// src/claims/lifecycle.js — the AGM belief-revision lifecycle for bi-temporal claims (Phase 2b).
//
// Pure functions (no I/O), so the governance is unit-testable. Maps AGM operations onto the claim
// store: ADD (expansion) · UPDATE (revision-by-corroboration) · WEAKEN/RETIRE (contraction) ·
// RETRACT (revision-by-contradiction → close+open via db.claims.retract). Confidence is the existing
// log-odds posterior (confidence.js); this module owns the THRESHOLDS and the two governance rules
// the reviewer flagged:
//   C — propose-vs-corroborate role split: confidence may move ONLY on OBSERVATION evidence
//       (day-cards/messages/user-stated). The agent restating model.md (`agent-inferred`) carries
//       ZERO weight — the prior belief must never vote for itself (anti-self-anchoring). Structural,
//       not a prompt suggestion.
//   A — the SPRT promotion bar is config-default + SCALES with decay_class (a trait/distribution claim
//       needs many states; a transient state needs few — Whole Trait Theory); the retraction floor is
//       named; `boundary` never auto-retires (λ=0, safety).
import { decayLogOdds, applyEvidence, toConfidence } from './confidence.js';

// ── A: thresholds (env-calibratable; defaults are conservative, tune fire-rate on the real vault) ──
export const promoteLogodds = () => Number(process.env.MYCELIUM_CLAIM_PROMOTE_LOGODDS) || 1.266; // ≈ σ⁻¹(0.78)
export const retireLogodds  = () => Number(process.env.MYCELIUM_CLAIM_RETIRE_LOGODDS)  || -0.847; // ≈ σ⁻¹(0.30)

// distinct corroborating DAYS required to promote episodic→stable, by decay_class (the active/stable
// axis). A bigger assertion (a trait/boundary) needs more independent states than a transient mood.
export const MIN_DISTINCT_DAYS = Object.freeze({ boundary: 5, identity: 5, fact: 3, preference: 2, mood: 2 });
const minDaysFor = (decayClass) => MIN_DISTINCT_DAYS[decayClass] ?? 3;

/**
 * AGM op for a validated proposal against the existing belief set.
 * @param {{relation:string, isNew:boolean}} p  relation from validator.js
 * @returns {'ADD'|'UPDATE'|'WEAKEN'|'RETRACT'|'NOOP'}
 */
export function decideOp({ relation, isNew }) {
  if (relation === 'strong_conflict') return 'RETRACT'; // revision: close the old, open the successor
  if (relation === 'weak_conflict') return 'WEAKEN';    // contraction: lower confidence, no successor
  if (relation === 'unrelated' && !isNew) return 'NOOP';
  if (isNew) return 'ADD';                               // expansion: born pending
  return 'UPDATE';                                       // corroboration: confidence up
}

/**
 * C — the evidence weight that actually moves confidence. The validator's ω is gated by SOURCE:
 * an `agent-inferred` restatement contributes ZERO (the belief can't corroborate itself);
 * `user-stated` outweighs an observation (source-priority). Day-card / message observations pass through.
 * @param {{omega:number, source:string}} e
 * @returns {number} the ωE applied to the log-odds update
 */
export function evidenceWeight({ omega = 0, source = 'agent-inferred' } = {}) {
  if (source === 'agent-inferred') return 0;            // anti-self-anchoring (the load-bearing rule)
  const priority = source === 'user-stated' ? 1.3 : 1.0;
  return omega * priority;
}

/** Distinct corroborating days from the support's day-card dates (the SPRT corroboration count). */
export function distinctDays(support) {
  const dates = Array.isArray(support?.day_card_dates) ? support.day_card_dates : [];
  return new Set(dates.filter(Boolean).map((d) => String(d).slice(0, 10))).size;
}

/** valid_from = the earliest observation date in support (when the trait became evidenced). */
export function validFrom(support) {
  const dates = (Array.isArray(support?.day_card_dates) ? support.day_card_dates : []).filter(Boolean).slice().sort();
  return dates[0] || null;
}

/** A — promotion bar: clears the (config) log-odds AND ≥ the decay_class-scaled distinct-day count. */
export function shouldPromote({ confidenceLogodds, decayClass, distinctDays: days }) {
  return Number(confidenceLogodds) >= promoteLogodds() && Number(days) >= minDaysFor(decayClass);
}

/** A — retraction/demotion floor; `boundary` never auto-retires (safety, λ=0). */
export function shouldRetire({ confidenceLogodds, decayClass }) {
  if (decayClass === 'boundary') return false;
  return Number(confidenceLogodds) <= retireLogodds();
}

/**
 * Full update for a corroboration/conflict: decay the prior toward neutral, then apply the
 * source-gated evidence weight (C). Returns the new log-odds + surfaced confidence.
 * @param {{ priorLogodds:number, dtSeconds:number, decayClass:string, evidence:{omega:number,source:string} }} p
 */
export function updateConfidence({ priorLogodds, dtSeconds, decayClass, evidence }) {
  const decayed = decayLogOdds(Number(priorLogodds) || 0, dtSeconds, decayClass);
  const next = applyEvidence(decayed, evidenceWeight(evidence));
  return { logodds: next, confidence: toConfidence(next) };
}

export default {
  promoteLogodds, retireLogodds, MIN_DISTINCT_DAYS,
  decideOp, evidenceWeight, distinctDays, validFrom, shouldPromote, shouldRetire, updateConfidence,
};
