// src/agent/tool-domains.js — the "areas" a user grants the in-app AI.
//
// The in-app chat agent (src/agent/harness.js) only ever sees the tools whose
// names fall in a GRANTED domain — this is the enforced capability boundary
// behind the "AI Access" settings panel ("full access to the areas the user
// defines"). Anything not mapped here is never exposed to the agent, even if it
// is registered in the MCP tool map — fail-closed.
//
// Deliberately EXCLUDED (not grantable in v1):
//   - reply / channel sends — the explicit-send egress chokepoint (§11); only
//     wired when AGENT_URL is set, and a portal chat reply is not a channel turn.
//   - delegate_to_agent / getTeamStatus / schedule_task / list_my_schedules /
//     create_space / seed_space / list_spaces — D5-dropped (no executor/multi-agent).
//   - drive / calendar — deferred (services subsystem not built).
// Scope-level data restriction (deny the AI `wealth` rows specifically) is a
// FOLLOW-UP: AGENT_SCOPES is process-global (env), not per-request, so per-turn
// scope restriction needs allowedScopes plumbing the harness doesn't have yet.
// The policy carries `scopes` forward-compatibly; today the domain grant is the
// enforced control, and getContext already withholds `sensitive`-flagged rows.

/** Ordered domain catalog: key → { label, description, tools[] }. */
export const DOMAINS = Object.freeze([
  { key: 'context',    label: 'Working context',  description: 'Load your current briefing (time, mind, recent activity, health).', tools: ['getContext'] },
  { key: 'search',     label: 'Search memory',    description: 'Semantic + keyword search across your messages and documents.',     tools: ['searchMindscape'] },
  { key: 'messages',   label: 'Messages',         description: 'Capture new messages, import, and read by day.',                     tools: ['captureMessage', 'importMessages', 'getDailyMessages'] },
  { key: 'memory',     label: 'Facts & relations', description: 'Remember facts/people, link them, pin or mark sensitive, forget.',  tools: ['remember', 'link', 'mark', 'forget'] },
  { key: 'documents',  label: 'Documents',        description: 'Create, read, update, list — and publish — your documents.',         tools: ['saveDocument', 'findDocuments', 'updateDocument', 'getDocument', 'listDocuments', 'getDocumentShareStatus', 'publishDocument'] },
  { key: 'mindfiles',  label: 'Mind files',       description: 'Read and edit your internal model + flag items for discussion.',     tools: ['updateInternalModel', 'flagForDiscussion', 'snapshotMindFile', 'readMindFile', 'editMindFile', 'writeMindFileWhole', 'removeFromMind'] },
  // Phase 5 (spec §3.8) consolidated the 11 cluster/Fisher/metric/topology readers
  // into these 3 tools — cognitiveState (folds getCurrentPhase + getHarmonicState +
  // getActiveMilestones), cognitiveHistory (getTrajectoryHistory + getMetricSeries +
  // getTopMovers), mindscape (mindscapeStructure + listTerritories + territoryDetail +
  // exploreTerritory + timeView). The old per-tool names are no longer registered in
  // src/mcp.js (only cognition.js's 3 tools are), so the separate 'topology' and
  // 'metrics' domains + the fisher names here were mapped-but-unregistered = inert.
  // Pruned 2026-07-19; the real topology/phase/metric read is these 3 tools.
  { key: 'cognition',  label: 'Cognitive state',  description: 'Your current phase, trajectory, milestones, metrics and topology view.', tools: ['cognitiveState', 'cognitiveHistory', 'mindscape'] },
  { key: 'health',     label: 'Body state',       description: 'Sleep, HRV, steps and other Apple Health data.',                     tools: ['getHealthData'] },
  { key: 'tasks',      label: 'Tasks',            description: 'Create and list your tasks.',                                         tools: ['createTask', 'listTasks'] },
  { key: 'cycles',     label: 'Reflection cycles', description: 'Change how your reflection cycles run — their instructions, schedule, on/off — and your relationship persona.', tools: ['listCycles', 'getCyclePrompt', 'updateCycle', 'updatePersona'] },
  { key: 'reflections', label: 'Reflection log', description: 'Record + look back on your dated reflection digests (day cards) — categorize days, trace red threads.', tools: ['recordReflection', 'listReflections'] },
  { key: 'claims',     label: 'Persona claims',   description: 'Durable person-level claims about you and their confidence.',         tools: ['personaClaims'] },
  { key: 'claims-distill', label: 'Claim distillation', description: 'Propose durable tendencies from your reflection records, and review how a belief moved over time.', tools: ['proposeClaim', 'listClaimsHistory'] },
  { key: 'federation', label: 'Connections',      description: 'Request and respond to connections with other Mycelium instances.',  tools: ['requestConnection', 'listConnectionRequests', 'respondToConnectionRequest'] },
]);

export const ALL_DOMAIN_KEYS = Object.freeze(DOMAINS.map((d) => d.key));
export const ALL_SCOPES = Object.freeze(['personal', 'org', 'wealth', 'health']);

const TOOL_TO_DOMAIN = (() => {
  const m = new Map();
  for (const d of DOMAINS) for (const t of d.tools) m.set(t, d.key);
  return m;
})();

/** Is this tool name mapped to ANY domain (i.e. grantable at all)? */
export function isGrantableTool(name) { return TOOL_TO_DOMAIN.has(name); }

/**
 * Given the live MCP tool registry ([{name,description,inputSchema}]) and the set
 * of granted domain keys, return the tool defs the harness may use. Intersection
 * is fail-closed: a registry tool with no domain mapping is never exposed; a
 * mapped tool absent from the registry is skipped.
 *
 * `grantedDomains` contract (fail-closed): an ARRAY is honored EXACTLY as given —
 * an explicit empty array `[]` is a real deny-all choice (grant zero tools), NOT a
 * fall-through to grant-all. This matches normalizePolicy, whose `domains: []` is a
 * valid deny-all. Only a truly-absent grant (`undefined`/`null` — no policy passed)
 * falls back to the broad ALL_DOMAIN_KEYS default. Note that "never configured" is
 * already resolved to the full ALL_DOMAIN_KEYS array by normalizePolicy/defaultPolicy
 * (see readPolicy in src/portal-chat.js), so a fresh user still gets the broad
 * default; only an explicit `[]` reaches here as deny-all.
 * @param {Array<{name:string,description:string,inputSchema:object}>} registryTools
 * @param {string[]|undefined|null} grantedDomains  array = honored exactly (incl. []); absent = default
 * @returns {{tools:Array, unmapped:string[]}}  unmapped = registry tools we dropped
 */
export function toolsForDomains(registryTools, grantedDomains) {
  // fail-closed: an explicit array (even []) is respected; ONLY undefined/null → default.
  const granted = new Set(Array.isArray(grantedDomains) ? grantedDomains : ALL_DOMAIN_KEYS);
  const tools = [];
  const unmapped = [];
  for (const t of registryTools || []) {
    const dom = TOOL_TO_DOMAIN.get(t.name);
    if (!dom) { unmapped.push(t.name); continue; }   // not grantable → never exposed
    if (granted.has(dom)) tools.push(t);
  }
  return { tools, unmapped };
}

/** The default policy when the user hasn't configured one: broad (own vault). */
export function defaultPolicy() {
  return { scopes: [...ALL_SCOPES], domains: [...ALL_DOMAIN_KEYS], includeSensitiveOnCloud: false };
}

/** Normalize a stored/inbound policy to known keys; fall back to broad defaults. */
export function normalizePolicy(raw) {
  const def = defaultPolicy();
  if (!raw || typeof raw !== 'object') return def;
  const scopes = Array.isArray(raw.scopes) ? raw.scopes.filter((s) => ALL_SCOPES.includes(s)) : def.scopes;
  const domains = Array.isArray(raw.domains) ? raw.domains.filter((d) => ALL_DOMAIN_KEYS.includes(d)) : def.domains;
  return {
    scopes: scopes.length ? scopes : def.scopes,
    domains,                                   // [] is a valid (deny-all) choice
    includeSensitiveOnCloud: !!raw.includeSensitiveOnCloud,
  };
}
