/**
 * Channel-daemon entrypoint (Phase 0) — wires the real Telegram Bot API + the
 * vault HTTP client into the egress chokepoint and starts the loopback server.
 *
 * Phase 0 is OUTBOUND only: it stands up the `/telegram/send` chokepoint and the
 * `/internal/inbound-context/current` endpoint so the deferred `reply` MCP tool
 * resolves end-to-end. The inbound poll/webhook listener + the agent turn land
 * in Phase 1 / Phase 2.
 *
 * Run: TELEGRAM_BOT_TOKEN=… OWNER_TELEGRAM_ID=… node packages/channel-daemon/index.js
 */
import { loadConfig, assertEgressConfig } from './config.js';
import { createTelegramApi } from './telegram-api.js';
import { createVaultClient } from './vault-client.js';
import { createEnvelopeDedup } from './dedup.js';
import { createTelegramChokepoint } from './chokepoint.js';
import { createDaemonApp } from './server.js';
import { createInboundHandler } from './inbound.js';
import { createTelegramPoller } from './transport/telegram-poller.js';
import { selectRuntime } from './agent/runtime.js';
import { createLane } from './agent/lane.js';
import { createCoalescer } from './transport/coalescer.js';
import { createRateLimiter } from './ratelimit.js';
import { createVoicePipeline } from './voice-pipeline.js';
import { createCommandHandler } from './commands.js';
import { getActiveTurn } from './inbound-context.js';

/**
 * Capture-only fallback when no runtime is configured (no BYOK key, no local
 * model): the inbound is still captured (in inbound.js, before runTurn) — this
 * just logs that no reply will be sent. Two-way is OFF, ingestion stays ON.
 */
function captureOnlyRunTurn(turnCtx) {
  console.log(`[channel-daemon] captured chat=${turnCtx.channelId}; two-way replies OFF (no inference configured)`);
}

/**
 * @param {object} cfg
 * @param {object} [opts]
 * @param {Function} [opts.runTurn]  override the turn handler (tests inject a fake)
 */
export function buildDaemon(cfg, { runTurn } = {}) {
  const telegram = createTelegramApi({ botToken: cfg.botToken });
  const vault = createVaultClient({ baseUrl: cfg.vaultBaseUrl });
  const dedup = createEnvelopeDedup();

  // Phase 0 authority: the operator's own DM is deliverable via owner-bootstrap
  // (the Phase 3 binding flow will register other chats). Any other target must
  // have a delivery-enabled identity_channels row — checked in the vault,
  // fail-closed.
  async function checkAuthority({ kind, id }) {
    if (cfg.ownerTelegramId && String(id) === String(cfg.ownerTelegramId)) {
      return { allowed: true, reason: 'owner-bootstrap' };
    }
    if (kind === 'telegram-group') {
      const g = await vault.getTelegramGroup(id);
      if (g.authorized && g.active !== false) return { allowed: true, reason: 'group-authorized' };
      return { allowed: false, reason: 'group-not-authorized' };
    }
    return vault.checkChannelAuthority({ kind, id });
  }

  const rateLimit = createRateLimiter({ maxPerWindow: cfg.rateLimitMax, windowMs: cfg.rateLimitWindowMs });
  // Voice (TTS) — harvested tts/ module + multipart sendVoice. Fail-soft: enabled
  // only when a TTS provider is configured (OPENAI_API_KEY / ELEVENLABS_*).
  const voicePipeline = createVoicePipeline({ sendVoice: (a) => telegram.sendVoice(a), agentId: cfg.agentId });

  const telegramSendHandler = createTelegramChokepoint({
    sendToTelegram: (a) => telegram.sendMessage(a),
    recordEgress: (entry) => { vault.recordEgress(entry); },        // fire-and-forget
    persistOutbound: (args) => { vault.captureMessage(args).catch((e) => console.error('[channel-daemon] outbound persist failed:', e.message)); },
    checkAuthority,
    dedup,
    rateLimit,
    voicePipeline,
    getActiveTurn,
    agentId: cfg.agentId,
  });

  const app = createDaemonApp({ telegramSendHandler, getActiveTurn });

  // Phase 2: resolve the turn handler. A test may inject `runTurn`; otherwise
  // select a runtime from config (BYOK key → Claude Agent SDK lane; none →
  // capture-only). The lane serializes turns + owns the active-turn lifecycle.
  let effectiveRunTurn = runTurn;
  let lane = null;
  if (!effectiveRunTurn) {
    const runtime = selectRuntime(cfg);
    if (runtime) {
      lane = createLane({ runtime });
      // Coalesce rapid inbound fragments into one turn (each fragment is still
      // captured per-message upstream). 0 disables → one turn per message.
      if (cfg.coalesceWindowMs > 0) {
        const coalescer = createCoalescer({ windowMs: cfg.coalesceWindowMs, flush: (turnCtx, merged) => lane.runTurn(turnCtx, merged) });
        effectiveRunTurn = (turnCtx, msg) => { coalescer.push(turnCtx, msg); };
      } else {
        effectiveRunTurn = lane.runTurn;
      }
      console.log(`[channel-daemon] two-way replies ON via ${lane.label}${cfg.coalesceWindowMs > 0 ? ` (coalesce ${cfg.coalesceWindowMs}ms)` : ''}`);
    } else {
      effectiveRunTurn = captureOnlyRunTurn;
    }
  }

  // Operator commands (/allow, /disallow, /channels) + group authorization.
  // Command acks go back through this daemon's own chokepoint as trusted
  // (system-template) sends, so they're audited + bypass the authority gate.
  const sendReply = async ({ chatId, text, replyToMessageId }) => {
    try {
      await fetch(`${cfg.selfUrl}/telegram/send`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, text, replyToMessageId, trusted: true }),
      });
    } catch (e) { console.error('[channel-daemon] command reply failed:', e.message); }
  };
  const commands = createCommandHandler({ vault, sendReply, ownerTelegramId: cfg.ownerTelegramId });
  const isGroupAuthorized = async (gid) => { const g = await vault.getTelegramGroup(gid); return !!g.authorized && g.active !== false; };

  // Phase 1: inbound long-poll → (commands) → capture → runTurn.
  const handleInbound = createInboundHandler({ vault, ownerTelegramId: cfg.ownerTelegramId, runTurn: effectiveRunTurn, commands, isGroupAuthorized });
  const poller = createTelegramPoller({ telegram, handleInbound });

  return { app, poller, telegram, lane };
}

async function main() {
  const cfg = loadConfig();
  assertEgressConfig(cfg);
  const { app, poller, telegram } = buildDaemon(cfg);

  // Validate the token up front so a bad token fails loud, not silently mid-poll.
  try {
    const me = await telegram.getMe();
    console.log(`[channel-daemon] telegram bot @${me.username} (id ${me.id})`);
  } catch (e) {
    console.error(`[channel-daemon] telegram getMe failed — check TELEGRAM_BOT_TOKEN: ${e.message}`);
    process.exit(1);
  }

  const server = app.listen(cfg.port, cfg.host, () => {
    console.log(`[channel-daemon] listening on http://${cfg.host}:${cfg.port} (vault: ${cfg.vaultBaseUrl})`);
    console.log('[channel-daemon] Phase 0+1: inbound capture + outbound egress. reply tool agentUrl → this server.');
  });

  poller.start(); // runs until stop()

  const shutdown = () => {
    poller.stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Run only when invoked directly (not when imported by the verify script).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
