/**
 * Portal cycles router (Phase 10 PR 7E, Wave 3.4).
 *
 * Agent autonomous activity view — one handler returning the wake-cycle
 * schedule for every agent (fetched live from each agent's /wake-cycles),
 * enriched with health state, schedule-parsing into concrete fire hours
 * for today, plus the 10 most recent background jobs from D1.
 *
 *   GET /portal/cycles  — aggregated cycle view across AGENT_REGISTRY
 *
 * The schedule parser recognizes three forms:
 *   - daily:HH
 *   - every:Nh
 *   - weekly:DOW:HH
 * Anything else leaves fireHour null and firedToday false.
 */

import { Router } from 'express';

/**
 * @typedef {object} CreatePortalCyclesRouterDeps
 * @property {(req: any) => Promise<object|null>} authenticatePortalRequest
 * @property {() => object|null}                  tryGetDb
 * @property {Record<string, { name: string, role: string, color: string, port: number }>} agentRegistry
 * @property {object} config  — { LOG_PREFIX }
 * @property {object} [log]
 */

export function createPortalCyclesRouter(deps) {
  if (!deps) throw new TypeError('createPortalCyclesRouter: deps required');
  const { authenticatePortalRequest, tryGetDb, agentRegistry, config, log } = deps;

  if (typeof authenticatePortalRequest !== 'function') {
    throw new TypeError('createPortalCyclesRouter: authenticatePortalRequest required');
  }
  if (typeof tryGetDb !== 'function') {
    throw new TypeError('createPortalCyclesRouter: tryGetDb required');
  }
  if (!agentRegistry || typeof agentRegistry !== 'object') {
    throw new TypeError('createPortalCyclesRouter: agentRegistry required');
  }
  if (!config?.LOG_PREFIX) {
    throw new TypeError('createPortalCyclesRouter: config.LOG_PREFIX required');
  }

  const { LOG_PREFIX } = config;
  const logger = log || console;
  const err = logger.error ? logger.error.bind(logger) : console.error;
  const info = logger.info ? logger.info.bind(logger) : console.log;

  const router = Router();

  router.get('/portal/cycles', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const agentEntries = Object.entries(agentRegistry);
      const results = await Promise.all(
        agentEntries.map(async ([agentId, infoEntry]) => {
          const agentUrl = `http://localhost:${infoEntry.port}`;
          let cycles = [];
          let health = null;

          try {
            const [cycleRes, healthRes] = await Promise.all([
              fetch(`${agentUrl}/wake-cycles`, { signal: AbortSignal.timeout(3000) })
                .then((r) => (r.ok ? r.json() : null)).catch(() => null),
              fetch(`${agentUrl}/health`, { signal: AbortSignal.timeout(3000) })
                .then((r) => (r.ok ? r.json() : null)).catch(() => null),
            ]);

            if (cycleRes?.cycles) cycles = cycleRes.cycles;
            if (healthRes) {
              health = {
                status: healthRes.status,
                uptime: healthRes.uptime,
                activeTasks: healthRes.state?.activeTasks || 0,
                lastMessageTime: healthRes.state?.lastMessageTime || null,
                model: healthRes.lastModelUsed || healthRes.model,
              };
            }
          } catch { /* agent unreachable — record as offline below */ }

          return {
            agentId,
            name: infoEntry.name,
            color: infoEntry.color,
            role: infoEntry.role,
            status: health?.status || 'offline',
            health,
            cycles: cycles.map((c) => ({
              id: c.id,
              description: c.description,
              schedule: c.schedule,
              enabled: c.enabled !== false,
              essential: c.essential || false,
              // Fields added in Scheduler A1 — all optional; older agents
              // that haven't picked up the new code just return undefined.
              // `lifecycle` holds the active|paused|cancelled state; the existing
              // `status` field is reused below for completed|upcoming timeline state.
              lifecycle: c.status || (c.enabled === false ? 'paused' : 'active'),
              created_by: c.created_by || 'seed',
              purpose: c.purpose || null,
              delivery_channel: c.delivery_channel || 'lifecycle',
              last_run_at: c.last_run_at || null,
              last_run_status: c.last_run_status || null,
            })),
          };
        }),
      );

      const now = new Date();
      const today = now.toISOString().split('T')[0];
      const currentHour = now.getHours();
      const currentDay = now.getDay();

      for (const agent of results) {
        for (const cycle of agent.cycles) {
          let fireHour = null;
          let firedToday = false;

          if (cycle.schedule?.startsWith('daily:')) {
            fireHour = parseInt(cycle.schedule.split(':')[1], 10);
            firedToday = currentHour >= fireHour;
          } else if (cycle.schedule?.startsWith('every:')) {
            const intervalH = parseInt(cycle.schedule.match(/(\d+)h/)?.[1] || '24', 10);
            for (let h = 0; h < 24; h += intervalH) {
              if (h <= currentHour) { fireHour = h; firedToday = true; }
            }
            for (let h = 0; h < 24; h += intervalH) {
              if (h > currentHour) { cycle.nextHour = h; break; }
            }
          } else if (cycle.schedule?.startsWith('weekly:')) {
            const parts = cycle.schedule.split(':');
            const dow = parseInt(parts[1], 10);
            fireHour = parseInt(parts[2], 10);
            firedToday = currentDay === dow && currentHour >= fireHour;
            cycle.dayOfWeek = dow;
          }

          cycle.fireHour = fireHour;
          cycle.firedToday = firedToday;
          cycle.status = firedToday ? 'completed' : 'upcoming';
        }
      }

      const db = tryGetDb();
      let recentJobs = [];
      if (db) {
        try {
          recentJobs = await db.rawQuery(
            `SELECT kind, status, stage_label, started_at, finished_at, step, total_steps
             FROM background_jobs WHERE user_id = ?
             ORDER BY started_at DESC LIMIT 10`,
            [user.id],
          );
        } catch { /* no background_jobs table on this VPS — empty list */ }
      }

      res.json({ agents: results, backgroundJobs: recentJobs, date: today });
    } catch (e) {
      err(`[${LOG_PREFIX}] [cycles] ${e.message}`);
      res.status(500).json({ error: 'Failed to load cycles' });
    }
  });

  // ── Cycle mutation proxies ──────────────────────────────────────────────
  // The user triggers pause/resume/cancel from the portal. We resolve the
  // target agent's port from the registry and proxy to its /wake-cycles/:id
  // endpoint with the worker-secret. The agent's scheduler mutates its own
  // wake-cycles.json — the portal never touches the file directly.

  async function proxyCycleAction(req, res, action) {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const infoEntry = agentRegistry[req.params.agentId];
      if (!infoEntry) return res.status(404).json({ error: 'Unknown agent' });

      const secret = process.env.WORKER_SECRET || process.env.MYA_WORKER_SECRET;
      const headers = { 'Content-Type': 'application/json' };
      if (secret) headers['x-worker-secret'] = secret;

      const target = `http://localhost:${infoEntry.port}/wake-cycles/${encodeURIComponent(req.params.cycleId)}/${action}`;
      const upstream = await fetch(target, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(5000),
      });
      const body = await upstream.text();
      res.status(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(body);
    } catch (e) {
      err(`[${LOG_PREFIX}] [cycles ${action}] ${e.message}`);
      res.status(502).json({ error: 'Agent unreachable' });
    }
  }

  router.post('/portal/cycles/:agentId/:cycleId/pause',  (req, res) => proxyCycleAction(req, res, 'pause'));
  router.post('/portal/cycles/:agentId/:cycleId/resume', (req, res) => proxyCycleAction(req, res, 'resume'));
  router.post('/portal/cycles/:agentId/:cycleId/cancel', (req, res) => proxyCycleAction(req, res, 'cancel'));

  info(`[${LOG_PREFIX}] portal-cycles-router mounted 4 handlers`);

  return router;
}
