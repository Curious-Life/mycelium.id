/**
 * Portal audit router (Phase 10 PR 7G).
 *
 * One middleware + one handler:
 *
 *   USE /portal              — per-request audit trail for state-changing
 *                              portal requests (POST/PUT/DELETE). On
 *                              res.finish, writes a `portal.write` row to
 *                              audit_log with method / status / duration.
 *                              Never logs bodies or PII.
 *
 *   GET /portal/audit/log    — paginated read of audit_log; filters by
 *                              event_type and `after`; capped at 500 rows.
 *                              Queries via rawQueryAdmin (bypasses tenant
 *                              WHERE-injection) because audit_log is owner-
 *                              scoped infrastructure, not user data.
 *
 * Ordering note: The audit middleware uses `res.on('finish')` to attach
 * its audit write AFTER the handler completes. For that listener to fire,
 * the middleware must run BEFORE the terminating handler on the request
 * path. In app.js this router is mounted near the end of the portal
 * chain, so state-changing requests to routers registered EARLIER do not
 * get audited. That is the pre-extraction behavior and this router
 * preserves it. Moving the audit-middleware mount point earlier in app.js
 * would expand coverage but is out of scope here.
 */

import { Router } from 'express';

/**
 * @typedef {object} CreatePortalAuditRouterDeps
 * @property {(req: any) => Promise<object|null>} authenticatePortalRequest
 * @property {() => object|null} tryGetDb
 * @property {object} config — { LOG_PREFIX }
 * @property {object} [log]
 */

export function createPortalAuditRouter(deps) {
  if (!deps) throw new TypeError('createPortalAuditRouter: deps required');
  const { authenticatePortalRequest, tryGetDb, config, log } = deps;

  if (typeof authenticatePortalRequest !== 'function') {
    throw new TypeError('createPortalAuditRouter: authenticatePortalRequest required');
  }
  if (typeof tryGetDb !== 'function') {
    throw new TypeError('createPortalAuditRouter: tryGetDb required');
  }
  if (!config?.LOG_PREFIX) {
    throw new TypeError('createPortalAuditRouter: config.LOG_PREFIX required');
  }

  const { LOG_PREFIX } = config;
  const logger = log || console;
  const err  = logger.error ? logger.error.bind(logger) : console.error;
  const info = logger.info  ? logger.info.bind(logger)  : console.log;

  const router = Router();

  // ── Audit middleware: logs state-changing portal requests ──────────

  router.use('/portal', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const startTime = Date.now();
    res.on('finish', () => {
      // authenticatePortalRequest sets req._auditUser when the session
      // resolves. Unauthenticated or failed-auth writes skip the audit.
      const user = req._auditUser;
      if (!user) return;
      tryGetDb()?.audit.log({
        action: 'portal.write',
        userId: user.id,
        ip: req.ip,
        resourceType: req.path,
        details: {
          method: req.method,
          status: res.statusCode,
          duration: Date.now() - startTime,
        },
      }).catch(() => { /* audit write is best-effort */ });
    });
    next();
  });

  // ── GET /portal/audit/log: read-back of audit_log ──────────────────

  router.get('/portal/audit/log', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const { limit, event_type, after } = req.query;

      // audit_log holds only metadata (method / status / endpoint /
      // event_type / ip / created_at). No PII. rawQueryAdmin bypasses
      // tenant WHERE-injection because audit_log is infrastructure, not
      // user data.
      let sql = 'SELECT id, event_type, agent_id, ip_address, endpoint, method, success, details, created_at FROM audit_log WHERE 1=1';
      const params = [];

      if (event_type) { sql += ' AND event_type = ?'; params.push(event_type); }
      if (after)      { sql += ' AND created_at > ?'; params.push(after); }

      sql += ' ORDER BY created_at DESC LIMIT ?';
      params.push(Math.min(parseInt(limit, 10) || 100, 500));

      const rows = await db.rawQueryAdmin(sql, params);
      res.json({ events: rows });
    } catch (e) {
      err(`[${LOG_PREFIX}] [audit/log] ${e.message}`);
      res.status(500).json({ error: 'Failed to query audit log' });
    }
  });

  info(`[${LOG_PREFIX}] portal-audit-router mounted 1 middleware + 1 handler`);

  return router;
}
