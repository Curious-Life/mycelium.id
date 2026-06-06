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
import { getActiveTurn, setActiveTurn } from './inbound-context.js';

/**
 * Phase 1 turn stub: register the active turn so a human can exercise the egress
 * chokepoint (and the reply tool) against a live inbound message. Phase 2
 * replaces this with the real single-user lane: setActiveTurn → agent turn
 * (which calls the reply tool) → clearActiveTurn in finally.
 */
function phase1RunTurn(turnCtx) {
  setActiveTurn(turnCtx);
  console.log(`[channel-daemon] active turn set for chat=${turnCtx.channelId} (Phase 1: no agent reply yet)`);
}

export function buildDaemon(cfg, { runTurn = phase1RunTurn } = {}) {
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
    return vault.checkChannelAuthority({ kind, id });
  }

  const telegramSendHandler = createTelegramChokepoint({
    sendToTelegram: (a) => telegram.sendMessage(a),
    recordEgress: (entry) => { vault.recordEgress(entry); },        // fire-and-forget
    persistOutbound: (args) => { vault.captureMessage(args).catch((e) => console.error('[channel-daemon] outbound persist failed:', e.message)); },
    checkAuthority,
    dedup,
    getActiveTurn,
    agentId: cfg.agentId,
  });

  const app = createDaemonApp({ telegramSendHandler, getActiveTurn });

  // Phase 1: inbound long-poll → capture → runTurn.
  const handleInbound = createInboundHandler({ vault, ownerTelegramId: cfg.ownerTelegramId, runTurn });
  const poller = createTelegramPoller({ telegram, handleInbound });

  return { app, poller, telegram };
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
