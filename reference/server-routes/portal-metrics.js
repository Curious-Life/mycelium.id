/**
 * Portal metrics router (PR1.5 B3).
 *
 * Read API for the cognitive_metrics_harmonic table written by
 * scripts/compute_information_harmonics.py (PR1 v3). Backs the portal
 * vitality/frequency-page rewrite (workstream C).
 *
 * Three GET handlers, all session-gated via authenticatePortalRequest:
 *   GET /portal/metrics/window               — one window of metrics for (user, granularity)
 *   GET /portal/metrics/series               — time-series of one metric across windows
 *   GET /portal/metrics/contracts/:family    — frozen presentation contract for a metric family
 *
 * Pure handlers live in `packages/server/lib/metrics-handlers.js`. This
 * router adds session auth + parses query params + maps thrown
 * RangeError → 400. The internal-metrics router (loopback-gated) shares
 * the same handlers via Pattern B socket-loopback check.
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


export function createPortalMetricsRouter(deps) {
  if (!deps) throw new TypeError('createPortalMetricsRouter: deps required');
  const { authenticatePortalRequest, tryGetDb, safeError, config, log } = deps;

  if (typeof authenticatePortalRequest !== 'function') {
    throw new TypeError('createPortalMetricsRouter: authenticatePortalRequest required');
  }
  if (typeof tryGetDb !== 'function') {
    throw new TypeError('createPortalMetricsRouter: tryGetDb required');
  }
  if (typeof safeError !== 'function') {
    throw new TypeError('createPortalMetricsRouter: safeError required');
  }
  if (!config?.LOG_PREFIX) {
    throw new TypeError('createPortalMetricsRouter: config.LOG_PREFIX required');
  }

  const { LOG_PREFIX } = config;
  const logger = log || console;
  const err = logger.error ? logger.error.bind(logger) : console.error;

  const router = Router();

  // ── GET /portal/metrics/window ─────────────────────────────────────
  router.get('/portal/metrics/window', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const granularity = String(req.query.granularity || 'alpha');
      const metricsParam = req.query.metrics;
      const metrics = typeof metricsParam === 'string' && metricsParam.trim()
        ? metricsParam.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;

      const result = await windowHandler({ db }, { userId: user.id, granularity, metrics });
      res.set('Cache-Control', 'no-store');
      res.json(result);
    } catch (e) {
      if (e instanceof RangeError) {
        return res.status(400).json({ error: e.message });
      }
      err(`[${LOG_PREFIX}] /portal/metrics/window error: ${e.message}`);
      res.status(500).json({ error: safeError(e, 'Failed to load window') });
    }
  });

  // ── GET /portal/metrics/series ─────────────────────────────────────
  router.get('/portal/metrics/series', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const granularity = String(req.query.granularity || 'alpha');
      const metric = String(req.query.metric || '');
      const result = await seriesHandler({ db }, {
        userId: user.id,
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
      err(`[${LOG_PREFIX}] /portal/metrics/series error: ${e.message}`);
      res.status(500).json({ error: safeError(e, 'Failed to load series') });
    }
  });

  // ── GET /portal/metrics/contracts/:family ──────────────────────────
  router.get('/portal/metrics/contracts/:family', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const result = contractsHandler({ family: req.params.family });
      res.set('Cache-Control', 'private, max-age=86400');
      res.json(result);
    } catch (e) {
      if (e?.name === 'UnknownMetricFamilyError') {
        return res.status(404).json({ error: `Unknown family: ${req.params.family}` });
      }
      err(`[${LOG_PREFIX}] /portal/metrics/contracts error: ${e.message}`);
      res.status(500).json({ error: safeError(e, 'Failed to load contract') });
    }
  });

  return router;
}
