/**
 * src/metrics/freshness.js — family-grained metric freshness (spec §6 I5 + I7).
 *
 * "Freshness" is orthogonal to per-row `low_confidence`: low_confidence says "the
 * estimator is shaky for THIS window"; freshness says "the whole family's last
 * pipeline write is older than its budget — the numbers may be stale." Per I7 the
 * agent + portal surfaces must be freshness-aware: a stale family gets a hedge
 * prepended to the output, not just a silent old number.
 *
 * This module is the ONE place that owns the family→budget map + the probe. It is
 * consumed by BOTH the HTTP surface (src/portal-measurement.js /metric-freshness
 * + /measurement-health) and the agent surface (src/tools/metrics.js, reached via
 * cognitiveState / cognitiveHistory) so the two never drift. Content-free: it
 * reads only plaintext timestamps + pipeline_state — no decrypted values, so
 * nothing here can leak ciphertext.
 */

const HOUR = 3600000;

// V1 freshness budgets — the subset of reference/core/metric-budgets.js whose
// tables exist in the V1 schema. Era-anchored tables (cognitive_metrics_harmonic)
// use a pipeline_state probe; the rest use MAX(timestamp_column).
export const METRIC_BUDGETS = Object.freeze([
  { table: 'fisher_trajectory', timestamp_column: 'computed_at', budget_ms: 26 * HOUR, cadence: '24h', description: 'Cognitive trajectory (Fisher information geometry per window).' },
  { table: 'fisher_milestones', timestamp_column: 'detected_at', budget_ms: 26 * HOUR, cadence: '24h', description: 'Milestone events (phase shifts, velocity outliers).' },
  { table: 'territory_vitality', timestamp_column: 'computed_at', budget_ms: 26 * HOUR, cadence: '24h', description: 'Per-territory vitality scores (sparse/active/anchor phase).' },
  { table: 'territory_cofire', timestamp_column: 'last_computed', budget_ms: 26 * HOUR, cadence: '24h', description: 'Territory co-firing graph (4 temporal scales).' },
  { table: 'complexity_snapshots', timestamp_column: 'computed_at', budget_ms: 30 * HOUR, cadence: '24h', description: 'LZ76 complexity (territory-id sequence novelty).' },
  { table: 'topology_audit_snapshots', timestamp_column: 'run_at', budget_ms: 30 * HOUR, cadence: '24h', description: 'Topology health (M2 entropy, degree Gini, orphans).' },
  { table: 'frequency_snapshots', timestamp_column: 'computed_at', budget_ms: 30 * HOUR, cadence: '24h', description: 'Windowed cognitive frequency metrics.' },
  { table: 'cognitive_metrics_harmonic', probe: { kind: 'pipeline_state', stage_name: 'cognitive-harmonics' }, budget_ms: 26 * HOUR, cadence: '24h (era-anchored)', description: 'Cognitive harmonics (information-harmonics + bigram flow + topology H0 entropy).' },
  { table: 'embedding_trajectory', timestamp_column: 'computed_at', budget_ms: 26 * HOUR, cadence: '24h', description: 'Basis-free movement cross-check (global embedding-centroid drift).' },
]);

// Which pipeline_state stage writes each metric family — so /measurement-health
// can say "stale BECAUSE the stage failed" (not just "stale"). These match the
// CANONICAL stage_names the stages record (script-basename, e.g. 'compute-cofire';
// specials: 'fisher-trajectory', 'cognitive-harmonics', 'cluster').
export const FAMILY_STAGE = Object.freeze({
  fisher_trajectory: 'fisher-trajectory', fisher_milestones: 'fisher-trajectory', territory_vitality: 'compute-vitality',
  territory_cofire: 'compute-cofire', complexity_snapshots: 'compute-complexity', topology_audit_snapshots: 'topology-audit',
  frequency_snapshots: 'compute-frequency', cognitive_metrics_harmonic: 'cognitive-harmonics',
  embedding_trajectory: 'compute-embedding-trajectory',
});

const BUDGET_BY_TABLE = new Map(METRIC_BUDGETS.map((b) => [b.table, b]));

// Probe ONE budget entry → { table, present, last_write, age_ms, budget_ms, cadence, description, verdict }.
// verdict ∈ fresh | stale | empty | missing. Pure aside from the db read.
async function probeBudget(db, uid, b, nowMs) {
  let lastWrite = null;
  try {
    if (b.probe?.kind === 'pipeline_state') {
      const r = await db.rawQuery(
        `SELECT last_success_at AS last_write FROM pipeline_state WHERE user_id = ? AND stage_name = ?`,
        [uid, b.probe.stage_name]);
      lastWrite = (r.results || r || [])[0]?.last_write ?? null;
    } else {
      // timestamp columns are PLAINTEXT — MAX() is valid in SQL.
      const r = await db.rawQuery(
        `SELECT MAX(${b.timestamp_column}) AS last_write FROM ${b.table} WHERE user_id = ?`,
        [uid]);
      lastWrite = (r.results || r || [])[0]?.last_write ?? null;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('no such table')) {
      return { table: b.table, present: false, last_write: null, age_ms: null, budget_ms: b.budget_ms, cadence: b.cadence, description: b.description, verdict: 'missing' };
    }
    throw err;
  }
  if (!lastWrite) {
    return { table: b.table, present: true, last_write: null, age_ms: null, budget_ms: b.budget_ms, cadence: b.cadence, description: b.description, verdict: 'empty' };
  }
  const writeMs = Date.parse(lastWrite);
  const ageMs = Number.isFinite(writeMs) ? nowMs - writeMs : null;
  const verdict = ageMs === null ? 'empty' : ageMs <= b.budget_ms ? 'fresh' : 'stale';
  return { table: b.table, present: true, last_write: lastWrite, age_ms: ageMs, budget_ms: b.budget_ms, cadence: b.cadence, description: b.description, verdict };
}

/**
 * Full freshness map across all budgeted families (backs the HTTP surfaces).
 * @returns {Promise<{nowMs:number, rows:object[], summary:object}>}
 */
export async function computeFreshness(db, uid) {
  const nowMs = Date.now();
  const rows = await Promise.all(METRIC_BUDGETS.map((b) => probeBudget(db, uid, b, nowMs)));
  const summary = rows.reduce((acc, r) => {
    acc.total += 1; acc[r.verdict] = (acc[r.verdict] || 0) + 1; return acc;
  }, { total: 0, fresh: 0, stale: 0, missing: 0, empty: 0 });
  return { nowMs, rows, summary };
}

/**
 * Freshness for ONE family's table (backs the agent-surface hedge). Returns null
 * if the table is not budgeted.
 */
export async function familyFreshness(db, uid, table) {
  const b = BUDGET_BY_TABLE.get(table);
  if (!b) return null;
  return probeBudget(db, uid, b, Date.now());
}

/**
 * I7 hedge copy for a freshness verdict row. Returns null for a fresh family (no
 * hedge). The text is PREPENDED to agent-facing metric output so the agent has
 * the staleness constraint at tool-call time, distinct from per-row
 * low_confidence.
 */
export function freshnessHedge(fresh) {
  if (!fresh || fresh.verdict === 'fresh') return null;
  if (fresh.verdict === 'missing') {
    return '_freshness: this metric family\'s table is not present in the vault yet — the enrichment pipeline has not created it._';
  }
  if (fresh.verdict === 'empty') {
    return '_freshness: the enrichment pipeline has no recorded run for this metric family yet — treat anything below as provisional, not a current reading._';
  }
  // stale
  const ageH = fresh.age_ms != null ? Math.round(fresh.age_ms / HOUR) : null;
  const budgetH = Math.round(fresh.budget_ms / HOUR);
  const ageStr = ageH == null ? 'unknown age'
    : ageH >= 48 ? `${Math.round(ageH / 24)}d old`
    : `${ageH}h old`;
  return `_freshness: STALE — this metric family's last pipeline write is ${ageStr} (budget ${budgetH}h); the enrichment pipeline may not have run recently, so the numbers below may lag your current state._`;
}
