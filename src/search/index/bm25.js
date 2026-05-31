/**
 * BM25 scorer over an InvertedIndex.
 *
 * Ported verbatim from reference/mind-search/index/bm25.js.
 *
 *   score(D,Q) = Σ_t IDF(t) · (tf·(k1+1)) / (tf + k1·(1 − b + b·|D|/avgdl))
 *   IDF(t)     = ln( (N − df + 0.5)/(df + 0.5) + 1 )      (+1 → non-negative)
 *   k1 = 1.5    b = 0.75
 *
 * BM25Scorer caches IDF across repeated scoring over an unchanged index;
 * call invalidate() after any mutation. score() (bare fn) is one-shot.
 */

const DEFAULT_K1 = 1.5;
const DEFAULT_B = 0.75;

export function score(query, index, opts = {}) {
  const scorer = new BM25Scorer(index, opts);
  return scorer.score(query, opts);
}

export class BM25Scorer {
  constructor(index, opts = {}) {
    if (!index || typeof index.lookup !== 'function') {
      throw new TypeError('BM25Scorer: index must implement InvertedIndex contract');
    }
    this.index = index;
    this.k1 = opts.k1 ?? DEFAULT_K1;
    this.b = opts.b ?? DEFAULT_B;
    if (!(this.k1 >= 0)) throw new TypeError('BM25Scorer: k1 must be non-negative');
    if (!(this.b >= 0 && this.b <= 1)) throw new TypeError('BM25Scorer: b must be in [0, 1]');
    this._idfCache = new Map();
    this._cachedN = index.totalDocs();
    this._cachedAvgdl = index.avgDocumentLength();
  }

  invalidate() {
    this._idfCache.clear();
    this._cachedN = this.index.totalDocs();
    this._cachedAvgdl = this.index.avgDocumentLength();
  }

  idf(token) {
    if (this._cachedN === 0) return 0;
    const cached = this._idfCache.get(token);
    if (cached !== undefined) return cached;
    const df = this.index.documentFrequency(token);
    if (df === 0) { this._idfCache.set(token, 0); return 0; }
    const value = Math.log(((this._cachedN - df + 0.5) / (df + 0.5)) + 1);
    this._idfCache.set(token, value);
    return value;
  }

  score(query, opts = {}) {
    if (this._cachedN === 0) return [];
    const tokens = Array.from(query).filter((t) => typeof t === 'string' && t.length > 0);
    if (tokens.length === 0) return [];

    const k1 = this.k1;
    const b = this.b;
    const avgdl = this._cachedAvgdl;
    const accum = new Map();

    const seen = new Set();
    for (const token of tokens) {
      if (seen.has(token)) continue;
      seen.add(token);
      const idf = this.idf(token);
      if (idf === 0) continue;
      const list = this.index.lookup(token);
      for (let i = 0; i < list.length; i++) {
        const { id, tf } = list[i];
        const dl = this.index.documentLength(id);
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
