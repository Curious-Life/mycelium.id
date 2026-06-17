// Canonical roster of MCP tools the single-user server registers (boot() → `tools`).
// SINGLE SOURCE OF TRUTH for the verify:* gates that assert the tool surface is intact.
//
// Why a named set instead of a bare `tools.length === N`: a magic number rots
// silently — add one tool and remove another and the count still "passes" while the
// surface has actually changed. Asserting the exact name set makes any drift FAIL
// LOUD with a missing/extra diff, and points at this one file to update deliberately.
//
// When the tool surface legitimately changes, update THIS list (and only this list)
// in the same commit as the tool's registration. The diff the gate prints tells you
// exactly which names to add or remove.
export const EXPECTED_TOOLS = [
  'cancel_task',
  'captureMessage',
  'cognitiveHistory',
  'cognitiveState',
  'createTask',
  'editMindFile',
  'flagForDiscussion',
  'forget',
  'getContext',
  'getDailyMessages',
  'getDocument',
  'getDocumentShareStatus',
  'getHealthData',
  'importMessages',
  'link',
  'listConnectionRequests',
  'listDocuments',
  'listTasks',
  'list_my_schedules',
  'mark',
  'mindscape',
  'personaClaims',
  'publishDocument',
  'readMindFile',
  'remember',
  'requestConnection',
  'respondToConnectionRequest',
  'saveDocument',
  'schedule_task',
  'searchMindscape',
  'snapshotMindFile',
  'updateDocument',
  'updateInternalModel',
  'writeMindFileWhole',
];

export const EXPECTED_TOOL_COUNT = EXPECTED_TOOLS.length;

// Compare the booted server's tool list against the canonical roster.
// Returns { ok, missing, extra, count } — missing/extra are sorted name arrays so a
// failing gate prints a precise, actionable diff rather than just "expected 34 got 35".
export function diffTools(tools) {
  const actual = new Set(tools.map((t) => t.name));
  const expected = new Set(EXPECTED_TOOLS);
  const missing = EXPECTED_TOOLS.filter((n) => !actual.has(n));
  const extra = [...actual].filter((n) => !expected.has(n)).sort();
  return { ok: missing.length === 0 && extra.length === 0, missing, extra, count: actual.size };
}

// One-line human-readable summary for a gate's PASS/FAIL detail column.
export function toolDiffDetail(tools) {
  const { ok, missing, extra, count } = diffTools(tools);
  if (ok) return `${count}/${EXPECTED_TOOL_COUNT} tools, roster intact`;
  const parts = [`${count} tools`];
  if (missing.length) parts.push(`MISSING: ${missing.join(', ')}`);
  if (extra.length) parts.push(`UNEXPECTED: ${extra.join(', ')}`);
  return parts.join(' — ');
}
