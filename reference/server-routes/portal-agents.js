/**
 * Portal agents router (Phase 10 PR 7E, Wave 3.3).
 *
 * Agents dashboard surface. Three handlers, one of which is a long-lived
 * Server-Sent Events stream aggregating activity from every agent's
 * /activity/stream endpoint + periodic heartbeat via /health.
 *
 *   GET /portal/agents                        — all agents + customizations + live health
 *   PUT /portal/agents/:agentId/customize     — display name / personality / emoji
 *   GET /portal/agents/stream                 — SSE aggregator (one connection per upstream)
 *
 * SSE handler lifecycle is delicate:
 *   - On connect, open a fetch stream to each agent's /activity/stream.
 *   - Tag each event with agentId + name + color before forwarding.
 *   - A 10s interval poll enriches with live status via /health.
 *   - A 15s keepalive comment keeps intermediaries from closing the socket.
 *   - On req.close, all upstream AbortControllers fire and intervals clear.
 */

import { Router } from 'express';

/**
 * @typedef {object} CreatePortalAgentsRouterDeps
 * @property {(req: any) => Promise<object|null>} authenticatePortalRequest
 * @property {() => object|null}                  tryGetDb
 * @property {(userId: string, db: object) => Promise<Record<string, object>>} getAgentCustomizations
 * @property {Record<string, { name: string, role: string, color: string, port: number }>} agentRegistry
 * @property {object} config  — { LOG_PREFIX }
 * @property {object} [log]
 */

export function createPortalAgentsRouter(deps) {
  if (!deps) throw new TypeError('createPortalAgentsRouter: deps required');
  const { authenticatePortalRequest, tryGetDb, getAgentCustomizations, agentRegistry, config, log } = deps;

  if (typeof authenticatePortalRequest !== 'function') {
    throw new TypeError('createPortalAgentsRouter: authenticatePortalRequest required');
  }
  if (typeof tryGetDb !== 'function') {
    throw new TypeError('createPortalAgentsRouter: tryGetDb required');
  }
  if (typeof getAgentCustomizations !== 'function') {
    throw new TypeError('createPortalAgentsRouter: getAgentCustomizations required');
  }
  if (!agentRegistry || typeof agentRegistry !== 'object') {
    throw new TypeError('createPortalAgentsRouter: agentRegistry required');
  }
  if (!config?.LOG_PREFIX) {
    throw new TypeError('createPortalAgentsRouter: config.LOG_PREFIX required');
  }

  const { LOG_PREFIX } = config;
  const logger = log || console;
  const err = logger.error ? logger.error.bind(logger) : console.error;
  const info = logger.info ? logger.info.bind(logger) : console.log;

  const router = Router();

  // Lightweight registry — no health checks, no DB hit. The full
  // /portal/agents endpoint pings each agent's /health (3 s timeout
  // each, parallel) which is far too heavy for surfaces like the
  // library page that just want { id, name, color }. Use this when
  // the caller needs the static metadata only.
  router.get('/portal/agents/registry', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const agents = Object.entries(agentRegistry).map(([id, infoEntry]) => ({
        id,
        name: infoEntry.name,
        role: infoEntry.role,
        color: infoEntry.color,
      }));
      res.json({ agents });
    } catch (e) {
      err(`[${LOG_PREFIX}] [agents/registry] ${e.message}`);
      res.status(500).json({ error: 'Failed to load agent registry' });
    }
  });

  router.get('/portal/agents', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const db = tryGetDb();
      const customizations = db ? await getAgentCustomizations(user.id, db) : {};

      const agents = await Promise.all(
        Object.entries(agentRegistry).map(async ([agentId, infoEntry]) => {
          const custom = customizations[agentId];
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3000);
            const healthRes = await fetch(`http://localhost:${infoEntry.port}/health`, {
              signal: controller.signal,
            });
            clearTimeout(timeout);
            const health = await healthRes.json();
            return {
              id: agentId,
              name: custom?.display_name || infoEntry.name,
              defaultName: infoEntry.name,
              role: infoEntry.role,
              color: infoEntry.color,
              port: infoEntry.port,
              status: 'online',
              model: health.lastModelUsed || health.model || 'unknown',
              activeTasks: health.state?.activeTasks || 0,
              personality: custom?.personality || null,
              avatarEmoji: custom?.avatar_emoji || null,
            };
          } catch {
            return {
              id: agentId,
              name: custom?.display_name || infoEntry.name,
              defaultName: infoEntry.name,
              role: infoEntry.role,
              color: infoEntry.color,
              port: infoEntry.port,
              status: 'offline',
              model: null,
              activeTasks: 0,
              personality: custom?.personality || null,
              avatarEmoji: custom?.avatar_emoji || null,
            };
          }
        }),
      );

      res.json({ agents });
    } catch (e) {
      err(`[${LOG_PREFIX}] [agents] list failed: ${e.message}`);
      res.status(500).json({ error: 'Failed to load agents' });
    }
  });

  router.put('/portal/agents/:agentId/customize', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const { agentId } = req.params;
      if (!agentRegistry[agentId]) return res.status(404).json({ error: 'Unknown agent' });

      const { displayName, personality, avatarEmoji } = req.body || {};

      const safeName = displayName ? String(displayName).slice(0, 50).trim() : null;
      const safePersonality = personality ? String(personality).slice(0, 2000).trim() : null;
      const safeEmoji = avatarEmoji ? String(avatarEmoji).slice(0, 10).trim() : null;

      await db.rawQuery(
        `INSERT INTO agent_customizations (user_id, agent_id, display_name, personality, avatar_emoji)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user_id, agent_id) DO UPDATE SET
           display_name = COALESCE(excluded.display_name, display_name),
           personality = COALESCE(excluded.personality, personality),
           avatar_emoji = COALESCE(excluded.avatar_emoji, avatar_emoji),
           updated_at = datetime('now')`,
        [user.id, agentId, safeName, safePersonality, safeEmoji],
      );

      res.json({ ok: true, name: safeName });
    } catch (e) {
      err(`[${LOG_PREFIX}] [agents/customize] ${e.message}`);
      res.status(500).json({ error: 'Failed to customize agent' });
    }
  });

  router.get('/portal/agents/stream', async (req, res) => {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    let closed = false;
    const upstreamConnections = [];

    for (const [agentId, infoEntry] of Object.entries(agentRegistry)) {
      try {
        const controller = new AbortController();
        const fetchRes = await fetch(`http://localhost:${infoEntry.port}/activity/stream`, {
          signal: controller.signal,
        });
        upstreamConnections.push({ controller, agentId });

        const reader = fetchRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        (async () => {
          try {
            while (!closed) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';
              for (const line of lines) {
                if (closed) break;
                if (line.startsWith('data: ')) {
                  try {
                    const entry = JSON.parse(line.slice(6));
                    entry.agentId = agentId;
                    entry.agentName = infoEntry.name;
                    entry.agentColor = infoEntry.color;
                    res.write(`data: ${JSON.stringify(entry)}\n\n`);
                  } catch { /* skip unparseable */ }
                }
              }
            }
          } catch {
            if (!closed) {
              res.write(`data: ${JSON.stringify({
                type: 'status',
                content: 'Agent disconnected',
                agentId,
                agentName: infoEntry.name,
                agentColor: infoEntry.color,
                timestamp: new Date().toISOString(),
              })}\n\n`);
            }
          }
        })();
      } catch {
        // Upstream unreachable at startup — skip
      }
    }

    const healthPoll = setInterval(async () => {
      if (closed) return;
      const statuses = await Promise.all(
        Object.entries(agentRegistry).map(async ([agentId, infoEntry]) => {
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 2000);
            const healthRes = await fetch(`http://localhost:${infoEntry.port}/health`, { signal: controller.signal });
            clearTimeout(timeout);
            const health = await healthRes.json();
            return {
              agentId,
              name: infoEntry.name,
              color: infoEntry.color,
              status: 'online',
              activeTasks: health.state?.activeTasks || 0,
              model: health.lastModelUsed || health.model,
            };
          } catch {
            return { agentId, name: infoEntry.name, color: infoEntry.color, status: 'offline', activeTasks: 0, model: null };
          }
        }),
      );
      if (!closed) {
        res.write(`data: ${JSON.stringify({ type: 'heartbeat', agents: statuses, timestamp: new Date().toISOString() })}\n\n`);
      }
    }, 10000);

    const keepalive = setInterval(() => {
      if (!closed) res.write(': keepalive\n\n');
    }, 15000);

    req.on('close', () => {
      closed = true;
      clearInterval(healthPoll);
      clearInterval(keepalive);
      for (const conn of upstreamConnections) {
        try { conn.controller.abort(); } catch { /* already aborted */ }
      }
    });
  });

  info(`[${LOG_PREFIX}] portal-agents-router mounted 3 handlers`);

  return router;
}
