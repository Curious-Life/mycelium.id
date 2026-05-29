/**
 * Portal trajectory router (Fisher Trajectory Phase 4).
 *
 * Read API for the Fisher trajectory + milestones data written by
 * scripts/compute-fisher.py (Phase 3). Backs the vitality-page integration
 * (§5.1) and the agent MCP tools (§6.2) that read the same tables.
 *
 * Five handlers:
 *   GET  /portal/trajectory               — paged trajectory rows
 *   GET  /portal/trajectory/summary       — period summary (headline numbers)
 *   GET  /portal/trajectory/compare       — period1 vs period2
 *   GET  /portal/trajectory/milestones    — active or all milestones
 *   POST /portal/trajectory/milestones/:id/dismiss — record dismissal
 *
 * All endpoints require a portal session. CSRF is handled by the
 * /portal/* exemption in auth-helpers (see portal-frequency.js
 * regenerate handler for the same pattern).
 *
 * Spec: docs/architecture/FISHER-TRAJECTORY.md
 * Plan: docs/architecture/FISHER-IMPLEMENTATION.md (§4)
 */

import { Router } from 'express';

const VALID_LEVELS = new Set(['realm', 'theme', 'territory']);
const VALID_WINDOW_TYPES = new Set(['daily', 'weekly_rolling', 'weekly_step', 'monthly']);
const PERIOD_DAYS = { week: 7, month: 30, quarter: 90 };

/**
 * Fisher geodesic on the categorical simplex.
 * d(p, q) = 2 * arccos(Σ √(p_i * q_i))
 *
 * p, q are dicts {id: prob}. Mirrors scripts/fisher.py:fisher_distance —
 * same formula, same numerical clamp. Used for period-level displacement
 * (between first and last activation_vector in the period). 5-line port
 * is cheaper than a Worker round-trip.
 */
function fisherDistance(p, q) {
  let bhatt = 0;
  // Union of keys; missing keys treated as 0 (which contributes 0 to bhatt).
  const keys = new Set([...Object.keys(p), ...Object.keys(q)]);
  for (const k of keys) {
    const pk = p[k] ?? 0;
    const qk = q[k] ?? 0;
    bhatt += Math.sqrt(pk * qk);
  }
  bhatt = Math.max(-1, Math.min(1, bhatt));
  return 2 * Math.acos(bhatt);
}

/**
 * Parse an activation_vector JSON column safely. Empty/invalid → {}.
 */
function parseVec(jsonStr) {
  if (!jsonStr) return {};
  try {
    const v = JSON.parse(jsonStr);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function parseContributors(jsonStr) {
  if (!jsonStr) return [];
  try {
    const v = JSON.parse(jsonStr);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * @typedef {object} CreatePortalTrajectoryRouterDeps
 * @property {(req: any) => Promise<object|null>} authenticatePortalRequest
 * @property {() => object|null}                  tryGetDb
 * @property {(err: Error, fallback?: string) => string} safeError
 * @property {object} config  — { LOG_PREFIX }
 * @property {object} [log]
 */
export function createPortalTrajectoryRouter(deps) {
  if (!deps) throw new TypeError('createPortalTrajectoryRouter: deps required');
  const { authenticatePortalRequest, tryGetDb, safeError, config, log } = deps;

  if (typeof authenticatePortalRequest !== 'function') {
    throw new TypeError('createPortalTrajectoryRouter: authenticatePortalRequest required');
  }
  if (typeof tryGetDb !== 'function') {
    throw new TypeError('createPortalTrajectoryRouter: tryGetDb required');
  }
  if (typeof safeError !== 'function') {
    throw new TypeError('createPortalTrajectoryRouter: safeError required');
  }
  if (!config?.LOG_PREFIX) {
    throw new TypeError('createPortalTrajectoryRouter: config.LOG_PREFIX required');
  }

  const { LOG_PREFIX } = config;
  const logger = log || console;
  const err = logger.error ? logger.error.bind(logger) : console.error;
  const info = logger.info ? logger.info.bind(logger) : console.log;

  const router = Router();

  // ── Helper: latest clustering_run_id for the user ──────────────────
  // Canonical run IDs are `era-<ISO>` (packages/metrics/era.js); legacy
  // `fisher-YYYYMMDDTHH` rows lex-beat era-* (ASCII 'f' > 'e') and are
  // aged out by fisher-cleanup (scripts/pipeline-health.js fisher-cleanup).
  async function getLatestRunId(db, userId) {
    const rows = await db.rawQuery(
      `SELECT MAX(clustering_run_id) AS run_id FROM fisher_trajectory WHERE user_id = ?`,
      [userId],
    );
    return rows?.[0]?.run_id || null;
  }

  // ── GET /portal/trajectory ─────────────────────────────────────────
  // Paged trajectory rows for the user × level × window_type, in a date
  // range, optionally pinned to a specific clustering_run_id.
  router.get('/portal/trajectory', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const { level, window_type, from, to, run_id } = req.query;
      if (!level || !VALID_LEVELS.has(level)) {
        return res.status(400).json({
          error: `level must be one of: ${[...VALID_LEVELS].join(', ')}`,
        });
      }
      if (!window_type || !VALID_WINDOW_TYPES.has(window_type)) {
        return res.status(400).json({
          error: `window_type must be one of: ${[...VALID_WINDOW_TYPES].join(', ')}`,
        });
      }

      const runId = run_id || (await getLatestRunId(db, user.id));
      if (!runId) return res.json({ trajectory: [], run_id: null });

      const params = [user.id, level, window_type, runId];
      let sql =
        `SELECT id, level, window_type, window_start, window_end,
                activation_vector, fisher_velocity, fisher_velocity_z,
                fisher_displacement, fisher_trajectory_length, exploration_ratio,
                R_recent, phase, phase_recent, activation_entropy, top_contributors,
                message_count, active_territory_count, low_confidence,
                clustering_run_id, computed_at
         FROM fisher_trajectory
         WHERE user_id = ? AND level = ? AND window_type = ? AND clustering_run_id = ?`;
      if (from) { sql += ` AND window_start >= ?`; params.push(from); }
      if (to)   { sql += ` AND window_end <= ?`;   params.push(to); }
      sql += ` ORDER BY window_start`;

      const rows = await db.rawQuery(sql, params);
      res.json({ trajectory: rows || [], run_id: runId });
    } catch (e) {
      err(`[${LOG_PREFIX}] Trajectory fetch error: ${e.message}`);
      res.status(500).json({ error: safeError(e, 'Failed to load trajectory') });
    }
  });

  // ── GET /portal/trajectory/summary ─────────────────────────────────
  // Headline numbers for a period (week|month|quarter) at a level.
  // Returns null when no trajectory data exists for the user.
  router.get('/portal/trajectory/summary', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const period = String(req.query.period || 'month');
      const level = String(req.query.level || 'realm');
      if (!(period in PERIOD_DAYS)) {
        return res.status(400).json({
          error: `period must be one of: ${Object.keys(PERIOD_DAYS).join(', ')}`,
        });
      }
      if (!VALID_LEVELS.has(level)) {
        return res.status(400).json({
          error: `level must be one of: ${[...VALID_LEVELS].join(', ')}`,
        });
      }

      const runId = await getLatestRunId(db, user.id);
      if (!runId) return res.json({ summary: null });

      // weekly_step is the canonical statistical series (per spec design
      // commitment — never compute period-level metrics on weekly_rolling).
      const rows = await db.rawQuery(
        `SELECT window_start, window_end, activation_vector,
                fisher_velocity, fisher_velocity_z, fisher_trajectory_length,
                fisher_displacement,
                exploration_ratio, R_recent, phase, phase_recent,
                top_contributors, low_confidence
         FROM fisher_trajectory
         WHERE user_id = ? AND level = ? AND window_type = 'weekly_step'
           AND clustering_run_id = ?
           AND window_end >= datetime('now', ?)
         ORDER BY window_start`,
        [user.id, level, runId, `-${PERIOD_DAYS[period]} days`],
      );

      if (!rows || rows.length === 0) return res.json({ summary: null });

      const first = rows[0];
      const last = rows[rows.length - 1];

      // Period-level distance: cumulative L delta within the window.
      // (Stored fisher_trajectory_length is cumulative-from-anchor; the
      // delta gives us the in-period contribution honestly.)
      const total_distance = (last.fisher_trajectory_length || 0)
                             - (first.fisher_trajectory_length || 0);

      // Period displacement: geodesic between activation distributions
      // at the first and last weeks of the period.
      const displacement = fisherDistance(
        parseVec(first.activation_vector),
        parseVec(last.activation_vector),
      );

      // Period exploration ratio. Stable phase if total_distance is ~0.
      const ratio = total_distance > 0.001 ? (displacement / total_distance) : null;

      // Velocity stats over the period.
      const velocities = rows
        .map((r) => r.fisher_velocity)
        .filter((v) => v != null);
      const velocityZs = rows
        .map((r) => r.fisher_velocity_z)
        .filter((z) => z != null);
      const avg_velocity = velocities.length
        ? velocities.reduce((a, b) => a + b, 0) / velocities.length : null;
      const avg_velocity_z = velocityZs.length
        ? velocityZs.reduce((a, b) => a + b, 0) / velocityZs.length : null;

      // Peak velocity row (by raw velocity; carries z if present).
      let peak = null;
      for (const r of rows) {
        if (r.fisher_velocity != null && (!peak || r.fisher_velocity > peak.fisher_velocity)) {
          peak = r;
        }
      }
      const peak_velocity = peak ? {
        date: (peak.window_end || '').slice(0, 10),
        value: peak.fisher_velocity,
        z: peak.fisher_velocity_z ?? null,
      } : null;

      // Phase 1: surface phase_recent / R_recent / displacement_normalized
      // alongside the legacy fields. Consumers can null-coalesce.
      // displacement_normalized = fisher_displacement / π ∈ [0, 1] —
      // bounded "how far you've moved from where you started" for the
      // last weekly_step window in the period.
      const lastDisp = last.fisher_displacement != null
        ? Number(last.fisher_displacement) / Math.PI : null;
      res.json({
        summary: {
          period,
          level,
          run_id: runId,
          phase: last.phase || 'stable',
          phase_recent: last.phase_recent || last.phase || 'stable',
          total_distance,
          displacement,
          displacement_normalized: lastDisp,
          exploration_ratio: ratio,
          R_recent: last.R_recent != null ? last.R_recent : null,
          avg_velocity,
          avg_velocity_z,
          peak_velocity,
          top_movers: parseContributors(last.top_contributors),
          window_count: rows.length,
        },
      });
    } catch (e) {
      err(`[${LOG_PREFIX}] Trajectory summary error: ${e.message}`);
      res.status(500).json({ error: safeError(e, 'Failed to load summary') });
    }
  });

  // ── GET /portal/trajectory/compare ─────────────────────────────────
  // Side-by-side stats for two arbitrary periods. Both computed under the
  // current clustering_run_id so the comparison is taxonomy-consistent.
  router.get('/portal/trajectory/compare', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const { period1_from, period1_to, period2_from, period2_to } = req.query;
      const level = String(req.query.level || 'realm');
      if (!period1_from || !period1_to || !period2_from || !period2_to) {
        return res.status(400).json({
          error: 'period1_from, period1_to, period2_from, period2_to are all required',
        });
      }
      if (!VALID_LEVELS.has(level)) {
        return res.status(400).json({
          error: `level must be one of: ${[...VALID_LEVELS].join(', ')}`,
        });
      }

      const runId = await getLatestRunId(db, user.id);
      if (!runId) return res.json({ comparison: null });

      const fetchPeriod = async (start, end) => {
        const rows = await db.rawQuery(
          `SELECT window_start, window_end, activation_vector,
                  fisher_velocity, fisher_trajectory_length, phase
           FROM fisher_trajectory
           WHERE user_id = ? AND level = ? AND window_type = 'weekly_step'
             AND clustering_run_id = ?
             AND window_start >= ? AND window_end <= ?
           ORDER BY window_start`,
          [user.id, level, runId, start, end],
        );
        if (!rows || rows.length === 0) return null;
        const first = rows[0], last = rows[rows.length - 1];
        const total_distance = (last.fisher_trajectory_length || 0)
                               - (first.fisher_trajectory_length || 0);
        const displacement = fisherDistance(
          parseVec(first.activation_vector),
          parseVec(last.activation_vector),
        );
        return {
          from: start,
          to: end,
          total_distance,
          displacement,
          exploration_ratio: total_distance > 0.001 ? displacement / total_distance : null,
          phase_at_end: last.phase || 'stable',
          window_count: rows.length,
        };
      };

      const [p1, p2] = await Promise.all([
        fetchPeriod(period1_from, period1_to),
        fetchPeriod(period2_from, period2_to),
      ]);
      res.json({ comparison: { run_id: runId, level, period1: p1, period2: p2 } });
    } catch (e) {
      err(`[${LOG_PREFIX}] Trajectory compare error: ${e.message}`);
      res.status(500).json({ error: safeError(e, 'Failed to compare periods') });
    }
  });

  // ── GET /portal/trajectory/milestones ──────────────────────────────
  // Active (undismissed) milestones by default. ?include_dismissed=1 to
  // see the audit trail. Newest first.
  router.get('/portal/trajectory/milestones', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const includeDismissed = req.query.include_dismissed === '1';
      const limitRaw = parseInt(req.query.limit, 10);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 100
        ? limitRaw : 20;

      let sql =
        `SELECT id, rule_type, level, window_start, window_end,
                phase_from, phase_to, velocity_z, displacement,
                detail, headline, dismissed_at, notified_via,
                detected_at, clustering_run_id
         FROM fisher_milestones
         WHERE user_id = ?`;
      const params = [user.id];
      if (!includeDismissed) {
        sql += ` AND dismissed_at IS NULL`;
      }
      sql += ` ORDER BY detected_at DESC LIMIT ?`;
      params.push(limit);

      const rows = await db.rawQuery(sql, params);
      res.json({ milestones: rows || [] });
    } catch (e) {
      err(`[${LOG_PREFIX}] Milestones fetch error: ${e.message}`);
      res.status(500).json({ error: safeError(e, 'Failed to load milestones') });
    }
  });

  // ── POST /portal/trajectory/milestones/:id/dismiss ─────────────────
  // Record dismissal. Idempotent — a second dismiss is a no-op (we only
  // set dismissed_at if it's currently NULL).
  router.post('/portal/trajectory/milestones/:id/dismiss', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const id = String(req.params.id || '');
      if (!id) return res.status(400).json({ error: 'milestone id required' });

      // Scope to the user — defense in depth on top of D1's per-tenant isolation.
      // Idempotent via WHERE dismissed_at IS NULL.
      await db.rawQuery(
        `UPDATE fisher_milestones SET dismissed_at = datetime('now')
         WHERE id = ? AND user_id = ? AND dismissed_at IS NULL`,
        [id, user.id],
      );

      // Verify the row exists for this user (don't leak existence of other users' rows).
      const rows = await db.rawQuery(
        `SELECT id, dismissed_at FROM fisher_milestones WHERE id = ? AND user_id = ?`,
        [id, user.id],
      );
      if (!rows || rows.length === 0) {
        return res.status(404).json({ error: 'milestone not found' });
      }
      res.json({ dismissed: true, dismissed_at: rows[0].dismissed_at });
    } catch (e) {
      err(`[${LOG_PREFIX}] Milestone dismiss error: ${e.message}`);
      res.status(500).json({ error: safeError(e, 'Failed to dismiss milestone') });
    }
  });

  info(`[${LOG_PREFIX}] portal-trajectory-router mounted 5 handlers`);

  return router;
}

// Exposed for unit testing.
export const _internal = { fisherDistance, parseVec, parseContributors };
