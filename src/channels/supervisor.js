// src/channels/supervisor.js — ONE owner for the channel-daemon
// (packages/channel-daemon, the Telegram/Discord bridge) lifecycle, mirroring
// src/embed/supervisor.js. Without this the daemon never runs in the packaged
// app: nothing spawned it and packages/ wasn't even bundled (the #1 "my bot
// doesn't reply" cause — see docs/CHANNEL-DAEMON-RELIABILITY-DESIGN-2026-06-08.md).
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

const TICK_MS = 4000;            // re-evaluate lifecycle this often
const MAX_BACKOFF_MS = 30000;
const DOWN_AFTER = 5;            // consecutive crashes → report 'down' (likely a bad token)
const PROBE_TIMEOUT_MS = 1500;

let _health = { status: 'unknown', message: 'Channels not started.', detail: null };
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

  const setHealth = (status, message, detail = null) => { _health = { status, message, detail }; };
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
  });

  // Should the daemon run right now? Enabled + at least one platform token.
  async function shouldRun() {
    try {
      const enabled = (await db.secrets.get(userId, 'CHANNEL_ENABLED')) === '1';
      if (!enabled) return false;
      const hasTg = await db.secrets.has(userId, 'TELEGRAM_BOT_TOKEN');
      const hasDc = await db.secrets.has(userId, 'DISCORD_BOT_TOKEN');
      return Boolean(hasTg || hasDc);
    } catch { return false; }
  }

  // True if :3010 /healthz answers (an existing daemon is up).
  async function probe() {
    try {
      const res = await fetchImpl(healthzUrl, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      return res.ok;
    } catch { return false; }
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
        setHealth('down', 'The channel bridge keeps stopping — check the bot token.', tail || `exited code ${code}`);
      } else {
        setHealth('starting', 'Restarting the channel bridge…', tail || `exited code ${code}`);
      }
      backoff();
      log(`[channel-supervisor] daemon exited (code ${code}) — restart #${failures} scheduled${tail ? `: ${tail}` : ''}`);
    });
  }

  async function tick() {
    if (stopped) return;
    if (!(await shouldRun())) {
      // Channels disabled / no token → ensure nothing is running.
      if (child) killChild();
      setHealth('disabled', 'Channels are off (enable + add a bot token in Settings → Channels).');
      failures = 0;
      return;
    }
    if (await probe()) { setHealth('ok', 'Channel bridge is running.'); failures = 0; return; }
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
  _health = { status: 'unknown', message: 'Channels not started.', detail: null };
}

export default startChannelSupervisor;
