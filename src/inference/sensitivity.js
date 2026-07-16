// src/inference/sensitivity.js — §4g: WHICH TASKS ARE SENSITIVE. The single source of truth.
//
// A LEAF module on purpose: router.js and run-turn.js both need this, and importing resolve.js
// (its natural home) would drag claude-oauth + claude-config-dir into the import graph of a
// module that half the app loads. Nothing here imports anything.
//
// ── THE BUG THIS EXISTS TO KILL (found 2026-07-16, designing the Intelligence screen) ──
// `sensitive` was a per-CALL boolean each caller had to remember, and the outcome was exactly
// what that predicts. role-models.js asserted, and the Intelligence screen was about to print:
//
//     "narrate runs `sensitive:true`, so the §4g gate denies sensitive→US, so a US pick would
//      be silently downgraded to local — never recommend one (fail-closed)"
//
// Only TWO call sites in the whole repo passed `sensitive: true` — claims/discovery.js and
// claims/validator.js — so the CLAIM abstractions were protected and nothing else was:
//   • pipeline/lib/narrate-infer.js — the REAL "Descriptions" worker (describe-clusters.js:
//     cluster names + chronicles) — called router.infer({ task:'narrate' }) with no flag, so
//     `sensitive` defaulted to FALSE and the §4g gate never fired. A US model chosen for
//     narrate was used, verbatim, to name the user's mindscape.
//   • src/agent/run-turn.js hard-coded `{ sensitive: false }` for EVERY task, so the agent
//     narration walk had no §4g enforcement at all.
// The guarantee existed in a comment and in a design doc. It did not exist in code.
// Operator decision (2026-07-16): make the guarantee real, then say it on screen.
//
// ── WHY A TASK, NOT A CALL SITE ──
// A task is sensitive because of WHAT IT LOOKS AT. router.infer now DEFAULTS `sensitive` from
// this set, so any caller that OMITS the flag gets it right — the failure above becomes the
// default-correct case rather than a thing reviewers must catch.
//
// ⚠️ IT IS NOT A FORCE FIELD, and an earlier version of this comment said it was ("no caller
// CAN forget it"). A caller that passes `sensitive` EXPLICITLY still overrides the default —
// inference/cascade.js did exactly that with a hardcoded `false`, so `inferWithCascade({
// task:'narrate' })` would have leaked despite this set (independent review, 2026-07-16;
// cascade.js now defaults from the task too). If you add a wrapper around router.infer,
// default its `sensitive` from the task or you have re-opened the hole.

/**
 * Tasks whose content must never egress to a US provider (§4g).
 *
 * 'narrate' — mindscape names + chronicles are a direct read of the user's personal themes;
 * it is the most revealing summary the system produces.
 *
 * Deliberately NOT here: 'chat' (the user is choosing to talk to that model), 'harness' /
 * 'reflection' (agent mechanics). A set that quietly swallowed every task would disable US
 * providers app-wide and be reverted by the next person who noticed — which would take the
 * narrate protection with it.
 */
export const SENSITIVE_TASKS = new Set(['narrate']);

/** Is this task §4g-sensitive (never egress to a US provider)? @see SENSITIVE_TASKS */
export const isSensitiveTask = (task) => SENSITIVE_TASKS.has(task);

export default isSensitiveTask;
