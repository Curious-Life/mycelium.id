/**
 * Internal metrics router (PR1.5 B3).
 *
 * Loopback-only counterpart to portal-metrics.js. Read API for the
 * cognitive_metrics_harmonic table for agent MCP tools running on the
 * same VPS. Backs workstream D (agent metrics tools).
 *
 * Three GET handlers, all gated via Pattern B (handler-level socket
 * check, NOT in INTERNAL_ENDPOINTS — mirrors /internal/audit/egress,
 * /internal/inbound-context/current, /internal/guardians/metrics):
 *
 *   - req.socket.remoteAddress in {127.0.0.1, ::1, ::ffff:127.0.0.1}
 *   - x-forwarded-for header MUST be absent (genuine loopback never has it)
 *   - non-loopback → 404 (non-discoverable externally)
 *
 *   GET /internal/metrics/window               — one window
 *   GET /internal/metrics/series               — time-series of one metric
 *   GET /internal/metrics/contracts/:family    — frozen presentation contract
 *
 * User identity: process.env.MYA_USER_ID || process.env.USER_ID ||
 * process.env.AGENT_ID. Mirrors internal-search.js:178 chain. On
 * customer VPSes, ecosystem.config.cjs:70 sets USER_ID = MYA_USER_ID.
 *
 * Spec: docs/architecture/COGNITIVE-METRICS-SPEC.md §4.23/§4.33/§4.34
 * Design: docs/MEASUREMENT-PLANE-PR1.5-B3-DESIGN-2026-05-08.md
 */

import { Router } from 'express';
import {
  windowHandler,
  seriesHandler,
  contractsHandler,
} from '../lib/metrics-handlers.js';

const LOOPBACK_IPS = Object.freeze(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Pattern B socket-loopback check. Mirrors admin-fleet.js:487-490
 * verbatim — returns true iff the immediate socket peer is loopback AND
 * no x-forwarded-for header is present.
 */
function isLocalSocket(req) {
  const socketIp = req.socket?.remoteAddress || '';
  return LOOPBACK_IPS.includes(socketIp) && !req.headers['x-forwarded-for'];
}

function resolveUserId() {
  return process.env.MYA_USER_ID || process.env.USER_ID || process.env.AGENT_ID || null;
}


export function createInternalMetricsRouter(deps) {
  if (!deps) throw new TypeError('createInternalMetricsRouter: deps required');
  const { tryGetDb, safeError, config, log } = deps;

  if (typeof tryGetDb !== 'function') {
    throw new TypeError('createInternalMetricsRouter: tryGetDb required');
  }
  if (typeof safeError !== 'function') {
    throw new TypeError('createInternalMetricsRouter: safeError required');
  }
  if (!config?.LOG_PREFIX) {
    throw new TypeError('createInternalMetricsRouter: config.LOG_PREFIX required');
  }

  const { LOG_PREFIX } = config;
  const logger = log || console;
  const err = logger.error ? logger.error.bind(logger) : console.error;

  const router = Router();

  // ── GET /internal/metrics/window ───────────────────────────────────
  router.get('/internal/metrics/window', async (req, res) => {
    if (!isLocalSocket(req)) return res.status(404).end();
    try {
      const userId = resolveUserId();
      if (!userId) {
        err(`[${LOG_PREFIX}] /internal/metrics/window: no user id env (MYA_USER_ID/USER_ID/AGENT_ID all unset)`);
        return res.status(500).json({ error: 'user-id-unresolved' });
      }
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const granularity = String(req.query.granularity || 'alpha');
      const metricsParam = req.query.metrics;
      const metrics = typeof metricsParam === 'string' && metricsParam.trim()
        ? metricsParam.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;

      const result = await windowHandler({ db }, { userId, granularity, metrics });
      res.set('Cache-Control', 'no-store');
      res.json(result);
    } catch (e) {
      if (e instanceof RangeError) {
        return res.status(400).json({ error: e.message });
      }
      err(`[${LOG_PREFIX}] /internal/metrics/window error: ${e.message}`);
      res.status(500).json({ error: safeError(e, 'Failed to load window') });
    }
  });

  // ── GET /internal/metrics/series ───────────────────────────────────
  router.get('/internal/metrics/series', async (req, res) => {
    if (!isLocalSocket(req)) return res.status(404).end();
    try {
      const userId = resolveUserId();
      if (!userId) {
        err(`[${LOG_PREFIX}] /internal/metrics/series: no user id env`);
        return res.status(500).json({ error: 'user-id-unresolved' });
      }
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const granularity = String(req.query.granularity || 'alpha');
      const metric = String(req.query.metric || '');
      const result = await seriesHandler({ db }, {
        userId,
        metric,
        granularity,
        from: req.query.from,
        to: req.query.to,
        limit: req.query.limit,
      });
      res.set('Cache-Control', 'no-store');
      res.json(result);
    } catch (e) {
      if (e instanceof RangeError) {
        return res.status(400).json({ error: e.message });
      }
      err(`[${LOG_PREFIX}] /internal/metrics/series error: ${e.message}`);
      res.status(500).json({ error: safeError(e, 'Failed to load series') });
    }
  });

  // ── GET /internal/metrics/contracts/:family ────────────────────────
  router.get('/internal/metrics/contracts/:family', async (req, res) => {
    if (!isLocalSocket(req)) return res.status(404).end();
    try {
      const result = contractsHandler({ family: req.params.family });
      res.set('Cache-Control', 'private, max-age=86400');
      res.json(result);
    } catch (e) {
      if (e?.name === 'UnknownMetricFamilyError') {
        return res.status(404).json({ error: `Unknown family: ${req.params.family}` });
      }
      err(`[${LOG_PREFIX}] /internal/metrics/contracts error: ${e.message}`);
      res.status(500).json({ error: safeError(e, 'Failed to load contract') });
    }
  });

  return router;
}

// Exported for unit-test introspection.
export const _internal = Object.freeze({ isLocalSocket, resolveUserId, LOOPBACK_IPS });
