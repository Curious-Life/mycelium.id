/**
 * src/metrics/surface-gate.js — the metric-read CHOKEPOINT (audit S1 fix).
 *
 * `validatePresentation` / `assertNotSurfacedUnlessValidated` (cvp.js) were dead
 * code: defined + unit-tested, zero callers. The presentation contracts were
 * therefore advisory — nothing structurally stopped a Tier-1 embedding-anchor
 * metric (insight / reflection / inner-territory / affect, all cvp_status=
 * 'pending') from being surfaced as a validated number the moment a reader was
 * wired. This module turns the gate into a real boundary:
 *
 *   - it is the single source of truth for "which presentation family does this
 *     metric COLUMN belong to" (both the harmonic table and the anchor table);
 *   - `assertColumnSurfaceable` is invoked at the db read boundary
 *     (src/db/metrics.js for the harmonic family) so a non-surfaceable column
 *     throws BEFORE any number reaches a formatter;
 *   - `gateAnchorValue` is the per-value gate the sanctioned anchor reader
 *     (src/db/anchor.js) runs on every Tier-1 scalar: a cvp_status!=='pass'
 *     metric is REPLACED with its refusal_mode copy, never the raw number.
 *
 * Fail-closed: an UNKNOWN column throws (we never surface a number we cannot
 * classify). The harmonic families are non-Tier-1 and carry contracts, so they
 * pass; the four Tier-1 anchor families are 'pending', so they refuse.
 *
 * Spec: research/mycelium-cognitive-measurement-unified-2026-06-04.md §2.2
 * field 7 (presentation contract) + §2.3 (CVP mandatory gate). Audit finding S1
 * in docs/METRICS-AUDIT-vs-LITERATURE-2026-06-19.md.
 */

import {
  assertNotSurfacedUnlessValidated,
  validatePresentation,
  TIER1_EMBEDDING_FAMILIES,
} from './cvp.js';
import { CONTRACTS } from './contracts.js';

// ── Harmonic table (cognitive_metrics_harmonic) column → presentation family ──
// These mirror the column construction in src/db/metrics.js. The two lists are
// cross-checked by verify:cvp (G-series) so they can never silently drift.
const BANDS = Object.freeze(['gamma', 'beta', 'alpha', 'theta', 'delta']);
const FLOW_FEATURES = Object.freeze([
  'mean_crossing_rate',
  'slope_sign_change_rate',
  'autocorrelation_lag1',
  'variance',
  'total_spectral_energy',
]);

const HARMONIC_COLUMN_FAMILY = {};
for (const k of [1, 2, 3]) for (const b of BANDS) {
  HARMONIC_COLUMN_FAMILY[`harmonic_amplitude_${b}_k${k}`] = 'information_harmonic_amplitude';
}
for (const f of FLOW_FEATURES) for (const b of BANDS) {
  HARMONIC_COLUMN_FAMILY[`${f}_${b}`] = 'bigram_flow_features';
}
HARMONIC_COLUMN_FAMILY['topology_h0_persistence_entropy'] = 'topology_persistence_entropy';
Object.freeze(HARMONIC_COLUMN_FAMILY);

// ── Anchor table (cognitive_metrics_anchor) columns ──────────────────────────
// For the Tier-1 anchor family the metric COLUMN name IS the family id (matches
// the keys in TIER1_EMBEDDING_FAMILIES + CONTRACTS).
export const ANCHOR_METRIC_COLUMNS = Object.freeze(Object.keys(TIER1_EMBEDDING_FAMILIES));
const ANCHOR_COLUMN_SET = new Set(ANCHOR_METRIC_COLUMNS);

/**
 * Resolve a metric column to its presentation family + tier.
 * @returns {{ family:string, tier:number, anchor:boolean } | null} null = unknown column
 */
export function metricColumnFamily(column) {
  const harmonic = HARMONIC_COLUMN_FAMILY[column];
  if (harmonic) return { family: harmonic, tier: 0, anchor: false };
  if (ANCHOR_COLUMN_SET.has(column)) {
    return { family: column, tier: TIER1_EMBEDDING_FAMILIES[column].tier, anchor: true };
  }
  return null;
}

/** Exported for the drift cross-check in verify:cvp. */
export const _HARMONIC_COLUMN_FAMILY = HARMONIC_COLUMN_FAMILY;

/**
 * Throwing guard for the db read boundary. Resolves `column` to its family and
 * runs the presentation-contract gate. Throws CVP_NOT_VALIDATED if the metric
 * may not be surfaced (Tier-1 not-yet-`pass`, or no contract), and throws an
 * UnknownMetricColumn error for any column we cannot classify (fail-closed).
 *
 * @param {string} column                  metric column name
 * @param {object} [opts]
 * @param {string} [opts.cvp_status]        per-row CVP status (anchor rows carry it)
 * @returns {{surfaceable:boolean, requiresCVP:boolean, hasContract:boolean, reason:string}}
 */
export function assertColumnSurfaceable(column, { cvp_status } = {}) {
  const resolved = metricColumnFamily(column);
  if (!resolved) {
    const err = new Error(`PresentationContractViolation: metric column "${column}" has no known presentation family — refuse to surface (fail-closed).`);
    err.code = 'CVP_UNKNOWN_COLUMN';
    throw err;
  }
  // Pass CONTRACTS explicitly — the validator's fallback ref is only set when
  // the metrics barrel (index.js) has been imported, and this module must gate
  // correctly regardless of import order.
  return assertNotSurfacedUnlessValidated({ family: resolved.family, tier: resolved.tier, cvp_status, contracts: CONTRACTS });
}

/**
 * Per-value gate for the anchor reader. NEVER throws on a pending metric — it
 * substitutes the honest refusal copy so the caller cannot accidentally surface
 * the raw number. Throws only for an unclassifiable column (fail-closed).
 *
 * @param {string} column
 * @param {number|null} value               the (already auto-decrypted) scalar
 * @param {object} [opts]
 * @param {string} [opts.cvp_status]
 * @returns {{surfaceable:boolean, value:(number|null), refusal:(string|null), family:string, reason:string}}
 */
export function gateAnchorValue(column, value, { cvp_status } = {}) {
  const resolved = metricColumnFamily(column);
  if (!resolved) {
    const err = new Error(`PresentationContractViolation: anchor column "${column}" has no known presentation family (fail-closed).`);
    err.code = 'CVP_UNKNOWN_COLUMN';
    throw err;
  }
  const v = validatePresentation({ family: resolved.family, tier: resolved.tier, cvp_status, contracts: CONTRACTS });
  if (v.surfaceable) {
    return { surfaceable: true, value: value ?? null, refusal: null, family: resolved.family, reason: v.reason };
  }
  // Not surfaceable → drop the number, carry the refusal copy in its place.
  const refusal = CONTRACTS[resolved.family]?.refusal_mode
    || `Metric "${resolved.family}" is not validated for surfacing (${v.reason}).`;
  return { surfaceable: false, value: null, refusal, family: resolved.family, reason: v.reason };
}
