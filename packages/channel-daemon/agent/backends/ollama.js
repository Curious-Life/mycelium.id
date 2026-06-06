/**
 * Local Ollama runtime (sovereign — NO cloud egress). The config-implied local
 * locus: when no Anthropic BYOK key is set but a local model is configured, the
 * agent turn runs entirely on-box. Vault content never leaves the machine.
 *
 * The Agent SDK gives us the tool-use loop for free; here we hand-roll it over
 * Ollama's /api/chat (tools) + an MCP client to the vault's own tools. The loop
 * logic is exported pure (`runOllamaTurn`) so it's unit-testable without Ollama
 * or a running vault; `createOllamaRuntime` wires the real fetch + MCP client.
 *
 * Tool-calling reliability on local models is weaker than frontier models — this
 * is the sovereign option, not the default. The reply tool is still the only
 * egress path (the chokepoint enforces it regardless of what the model emits).
 */
import { buildReplySystemPrompt } from '../prompt.js';

const REPLY_TOOL_SUFFIX = 'reply';

function extractText(result) {
  const c = result?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : x?.text || '')).join(' ');
  return result?.text || '';
}

/**
 * Pure tool-use loop. Deps are injected so this is testable with fakes.
 * @param {object} a
 * @param {(req:{messages:any[],tools:any[]})=>Promise<{message:{content?:string,tool_calls?:any[]}}>} a.ollamaChat
 * @param {{listTools:()=>Promise<{tools:any[]}>, callTool:(c:{name:string,arguments:any})=>Promise<any>}} a.mcpClient
 * @param {string} a.systemPrompt
 * @param {string} a.userMessage
 * @param {number} [a.maxTurns]
 */
export async function runOllamaTurn({ ollamaChat, mcpClient, systemPrompt, userMessage, maxTurns = 8 }) {
  const { tools: mcpTools } = await mcpClient.listTools();
  const tools = (mcpTools || []).map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description || '', parameters: t.inputSchema || { type: 'object', properties: {} } },
  }));

  const messages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }];
  let usedReplyTool = false;
  let delivered = false;

  for (let i = 0; i < maxTurns; i++) {
    const resp = await ollamaChat({ messages, tools });
    const m = resp?.message || {};
    messages.push({ role: 'assistant', content: m.content || '', ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}) });
    const calls = m.tool_calls || [];
    if (!calls.length) break; // model is done (no more tools)

    for (const tc of calls) {
      const name = tc?.function?.name;
      if (!name) continue;
      let args = tc.function.arguments;
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
      const isReply = name.endsWith(REPLY_TOOL_SUFFIX);
      if (isReply) usedReplyTool = true;
      let resultText = '';
      try {
        const result = await mcpClient.callTool({ name, arguments: args || {} });
        resultText = extractText(result);
        if (isReply && /"delivered"\s*:\s*true/.test(resultText)) delivered = true;
      } catch (e) {
        resultText = `tool error: ${e.message}`;
      }
      messages.push({ role: 'tool', content: resultText });
    }
    if (usedReplyTool && delivered) break; // delivered — stop early
  }

  return { delivered, usedReplyTool, reason: usedReplyTool ? (delivered ? 'delivered' : 'reply-not-delivered') : 'no-reply' };
}

async function connectMcp(cfg) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const transport = new StreamableHTTPClientTransport(new URL(cfg.mcpUrl), {
    requestInit: cfg.mcpBearer ? { headers: { Authorization: `Bearer ${cfg.mcpBearer}` } } : {},
  });
  const client = new Client({ name: 'channel-daemon-ollama', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

export function createOllamaRuntime(cfg) {
  const model = cfg.ollamaModel;
  const base = (cfg.ollamaUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const fetchImpl = cfg.fetch || globalThis.fetch;

  async function ollamaChat({ messages, tools }) {
    const res = await fetchImpl(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, tools, stream: false }),
      signal: AbortSignal.timeout(cfg.ollamaTimeoutMs || 120_000),
    });
    if (!res.ok) throw new Error(`ollama /api/chat http ${res.status}`);
    return res.json();
  }

  return {
    label: `ollama(${model}, mcp:http)`,
    async runTurn({ turnCtx, userMessage }) {
      const mcpClient = await connectMcp(cfg);
      try {
        return await runOllamaTurn({
          ollamaChat, mcpClient,
          systemPrompt: buildReplySystemPrompt({ turnCtx, persona: cfg.persona }),
          userMessage, maxTurns: cfg.maxTurns || 8,
        });
      } finally {
        try { await mcpClient.close?.(); } catch { /* */ }
      }
    },
  };
}
