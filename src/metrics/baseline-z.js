// Trailing-exclusive baseline z-score — "is the latest value unusual vs MY OWN recent normal".
//
// This is the self-normalization the whole measurement layer converges on (cf. the Fisher
// pooled-null z, the LZ surrogate normalization): never surface a raw accumulator, always the
// baseline-relative form. The pooled-null z answers "is this above measurement NOISE"; THIS
// answers "is this unusual for ME" — they disagree exactly for a stable, low-volume writer
// (a real-but-ordinary-for-them change reads high-pooled-z / low-baseline-z), and the headline
// copy ("Nσ above your normal") describes THIS one.
//
// Two correctness requirements, both load-bearing (see verify:fisher-display):
//  1. TRAILING + EXCLUSIVE — the baseline is the K windows BEFORE the current one; the current
//     value is excluded from its own mean/std. Including it lets a real spike inflate its own
//     std and pull the mean toward itself, so a big week partially hides itself.
//  2. FAIL CLOSED on a degenerate baseline — a near-constant history has std→0, which would
//     fabricate a 100σ for any deviation. Below a coefficient-of-variation floor we return
//     low_confidence, NEVER a giant σ. A fake "you're 100σ off your normal" is exactly the
//     dishonesty this metric exists to kill.

export const BASELINE_Z_DEFAULTS = Object.freeze({
  k: 12,          // trailing window length (~12 weekly_step windows ≈ a quarter)
  minCount: 6,    // need at least this many prior points for a meaningful mean/std
  cvMin: 0.02,    // coefficient-of-variation floor: below this the baseline is too flat to z-score
  stdFloor: 1e-9, // absolute std floor (exact-constant history)
  ddof: 1,        // sample std (Bessel's correction)
});

/**
 * @param {Array<number>} values chronological series; the LAST element is the current value.
 * @param {{k?:number,minCount?:number,cvMin?:number,stdFloor?:number,ddof?:number}} [opts]
 * @returns {{z:number|null, mean:number|null, std:number|null, n:number,
 *            lowConfidence:boolean, reason:string|null}}
 *   reason ∈ {null, 'insufficient_history', 'degenerate_baseline'}.
 */
export function baselineZ(values, opts = {}) {
  const { k, minCount, cvMin, stdFloor, ddof } = { ...BASELINE_Z_DEFAULTS, ...opts };
  const clean = (Array.isArray(values) ? values : []).filter((v) => Number.isFinite(v));
  if (clean.length < minCount + 1) {
    return { z: null, mean: null, std: null, n: clean.length, lowConfidence: true, reason: 'insufficient_history' };
  }
  const cur = clean[clean.length - 1];
  // Trailing + EXCLUSIVE: the K values immediately before the current one.
  const prior = clean.slice(Math.max(0, clean.length - 1 - k), clean.length - 1);
  if (prior.length < minCount) {
    return { z: null, mean: null, std: null, n: prior.length, lowConfidence: true, reason: 'insufficient_history' };
  }
  const mean = prior.reduce((a, b) => a + b, 0) / prior.length;
  const denom = Math.max(1, prior.length - ddof);
  const variance = prior.reduce((a, b) => a + (b - mean) * (b - mean), 0) / denom;
  const std = Math.sqrt(Math.max(0, variance));
  const cv = std / (Math.abs(mean) + 1e-12);
  if (std < stdFloor || cv < cvMin) {
    // Degenerate near-constant baseline → fail closed (NOT a fabricated σ).
    return { z: null, mean, std, n: prior.length, lowConfidence: true, reason: 'degenerate_baseline' };
  }
  return { z: (cur - mean) / std, mean, std, n: prior.length, lowConfidence: false, reason: null };
}
