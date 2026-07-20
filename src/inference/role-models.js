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
//     modest local box, so recommend an EU-sovereign zero-retention CLOUD (Regolo). This is a
//     RECOMMENDATION, not a wall: since 2026-07-19 `narrate` is NOT §4g-sensitive, so the user
//     may assign Descriptions to ANY connected provider, including US. The badge points at EU-ZDR
//     because that keeps the most-revealing summary sovereign by default; it does not refuse a
//     US pick the user makes deliberately.
//
//     ⚠️ HISTORY (2026-07-16 → 2026-07-19). This once claimed narrate ran `sensitive:true` so a
//     US pick was refused — first FALSE (the flag was per-CALL and only claims/discovery +
//     claims/validator passed it, never the mindscape narrator), then made real by adding narrate
//     to SENSITIVE_TASKS. The operator then removed that limit (2026-07-19): Descriptions is no
//     longer confined to EU/on-device. `sensitive` is still DERIVED FROM THE TASK
//     (src/inference/sensitivity.js) — narrate now derives FALSE — and an EXPLICIT `sensitive`
//     argument still overrides it, which is why claims (sensitive:true) stay protected regardless
//     of this change.
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
    // `kind` describes the RECOMMENDED model (an EU zero-retention cloud), NOT a limit on what
    // may be assigned — narrate is no longer §4g-sensitive (2026-07-19), so any provider is
    // offerable. The badge stays EU-ZDR because it keeps mindscape narration sovereign by default.
    kind: 'cloud-eu-zdr',
    presetId: 'regolo',
    why: 'Mindscape narration is heavy for modest local boxes; EU zero-retention cloud keeps it sovereign by default (you can still choose another provider).',
  }),
  // voice (the local TTS `speak` kind) — the FIRST `voice` pick in this repo with EVIDENCE:
  // Qwen3-TTS won a LIVE listening test on the operator's own hardware (2026-07-15), replacing
  // Kokoro — which the operator judged "quite bad" and which sits BELOW OpenAI TTS-1 on the arena
  // (LOCAL-TTS-EVAL §1). Runs LOCAL via the MLX runtime (Apple Silicon) — zero egress, the point.
  // See docs/AGENT-CHARACTER-AND-VOICE-DESIGN-2026-07-15.md §0 (V1) + §2 (the evidence).
  // `model` is the recommended MLX variant; its size/RTF live in src/tts/qwen3-tts-model.js's
  // catalog, single-sourced FROM HERE so the "Recommended for voice" badge and the actual default
  // can never drift (verify:tts-voice pins them equal — the LOCAL-TTS-EVAL §6.2 requirement).
  voice: Object.freeze({
    task: 'speak',
    kind: 'local',
    model: 'Qwen3-TTS-12Hz-1.7B-Base-8bit',
    why: 'Won the live listening test (2026-07-15) on the operator’s own hardware — Apache-2.0, MLX-native, and takes a voice described in plain English.',
  }),
});

/** The curated local model recommended for on-box labeling (the `categorize` task). */
export const labelingRecommendedModel = () => ROLE_RECOMMENDATIONS.labeling.model;

/**
 * The curated local models we ACTUALLY USE / endorse — the ONLY names that earn the ★
 * "recommended" badge in the hardware recommender. Operator decision 2026-07-19: stop
 * auto-starring the warmth-ranked top-3 (it surfaced gemma et al., which we don't use and
 * judged not good). The recommender still LISTS the whole catalog to browse — it just no
 * longer claims "we recommend this" about a model we haven't validated.
 *
 * Single-sourced here so the badge can never drift from what ships. Add a model to this
 * list to endorse it. Today it is exactly the on-box labeling pick: conversation runs on
 * the cloud (Claude), so there is no endorsed local CHAT model yet.
 */
export const endorsedLocalModels = () => [ROLE_RECOMMENDATIONS.labeling.model];

/** The cloud preset id recommended for descriptions (the `narrate` task). */
export const descriptionsRecommendedPreset = () => ROLE_RECOMMENDATIONS.descriptions.presetId;

/** The curated LOCAL voice model recommended for on-box TTS (the `speak` kind) — the winner of
 *  the live listening test (2026-07-15). Single source of truth: the qwen3-tts model catalog's
 *  DEFAULT_VOICE_MODEL imports this so the "Recommended for voice" badge and the actual default
 *  can never drift (verify:tts-voice pins them equal). */
export const voiceRecommendedModel = () => ROLE_RECOMMENDATIONS.voice.model;

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
//   'any'         — cloud or local, user's call (Conversation, Descriptions).
//   'on-device'   — always local; not a cloud choice (Understanding, Transcription).
//   'eu-or-local' — §4g HARD LIMIT: the task is sensitivity.js-sensitive, US is REFUSED at the
//                   router, so US models are NOT OFFERED (offering a choice the system overrides
//                   is a silent lie — §3.11d). NO function carries this today: narrate was the
//                   last one, and the operator lifted its limit (2026-07-19). The value + the
//                   screen's offerable() filter are RETAINED as generic infrastructure — if a
//                   future task joins SENSITIVE_TASKS and its function is marked 'eu-or-local',
//                   the router refusal and the screen filter must agree (verify:intelligence-
//                   functions F4/F4b pin the biconditional in BOTH directions).
export const INTELLIGENCE_FUNCTIONS = Object.freeze([
  Object.freeze({
    key: 'conversation', label: 'Conversation', sub: 'chat, channels & reflections',
    tasks: Object.freeze(['chat', 'harness', 'reflection']), // one voice drives chat, channels + reflection
    kind: 'provider', jurisdiction: 'any',
    recommend: 'claude_subscription',
    // ⚠️ The `why` here is the ROW'S plain description (shown as the quiet subline in the
    // Functions view), decoupled 2026-07-19 from ROLE_RECOMMENDATIONS.*.why (the eval
    // rationale, still single-sourced for the recommender badge). Keep it a clear one-liner.
    why: 'The model your agent talks with, and how it runs a turn.',
  }),
  Object.freeze({
    // Renamed 'Understanding your messages' → 'Labeling' (operator, 2026-07-19): the precise
    // function name over the outcome phrasing. Still {categorize, enrich}, one approval for both.
    key: 'understanding', label: 'Labeling', sub: 'categories + entities',
    tasks: Object.freeze(['categorize', 'enrich']),          // ONE approval sets BOTH (see above)
    kind: 'local', jurisdiction: 'on-device',
    recommend: ROLE_RECOMMENDATIONS.labeling.model,
    why: 'Reads each message and tags what it’s about — on your device.',
  }),
  Object.freeze({
    // DISPLAY label renamed 'Descriptions' → 'Narration' (IM-1, operator-confirmed 2026-07-20):
    // "Descriptions" read as opaque. ⚠️ LABEL ONLY — the function key stays 'descriptions' and the
    // task stays 'narrate' (the resolver/DB rename is out of scope + risky; a data rename would
    // break every taskModels row keyed on narrate). Everything below (key, tasks, recommend) is
    // untouched.
    key: 'descriptions', label: 'Narration', sub: 'mindscape names & chronicles',
    tasks: Object.freeze(['narrate']),
    // jurisdiction 'any': narrate is NOT §4g-sensitive (2026-07-19 operator decision), so every
    // provider is offerable — like Conversation. `kind: 'cloud-eu-zdr'` names the RECOMMENDATION
    // (Regolo EU-ZDR, kept as the sovereign default), it is not a limit. F4b pins that no
    // sensitive task hides under a non-limited function, so this pairing can never silently leak.
    kind: 'cloud-eu-zdr', jurisdiction: 'any',
    recommend: ROLE_RECOMMENDATIONS.descriptions.presetId,
    why: 'Writes the descriptions of your mindscape areas.',
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
    key: 'search', label: 'Search', sub: 'finding things',
    tasks: Object.freeze([]),                                // embedding is not an INFERENCE_TASK
    kind: 'bundled', jurisdiction: 'on-device',
    recommend: 'nomic-v1.5',
    why: 'Finds things across your memory. Built in — nothing to set up.',
  }),
  Object.freeze({
    key: 'transcription', label: 'Transcription', sub: 'audio → text',
    tasks: Object.freeze([]),                                // whisper — a model kind, not an inference task
    kind: 'whisper', jurisdiction: 'on-device',
    recommend: 'by-ram',                                     // large-v3-turbo / small, chosen by RAM (portal-transcription)
    why: 'Turns voice notes and audio into text, on your device.',
  }),
  Object.freeze({
    key: 'voice', label: 'Voice', sub: 'text → speech',
    tasks: Object.freeze([]),                                // TTS — a model kind, not an inference task
    kind: 'tts', jurisdiction: 'on-device-or-cloud',
    recommend: ROLE_RECOMMENDATIONS.voice.model,             // Qwen3-TTS — WON the live listening test (2026-07-15)
    // Plain description (decoupled from ROLE_RECOMMENDATIONS.voice.why 2026-07-19 — the eval
    // rationale "won the live listening test" read as redundant in the row; still single-sourced
    // for the recommender badge / verify:tts-voice).
    why: 'The voice your agent speaks in.',
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
