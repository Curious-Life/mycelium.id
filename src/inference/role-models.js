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
//     modest local box, so recommend an EU-sovereign zero-retention CLOUD. `narrate` is
//     §4g-SENSITIVE (src/inference/sensitivity.js SENSITIVE_TASKS), so the recommendation
//     MUST be EU-ZDR only: a US pick is refused and falls back to EU/on-box — never
//     recommend one (fail-closed).
//
//     ⚠️ THIS WAS FALSE UNTIL 2026-07-16 AND IT MATTERED. It read "narrate runs
//     `sensitive:true`, so the §4g gate denies sensitive→US, so a US pick would be silently
//     downgraded to local". `sensitive` was a per-CALL flag, and the two callers that passed
//     it were claims/discovery + claims/validator — NOT the code that narrates the mindscape.
//     pipeline/lib/narrate-infer.js called router.infer({task:'narrate'}) with no flag
//     (defaulting FALSE), and agent/run-turn.js hard-coded `{sensitive:false}` — so a US model
//     picked for narrate was used, verbatim, to name the user's personal themes. The guarantee
//     lived in this comment and in a design doc; it did not exist in code, and the Intelligence
//     screen was about to print it on the user's screen. `sensitive` is now DERIVED FROM THE
//     TASK (src/inference/sensitivity.js), so any caller that OMITS the flag is correct — an
//     EXPLICIT `sensitive` argument still overrides it, so a new wrapper around router.infer
//     must default it from the task too, or the hole reopens (inference/cascade.js did exactly
//     that; fixed 2026-07-16). This sentence is true of the DEFAULT, not of every caller.
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

// ── The FUNCTION taxonomy — the Intelligence screen, organized by what the user WANTS DONE ──
// (design §3.11, "organized by FUNCTION not by provider"). This is the ordered list the ONE
// IntelligenceScreen component renders — hosted by BOTH Settings → Intelligence and the
// onboarding Intelligence step, so a recommendation can never reach one surface and not the
// other (map §5.2 found THREE diverging implementations).
//
// The six INFERENCE_TASKS (chat, narrate, harness, reflection, categorize, enrich) map onto
// three inference functions; transcription and voice are separate model KINDS (not inference
// tasks — whisper / TTS), included so the screen is ONE coherent function list.
//
// ⚠️ UNDERSTANDING = {categorize, enrich}, ONE approval for both (operator decision 2026-07-16).
// They are the two on-box message-analysis tasks, and a screen that split them let a vault
// approve labeling and leave `enrich` (L2 entities + gist) SILENTLY DEAD with no surface
// reporting it — the exact dormancy class this round exists to end (M's re-review). One card,
// one model, both tasks: the picker writes categorize AND enrich together.
//
// `jurisdiction` is the honest limit each function carries:
//   'any'         — cloud or local, user's call (Conversation).
//   'on-device'   — always local; not a cloud choice (Understanding, Transcription).
//   'eu-or-local' — §4g HARD LIMIT: narrate is sensitivity.js-sensitive, US is REFUSED at the
//                   router, so US models are NOT OFFERED (offering a choice the system overrides
//                   is a silent lie — §3.11d). This is the one place "full flexibility" yields.
export const INTELLIGENCE_FUNCTIONS = Object.freeze([
  Object.freeze({
    key: 'conversation', label: 'Conversation', sub: 'your agent’s voice',
    tasks: Object.freeze(['chat', 'harness', 'reflection']), // one voice drives chat, channels + reflection
    kind: 'provider', jurisdiction: 'any',
    recommend: 'claude_subscription',
    why: 'Your Claude subscription — the fullest reasoning, on your own account.',
  }),
  Object.freeze({
    key: 'understanding', label: 'Understanding your messages', sub: 'labels + entities',
    tasks: Object.freeze(['categorize', 'enrich']),          // ONE approval sets BOTH (see above)
    kind: 'local', jurisdiction: 'on-device',
    recommend: ROLE_RECOMMENDATIONS.labeling.model,
    why: ROLE_RECOMMENDATIONS.labeling.why,
  }),
  Object.freeze({
    key: 'descriptions', label: 'Descriptions', sub: 'mindscape names + chronicles',
    tasks: Object.freeze(['narrate']),
    kind: 'cloud-eu-zdr', jurisdiction: 'eu-or-local',       // §4g: US refused (sensitivity.js) ⇒ never offered
    recommend: ROLE_RECOMMENDATIONS.descriptions.presetId,
    why: ROLE_RECOMMENDATIONS.descriptions.why,
  }),
  Object.freeze({
    // ⚠️ NOT A CHOICE, and the screen must never render it as one (§3.10d-c). The embedder
    // ships INSIDE the app (bundled ONNX Nomic v1.5, HF_HUB_OFFLINE) — it cannot be declined,
    // cannot be downloaded, and has no rail at all. It is here because §3.11b lists Search as a
    // function ROW: omitting it would force the component to hardcode a sixth row, which is the
    // precise drift this spine exists to prevent (independent review, 2026-07-16).
    // `kind: 'bundled'` is the discriminator the screen switches on to render "Included — runs
    // on your device" instead of a picker. Presenting a non-choice as consent is the same
    // dishonesty §3.10 exists to remove.
    key: 'search', label: 'Search', sub: 'semantic recall',
    tasks: Object.freeze([]),                                // embedding is not an INFERENCE_TASK
    kind: 'bundled', jurisdiction: 'on-device',
    recommend: 'nomic-v1.5',
    why: 'Included with the app — it runs on your device and needs no setup.',
  }),
  Object.freeze({
    key: 'transcription', label: 'Transcription', sub: 'audio → text',
    tasks: Object.freeze([]),                                // whisper — a model kind, not an inference task
    kind: 'whisper', jurisdiction: 'on-device',
    recommend: 'by-ram',                                     // large-v3-turbo / small, chosen by RAM (portal-transcription)
    why: 'Whisper runs on your device — larger models transcribe better where RAM allows.',
  }),
  Object.freeze({
    key: 'voice', label: 'Voice', sub: 'speaking',
    tasks: Object.freeze([]),                                // TTS — a model kind, not an inference task
    kind: 'tts', jurisdiction: 'on-device-or-cloud',
    recommend: null,                                         // ⚠️ the HONEST row: no model has won an eval (D16 pending)
    why: 'No voice model has won a listening test yet — pick by ear.',
  }),
]);

// Object.create(null): a bare {} accumulator inherits Object.prototype, so functionForTask
// ('constructor') returned the Object constructor and ('toString') a function — not null, which
// is what the JSDoc below promises. No INFERENCE_TASK collides today, so this is hygiene rather
// than a live bug (independent review, 2026-07-16) — but the contract should be true as written.
const TASK_TO_FUNCTION = Object.freeze(
  INTELLIGENCE_FUNCTIONS.reduce((m, f) => { for (const t of f.tasks) m[t] = f.key; return m; }, Object.create(null)),
);

/** The function key an INFERENCE_TASK belongs to (or null for a task with no function — which
 *  the verify pin forbids, so this returning null in production is a bug, not a state). */
export const functionForTask = (task) => TASK_TO_FUNCTION[task] || null;

/** The tasks a function writes when the user approves its model (Understanding writes two). */
export const tasksForFunction = (key) => INTELLIGENCE_FUNCTIONS.find((f) => f.key === key)?.tasks || [];
