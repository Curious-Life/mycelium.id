// src/inference/role-models.js — curated, role-aware model recommendations.
//
// The model picker's generic recommender (src/hardware/recommend.js) ranks for a
// WARM PERSONAL COMPANION (gemma-family warmth + EQ), which structurally penalizes
// small analytical models. But two roles want the opposite of warmth, so their
// "Recommended" badge is a curated OPERATOR DECISION (eval-backed), surfaced
// independently of the companion ranking:
//
//   • labeling (the on-box `categorize` task) — wants small/fast/analytical with
//     clean JSON + 12-name register adherence. qwen3.5:4b won the live 4-model eval
//     (2026-06-21). On-box by design (bulk + privacy + cost) → a LOCAL model name.
//   • descriptions (the `narrate` task — mindscape names + chronicles) — heavy for a
//     modest local box, so recommend an EU-sovereign zero-retention CLOUD. narrate
//     runs `sensitive:true`, so the recommendation MUST be EU-ZDR only: the §4g gate
//     (src/inference/router.js) denies sensitive→US, so a US pick would be silently
//     downgraded to local — never recommend one (fail-closed).
//
// This is the SINGLE SOURCE OF TRUTH. enrich/categories.js DEFAULT_LABEL_MODEL imports
// the labeling pick from here so the badge and the actual default can never drift
// (a verify assert pins them equal).

export const ROLE_RECOMMENDATIONS = Object.freeze({
  labeling: Object.freeze({
    task: 'categorize',
    kind: 'local',
    model: 'qwen3.5:4b',
    why: 'Won the 4-model L1 eval (2026-06-21): clean 12-name register adherence, balanced domains, small + fast.',
  }),
  descriptions: Object.freeze({
    task: 'narrate',
    kind: 'cloud-eu-zdr', // EU zero-retention only — never US (sensitive task, §4g)
    presetId: 'regolo',
    why: 'Mindscape narration is heavy for modest local boxes; EU zero-retention cloud keeps sensitive content sovereign.',
  }),
});

/** The curated local model recommended for on-box labeling (the `categorize` task). */
export const labelingRecommendedModel = () => ROLE_RECOMMENDATIONS.labeling.model;

/** The cloud preset id recommended for descriptions (the `narrate` task). */
export const descriptionsRecommendedPreset = () => ROLE_RECOMMENDATIONS.descriptions.presetId;
