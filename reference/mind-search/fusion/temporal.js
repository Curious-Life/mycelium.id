/**
 * Temporal-proximity boost.
 *
 *   boosted_score = score · exp(−Δt / τ)        Δt = max(0, queryTs − itemTs)
 *
 * Recency intent (selected per query):
 *
 *   recent     τ = 6 h     "what was I doing this morning"
 *   mixed      τ = 7 d     default — balances recall and recency
 *   reflective τ = ∞       no decay — full retrospective recall
 *
 * Why a multiplicative boost rather than additive: it preserves the
 * relative-ordering invariants of the upstream scorer for items with
 * similar timestamps, while letting recency dominate when timestamps
 * differ substantially. Additive boosting would let a stale item with
 * a high upstream score swamp a recent low-scored one.
 *
 * Why max(0, queryTs − itemTs): items with a future timestamp would
 * otherwise produce Δt < 0 → exp(positive) → > 1, amplifying scores
 * unboundedly. Clamp to zero — future items get the full score, no
 * special handling, no surprises.
 *
 * Items lacking a `ts` field are passed through with score unchanged.
 * The fusion layer (rrf.js) doesn't propagate `ts`, so callers must
 * enrich each result with its document's timestamp before invoking this
 * function. (See LocalBackend in PR 8.)
 *
 * Properties (test-enforced):
 *   • Δt = 0  →  boost = 1  →  score unchanged
 *   • boost is monotonically non-increasing in Δt (older → not-higher)
 *   • Δt < 0 (future) → boost = 1 (clamped, no amplification)
 *   • recency='reflective' → identity (no field changed)
 *   • All output scores are finite (no NaN, no Infinity)
 *   • Length and id-set of input == output
 */

/**
 * @typedef {'recent' | 'mixed' | 'reflective'} Recency
 *
 * @typedef {object} ScoredItem
 * @property {string} id
 * @property {number} score
 * @property {number} [ts]   unix-seconds; missing = no boost applied
 *
 * @typedef {object} TemporalOpts
 * @property {number} [queryTs]              unix-seconds; default Math.floor(Date.now()/1000)
 * @property {Recency} [recency='mixed']
 * @property {number} [tau]                  override τ in seconds (escape hatch)
 * @property {boolean} [sort=true]           re-sort output desc by score
 */

/**
 * Decay constants τ (seconds) per recency intent.
 * Exposed for tests and tools that want to reason about the curve.
 */
export const RECENCY_TAU = Object.freeze({
  recent:     6 * 3600,        //  21,600 s   = 6 hours
  mixed:      7 * 24 * 3600,   // 604,800 s   = 7 days
  reflective: Infinity,        // no decay
});

/**
 * Apply temporal-proximity boost to scored items. Returns a new array;
 * does NOT mutate the input.
 *
 * @param {ScoredItem[]} results
 * @param {TemporalOpts} [opts]
 * @returns {ScoredItem[]}
 */
export function temporalBoost(results, opts = {}) {
  if (!Array.isArray(results)) {
    throw new TypeError('temporalBoost: results must be an array');
  }
  const recency = opts.recency ?? 'mixed';
  const tauOverride = opts.tau;
  let tau;
  if (tauOverride !== undefined) {
    if (typeof tauOverride !== 'number' || !(tauOverride > 0)) {
      throw new TypeError('temporalBoost: opts.tau must be a positive number');
    }
    tau = tauOverride;
  } else {
    if (!(recency in RECENCY_TAU)) {
      throw new TypeError(`temporalBoost: unknown recency '${recency}'`);
    }
    tau = RECENCY_TAU[recency];
  }

  // Reflective is identity by construction (τ = ∞ → exp(0) = 1).
  // Short-circuit to avoid the loop and to preserve `ts` shape exactly.
  if (tau === Infinity) {
    if (opts.sort === false) return results.slice();
    return [...results].sort(byScoreDescThenIdAsc);
  }

  const queryTs = opts.queryTs ?? Math.floor(Date.now() / 1000);
  if (typeof queryTs !== 'number' || !Number.isFinite(queryTs)) {
    throw new TypeError('temporalBoost: opts.queryTs must be a finite number');
  }

  const out = new Array(results.length);
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r || typeof r.id !== 'string') {
      throw new TypeError(`temporalBoost: results[${i}] must be an object with string id`);
    }
    const ts = r.ts;
    let boostedScore = r.score;
    if (typeof ts === 'number' && Number.isFinite(ts)) {
      const dt = Math.max(0, queryTs - ts); // clamp future to "now"
      const boost = Math.exp(-dt / tau);
      boostedScore = r.score * boost;
    }
    // Preserve all original fields; only `score` changes.
    out[i] = { ...r, score: boostedScore };
  }

  if (opts.sort === false) return out;
  out.sort(byScoreDescThenIdAsc);
  return out;
}

/**
 * Apply temporal boost to a list and look up each item's `ts` from a
 * provider function. Convenience for the LocalBackend write site, where
 * RRF output lacks `ts` but the InvertedIndex.documentTs() can supply it.
 *
 * @param {Array<{id: string, score: number}>} results
 * @param {(id: string) => number | null} tsProvider
 * @param {TemporalOpts} [opts]
 * @returns {ScoredItem[]}
 */
export function temporalBoostWithProvider(results, tsProvider, opts = {}) {
  if (typeof tsProvider !== 'function') {
    throw new TypeError('temporalBoostWithProvider: tsProvider must be a function');
  }
  const enriched = results.map((r) => {
    const ts = tsProvider(r.id);
    return ts == null ? r : { ...r, ts };
  });
  return temporalBoost(enriched, opts);
}

// ── Sort helper ─────────────────────────────────────────────────────────

function byScoreDescThenIdAsc(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}
