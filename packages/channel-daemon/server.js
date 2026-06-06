/**
 * Channel-daemon HTTP app (Phase 0).
 *
 * Exposes exactly the two endpoints the `reply` MCP tool was written against
 * (src/tools/reply.js:103,112):
 *
 *   GET  /internal/inbound-context/current   → 200 ActiveTurnContext | 404 (no active turn)
 *   POST /telegram/send                       → the egress chokepoint
 *
 * Binds loopback-only (127.0.0.1) by default — the agent's processes call it
 * over the same-machine trust boundary, like the canonical bot's HTTP API. The
 * `reply` tool's `agentUrl` points at this app.
 */
import express from 'express';

/**
 * @param {object} deps
 * @param {(req,res)=>any} deps.telegramSendHandler   from createTelegramChokepoint
 * @param {(req,res)=>any} [deps.discordSendHandler]  from createDiscordChokepoint
 * @param {()=>object|null} deps.getActiveTurn
 * @param {string} [deps.jsonLimit]
 */
export function createDaemonApp({ telegramSendHandler, discordSendHandler, getActiveTurn, jsonLimit = '1mb' }) {
  if (typeof getActiveTurn !== 'function') throw new TypeError('createDaemonApp: getActiveTurn required');
  if (typeof telegramSendHandler !== 'function' && typeof discordSendHandler !== 'function') {
    throw new TypeError('createDaemonApp: at least one of telegramSendHandler / discordSendHandler required');
  }

  const app = express();
  app.use(express.json({ limit: jsonLimit }));

  // The reply tool resolves its target from here. 404 (not 200-with-null) so the
  // tool returns errorCode 'no-active-turn' and the agent ends with NO_REPLY.
  app.get('/internal/inbound-context/current', (_req, res) => {
    const turn = getActiveTurn();
    if (!turn || !turn.channelId) return res.status(404).json({ error: 'no-active-turn' });
    res.json(turn);
  });

  // The reply tool POSTs /{platform}/send based on the inbound turn's source.
  if (typeof telegramSendHandler === 'function') app.post('/telegram/send', telegramSendHandler);
  if (typeof discordSendHandler === 'function') app.post('/discord/send', discordSendHandler);

  // Liveness — never reveals config.
  app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'channel-daemon' }));

  return app;
}
