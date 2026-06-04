/**
 * Canonical mathematical primitives for derived-metric stages (JS).
 *
 * Single source of truth for the operators the measurement stages need
 * (compute-vitality, topology-audit, compute-complexity, compute-territory-
 * neighbors, the criticality + coherence families). Imported, never
 * copy-pasted per stage — see docs/MEASUREMENT-LAYER-BUILDOUT-PLAN-2026-06-04.md
 * (the modular-monolith principle: shared primitives live in exactly one place).
 *
 * PORTED VERBATIM from the canonical @mycelium/metrics/primitives.js
 * (Curious-Life/mycelium) so the 1e-12 cross-language fixture parity holds and
 * re-sync stays trivial. The function bodies are byte-equivalent to canonical;
 * only this header differs. Cross-language gate: scripts/verify-primitives.mjs
 * against scripts/fixtures/primitives_fixture.json.
 *
 * NOTE on entropy bases: nats and bits are BOTH used in different places — the
 * three named functions are NOT interchangeable.
 *   - entropyNats(p)        → -Σ pᵢ ln pᵢ            (matches pipeline/fisher.py)
 *   - entropyBits(p)        → -Σ pᵢ log₂ pᵢ
 *   - entropyNormalized(p)  → entropy / ln|p| ∈ [0,1] (base-invariant; canonical for new code)
 *
 * NOTE on lzComplexity: this is a HEURISTIC "working approximation" of LZ76, not
 * the textbook algorithm (preserved verbatim for byte-equivalence with the
 * canonical compute-complexity.js). A true textbook LZ76 lands separately in
 * F3 (alongside this, not replacing it) per the buildout plan.
 */

// ── Vector utilities ─────────────────────────────────────────────────

/**
 * L2-normalize a vector. Returns the input (copied) unchanged when its norm is
 * zero (defensive; matches the Python normalization sites).
 * @param {number[]} v
 * @returns {number[]}
 */
export function l2Normalize(v) {
  let sumSq = 0;
  for (const x of v) sumSq += x * x;
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return v.slice();
  return v.map((x) => x / norm);
}

/**
 * Cosine similarity of two vectors. Returns 0 on null/undefined input, length
 * mismatch, or zero norm on either side (sensible degenerate case).
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
export function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

// ── Probability vectors ─────────────────────────────────────────────

/**
 * Convert a non-negative count vector to a probability vector. Returns a
 * uniform distribution over n bins when total is zero (sum-to-one property).
 * @param {number[]} counts
 * @returns {number[]}
 */
export function countsToProbs(counts) {
  const n = counts.length;
  if (n === 0) return [];
  let total = 0;
  for (const c of counts) total += c;
  if (total === 0) return new Array(n).fill(1 / n);
  return counts.map((c) => c / total);
}

// ── Shannon entropy (three named variants — NOT interchangeable) ─────

/**
 * Shannon entropy in nats (natural-log base). H(p) = -Σ pᵢ ln pᵢ, 0·ln0 = 0.
 * Matches pipeline/fisher.py::activation_entropy.
 * @param {number[]} p
 * @returns {number}
 */
export function entropyNats(p) {
  let h = 0;
  for (const pi of p) {
    if (pi > 0) h -= pi * Math.log(pi);
  }
  return h;
}

/**
 * Shannon entropy in bits (base-2 log). H(p) = -Σ pᵢ log₂(pᵢ).
 * @param {number[]} p
 * @returns {number}
 */
export function entropyBits(p) {
  let h = 0;
  for (const pi of p) {
    if (pi > 0) h -= pi * Math.log2(pi);
  }
  return h;
}

/**
 * Shannon entropy normalized to [0,1] by dividing by log|p| (base-invariant).
 * Returns 0 for length-0/1 input (max entropy 0; 0/0 → 0).
 * @param {number[]} p
 * @returns {number}
 */
export function entropyNormalized(p) {
  const n = p.length;
  if (n <= 1) return 0;
  const h = entropyNats(p);
  const maxH = Math.log(n);
  return maxH > 0 ? h / maxH : 0;
}

// ── Lempel-Ziv complexity (HEURISTIC, see file header) ──────────────

/**
 * Heuristic LZ76-style complexity of a stringifiable sequence. Detects
 * repetition/novelty. NOT textbook LZ76 (see header). Output shape preserved
 * verbatim from the original compute-complexity.js implementation.
 *
 *   complexity, normalized ∈ [0,1], sequenceLength, alphabetSize
 * @param {Array<number|string>} sequence
 * @returns {{complexity:number, normalized:number, sequenceLength:number, alphabetSize:number}}
 */
export function lzComplexity(sequence) {
  if (sequence.length < 2) {
    return { complexity: 0, normalized: 0, sequenceLength: sequence.length, alphabetSize: 0 };
  }

  const s = sequence.map((x) => String(x)).join(',') + ',';
  const n = s.length;

  let complexity = 1;
  let i = 0;
  let k = 1;

  while (i + k <= n) {
    const substring = s.slice(i, i + k);
    const searchRegion = s.slice(0, i);
    if (searchRegion.includes(substring)) {
      k++;
    } else {
      complexity++;
      i = i + k;
      k = 1;
    }
  }

  const alphabetSize = new Set(sequence).size;
  const maxComplexity = alphabetSize > 1 ? n / Math.log2(alphabetSize) : 1;
  const normalized = maxComplexity > 0 ? Math.min(1, complexity / maxComplexity) : 0;

  return {
    complexity,
    normalized: Math.round(normalized * 1000) / 1000,
    sequenceLength: sequence.length,
    alphabetSize,
  };
}

// ── Gini coefficient ────────────────────────────────────────────────

/**
 * Gini coefficient of a non-negative numeric vector (0 = equal, 1 = maximally
 * unequal). Takes UNSORTED input, sorts internally. Returns 0 on empty or
 * zero-mean input.
 *   G(v) = Σᵢ (2i − n − 1) · vᵢ_sorted / (n² · mean)
 * @param {number[]} values
 * @returns {number}
 */
export function gini(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return 0;
  let sum = 0;
  for (const v of sorted) sum += v;
  if (sum === 0) return 0;
  const mean = sum / n;
  let sumDiff = 0;
  for (let i = 0; i < n; i++) {
    sumDiff += (2 * (i + 1) - n - 1) * sorted[i];
  }
  return sumDiff / (n * n * mean);
}

// ── True Lempel-Ziv (LZ76) complexity ───────────────────────────────

/**
 * Textbook Lempel-Ziv (1976) complexity c(S) via the Kaspar & Schuster (1987)
 * production-count algorithm — the RIGOROUS LZ76 the spec (§4.18) wants,
 * distinct from the heuristic `lzComplexity` above (kept for byte-equivalence
 * with the legacy compute-complexity path). Operates on a sequence of
 * comparable symbols (numbers/strings).
 *
 *   complexity      true LZ76 production count c(n)
 *   normalized      c(n) / (n / log_a(n))  (a = alphabet size), clamped ≤ 1
 *   sequenceLength, alphabetSize
 * @param {Array<number|string>} sequence
 * @returns {{complexity:number, normalized:number, sequenceLength:number, alphabetSize:number}}
 */
export function lz76Complexity(sequence) {
  const n = sequence.length;
  const alphabetSize = new Set(sequence).size;
  if (n < 2) return { complexity: n === 0 ? 0 : 1, normalized: 0, sequenceLength: n, alphabetSize };
  const s = sequence;
  let i = 0, c = 1, u = 1, v = 1, vmax = 1;
  while (u + v <= n) {
    if (s[i + v - 1] === s[u + v - 1]) {
      v++;
    } else {
      if (v > vmax) vmax = v;
      i++;
      if (i === u) { c++; u += vmax; v = 1; i = 0; vmax = 1; }
      else { v = 1; }
    }
  }
  if (v !== 1) c++;
  const b = alphabetSize > 1 ? n / (Math.log(n) / Math.log(alphabetSize)) : 1;
  const normalized = b > 0 ? Math.min(1, c / b) : 0;
  return { complexity: c, normalized: Math.round(normalized * 1000) / 1000, sequenceLength: n, alphabetSize };
}

// ── Variance ────────────────────────────────────────────────────────

/**
 * Population variance (mean of squared deviations). 0 on empty input. The
 * caller slides the window for §4.26 critical_slowing_variance; also used by
 * CVP baselines.
 * @param {number[]} values
 * @returns {number}
 */
export function variance(values) {
  const n = values.length;
  if (n === 0) return 0;
  let mean = 0;
  for (const x of values) mean += x;
  mean /= n;
  let s = 0;
  for (const x of values) { const d = x - mean; s += d * d; }
  return s / n;
}
