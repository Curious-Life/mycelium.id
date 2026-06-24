/**
 * Fisher trajectory namespace — read-side access to fisher_trajectory and
 * fisher_milestones tables.
 *
 * Five methods that mirror the portal-trajectory.js API but exist as the
 * canonical DB surface for any internal consumer (MCP tools, context-
 * assembly, future server-side renderers). The portal API still calls
 * d.rawQuery directly today; if the surfaces converge, migrate it onto
 * these methods.
 *
 *   getCurrentPhase    — latest weekly_step row at level (default 'realm')
 *   getTrajectory      — paged history for level × window_type
 *   getActiveMilestones — newest undismissed milestones
 *   getTopMovers       — parsed top_contributors for one window
 *   dismissMilestone   — sets dismissed_at, scoped to user, idempotent
 *
 * Conventions:
 *   - Every query starts with `WHERE user_id = ?` as the first filter.
 *   - All values bound via positional placeholders.
 *   - Unknown level → throws (fail-closed); unknown window_type → throws.
 *   - Latest-run resolution uses MAX(clustering_run_id); canonical run-id
 *     format is `era-<ISO8601>` (packages/metrics/era.js) which is
 *     lexicographically chronological. Legacy `fisher-YYYYMMDDTHH` rows
 *     lex-beat era-* (ASCII 'f' > 'e') and are aged out by fisher-cleanup
 *     (scripts/pipeline-health.js fisher-cleanup stage).
 *
 * @typedef {object} FisherNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {(result: any) => any} firstRow
 */

const VALID_LEVELS = new Set(['realm', 'theme', 'territory']);
const VALID_WINDOW_TYPES = new Set(['daily', 'weekly_rolling', 'weekly_step', 'monthly']);

function checkLevel(level) {
  if (!VALID_LEVELS.has(level)) {
    throw new TypeError(`fisher: invalid level "${level}", expected one of: ${[...VALID_LEVELS].join(', ')}`);
  }
}
function checkWindowType(wt) {
  if (!VALID_WINDOW_TYPES.has(wt)) {
    throw new TypeError(`fisher: invalid window_type "${wt}", expected one of: ${[...VALID_WINDOW_TYPES].join(', ')}`);
  }
}

function parseJsonSafe(s, fallback) {
  if (!s) return fallback;
  try {
    const v = JSON.parse(s);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

// K1b: the sensitive fisher metric columns are encrypted at rest; the adapter
// auto-decrypts them to STRINGS on read, so coerce them back to numbers here
// (centralized so every consumer — tools, portal, context — gets numbers).
// NULL columns stay null. Structural columns (phase/level/window_*/counts) are
// plaintext and untouched.
const TRAJ_NUMERIC = [
  'fisher_velocity', 'fisher_velocity_z', 'fisher_displacement',
  'fisher_trajectory_length', 'exploration_ratio', 'R_recent', 'activation_entropy',
];
const MILESTONE_NUMERIC = ['velocity_z', 'displacement'];

function coerceNums(row, fields) {
  if (!row) return row;
  for (const f of fields) {
    const v = row[f];
    if (v !== null && v !== undefined && typeof v !== 'number') {
      const n = Number(v);
      if (!Number.isNaN(n)) row[f] = n;
    }
  }
  return row;
}

export function createFisherNamespace(deps) {
  if (!deps) throw new TypeError('createFisherNamespace: deps required');
  const { d1Query, firstRow } = deps;
  if (typeof d1Query !== 'function') {
    throw new TypeError('createFisherNamespace: d1Query required');
  }
  if (typeof firstRow !== 'function') {
    throw new TypeError('createFisherNamespace: firstRow required');
  }

  // Resolve latest clustering_run_id for a user. Returns null if no rows.
  async function latestRunId(userId) {
    const result = await d1Query(
      `SELECT MAX(clustering_run_id) AS run_id FROM fisher_trajectory WHERE user_id = ?`,
      [userId],
    );
    return firstRow(result)?.run_id || null;
  }

  return {
    /**
     * Latest weekly_step row at the given level — the headline phase + R + z.
     *
     * `level: 'all'` returns the latest row at each of the three levels in
     * one round trip: { realm, theme, territory }, with each value either a
     * row dict or null. Convenient for agent context where all three matter.
     *
     * Returns null when the user has no trajectory data yet.
     */
    async getCurrentPhase(userId, { level = 'realm' } = {}) {
      if (level === 'all') {
        const [realm, theme, territory] = await Promise.all([
          this.getCurrentPhase(userId, { level: 'realm' }),
          this.getCurrentPhase(userId, { level: 'theme' }),
          this.getCurrentPhase(userId, { level: 'territory' }),
        ]);
        // Return null when none of the three have data; otherwise the dict.
        if (!realm && !theme && !territory) return null;
        return { realm, theme, territory };
      }
      checkLevel(level);
      const runId = await latestRunId(userId);
      if (!runId) return null;
      const result = await d1Query(
        `SELECT level, window_start, window_end, phase, phase_recent,
                fisher_velocity, fisher_velocity_z,
                fisher_displacement, fisher_trajectory_length,
                exploration_ratio, R_recent, activation_entropy,
                top_contributors, low_confidence,
                clustering_run_id, computed_at
         FROM fisher_trajectory
         WHERE user_id = ? AND level = ? AND window_type = 'weekly_step'
           AND clustering_run_id = ?
         ORDER BY window_start DESC
         LIMIT 1`,
        [userId, level, runId],
      );
      const row = firstRow(result);
      if (!row) return null;
      return {
        ...coerceNums(row, TRAJ_NUMERIC),
        low_confidence: !!row.low_confidence,
        top_contributors: parseJsonSafe(row.top_contributors, []),
      };
    },

    /**
     * Paged trajectory rows. Defaults to the latest run + weekly_step + realm.
     * Honors from/to as ISO timestamp bounds.
     */
    async getTrajectory(userId, opts = {}) {
      const level = opts.level || 'realm';
      const windowType = opts.windowType || 'weekly_step';
      checkLevel(level);
      checkWindowType(windowType);
      const rawLim = parseInt(opts.limit, 10);
      const limit = !Number.isFinite(rawLim) || rawLim <= 0 ? 100 : Math.min(rawLim, 1000);

      const runId = opts.runId || (await latestRunId(userId));
      if (!runId) return [];

      const params = [userId, level, windowType, runId];
      let sql = `SELECT id, level, window_type, window_start, window_end,
                        activation_vector, fisher_velocity, fisher_velocity_z,
                        fisher_displacement, fisher_trajectory_length,
                        exploration_ratio, R_recent,
                        phase, phase_recent, activation_entropy,
                        top_contributors, message_count, active_territory_count,
                        low_confidence, clustering_run_id, computed_at
                 FROM fisher_trajectory
                 WHERE user_id = ? AND level = ? AND window_type = ? AND clustering_run_id = ?`;
      if (opts.from) { sql += ` AND window_start >= ?`; params.push(opts.from); }
      if (opts.to)   { sql += ` AND window_end <= ?`;   params.push(opts.to); }
      sql += ` ORDER BY window_start LIMIT ?`;
      params.push(limit);

      const result = await d1Query(sql, params);
      const rows = result.results || result || [];
      return rows.map((r) => ({
        ...coerceNums(r, TRAJ_NUMERIC),
        low_confidence: !!r.low_confidence,
        top_contributors: parseJsonSafe(r.top_contributors, []),
      }));
    },

    /**
     * Active milestones for the user, newest first. By default returns
     * undismissed only; pass { includeDismissed: true } to surface the audit trail.
     */
    async getActiveMilestones(userId, opts = {}) {
      const includeDismissed = !!opts.includeDismissed;
      const raw = parseInt(opts.limit, 10);
      const limit = !Number.isFinite(raw) || raw <= 0 ? 20 : Math.min(raw, 100);

      // The fisher_milestones UNIQUE key includes clustering_run_id, so the
      // SAME logical milestone (same rule/level/week) is re-inserted on every
      // clustering run — surfacing as N identical alerts. Dedup across run_id
      // below (newest kept) so a single transition shows once. Over-fetch so
      // the post-dedup set can still satisfy the caller's `limit`.
      const fetchLimit = Math.min(Math.max(limit * 5, 50), 500);
      let sql = `SELECT id, rule_type, level, window_start, window_end,
                        phase_from, phase_to, velocity_z, displacement,
                        detail, headline, dismissed_at, notified_via,
                        detected_at, clustering_run_id
                 FROM fisher_milestones
                 WHERE user_id = ?`;
      const params = [userId];
      if (!includeDismissed) sql += ` AND dismissed_at IS NULL`;
      sql += ` ORDER BY detected_at DESC LIMIT ?`;
      params.push(fetchLimit);

      const result = await d1Query(sql, params);
      const rows = result.results || result || [];

      // Collapse run-id duplicates: key on the logical identity (rule + level
      // + window + phase endpoints), keep the newest (rows are detected_at
      // DESC), then trim to the caller's limit.
      const seen = new Set();
      const deduped = [];
      for (const r of rows) {
        const key = `${r.rule_type}|${r.level}|${r.window_start}|${r.phase_from ?? ''}|${r.phase_to ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(r);
        if (deduped.length >= limit) break;
      }
      return deduped.map((r) => ({
        ...coerceNums(r, MILESTONE_NUMERIC),
        detail: parseJsonSafe(r.detail, {}),
      }));
    },

    /**
     * Top movers (parsed top_contributors JSON) for one window. Defaults to
     * the most recent weekly_step window at level=realm.
     */
    async getTopMovers(userId, opts = {}) {
      const level = opts.level || 'realm';
      checkLevel(level);

      const runId = opts.runId || (await latestRunId(userId));
      if (!runId) return [];

      const params = [userId, level, runId];
      let sql = `SELECT top_contributors, window_end
                 FROM fisher_trajectory
                 WHERE user_id = ? AND level = ?
                   AND window_type = 'weekly_step' AND clustering_run_id = ?`;
      if (opts.windowEnd) {
        sql += ` AND window_end = ?`;
        params.push(opts.windowEnd);
      }
      sql += ` ORDER BY window_start DESC LIMIT 1`;

      const result = await d1Query(sql, params);
      const row = firstRow(result);
      if (!row) return [];
      return parseJsonSafe(row.top_contributors, []);
    },

    /**
     * Record dismissal. Idempotent (UPDATE only fires when dismissed_at IS NULL),
     * scoped to user (defense-in-depth on top of D1 per-tenant isolation).
     * Returns { dismissed: bool, already_dismissed: bool, exists: bool }.
     */
    async dismissMilestone(userId, milestoneId) {
      if (!milestoneId) return { dismissed: false, exists: false, already_dismissed: false };

      // Existence + current state.
      const before = await d1Query(
        `SELECT id, dismissed_at FROM fisher_milestones WHERE id = ? AND user_id = ?`,
        [milestoneId, userId],
      );
      const beforeRow = firstRow(before);
      if (!beforeRow) {
        return { dismissed: false, exists: false, already_dismissed: false };
      }
      if (beforeRow.dismissed_at) {
        return { dismissed: false, exists: true, already_dismissed: true };
      }

      await d1Query(
        `UPDATE fisher_milestones SET dismissed_at = datetime('now')
         WHERE id = ? AND user_id = ? AND dismissed_at IS NULL`,
        [milestoneId, userId],
      );
      return { dismissed: true, exists: true, already_dismissed: false };
    },
  };
}

// Exposed for unit testing.
export const _internal = { VALID_LEVELS, VALID_WINDOW_TYPES, parseJsonSafe };
