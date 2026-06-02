/**
 * Mindscape unified search.
 *
 *   - searchMindscape: bulk recall across 5 layers (messages,
 *     documents, territories, realms, themes). One HTTP round-trip
 *     to the agent-server's `/internal/v1/search/mindscape`. Optional
 *     topology expansion for matched territories — populated by the
 *     server inline so this domain doesn't make follow-up calls.
 *
 * The `exploreMindscape` tool was retired in the 2026-05-08 MCP
 * refactor (zero MCP calls in 7d for personal-agent). Operators can
 * still kick off territory exploration via scripts/describe-chronicles.js
 * directly on the VPS.
 *
 * Why no `generateEmbedding` dep anymore: the server owns embedding
 * (single owner of the task=query prefix and of the embed-service
 * connection). MCP-side tools used to call `generateEmbedding(query)`
 * before each helper, which both duplicated the prefix decision and,
 * when the MCP-process mind-search registry was empty, fell through
 * to a Vectorize path that's been broken since the BGE shutdown.
 *
 * @typedef {object} MindscapeDeps
 * @property {{ bulkSearch: (args: object) => Promise<object>, isScoped: () => boolean }} searchHelpers
 */

export function createMindscapeDomain(deps) {
  if (!deps) throw new TypeError('createMindscapeDomain: deps required');
  const { searchHelpers, db = null, userId = 'local-user' } = deps;
  if (!searchHelpers || typeof searchHelpers.bulkSearch !== 'function') {
    throw new TypeError('createMindscapeDomain: searchHelpers.bulkSearch required');
  }

  const tools = [
    {
      name: 'searchMindscape',
      description: 'Search across the entire mindscape: conversations, documents, territories, realms, themes — and your remembered facts — all in one call. Returns results grouped by type.\n\nTwo ways to recall:\n- query: a concept, topic, question, or memory you craft.\n- relatedTo: paste the current message/turn to proactively pull what is related to it (no query craft needed). Proactive recall excludes anything you marked sensitive.\n\nScopes:\n- "all" (default): search everything\n- "messages": past conversations only\n- "facts": list your remembered facts (optionally pass query as a category filter)\n- "documents" / "territories" / "realms" / "themes": that layer only\n\nWith includeTopology: true, matched territories also show their co-firing neighbors.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for — concept, topic, question, or memory. (For scope:"facts", an optional category filter.)' },
          relatedTo: { type: 'string', description: 'Proactive recall: paste the current message/turn to pull related memories. Excludes sensitive items.' },
          scope: {
            type: 'string',
            enum: ['all', 'messages', 'facts', 'documents', 'territories', 'realms', 'themes'],
            description: 'What to search (default: all)',
          },
          limit:           { type: 'number',  description: 'Max results per type (default 5)' },
          includeTopology: { type: 'boolean', description: 'Attach co-firing neighbors for matched territories (default false)' },
          agent:           { type: 'string',  description: 'Optional: filter message results by agent ID (e.g., research-agent, company-agent). Only applies to message scope.' },
        },
      },
    },
  ];

  // scope:'facts' — list remembered facts directly (facts aren't in the ANN
  // index; this is a structured listing, not a semantic search). Includes
  // sensitive facts because this is an EXPLICIT request, not proactive recall.
  async function listFacts(args) {
    if (!db?.facts?.list) return 'Facts are not available.';
    const category = (args.query || '').trim() || null;
    const rows = await db.facts.list({ userId, category, limit: 100 });
    if (!rows.length) return category ? `No facts in category "${category}".` : 'No facts remembered yet.';
    const lines = rows
      .map((f) => `- ${f.pinned ? '📌 ' : ''}${f.sensitive ? '🔒 ' : ''}**${f.category}/${f.key}**: ${(f.value || '').slice(0, 300)}`)
      .join('\n');
    return `## Facts (${rows.length})\n${lines}`;
  }

  const handlers = {
    searchMindscape: async (args = {}) => {
      const scope = args.scope || 'all';

      // Facts listing is a distinct path (structured, not ANN search).
      if (scope === 'facts') return listFacts(args);

      // relatedTo = proactive recall: use the turn text as the query and
      // exclude sensitive items. Falls back to the crafted query otherwise.
      const proactive = typeof args.relatedTo === 'string' && args.relatedTo.trim().length > 0;
      const text = proactive ? args.relatedTo : (args.query || '');
      if (!text.trim()) return 'Provide either query or relatedTo to search.';

      const result = await searchHelpers.bulkSearch({
        query: text,
        limit: args.limit || 5,
        agent: args.agent || null,
        scope,
        includeTopology: !!args.includeTopology,
        excludeSensitive: proactive,
      });

      const sections = [];

      if (result.messages.length)  sections.push(`## Messages (${result.messages.length})\n${result.messages.join('\n\n')}`);
      if (result.documents.length) sections.push(`## Documents (${result.documents.length})\n${result.documents.join('\n')}`);

      if (result.territories.formatted.length) {
        sections.push(`## Territories (${result.territories.formatted.length})\n${result.territories.formatted.join('\n\n')}`);

        if (args.includeTopology) {
          // Topology was expanded server-side and attached to each
          // territory's `topology` field. Render the top 3 here to
          // match the legacy section format.
          const topoSections = result.territories.raw.slice(0, 3).map((t) => {
            if (!Array.isArray(t.topology) || t.topology.length === 0) return null;
            const lines = t.topology.map((n) => `- **${n.name}** (strength: ${n.weight?.toFixed?.(2) ?? n.weight})`).join('\n');
            return `### Co-firing with "${t.name}"\n${lines}`;
          }).filter(Boolean);
          if (topoSections.length) sections.push(`## Topology Context\n${topoSections.join('\n\n')}`);
        }
      }

      if (result.realms.length) sections.push(`## Realms (${result.realms.length})\n${result.realms.join('\n\n')}`);
      if (result.themes.length) sections.push(`## Themes (${result.themes.length})\n${result.themes.join('\n\n')}`);

      if (sections.length === 0) {
        return proactive ? 'No related context found.' : `No results for: ${text}`;
      }
      const header = proactive ? '# Related context\n\n' : '';
      return header + sections.join('\n\n');
    },
  };

  return { tools, handlers };
}
