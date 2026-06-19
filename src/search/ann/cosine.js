/**
 * Cosine similarity over Float32Array.
 *
 * Ported verbatim from reference/mind-search/ann/cosine.js. Pure, zero-dep,
 * deterministic. cosine() computes norms; cosineUnit() assumes unit vectors
 * (embed-service produces unit vectors by convention).
 *
 * Invariants: cos(v,v)≈1; cos(v,w)===cos(w,v); -1≤cos≤1; cos(v,0)===0.
 */

export function cosine(a, b) {
  if (a.length !== b.length) {
    throw new Error(`cosine: dim mismatch a=${a.length} b=${b.length}`);
  }
  const n = a.length;
  let dot = 0, normA = 0, normB = 0;
  let i = 0;
  for (; i + 4 <= n; i += 4) {
    const a0 = a[i], a1 = a[i + 1], a2 = a[i + 2], a3 = a[i + 3];
    const b0 = b[i], b1 = b[i + 1], b2 = b[i + 2], b3 = b[i + 3];
    dot += a0 * b0 + a1 * b1 + a2 * b2 + a3 * b3;
    normA += a0 * a0 + a1 * a1 + a2 * a2 + a3 * a3;
    normB += b0 * b0 + b1 * b1 + b2 * b2 + b3 * b3;
  }
  for (; i < n; i++) {
    const ai = a[i], bi = b[i];
    dot += ai * bi; normA += ai * ai; normB += bi * bi;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function cosineUnit(a, b) {
  if (a.length !== b.length) {
    throw new Error(`cosineUnit: dim mismatch a=${a.length} b=${b.length}`);
  }
  const n = a.length;
  let dot = 0, i = 0;
  for (; i + 4 <= n; i += 4) {
    dot += a[i] * b[i] + a[i + 1] * b[i + 1] + a[i + 2] * b[i + 2] + a[i + 3] * b[i + 3];
  }
  for (; i < n; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Top-K cosine search of `query` against `candidates`. Sorted desc, stable
 * (lower idx wins ties). Default assumes unit vectors; pass { assumeUnit:false }
 * for the full cosine path (used by the deterministic stub embedder in verify).
 * @returns {Array<{ idx:number, score:number }>}
 */
export function topKCosine(query, candidates, k, opts = {}) {
  const { assumeUnit = true } = opts;
  const scoreFn = assumeUnit ? cosineUnit : cosine;
  const n = candidates.length;
  if (n === 0) return [];
  const scored = new Array(n);
  for (let i = 0; i < n; i++) scored[i] = { idx: i, score: scoreFn(query, candidates[i]) };
  scored.sort((x, y) => (y.score !== x.score ? y.score - x.score : x.idx - y.idx));
  if (k >= n) return scored;
  return scored.slice(0, k);
}
