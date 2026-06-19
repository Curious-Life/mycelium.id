/**
 * Tier-1 embedding-anchor read namespace — the ONLY sanctioned reader of
 * `cognitive_metrics_anchor` (audit S1 fix).
 *
 * The four anchor metrics (§4.5 insight_embedding_proximity, §4.11
 * inner_territory_presence, §4.12 reflective_embedding_density, §4.13
 * affective_volatility_within_window) are Tier-1 embedding-geometry metrics that
 * have NOT cleared the mandatory Construct Validity Protocol (spec §2.3) — real
 * CVP needs operator human-labeled held-out data, which does not exist. Every row
 * carries cvp_status='pending' + low_confidence=1.
 *
 * Before this namespace existed, the anchor table had ZERO readers: its safety
 * rested on omission ("no reader is wired"), not on the gate built for exactly
 * this. This namespace makes the gate STRUCTURAL: every scalar it reads is run
 * through `gateAnchorValue`, so a cvp_status!=='pass' metric is REPLACED with its
 * honest refusal_mode copy and the raw (auto-decrypted) number is dropped on the
 * floor — it can never reach a formatter or HTTP response.
 *
 * It is wired into the assembled `db` object deliberately as a fail-closed
 * reader: any future tool/route that wants anchor data calls db.anchor.* and
 * gets the gate for free. The "no ungated reader" invariant — that no other file
 * queries `cognitive_metrics_anchor` — is enforced by verify:cvp.
 *
 * @typedef {object} AnchorNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {(result: any) => any} firstRow
 */

import { ANCHOR_METRIC_COLUMNS, gateAnchorValue } from '../metrics/surface-gate.js';

const VALID_GRANULARITIES = Object.freeze(new Set(['alpha', 'theta', 'delta']));

function checkGranularity(g) {
  if (!VALID_GRANULARITIES.has(g)) {
    throw new TypeError(`anchor: invalid granularity "${g}", expected one of: ${[...VALID_GRANULARITIES].join(', ')}`);
  }
}

export function createAnchorNamespace(deps) {
  if (!deps) throw new TypeError('createAnchorNamespace: deps required');
  const { d1Query, firstRow } = deps;
  if (typeof d1Query !== 'function') throw new TypeError('createAnchorNamespace: d1Query required');
  if (typeof firstRow !== 'function') throw new TypeError('createAnchorNamespace: firstRow required');

  return {
    /** The Tier-1 metric columns this namespace governs. */
    METRIC_COLUMNS: ANCHOR_METRIC_COLUMNS,

    /**
     * Latest anchor-metric window for (user, granularity). Returns the structural
     * fields PLUS a `values` map in which every metric is GATED: surfaceable
     * metrics carry their number, non-surfaceable (the present reality: all four
     * are cvp_status='pending') carry `null` and a `refusals[col]` entry with the
     * honest copy. The raw decrypted number is never returned for a pending
     * metric. Returns null `window_end` when no row exists.
     *
     * @param {string} userId
     * @param {object} [opts]
     * @param {string} [opts.granularity='alpha']
     */
    async getCurrentWindow(userId, { granularity = 'alpha' } = {}) {
      checkGranularity(granularity);

      // Structural columns + cvp_status are plaintext; the 4 metric scalars
      // auto-decrypt through the adapter (so the gate, not the SELECT, is what
      // protects them). Order by window_end so "current" = most recent.
      const result = await d1Query(
        `SELECT window_end, era_id, anchor_version, language, message_count,
                low_confidence, cvp_status, ${ANCHOR_METRIC_COLUMNS.join(', ')}
         FROM cognitive_metrics_anchor
         WHERE user_id = ? AND granularity = ?
         ORDER BY window_end DESC
         LIMIT 1`,
        [userId, granularity],
      );
      const row = firstRow(result);
      if (!row) {
        return {
          window_end: null,
          granularity,
          era_id: null,
          cvp_status: null,
          message_count: 0,
          low_confidence: true,
          values: {},
          refusals: {},
          surfaceable: false,
        };
      }

      const values = {};
      const refusals = {};
      let anySurfaceable = false;
      for (const c of ANCHOR_METRIC_COLUMNS) {
        const gated = gateAnchorValue(c, row[c] === undefined ? null : row[c], { cvp_status: row.cvp_status });
        if (gated.surfaceable) {
          values[c] = gated.value;
          anySurfaceable = true;
        } else {
          values[c] = null;
          refusals[c] = gated.refusal;
        }
      }

      return {
        window_end: row.window_end,
        granularity,
        era_id: row.era_id ?? null,
        anchor_version: row.anchor_version ?? null,
        cvp_status: row.cvp_status ?? null,
        message_count: row.message_count ?? 0,
        low_confidence: !!row.low_confidence,
        values,
        refusals,
        surfaceable: anySurfaceable,
      };
    },
  };
}

export default createAnchorNamespace;
