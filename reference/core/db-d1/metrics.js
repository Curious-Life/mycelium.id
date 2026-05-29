/**
 * Cognitive metrics namespace — read-side access to cognitive_metrics_harmonic
 * (PR1 v3 §4.23/§4.33/§4.34 — information harmonics + bigram flow features +
 * topology persistence entropy).
 *
 * Three methods, mirroring fisher.js's pattern. The portal-metrics + internal-
 * metrics routers (PR1.5 B3) currently query via shared pure handlers in
 * packages/server/lib/metrics-handlers.js — those handlers wrap d.rawQuery
 * directly. This namespace is the canonical DB surface for in-process
 * consumers (MCP tools, context-assembly), so the agent's reads don't pay an
 * HTTP round-trip on the same VPS.
 *
 *   getCurrentEra      — era_id from pipeline_state.cluster.last_success_at
 *                        with the canonical fallback chain
 *   getCurrentWindow   — most-recent window for (user, granularity, era)
 *   getSeries          — time-series of one metric across windows in current era
 *
 * Conventions:
 *   - Every query starts with `WHERE user_id = ?`.
 *   - All values bound via positional placeholders.
 *   - Unknown granularity → throws (fail-closed); unknown metric → throws.
 *   - Era resolution: pipeline_state.stage_name='cluster'.last_success_at,
 *     fallback to MAX(territory_profiles.updated_at WHERE dissolved_at IS NULL),
 *     cold-start to era-bootstrap-YYYY-MM-DD.
 *
 * @typedef {object} MetricsNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {(result: any) => any} firstRow
 */

const BANDS = Object.freeze(['gamma', 'beta', 'alpha', 'theta', 'delta']);
const HARMONIC_K = Object.freeze([1, 2, 3]);
const FLOW_FEATURES = Object.freeze([
  'mean_crossing_rate',
  'slope_sign_change_rate',
  'autocorrelation_lag1',
  'variance',
  'total_spectral_energy',
]);

const HARMONIC_AMPLITUDE_COLS = HARMONIC_K.flatMap((k) =>
  BANDS.map((b) => `harmonic_amplitude_${b}_k${k}`)
);
const BIGRAM_FLOW_COLS = FLOW_FEATURES.flatMap((f) =>
  BANDS.map((b) => `${f}_${b}`)
);
// Column renamed in migration 157 — family ID (`topology_persistence_entropy`)
// stays for URL stability; column name reflects PR1 H0-only ship.
const TOPOLOGY_COLS = Object.freeze(['topology_h0_persistence_entropy']);

/** All 41 metric column names. Source of truth for db.metrics consumers. */
export const METRIC_COLUMNS = Object.freeze([
  ...HARMONIC_AMPLITUDE_COLS,
  ...BIGRAM_FLOW_COLS,
  ...TOPOLOGY_COLS,
]);

const METRIC_COLUMN_SET = new Set(METRIC_COLUMNS);
const VALID_GRANULARITIES = Object.freeze(new Set(['alpha', 'theta', 'delta']));
const SERIES_DEFAULT_LIMIT = 100;
const SERIES_MAX_LIMIT = 1000;

function checkGranularity(g) {
  if (!VALID_GRANULARITIES.has(g)) {
    throw new TypeError(`metrics: invalid granularity "${g}", expected one of: ${[...VALID_GRANULARITIES].join(', ')}`);
  }
}

function checkMetric(m) {
  if (!METRIC_COLUMN_SET.has(m)) {
    throw new TypeError(`metrics: invalid metric "${m}" — see METRIC_COLUMNS for the 41 valid names`);
  }
}


export function createMetricsNamespace(deps) {
  if (!deps) throw new TypeError('createMetricsNamespace: deps required');
  const { d1Query, firstRow } = deps;
  if (typeof d1Query !== 'function') {
    throw new TypeError('createMetricsNamespace: d1Query required');
  }
  if (typeof firstRow !== 'function') {
    throw new TypeError('createMetricsNamespace: firstRow required');
  }

  /**
   * Resolve the canonical era_id. Mirrors deriveFisherEraId from
   * @mycelium/metrics/era.js but inlines the SQL for in-process call.
   */
  async function getCurrentEra(userId) {
    const psResult = await d1Query(
      `SELECT last_success_at FROM pipeline_state WHERE user_id = ? AND stage_name = ?`,
      [userId, 'cluster'],
    );
    const psRow = firstRow(psResult);
    if (psRow?.last_success_at) {
      return `era-${psRow.last_success_at}`;
    }

    const tpResult = await d1Query(
      `SELECT MAX(updated_at) AS last_updated FROM territory_profiles
       WHERE user_id = ? AND dissolved_at IS NULL`,
      [userId],
    );
    const tpRow = firstRow(tpResult);
    if (tpRow?.last_updated) {
      return `era-${tpRow.last_updated}`;
    }

    const today = new Date().toISOString().slice(0, 10);
    return `era-bootstrap-${today}`;
  }

  return {
    getCurrentEra,

    /**
     * Latest window for (user, granularity, current_era). Returns null when
     * no rows exist for the user/era combination.
     *
     * @param {string} userId
     * @param {object} opts
     * @param {string} [opts.granularity='alpha']  alpha | theta | delta
     * @param {string[]} [opts.requestedMetrics]   subset of METRIC_COLUMNS;
     *                                             default = all 41
     */
    async getCurrentWindow(userId, { granularity = 'alpha', requestedMetrics = null } = {}) {
      checkGranularity(granularity);
      const cols = requestedMetrics && requestedMetrics.length > 0
        ? requestedMetrics
        : METRIC_COLUMNS;
      for (const c of cols) checkMetric(c);

      const eraId = await getCurrentEra(userId);

      const result = await d1Query(
        `SELECT window_end, message_count, low_confidence, notes,
                ${cols.join(', ')}
         FROM cognitive_metrics_harmonic
         WHERE user_id = ? AND granularity = ? AND clustering_run_id = ?
         ORDER BY window_end DESC
         LIMIT 1`,
        [userId, granularity, eraId],
      );

      const row = firstRow(result);
      if (!row) {
        return {
          window_end: null,
          granularity,
          era_id: eraId,
          message_count: 0,
          low_confidence: true,
          notes: null,
          values: {},
        };
      }

      const values = {};
      for (const c of cols) values[c] = row[c] === undefined ? null : row[c];

      return {
        window_end: row.window_end,
        granularity,
        era_id: eraId,
        message_count: row.message_count ?? 0,
        low_confidence: !!row.low_confidence,
        notes: row.notes ?? null,
        values,
      };
    },

    /**
     * Time-series of ONE metric across windows of a granularity in the
     * current era.
     *
     * @param {string} userId
     * @param {object} opts
     * @param {string} opts.metric              one of METRIC_COLUMNS
     * @param {string} [opts.granularity='alpha']
     * @param {string} [opts.from]              ISO 8601 inclusive lower bound
     * @param {string} [opts.to]                ISO 8601 inclusive upper bound
     * @param {number} [opts.limit=100]         default 100, max 1000
     */
    async getSeries(userId, { metric, granularity = 'alpha', from = null, to = null, limit = SERIES_DEFAULT_LIMIT } = {}) {
      if (!metric) throw new TypeError('metrics: metric required');
      checkMetric(metric);
      checkGranularity(granularity);

      const rawLim = parseInt(limit, 10);
      const cappedLim = !Number.isFinite(rawLim) || rawLim <= 0
        ? SERIES_DEFAULT_LIMIT
        : Math.min(rawLim, SERIES_MAX_LIMIT);

      const eraId = await getCurrentEra(userId);

      const params = [userId, granularity, eraId];
      let sql = `SELECT window_end, ${metric} AS value, message_count, low_confidence, notes
                 FROM cognitive_metrics_harmonic
                 WHERE user_id = ? AND granularity = ? AND clustering_run_id = ?`;
      if (from) { sql += ` AND window_end >= ?`; params.push(from); }
      if (to)   { sql += ` AND window_end <= ?`; params.push(to); }
      sql += ` ORDER BY window_end LIMIT ?`;
      params.push(cappedLim);

      const result = await d1Query(sql, params);
      const rows = result?.results || result || [];
      return rows.map((r) => ({
        window_end: r.window_end,
        value: r.value === undefined ? null : r.value,
        message_count: r.message_count ?? 0,
        low_confidence: !!r.low_confidence,
        notes: r.notes ?? null,
      }));
    },
  };
}

// Exported for unit tests + cross-module use.
export const _internal = Object.freeze({
  BANDS,
  HARMONIC_K,
  FLOW_FEATURES,
  VALID_GRANULARITIES,
  SERIES_DEFAULT_LIMIT,
  SERIES_MAX_LIMIT,
});
