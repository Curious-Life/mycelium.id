/**
 * Portal activity router (Phase 10 PR 7E, Wave 2.2).
 *
 * Desktop activity aggregation + ingestion. Six handlers covering the
 * /portal/activity/* surface consumed by the portal dashboard + the
 * Mac menubar app's batch sync. All handlers require a portal session
 * and a live DB with the `activity` namespace.
 *
 *   GET  /portal/activity/today     — sessions/topApps/categories/topDomains + totals
 *   GET  /portal/activity/summary   — daily summary for date range
 *   GET  /portal/activity/range     — topApps + topDomains + categories for range
 *   GET  /portal/activity/apps      — top apps for a date
 *   GET  /portal/activity/messages  — message counts by source by day
 *   POST /portal/activity/sync      — Mac menubar upload (≤100 sessions, agent_id
 *                                     stamped from auth so clients can't spoof)
 */

import { Router } from 'express';

/**
 * @typedef {object} CreatePortalActivityRouterDeps
 * @property {(req: any) => Promise<object|null>} authenticatePortalRequest
 * @property {() => object|null}                  tryGetDb
 * @property {object} config  — { LOG_PREFIX }
 * @property {object} [log]
 */

export function createPortalActivityRouter(deps) {
  if (!deps) throw new TypeError('createPortalActivityRouter: deps required');
  const { authenticatePortalRequest, tryGetDb, config, log } = deps;

  if (typeof authenticatePortalRequest !== 'function') {
    throw new TypeError('createPortalActivityRouter: authenticatePortalRequest required');
  }
  if (typeof tryGetDb !== 'function') {
    throw new TypeError('createPortalActivityRouter: tryGetDb required');
  }
  if (!config?.LOG_PREFIX) {
    throw new TypeError('createPortalActivityRouter: config.LOG_PREFIX required');
  }

  const { LOG_PREFIX } = config;
  const logger = log || console;
  const err = logger.error ? logger.error.bind(logger) : console.error;
  const info = logger.info ? logger.info.bind(logger) : console.log;

  const router = Router();

  router.get('/portal/activity/today', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const date = req.query.date || new Date().toISOString().split('T')[0];
      const [sessions, topApps, categories, topDomains] = await Promise.all([
        db.activity.getSessions(user.id, { date, limit: 500 }),
        db.activity.getTopApps(user.id, { date, limit: 10 }),
        db.activity.getCategoryBreakdown(user.id, { date }),
        db.activity.getTopDomains(user.id, { date, limit: 15 }),
      ]);

      let activeSeconds = 0, idleSeconds = 0, weightedProductivity = 0;
      for (const s of sessions) {
        if (s.idle) {
          idleSeconds += s.duration_s || 0;
        } else {
          activeSeconds += s.duration_s || 0;
          weightedProductivity += (s.productivity || 50) * (s.duration_s || 0);
        }
      }
      const productivityScore = activeSeconds > 0 ? Math.round(weightedProductivity / activeSeconds) : 50;

      res.json({
        date,
        sessions,
        topApps,
        topDomains,
        categories,
        totals: { activeSeconds, idleSeconds, productivityScore },
      });
    } catch (e) {
      err(`[${LOG_PREFIX}] [activity] today failed: ${e.message}`);
      res.status(500).json({ error: 'Failed to load activity' });
    }
  });

  router.get('/portal/activity/summary', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const { from, to } = req.query;
      const summary = await db.activity.getDailySummary(user.id, {
        from: from || undefined,
        to: to || undefined,
      });

      res.json({ summary });
    } catch (e) {
      err(`[${LOG_PREFIX}] [activity] summary failed: ${e.message}`);
      res.status(500).json({ error: 'Failed to load activity summary' });
    }
  });

  router.get('/portal/activity/range', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const { from, to } = req.query;
      if (!from || !to) return res.status(400).json({ error: 'from and to required' });

      const [topApps, topDomains, categories] = await Promise.all([
        db.activity.getTopApps(user.id, { from, to, limit: 10 }),
        db.activity.getTopDomains(user.id, { from, to, limit: 15 }),
        db.activity.getCategoryBreakdown(user.id, { from, to }),
      ]);

      let activeSeconds = 0, idleSeconds = 0;
      for (const cat of categories) {
        if (cat.category === 'idle') idleSeconds += cat.total_s || 0;
        else activeSeconds += cat.total_s || 0;
      }

      res.json({ topApps, topDomains, categories, totals: { activeSeconds, idleSeconds } });
    } catch (e) {
      err(`[${LOG_PREFIX}] [activity] range failed: ${e.message}`);
      res.status(500).json({ error: 'Failed to load activity range' });
    }
  });

  router.get('/portal/activity/apps', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const date = req.query.date || new Date().toISOString().split('T')[0];
      const limit = parseInt(req.query.limit, 10) || 10;
      const apps = await db.activity.getTopApps(user.id, { date, limit });

      res.json({ apps });
    } catch (e) {
      err(`[${LOG_PREFIX}] [activity] apps failed: ${e.message}`);
      res.status(500).json({ error: 'Failed to load top apps' });
    }
  });

  router.get('/portal/activity/messages', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const result = await db.rawQuery(`
        SELECT substr(created_at, 1, 10) as day, COUNT(*) as count,
          SUM(CASE WHEN source LIKE 'import_%' OR source = 'claude_export' THEN 1 ELSE 0 END) as imported,
          SUM(CASE WHEN source LIKE 'discord%' THEN 1 ELSE 0 END) as discord,
          SUM(CASE WHEN source = 'telegram' THEN 1 ELSE 0 END) as telegram,
          SUM(CASE WHEN source IN ('portal', 'web', 'portal_prompt') THEN 1 ELSE 0 END) as portal,
          SUM(CASE WHEN source NOT LIKE 'import_%' AND source != 'claude_export'
                AND source NOT LIKE 'discord%' AND source != 'telegram'
                AND source NOT IN ('portal', 'web', 'portal_prompt') THEN 1 ELSE 0 END) as other
        FROM messages WHERE user_id = ?
        GROUP BY day ORDER BY day
      `, [user.id]);

      res.json({ days: result });
    } catch (e) {
      err(`[${LOG_PREFIX}] [activity] messages failed: ${e.message}`);
      res.status(500).json({ error: 'Failed to load message activity' });
    }
  });

  router.post('/portal/activity/sync', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const { sessions } = req.body || {};
      if (!Array.isArray(sessions) || sessions.length === 0) {
        return res.status(400).json({ error: 'No sessions provided' });
      }
      if (sessions.length > 100) {
        return res.status(400).json({ error: 'Max 100 sessions per sync' });
      }

      // Stamp agent_id from the authenticated session — callers cannot spoof.
      const stamped = sessions.map((s) => ({
        ...s,
        agent_id: user.id,
        date: s.date || (s.started_at ? s.started_at.split('T')[0] : new Date().toISOString().split('T')[0]),
      }));

      await db.activity.syncSessions(stamped);

      res.json({ ok: true, synced: stamped.length });
    } catch (e) {
      err(`[${LOG_PREFIX}] [activity] sync failed: ${e.message}`);
      res.status(500).json({ error: 'Failed to sync activity' });
    }
  });

  info(`[${LOG_PREFIX}] portal-activity-router mounted 6 handlers`);

  return router;
}
