/**
 * Temporal-proximity boost.
 *
 * Ported verbatim from reference/mind-search/fusion/temporal.js.
 *
 *   boosted = score · exp(−Δt / τ)     Δt = max(0, queryTs − itemTs)
 *
 *   recent     τ = 6h
 *   mixed      τ = 7d   (default)
 *   reflective τ = ∞    (no decay)
 *
 * Multiplicative (preserves upstream ordering for similar timestamps; lets
 * recency dominate when timestamps differ). Future items clamped to Δt=0.
 * Items without ts pass through unchanged.
 */

export const RECENCY_TAU = Object.freeze({
  recent: 6 * 3600,
  mixed: 7 * 24 * 3600,
  reflective: Infinity,
});

export function temporalBoost(results, opts = {}) {
  if (!Array.isArray(results)) throw new TypeError('temporalBoost: results must be an array');
  const recency = opts.recency ?? 'mixed';
  const tauOverride = opts.tau;
  let tau;
  if (tauOverride !== undefined) {
    if (typeof tauOverride !== 'number' || !(tauOverride > 0)) {
      throw new TypeError('temporalBoost: opts.tau must be a positive number');
    }
    tau = tauOverride;
  } else {
    if (!(recency in RECENCY_TAU)) throw new TypeError(`temporalBoost: unknown recency '${recency}'`);
    tau = RECENCY_TAU[recency];
  }

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
      const dt = Math.max(0, queryTs - ts);
      boostedScore = r.score * Math.exp(-dt / tau);
    }
    out[i] = { ...r, score: boostedScore };
  }
  if (opts.sort === false) return out;
  out.sort(byScoreDescThenIdAsc);
  return out;
}

/** Boost a list, looking up each item's ts from a provider function. */
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

function byScoreDescThenIdAsc(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}
