// src/inference/sensitivity.js — §4g: WHICH TASKS ARE SENSITIVE BY DEFAULT. The single source of truth.
//
// A LEAF module on purpose: router.js and run-turn.js both need this, and importing resolve.js
// (its natural home) would drag claude-oauth + claude-config-dir into the import graph of a
// module that half the app loads. Nothing here imports anything.
//
// ── THE MECHANISM ──
// `sensitive` is a per-request boolean the §4g gate reads: `sensitive && /^us/.test(jurisdiction)
// && !exempt` ⇒ US egress is REFUSED (router.js, resolve.js, run-turn.js). router.infer DEFAULTS
// `sensitive` from THIS set — so any caller that OMITS the flag inherits the task's default, and
// a caller that passes `sensitive` EXPLICITLY overrides it.
//
// ⚠️ IT IS NOT A FORCE FIELD. An explicit argument always wins — inference/cascade.js once
// shipped a hardcoded `false`, so `inferWithCascade({ task })` overrode the default (fixed
// 2026-07-16; cascade.js now defaults from the task too). If you add a wrapper around
// router.infer, default its `sensitive` from the task or a future sensitive task re-opens a hole.
//
// ── WHY THE SET IS EMPTY (operator decision, 2026-07-19) ──
// 'narrate' — the "Descriptions" task (mindscape names + chronicles) — used to live here, so the
// router refused a US provider for it and the Intelligence screen offered only EU/on-device. The
// operator removed that limit: Descriptions may now be assigned to ANY connected provider,
// including US. The recommendation stays EU-ZDR (Regolo, role-models.js), but it is a
// recommendation, not a wall. So no task DEFAULTS to sensitive today.
//
// ⚠️ THE §4g MACHINERY IS STILL LIVE — this set going empty did NOT disable it. The two callers
// that pass `sensitive: true` EXPLICITLY — claims/discovery.js and claims/validator.js (the
// persona/claim abstractions, the most sensitive data in the vault) — are UNAFFECTED: they never
// read this set. Their US-egress protection is intact. Removing narrate changed only the DEFAULT
// for callers that omit the flag (pipeline/lib/narrate-infer.js, agent/run-turn.js narration
// walk), which is exactly the "Descriptions may go anywhere" change the operator asked for.
//
// If a future task must never reach a US provider by default, add it here — one line, and every
// omitting caller inherits the refusal. A set that swallowed EVERY task would disable US
// providers app-wide and be reverted by the next person who noticed, so keep it minimal.

/**
 * Tasks whose content must never egress to a US provider by default (§4g). Callers that omit the
 * `sensitive` flag inherit this; callers may still pass `sensitive: true` explicitly (claims do).
 *
 * EMPTY as of 2026-07-19: 'narrate' (Descriptions) was removed by operator decision so mindscape
 * names + chronicles can be assigned to any connected provider, including US. See the header.
 */
export const SENSITIVE_TASKS = new Set([]);

/** Is this task §4g-sensitive (never egress to a US provider)? @see SENSITIVE_TASKS */
export const isSensitiveTask = (task) => SENSITIVE_TASKS.has(task);

export default isSensitiveTask;
