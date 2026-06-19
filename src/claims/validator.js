// src/claims/validator.js — evidence validator (PersonaTree §3.3). Given a new
// interaction event and an existing claim, judge whether the event SUPPORTS,
// CONFLICTS with, or is UNRELATED to the claim, and map that judgment to an
// evidence weight ω that feeds the log-odds confidence update (confidence.js).
//
// This is the conflict detection Mycelium lacked: the internal-model
// "contradictions" bucket was a manual notepad with nothing populating it.
//
// SECURITY (non-negotiable, CLAUDE.md §1-4): the prompt carries the most
// sensitive abstractions in the vault (values, boundaries). Every call passes
// sensitive:true → the inference router hard-blocks US-cloud egress and runs
// on-box local (verified src/inference/router.js:151-154). The router is
// INJECTED so this module is unit-testable without a live model.
//
// See docs/PERSONA-CLAIMS-DESIGN-2026-06-06.md §3.4.

// Ordered evidence categories → ω (log-odds evidence weight). Symmetric around 0.
export const RELATION_OMEGA = Object.freeze({
  strong_support: 1.0,
  weak_support: 0.4,
  unrelated: 0.0,
  weak_conflict: -0.4,
  strong_conflict: -1.0,
});
const RELATIONS = Object.keys(RELATION_OMEGA);

function buildPrompt(evidenceText, claim) {
  return [
    'You are a behavioral-logic validator. Decide how a NEW observation relates to a KNOWN claim about a person.',
    '',
    `KNOWN CLAIM (${claim.claimType || 'unknown type'}): ${claim.content}`,
    `NEW OBSERVATION: ${evidenceText}`,
    '',
    'Reply with ONLY a JSON object, no prose:',
    '{"relation": one of ["strong_support","weak_support","unrelated","weak_conflict","strong_conflict"], "rationale": "<= 15 words"}',
    'Use "unrelated" when the observation neither supports nor contradicts the claim.',
  ].join('\n');
}

/** Extract the first JSON object from model text; null if none parses. */
function parseJudgment(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/**
 * @param {{ infer: (req:object)=>Promise<string> }} deps  the inference router
 * @returns {{ validate: (evidenceText:string, claim:object)=>Promise<{relation:string, omega:number, rationale:string}> }}
 */
export function createValidator({ infer } = {}) {
  if (typeof infer !== 'function') throw new TypeError('createValidator: infer required');

  async function validate(evidenceText, claim) {
    if (!evidenceText || !claim?.content) {
      // Nothing to judge against → no-op evidence (fail-safe: never invents an update).
      return { relation: 'unrelated', omega: 0, rationale: 'insufficient input' };
    }
    let text;
    try {
      text = await infer({
        prompt: buildPrompt(evidenceText, claim),
        task: 'classify',
        sensitive: true, // §4g: NEVER egress these abstractions to US cloud
        maxTokens: 80,
      });
    } catch {
      // Model unavailable / errored → fail-safe to no-op (Tier-3 fail-open).
      return { relation: 'unrelated', omega: 0, rationale: 'validator unavailable' };
    }
    const j = parseJudgment(text);
    const relation = j && RELATIONS.includes(j.relation) ? j.relation : 'unrelated';
    return {
      relation,
      omega: RELATION_OMEGA[relation],
      rationale: (j && typeof j.rationale === 'string' ? j.rationale : '').slice(0, 120),
    };
  }

  return { validate };
}

export default createValidator;
