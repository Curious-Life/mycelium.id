/**
 * Agent ID alias resolution.
 *
 * Some agent IDs in the database are pre-monorepo legacy names that
 * we still need to recognize when filtering. The canonical example
 * is `mya-personal` — Supabase-era ID for what is now
 * `personal-agent`. ~38k historic ChatGPT/Claude/import messages
 * still carry agent_id='mya-personal' in D1.
 *
 * Without alias resolution:
 *   - Strict-equality `WHERE agent_id = 'personal-agent'` silently
 *     drops 38k rows. Mind-search visibility regression.
 *   - Each filter site reinvents the alias rule (or forgets to).
 *
 * This module is the single source of truth. Every agent_id filter
 * — SQL or post-filter — should resolve through `resolveAgentIds`
 * or build via `buildAgentIdFilter`.
 *
 * Adding a new alias: add the key to AGENT_ID_ALIASES with the full
 * list of equivalents (canonical first). Tests in
 * test/agent-id-aliases.test.js pin behavior.
 *
 * Mya is the only known alias today. The structure exists so the
 * next legacy rename (if any) doesn't bleed silent-drop bugs.
 */

/**
 * Canonical → [canonical, ...legacy] map.
 * Order matters: canonical first so SQL output is reasoned about
 * consistently.
 */
export const AGENT_ID_ALIASES = Object.freeze({
  'personal-agent': Object.freeze(['personal-agent', 'mya-personal']),
});

/**
 * Resolve an agent_id to the full list of equivalent IDs to filter
 * over. Returns null when input is null/undefined/empty (caller
 * should treat as "no filter").
 *
 * Non-aliased IDs return [id] verbatim — no surprise behavior for
 * agents that don't have legacy names (research-agent, wealth-agent,
 * etc.).
 *
 * @param {string|null|undefined} agentId
 * @returns {string[] | null}
 */
export function resolveAgentIds(agentId) {
  if (agentId === null || agentId === undefined || agentId === '') return null;
  if (typeof agentId !== 'string') {
    throw new TypeError('resolveAgentIds: agentId must be a string');
  }
  return AGENT_ID_ALIASES[agentId] ? [...AGENT_ID_ALIASES[agentId]] : [agentId];
}

/**
 * Build a SQL filter fragment + params array for an agent_id filter,
 * resolving aliases. Returns `{ sql: '', params: [] }` when input is
 * null/empty (caller appends nothing).
 *
 * Usage:
 *   const { sql, params } = buildAgentIdFilter(agentId);
 *   if (sql) {
 *     query += ` AND ${sql}`;
 *     queryParams.push(...params);
 *   }
 *
 * Or pass a custom column for joins:
 *   buildAgentIdFilter('personal-agent', 'm.agent_id')
 *   → { sql: "m.agent_id IN (?, ?)", params: ['personal-agent', 'mya-personal'] }
 *
 * @param {string|null|undefined} agentId
 * @param {string} [column='agent_id']
 * @returns {{ sql: string, params: string[] }}
 */
export function buildAgentIdFilter(agentId, column = 'agent_id') {
  const ids = resolveAgentIds(agentId);
  if (!ids) return { sql: '', params: [] };
  if (ids.length === 1) return { sql: `${column} = ?`, params: [ids[0]] };
  const placeholders = ids.map(() => '?').join(', ');
  return { sql: `${column} IN (${placeholders})`, params: ids };
}

/**
 * Predicate for in-memory post-filtering (after rows return from D1
 * or a scan-matcher). Returns true when the row's agent_id matches
 * the resolved alias set, OR when no filter is requested.
 *
 * Usage:
 *   const matches = makeAgentIdMatcher(agent);
 *   rows.filter((r) => matches(r.agent_id));
 *
 * @param {string|null|undefined} agentId
 * @returns {(rowAgentId: string|null|undefined) => boolean}
 */
export function makeAgentIdMatcher(agentId) {
  const ids = resolveAgentIds(agentId);
  if (!ids) return () => true;
  if (ids.length === 1) {
    const target = ids[0];
    return (rowAgentId) => rowAgentId === target;
  }
  const set = new Set(ids);
  return (rowAgentId) => set.has(rowAgentId);
}
