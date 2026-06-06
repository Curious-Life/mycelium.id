// src/claims/confidence.js — log-odds confidence with type-specific temporal
// decay. Pure functions, no I/O. Implements PersonaTree §3.4 (Eq. 3):
//
//   L_t = (L_{t-1} − L_base) · e^{−λ·Δt} + L_base + ωE
//   c_t = σ(L_t)
//
// Confidence lives in LOG-ODDS space so support / conflict act as additive
// positive / negative evidence (ωE), while the sigmoid keeps the surfaced
// confidence bounded in (0,1). The decay term pulls L back toward a neutral
// baseline (L_base = 0 ⇒ c = 0.5) when no new evidence arrives — but the decay
// RATE λ is type-specific: a safety boundary never fades, a passing mood fades
// fast. Reuses the exp(−Δt/τ) shape from src/search/fusion/temporal.js (τ = 1/λ).
//
// See docs/PERSONA-CLAIMS-DESIGN-2026-06-06.md §3.3.

const DAY = 86400; // seconds

// Per-second decay rates by decay_class. λ = ln(2)/halflife is an option, but we
// use λ = 1/τ (the temporal.js convention) so τ reads directly as a time
// constant in seconds. A boundary has λ=0 → it NEVER decays (CLAUDE.md §3
// fail-closed: an allergy / trauma boundary must not silently fade).
export const DECAY_LAMBDA = Object.freeze({
  boundary: 0, // never fades
  identity: 1 / (365 * DAY), // τ ≈ 1 year
  fact: 1 / (180 * DAY), // τ ≈ 6 months
  preference: 1 / (30 * DAY), // τ ≈ 1 month
  mood: 1 / (7 * DAY), // τ ≈ 1 week
});

// Neutral baseline the decay pulls toward (log-odds 0 ⇒ confidence 0.5).
export const L_BASE = 0;

function lambdaFor(decayClass) {
  const λ = DECAY_LAMBDA[decayClass];
  if (λ === undefined) {
    throw new TypeError(`confidence: unknown decay_class ${JSON.stringify(decayClass)} (valid: ${Object.keys(DECAY_LAMBDA).join(', ')})`);
  }
  return λ;
}

/**
 * Decay a log-odds value toward L_BASE over Δt seconds for a decay class.
 * Negative Δt (a future/clock-skew timestamp) is clamped to 0 — no decay —
 * matching temporalBoost's Δt = max(0, …). λ=0 (boundary) is an exact identity.
 * @returns {number} decayed log-odds
 */
export function decayLogOdds(L, dtSeconds, decayClass) {
  if (typeof L !== 'number' || !Number.isFinite(L)) throw new TypeError('confidence: L must be a finite number');
  if (typeof dtSeconds !== 'number' || Number.isNaN(dtSeconds)) throw new TypeError('confidence: dtSeconds must be a number');
  const λ = lambdaFor(decayClass);
  if (λ === 0) return L; // boundary: no decay, ever
  const dt = Math.max(0, dtSeconds);
  return (L - L_BASE) * Math.exp(-λ * dt) + L_BASE;
}

/**
 * Apply an evidence weight ω ∈ [−1,1]-ish (positive = support, negative =
 * conflict) to a log-odds value. Additive in log-odds space (PersonaTree ωE).
 */
export function applyEvidence(L, omega) {
  if (typeof L !== 'number' || !Number.isFinite(L)) throw new TypeError('confidence: L must be a finite number');
  if (typeof omega !== 'number' || !Number.isFinite(omega)) throw new TypeError('confidence: omega must be a finite number');
  return L + omega;
}

/**
 * Full Eq. 3 update: decay the prior, then add the new evidence weight.
 * @param {{ L:number, dtSeconds:number, decayClass:string, omega:number }} p
 * @returns {{ L:number, confidence:number }} new log-odds + surfaced confidence
 */
export function update({ L, dtSeconds, decayClass, omega }) {
  const decayed = decayLogOdds(L, dtSeconds, decayClass);
  const next = applyEvidence(decayed, omega);
  return { L: next, confidence: toConfidence(next) };
}

/** σ(L) = 1/(1+e^{−L}) — bounded confidence in (0,1). */
export function toConfidence(L) {
  if (typeof L !== 'number' || !Number.isFinite(L)) throw new TypeError('confidence: L must be a finite number');
  return 1 / (1 + Math.exp(-L));
}

/** Inverse of toConfidence: log-odds from a confidence in (0,1). For seeding. */
export function fromConfidence(c) {
  if (typeof c !== 'number' || !(c > 0) || !(c < 1)) throw new TypeError('confidence: c must be in the open interval (0,1)');
  return Math.log(c / (1 - c));
}

export default { DECAY_LAMBDA, L_BASE, decayLogOdds, applyEvidence, update, toConfidence, fromConfidence };
