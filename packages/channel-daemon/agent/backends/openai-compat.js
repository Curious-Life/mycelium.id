/**
 * OpenAI-compatible runtime (cloud BYOK or self-hosted) — the bridge that lets the
 * channel agent use WHATEVER provider the user selected in the app (the active
 * `ai_providers` row). The in-app chat already speaks the OpenAI `/v1/chat/completions`
 * protocol to every non-Anthropic provider (Regolo, OpenRouter, local llama.cpp, …);
 * this backend gives the channel daemon the same reach without a second tool-loop.
 *
 * It REUSES `runOllamaTurn` (agent/backends/ollama.js): that loop already emits and
 * parses the OpenAI tool-call shape (`{type:'function', function:{arguments}}`) and
 * threads `tool_call_id` on tool results, so the only thing that differs from the
 * Ollama backend is the HTTP call — `/v1/chat/completions` + `Authorization: Bearer`
 * + the `choices[0].message` response envelope.
 *
 * Egress discipline is unchanged: the `reply` MCP tool is still the ONLY delivery
 * path; the chokepoint enforces it regardless of what the model emits. Native Ollama
 * keeps its own backend (ollama.js) — this is for keyed/strict OpenAI servers.
 */
import { buildReplySystemPrompt } from '../prompt.js';
import { runOllamaTurn } from './ollama.js';

async function connectMcp(cfg) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const transport = new StreamableHTTPClientTransport(new URL(cfg.mcpUrl), {
    requestInit: cfg.mcpBearer ? { headers: { Authorization: `Bearer ${cfg.mcpBearer}` } } : {},
  });
  const client = new Client({ name: 'channel-daemon-openai', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

/** Normalise a provider base_url to the `/v1/chat/completions` endpoint. */
export function resolveChatCompletionsUrl(baseUrl) {
  const b = String(baseUrl || '').replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(b)) return b;          // already full
  if (/\/v\d+$/.test(b)) return `${b}/chat/completions`; // ends in /v1
  return `${b}/v1/chat/completions`;                     // bare host
}

export function createOpenAiCompatRuntime(cfg) {
  const model = cfg.openaiModel || cfg.model;
  const url = resolveChatCompletionsUrl(cfg.openaiBaseUrl);
  const apiKey = cfg.openaiApiKey || '';
  const fetchImpl = cfg.fetch || globalThis.fetch;

  // Same signature runOllamaTurn expects: ({messages,tools,tool_choice}) → {message}.
  async function openaiChat({ messages, tools, tool_choice }) {
    const body = { model, messages, tools, stream: false };
    if (tool_choice) body.tool_choice = tool_choice; // forced reply (best-effort)
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.openaiTimeoutMs || cfg.ollamaTimeoutMs || 120_000),
    });
    if (!res.ok) throw new Error(`openai-compat /chat/completions http ${res.status}`);
    const data = await res.json();
    // OpenAI envelope → the {message} shape the shared loop reads.
    return { message: data?.choices?.[0]?.message || {} };
  }

  return {
    label: `openai-compat(${model || '?'} @ ${cfg.openaiBaseUrl})`,
    async runTurn({ turnCtx, userMessage }) {
      const mcpClient = await connectMcp(cfg);
      try {
        return await runOllamaTurn({
          ollamaChat: openaiChat, mcpClient,
          systemPrompt: buildReplySystemPrompt({ turnCtx, persona: cfg.persona }),
          userMessage, maxTurns: cfg.maxTurns || 8,
        });
      } finally {
        try { await mcpClient.close?.(); } catch { /* */ }
      }
    },
  };
}
