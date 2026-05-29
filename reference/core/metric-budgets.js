/**
 * Metric Freshness Budgets — single source of truth.
 *
 * The Worker has a parallel mirror at
 * packages/worker/src/config/metric-budgets.ts because the Worker is
 * bundled separately and can't import from packages/core. Whenever this
 * file changes, the Worker mirror MUST change to match — both files
 * exist because of the runtime split, not because the formats differ.
 *
 * Used by:
 *   - Worker:        /api/metric-freshness handler + alert-dispatch
 *   - agent-server:  /portal/metric-freshness handler (this file)
 *
 * Adding a new metric: append an entry. Probes are tolerant of missing
 * tables — they report `verdict: 'missing'` rather than failing — so
 * this list can include tables not yet migrated everywhere.
 *
 * @typedef {object} MetricBudgetProbe
 * @property {'pipeline_state'} kind    Probe kind. Currently only
 *                                      'pipeline_state' (anchors freshness
 *                                      to a stage's last_success_at).
 * @property {string} stage_name        Required when kind ===
 *                                      'pipeline_state'. The pipeline
 *                                      stage whose last_success_at
 *                                      anchors this table's freshness.
 *
 * @typedef {object} MetricBudget
 * @property {string} table             D1 table name.
 * @property {string} [timestamp_column] Column holding the freshest write
 *                                      signal for the row. Required
 *                                      unless `probe` is set.
 * @property {MetricBudgetProbe} [probe] Optional custom probe override.
 *                                      When set, the freshness handler
 *                                      uses this instead of
 *                                      `MAX(timestamp_column)`. Used for
 *                                      tables with no per-row computed_at
 *                                      (e.g., cognitive_metrics_harmonic
 *                                      whose freshness is era-level).
 * @property {number} budget_ms         Allowed staleness in ms. Older →
 *                                      stale.
 * @property {string} cadence           Human-readable cadence note for
 *                                      operator/portal display.
 * @property {string} description       Brief description surfaced in
 *                                      alerts and badges.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** @type {MetricBudget[]} */
export const METRIC_BUDGETS = [
  // ── Per-window metrics (tick-cadence, hourly orchestrator) ─────────
  {
    table: 'fisher_trajectory',
    timestamp_column: 'computed_at',
    budget_ms: 26 * HOUR,
    cadence: '24h',
    description: 'Cognitive trajectory (Fisher information geometry per window).',
  },
  {
    table: 'fisher_milestones',
    timestamp_column: 'detected_at',
    budget_ms: 26 * HOUR,
    cadence: '24h',
    description: 'Milestone events (phase shifts, velocity outliers).',
  },
  // ── Per-territory metrics ──────────────────────────────────────────
  {
    table: 'territory_vitality',
    timestamp_column: 'computed_at',
    budget_ms: 26 * HOUR,
    cadence: '24h',
    description: 'Per-territory vitality scores (sparse/active/anchor phase).',
  },
  {
    table: 'territory_cofire',
    timestamp_column: 'last_computed',
    budget_ms: 26 * HOUR,
    cadence: '24h',
    description: 'Territory co-firing graph (4 temporal scales).',
  },
  // ── Per-cluster-run metrics (advance only on re-cluster) ───────────
  {
    table: 'cluster_events',
    timestamp_column: 'created_at',
    budget_ms: 8 * DAY,
    cadence: 'weekly (gated on re-cluster)',
    description: 'Cluster taxonomy events (formed/grew/split/merged).',
  },
  // ── Currently-orphaned metrics (PR 2.1 will promote to stages) ─────
  {
    table: 'complexity_snapshots',
    timestamp_column: 'computed_at',
    budget_ms: 30 * HOUR,
    cadence: '24h',
    description: 'LZ76 complexity (territory-id sequence novelty).',
  },
  {
    table: 'topology_audit_snapshots',
    timestamp_column: 'run_at',
    budget_ms: 30 * HOUR,
    cadence: '24h',
    description: 'Topology health (M2 entropy, degree Gini, orphans).',
  },
  {
    table: 'user_profiles',
    timestamp_column: 'updated_at',
    budget_ms: 30 * HOUR,
    cadence: '24h',
    description: 'Cognitive fingerprint (depth, breadth, coherence, exploration).',
  },
  // ── Retiring (PR 2.2) — kept here so dashboards still show its state
  {
    table: 'frequency_snapshots',
    timestamp_column: 'computed_at',
    budget_ms: 30 * HOUR,
    cadence: '24h (RETIRING — PR 2.2)',
    description: 'Legacy frequency metrics (compression broken; retiring).',
  },
  // ── Time-chronicles (multi-granularity) ────────────────────────────
  {
    table: 'time_chronicles',
    timestamp_column: 'computed_at',
    budget_ms: 32 * DAY,
    cadence: 'monthly (worst-case granularity)',
    description: 'Encrypted time-period narratives (day/week/month).',
  },
  // ── LLM-described content (event-driven) ───────────────────────────
  {
    table: 'semantic_themes',
    timestamp_column: 'updated_at',
    budget_ms: 8 * DAY,
    cadence: 'weekly (gated on re-cluster + hash)',
    description: 'Realm/theme descriptions (Claude-generated narratives).',
  },
  // ── Cognitive metrics (era-anchored, no per-row computed_at) ───────
  // Freshness is era-level: the table is rewritten by the
  // `cognitive-harmonics` stage when a new era's harmonics are computed.
  // No per-row computed_at column exists, so we anchor to that stage's
  // pipeline_state.last_success_at via the custom probe.
  {
    table: 'cognitive_metrics_harmonic',
    probe: { kind: 'pipeline_state', stage_name: 'cognitive-harmonics' },
    budget_ms: 26 * HOUR,
    cadence: '24h (era-anchored via pipeline_state.cognitive-harmonics)',
    description: 'Cognitive harmonics (information-harmonics + bigram flow + topology H0 entropy).',
  },
  // ── Phase 5 canonical cognitive metrics (migration 158) ────────────
  // The 4 new tables coexist with legacy ones until PR 5.7 retires
  // legacy. During co-existence both surfaces register here so
  // freshness telemetry covers the actual write paths. Probes anchor
  // to the new compute-cognitive-metrics-* stages (introduced in
  // PRs 5.3–5.6); until those ship, the probes report verdict: 'empty'.
  {
    table: 'cognitive_metrics_window',
    probe: { kind: 'pipeline_state', stage_name: 'compute-cognitive-metrics-window' },
    budget_ms: 26 * HOUR,
    cadence: '24h (era-anchored; replaces cognitive-harmonics in PR 5.4)',
    description: 'Canonical per-window cognitive metrics (replaces cognitive_metrics_harmonic).',
  },
  {
    table: 'cognitive_metrics_trajectory',
    probe: { kind: 'pipeline_state', stage_name: 'compute-cognitive-metrics-trajectory' },
    budget_ms: 26 * HOUR,
    cadence: '24h (era-anchored; replaces fisher-trajectory + compute-complexity in PR 5.3)',
    description: 'Canonical per-(level, window) trajectory metrics (replaces fisher_trajectory).',
  },
  {
    table: 'cognitive_metrics_per_territory',
    probe: { kind: 'pipeline_state', stage_name: 'compute-cognitive-metrics-per-territory' },
    budget_ms: 26 * HOUR,
    cadence: '24h (era-anchored; new in PR 5.5)',
    description: 'Per-territory cognitive metrics (recurrence + cofire derivatives).',
  },
  {
    table: 'topology_metrics',
    probe: { kind: 'pipeline_state', stage_name: 'compute-topology-metrics' },
    budget_ms: 8 * DAY,
    cadence: 'weekly (era-anchored; replaces topology-audit orphan in PR 5.6)',
    description: 'Canonical per-era topology metrics (replaces topology_audit_snapshots).',
  },
];
