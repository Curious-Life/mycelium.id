/**
 * Reciprocal Rank Fusion (Cormack, Clarke & Büttcher 2009).
 *
 * Ported verbatim from reference/mind-search/fusion/rrf.js.
 *
 *   RRF(d) = Σ_{L ∈ lists} 1/(k + rank_L(d))   (ranks 1-indexed; k=60)
 *
 * Rank-based, so robust to incomparable score scales between BM25 (0..∞) and
 * cosine (-1..1). Within-list duplicate ids count only at their best rank.
 * Deterministic ordering (ties broken by id asc).
 */

const DEFAULT_K = 60;

export function rrf(lists, opts = {}) {
  if (!Array.isArray(lists)) {
    throw new TypeError('rrf: lists must be an array of arrays');
  }
  for (let i = 0; i < lists.length; i++) {
    if (!Array.isArray(lists[i])) throw new TypeError(`rrf: lists[${i}] must be an array`);
  }
  const k = opts.k ?? DEFAULT_K;
  if (typeof k !== 'number' || !Number.isFinite(k) || k <= 0) {
    throw new TypeError('rrf: opts.k must be a finite positive number');
  }
  const includeSources = opts.includeSources === true;

  const accum = new Map();
  const sources = includeSources ? new Map() : null;

  for (let li = 0; li < lists.length; li++) {
    const list = lists[li];
    const seenInList = new Set();
    for (let r = 0; r < list.length; r++) {
      const item = list[r];
      if (!item || typeof item.id !== 'string' || item.id.length === 0) continue;
      if (seenInList.has(item.id)) continue;
      seenInList.add(item.id);
      const contribution = 1 / (k + r + 1);
      accum.set(item.id, (accum.get(item.id) || 0) + contribution);
      if (sources) {
        let arr = sources.get(item.id);
        if (!arr) { arr = []; sources.set(item.id, arr); }
        arr.push(li);
      }
    }
  }

  if (accum.size === 0) return [];

  const out = new Array(accum.size);
  let i = 0;
  for (const [id, score] of accum) {
    out[i++] = sources ? { id, score, sources: sources.get(id) } : { id, score };
  }
  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });

  if (Number.isInteger(opts.topK) && opts.topK >= 0 && opts.topK < out.length) {
    return out.slice(0, opts.topK);
  }
  return out;
}

/** Theoretical max RRF score: numLists / (k + 1). */
export function maxRrfScore(numLists, k = DEFAULT_K) {
  if (!Number.isFinite(numLists) || numLists < 0) {
    throw new TypeError('maxRrfScore: numLists must be a non-negative finite number');
  }
  if (!Number.isFinite(k) || k <= 0) {
    throw new TypeError('maxRrfScore: k must be a positive finite number');
  }
  return numLists / (k + 1);
}
