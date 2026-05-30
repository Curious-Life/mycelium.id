/**
 * BM25 scorer over an InvertedIndex.
 *
 * Standard formula (Robertson/Spärck Jones):
 *
 *   score(D, Q) = Σ_{t ∈ Q} IDF(t) · (tf(t,D) · (k1 + 1)) /
 *                              (tf(t,D) + k1 · (1 − b + b · |D|/avgdl))
 *
 *   IDF(t) = ln( (N − df(t) + 0.5) / (df(t) + 0.5) + 1 )
 *
 *   k1 = 1.5      term-frequency saturation (lower → faster saturation)
 *   b  = 0.75     length-normalization strength (1.0 = full, 0 = none)
 *
 * The "+1" in IDF guarantees a non-negative score even when a token
 * appears in more than half the corpus (otherwise IDF can go negative,
 * which inverts ranking for noise terms — undesirable for our use).
 *
 * Properties (test-enforced):
 *   • Monotonic in tf:  more occurrences → higher score (holding df fixed)
 *   • Decreasing in df: rarer term → higher score (holding tf fixed)
 *   • Zero score for empty query
 *   • Stable under document-insertion order
 *
 * IDF caching:
 *   IDF depends only on (df(t), N). Both change only when documents are
 *   added/removed. We cache IDF per token and invalidate the entire cache
 *   when N changes (via invalidate()) — coarse but correct, and cheap to
 *   recompute lazily on next score() call.
 *
 * No state in the function itself: callers that want repeated scoring
 * across an unchanged index should construct a `BM25Scorer` instance,
 * which carries the IDF cache. One-shot callers can use the bare `score()`
 * function (no caching).
 */

const DEFAULT_K1 = 1.5;
const DEFAULT_B  = 0.75;

/**
 * @typedef {object} BM25Opts
 * @property {number} [k1=1.5]
 * @property {number} [b=0.75]
 * @property {number} [topK=20]   when set, return only the top-K results
 *
 * @typedef {object} BM25Hit
 * @property {string} id
 * @property {number} score
 */

/**
 * Score query tokens against the index. Stateless — recomputes IDF every
 * call. For repeated scoring use BM25Scorer.
 *
 * @param {Iterable<string>} query   tokens (already normalized)
 * @param {import('./inverted.js').InvertedIndex} index
 * @param {BM25Opts} [opts]
 * @returns {BM25Hit[]}              sorted desc by score
 */
export function score(query, index, opts = {}) {
  const scorer = new BM25Scorer(index, opts);
  return scorer.score(query, opts);
}

/**
 * Stateful scorer with IDF caching. Construct once per query batch over
 * an unchanged index for amortized speed. Call `invalidate()` after any
 * mutation that changes document count or per-token df.
 */
export class BM25Scorer {
  /**
   * @param {import('./inverted.js').InvertedIndex} index
   * @param {BM25Opts} [opts]
   */
  constructor(index, opts = {}) {
    if (!index || typeof index.lookup !== 'function') {
      throw new TypeError('BM25Scorer: index must implement InvertedIndex contract');
    }
    this.index = index;
    this.k1 = opts.k1 ?? DEFAULT_K1;
    this.b  = opts.b  ?? DEFAULT_B;
    if (!(this.k1 >= 0)) throw new TypeError('BM25Scorer: k1 must be non-negative');
    if (!(this.b >= 0 && this.b <= 1)) throw new TypeError('BM25Scorer: b must be in [0, 1]');

    /** @type {Map<string, number>} */
    this._idfCache = new Map();
    this._cachedN = index.totalDocs();
    this._cachedAvgdl = index.avgDocumentLength();
  }

  /**
   * Recompute internal aggregates after the underlying index changed.
   * Cheap (just reads three numbers); always safe to call.
   */
  invalidate() {
    this._idfCache.clear();
    this._cachedN = this.index.totalDocs();
    this._cachedAvgdl = this.index.avgDocumentLength();
  }

  /**
   * IDF(t) = ln( (N − df + 0.5) / (df + 0.5) + 1 )
   *
   * Returns 0 for unknown tokens so scoring loops can multiply blindly.
   */
  idf(token) {
    if (this._cachedN === 0) return 0;
    let cached = this._idfCache.get(token);
    if (cached !== undefined) return cached;
    const df = this.index.documentFrequency(token);
    if (df === 0) {
      this._idfCache.set(token, 0);
      return 0;
    }
    const value = Math.log(((this._cachedN - df + 0.5) / (df + 0.5)) + 1);
    this._idfCache.set(token, value);
    return value;
  }

  /**
   * Score query tokens against the indexed corpus.
   *
   * @param {Iterable<string>} query   tokens (already normalized)
   * @param {object} [opts]
   * @param {number} [opts.topK]       return only top-K (sorted desc)
   * @returns {BM25Hit[]}              sorted desc by score
   */
  score(query, opts = {}) {
    if (this._cachedN === 0) return [];
    const tokens = Array.from(query).filter((t) => typeof t === 'string' && t.length > 0);
    if (tokens.length === 0) return [];

    const k1 = this.k1;
    const b = this.b;
    const avgdl = this._cachedAvgdl;

    /** @type {Map<string, number>} */
    const accum = new Map();

    // Iterate query tokens once each — repeated tokens in the query are
    // a no-op for BM25 (the formula assumes set semantics on Q).
    const seen = new Set();
    for (const token of tokens) {
      if (seen.has(token)) continue;
      seen.add(token);
      const idf = this.idf(token);
      if (idf === 0) continue; // unknown or universally common; contributes 0
      const list = this.index.lookup(token);
      for (let i = 0; i < list.length; i++) {
        const { id, tf } = list[i];
        const dl = this.index.documentLength(id);
        // dl is guaranteed > 0 if the doc has any tokens; defensive guard:
        const norm = dl === 0 ? 1 : (1 - b + b * dl / avgdl);
        const tfPart = (tf * (k1 + 1)) / (tf + k1 * norm);
        accum.set(id, (accum.get(id) || 0) + idf * tfPart);
      }
    }

    if (accum.size === 0) return [];

    const out = new Array(accum.size);
    let i = 0;
    for (const [id, sum] of accum) out[i++] = { id, score: sum };

    out.sort((a, b2) => {
      if (b2.score !== a.score) return b2.score - a.score;
      // Stable tie-break: lexicographic id (deterministic across runs)
      if (a.id < b2.id) return -1;
      if (a.id > b2.id) return 1;
      return 0;
    });

    if (Number.isInteger(opts.topK) && opts.topK >= 0 && opts.topK < out.length) {
      return out.slice(0, opts.topK);
    }
    return out;
  }
}
