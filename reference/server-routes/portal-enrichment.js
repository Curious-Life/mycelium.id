/**
 * Portal enrichment router (Phase 10 PR 7D, Wave 3.1).
 *
 * 4 handlers wrapping the local enrichment service (default:
 * http://127.0.0.1:8095) that embeds + tags messages:
 *
 *   GET  /portal/enrichment/status          — message-state counts
 *                                              (total / enriched / embedded /
 *                                              pending / failed) + active
 *                                              job row + service health
 *   POST /portal/enrichment/trigger         — enqueue background job,
 *                                              POST to service /enrich-all,
 *                                              fire "started" email
 *   GET  /portal/enrichment/progress/:jobId — per-job status + IDOR guard
 *                                              + stale-heartbeat detection
 *                                              (60s threshold → abandoned)
 *   POST /portal/enrichment/notify          — INTERNAL (loopback only):
 *                                              the enrichment service
 *                                              pings back on phase
 *                                              transitions so we can send
 *                                              the user a branded email
 *
 * `sendEnrichmentEmail` is injected rather than re-declared — the same
 * helper is already consumed by `portal-uploads.js` (post-upload
 * notifications) and lives in agent-server.js.
 */

import { Router } from 'express';

const ENRICHMENT_URL_DEFAULT = 'http://127.0.0.1:8095';
const ENRICHMENT_SERVICE_HEALTH_TIMEOUT_MS = 2000;
const ENRICHMENT_TRIGGER_TIMEOUT_MS = 5000;
const HEARTBEAT_STALE_MS = 60_000;
const LOOPBACK_IPS = Object.freeze(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * @typedef {object} CreatePortalEnrichmentRouterDeps
 * @property {(req: any) => Promise<object|null>} authenticatePortalRequest
 * @property {() => object|null}                  tryGetDb
 * @property {(userId: string, event: string, messageCount?: number) => Promise<any>} sendEnrichmentEmail
 * @property {object} config  — { LOG_PREFIX, ENRICHMENT_URL? }
 * @property {object} [log]
 */

export function createPortalEnrichmentRouter(deps) {
  if (!deps) throw new TypeError('createPortalEnrichmentRouter: deps required');
  const {
    authenticatePortalRequest,
    tryGetDb,
    sendEnrichmentEmail,
    config,
    log,
  } = deps;

  if (typeof authenticatePortalRequest !== 'function') {
    throw new TypeError('createPortalEnrichmentRouter: authenticatePortalRequest required');
  }
  if (typeof tryGetDb !== 'function') {
    throw new TypeError('createPortalEnrichmentRouter: tryGetDb required');
  }
  if (typeof sendEnrichmentEmail !== 'function') {
    throw new TypeError('createPortalEnrichmentRouter: sendEnrichmentEmail required');
  }
  if (!config?.LOG_PREFIX) {
    throw new TypeError('createPortalEnrichmentRouter: config.LOG_PREFIX required');
  }

  const { LOG_PREFIX } = config;
  // ENRICHMENT_URL resolution order: config override → env → default loopback.
  // Resolved at factory time (not per-request) so tests can point at a stub.
  const enrichmentUrl = config.ENRICHMENT_URL || process.env.ENRICHMENT_URL || ENRICHMENT_URL_DEFAULT;
  const logger = log || console;
  const router = Router();

  router.get('/portal/enrichment/status', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      // Count by nlp_processed state: 0=unprocessed, 2=embedded, 1=enriched, -1=failed
      const [total, enriched, embedded, pending, failed] = await Promise.all([
        db.rawQuery('SELECT COUNT(*) as c FROM messages WHERE user_id = ?', [user.id]),
        db.rawQuery('SELECT COUNT(*) as c FROM messages WHERE user_id = ? AND nlp_processed = 1', [user.id]),
        db.rawQuery('SELECT COUNT(*) as c FROM messages WHERE user_id = ? AND nlp_processed = 2', [user.id]),
        db.rawQuery('SELECT COUNT(*) as c FROM messages WHERE user_id = ? AND (nlp_processed = 0 OR nlp_processed IS NULL)', [user.id]),
        db.rawQuery('SELECT COUNT(*) as c FROM messages WHERE user_id = ? AND nlp_processed = -1', [user.id]),
      ]);

      let service = null;
      try {
        const sRes = await fetch(`${enrichmentUrl}/status`, {
          signal: AbortSignal.timeout(ENRICHMENT_SERVICE_HEALTH_TIMEOUT_MS),
        });
        if (sRes.ok) service = await sRes.json();
      } catch { /* service unavailable */ }

      // Check for running enrichment job
      let activeJob = null;
      try {
        const jobs = await db.rawQuery(
          "SELECT id, status, step, total_steps, stage_label, started_at, last_heartbeat FROM background_jobs WHERE user_id = ? AND kind = 'enrichment' AND status = 'running' ORDER BY started_at DESC LIMIT 1",
          [user.id],
        );
        if (jobs.length > 0) activeJob = jobs[0];
      } catch { /* no background_jobs table yet */ }

      res.json({
        messages: {
          total: total[0]?.c || 0,
          enriched: enriched[0]?.c || 0,
          embedded: embedded[0]?.c || 0,
          pending: pending[0]?.c || 0,
          failed: failed[0]?.c || 0,
        },
        service,
        activeJob,
      });
    } catch {
      res.status(500).json({ error: 'Failed to get enrichment status' });
    }
  });

  router.post('/portal/enrichment/trigger', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const running = await db.rawQuery(
        "SELECT id FROM background_jobs WHERE user_id = ? AND kind = 'enrichment' AND status = 'running' LIMIT 1",
        [user.id],
      );
      if (running.length > 0) {
        return res.json({ jobId: running[0].id, status: 'already_running' });
      }

      const pendingRows = await db.rawQuery(
        'SELECT COUNT(*) as c FROM messages WHERE user_id = ? AND (nlp_processed = 0 OR nlp_processed IS NULL)',
        [user.id],
      );
      const pendingCount = pendingRows[0]?.c || 0;
      if (pendingCount === 0) {
        return res.json({ queued: 0, message: 'All messages are already enriched' });
      }

      const jobId = `enr_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;
      await db.rawQuery(
        `INSERT INTO background_jobs (id, user_id, kind, status, step, total_steps, stage_label, started_at, last_heartbeat)
         VALUES (?, ?, 'enrichment', 'running', 0, 2, 'Starting…', datetime('now'), datetime('now'))`,
        [jobId, user.id],
      );

      try {
        const enrichRes = await fetch(`${enrichmentUrl}/enrich-all`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: user.id, jobId }),
          signal: AbortSignal.timeout(ENRICHMENT_TRIGGER_TIMEOUT_MS),
        });
        if (!enrichRes.ok) {
          await db.rawQuery(
            "UPDATE background_jobs SET status = 'error', error = 'Enrichment service unavailable' WHERE id = ?",
            [jobId],
          );
          return res.status(502).json({ error: 'Enrichment service unavailable' });
        }
      } catch {
        await db.rawQuery(
          "UPDATE background_jobs SET status = 'error', error = 'Enrichment service not running' WHERE id = ?",
          [jobId],
        );
        return res.status(502).json({ error: 'Enrichment service not reachable' });
      }

      // Fire-and-forget — failure here must not affect the handler outcome.
      sendEnrichmentEmail(user.id, 'started', pendingCount).catch(() => {});

      db.audit?.log({
        action: 'enrichment.started',
        userId: user.id,
        ip: req.ip,
        details: { jobId, pendingCount },
      }).catch(() => {});

      res.json({ jobId, status: 'running', pendingCount });
    } catch (e) {
      (logger.error ? logger.error.bind(logger) : console.error)(
        '[enrichment/trigger]', e.message
      );
      res.status(500).json({ error: 'Failed to trigger enrichment' });
    }
  });

  router.get('/portal/enrichment/progress/:jobId', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      // IDOR guard: job id + user id must both match.
      const rows = await db.rawQuery(
        `SELECT id, status, step, total_steps, stage_label, started_at, finished_at, error, last_heartbeat
         FROM background_jobs WHERE id = ? AND user_id = ? AND kind = 'enrichment'`,
        [req.params.jobId, user.id],
      );
      if (!rows.length) return res.status(404).json({ error: 'Job not found' });

      const job = rows[0];

      // Stale-heartbeat detection — if "running" but no heartbeat for 60s,
      // mark abandoned so the UI stops spinning forever.
      if (job.status === 'running' && job.last_heartbeat) {
        const staleMs = Date.now() - new Date(job.last_heartbeat).getTime();
        if (staleMs > HEARTBEAT_STALE_MS) {
          await db.rawQuery(
            "UPDATE background_jobs SET status = 'abandoned', error = 'Heartbeat stalled' WHERE id = ?",
            [job.id],
          );
          job.status = 'abandoned';
          job.error = 'Heartbeat stalled';
        }
      }

      res.json({
        id: job.id,
        status: job.status,
        step: job.step,
        totalSteps: job.total_steps,
        stageLabel: job.stage_label,
        startedAt: job.started_at,
        finishedAt: job.finished_at,
        error: job.error,
      });
    } catch {
      res.status(500).json({ error: 'Failed to get job progress' });
    }
  });

  router.post('/portal/enrichment/notify', async (req, res) => {
    // Internal endpoint — accept only from loopback (the enrichment service
    // runs on the same VPS and calls back on phase transitions).
    const remoteIp = req.ip || req.connection?.remoteAddress || '';
    if (!LOOPBACK_IPS.some(ip => remoteIp.includes(ip))) {
      return res.status(403).json({ error: 'Internal only' });
    }

    const { event, userId, messageCount } = req.body || {};
    if (!event || !userId) return res.status(400).json({ error: 'event and userId required' });

    // Fire-and-forget; the service doesn't care if email delivery succeeds.
    sendEnrichmentEmail(userId, event, messageCount).catch(err => {
      (logger.warn ? logger.warn.bind(logger) : console.warn)(
        `[enrichment/notify] Email failed: ${err.message}`
      );
    });

    res.json({ ok: true });
  });

  (logger.info ? logger.info.bind(logger) : console.log)(
    `[${LOG_PREFIX}] portal-enrichment-router mounted 4 handlers (service=${enrichmentUrl})`
  );

  return router;
}
