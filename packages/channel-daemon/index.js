/**
 * Channel-daemon entrypoint — wires the configured platforms (Telegram and/or
 * Discord) into the shared egress chokepoint + agent turn pipeline and starts the
 * loopback server. Each platform is built only when its token is configured; both
 * share one runtime/lane/dedup/rate-limit and the active-turn registry.
 *
 * Config comes from the vault (portal Settings → Channels, hydrated over loopback)
 * with env as the fallback. Run: node packages/channel-daemon/index.js
 */
import { loadConfig, assertEgressConfig, applyChannelConfigToEnv } from './config.js';
import { createVaultClient } from './vault-client.js';
import { createEnvelopeDedup } from './dedup.js';
import { createRateLimiter } from './ratelimit.js';
import { createDaemonApp } from './server.js';
import { selectRuntime } from './agent/runtime.js';
import { createLane } from './agent/lane.js';
import { createCoalescer } from './transport/coalescer.js';
import { getActiveTurn } from './inbound-context.js';
// telegram
import { createTelegramApi } from './telegram-api.js';
import { createTelegramChokepoint } from './chokepoint.js';
import { createVoicePipeline } from './voice-pipeline.js';
import { createInboundHandler } from './inbound.js';
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

/**
 * @param {object} cfg
 * @param {object} [opts]
 * @param {Function} [opts.runTurn]  override the turn handler (tests inject a fake)
 */
export function buildDaemon(cfg, { runTurn } = {}) {
  const vault = createVaultClient({ baseUrl: cfg.vaultBaseUrl });
  const dedup = createEnvelopeDedup();
  const rateLimit = createRateLimiter({ maxPerWindow: cfg.rateLimitMax, windowMs: cfg.rateLimitWindowMs });

  // ── shared agent-turn pipeline (one runtime/lane for all platforms) ────────
  let effectiveRunTurn = runTurn;
  let lane = null;
  if (!effectiveRunTurn) {
    const runtime = selectRuntime(cfg);
    if (runtime) {
      lane = createLane({ runtime });
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

  const recordEgress = (entry) => { vault.recordEgress(entry); };
  const persistOutbound = (args) => { vault.captureMessage(args).catch((e) => console.error('[channel-daemon] outbound persist failed:', e.message)); };

  let telegram = null, poller = null, telegramSendHandler;
  let discord = null, gateway = null, discordSendHandler;

  // ── Telegram ───────────────────────────────────────────────────────────────
  if (cfg.botToken) {
    telegram = createTelegramApi({ botToken: cfg.botToken });
    const voicePipeline = createVoicePipeline({ sendVoice: ({ target, filePath, replyToMessageId }) => telegram.sendVoice({ chatId: target, filePath, replyToMessageId }), agentId: cfg.agentId });

    async function checkTelegramAuthority({ kind, id }) {
      if (cfg.ownerTelegramId && String(id) === String(cfg.ownerTelegramId)) return { allowed: true, reason: 'owner-bootstrap' };
      if (kind === 'telegram-group') {
        const g = await vault.getTelegramGroup(id);
        return g.authorized && g.active !== false ? { allowed: true, reason: 'group-authorized' } : { allowed: false, reason: 'group-not-authorized' };
      }
      return vault.checkChannelAuthority({ kind, id });
    }

    telegramSendHandler = createTelegramChokepoint({
      sendToTelegram: (a) => telegram.sendMessage(a), recordEgress, persistOutbound,
      checkAuthority: checkTelegramAuthority, dedup, rateLimit, voicePipeline, getActiveTurn, agentId: cfg.agentId,
    });

    const sendReply = async ({ chatId, text, replyToMessageId }) => {
      try { await fetch(`${cfg.selfUrl}/telegram/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId, text, replyToMessageId, trusted: true }) }); }
      catch (e) { console.error('[channel-daemon] command reply failed:', e.message); }
    };
    const commands = createCommandHandler({ vault, sendReply, ownerTelegramId: cfg.ownerTelegramId });
    const isGroupAuthorized = async (gid) => { const g = await vault.getTelegramGroup(gid); return !!g.authorized && g.active !== false; };
    const handleInbound = createInboundHandler({ vault, ownerTelegramId: cfg.ownerTelegramId, runTurn: effectiveRunTurn, commands, isGroupAuthorized });
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
    async function checkDiscordAuthority({ kind, id }) {
      const turn = getActiveTurn();
      if (turn && String(turn.channelId) === String(id) && (turn.source === 'discord' || turn.source === 'discord-thread')) {
        return { allowed: true, reason: 'reply-to-inbound' };
      }
      const a = await vault.checkChannelAuthority({ kind: 'discord', id });
      return a?.allowed ? { allowed: true, reason: 'registry' } : { allowed: false, reason: 'discord-channel-not-authorized' };
    }

    discordSendHandler = createDiscordChokepoint({
      sendToDiscord: (a) => discord.sendMessage(a), recordEgress, persistOutbound,
      checkAuthority: checkDiscordAuthority, dedup, rateLimit, voicePipeline: discordVoice, getActiveTurn, agentId: cfg.agentId,
    });

    const discordSendReply = async ({ channelId, content, replyToMessageId }) => {
      try { await fetch(`${cfg.selfUrl}/discord/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channelId, content, replyToMessageId, trusted: true }) }); }
      catch (e) { console.error('[channel-daemon] discord command reply failed:', e.message); }
    };
    const discordCommands = createDiscordCommandHandler({ vault, sendReply: discordSendReply, ownerDiscordId: cfg.ownerDiscordId });
    const isChannelAuthorized = async (id) => { const a = await vault.checkChannelAuthority({ kind: 'discord', id }); return !!a?.allowed; };
    const handleDiscordInbound = createDiscordInboundHandler({ vault, ownerDiscordId: cfg.ownerDiscordId, runTurn: effectiveRunTurn, commands: discordCommands, isChannelAuthorized });
    gateway = createDiscordGateway({ botToken: cfg.discordBotToken, handleInbound: handleDiscordInbound });
  }

  const app = createDaemonApp({ telegramSendHandler, discordSendHandler, getActiveTurn });
  return { app, poller, gateway, telegram, discord, lane, vault };
}

async function main() {
  // Hydrate from vault-managed config (portal is authoritative) BEFORE loading cfg.
  let cfg = loadConfig();
  try {
    const cc = await createVaultClient({ baseUrl: cfg.vaultBaseUrl }).getChannelConfig();
    if (cc) { applyChannelConfigToEnv(cc); cfg = loadConfig(); console.log('[channel-daemon] config hydrated from vault.'); }
  } catch (e) { console.error('[channel-daemon] vault config hydrate skipped:', e.message); }

  assertEgressConfig(cfg);
  const { app, poller, gateway, telegram, discord, lane, vault } = buildDaemon(cfg);

  // Validate tokens up front so a bad token fails loud, not silently mid-run.
  if (telegram) {
    try { const me = await telegram.getMe(); console.log(`[channel-daemon] telegram bot @${me.username} (id ${me.id})`); }
    catch (e) { console.error(`[channel-daemon] telegram getMe failed — check TELEGRAM_BOT_TOKEN: ${e.message}`); process.exit(1); }
  }
  if (discord) {
    try { const me = await discord.getMe(); console.log(`[channel-daemon] discord bot ${me.username} (id ${me.id})`); }
    catch (e) { console.error(`[channel-daemon] discord users/@me failed — check DISCORD_BOT_TOKEN: ${e.message}`); process.exit(1); }
  }

  // Preflight (http mode): two-way replies need the vault MCP to advertise `reply`.
  if (lane && cfg.mcpMode !== 'stdio') {
    const tools = await vault.listToolNames();
    if (tools && !tools.includes('reply')) {
      console.error(`[channel-daemon] ⚠ vault MCP does NOT advertise the 'reply' tool — two-way replies will NOT deliver. Boot the vault with AGENT_URL=${cfg.selfUrl} (and MYCELIUM_MCP_BEARER).`);
    } else if (tools) {
      console.log('[channel-daemon] preflight OK — vault advertises the reply tool.');
    }
  }

  const server = app.listen(cfg.port, cfg.host, () => {
    console.log(`[channel-daemon] listening on http://${cfg.host}:${cfg.port} (vault: ${cfg.vaultBaseUrl})`);
    console.log(`[channel-daemon] platforms: ${[telegram && 'telegram', discord && 'discord'].filter(Boolean).join(' + ') || 'none'}`);
  });

  if (poller) poller.start();
  if (gateway) { gateway.start().catch((e) => console.error('[channel-daemon] discord gateway failed to start:', e.message)); }

  const shutdown = () => {
    if (poller) poller.stop();
    if (gateway) gateway.stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Run only when invoked directly (not when imported by the verify script).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
