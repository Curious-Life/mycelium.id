// Build-new injected helpers for the db-d1 namespaces.
//
// These are the small free functions the reference db-d1.js orchestrator
// supplied to specific namespace factories. They are NOT in reference/ (only
// the leaf namespaces are), so they are written here against the verified
// call-site contracts:
//   - parseHealthRow      (health.js:65,73)  — row -> typed row (workout_types JSON)
//   - computeHealthSummary(health.js:80)     — rows -> { averages, trends, anomalies }
//   - cofireCol           (topology.js)      — scale string -> cofire column name
//   - hashTokenSync       (registration-tokens.js) — code -> SHA-256 hex
// `handles` (profiles federation) is intentionally omitted from the V1 tool surface.
import { createHash } from 'node:crypto';

/** Parse a raw health_daily row: decode workout_types JSON; pass numerics through. */
export function parseHealthRow(row) {
  if (!row) return null;
  const out = { ...row };
  if (typeof out.workout_types === 'string' && out.workout_types) {
    try { out.workout_types = JSON.parse(out.workout_types); } catch { /* leave string */ }
  }
  return out;
}

const SUMMARY_NUMERIC = [
  'sleep_duration_min', 'sleep_efficiency', 'sleep_deep_min', 'sleep_rem_min',
  'hrv_avg', 'hrv_sleep_avg', 'resting_hr', 'steps', 'active_energy_kcal',
  'workout_minutes', 'mindful_minutes',
];
// Metrics where a HIGHER value is "better" (governs trend arrow direction).
const HIGHER_IS_BETTER = new Set([
  'sleep_duration_min', 'sleep_efficiency', 'sleep_deep_min', 'sleep_rem_min',
  'hrv_avg', 'hrv_sleep_avg', 'steps', 'mindful_minutes',
]);

function mean(nums) {
  const v = nums.filter((n) => typeof n === 'number' && Number.isFinite(n));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/**
 * Aggregate parsed health rows.
 * @returns {{ averages: object, trends: object, anomalies: Array }}
 *   Matches the health tool's consumption (tools/health.js:57-76).
 */
export function computeHealthSummary(rows, _today) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { averages: {}, trends: {}, anomalies: [] };
  }
  const averages = {};
  for (const m of SUMMARY_NUMERIC) {
    const avg = mean(rows.map((r) => r?.[m]));
    if (avg != null) averages[m] = avg;
  }

  // Trend: compare the mean of the first half vs the second half (chronological).
  const trends = {};
  const sorted = [...rows].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const mid = Math.floor(sorted.length / 2);
  for (const m of SUMMARY_NUMERIC) {
    if (sorted.length < 4) { trends[m] = 'insufficient'; continue; }
    const first = mean(sorted.slice(0, mid).map((r) => r?.[m]));
    const second = mean(sorted.slice(mid).map((r) => r?.[m]));
    if (first == null || second == null || first === 0) { trends[m] = 'insufficient'; continue; }
    const delta = (second - first) / Math.abs(first);
    if (Math.abs(delta) < 0.05) { trends[m] = 'stable'; continue; }
    const rising = delta > 0;
    const better = HIGHER_IS_BETTER.has(m) ? rising : !rising;
    trends[m] = better ? 'improving' : 'declining';
  }

  // Anomaly: a day's metric > 2.5 stddev from the series mean.
  const anomalies = [];
  for (const m of ['sleep_duration_min', 'hrv_avg', 'resting_hr', 'steps']) {
    const vals = sorted.map((r) => r?.[m]).filter((n) => typeof n === 'number' && Number.isFinite(n));
    if (vals.length < 4) continue;
    const mu = mean(vals);
    const sd = Math.sqrt(mean(vals.map((v) => (v - mu) ** 2)) || 0);
    if (!sd) continue;
    for (const r of sorted) {
      const v = r?.[m];
      if (typeof v === 'number' && Math.abs(v - mu) > 2.5 * sd) {
        anomalies.push({ date: r.date, metric: m, value: Math.round(v), baseline: Math.round(mu) });
      }
    }
  }
  return { averages, trends, anomalies };
}

const COFIRE_COLUMNS = {
  immediate: 'cofire_immediate',
  session: 'cofire_session',
  daily: 'cofire_daily',
  weekly: 'cofire_weekly',
};
/** Map a co-firing timescale to its column (defaults to the base `cofire`). */
export function cofireCol(scale) {
  return COFIRE_COLUMNS[scale] || 'cofire';
}

/** SHA-256 hex of a token/code (registration-tokens lookup key). */
export function hashTokenSync(code) {
  return createHash('sha256').update(String(code)).digest('hex');
}
