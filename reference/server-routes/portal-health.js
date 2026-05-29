/**
 * Portal health router (Phase 10 PR 7E, Wave 2.3).
 *
 * Apple Health daily summaries synced from the iOS / menubar companion
 * apps. Four handlers — one write, three reads. Requires `db.health`
 * to be present (soft-failed 503 when the schema is missing).
 *
 *   POST /portal/health/sync    — upload ≤60 days of health metrics
 *   GET  /portal/health/today   — metrics for today
 *   GET  /portal/health/range   — metrics for [from, to]
 *   GET  /portal/health/summary — rolling summary (capped at 90 days)
 */

import { Router } from 'express';

/**
 * @typedef {object} CreatePortalHealthRouterDeps
 * @property {(req: any) => Promise<object|null>} authenticatePortalRequest
 * @property {() => object|null}                  tryGetDb
 * @property {object} config  — { LOG_PREFIX }
 * @property {object} [log]
 */

export function createPortalHealthRouter(deps) {
  if (!deps) throw new TypeError('createPortalHealthRouter: deps required');
  const { authenticatePortalRequest, tryGetDb, config, log } = deps;

  if (typeof authenticatePortalRequest !== 'function') {
    throw new TypeError('createPortalHealthRouter: authenticatePortalRequest required');
  }
  if (typeof tryGetDb !== 'function') {
    throw new TypeError('createPortalHealthRouter: tryGetDb required');
  }
  if (!config?.LOG_PREFIX) {
    throw new TypeError('createPortalHealthRouter: config.LOG_PREFIX required');
  }

  const { LOG_PREFIX } = config;
  const logger = log || console;
  const err = logger.error ? logger.error.bind(logger) : console.error;
  const info = logger.info ? logger.info.bind(logger) : console.log;

  const router = Router();

  router.post('/portal/health/sync', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db?.health) return res.status(503).json({ error: 'Database not available' });

      const { days } = req.body || {};
      if (!Array.isArray(days) || days.length === 0) {
        return res.status(400).json({ error: 'No days provided' });
      }
      if (days.length > 60) {
        return res.status(400).json({ error: 'Max 60 days per sync' });
      }

      const synced = await db.health.syncDays(user.id, days);
      info(`[${LOG_PREFIX}] Health sync: ${synced} days for user=${user.id}`);
      res.json({ ok: true, synced });
    } catch (e) {
      err(`[${LOG_PREFIX}] [health] sync failed: ${e.message}`);
      res.status(500).json({ error: 'Failed to sync health data' });
    }
  });

  router.get('/portal/health/today', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db?.health) return res.status(503).json({ error: 'Database not available' });

      const today = new Date().toISOString().split('T')[0];
      const data = await db.health.getDay(user.id, today);
      res.json({ date: today, metrics: data });
    } catch (e) {
      err(`[${LOG_PREFIX}] [health] today failed: ${e.message}`);
      res.status(500).json({ error: 'Failed to load health data' });
    }
  });

  router.get('/portal/health/range', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db?.health) return res.status(503).json({ error: 'Database not available' });

      const { from, to } = req.query;
      if (!from || !to) return res.status(400).json({ error: 'from and to required' });
      const days = await db.health.getRange(user.id, from, to);
      res.json({ days });
    } catch (e) {
      err(`[${LOG_PREFIX}] [health] range failed: ${e.message}`);
      res.status(500).json({ error: 'Failed to load health data' });
    }
  });

  router.get('/portal/health/summary', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db?.health) return res.status(503).json({ error: 'Database not available' });

      const days = parseInt(req.query.days, 10) || 7;
      const summary = await db.health.getSummary(user.id, Math.min(days, 90));
      res.json(summary);
    } catch (e) {
      err(`[${LOG_PREFIX}] [health] summary failed: ${e.message}`);
      res.status(500).json({ error: 'Failed to compute health summary' });
    }
  });

  info(`[${LOG_PREFIX}] portal-health-router mounted 4 handlers`);

  return router;
}
