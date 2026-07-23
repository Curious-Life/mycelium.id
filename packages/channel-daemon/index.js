/**
 * Channel-daemon entrypoint — wires the configured platforms (Telegram and/or
 * Discord) into the shared egress chokepoint + agent turn pipeline and starts the
 * loopback server. Each platform is built only when its token is configured; both
 * share one runtime/lane/dedup/rate-limit and the active-turn registry.
 *
 * Config comes from the vault (portal Settings → Channels, hydrated over loopback)
 * with env as the fallback. Run: node packages/channel-daemon/index.js
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig, assertEgressConfig, applyChannelConfigToEnv, reconcileTtsEnv } from './config.js';
import { createVaultClient } from './vault-client.js';
import { createEnvelopeDedup } from './dedup.js';
import { createRateLimiter } from './ratelimit.js';
import { createDaemonApp } from './server.js';
import { selectRuntime } from './agent/runtime.js';
import { createLane } from './agent/lane.js';
import { createTypingPresence } from './presence.js';
import { createAuthOutageNotifier, AUTH_NOTICE_TEXT } from './auth-notice.js';
import { createCoalescer } from './transport/coalescer.js';
import { getActiveTurn } from './inbound-context.js';
// telegram
import { createTelegramApi } from './telegram-api.js';
import { createTelegramChokepoint } from './chokepoint.js';
import { createVoicePipeline, createVoiceReplyPolicy } from './voice-pipeline.js';
import { createInboundHandler } from './inbound.js';
import { contextualizeMedia } from './media.js';
import { createMediaQueue } from './media-queue.js';
import { createTelegramPoller } from './transport/telegram-poller.js';
import { createCommandHandler } from './commands.js';
// discord
import { createDiscordApi } from './discord-api.js';
import { createDiscordChokepoint } from './discord-chokepoint.js';
import { createDiscordVoicePipeline } from './discord-voice.js';
import { createDiscordInboundHandler } from './discord-inbound.js';
import { createDiscordCommandHandler } from './commands-discord.js';
import { createDiscordGateway } from './transport/discord-gateway.js';

function captureOnlyRunTurn(turnCtx) {
  console.log(`[channel-daemon] captured ${turnCtx.source} chat=${turnCtx.channelId}; two-way replies OFF (no inference configured)`);
}

// Observability (Layer 3b): where to persist per-turn outcomes. Explicit env wins; else a
// `logs/` dir under the daemon's data/state dir; else null (console-only, fail-soft — never
// throws so a missing/unwritable dir can't stop the daemon from booting).
export function resolveTurnLogPath() {
  const explicit = process.env.MYCELIUM_CHANNEL_TURN_LOG;
  // The explicit path must have its parent dir ensured HERE: the packaged app's
  // supervisor passes a <app-data>/logs/… path whose dir may not exist yet, and
  // lane.js's appendFileSync is deliberately fail-soft — without the mkdir the
  // "persistent" log silently never lands (the exact inertness this fixes).
  if (explicit) {
    try { mkdirSync(path.dirname(explicit), { recursive: true }); return explicit; }
    catch { return null; } // unwritable → honest console-only, never a boot crash
  }
  const base = process.env.MYCELIUM_DATA_DIR || process.env.MYCELIUM_VAULT_DIR || process.env.MYCELIUM_STATE_DIR || null;
  if (!base) return null;
  try { const dir = path.join(base, 'logs'); mkdirSync(dir, { recursive: true }); return path.join(dir, 'channel-turns.jsonl'); }
  catch { return null; }
}

/**
 * @param {object} cfg
 * @param {object} [opts]
 * @param {Function} [opts.runTurn]  override the turn handler (tests inject a fake;
 *                                   BYPASSES the lane/outcome wiring entirely)
 * @param {object}  [opts.runtime]   test seam: inject an AgentRuntime that still runs
 *                                   through the REAL lane + outcome + notifier wiring
 *                                   (unlike opts.runTurn) — gates assert the wiring, not
 *                                   a re-assembled copy of it
 * @param {object}  [opts.dedup]     test seam: a createEnvelopeDedup() with a compressed
 *                                   TTL so time-spaced behavior is drivable in seconds
 */
export async function buildDaemon(cfg, { runTurn, runtime: injectedRuntime, dedup: injectedDedup } = {}) {
  const vault = createVaultClient({ baseUrl: cfg.vaultBaseUrl });
  const dedup = injectedDedup || createEnvelopeDedup();
  const rateLimit = createRateLimiter({ maxPerWindow: cfg.rateLimitMax, windowMs: cfg.rateLimitWindowMs });

  // Platform clients — declared ahead of the lane so presence can late-bind
  // (the lane exists before the Telegram client; presence only fires mid-turn,
  // long after both are constructed).
  let telegram = null, poller = null, telegramSendHandler;
  let discord = null, gateway = null, discordSendHandler;

  // Per-boot secret that authorizes a `trusted` (authority/rate-limit-bypass)
  // send. Only the in-process command-ack closures below carry it (header
  // x-egress-trusted); a body `trusted:true` from any other loopback caller is
  // ignored. Random per process — never persisted, never logged (H2).
  const trustedToken = crypto.randomBytes(32).toString('hex');

  // ── shared agent-turn pipeline (one runtime/lane for all platforms) ────────
  let effectiveRunTurn = runTurn;
  let lane = null;
  let reprobeTimer = null;
  // Typing indicator — shared by the lane (turn) + inbound (pre-turn media stage).
  // Constructed UNCONDITIONALLY: the inbound handlers capture it BY VALUE at build
  // time, so a capture-only boot that later upgrades (re-probe below) must already
  // have handed them the real object, not null. It closes over the late-bound
  // `telegram` and is inert until a turn actually runs — costs nothing when idle.
  const presence = createTypingPresence({
    sendChatAction: (chatId) => telegram ? telegram.sendChatAction({ chatId }) : null,
  });
  // Honest replies state for /healthz → the Channels UI (so "receiving but not
  // replying — no model connected" is never a silent green again). ONE shared object,
  // MUTATED in place on upgrade: server.js reads `replies.mode` per request, so the
  // flip is visible live without a daemon restart.
  const replies = { mode: 'capture-only', backend: null };

  // ── Owner notice on an AUTH outage (auth-notice.js — SECURITY-SENSITIVE) ──
  // An expired subscription ends every turn 'no-reply'/reason:'auth'; the packaged
  // app's console goes to /dev/null, so the owner saw typing-then-silence. Send ONE
  // static, content-free notice per outage episode, to the OWNER chat that messaged,
  // through the EXISTING egress chokepoint route (§11): the same per-boot-token
  // trusted /telegram/send | /discord/send path the command acks ride — never a new
  // send path, and the chokepoint still audits + persists + dedups it.
  const authNotice = createAuthOutageNotifier({
    isOwnerChat: (rec) => {
      const src = String(rec?.source || '');
      // Telegram: an owner 1:1 DM's chatId IS the owner's Telegram id (groups are
      // '-'-prefixed and can never match). Discord: chatId is a channel id, so
      // owner-ness is proven by the SENDER id the lane records from the turnCtx.
      if (src === 'telegram') return !!cfg.ownerTelegramId && String(rec.chatId) === String(cfg.ownerTelegramId);
      if (src.startsWith('discord')) {
        // Owner-ness is proven by the SENDER id (Discord chatId is a CHANNEL id, not a
        // user id). But the Discord inbound authorizes the owner ANYWHERE — it bypasses
        // channel policy — so an owner message in a PUBLIC guild channel during an auth
        // outage would otherwise POST the static notice to that public channel. The send
        // rides the per-boot trusted token, which bypasses the chokepoint's channel-
        // authority gate (send-handler.js `if (!trustedReq)`), so nothing downstream
        // constrains the recipient. Enforce the notice module's "Never broadcast"
        // invariant HERE: recipient-safety restricts the Discord notice to DMs, where the
        // guild id is null. A guild-channel outage is SUPPRESSED. (Telegram is unaffected:
        // groups are '-'-prefixed and already fail the owner-DM id match above.)
        if (!cfg.ownerDiscordId || rec.senderId == null || String(rec.senderId) !== String(cfg.ownerDiscordId)) return false;
        return rec.guildId == null; // DM only — a server channel (guildId set) is suppressed
      }
      return false;
    },
    // Routing metadata ONLY — the text is the static AUTH_NOTICE_TEXT constant,
    // attached here so no dynamic content can ever enter the notice.
    send: async ({ source, chatId }) => {
      const discord = String(source || '').startsWith('discord');
      const route = discord ? '/discord/send' : '/telegram/send';
      const body = discord
        ? { channelId: chatId, content: AUTH_NOTICE_TEXT, trusted: true }
        : { chatId, text: AUTH_NOTICE_TEXT, trusted: true };
      const res = await fetch(`${cfg.selfUrl}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-egress-trusted': trustedToken },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`auth-notice egress ${res.status}`); // notifier logs, fail-soft
    },
    log: (m) => console.warn(`[channel-daemon] ⚠ ${m}`),
  });

  if (!effectiveRunTurn) {
    // auto router records cloud-routing decisions hash-only via the vault.
    const auditEgress = (e) => { vault.recordInferenceEgress(e); };
    const runtime = injectedRuntime || selectRuntime(cfg, { auditEgress });
    // B1 (red-team RT4): native runs the turn on the SERVER, which may have no model
    // configured — that would silently drop every reply. Probe the vault; if it has no
    // model, stay HONESTLY capture-only (never claim replies are ON) until one is added.
    let nativeNoModel = false;
    if (runtime && runtime.label === 'native' && typeof runtime.probeHealth === 'function') {
      try { nativeNoModel = !(await runtime.probeHealth())?.hasModel; } catch { nativeNoModel = true; }
      if (nativeNoModel) console.log('[channel-daemon] native backend selected but the vault has no model — capture-only until a model is connected');
    }
    // Build the full reply pipeline for `rt` and swap it in LIVE. Called at boot when
    // the model is already reachable, or later by the re-probe when it becomes so.
    const activateLane = (rt) => {
      // Observability (Layer 3b): persist every turn outcome + surface degraded/failed turns.
      // Log path: explicit env, else <data dir>/logs, else null (console-only, fail-soft).
      const turnLogPath = resolveTurnLogPath();
      lane = createLane({
        runtime: rt, presence, ...(cfg.turnTimeoutMs ? { turnTimeoutMs: cfg.turnTimeoutMs } : {}),
        turnLogPath,
        // A not-ok or degraded outcome is an operator signal — WARN loudly (the persistent log +
        // /healthz lastTurn carry the detail), and feed the auth-outage notifier (the
        // Layer-3b proactive push, U1): one owner notice per auth episode, via the
        // egress chokepoint. onTurnOutcome never throws into the lane (fail-soft inside).
        onOutcome: (rec) => {
          if (!rec?.ok || rec?.degraded || rec?.harvested) console.warn(`[channel-daemon] ⚠ turn ${rec?.verdict}${rec?.degraded ? ' DEGRADED' : ''}${rec?.harvested ? ' HARVESTED' : ''} chat=${rec?.chatId} model=${rec?.model || '?'} reason=${rec?.reason || rec?.error || '-'}`);
          void authNotice.onTurnOutcome(rec);
        },
      });
      if (turnLogPath) console.log(`[channel-daemon] turn log → ${turnLogPath}`);
      if (cfg.coalesceWindowMs > 0) {
        const coalescer = createCoalescer({ windowMs: cfg.coalesceWindowMs, flush: (turnCtx, merged) => lane.runTurn(turnCtx, merged) });
        effectiveRunTurn = (turnCtx, msg) => { coalescer.push(turnCtx, msg); };
      } else {
        effectiveRunTurn = lane.runTurn;
      }
      replies.mode = 'on';
      replies.backend = lane?.label || 'custom';
      console.log(`[channel-daemon] two-way replies ON via ${lane.label}${cfg.coalesceWindowMs > 0 ? ` (coalesce ${cfg.coalesceWindowMs}ms)` : ''}`);
      // Reply-tool preflight, HERE and not only in main(): main() destructured `lane`
      // at boot, so a late (re-probe) upgrade used to skip the check entirely — a vault
      // that doesn't advertise `reply` would upgrade and then silently fail to deliver,
      // in exactly the boot-race path this fix exists for (review M2). Fail-soft + async:
      // a warning, never a crash, off the activation's synchronous critical section.
      if (cfg.mcpMode !== 'stdio') {
        vault.listToolNames().then((tools) => {
          if (tools && !tools.includes('reply')) {
            console.error(`[channel-daemon] ⚠ vault MCP does NOT advertise the 'reply' tool — two-way replies will NOT deliver. Boot the vault with AGENT_URL=${cfg.selfUrl} (and MYCELIUM_MCP_BEARER).`);
          } else if (tools) {
            console.log('[channel-daemon] preflight OK — vault advertises the reply tool.');
          }
        }).catch(() => { /* preflight is advisory */ });
      }
    };
    if (runtime && !nativeNoModel) {
      activateLane(runtime);
    } else {
      effectiveRunTurn = captureOnlyRunTurn;
      // THE BOOT-RACE LATCH FIX. The one-shot probe above races the server's boot: the
      // daemon is spawned BY server-rest, probes it within 3s, and on a 2GB vault the
      // server is still opening/migrating — so the probe times out and the daemon
      // latched capture-only for its whole life. Telegram then RECEIVED every message
      // and silently never replied; the Channels card told the user to "select an AI
      // model" — advice that could not work, because nothing ever re-checked. Worse,
      // server-rest is now SUPERVISED (auto-respawn), so every respawn re-rolled this
      // race. Re-probe until the model becomes reachable, then upgrade IN PLACE.
      // Upgrade-only by design: a later outage is a per-turn failure the lane already
      // reports honestly; flapping the whole pipeline would hide it.
      if (runtime && nativeNoModel && typeof runtime.probeHealth === 'function') {
        const RECHECK_MS = Number(cfg.modelRecheckMs) > 0 ? Number(cfg.modelRecheckMs) : 15_000;
        // The callback is async: a SLOW probe can leave several ticks in flight at once,
        // and each would see hasModel and activate its own lane (two coalescers, double
        // replies). `upgraded` is checked+set with NO await in between — JS's single
        // thread makes that atomic — so exactly one tick wins. Prod timings (3s probe
        // cap ≪ 15s interval) can't overlap, but the guard makes it true by construction.
        let upgraded = false;
        reprobeTimer = setInterval(async () => {
          let hasModel = false;
          try { hasModel = !!(await runtime.probeHealth())?.hasModel; } catch { hasModel = false; }
          if (!hasModel || upgraded) return;
          upgraded = true;
          clearInterval(reprobeTimer); reprobeTimer = null;
          activateLane(runtime);
          console.log('[channel-daemon] model became reachable — upgraded capture-only → two-way replies (no restart needed)');
        }, RECHECK_MS);
        if (reprobeTimer.unref) reprobeTimer.unref();
      }
    }
  }
  // Injected runTurn (tests) bypasses the block above — reflect it honestly.
  if (effectiveRunTurn && effectiveRunTurn !== captureOnlyRunTurn && replies.mode === 'capture-only') {
    replies.mode = 'on';
    replies.backend = lane?.label || 'custom';
  }

  const recordEgress = (entry) => { vault.recordEgress(entry); };
  const persistOutbound = (args) => { vault.captureMessage(args).catch((e) => console.error('[channel-daemon] outbound persist failed:', e.message)); };

  // ── Telegram ───────────────────────────────────────────────────────────────
  if (cfg.botToken) {
    telegram = createTelegramApi({ botToken: cfg.botToken });
    const voicePipeline = createVoicePipeline({ sendVoice: ({ target, filePath, replyToMessageId, messageThreadId }) => telegram.sendVoice({ chatId: target, filePath, replyToMessageId, messageThreadId }), agentId: cfg.agentId });

    async function checkTelegramAuthority({ kind, id, isAgentExplicit }) {
      // owner-bootstrap (reply to the operator's own DM) is ONLY for an agent-explicit
      // send — the reply tool's x-egress-provenance. A bare loopback caller must not be
      // able to impersonate the agent to the owner; it falls through to the registry.
      if (isAgentExplicit && cfg.ownerTelegramId && String(id) === String(cfg.ownerTelegramId)) return { allowed: true, reason: 'owner-bootstrap' };
      if (kind === 'telegram-group') {
        const g = await vault.getTelegramGroup(id);
        return g.authorized && g.active !== false ? { allowed: true, reason: 'group-authorized' } : { allowed: false, reason: 'group-not-authorized' };
      }
      return vault.checkChannelAuthority({ kind, id });
    }

    telegramSendHandler = createTelegramChokepoint({
      sendToTelegram: (a) => telegram.sendMessage(a), recordEgress, persistOutbound,
      checkAuthority: checkTelegramAuthority, dedup, rateLimit, voicePipeline, getActiveTurn, agentId: cfg.agentId,
      trustedToken,
      // The voice toggle, consulted at REPLY TIME (QA6-VOICE). `isEnabled` reads the
      // live TTS provider config (Settings → Voice, re-hydrated per refresh), so
      // switching voice on/off takes effect on the next reply with no restart.
      voiceReplyDefault: createVoiceReplyPolicy({ isEnabled: () => voicePipeline.isEnabled(), getActiveTurn }),
    });

    const sendReply = async ({ chatId, text, replyToMessageId, messageThreadId }) => {
      try { await fetch(`${cfg.selfUrl}/telegram/send`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-egress-trusted': trustedToken }, body: JSON.stringify({ chatId, text, replyToMessageId, messageThreadId, trusted: true }) }); }
      catch (e) { console.error('[channel-daemon] command reply failed:', e.message); }
    };
    const commands = createCommandHandler({ vault, sendReply, ownerTelegramId: cfg.ownerTelegramId });
    const isGroupAuthorized = async (gid) => { const g = await vault.getTelegramGroup(gid); return !!g.authorized && g.active !== false; };
    const checkChannelAccess = (kind, id, sender) => vault.checkChannelAccess({ kind, id, sender });
    // Inbound media: download (memory-only) → encrypted vault blob → local
    // vision/transcription context. Fail-soft end to end (media.js contract).
    const mediaStage = cfg.mediaEnabled
      ? (msg) => contextualizeMedia(msg, { telegram, vault, maxBytes: cfg.mediaMaxBytes })
      : undefined;
    // MED-4 — offload the minutes-long media stage onto a bounded serial worker
    // so the poller never stalls; degrade-to-placeholder under flood (never drop).
    const mediaQueue = cfg.mediaEnabled
      ? createMediaQueue({ maxPending: cfg.mediaQueueMax, senderMax: cfg.mediaSenderMax, senderWindowMs: cfg.mediaSenderWindowMs })
      : undefined;
    // Pairing (design D2): only wired for Telegram, and only meaningful while no
    // owner is bound — createInboundHandler self-guards on !ownerTelegramId. The
    // reply rides the SAME /telegram/send egress chokepoint as every outbound.
    const requestPairing = (a) => vault.requestPairing(a);
    const handleInbound = createInboundHandler({ vault, ownerTelegramId: cfg.ownerTelegramId, runTurn: (turnCtx, msg) => effectiveRunTurn(turnCtx, msg) /* trampoline: re-probe swaps the target live */, commands, isGroupAuthorized, checkChannelAccess, contextualizeMedia: mediaStage, mediaQueue, presence, requestPairing, sendReply });
    poller = createTelegramPoller({ telegram, handleInbound });
  }

  // ── Discord ──────────────────────────────────────────────────────────────
  if (cfg.discordBotToken) {
    discord = createDiscordApi({ botToken: cfg.discordBotToken });
    const discordVoice = createDiscordVoicePipeline({ sendVoice: (a) => discord.sendVoice(a), agentId: cfg.agentId });

    // Discord authority: allow replying to the active inbound turn's channel
    // (reply path) OR any channel the operator authorized via /allow
    // (identity_channels kind 'discord'). Cross-channel to an unauthorized
    // channel is fail-closed.
    async function checkDiscordAuthority({ kind, id, isAgentExplicit }) {
      const turn = getActiveTurn();
      // reply-to-inbound is ONLY for an agent-explicit send — otherwise any local
      // caller that reads the active channelId could inject into the live channel.
      if (isAgentExplicit && turn && String(turn.channelId) === String(id) && (turn.source === 'discord' || turn.source === 'discord-thread')) {
        return { allowed: true, reason: 'reply-to-inbound' };
      }
      const a = await vault.checkChannelAuthority({ kind: 'discord', id });
      return a?.allowed ? { allowed: true, reason: 'registry' } : { allowed: false, reason: 'discord-channel-not-authorized' };
    }

    discordSendHandler = createDiscordChokepoint({
      sendToDiscord: (a) => discord.sendMessage(a), recordEgress, persistOutbound,
      checkAuthority: checkDiscordAuthority, dedup, rateLimit, voicePipeline: discordVoice, getActiveTurn, agentId: cfg.agentId,
      trustedToken,
    });

    const discordSendReply = async ({ channelId, content, replyToMessageId }) => {
      try { await fetch(`${cfg.selfUrl}/discord/send`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-egress-trusted': trustedToken }, body: JSON.stringify({ channelId, content, replyToMessageId, trusted: true }) }); }
      catch (e) { console.error('[channel-daemon] discord command reply failed:', e.message); }
    };
    const discordCommands = createDiscordCommandHandler({ vault, sendReply: discordSendReply, ownerDiscordId: cfg.ownerDiscordId });
    const isChannelAuthorized = async (id) => { const a = await vault.checkChannelAuthority({ kind: 'discord', id }); return !!a?.allowed; };
    const checkDiscordAccess = (kind, id, sender) => vault.checkChannelAccess({ kind, id, sender });
    const handleDiscordInbound = createDiscordInboundHandler({ vault, ownerDiscordId: cfg.ownerDiscordId, runTurn: (turnCtx, msg) => effectiveRunTurn(turnCtx, msg) /* trampoline (see telegram) */, commands: discordCommands, isChannelAuthorized, checkChannelAccess: checkDiscordAccess });
    gateway = createDiscordGateway({ botToken: cfg.discordBotToken, handleInbound: handleDiscordInbound });
  }

  const app = createDaemonApp({ telegramSendHandler, discordSendHandler, getActiveTurn, replies, getLastTurn: () => (lane && typeof lane.lastTurn === "function" ? lane.lastTurn() : null) /* lane may be built AFTER boot (re-probe) */ });
  // `lane` is the BOOT-time value (null on a capture-only boot); getLane() reads the
  // live one across a re-probe upgrade. Kept both for compatibility.
  return { app, poller, gateway, telegram, discord, lane, getLane: () => lane, vault, replies };
}

async function main() {
  // Hydrate from vault-managed config (portal is authoritative) BEFORE loading cfg.
  let cfg = loadConfig();
  try {
    const cc = await createVaultClient({ baseUrl: cfg.vaultBaseUrl }).getChannelConfig();
    if (cc) { applyChannelConfigToEnv(cc); cfg = loadConfig(); console.log('[channel-daemon] config hydrated from vault.'); }
  } catch (e) { console.error('[channel-daemon] vault config hydrate skipped:', e.message); }

  assertEgressConfig(cfg);
  const { app, poller, gateway, telegram, discord, lane, vault } = await buildDaemon(cfg);

  // Validate tokens up front so a bad token fails loud, not silently mid-run.
  if (telegram) {
    try { const me = await telegram.getMe(); console.log(`[channel-daemon] telegram bot @${me.username} (id ${me.id})`); }
    catch (e) { console.error(`[channel-daemon] telegram getMe failed — check TELEGRAM_BOT_TOKEN: ${e.message}`); process.exit(1); }
  }
  if (discord) {
    try { const me = await discord.getMe(); console.log(`[channel-daemon] discord bot ${me.username} (id ${me.id})`); }
    catch (e) { console.error(`[channel-daemon] discord users/@me failed — check DISCORD_BOT_TOKEN: ${e.message}`); process.exit(1); }
  }

  // Reply-tool preflight moved INTO activateLane (buildDaemon): it must also run on a
  // late re-probe upgrade, which this boot-time block could never see (review M2).

  const server = app.listen(cfg.port, cfg.host, () => {
    console.log(`[channel-daemon] listening on http://${cfg.host}:${cfg.port} (vault: ${cfg.vaultBaseUrl})`);
    console.log(`[channel-daemon] platforms: ${[telegram && 'telegram', discord && 'discord'].filter(Boolean).join(' + ') || 'none'}`);
  });

  if (poller) poller.start();
  if (gateway) { gateway.start().catch((e) => console.error('[channel-daemon] discord gateway failed to start:', e.message)); }

  // Live config refresh: re-hydrate vault-managed env on an interval so portal Settings →
  // Voice/Channels changes (TTS provider + voice especially) take effect WITHOUT an app
  // restart. resolveProvider()/resolveVoice() read process.env live per synth, so refreshing
  // env is sufficient. Fail-soft — a failed fetch keeps the last-known config (never crashes).
  const refreshMs = Number(process.env.MYCELIUM_CHANNEL_CONFIG_REFRESH_MS) || 30000;
  let configRefresh = null;
  if (refreshMs > 0) {
    const refreshClient = createVaultClient({ baseUrl: cfg.vaultBaseUrl });
    configRefresh = setInterval(async () => {
      try {
        const fresh = await refreshClient.getChannelConfig();
        if (fresh) { applyChannelConfigToEnv(fresh); reconcileTtsEnv(fresh); }
      } catch { /* keep last-known config */ }
    }, refreshMs);
    configRefresh.unref?.();
  }

  const shutdown = () => {
    if (configRefresh) clearInterval(configRefresh);
    if (poller) poller.stop();
    if (gateway) gateway.stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Resilience (Layer 3b): a stray unhandled rejection / uncaught exception must NOT silently
  // kill the daemon (which would freeze the poll loop → "replies once then stops" with no signal).
  // Log loudly and stay up; the poller's own try/catch + backoff keeps ingesting. A truly fatal
  // state still surfaces via /healthz. Registered once, in main() only (never in the test import).
  process.on('unhandledRejection', (reason) => {
    console.error(`[channel-daemon] ⚠ unhandledRejection (kept alive): ${String(reason?.stack || reason).slice(0, 300)}`);
  });
  process.on('uncaughtException', (err) => {
    console.error(`[channel-daemon] ⚠ uncaughtException (kept alive): ${String(err?.stack || err).slice(0, 300)}`);
  });
}

// Run only when invoked directly (not when imported by the verify script). Compare
// decoded FS paths — `file://${argv[1]}` keeps a raw space while import.meta.url
// percent-encodes it, so a bundle path WITH A SPACE ("Mycelium Dev.app") never
// matched → main() silently never ran → the daemon exited 0 and the supervisor
// reported "down — check the bot token" even with a valid token.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
