/**
 * Portal metric-freshness router (PR 0.3, measurement plane).
 *
 *   GET /portal/metric-freshness   →  per-table freshness map for the
 *                                     authenticated portal user.
 *
 * Returns the same shape as the Worker's /api/metric-freshness so the
 * portal can use one client. We probe the local D1 directly (via
 * tryGetDb) instead of round-tripping the Worker — agent-server already
 * has the right tenant routing and avoids an extra hop on every page
 * load. Budgets are sourced from @mycelium/core/metric-budgets.js (the
 * canonical source).
 *
 * Spec: docs/architecture/MEASUREMENT-PLANE-PLAN.md (PR 0.3).
 */

import { Router } from 'express';
import { METRIC_BUDGETS } from '@mycelium/core/metric-budgets.js';

/**
 * @typedef {object} CreatePortalMetricFreshnessRouterDeps
 * @property {(req: any) => Promise<object|null>} authenticatePortalRequest
 * @property {() => object|null}                  tryGetDb
 * @property {(err: Error, fallback?: string) => string} safeError
 * @property {object} [log]
 */
export function createPortalMetricFreshnessRouter(deps) {
  if (!deps) throw new TypeError('createPortalMetricFreshnessRouter: deps required');
  const { authenticatePortalRequest, tryGetDb, safeError, log } = deps;
  if (typeof authenticatePortalRequest !== 'function') {
    throw new TypeError('createPortalMetricFreshnessRouter: authenticatePortalRequest required');
  }
  if (typeof tryGetDb !== 'function') {
    throw new TypeError('createPortalMetricFreshnessRouter: tryGetDb required');
  }
  if (typeof safeError !== 'function') {
    throw new TypeError('createPortalMetricFreshnessRouter: safeError required');
  }
  const logger = log || console;
  const errLog = logger.error ? logger.error.bind(logger) : console.error;

  const router = Router();

  router.get('/portal/metric-freshness', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const nowMs = Date.now();
      const rows = await Promise.all(
        METRIC_BUDGETS.map(async (b) => {
          let row = null;
          try {
            if (b.probe?.kind === 'pipeline_state') {
              // Custom probe: anchor freshness to a pipeline stage's
              // last_success_at instead of MAX(timestamp_column). Used
              // for tables with no per-row computed_at (e.g.,
              // cognitive_metrics_harmonic — era-level freshness).
              const result = await db.rawQuery(
                `SELECT last_success_at AS last_write FROM pipeline_state
                 WHERE user_id = ? AND stage_name = ?`,
                [user.id, b.probe.stage_name],
              );
              row = (result || [])[0] || null;
            } else {
              const result = await db.rawQuery(
                `SELECT MAX(${b.timestamp_column}) AS last_write FROM ${b.table} WHERE user_id = ?`,
                [user.id],
              );
              row = (result || [])[0] || null;
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('no such table')) {
              return {
                table: b.table,
                present: false,
                last_write: null,
                age_ms: null,
                budget_ms: b.budget_ms,
                cadence: b.cadence,
                description: b.description,
                verdict: 'missing',
              };
            }
            throw err;
          }
          const lastWrite = row?.last_write ?? null;
          if (!lastWrite) {
            return {
              table: b.table,
              present: true,
              last_write: null,
              age_ms: null,
              budget_ms: b.budget_ms,
              cadence: b.cadence,
              description: b.description,
              verdict: 'empty',
            };
          }
          const writeMs = Date.parse(lastWrite);
          const ageMs = Number.isFinite(writeMs) ? nowMs - writeMs : null;
          const verdict =
            ageMs === null ? 'empty' : ageMs <= b.budget_ms ? 'fresh' : 'stale';
          return {
            table: b.table,
            present: true,
            last_write: lastWrite,
            age_ms: ageMs,
            budget_ms: b.budget_ms,
            cadence: b.cadence,
            description: b.description,
            verdict,
          };
        }),
      );

      const summary = rows.reduce(
        (acc, r) => {
          acc.total += 1;
          acc[r.verdict] = (acc[r.verdict] || 0) + 1;
          return acc;
        },
        { total: 0, fresh: 0, stale: 0, missing: 0, empty: 0 },
      );

      res.json({
        user_id: user.id,
        now: new Date(nowMs).toISOString(),
        metrics: rows,
        summary,
      });
    } catch (e) {
      errLog('[metric-freshness] failed:', e);
      res.status(500).json({ error: safeError(e, 'Failed to fetch metric freshness') });
    }
  });

  return router;
}
