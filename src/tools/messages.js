/**
 * Messages domain — single tool: getDailyMessages.
 *
 * `getDailyMessages` does paginated chronological review of a single
 * UTC day's messages (30 per page). Filterable by channel prefix and
 * agent ID.
 *
 * Company-scoped agents see the full team's traffic by default but
 * have personal-agent and mya-personal messages excluded so they
 * don't leak personal context. That filter is lifted when the
 * caller explicitly passes an agent filter (because they asked for
 * that agent's view specifically).
 *
 * The `listDataSources` tool was retired in the 2026-05-08 MCP
 * refactor (zero MCP calls in 7d for personal-agent).
 *
 * @typedef {object} MessagesDeps
 * @property {object} db — needs messages.selectPaginated
 * @property {string} userId
 * @property {Record<string,string>} agentLabels — for rendering role labels
 * @property {() => boolean} isScoped — true when MEMORY_SCOPE === 'company'
 */

export function createMessagesDomain(deps) {
  if (!deps) throw new TypeError('createMessagesDomain: deps required');
  const { db, userId, agentLabels, isScoped } = deps;
  if (!db) throw new TypeError('createMessagesDomain: db required');
  if (typeof userId !== 'string') throw new TypeError('createMessagesDomain: userId required');
  if (!agentLabels || typeof agentLabels !== 'object') throw new TypeError('createMessagesDomain: agentLabels required');
  if (typeof isScoped !== 'function') throw new TypeError('createMessagesDomain: isScoped required');

  const tools = [
    {
      name: 'getDailyMessages',
      description: 'Page through messages for a specific day in chronological order. Returns 30 messages per page. Use this to systematically review what happened — who said what, on which channel, in what order. Call with increasing page numbers to read through the full day. The response includes total count and remaining pages.',
      inputSchema: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Date to review (YYYY-MM-DD). Defaults to today.' },
          page: { type: 'number', description: 'Page number (1-based). Default: 1' },
          channel: { type: 'string', description: 'Optional: filter by channel prefix (discord, telegram, portal)' },
          agent: { type: 'string', description: 'Optional: filter by agent ID (e.g., research-agent, company-agent)' },
        },
      },
    },
  ];

  const handlers = {
    getDailyMessages: async (args) => {
      const date = args.date || new Date().toISOString().split('T')[0];
      const page = Math.max(1, args.page || 1);
      const pageSize = 30;
      const offset = (page - 1) * pageSize;

      // Date range: midnight to midnight UTC.
      const since = `${date}T00:00:00.000Z`;
      const nextDay = new Date(new Date(`${date}T00:00:00Z`).getTime() + 86400000);
      const until = nextDay.toISOString();

      // Company-scoped agents see all agents except personal-agent.
      // Pass canonical id only — selectPaginated expands aliases via
      // @mycelium/core/agent-id-aliases.js, so 'mya-personal' is also
      // excluded automatically.
      const result = await db.messages.selectPaginated(userId, {
        since, until, offset, limit: pageSize,
        channel: args.channel || undefined,
        agentId: args.agent || undefined,
        excludeAgentId: (isScoped() && !args.agent) ? 'personal-agent' : undefined,
      });

      if (result.total === 0) {
        return `No messages found for ${date}.` +
          (args.channel ? ` (filtered by channel: ${args.channel})` : '') +
          (args.agent ? ` (filtered by agent: ${args.agent})` : '');
      }

      const totalPages = Math.ceil(result.total / pageSize);
      const formatted = result.messages.map(m => {
        const time = m.created_at
          ? new Date(m.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
          : '??:??';
        const src = m.source || 'unknown';
        const label = m.role === 'user' ? 'Human' : (agentLabels[m.agent_id] || m.agent_id || 'Assistant');
        return `[${time}] (${src}) ${label}: ${m.content}`;
      }).join('\n\n');

      const remaining = result.total - offset - result.messages.length;
      let header = `# Messages for ${date} — Page ${page}/${totalPages} (${result.total} total)`;
      if (args.channel) header += `\nFiltered by channel: ${args.channel}`;
      if (args.agent)   header += `\nFiltered by agent: ${args.agent}`;

      const footer = result.hasMore
        ? `\n\n--- ${remaining} more messages. Call getDailyMessages with page: ${page + 1} to continue.`
        : '\n\n--- End of messages for this day.';

      return `${header}\n\n${formatted}${footer}`;
    },

  };

  return { tools, handlers };
}
