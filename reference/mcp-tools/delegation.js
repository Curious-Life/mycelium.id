/**
 * Delegation + team visibility domain — two tools.
 *
 *   - delegate_to_agent: POST /delegate to this agent's local
 *     agent-server so it can relay the task to a sibling agent.
 *     Takes a 15s timeout. AGENT_INTERNAL_SECRET (if set) is attached
 *     as `x-internal-secret` so the delegate endpoint can authenticate
 *     the call. Failures are caught and returned as a readable string
 *     rather than thrown — the LLM needs a coherent result message.
 *
 *   - getTeamStatus: aggregates a dashboard across company agents
 *     (COMPANY_TEAM excludes personal-agent). For each agent it
 *     parallel-fetches the /health endpoint (3s timeout) and the
 *     latest message from D1. Missing agents render as OFFLINE.
 *
 * @typedef {object} DelegationDeps
 * @property {object} db — needs messages.selectRecent(userId, opts)
 * @property {string} userId
 * @property {string|undefined} agentUrl — local agent-server URL (e.g. http://localhost:5006)
 * @property {string|undefined} internalSecret — AGENT_INTERNAL_SECRET for /delegate auth
 * @property {Record<string, { name: string, port: number, role: string }>} companyTeam
 * @property {(url: string, init?: any) => Promise<any>} [fetch] — defaults to globalThis.fetch
 */

export function createDelegationDomain(deps) {
  if (!deps) throw new TypeError('createDelegationDomain: deps required');
  const {
    db, userId, agentUrl, internalSecret, companyTeam,
    fetch: fetchImpl = globalThis.fetch,
  } = deps;
  if (!db) throw new TypeError('createDelegationDomain: db required');
  if (typeof userId !== 'string') throw new TypeError('createDelegationDomain: userId required');
  if (!companyTeam || typeof companyTeam !== 'object') throw new TypeError('createDelegationDomain: companyTeam required');
  if (typeof fetchImpl !== 'function') throw new TypeError('createDelegationDomain: fetch required');

  const tools = [
    {
      name: 'delegate_to_agent',
      description: 'Delegate a task to another agent. Delegation is async — they work independently and report back.\n\nAgents:\n- research-agent (Ada): Deep research, analysis, web search, literature review\n- commercial-intelligence-agent (Rex): Market analysis, competitor intel, pricing, revenue\n- publishing-agent (Noa): Writing, editing, content creation, publishing\n\nWrite self-contained task descriptions. The receiving agent has NO access to your conversation — they only see what you send in task + context.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: {
            type: 'string',
            enum: ['research-agent', 'commercial-intelligence-agent', 'publishing-agent'],
            description: 'Target agent ID',
          },
          task:    { type: 'string', description: 'Specific, actionable instructions. Include: what to do, what format to return results in, and any constraints. Bad: "look into competitors". Good: "Research pricing tiers for Notion, Coda, and Obsidian team plans. Return a comparison table with monthly/annual pricing and key differentiators."' },
          context: { type: 'string', description: 'Background the agent needs to do the work. Only include what is relevant — not your full conversation.' },
          priority: { type: 'string', enum: ['low', 'normal', 'high'], description: 'Priority level. Use high only when a human is actively waiting. Default: normal.' },
        },
        required: ['agent', 'task'],
      },
    },
    {
      name: 'getTeamStatus',
      description: 'Get a consolidated status dashboard of all company agents (Ada, Rex, Noa, QA). Shows online/offline status, current model, active tasks, messages today, and last message snippet for each agent. Use this as your first step in any operations cycle to understand team state at a glance.',
      inputSchema: {
        type: 'object',
        properties: {
          includeLastMessage: { type: 'boolean', description: 'Include last message snippet for each agent (default: true)' },
        },
      },
    },
  ];

  const handlers = {
    delegate_to_agent: async (args) => {
      if (!agentUrl) {
        return 'Delegation unavailable: AGENT_URL not configured. Cannot reach local agent-server.';
      }
      try {
        const delegateHeaders = { 'Content-Type': 'application/json' };
        if (internalSecret) delegateHeaders['x-internal-secret'] = internalSecret;
        const res = await fetchImpl(`${agentUrl}/delegate`, {
          method: 'POST',
          headers: delegateHeaders,
          body: JSON.stringify({
            agent:    args.agent,
            task:     args.task,
            context:  args.context || '',
            priority: args.priority || 'normal',
          }),
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`${res.status}: ${body.slice(0, 200)}`);
        }
        const data = await res.json();
        return data.message || `Delegated to ${args.agent}.`;
      } catch (err) {
        return `Delegation failed (${args.agent}): ${err.message}. The agent may be offline.`;
      }
    },

    getTeamStatus: async (args) => {
      const includeLastMessage = args.includeLastMessage !== false;
      const agentIds = Object.keys(companyTeam);

      const [healthResults, lastMessages] = await Promise.all([
        Promise.all(agentIds.map(async (agentId) => {
          const info = companyTeam[agentId];
          try {
            const res = await fetchImpl(`http://localhost:${info.port}/health`, {
              signal: AbortSignal.timeout(3000),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return { agentId, health: await res.json(), status: 'online' };
          } catch (err) {
            return { agentId, health: null, status: 'offline', error: err.message };
          }
        })),

        includeLastMessage ? Promise.all(agentIds.map(async (agentId) => {
          try {
            const msgs = await db.messages.selectRecent(userId, { limit: 1, agentId });
            return msgs[0] ? { ...msgs[0], agent_id: agentId } : null;
          } catch { return null; }
        })) : [],
      ]);

      const lastMsgMap = new Map();
      for (const m of lastMessages) {
        if (m?.agent_id) lastMsgMap.set(m.agent_id, m);
      }

      const lines = ['# Team Status Dashboard\n'];

      for (const { agentId, health, status, error } of healthResults) {
        const info = companyTeam[agentId];
        const statusLabel = status === 'online' ? 'ONLINE' : 'OFFLINE';
        lines.push(`## ${info.name} (${agentId}) — ${statusLabel}`);
        lines.push(`- Role: ${info.role}`);

        if (status === 'online') {
          const model = health?.lastModelUsed || health?.model || '?';
          const activeTasks = health?.state?.activeTasks || 0;
          const msgCount = health?.state?.messagesToday || 0;
          lines.push(`- Model: ${model}`);
          lines.push(`- Active tasks: ${activeTasks}`);
          lines.push(`- Messages today: ${msgCount}`);
        } else {
          lines.push(`- Error: ${error || 'unreachable'}`);
        }

        const lastMsg = lastMsgMap.get(agentId);
        if (lastMsg) {
          const time = lastMsg.created_at
            ? new Date(lastMsg.created_at).toISOString().replace('T', ' ').slice(0, 19)
            : '?';
          const snippet = (lastMsg.content || '').slice(0, 150);
          const src = lastMsg.source || '?';
          lines.push(`- Last activity: ${time} (${src})`);
          lines.push(`  > ${snippet}${(lastMsg.content?.length || 0) > 150 ? '...' : ''}`);
        } else {
          lines.push(`- Last activity: no recent messages`);
        }

        lines.push('');
      }

      return lines.join('\n');
    },
  };

  return { tools, handlers };
}
