/**
 * Reciprocal Rank Fusion.
 *
 * Cormack, Clarke & Büttcher (2009): given multiple ranked result lists
 * over the same id space, compute a fused score per id as the sum of
 * 1/(k + rank) contributions across lists. Ranks are 1-indexed.
 *
 *   RRF(d) = Σ_{L ∈ lists}  1 / (k + rank_L(d))   if d ∈ L
 *
 * k = 60 is the literature default. Lower k weighs the head more
 * aggressively (top-1 dominates); higher k spreads weight further down.
 * 60 is a robust setting across IR benchmarks; we keep it.
 *
 * Why RRF (vs weighted score sums):
 *   • Score-magnitude-independent. Cosine in [-1, 1] and BM25 in [0, ∞)
 *     have wildly different distributions; RRF normalizes via rank.
 *   • Robust to scale changes and outliers in either upstream.
 *   • Operationally trivial: no hyperparameter tuning per upstream.
 *
 * Properties (test-enforced):
 *   • Output id set ⊆ union of input id sets
 *   • Output scores are non-negative and bounded by len(lists) / (k+1)
 *   • Within-list duplicate ids count only at their best rank
 *   • Deterministic ordering (stable tie-break by id)
 *
 * Per CLAUDE.md §1 this module never logs or returns content — only ids
 * and scores. The optional `includeSources` flag includes a small numeric
 * source-list bitmap for debugging (no content).
 */

const DEFAULT_K = 60;

/**
 * @typedef {object} RrfHit
 * @property {string} id
 * @property {number} score
 *
 * @typedef {object} RrfHitWithSources
 * @property {string} id
 * @property {number} score
 * @property {number[]} sources   indices of input lists that contained this id
 */

/**
 * Fuse N ranked lists into a single ranked list.
 *
 * @param {Array<Array<{id: string}>>} lists  ordered: lists[i][0] is rank 1 in list i
 * @param {object} [opts]
 * @param {number} [opts.k=60]                 RRF smoothing constant (must be > 0)
 * @param {number} [opts.topK]                 trim output to top-K (sorted desc)
 * @param {boolean} [opts.includeSources=false] include `sources` (input-list indices)
 * @returns {RrfHit[] | RrfHitWithSources[]}    sorted desc by score, ties by id asc
 */
export function rrf(lists, opts = {}) {
  if (!Array.isArray(lists)) {
    throw new TypeError('rrf: lists must be an array of arrays');
  }
  for (let i = 0; i < lists.length; i++) {
    if (!Array.isArray(lists[i])) {
      throw new TypeError(`rrf: lists[${i}] must be an array`);
    }
  }
  const k = opts.k ?? DEFAULT_K;
  if (typeof k !== 'number' || !Number.isFinite(k) || k <= 0) {
    throw new TypeError('rrf: opts.k must be a finite positive number');
  }
  const includeSources = opts.includeSources === true;

  /** @type {Map<string, number>} */
  const accum = new Map();
  /** @type {Map<string, number[]> | null} */
  const sources = includeSources ? new Map() : null;

  for (let li = 0; li < lists.length; li++) {
    const list = lists[li];
    // Track ids seen earlier in THIS list — only count first (best) rank
    // per id within a single list. Later occurrences of the same id are
    // worse rank, and treating them as additional contributions would
    // over-weight upstream lists that emit duplicates.
    const seenInList = new Set();
    for (let r = 0; r < list.length; r++) {
      const item = list[r];
      if (!item || typeof item.id !== 'string' || item.id.length === 0) continue;
      if (seenInList.has(item.id)) continue;
      seenInList.add(item.id);
      const contribution = 1 / (k + r + 1); // ranks are 1-indexed: rank = r+1
      accum.set(item.id, (accum.get(item.id) || 0) + contribution);
      if (sources) {
        let arr = sources.get(item.id);
        if (!arr) {
          arr = [];
          sources.set(item.id, arr);
        }
        arr.push(li);
      }
    }
  }

  if (accum.size === 0) return [];

  const out = new Array(accum.size);
  let i = 0;
  for (const [id, score] of accum) {
    out[i++] = sources
      ? { id, score, sources: sources.get(id) }
      : { id, score };
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

/**
 * Theoretical maximum RRF score for a given configuration.
 * Useful for normalizing against if a caller wants [0, 1] output.
 *
 * Maximum is reached by an id ranked 1 in every input list:
 *   maxScore = numLists / (k + 1)
 *
 * @param {number} numLists
 * @param {number} [k=60]
 * @returns {number}
 */
export function maxRrfScore(numLists, k = DEFAULT_K) {
  if (!Number.isFinite(numLists) || numLists < 0) {
    throw new TypeError('maxRrfScore: numLists must be a non-negative finite number');
  }
  if (!Number.isFinite(k) || k <= 0) {
    throw new TypeError('maxRrfScore: k must be a positive finite number');
  }
  return numLists / (k + 1);
}
