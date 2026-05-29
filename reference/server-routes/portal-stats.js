/**
 * Portal stats router (Phase 10 PR 7G).
 *
 * One handler backing the portal overview page: a single round trip of
 * seven parallel D1 aggregations combined into one response shape.
 *
 *   GET /portal/stats
 *
 * Queries issued in parallel:
 *   1. messages aggregate — totals + split by source + min/max created_at
 *   2. messages grouped by agent_id
 *   3. messages last 30 days
 *   4. documents total
 *   5. attachments — totals + split by file_type prefix + summed bytes
 *   6. people — totals + counts by engagement tier
 *   7. mindscape — distinct territories / realms / points
 *
 * `integrations` is derived from the source split: any source with >0
 * messages surfaces as a connected integration row.
 */

import { Router } from 'express';

/**
 * @typedef {object} CreatePortalStatsRouterDeps
 * @property {(req: any) => Promise<object|null>} authenticatePortalRequest
 * @property {() => object|null} tryGetDb
 * @property {object} config — { LOG_PREFIX }
 * @property {object} [log]
 */

export function createPortalStatsRouter(deps) {
  if (!deps) throw new TypeError('createPortalStatsRouter: deps required');
  const { authenticatePortalRequest, tryGetDb, config, log } = deps;

  if (typeof authenticatePortalRequest !== 'function') {
    throw new TypeError('createPortalStatsRouter: authenticatePortalRequest required');
  }
  if (typeof tryGetDb !== 'function') {
    throw new TypeError('createPortalStatsRouter: tryGetDb required');
  }
  if (!config?.LOG_PREFIX) {
    throw new TypeError('createPortalStatsRouter: config.LOG_PREFIX required');
  }

  const { LOG_PREFIX } = config;
  const logger = log || console;
  const err  = logger.error ? logger.error.bind(logger) : console.error;
  const info = logger.info  ? logger.info.bind(logger)  : console.log;

  const router = Router();

  router.get('/portal/stats', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });
      const userId = user.id;

      // Wrap rawQuery to normalise to {results:[...]} for uniform access.
      const d1q = async (sql, params) => ({ results: await db.rawQuery(sql, params) });

      const [msgStats, msgByAgent, msg30d, docCount, attStats, contactStats, mindscapeStats] =
        await Promise.all([
          d1q(
            `SELECT COUNT(*) as total,
              SUM(CASE WHEN source = 'telegram' THEN 1 ELSE 0 END) as telegram,
              SUM(CASE WHEN source LIKE 'discord%' THEN 1 ELSE 0 END) as discord,
              SUM(CASE WHEN source IN ('portal', 'web', 'portal_prompt') THEN 1 ELSE 0 END) as portal,
              SUM(CASE WHEN source = 'whatsapp' THEN 1 ELSE 0 END) as whatsapp,
              SUM(CASE WHEN source LIKE 'import%' OR source = 'linkedin' THEN 1 ELSE 0 END) as imported,
              SUM(CASE WHEN source NOT IN ('telegram', 'whatsapp', 'portal', 'web', 'portal_prompt')
                       AND source NOT LIKE 'discord%' AND source NOT LIKE 'import%'
                       AND source != 'linkedin' THEN 1 ELSE 0 END) as other,
              MIN(created_at) as first_message, MAX(created_at) as last_message
              FROM messages WHERE user_id = ?`,
            [userId],
          ),
          d1q(
            `SELECT agent_id, COUNT(*) as count FROM messages WHERE user_id = ? GROUP BY agent_id`,
            [userId],
          ),
          d1q(
            `SELECT COUNT(*) as count FROM messages
             WHERE user_id = ? AND created_at > datetime('now', '-30 days')`,
            [userId],
          ),
          d1q(`SELECT COUNT(*) as total FROM documents WHERE user_id = ?`, [userId]),
          d1q(
            `SELECT COUNT(*) as total,
              SUM(CASE WHEN file_type LIKE 'image%' THEN 1 ELSE 0 END) as images,
              SUM(CASE WHEN file_type LIKE 'audio%' THEN 1 ELSE 0 END) as voice,
              SUM(CASE WHEN file_type LIKE 'video%' THEN 1 ELSE 0 END) as video,
              COALESCE(SUM(file_size), 0) as total_bytes
              FROM attachments WHERE user_id = ?`,
            [userId],
          ),
          d1q(
            `SELECT COUNT(*) as total,
              SUM(CASE WHEN status = 'inner' THEN 1 ELSE 0 END) as inner_count,
              SUM(CASE WHEN status = 'engaged' THEN 1 ELSE 0 END) as engaged_count,
              SUM(CASE WHEN status = 'acknowledged' THEN 1 ELSE 0 END) as acknowledged_count,
              SUM(CASE WHEN status = 'connected' THEN 1 ELSE 0 END) as connected_count
              FROM people WHERE user_id = ?`,
            [userId],
          ),
          d1q(
            `SELECT
              (SELECT COUNT(DISTINCT territory_id) FROM clustering_points
                 WHERE user_id = ? AND territory_id IS NOT NULL AND territory_id != -1) as territories,
              (SELECT COUNT(DISTINCT realm_id) FROM clustering_points
                 WHERE user_id = ? AND realm_id IS NOT NULL) as realms,
              (SELECT COUNT(*) FROM clustering_points WHERE user_id = ?) as points`,
            [userId, userId, userId],
          ),
        ]);

      const msg      = msgStats?.results?.[0]       || {};
      const att      = attStats?.results?.[0]       || {};
      const contacts = contactStats?.results?.[0]   || {};
      const mind     = mindscapeStats?.results?.[0] || {};

      const sourceMap = {
        telegram: { name: 'Telegram', icon: 'telegram' },
        discord:  { name: 'Discord',  icon: 'discord'  },
        portal:   { name: 'Portal',   icon: 'portal'   },
        whatsapp: { name: 'WhatsApp', icon: 'whatsapp' },
        imported: { name: 'Imported', icon: 'import'   },
      };
      const integrations = Object.entries(sourceMap)
        .map(([key, meta]) => ({
          ...meta,
          messageCount: msg[key] || 0,
          status: (msg[key] || 0) > 0 ? 'connected' : 'not_connected',
        }))
        .filter((i) => i.messageCount > 0);

      const byAgent = {};
      for (const row of (msgByAgent?.results || [])) {
        if (row.agent_id) byAgent[row.agent_id] = row.count;
      }

      res.json({
        messages: {
          total: msg.total || 0,
          bySource: {
            telegram: msg.telegram || 0,
            discord:  msg.discord  || 0,
            portal:   msg.portal   || 0,
            whatsapp: msg.whatsapp || 0,
            imported: msg.imported || 0,
            other:    msg.other    || 0,
          },
          byAgent,
          dateRange: { first: msg.first_message, last: msg.last_message },
          last30Days: msg30d?.results?.[0]?.count || 0,
        },
        documents: { total: docCount?.results?.[0]?.total || 0 },
        attachments: {
          total: att.total || 0,
          byType: { image: att.images || 0, voice: att.voice || 0, video: att.video || 0 },
          totalSizeMB: Math.round((att.total_bytes || 0) / 1024 / 1024),
        },
        contacts: {
          total: contacts.total || 0,
          byTier: {
            inner:        contacts.inner_count        || 0,
            engaged:      contacts.engaged_count      || 0,
            acknowledged: contacts.acknowledged_count || 0,
            connected:    contacts.connected_count    || 0,
          },
        },
        mindscape: {
          territories: mind.territories || 0,
          realms:      mind.realms      || 0,
          points:      mind.points      || 0,
        },
        integrations,
      });
    } catch (e) {
      err(`[${LOG_PREFIX}] [portal/stats] ${e.message}`);
      res.status(500).json({ error: 'Failed to load stats' });
    }
  });

  info(`[${LOG_PREFIX}] portal-stats-router mounted 1 handler`);

  return router;
}
