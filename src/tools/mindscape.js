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
  const { searchHelpers } = deps;
  if (!searchHelpers || typeof searchHelpers.bulkSearch !== 'function') {
    throw new TypeError('createMindscapeDomain: searchHelpers.bulkSearch required');
  }

  const tools = [
    {
      name: 'searchMindscape',
      description: 'Search across the entire mindscape: conversations, documents, territories, realms, and themes — all in one call. Returns results grouped by type.\n\nScopes:\n- "all" (default): search everything\n- "messages": past conversations only\n- "documents": documents only\n- "territories": most specific mindscape level\n- "realms": highest mindscape level\n- "themes": mid-level themes\n\nWith includeTopology: true, matched territories also show their co-firing neighbors.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for — concept, topic, question, or memory' },
          scope: {
            type: 'string',
            enum: ['all', 'messages', 'documents', 'territories', 'realms', 'themes'],
            description: 'What to search (default: all)',
          },
          limit:           { type: 'number',  description: 'Max results per type (default 5)' },
          includeTopology: { type: 'boolean', description: 'Attach co-firing neighbors for matched territories (default false)' },
          agent:           { type: 'string',  description: 'Optional: filter message results by agent ID (e.g., research-agent, company-agent). Only applies to message scope.' },
        },
        required: ['query'],
      },
    },
  ];

  const handlers = {
    searchMindscape: async (args) => {
      const result = await searchHelpers.bulkSearch({
        query: args.query,
        limit: args.limit || 5,
        agent: args.agent || null,
        scope: args.scope || 'all',
        includeTopology: !!args.includeTopology,
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

      if (sections.length === 0) return `No results for: ${args.query}`;
      return sections.join('\n\n');
    },
  };

  return { tools, handlers };
}
