// src/agent/harness.js — provider-agnostic, user-driven tool-use loop.
//
// This is the in-app chat agent. It is NOT the autonomous loop D5 defers (no
// scheduler, no lanes, no recovery): one user turn → (think · call vault tools ·
// respond) → idle. It drives WHATEVER intelligence the user selected (Anthropic
// native, or any OpenAI-compatible endpoint — OpenAI / OpenRouter / EU-ZDR /
// local Ollama via its /v1 surface), calling the SAME 52-tool handler map an
// external MCP client would use — but in-process, never over the network.
//
// ⚠️ EGRESS BOUNDARY. When the selected provider is cloud, the messages (which
// carry vault plaintext the user granted access to) are sent to that provider
// over TLS, authenticated with the user's own key. Every model call fires the
// onEgress audit sink (sha256 hash + length only — NEVER the plaintext, §1/§8).
// The §4g sensitive/jurisdiction policy is applied by the caller (portal-chat)
// when it builds the context + picks the provider; the harness speaks the wire
// protocol and audits, it does not re-decide policy.
//
// Hand-rolled over the providers' REST APIs (reusing cloud.js's openStream /
// ssePayloads), matching the no-SDK, no-echo, fail-closed discipline of the
// inference layer — so egress audit + leak-safety live in one place rather than
// fragmenting across an SDK path and a raw path.

import { createHash } from 'node:crypto';
import { openStream, ssePayloads, resolveChatUrl } from '../inference/cloud.js';
import { DEFAULT_OLLAMA_URL, DEFAULT_LOCAL_MODEL } from '../inference/local.js';
import { InferenceError } from '../inference/errors.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Chat defaults differ from the enrichment defaults in cloud.js: chat wants the
// most capable current model unless the user pinned one in Settings.
export const DEFAULT_ANTHROPIC_CHAT_MODEL = 'claude-opus-4-8';
export const DEFAULT_OPENAI_CHAT_MODEL = 'gpt-4o';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry the connection on TRANSIENT pre-token failures (network blip, provider
// 5xx). A 4xx (bad request / tools unsupported) won't change on retry, and a
// TTFB timeout would just time out again — neither is retried. Retries happen
// BEFORE any token streams, so there's nothing to un-stream. Aborts immediately
// if the turn's signal fires.
function isRetryable(err) {
  const st = err?.status;
  if (st) return st >= 500;
  if (err?.cause?.name === 'AbortError') return false; // timeout
  return true; // network-level error
}
async function openStreamRetry(args, { retries = 2, signal, logger } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new InferenceError('harness: aborted', { backend: 'cloud' });
    try { return await openStream(...args, signal); }
    catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === retries) throw err;
      logger?.(`stream connect attempt ${attempt + 1} failed (${err?.status || err?.message || 'error'}); retrying`);
      await delay(800 * (attempt + 1));
    }
  }
  throw lastErr;
}

// ── Adapters ─────────────────────────────────────────────────────────────────
// Each adapter owns: its provider tool format, its native message shape, and
// parsing one streamed completion into a uniform { text, toolCalls, stopReason,
// usage }. The loop (streamTurn) is shared.

const anthropicAdapter = {
  kind: 'anthropic',
  mapTools: (tools) => tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema || { type: 'object', properties: {} } })),
  // History is carried in the system preamble (getContext), so the turn opens
  // with a single user message — sidesteps role-alternation pitfalls.
  init: ({ userMessage }) => [{ role: 'user', content: userMessage }],
  pushAssistant(messages, text, toolCalls) {
    const content = [];
    if (text) content.push({ type: 'text', text });
    for (const tc of toolCalls) content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
    messages.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] });
  },
  toolResult: (tc, out, isError) => ({ type: 'tool_result', tool_use_id: tc.id, content: String(out), ...(isError ? { is_error: true } : {}) }),
  pushToolResults(messages, results) { messages.push({ role: 'user', content: results }); },

  async streamOnce({ cfg, system, messages, toolDefs, model, maxTokens, send, signal, fetch, timeoutMs, logger }) {
    const body = { model, max_tokens: maxTokens, system, messages, stream: true };
    if (toolDefs && toolDefs.length) { body.tools = toolDefs; body.tool_choice = { type: 'auto' }; }
    const res = await openStreamRetry([ANTHROPIC_URL, { 'x-api-key': cfg.anthropicApiKey, 'anthropic-version': ANTHROPIC_VERSION }, body, fetch, timeoutMs], { retries: 2, signal, logger });
    let text = '';
    const blocks = new Map();        // index → { type, id, name, json }
    let stopReason = null;
    const usage = { inputTokens: 0, outputTokens: 0 };
    try {
      for await (const payload of ssePayloads(res)) {
        if (signal?.aborted) break;
        let ev; try { ev = JSON.parse(payload); } catch { continue; }
        switch (ev.type) {
          case 'message_start': usage.inputTokens = ev.message?.usage?.input_tokens || 0; break;
          case 'content_block_start': {
            const cb = ev.content_block || {};
            blocks.set(ev.index, { type: cb.type, id: cb.id, name: cb.name, json: '' });
            break;
          }
          case 'content_block_delta': {
            const d = ev.delta || {};
            if (d.type === 'text_delta' && d.text) { text += d.text; send({ type: 'text_delta', content: d.text }); }
            else if (d.type === 'input_json_delta') { const b = blocks.get(ev.index); if (b) b.json += d.partial_json || ''; }
            break;
          }
          case 'message_delta': if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason; if (ev.usage?.output_tokens) usage.outputTokens = ev.usage.output_tokens; break;
          default: break;
        }
      }
    } catch (err) {
      if (!signal?.aborted) throw err;   // genuine stream error → propagate; abort (stall/disconnect) → keep partial
    }
    const toolCalls = [];
    for (const b of blocks.values()) {
      if (b.type !== 'tool_use') continue;
      let args = {}; try { args = b.json ? JSON.parse(b.json) : {}; } catch { args = {}; }
      toolCalls.push({ id: b.id, name: b.name, args });
    }
    return { text, toolCalls, stopReason, usage, isTool: stopReason === 'tool_use', aborted: !!signal?.aborted };
  },
};

const openaiAdapter = {
  kind: 'openai',
  mapTools: (tools) => tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema || { type: 'object', properties: {} } } })),
  init: ({ userMessage }) => [{ role: 'user', content: userMessage }],
  pushAssistant(messages, text, toolCalls) {
    if (toolCalls.length) {
      messages.push({ role: 'assistant', content: text || null, tool_calls: toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args) } })) });
    } else {
      messages.push({ role: 'assistant', content: text });
    }
  },
  // OpenAI tool results are individual messages (not grouped under one turn).
  toolResult: (tc, out) => ({ role: 'tool', tool_call_id: tc.id, content: String(out) }),
  pushToolResults(messages, results) { for (const r of results) messages.push(r); },

  async streamOnce({ cfg, system, messages, toolDefs, model, maxTokens, send, signal, fetch, timeoutMs, logger }) {
    const body = { model, max_tokens: maxTokens, stream: true, stream_options: { include_usage: true }, messages: [{ role: 'system', content: system }, ...messages] };
    if (toolDefs && toolDefs.length) { body.tools = toolDefs; body.tool_choice = 'auto'; }
    const headers = cfg.openaiApiKey ? { Authorization: `Bearer ${cfg.openaiApiKey}` } : {};
    const res = await openStreamRetry([resolveChatUrl(cfg.baseUrl), headers, body, fetch, timeoutMs], { retries: 2, signal, logger });
    let text = '';
    let stopReason = null;
    const usage = { inputTokens: 0, outputTokens: 0 };
    const partial = new Map();       // index → { id, name, args }
    try {
      for await (const payload of ssePayloads(res)) {
        if (signal?.aborted) break;
        let ev; try { ev = JSON.parse(payload); } catch { continue; }
        if (ev.usage) { usage.inputTokens = ev.usage.prompt_tokens || usage.inputTokens; usage.outputTokens = ev.usage.completion_tokens || usage.outputTokens; }
        const choice = ev.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) stopReason = choice.finish_reason;
        const d = choice.delta || {};
        if (typeof d.content === 'string' && d.content) { text += d.content; send({ type: 'text_delta', content: d.content }); }
        for (const tc of d.tool_calls || []) {
          const slot = partial.get(tc.index) || { id: '', name: '', args: '' };
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
          partial.set(tc.index, slot);
        }
      }
    } catch (err) {
      if (!signal?.aborted) throw err;   // genuine stream error → propagate; abort → keep partial
    }
    const toolCalls = [];
    for (const slot of partial.values()) {
      let args = {}; try { args = slot.args ? JSON.parse(slot.args) : {}; } catch { args = {}; }
      toolCalls.push({ id: slot.id, name: slot.name, args });
    }
    return { text, toolCalls, stopReason, usage, isTool: stopReason === 'tool_calls', aborted: !!signal?.aborted };
  },
};

// ── Provider normalization ───────────────────────────────────────────────────
// resolveInferenceConfig returns {anthropicApiKey?, openaiApiKey?, baseUrl?,
// cloudModel?, jurisdiction?}. An empty object = no provider configured → the
// guaranteed floor: on-box Ollama over its OpenAI-compatible /v1 surface.
function normalizeProvider(cfg = {}) {
  if (cfg.anthropicApiKey) {
    return { adapter: anthropicAdapter, cfg, model: cfg.cloudModel || DEFAULT_ANTHROPIC_CHAT_MODEL, jurisdiction: cfg.jurisdiction || 'us-standard' };
  }
  if (cfg.openaiApiKey || cfg.baseUrl) {
    return { adapter: openaiAdapter, cfg, model: cfg.cloudModel || DEFAULT_OPENAI_CHAT_MODEL, jurisdiction: cfg.jurisdiction || 'us-standard' };
  }
  // Local floor: Ollama's OpenAI-compatible endpoint. Tool-calling depends on the
  // model; if it rejects tools, streamTurn retries text-only (the relay floor).
  return { adapter: openaiAdapter, cfg: { baseUrl: `${DEFAULT_OLLAMA_URL}/v1` }, model: cfg.cloudModel || DEFAULT_LOCAL_MODEL, jurisdiction: 'local', local: true };
}

/**
 * Create the agent harness.
 * @param {object} opts
 * @param {(e:object)=>void} [opts.onEgress]  audit sink (createEgressAuditSink) — hash+len only
 * @param {typeof fetch} [opts.fetch]
 * @param {number} [opts.timeoutMs]           per-call connection (TTFB) timeout
 * @param {(msg:string)=>void} [opts.logger]
 */
export function createAgentHarness({ onEgress, fetch = globalThis.fetch, timeoutMs = 120000, logger = () => {} } = {}) {
  /**
   * Drive ONE user turn to completion, streaming SSE-shaped events via send().
   * @param {object} a
   * @param {object} a.provider     resolveInferenceConfig() result (or {} for local)
   * @param {string} a.system       system preamble (getContext + retrieval)
   * @param {string} a.userMessage
   * @param {Array<{name,description,inputSchema}>} a.tools   granted-domain tool defs
   * @param {(name:string,args:object)=>Promise<string>} a.call   in-process handler dispatch
   * @param {(ev:object)=>void} a.send         emits {type,...} events to the SSE writer
   * @param {AbortSignal} [a.signal]
   * @param {number} [a.maxIterations=8]
   * @param {number} [a.maxTokens=4096]
   * @returns {Promise<{toolsUsed:string[], capped?:boolean}>}
   */
  async function streamTurn({ provider, system, userMessage, tools = [], call, send, signal, maxIterations = 8, maxTokens = 4096 }) {
    const { adapter, cfg, model, jurisdiction, local } = normalizeProvider(provider);
    const messages = adapter.init({ userMessage });
    let toolDefs = adapter.mapTools(tools);
    const toolsUsed = [];

    const audit = (decision = 'allowed', reason) => {
      try {
        const blob = JSON.stringify(messages);
        onEgress?.({ provider: adapter.kind, model, jurisdiction, decision, reason: reason || null, contentHash: sha256(blob), contentLength: blob.length });
      } catch { /* audit must never break the turn */ }
    };

    const once = (defs, first) => adapter.streamOnce({ cfg, system, messages, toolDefs: defs, model, maxTokens, send, signal, fetch, timeoutMs, logger }).catch((err) => {
      // No-tool model (common with small local models): retry the very first call
      // without tools → degrade to a plain context-grounded answer (the relay floor).
      if (first && defs && defs.length) { logger(`harness: provider rejected tools (${err?.status || '?'}); falling back to text-only`); toolDefs = []; return null; }
      throw err;
    });

    for (let i = 0; i < maxIterations; i++) {
      if (signal?.aborted) return { toolsUsed, aborted: true };
      audit();
      let r = await once(toolDefs, i === 0);
      if (r === null) r = await once([], false);   // tool-fallback retry, no tools
      if (r.aborted) return { toolsUsed, aborted: true };   // stall/disconnect — partial text already streamed
      adapter.pushAssistant(messages, r.text, r.toolCalls);
      if (!r.isTool || !r.toolCalls.length) { if (r.usage) send({ type: 'usage', inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens }); return { toolsUsed, local: !!local }; }

      const results = [];
      for (const tc of r.toolCalls) {
        if (signal?.aborted) return { toolsUsed, aborted: true };
        send({ type: 'tool_start', name: tc.name }); toolsUsed.push(tc.name);
        let out, isErr = false;
        try { out = await call(tc.name, tc.args); }
        catch { out = 'tool execution failed'; isErr = true; }   // never surface err.message (§1)
        send({ type: isErr ? 'tool_error' : 'tool_complete', name: tc.name });
        results.push(adapter.toolResult(tc, out, isErr));
      }
      adapter.pushToolResults(messages, results);
    }

    // maxIterations exhausted — one final no-tools pass so the user gets an answer,
    // not a silent stop. Logged (no silent caps).
    logger(`harness: hit maxIterations=${maxIterations}; final answer pass without tools`);
    audit();
    const fin = await adapter.streamOnce({ cfg, system, messages, toolDefs: null, model, maxTokens, send, signal, fetch, timeoutMs, logger });
    if (fin.usage) send({ type: 'usage', inputTokens: fin.usage.inputTokens, outputTokens: fin.usage.outputTokens });
    return { toolsUsed, capped: true };
  }

  return { streamTurn };
}

export default createAgentHarness;
