// src/agent/autonomy-tools.js — the tool grant for AUTONOMOUS turns (Phase 5, Step 5).
// Spec §5.5/§11.
//
// Autonomous turns (scheduler wake-cycles; later, native channel turns) do NOT go
// through the chat "AI Access" domain policy (src/agent/tool-domains.js). That policy
// deliberately EXCLUDES the write/egress autonomy tools (reply / schedule_task / …) so
// interactive chat can never auto-send or self-schedule. Autonomous turns instead get
// an EXPLICIT grant assembled here:
//
//   • READ-SAFE tools — always available (no writes, no egress): the briefing, search,
//     and the read-only cognition/health/doc/claims surface.
//   • GATED autonomy tools — available ONLY when the task/channel config names them in
//     `enabledNames` AND they are present in the live registry (reply is registry-present
//     only when AGENT_URL is set). Fail-closed: anything in neither set is never granted.
//
// This keeps the chat exclusion invariant intact (these tools stay OUT of DOMAINS) while
// giving the autonomous surfaces a precise, opt-in capability set.

import { filterSelfArming } from './turn-taking.js';

// Read-only tools an autonomous turn may always use — no writes, no egress.
//
// This tier is UNCONDITIONAL: it is granted to every autonomous turn, including an UNTRUSTED
// channel turn (a group, or a non-owner sender), which also holds `reply`. So the bar for
// membership is not "does it write" alone — it is "am I willing to hand this to a prompt
// injection that has an egress path". Nothing is added here without that question answered.
export const SAFE_AUTONOMOUS_TOOLS = new Set([
  'getContext', 'searchMindscape', 'listDocuments', 'getDocument', 'listTasks',
  'getDailyMessages', 'cognitiveState', 'cognitiveHistory', 'readMindFile',
  'mindscape', 'personaClaims', 'getHealthData', 'getEntityContext',
]);

// Gated tools — granted only when a task explicitly enables them by name. These are the
// SAME names kept out of the chat DOMAINS catalog (tool-domains.js §9-13): an autonomous
// turn can schedule follow-ups and reply to a channel; interactive chat can do neither.
// describeEntity (narration write) joins them: the narration walk opts it in; chat cannot.
export const AUTONOMY_TOOLS = new Set([
  'schedule_task', 'list_my_schedules', 'cancel_task', 'reply', 'describeEntity',
]);

// Vault-WRITE tools — also gated, also opt-in-by-name. The boundary, stated as it ACTUALLY is:
// membership here is granted on NAME ALONE. Three surfaces name them, and only the first is
// owner-trusted:
//   • an owner-trusted channel turn — a 1:1 DM from the vault owner (resolve-grant.js:53-59),
//     which names a deliberately TRIMMED subset: no mind-model rewriters at all;
//   • a seeded reflection cycle — the frozen enabledTools array (cycle-prompts.js:185, :257);
//   • a fired scheduled task — scheduler.js:125-133 passes NO trust flag, so a task planted via
//     schedule_task gets whatever it named, with no human present at fire time.
// An UNTRUSTED channel turn (any group, any non-owner sender) names only `reply`, so a prompt
// injection arriving through untrusted content can still only read + reply (W3) — but an
// injection that reaches schedule_task is a different, weaker boundary. The real fix there is
// trust PROVENANCE on the task row; see the schedule-enabled-tools design §5.
//
export const WRITE_AUTONOMOUS_TOOLS = new Set([
  'remember', 'link', 'mark', 'saveDocument', 'updateDocument', 'captureMessage',
  'editMindFile', 'writeMindFileWhole', 'updateInternalModel', 'createTask', 'flagForDiscussion',
]);

// CYCLE tools — a FOURTH tier, strictly narrower than WRITE_AUTONOMOUS_TOOLS (D-076;
// the cycle-tool-grant design §4). Two independent conditions (CLAUDE.md §2):
// named in `enabledNames` AND `isCycle === true`.
//
// WHY NOT just add these to the tiers above. These five are needed by exactly ONE caller — the
// seeded reflection cycles — and by no other autonomous surface (a channel turn never names
// them, resolve-grant.js:53-59; the narration walk names two unrelated tools,
// narration-walk.js:127). The only OTHER surface that could name them is a task planted via
// `schedule_task`, which fires later with no human present (scheduler.js:125-133). Putting them
// in WRITE would hand that surface capabilities it has no legitimate use for, and an adversarial
// review found one of them is not merely a new ROUTE but a new KIND of power:
//
// ⚠️ WHAT THIS TIER DOES NOT BUY, stated so no reader over-trusts it. `isCycle` proves the ROW
// is engine-owned; it does NOT prove the row's INSTRUCTIONS are. `updateCycle` (tools/cycles.js
// :122-137) is chat-grantable (tool-domains.js:40) and rewrites a real cycle's `prompt` body
// while leaving `created_by` intact — so an injection that reaches a chat turn can change what
// the 03:00 cycle is told to do, and that turn runs `outputTarget: 'none'`, i.e. silently. The
// cycle's `enabled_tools` is NOT reachable that way (buildCyclePatch emits only prompt/schedule/
// next_run/status), so the tool SET is fixed; the INSTRUCTIONS are not. All five are already
// chat-grantable anyway (tool-domains.js:28, :41, :43), so this is unattended-execution
// amplification rather than a new capability — but it is the honest boundary, and it is why
// this tier is a containment measure, not a trust proof.
//
//   `proposeClaim` writes person_claims — and NOTHING in this product can undo that. The only
//   retraction path (claims/distill.js:108) is gated on `validate`, which mcp.js:155 never
//   supplies, and the portal exposes claims read-only (portal-claims.js:34, :54). A promoted
//   claim renders as an evidence-grounded, confidence-scored TENDENCY in EVERY later turn's
//   preamble (tools/context.js:275-298). Promotion needs only `distinctDays`, which is derived
//   from caller-supplied `day_card_dates` that are never checked against real reflection_records
//   (claims-distill.js:139-143, claims/distill.js:40) — so one call with three fabricated date
//   strings can seat a fabricated belief permanently.
//
// `isCycle` comes from `created_by === 'reflection-cycle'` (cycle-prompts.js:302), which is
// UNFORGEABLE by the model: `schedule_task` hardcodes `createdBy: 'agent'`
// (tools/schedule-tasks.js:84) and `created_by` is excluded from TASK_PATCH, so it cannot be
// patched after the fact (db/harness.js:33). Every non-scheduler caller of runAgentTurn passes
// nothing ⇒ false ⇒ fail-closed on the parameter's default value.
//
// Per-tool, for the record (full rationale + threat model in the design doc §4-5):
//   • recordReflection  — one INSERT of a fresh row (db/reflections.js:32-33). The cycles' whole
//     output path; inert before this change.
//   • listReflections   — pure SELECT. Deliberately NOT in SAFE despite being read-only: SAFE is
//     unconditional, and unlike getContext's hard `limit: 5` on day cards (context.js:305) this
//     tool takes the model's own limit up to 2000 (db/reflections.js:47, :57) — a whole-history
//     pull for an injected untrusted turn holding `reply`.
//   • snapshotMindFile  — additive-only backup; destination hardcoded to
//     snapshots/<file>/<date>.md, first-write-wins, `/` rejected (internal.js:224,
//     mindfiles/snapshot.js:14-26).
//   • removeFromMind    — a STRICT SUBSET of writeMindFileWhole (same filename space; any
//     elision is expressible as a whole-file write — internal.js:294-316 vs :318-335). NOT the
//     destructive tier: that is for `forget` (vault rows + embeddings, no snapshot, irreversible).
//   • proposeClaim      — see above. This tier exists mostly because of this one.
export const CYCLE_AUTONOMOUS_TOOLS = new Set([
  'recordReflection', 'listReflections', 'snapshotMindFile', 'removeFromMind', 'proposeClaim',
]);

// DESTRUCTIVE vault tools — a THIRD, strictly narrower tier than WRITE_AUTONOMOUS_TOOLS
// (D-040 ↻1; the forget-reachability design).
//
// WHY A SEPARATE SET. `WRITE_AUTONOMOUS_TOOLS` means "opt-in by name, from anywhere", and
// `schedule_task` accepts an ARBITRARY enabled_tools array from the model with no allowlist
// (src/tools/schedule-tasks.js:73-77 → src/agent/scheduler.js:130). So had `forget` joined
// that set, a fired scheduled task — no human present — could destroy vault data, and an
// injection inside content the owner forwarded could plant that task today to fire tomorrow.
//
// These names therefore need INDEPENDENT conditions (CLAUDE.md §2): named in `enabledNames`
// AND `ownerTrusted === true`. `ownerTrusted` is only ever passed by the channel-turn path,
// where it is already the token-gated value (agent/channel-turn.js = isOwnerTrustedTurn(...)
// && channelTurnTokenValid(...)). Every other caller of runAgentTurn passes nothing ⇒ false
// ⇒ naming `forget` cannot reach it. Fail-closed by default, on the parameter's default.
//
// COMPOSITION WITH D-063 TURN-TAKING (#381), reconciled deliberately rather than merged:
// `humanTriggered` and `ownerTrusted` are two different questions about the same turn —
// "did a human start it" vs "is that human the vault owner, proven by the daemon token" —
// and they are enforced in the same function. They compose cleanly (filterSelfArming only
// strips SELF_ARMING_TOOLS = {schedule_task}, so it never voids this tier), and they AGREE
// on every path that must be denied: the scheduler, reflection cycles and the narration
// walk pass neither flag, so both mechanisms independently refuse.
//
// Where they DIFFER, the stricter one wins (fail-closed). `humanTriggered` is broader than
// `ownerTrusted` — channel-turn sets it true for EVERY inbound channel message, including a
// stranger's DM and a group, because an inbound message really is a human's. That breadth is
// right for schedule_task and wrong for an irreversible delete. So the destructive tier
// requires BOTH: an owner-proved turn that a human actually started. Requiring
// `humanTriggered` here is redundant TODAY (the one caller that passes ownerTrusted also
// passes humanTriggered), and it is kept precisely so it stops being redundant safely — a
// future non-human owner-trusted surface must not silently inherit the power to destroy
// data. This is the D-063 invariant applied to the most destructive tool in the registry.
export const OWNER_DESTRUCTIVE_TOOLS = new Set(['forget']);

/**
 * Build the granted tool defs for an autonomous turn.
 *
 * TURN-TAKING (D-063): the SELF-ARMING tools (`schedule_task`) are stripped unless this
 * turn was started by a human. An agent turn that no human started must not be able to arm
 * the agent's NEXT turn — that is the self-triggering loop, and `schedule_task` delivers to
 * 'chat' by default and may re-grant itself, so the chain is otherwise unbounded. This is
 * layer 1 (grant time); the scheduler also wires selfArmingDenyGuard at runtime.
 * FAIL-CLOSED: `humanTriggered` must be explicitly true (see filterSelfArming).
 *
 * @param {Array<{name:string}>} registryTools  the live MCP tool registry
 * @param {string[]} [enabledNames]   gated tools this task/channel opted into
 * @param {{humanTriggered?:boolean, isCycle?:boolean, ownerTrusted?:boolean}} [ctx]
 *   humanTriggered — an inbound human message started this turn (D-063, above).
 *   isCycle        — this turn is an engine-owned reflection cycle (created_by ===
 *     'reflection-cycle', which the model cannot forge) — the ONLY condition under which
 *     CYCLE_AUTONOMOUS_TOOLS become grantable (D-076).
 *   ownerTrusted   — this turn is a token-proved owner-authored 1:1 turn — required, together
 *     with humanTriggered, for OWNER_DESTRUCTIVE_TOOLS (D-040 ↻1).
 *
 *   All three default false (fail-closed) and all three are INDEPENDENT NARROWING conditions:
 *   none of them relaxes another, and the tiers they gate are disjoint. A cycle is never
 *   humanTriggered, so it still cannot self-arm; a cycle is never ownerTrusted, so it can
 *   never `forget`; an owner DM is never a cycle, so it never gets the cycle tools.
 * @returns {Array} the subset the turn may use (read-safe ∪ explicitly-enabled gated/write
 *   ∪ explicitly-enabled cycle tools when this is a cycle ∪ explicitly-enabled destructive
 *   when owner-trusted AND human-triggered)
 */
export function autonomyTools(registryTools, enabledNames = [], { humanTriggered = false, isCycle = false, ownerTrusted = false } = {}) {
  const enabled = new Set(filterSelfArming(enabledNames, { humanTriggered }));
  const out = [];
  for (const t of registryTools || []) {
    if (SAFE_AUTONOMOUS_TOOLS.has(t.name)) out.push(t);                       // always read-safe
    else if (CYCLE_AUTONOMOUS_TOOLS.has(t.name)) {
      // Cycle tools: opt-in AND a real cycle. `=== true` so a truthy-but-not-boolean value
      // (a JSON-parsed string, an object) can never widen the grant.
      if (enabled.has(t.name) && isCycle === true) out.push(t);
    } else if (OWNER_DESTRUCTIVE_TOOLS.has(t.name)) {
      // Destructive: opt-in AND owner-trusted AND human-triggered. `=== true` on both so a
      // truthy-but-not-boolean value can never widen it. Disjoint from the cycle tier above —
      // a reflection cycle can never reach this branch, and an owner DM can never reach that
      // one, so the two narrowing flags never have to be reconciled against each other.
      if (enabled.has(t.name) && ownerTrusted === true && humanTriggered === true) out.push(t);
    } else if ((AUTONOMY_TOOLS.has(t.name) || WRITE_AUTONOMOUS_TOOLS.has(t.name)) && enabled.has(t.name)) out.push(t);  // gated/write, opt-in only
    // else: never granted (fail-closed)
  }
  return out;
}

export default autonomyTools;
