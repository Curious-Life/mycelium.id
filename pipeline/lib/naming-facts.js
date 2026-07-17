// pipeline/lib/naming-facts.js — the SHARED facts of the naming pipeline: its placeholder
// predicate and its per-unit token bound. ONE importable module used by the pipeline
// (describe-clusters.js) AND the portal route (GET /portal/mycelium/naming-status), so the
// two-predicate drift INTELLIGENCE-SCREEN-REDESIGN II.2a names is killed at the source:
// before this file, the portal client held one predicate (realm-only,
// MindscapeDetail.svelte) and the pipeline another (widened to `Territory N`) — two
// predicates for one fact, and the card would say "all named" while the job still found
// work. The portal client's copy is now DISPLAY-ONLY fallback ("Area N" labels); every
// COUNT goes through this module.
//
// §1: nothing here touches message content. The predicate sees a stored name string (a
// label the vault renders anyway); the bound is arithmetic over constants.

import { TOTAL_BUDGET_CHARS } from './narrate-sample.js';
import { estimateTokens } from '../../src/inference/token-budget.js';

/**
 * A cluster carrying only a deterministic PLACEHOLDER name — "Realm 7" / "Territory 12", written
 * by the describe pipeline when narration was unavailable — has not been NAMED, only slotted.
 * describe-clusters' skip gates short-circuit on `existing?.name`, and a placeholder is a truthy
 * string, so without this a gap-fill (PRESERVE) pass would skip the very rows it exists to name,
 * and even a default pass would skip a placeholder that ever carried a matching input hash. That
 * is the naming-job trap: "a namer that skips every unnamed realm is the same silent no-op, one
 * layer down" (DISTILLATION-SURFACE-DESIGN §8 / gate D10). Treat a placeholder as unnamed so a
 * naming pass always re-narrates it, while a REAL name is still preserved. Wider than the
 * portal's display fallback (adds the "Territory N" form the pipeline also writes).
 * @param {string|null|undefined} name
 * @returns {boolean} true ⇒ this row counts as UNNAMED
 */
export function isPlaceholderName(name) {
  return !name || /^(realm|territory)\s+\d+$/i.test(String(name).trim());
}

/**
 * The naming pipeline's output cap per unit — the `maxTokens` describe-clusters.js passes to
 * narrator.infer for a name+essence reply. Lifted here so the served forecast and the pipeline
 * consume ONE constant (a client- or route-side copy is the §5.2 hardcoded-taxonomy drift one
 * layer down).
 */
export const NAME_MAX_OUT_TOKENS = 300;

/**
 * The per-unit token BOUND for one naming call (INTELLIGENCE-SCREEN-REDESIGN II.3):
 * input is capped by construction at TOTAL_BUDGET_CHARS sampled chars (narrate-sample.js),
 * output at NAME_MAX_OUT_TOKENS. Derived through the REAL estimator (estimateTokens =
 * ceil(len/4), token-budget.js) rather than a duplicated `/4` literal. It is a bound, not an
 * estimate of the middle — most units sample fewer chars — so "up to ~" is true by
 * construction. ≈ 4,300 with the defaults.
 * @returns {number}
 */
export function perUnitTokenBound() {
  return estimateTokens('x'.repeat(TOTAL_BUDGET_CHARS)) + NAME_MAX_OUT_TOKENS;
}
