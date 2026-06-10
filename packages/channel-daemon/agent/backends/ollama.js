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
 * @param {(req:{messages:any[],tools:any[],tool_choice?:any})=>Promise<{message:{content?:string,tool_calls?:any[]}}>} a.ollamaChat
 * @param {{listTools:()=>Promise<{tools:any[]}>, callTool:(c:{name:string,arguments:any})=>Promise<any>}} a.mcpClient
 * @param {string} a.systemPrompt
 * @param {string} a.userMessage
 * @param {number} [a.maxTurns]
 * @param {string[]} [a.allowTools]  trim the tool surface to these names (suffix-
 *   matched so MCP prefixes like `mcp__x__name` work); the reply tool is ALWAYS
 *   kept. Local models need this: the full schema set overflows their context.
 * @param {AbortSignal} [a.signal]  lane-level whole-turn abort, threaded to chat calls
 */
export async function runOllamaTurn({ ollamaChat, mcpClient, systemPrompt, userMessage, maxTurns = 8, allowTools, signal }) {
  const { tools: mcpTools } = await mcpClient.listTools();
  const kept = (allowTools && allowTools.length)
    ? (mcpTools || []).filter((t) =>
        t.name.endsWith(REPLY_TOOL_SUFFIX)
        || allowTools.some((k) => t.name === k || t.name.endsWith(`__${k}`)))
    : (mcpTools || []);
  const tools = kept.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description || '', parameters: t.inputSchema || { type: 'object', properties: {} } },
  }));
  // The single egress tool (its MCP name may be prefixed, e.g. `mcp__…__reply`).
  const replyTool = tools.find((t) => t.function?.name?.endsWith(REPLY_TOOL_SUFFIX)) || null;

  const messages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }];
  let usedReplyTool = false;
  let delivered = false;
  let forced = false;

  // Deliver a reply tool call against the chokepoint; sets usedReplyTool/delivered.
  async function runReplyCall(tc) {
    let args = tc.function.arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    usedReplyTool = true;
    try {
      const result = await mcpClient.callTool({ name: tc.function.name, arguments: args || {} });
      if (/"delivered"\s*:\s*true/.test(extractText(result))) delivered = true;
      return extractText(result);
    } catch (e) { return `tool error: ${e.message}`; }
  }

  for (let i = 0; i < maxTurns; i++) {
    const resp = await ollamaChat({ messages, tools, signal });
    const m = resp?.message || {};
    messages.push({ role: 'assistant', content: m.content || '', ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}) });
    const calls = m.tool_calls || [];
    if (!calls.length) break; // model is done (no more tools)

    for (const tc of calls) {
      const name = tc?.function?.name;
      if (!name) continue;
      let resultText;
      if (name.endsWith(REPLY_TOOL_SUFFIX)) {
        resultText = await runReplyCall(tc);
      } else {
        let args = tc.function.arguments;
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
        try { resultText = extractText(await mcpClient.callTool({ name, arguments: args || {} })); }
        catch (e) { resultText = `tool error: ${e.message}`; }
      }
      // `tool_call_id`/`name` are required by strict OpenAI-compatible servers (the
      // openai-compat backend reuses this loop); native Ollama ignores the extras.
      messages.push({ role: 'tool', content: resultText, ...(tc.id ? { tool_call_id: tc.id } : {}), ...(name ? { name } : {}) });
    }
    if (usedReplyTool && delivered) break; // delivered — stop early
  }

  // GUARANTEED DELIVERY (weak-local-model safety net). Local models frequently end
  // a turn with free-form text instead of calling `reply` — which the chokepoint
  // never delivers (CLAUDE.md #11, by design). So if nothing was delivered, make a
  // FINAL call that FORCES the reply tool via `tool_choice` (Ollama ≥0.30 honors it;
  // older versions ignore it → no worse than before). This is NOT a model/provider
  // fallback — it's the SAME configured model, compelled to emit its answer through
  // the one egress tool. Explicit-send is preserved: the model still calls `reply`.
  if (!delivered && replyTool) {
    forced = true;
    messages.push({ role: 'user', content: 'Reply to the user now: call the reply tool with your message text. Do not output anything else.' });
    try {
      const resp = await ollamaChat({ messages, tools: [replyTool], tool_choice: { type: 'function', function: { name: replyTool.function.name } }, signal });
      for (const tc of (resp?.message?.tool_calls || [])) {
        if (tc?.function?.name?.endsWith(REPLY_TOOL_SUFFIX)) await runReplyCall(tc);
      }
    } catch { /* forced call failed (e.g. pre-0.30 Ollama) — honest reason below */ }
  }

  return {
    delivered,
    usedReplyTool,
    forced,
    reason: delivered ? (forced ? 'delivered-forced' : 'delivered') : (usedReplyTool ? 'reply-not-delivered' : 'no-reply'),
  };
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

  async function ollamaChat({ messages, tools, tool_choice, signal }) {
    const body = { model, messages, tools, stream: false };
    // Without an explicit num_ctx Ollama serves the model's default (often 4096),
    // which silently truncates the prompt → empty responses, no tool calls.
    body.options = { num_ctx: cfg.ollamaNumCtx || 8192 };
    if (tool_choice) body.tool_choice = tool_choice; // forced reply (Ollama ≥0.30)
    // 300s default: a COLD load + prompt ingest on a 7–12B exceeds 120s.
    const timeout = AbortSignal.timeout(cfg.ollamaTimeoutMs || 300_000);
    const res = await fetchImpl(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) throw new Error(`ollama /api/chat http ${res.status}`);
    return res.json();
  }

  return {
    label: `ollama(${model}, mcp:http)`,
    async runTurn({ turnCtx, userMessage, signal }) {
      const mcpClient = await connectMcp(cfg);
      try {
        return await runOllamaTurn({
          ollamaChat, mcpClient,
          systemPrompt: buildReplySystemPrompt({ turnCtx, persona: cfg.persona }),
          userMessage, maxTurns: cfg.maxTurns || 8,
          allowTools: cfg.localTools, signal,
        });
      } finally {
        try { await mcpClient.close?.(); } catch { /* */ }
      }
    },
  };
}
