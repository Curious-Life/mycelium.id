// src/channels/supervisor.js — ONE owner for the channel-daemon
// (packages/channel-daemon, the Telegram/Discord bridge) lifecycle, mirroring
// src/embed/supervisor.js. Without this the daemon never runs in the packaged
// app: nothing spawned it and packages/ wasn't even bundled (the #1 "my bot
// doesn't reply" cause — see the channel-daemon reliability design).
//
// This supervisor (run by the Node server, so it behaves identically in npm-dev,
// Tauri-dev, and the bundled app):
//   • runs the daemon ONLY when the user enabled channels AND configured a token
//     (CHANNEL_ENABLED=1 + TELEGRAM_BOT_TOKEN or DISCORD_BOT_TOKEN in the vault)
//   • ADOPTS an already-healthy daemon on :3010 (/healthz) — never double-spawns
//   • RESTARTS on crash with capped exponential backoff; reports 'down' if it
//     keeps dying (e.g. a bad bot token → the daemon exits(1) at getMe)
//   • reload() — called after Settings → Channels saves — stops/(re)starts the
//     daemon so a new token/model/enabled-flag is picked up WITHOUT an app restart
//     (the daemon reads its config from the vault only at boot)
//   • exposes getHealth() so the Channels UI can show real running state
//
// SECURITY (CLAUDE.md #4 master-key discipline): the daemon is KEYLESS — it
// reaches vault plaintext only by calling the app's loopback tools (MYCELIUM_MCP_URL
// = /internal/mcp) and the loopback REST vault-client (MYCELIUM_API_URL). Its env
// is a minimal allowlist; NO vault keys ever flow to it. It is a child of the Node
// server, so the Rust shell's process-group reap (src-tauri/src/main.rs) kills it
// on app exit regardless of stop().

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { dataDir } from '../paths.js';
import { registerCrashKillChild } from '../system/crash-reaper.js';

/**
 * Where the daemon's persistent per-turn outcome log lands: <dataDir>/logs/
 * channel-turns.jsonl — the SAME data-dir resolution the server itself uses
 * (src/paths.js), so in the packaged app it is ~/Library/Application Support/
 * id.mycelium.app/logs/. Exported pure so the verify gate can assert the VALUE.
 *
 * Why: the daemon's own resolveTurnLogPath falls back to MYCELIUM_DATA_DIR /
 * MYCELIUM_VAULT_DIR / MYCELIUM_STATE_DIR — none of which the keyless childEnv
 * allowlist carries (MYCELIUM_DATA_DIR is deliberately excluded from the child:
 * the daemon is dataless as well as keyless) — so in production the L3b turn
 * log was console-only, i.e. INERT. Passing the derived FILE path keeps the
 * allowlist dataless while making the log land durably. The log is leak-safe by
 * design: lane.js logTurn writes turn METADATA only, never message content (§1).
 */
export function channelTurnLogPath({ env = process.env } = {}) {
  return join(dataDir({ env }), 'logs', 'channel-turns.jsonl');
}

const TICK_MS = 4000;            // re-evaluate lifecycle this often
const MAX_BACKOFF_MS = 30000;
const DOWN_AFTER = 5;            // consecutive crashes → report 'down' (likely a bad token)
const PROBE_TIMEOUT_MS = 1500;

// `transports` (D-014) is the per-platform LIVE connection state proxied from the
// daemon's /healthz. It is `{}` — never a fabricated default — whenever we have no
// fresh read, so a consumer that finds no entry for a platform must treat it as NOT
// connected (fail closed; see honestChannelConnection() below).
let _health = { status: 'unknown', message: 'Channels not started.', detail: null, replies: null, backend: null, transports: {} };
let _instance = null;

/**
 * Current channel-daemon health for the UI. Status:
 *   'disabled' — channels off or no token (nothing to run; NOT an error)
 *   'starting' — (re)starting; transient
 *   'ok'       — daemon up + polling
 *   'down'     — keeps crashing (detail = hint; usually a bad bot token)
 *   'unknown'  — supervisor not started (e.g. verify scripts)
 * @returns {{status:string,message:string,detail:string|null}}
 */
export function getChannelHealth() { return { ..._health }; }

/**
 * D-014 — the ONE honest answer to "is <platform> connected?", for the settings UI.
 *
 * The operator's report: "discord shows as connected even though it is not connected."
 * The old UI derived that badge from `hasToken` — a STORED FLAG meaning "a bot token
 * exists in the vault". A token is a credential, not a socket. This function refuses to
 * conflate them, and it FAILS CLOSED: `connected` is true only when the daemon's own
 * transport reporter says the platform's gateway reached `ready`.
 *
 * States (the D-013 taxonomy, applied to one channel):
 *   'not-configured' — no token stored; nothing to connect
 *   'off'            — configured, but the channels master switch is off
 *   'connecting'     — the bridge is starting, or the socket is mid-handshake
 *   'connected'      — a LIVE gateway session exists (the only "connected")
 *   'failed'         — the bridge or that platform's gateway is down (reason names it)
 *   'unknown'        — we genuinely could not read (supervisor not started). NOT connected.
 *
 * @param {object} a
 * @param {'telegram'|'discord'} a.platform
 * @param {boolean} a.hasToken   a token is stored for this platform
 * @param {boolean} a.enabled    the channels master switch
 * @param {object}  [a.health]   getChannelHealth() result
 * @returns {{state:string, connected:boolean, reason:string|null, detail:string|null}}
 */
export function honestChannelConnection({ platform, hasToken, enabled, health = getChannelHealth() }) {
  const out = (state, reason = null, detail = null) => ({ state, connected: state === 'connected', reason, detail });
  if (!hasToken) return out('not-configured');
  if (!enabled) return out('off', 'disabled', 'Channels are switched off in Advanced.');

  const st = health?.status;
  if (st === 'unknown') return out('unknown', 'no_read', 'The bridge has not reported yet.');
  if (st === 'disabled') return out('off', 'disabled', health?.message || null);
  if (st === 'down') return out('failed', 'bridge_down', health?.message || 'The channel bridge is not running.');
  if (st === 'starting') return out('connecting', 'bridge_starting', health?.message || null);

  // status 'ok' means the daemon PROCESS answered /healthz — which is exactly the
  // evidence that was previously mistaken for "Discord is connected". Go one level
  // deeper and read the platform's own transport state.
  const t = health?.transports?.[platform];
  if (!t) return out('unknown', 'no_transport_report', 'The bridge is running but has not reported this channel.');
  if (t.connected === true && t.state === 'ready') return out('connected');
  if (t.state === 'connecting') return out('connecting', 'handshake', t.message || null);
  if (t.state === 'disconnected') return out('failed', t.reason || 'socket_closed', t.message || 'The connection dropped; retrying.');
  if (t.state === 'idle') return out('connecting', 'not_started', t.message || null);
  return out('failed', t.reason || 'gateway_failed', t.message || null);
}

/**
 * Start + supervise the channel daemon. Idempotent (a second call returns the
 * existing instance). Gate it the same way as the enrich drainer / embed
 * supervisor — real app launches only, never verify scripts.
 *
 * @param {object} opts
 * @param {string} [opts.home=process.cwd()]  repo root (cwd for the child)
 * @param {object} opts.db                    open vault db (reads CHANNEL_* secrets)
 * @param {string} opts.userId
 * @param {number} [opts.restPort=8787]       the app's REST port (vault + /internal/mcp)
 * @param {(m:string)=>void} [opts.log]
 * @param {typeof fetch} [opts.fetch]
 * @param {typeof spawn} [opts.spawn]  injectable for tests
 */
export function startChannelSupervisor({
  home = process.cwd(),
  db,
  userId,
  restPort = Number(process.env.MYCELIUM_REST_PORT) || 8787,
  log = (m) => process.stderr.write(`${m}\n`),
  fetch: fetchImpl = globalThis.fetch,
  spawn: spawnImpl = spawn,
  channelTurnToken = null,   // per-boot secret authenticating the daemon to channel-turn (RT1)
} = {}) {
  if (_instance) return _instance;

  const daemonPort = Number(process.env.CHANNEL_DAEMON_PORT) || 3010;
  const healthzUrl = `http://127.0.0.1:${daemonPort}/healthz`;

  let child = null;
  let spawnedByUs = false;
  let failures = 0;
  let nextStartAt = 0;
  let stopped = false;
  let errBuf = '';
  let tickTimer = null;

  // `transports` resets to {} on every setHealth unless the caller supplies a fresh
  // read (D-014). Stale per-platform state is worse than none: a gateway that was
  // ready before a crash must not keep reporting `ready` through the restart.
  const setHealth = (status, message, detail = null, extra = {}) => { _health = { status, message, detail, replies: null, backend: null, transports: {}, ...extra }; };
  const lastErrLine = () => errBuf.split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
  const backoff = () => { nextStartAt = Date.now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(failures, 5)); };

  // Keyless allowlist — NO vault keys. The daemon talks to the vault + tools over
  // loopback (vault-client + /internal/mcp). PATH/HOME for `node` + any spawned helper.
  const childEnv = () => ({
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    MYCELIUM_API_URL: `http://127.0.0.1:${restPort}`,
    MYCELIUM_MCP_URL: `http://127.0.0.1:${restPort}/internal/mcp`,
    CHANNEL_MCP_MODE: 'http',
    ...(process.env.CHANNEL_DAEMON_PORT ? { CHANNEL_DAEMON_PORT: process.env.CHANNEL_DAEMON_PORT } : {}),
    // Authenticates the native channel-turn forward (RT1) — only THIS spawned daemon
    // holds it, so a forged loopback POST cannot reach the owner-write grant.
    ...(channelTurnToken ? { MYCELIUM_CHANNEL_TURN_TOKEN: channelTurnToken } : {}),
    // Persistent per-turn outcome log (L3b): the derived FILE path, not the data
    // dir — the child stays keyless AND dataless (see channelTurnLogPath above).
    MYCELIUM_CHANNEL_TURN_LOG: channelTurnLogPath(),
  });

  // Should the daemon run right now? Enabled + a config the daemon will actually ACCEPT.
  // D-129: this predicate must MIRROR the daemon's own boot rule (packages/channel-daemon/
  // config.js assertEgressConfig), not approximate it. It used to be "any token", but the
  // daemon (a) requires OWNER_DISCORD_ID whenever DISCORD_BOT_TOKEN is set — even with a
  // healthy Telegram config — and (b) refuses to boot with neither platform complete. So
  // "any token" spawned a child the daemon was guaranteed to refuse: exit(1) → capped
  // backoff → respawn every ~30s, forever, burning cycles and spamming the log. A config
  // the daemon will provably reject must never spawn; the health line says what to fix.
  // Returns false or a { blocked: <honest reason> } object the tick surfaces.
  async function shouldRun() {
    try {
      const enabled = (await db.secrets.get(userId, 'CHANNEL_ENABLED')) === '1';
      if (!enabled) return false;
      const hasTg = await db.secrets.has(userId, 'TELEGRAM_BOT_TOKEN');
      const hasDc = await db.secrets.has(userId, 'DISCORD_BOT_TOKEN');
      const hasDcOwner = await db.secrets.has(userId, 'OWNER_DISCORD_ID');
      if (hasDc && !hasDcOwner) {
        return { blocked: 'Discord has a bot token but no owner id — the bridge refuses to start until OWNER_DISCORD_ID is set (or the Discord token is removed) in Settings → Channels.' };
      }
      if (!hasTg && !hasDc) return false;
      return true;
    } catch { return false; }
  }

  // Parsed /healthz body if :3010 answers (an existing daemon is up), else null.
  // Carries the non-secret replies state ({ replies:'on'|'capture-only', backend }).
  async function probe() {
    try {
      const res = await fetchImpl(healthzUrl, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      if (!res.ok) return null;
      try { return await res.json(); } catch { return { ok: true }; }
    } catch { return null; }
  }

  function killChild() {
    if (child && spawnedByUs) { try { child.kill('SIGTERM'); } catch { /* */ } }
    child = null;
  }

  function spawnDaemon() {
    setHealth('starting', failures ? 'Restarting the channel bridge…' : 'Starting the channel bridge…');
    try {
      child = spawnImpl(process.execPath, ['packages/channel-daemon/index.js'], {
        cwd: home, env: childEnv(), stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (e) {
      setHealth('down', 'Could not start the channel bridge.', String(e?.message || e));
      failures++; backoff(); return;
    }
    registerCrashKillChild(child, 'channel-daemon'); // D-136: the crash path must reap what stop() would
    spawnedByUs = true; errBuf = '';
    child.stderr?.on('data', (d) => { errBuf = (errBuf + d.toString()).slice(-4096); });
    child.on('error', () => { /* surfaced via exit/last stderr */ });
    child.on('exit', (code) => {
      const wasOurs = child;
      child = null;
      if (stopped || !wasOurs) return;
      failures++;
      const tail = lastErrLine();
      if (failures >= DOWN_AFTER) {
        // Name the ACTUAL cause instead of a blanket "check the bot token": the
        // daemon exits(1) with distinct, greppable reasons (config.js egress
        // asserts, index.js getMe checks). A missing owner id, an invalid token,
        // and an unconfigured platform are very different fixes.
        const t = String(tail || '');
        const [message, detail] =
          /OWNER_TELEGRAM_ID required/i.test(t) ? ['Your Telegram ID is missing (the bot token is set).', 'Message your bot and approve the pairing code, or add your Telegram ID in Settings → Channels.']
          : /getMe failed|check TELEGRAM_BOT_TOKEN/i.test(t) ? ['The Telegram bot token looks invalid.', 'Re-check the token from @BotFather in Settings → Channels.']
          : /OWNER_DISCORD_ID required/i.test(t) ? ['Your Discord owner ID is missing (the bot token is set).', 'Add your Discord ID in Settings → Channels.']
          : /check DISCORD_BOT_TOKEN|@me failed/i.test(t) ? ['The Discord bot token looks invalid.', 'Re-check the Discord token in Settings → Channels.']
          : /configure at least one platform/i.test(t) ? ['No channel is configured yet.', 'Add a Telegram or Discord bot token in Settings → Channels.']
          : ['The channel bridge keeps stopping.', t || `exited code ${code}`];
        setHealth('down', message, detail);
      } else {
        setHealth('starting', 'Restarting the channel bridge…', tail || `exited code ${code}`);
      }
      backoff();
      log(`[channel-supervisor] daemon exited (code ${code}) — restart #${failures} scheduled${tail ? `: ${tail}` : ''}`);
    });
  }

  async function tick() {
    if (stopped) return;
    const runnable = await shouldRun();
    if (runnable !== true) {
      // Channels disabled / no token / a config the daemon would refuse → nothing runs.
      if (child) killChild();
      // D-129: a BLOCKED config gets its own honest reason, not the generic "off" copy —
      // "channels are off" about a half-finished Discord setup is the D-013 class.
      if (runnable && runnable.blocked) setHealth('down', runnable.blocked);
      else setHealth('disabled', 'Channels are off (enable + add a bot token in Settings → Channels).');
      failures = 0;
      return;
    }
    const up = await probe();
    if (up) {
      const captureOnly = up.replies === 'capture-only';
      setHealth(
        'ok',
        captureOnly ? 'Bridge running — receiving, but not replying (no AI model connected).' : 'Channel bridge is running.',
        captureOnly ? 'Select an AI model in Settings → AI (or add a channel assistant key) to enable replies.' : null,
        // D-014: carry the daemon's per-platform transport report through verbatim. An
        // OLDER daemon (or one that answered /healthz before the field existed) sends no
        // `transports` — {} then means "no read", which honestChannelConnection() renders
        // as 'unknown', never as connected.
        { replies: up.replies || null, backend: up.backend || null, transports: (up.transports && typeof up.transports === 'object') ? up.transports : {} },
      );
      failures = 0;
      return;
    }
    if (child) return;                 // our child is still binding; exit handler covers crashes
    if (Date.now() < nextStartAt) return;
    spawnDaemon();
  }

  tickTimer = setInterval(() => { void tick(); }, TICK_MS);
  if (tickTimer.unref) tickTimer.unref();
  void tick();

  _instance = {
    getHealth: getChannelHealth,
    /**
     * Re-evaluate now AND restart a running daemon so a just-saved token/model/
     * enabled-flag is picked up (the daemon reads config only at boot). Called by
     * portal-channels after PUT /channels.
     */
    reload: () => { failures = 0; nextStartAt = 0; killChild(); void tick(); },
    /** Force an immediate re-evaluation without restarting a healthy daemon. */
    nudge: () => { nextStartAt = 0; void tick(); },
    stop: () => {
      stopped = true;
      if (tickTimer) clearInterval(tickTimer);
      killChild();
      _instance = null;
    },
  };
  return _instance;
}

// Test seam: reset the module singleton + health between unit runs in one process.
export function _resetChannelSupervisor() {
  if (_instance) { try { _instance.stop(); } catch { /* */ } }
  _instance = null;
  _health = { status: 'unknown', message: 'Channels not started.', detail: null, replies: null, backend: null, transports: {} };
}

export default startChannelSupervisor;
