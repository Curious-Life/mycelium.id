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

// Read-only tools an autonomous turn may always use — no writes, no egress.
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

// Vault-WRITE tools — also gated, also opt-in-by-name, but a STRICTER boundary: only an
// owner-trusted turn (a 1:1 DM from the vault owner — see resolve-grant.js) ever names
// these. An untrusted channel turn (any group, or any non-owner sender) never supplies
// them, so a prompt injection in untrusted content can still only read + reply. (W3.)
export const WRITE_AUTONOMOUS_TOOLS = new Set([
  'remember', 'link', 'mark', 'saveDocument', 'updateDocument', 'captureMessage',
  'editMindFile', 'writeMindFileWhole', 'updateInternalModel', 'createTask', 'flagForDiscussion',
]);

/**
 * Build the granted tool defs for an autonomous turn.
 * @param {Array<{name:string}>} registryTools  the live MCP tool registry
 * @param {string[]} [enabledNames]   gated tools this task/channel opted into
 * @returns {Array} the subset the turn may use (read-safe ∪ explicitly-enabled gated/write)
 */
export function autonomyTools(registryTools, enabledNames = []) {
  const enabled = new Set(Array.isArray(enabledNames) ? enabledNames : []);
  const out = [];
  for (const t of registryTools || []) {
    if (SAFE_AUTONOMOUS_TOOLS.has(t.name)) out.push(t);                       // always read-safe
    else if ((AUTONOMY_TOOLS.has(t.name) || WRITE_AUTONOMOUS_TOOLS.has(t.name)) && enabled.has(t.name)) out.push(t);  // gated/write, opt-in only
    // else: never granted (fail-closed)
  }
  return out;
}

export default autonomyTools;
