/**
 * Portal vitality router (Phase 10 PR 7E, Wave 2.1).
 *
 * Cognitive-measurement surface: snapshots of fingerprint + vitality +
 * complexity + growth events, time chronicles across granularities
 * (day/week/month/year), and the /breath sonification UI.
 *
 * Seven handlers:
 *   GET  /portal/vitality/snapshot               — aggregated 6-source snapshot
 *   GET  /portal/vitality/chronicle              — single chronicle by key
 *   GET  /portal/vitality/chronicle/by-window    — chronicle spanning [start,end]
 *   GET  /portal/vitality/chronicle/breadcrumb   — chronicle hierarchy walk
 *   GET  /portal/vitality/arc                    — current_arc_chronicles row
 *   POST /portal/vitality/chronicle/regenerate   — mark dirty for re-generation
 *   GET  /breath                                  — static HTML sonification UI
 *
 * All /portal/* endpoints require a portal session + DB. /breath is a
 * public HTML shell that loads auth-gated data via /portal/vitality/snapshot.
 */

import path from 'path';
import { Router } from 'express';

/**
 * @typedef {object} CreatePortalVitalityRouterDeps
 * @property {(req: any) => Promise<object|null>} authenticatePortalRequest
 * @property {() => object|null}                  tryGetDb
 * @property {(err: Error, fallback?: string) => string} safeError
 * @property {object} config  — { LOG_PREFIX, staticDir }
 * @property {object} [log]
 */

export function createPortalVitalityRouter(deps) {
  if (!deps) throw new TypeError('createPortalVitalityRouter: deps required');
  const { authenticatePortalRequest, tryGetDb, safeError, config, log } = deps;

  if (typeof authenticatePortalRequest !== 'function') {
    throw new TypeError('createPortalVitalityRouter: authenticatePortalRequest required');
  }
  if (typeof tryGetDb !== 'function') {
    throw new TypeError('createPortalVitalityRouter: tryGetDb required');
  }
  if (typeof safeError !== 'function') {
    throw new TypeError('createPortalVitalityRouter: safeError required');
  }
  if (!config?.LOG_PREFIX) {
    throw new TypeError('createPortalVitalityRouter: config.LOG_PREFIX required');
  }
  if (!config?.staticDir) {
    throw new TypeError('createPortalVitalityRouter: config.staticDir required');
  }

  const { LOG_PREFIX, staticDir } = config;
  const logger = log || console;
  const err = logger.error ? logger.error.bind(logger) : console.error;
  const info = logger.info ? logger.info.bind(logger) : console.log;

  const router = Router();

  router.get('/portal/vitality/snapshot', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const [fpRows, freqRows, complexityRows, eventsResult, sentimentRows, territoryRows] = await Promise.allSettled([
        db.rawQuery('SELECT * FROM user_profiles WHERE user_id = ?', [user.id]),
        db.rawQuery(
          'SELECT * FROM frequency_snapshots WHERE user_id = ? ORDER BY granularity, window_end',
          [user.id],
        ),
        db.rawQuery(
          'SELECT * FROM complexity_snapshots WHERE user_id = ? ORDER BY computed_at DESC LIMIT 30',
          [user.id],
        ),
        db.rawQuery(
          `SELECT ce.*, tp.name as territory_name, tp.essence as territory_essence
           FROM cluster_events ce
           LEFT JOIN territory_profiles tp ON tp.territory_id = ce.cluster_id AND tp.user_id = ce.user_id AND ce.level = 'territory'
           WHERE ce.user_id = ?
           ORDER BY ce.created_at DESC LIMIT 50`,
          [user.id],
        ),
        db.rawQuery(
          `SELECT date(created_at) as day,
            AVG(sentiment_valence) as avg_valence, AVG(sentiment_arousal) as avg_arousal,
            COUNT(*) as msg_count
           FROM messages WHERE user_id = ? AND sentiment_valence IS NOT NULL
           GROUP BY day ORDER BY day DESC LIMIT 30`,
          [user.id],
        ),
        db.rawQuery(
          `SELECT territory_id, name, essence, energy, coherence, growth_state,
                  message_count, archetype_type, archetype_character
           FROM territory_profiles
           WHERE user_id = ? AND dissolved_at IS NULL
           ORDER BY energy DESC NULLS LAST LIMIT 8`,
          [user.id],
        ),
      ]);

      const extract = (r, fallback) =>
        r.status === 'fulfilled' ? (r.value?.results || r.value || fallback) : fallback;

      res.json({
        fingerprint: extract(fpRows, [])?.[0] || null,
        vitality: extract(freqRows, []),
        complexity: extract(complexityRows, []),
        growthEvents: extract(eventsResult, []),
        sentiment: extract(sentimentRows, []),
        territories: extract(territoryRows, []),
      });
    } catch (e) {
      err(`[${LOG_PREFIX}] Vitality snapshot error: ${e.message}`);
      res.status(500).json({ error: safeError(e, 'Failed to load vitality data') });
    }
  });

  router.get('/portal/vitality/chronicle', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const { granularity, period_key } = req.query;
      if (!granularity || !period_key) return res.status(400).json({ error: 'granularity and period_key required' });

      const rows = await db.rawQuery(
        `SELECT * FROM time_chronicles WHERE user_id = ? AND granularity = ? AND period_key = ?`,
        [user.id, granularity, period_key],
      );
      res.json({ chronicle: rows?.[0] || null });
    } catch (e) {
      res.status(500).json({ error: safeError(e, 'Failed to load chronicle') });
    }
  });

  router.get('/portal/vitality/chronicle/by-window', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const { start, end, granularity } = req.query;
      if (!start || !end) return res.status(400).json({ error: 'start and end required' });

      let sql = `SELECT * FROM time_chronicles WHERE user_id = ? AND period_start <= ? AND period_end >= ?`;
      const params = [user.id, end, start];
      if (granularity) {
        sql += ` AND granularity = ?`;
        params.push(granularity);
      }
      sql += ` ORDER BY CASE granularity WHEN 'day' THEN 1 WHEN 'week' THEN 2 WHEN 'month' THEN 3 WHEN 'year' THEN 4 END LIMIT 1`;

      const rows = await db.rawQuery(sql, params);
      res.json({ chronicle: rows?.[0] || null });
    } catch (e) {
      res.status(500).json({ error: safeError(e, 'Failed to load chronicle') });
    }
  });

  router.get('/portal/vitality/chronicle/breadcrumb', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const { granularity, period_key } = req.query;
      if (!granularity || !period_key) return res.status(400).json({ error: 'granularity and period_key required' });

      const grans = ['day', 'week', 'month', 'year'];
      const startIdx = grans.indexOf(granularity);
      const breadcrumb = [];

      let currentKey = period_key;
      for (let i = startIdx; i < grans.length; i++) {
        const rows = await db.rawQuery(
          `SELECT granularity, period_key, theme, signature, period_start, period_end, parent_period_key
           FROM time_chronicles WHERE user_id = ? AND granularity = ? AND period_key = ?`,
          [user.id, grans[i], currentKey],
        );
        if (rows?.[0]) {
          breadcrumb.push(rows[0]);
          currentKey = rows[0].parent_period_key
            || (grans[i] === 'week' ? currentKey.slice(0, 7) : currentKey.slice(0, 4));
        } else if (i > startIdx) {
          break;
        }
      }

      res.json({ breadcrumb });
    } catch (e) {
      res.status(500).json({ error: safeError(e, 'Failed to load breadcrumb') });
    }
  });

  // /breath: vitality sonification UI. Standalone tuning interface; HTML
  // shell is public, all data fetches go through the auth-gated /snapshot
  // endpoint above.
  router.get('/breath', (_req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.sendFile(path.join(staticDir, 'breath.html'));
  });

  router.get('/portal/vitality/arc', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const rows = await db.rawQuery(
        `SELECT * FROM current_arc_chronicles WHERE user_id = ?`, [user.id],
      );
      res.json({ arc: rows?.[0] || null });
    } catch (e) {
      res.status(500).json({ error: safeError(e, 'Failed to load arc') });
    }
  });

  router.post('/portal/vitality/chronicle/regenerate', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const { granularity, period_key } = req.body || {};
      if (!granularity || !period_key) return res.status(400).json({ error: 'granularity and period_key required' });

      await db.rawQuery(
        `UPDATE time_chronicles SET dirty = 1 WHERE user_id = ? AND granularity = ? AND period_key = ?`,
        [user.id, granularity, period_key],
      );

      const row = await db.rawQuery(
        `SELECT parent_period_key FROM time_chronicles WHERE user_id = ? AND granularity = ? AND period_key = ?`,
        [user.id, granularity, period_key],
      );
      const parentKey = row?.[0]?.parent_period_key;
      if (parentKey) {
        const grans = ['day', 'week', 'month', 'year'];
        const startIdx = grans.indexOf(granularity);
        let pKey = parentKey;
        for (let i = startIdx + 1; i < grans.length && pKey; i++) {
          await db.rawQuery(
            `UPDATE time_chronicles SET dirty = 1 WHERE user_id = ? AND granularity = ? AND period_key = ?`,
            [user.id, grans[i], pKey],
          );
          const pRow = await db.rawQuery(
            `SELECT parent_period_key FROM time_chronicles WHERE user_id = ? AND granularity = ? AND period_key = ?`,
            [user.id, grans[i], pKey],
          );
          pKey = pRow?.[0]?.parent_period_key;
        }
      }

      res.json({ queued: true });
    } catch (e) {
      res.status(500).json({ error: safeError(e, 'Failed to queue regeneration') });
    }
  });

  info(`[${LOG_PREFIX}] portal-vitality-router mounted 7 handlers`);

  return router;
}
