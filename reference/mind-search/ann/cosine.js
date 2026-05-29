/**
 * Cosine similarity over Float32Array.
 *
 * Pure functions, zero dependencies, fully deterministic. Hot path in
 * mind-search query latency — measured budget is < 30 ms for 5000 candidate
 * 768D vectors on the customer-VPS class (4 GB, 2 vCPU).
 *
 * Two variants:
 *
 *   • cosine(a, b)         — full computation including L2 norms; safe when
 *                            inputs may not be unit vectors. ~3× the work
 *                            of cosineUnit.
 *
 *   • cosineUnit(a, b)     — assumes both inputs are L2-normalized; returns
 *                            dot product (== cosine for unit vectors). Hot
 *                            path. Embedding services produce unit vectors
 *                            by convention so we use this in production.
 *
 * Both reject dim mismatch (caller bug, not data corruption — throws plain
 * Error so it surfaces during development; mind-search proper wraps in
 * MindSearchError at integration boundaries).
 *
 * Property invariants enforced by tests/mind-search/ann/cosine.test.js:
 *
 *   • cos(v, v) ≈ 1
 *   • cos(v, w) === cos(w, v)
 *   • -1 ≤ cos(v, w) ≤ 1
 *   • cos(v, 0) === 0  (sentinel, not NaN)
 *
 * Numerical-stability note: for unit vectors and 768D dim, accumulated
 * float32 dot product has ~1e-6 absolute error. Tests use 1e-5 tolerance.
 */

/**
 * Full cosine similarity. Computes ‖a‖, ‖b‖, and a·b in one pass.
 *
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @returns {number}     in [-1, 1], or 0 if either vector is the zero vector
 */
export function cosine(a, b) {
  if (a.length !== b.length) {
    throw new Error(`cosine: dim mismatch a=${a.length} b=${b.length}`);
  }
  const n = a.length;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  // Manual unroll by 4 — meaningful win on V8 for hot loops.
  let i = 0;
  for (; i + 4 <= n; i += 4) {
    const a0 = a[i],     a1 = a[i + 1], a2 = a[i + 2], a3 = a[i + 3];
    const b0 = b[i],     b1 = b[i + 1], b2 = b[i + 2], b3 = b[i + 3];
    dot   += a0 * b0 + a1 * b1 + a2 * b2 + a3 * b3;
    normA += a0 * a0 + a1 * a1 + a2 * a2 + a3 * a3;
    normB += b0 * b0 + b1 * b1 + b2 * b2 + b3 * b3;
  }
  for (; i < n; i++) {
    const ai = a[i], bi = b[i];
    dot   += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Dot product. Equivalent to cosine() when both inputs are L2-normalized.
 * Production hot path — embed-service produces unit vectors.
 *
 * @param {Float32Array} a   pre-normalized
 * @param {Float32Array} b   pre-normalized
 * @returns {number}         in [-1, 1]
 */
export function cosineUnit(a, b) {
  if (a.length !== b.length) {
    throw new Error(`cosineUnit: dim mismatch a=${a.length} b=${b.length}`);
  }
  const n = a.length;
  let dot = 0;
  let i = 0;
  for (; i + 4 <= n; i += 4) {
    dot += a[i]     * b[i]
         + a[i + 1] * b[i + 1]
         + a[i + 2] * b[i + 2]
         + a[i + 3] * b[i + 3];
  }
  for (; i < n; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Top-K cosine search of `query` against `candidates`.
 *
 * Sorted descending by score. Stable for equal scores: lower idx first.
 * Returns at most `k` results; fewer if `candidates.length < k`.
 *
 * Default uses cosineUnit() — assumes unit-normalized inputs. Pass
 * `{ assumeUnit: false }` to force the full cosine path.
 *
 * @param {Float32Array} query
 * @param {Float32Array[]} candidates
 * @param {number} k
 * @param {object} [opts]
 * @param {boolean} [opts.assumeUnit=true]
 * @returns {Array<{ idx: number, score: number }>}
 */
export function topKCosine(query, candidates, k, opts = {}) {
  const { assumeUnit = true } = opts;
  const scoreFn = assumeUnit ? cosineUnit : cosine;
  const n = candidates.length;
  if (n === 0) return [];

  // Build full scored array first. For the operating regime (≤ 5K candidates)
  // this is cheaper than a heap because the score computation dominates.
  const scored = new Array(n);
  for (let i = 0; i < n; i++) {
    scored[i] = { idx: i, score: scoreFn(query, candidates[i]) };
  }

  // Stable sort: lower idx wins ties. Array.prototype.sort is stable since
  // V8 7.0 / Node 12+, so explicit tie-break is belt-and-suspenders.
  scored.sort((x, y) => {
    if (y.score !== x.score) return y.score - x.score;
    return x.idx - y.idx;
  });

  if (k >= n) return scored;
  return scored.slice(0, k);
}
