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
import { fireBeforeToolCall, fireAfterToolCall } from './hooks.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Chat defaults differ from the enrichment defaults in cloud.js: chat wants the
// most capable current model unless the user pinned one in Settings.
export const DEFAULT_ANTHROPIC_CHAT_MODEL = 'claude-opus-4-8';
export const DEFAULT_OPENAI_CHAT_MODEL = 'gpt-4o';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// In-turn safety (odysseus/openclaw): cap a single tool result before feeding it back
// to the model, so one huge result can't blow the context window mid-turn. High default
// (~8k tokens) → never touches a normal result; trims only pathological ones. Cross-turn
// summary-compaction (src/agent/compaction.js) handles the conversation-level case.
const TOOL_OUTPUT_MAX = Number(process.env.MYCELIUM_TOOL_OUTPUT_MAX) || 32000;
const capToolOutput = (s) => {
  const str = String(s);
  return str.length > TOOL_OUTPUT_MAX ? `${str.slice(0, TOOL_OUTPUT_MAX)}\n…[tool output truncated: ${str.length} chars]` : str;
};

// Tool-loop circuit breaker (Step 7b): `maxIterations` is the outer hard cap (odysseus
// MAX_AGENT_ROUNDS-style); TOOL_REPEAT_LIMIT trips when the model calls the SAME tool with
// the SAME args this many times — a wedged turn (e.g. searching the same query forever). On
// a trip we stop the tool loop and force the final no-tools answer pass, so the turn still
// produces an answer instead of burning the whole budget.
const MAX_ITERATIONS_DEFAULT = Number(process.env.MYCELIUM_MAX_ITERATIONS) || 8;
const TOOL_REPEAT_LIMIT = Number(process.env.MYCELIUM_TOOL_REPEAT_LIMIT) || 3;

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
    // `max_tokens` = the model hit the output cap mid-stream. Its text — and any
    // tool-call args — are cut off; truncated JSON parses to {} below, so a write
    // tool would silently no-op. Surface it so the caller refuses to treat it as
    // success (the "model said it saved but nothing was written" failure).
    return { text, toolCalls, stopReason, usage, isTool: stopReason === 'tool_use', truncated: stopReason === 'max_tokens', aborted: !!signal?.aborted };
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
        // Reasoning models (Ollama gemma3/4 + qwen3, DeepSeek-R1, etc.) stream
        // their thinking in delta.reasoning / delta.reasoning_content while
        // content stays "". Surface it as thinking_delta so (a) the UI shows
        // progress instead of a frozen "loading" and (b) the chat inactivity
        // watchdog sees activity — otherwise a thinking model looks stalled and
        // gets aborted before the real answer lands in `content`.
        const reasoning = (typeof d.reasoning === 'string' && d.reasoning) ? d.reasoning
          : (typeof d.reasoning_content === 'string' && d.reasoning_content) ? d.reasoning_content : '';
        if (reasoning) send({ type: 'thinking_delta', content: reasoning });
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
    // `length` = the output cap was hit mid-stream (OpenAI's truncation reason).
    // Same hazard as Anthropic's `max_tokens`: a cut-off tool-call argument string
    // parses to {} above → a silent no-op. Surface it (truncated) so the caller
    // can refuse rather than report success on an incomplete turn.
    return { text, toolCalls, stopReason, usage, isTool: stopReason === 'tool_calls', truncated: stopReason === 'length', aborted: !!signal?.aborted };
  },
};

const LOOPBACK_RE = /(?:\/\/)?(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])/;

// ── Native Ollama adapter (LOCAL chat) ───────────────────────────────────────
// Local chat is tool-free (portal-chat strips tools for local — slow TTFB + poor
// tool use on small models), so this is a TEXT-ONLY streaming adapter over Ollama's
// NATIVE /api/chat. The reason it isn't the OpenAI-compatible /v1 surface: /v1
// IGNORES num_ctx, so the model silently truncates a long briefing at Ollama's
// ~4096 default. /api/chat honors options.num_ctx, so streamTurn can size the
// window to hold the whole prompt + the reply. Leak-safe (no prompt/response echo).
const ollamaNativeAdapter = {
  kind: 'ollama',
  mapTools: () => [],                                   // local runs tool-free
  init: ({ userMessage }) => [{ role: 'user', content: userMessage }],
  pushAssistant(messages, text) { messages.push({ role: 'assistant', content: text || '' }); },
  toolResult: (tc, out) => ({ role: 'tool', content: String(out) }),
  pushToolResults(messages, results) { for (const r of results) messages.push(r); },

  async streamOnce({ cfg, system, messages, model, maxTokens, numCtx, send, signal, fetch, timeoutMs }) {
    const host = String(cfg.baseUrl || DEFAULT_OLLAMA_URL).replace(/\/+$/, '');
    const options = { num_predict: maxTokens };
    if (Number.isFinite(numCtx) && numCtx > 0) options.num_ctx = Math.round(numCtx);
    const body = { model, stream: true, think: false, options, messages: [{ role: 'system', content: system }, ...messages] };
    // Connection (TTFB) timeout only — a long generation must not be aborted
    // mid-flight; the turn's signal handles stall/disconnect/abort.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (signal) { if (signal.aborted) controller.abort(); else signal.addEventListener('abort', () => controller.abort(), { once: true }); }
    let res;
    try {
      res = await fetch(`${host}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      throw new InferenceError(`harness: Ollama unreachable at ${host}/api/chat`, { cause: err, backend: 'local' });
    }
    clearTimeout(timer);
    if (!res.ok) throw new InferenceError(`harness: Ollama error (status ${res.status})`, { status: res.status, backend: 'local' });
    if (!res.body) throw new InferenceError('harness: Ollama returned no stream body', { backend: 'local' });

    let text = '';
    let doneReason = null;                 // Ollama's terminal `done_reason` (e.g. 'stop' | 'length')
    const usage = { inputTokens: 0, outputTokens: 0 };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (signal?.aborted) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev; try { ev = JSON.parse(line); } catch { continue; } // skip a partial/garbled line
          const c = ev.message?.content;
          if (typeof c === 'string' && c) { text += c; send({ type: 'text_delta', content: c }); }
          // Thinking models stream reasoning here if think:false isn't honored —
          // surface it so the chat inactivity watchdog sees progress (mirror openai).
          const th = ev.message?.thinking;
          if (typeof th === 'string' && th) send({ type: 'thinking_delta', content: th });
          if (ev.done) {
            if (typeof ev.done_reason === 'string') doneReason = ev.done_reason;
            if (Number.isFinite(ev.prompt_eval_count)) usage.inputTokens = ev.prompt_eval_count;
            if (Number.isFinite(ev.eval_count)) usage.outputTokens = ev.eval_count;
          }
        }
      }
    } catch (err) {
      if (!signal?.aborted) throw err;   // genuine stream error → propagate; abort → keep partial
    }
    // `done_reason: 'length'` = Ollama hit num_predict (the output cap). Local chat
    // is tool-free so there's no broken tool-call here, but the reply is cut off —
    // surface it (truncated) so the caller flags an incomplete answer rather than a
    // clean stop. Default to 'stop' when Ollama omits the reason.
    return { text, toolCalls: [], stopReason: doneReason || 'stop', usage, isTool: false, truncated: doneReason === 'length', aborted: !!signal?.aborted };
  },
};

// ── Provider normalization ───────────────────────────────────────────────────
// resolveInferenceConfig returns {anthropicApiKey?, openaiApiKey?, baseUrl?,
// cloudModel?, jurisdiction?}. An empty object = no provider configured → the
// guaranteed floor: on-box Ollama via its NATIVE /api/chat (so num_ctx is sizable).
function normalizeProvider(cfg = {}) {
  if (cfg.anthropicApiKey) {
    return { adapter: anthropicAdapter, cfg, model: cfg.cloudModel || DEFAULT_ANTHROPIC_CHAT_MODEL, jurisdiction: cfg.jurisdiction || 'us-standard' };
  }
  const isLocal = cfg.jurisdiction === 'local' || (!!cfg.baseUrl && LOOPBACK_RE.test(cfg.baseUrl));
  // Non-local cloud over the OpenAI-compatible surface (OpenAI / OpenRouter / EU-ZDR …).
  if ((cfg.openaiApiKey || cfg.baseUrl) && !isLocal) {
    return { adapter: openaiAdapter, cfg, model: cfg.cloudModel || DEFAULT_OPENAI_CHAT_MODEL, jurisdiction: cfg.jurisdiction || 'us-standard' };
  }
  // Local Ollama — a configured local provider OR the no-provider floor. Native
  // /api/chat (baseUrl stripped of any /v1 suffix) so streamTurn can size num_ctx.
  const host = String(cfg.baseUrl || DEFAULT_OLLAMA_URL).replace(/\/v1\/?$/, '').replace(/\/+$/, '');
  return { adapter: ollamaNativeAdapter, cfg: { ...cfg, baseUrl: host }, model: cfg.cloudModel || DEFAULT_LOCAL_MODEL, jurisdiction: 'local', local: true };
}

/**
 * Describe a resolved provider config for DISPLAY (the chat "active model" chip)
 * and for the no-model preflight. Single source of truth for "what model is this
 * config", using the SAME defaults streamTurn() would pick — so the chip never
 * lies about what's actually running. Returns null when NO provider is configured
 * (empty {}), which is how chat refuses instead of silently falling back to local
 * Ollama. Carries no secrets — only the label/model name/jurisdiction.
 * @param {object} [cfg]  resolveInferenceConfig() result
 * @returns {{kind:string,label:string,model:string,jurisdiction:string,local:boolean}|null}
 */
export function describeProvider(cfg = {}) {
  if (cfg.anthropicApiKey) {
    return { kind: 'anthropic', label: 'Claude', model: cfg.cloudModel || DEFAULT_ANTHROPIC_CHAT_MODEL, jurisdiction: cfg.jurisdiction || 'us-standard', local: false };
  }
  if (cfg.openaiApiKey || cfg.baseUrl) {
    const isLocal = cfg.jurisdiction === 'local' || /(?:\/\/)?(?:127\.0\.0\.1|localhost|0\.0\.0\.0)/.test(cfg.baseUrl || '');
    // Prefer the provider row's own label (e.g. "Regolo.ai (EU…)") — only fall
    // back to a generic name when none was stored. Native OpenAI (key, no
    // base_url) is the one case that's genuinely "OpenAI".
    const isNativeOpenAI = !!cfg.openaiApiKey && !cfg.baseUrl;
    const fallbackLabel = isLocal ? 'Local model' : (isNativeOpenAI ? 'OpenAI' : 'Custom');
    return {
      kind: isLocal ? 'local' : (isNativeOpenAI ? 'openai' : 'custom'),
      label: cfg.label || fallbackLabel,
      model: cfg.cloudModel || (isLocal ? DEFAULT_LOCAL_MODEL : DEFAULT_OPENAI_CHAT_MODEL),
      jurisdiction: cfg.jurisdiction || (isLocal ? 'local' : 'us-standard'),
      local: isLocal,
    };
  }
  return null; // no provider configured → chat refuses (no silent fallback)
}

/**
 * Create the agent harness.
 * @param {object} opts
 * @param {(e:object)=>void} [opts.onEgress]  audit sink (createEgressAuditSink) — hash+len only
 * @param {typeof fetch} [opts.fetch]
 * @param {number} [opts.timeoutMs]           per-call connection (TTFB) timeout
 * @param {(msg:string)=>void} [opts.logger]
 */
export function createAgentHarness({ onEgress, onUsage, hooks, surface, fetch = globalThis.fetch, timeoutMs = 120000, logger = () => {} } = {}) {
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
   * @returns {Promise<{toolsUsed:string[], capped?:boolean, truncated?:boolean, aborted?:boolean, local?:boolean}>}
   *   `truncated:true` ⇒ the model stopped at its output cap — the (partial) text
   *   is cut off and any tool action it was emitting did NOT complete; callers must
   *   surface this rather than treat the turn as success.
   */
  async function streamTurn({ provider, system, userMessage, tools = [], call, send, signal, maxIterations = MAX_ITERATIONS_DEFAULT, maxTokens = 4096, numCtx }) {
    const { adapter, cfg, model, jurisdiction, local } = normalizeProvider(provider);
    const messages = adapter.init({ userMessage });
    let toolDefs = adapter.mapTools(tools);
    const toolsUsed = [];
    const callRepeats = new Map();   // tool sig → count (circuit breaker, Step 7b)
    let breaker = null;

    const audit = (decision = 'allowed', reason) => {
      try {
        const blob = JSON.stringify(messages);
        onEgress?.({ provider: adapter.kind, model, jurisdiction, decision, reason: reason || null, contentHash: sha256(blob), contentLength: blob.length });
      } catch { /* audit must never break the turn */ }
    };

    // §12 token-usage accounting — the provider reports real counts; record them
    // (counts only, never the messages). Fires once per turn on completion.
    const recordUsage = (usage) => {
      try {
        if (!usage || typeof onUsage !== 'function') return;
        onUsage({ area: 'chat', isLocal: !!local, provider: adapter.kind, model, jurisdiction, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, estimated: false });
      } catch { /* accounting must never break the turn */ }
    };

    const once = (defs, first) => adapter.streamOnce({ cfg, system, messages, toolDefs: defs, model, maxTokens, numCtx, send, signal, fetch, timeoutMs, logger }).catch((err) => {
      // No-tool model (common with small local models): retry the very first call
      // without tools → degrade to a plain context-grounded answer (the relay floor).
      if (first && defs && defs.length) { logger(`harness: provider rejected tools (${err?.status || '?'}); falling back to text-only`); toolDefs = []; return null; }
      throw err;
    });

    toolLoop:
    for (let i = 0; i < maxIterations; i++) {
      if (signal?.aborted) return { toolsUsed, aborted: true };
      audit();
      let r = await once(toolDefs, i === 0);
      if (r === null) r = await once([], false);   // tool-fallback retry, no tools
      if (r.aborted) return { toolsUsed, aborted: true };   // stall/disconnect — partial text already streamed
      adapter.pushAssistant(messages, r.text, r.toolCalls);
      // Truncation = the provider stopped at the output cap mid-stream. Any tool
      // call it was emitting has cut-off args (truncated JSON → {} → a silent
      // no-op write — the "said it saved but nothing was written" bug). DON'T run
      // those tools or iterate further: surface `truncated` and stop so the caller
      // raises a visible, actionable state. Partial text already streamed; keep it.
      if (r.truncated) {
        logger(`harness: provider stopped at the output cap (stop_reason=${r.stopReason}); turn truncated — not executing possibly-truncated tool calls`);
        if (r.usage) { send({ type: 'usage', inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens }); recordUsage(r.usage); }
        return { toolsUsed, local: !!local, truncated: true };
      }
      if (!r.isTool || !r.toolCalls.length) { if (r.usage) { send({ type: 'usage', inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens }); recordUsage(r.usage); } return { toolsUsed, local: !!local }; }

      const results = [];
      for (const tc of r.toolCalls) {
        if (signal?.aborted) return { toolsUsed, aborted: true };
        // Circuit breaker: same tool + same args N× ⇒ a wedged turn. Stop the tool
        // loop (don't execute the repeat) and fall to the final answer pass.
        const sig = `${tc.name}:${JSON.stringify(tc.args ?? {})}`;
        const reps = (callRepeats.get(sig) || 0) + 1; callRepeats.set(sig, reps);
        if (reps >= TOOL_REPEAT_LIMIT) { breaker = 'repeat'; logger(`harness: circuit-breaker — '${tc.name}' repeated ${reps}× with identical args; final answer pass`); break toolLoop; }
        // Runtime tool gate (G1): the FIRST per-call authorization seam, layered UNDER the
        // grant-time allowlist (autonomyTools). Fail-CLOSED — a throwing/timed-out guard blocks.
        // The denial is pushed as a tool-result so the model re-plans; the breaker above caps a
        // model that keeps re-requesting a blocked tool. No-hooks ⇒ this branch is skipped entirely.
        if (hooks?.beforeToolCall) {
          const verdict = await fireBeforeToolCall(hooks, { name: tc.name, args: tc.args, surface });
          if (verdict?.block) {
            send({ type: 'tool_blocked', name: tc.name });
            results.push(adapter.toolResult(tc, `blocked: ${verdict.reason || 'policy'}`, true));
            continue;   // not executed → deliberately NOT added to toolsUsed
          }
        }
        send({ type: 'tool_start', name: tc.name }); toolsUsed.push(tc.name);
        let out, isErr = false; const t0 = Date.now();
        try { out = await call(tc.name, tc.args); }
        catch { out = 'tool execution failed'; isErr = true; }   // never surface err.message (§1)
        out = capToolOutput(out);                                 // in-turn window safety
        // Observer hook (G1): fire-and-forget, fail-OPEN — never stalls or breaks the turn.
        if (hooks?.afterToolCall) fireAfterToolCall(hooks, { name: tc.name, args: tc.args, output: out, isError: isErr, durationMs: Date.now() - t0 }, logger);
        send({ type: isErr ? 'tool_error' : 'tool_complete', name: tc.name });
        results.push(adapter.toolResult(tc, out, isErr));
      }
      adapter.pushToolResults(messages, results);
    }

    // Loop ended — either maxIterations exhausted or the breaker tripped. One final
    // no-tools pass so the user gets an answer, not a silent stop. Logged (no silent caps).
    logger(breaker
      ? `harness: tool-loop circuit-breaker (${breaker}); final answer pass without tools`
      : `harness: hit maxIterations=${maxIterations}; final answer pass without tools`);
    audit();
    const fin = await adapter.streamOnce({ cfg, system, messages, toolDefs: null, model, maxTokens, numCtx, send, signal, fetch, timeoutMs, logger });
    if (fin.usage) { send({ type: 'usage', inputTokens: fin.usage.inputTokens, outputTokens: fin.usage.outputTokens }); recordUsage(fin.usage); }
    if (fin.truncated) logger(`harness: final answer pass also hit the output cap (stop_reason=${fin.stopReason})`);
    return { toolsUsed, capped: true, truncated: !!fin.truncated, ...(breaker ? { breaker } : {}) };
  }

  return { streamTurn };
}

export default createAgentHarness;
