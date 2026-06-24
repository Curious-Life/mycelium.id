// src/gateway/openai-compat.js — the OpenAI-compatible outbound gateway (S8).
//
// Fronts the inference router with an OpenAI `POST /v1/chat/completions`
// (+ `GET /v1/models`) surface so a user's own agent harness (opencode / Codex /
// Goose / Cline / Continue / OpenHands) can point its model base-URL at Mycelium
// and get sovereign, jurisdiction-gated, AUDITED inference through the operator's
// own BYOK keys — without the harness holding any provider key of its own.
//
// This is a THIN translation layer over seams that are reused UNCHANGED:
//   • resolve.js  — the active ai_providers row decides the route (+ jurisdiction)
//   • router.js   — infer({prompt,task,maxTokens,sensitive}) → Promise<string>
//   • egress.js   — every cloud egress audited (sha256 hash + length, never text)
//
// SECURITY (the §1–§13 non-negotiables apply):
//   • Mounted ONLY on the Bearer-guarded :4711 app — never the no-auth REST
//     :8787 (it spends the operator's keys; fail-closed auth is mandatory).
//   • Zero plaintext leakage: prompts/responses are NEVER logged; an inference
//     failure is reduced to a safe, generic envelope before it reaches the client
//     (provider error detail can reflect request content).
//   • The §4g sensitive hard-block is enforced inside router.js. Gateway input is
//     opaque harness text with no vault flag, so it CANNOT be classified — the
//     gateway defaults sensitive:false and lets a harness opt a request in via
//     `X-Mycelium-Sensitive: true`. Otherwise privacy is governed by the
//     configured provider's jurisdiction + the egress audit. Documented limit.
//
// v1 scope (decided in DESIGN-relay-and-gateway Part B.4 — not relitigated here):
//   • NON-streaming. `stream:true` → a single terminal SSE chunk (compat shim);
//     true token-streaming needs router/adapter streaming (a named fast-follow).
//   • `tools`/`tool_choice` are DROPPED (the router has no tool support; the
//     harness runs its own tool loop and only needs raw completions from us).
//   • Routing uses the single ACTIVE provider (resolveInferenceConfig). The §4g
//     cascade (EU→frontier→local on failure) is a later refinement; the `model`
//     field is advisory in v1 (`mycelium-auto` is the canonical id).

import { randomUUID, createHash } from 'node:crypto';
import { resolveInferenceConfig, resolveProviderChain } from '../inference/resolve.js';
import { createInferenceRouter } from '../inference/router.js';
import { resolveChatUrl } from '../inference/cloud.js';
import { fetchProvider } from '../inference/base-url.js';
import { createEgressAuditSink } from '../inference/egress.js';
import { inferWithCascade } from '../inference/cascade.js';
import { estimateTokens } from '../inference/token-budget.js';
import { createUsageSink } from '../inference/usage.js';

// §4g cascade (opt-in). Default OFF → the single active provider preserves v1
// behavior; ON → try EU→frontier→local until one succeeds. The preference is a
// persisted user setting (the Settings → Intelligence "smart routing" toggle);
// MYCELIUM_INFER_CASCADE is the env fallback used only when no setting is saved.
export async function isCascadeEnabled(db, userId, env = process.env) {
  try {
    const s = await db?.users?.getSettings?.(userId);
    if (s && typeof s.inferCascade === 'boolean') return s.inferCascade;
  } catch { /* fall through to env */ }
  return /^(1|true|yes)$/i.test(String(env.MYCELIUM_INFER_CASCADE || '').trim());
}

export const CANONICAL_MODEL = 'mycelium-auto';
const MAX_OUTPUT_TOKENS = 8192;

/** A client-facing error carrying an HTTP status + an OpenAI error `type`. */
export class GatewayError extends Error {
  constructor(message, status = 400, type = 'invalid_request_error') {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.type = type;
  }
}

// OpenAI content can be a string OR an array of parts ({type:'text',text}). We
// keep only text parts (the router is text-only; images/audio are out of scope).
function coerceContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : p && p.type === 'text' && typeof p.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('');
  }
  return '';
}

/**
 * Flatten an OpenAI `messages[]` into one role-tagged prompt. `system` messages
 * become a preamble; the rest are tagged `User:`/`Assistant:`/`Tool:` and joined,
 * ending with an `Assistant:` cue so the model continues as the assistant. The
 * router is prompt-only, so this is how a multi-turn request reaches it.
 * @param {Array<{role?:string,content?:any}>} messages
 * @returns {string}
 */
export function flattenMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new GatewayError('`messages` must be a non-empty array', 400);
  }
  const systems = [];
  const turns = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') throw new GatewayError('each message must be an object', 400);
    const role = String(m.role || '').toLowerCase();
    const content = coerceContent(m.content);
    if (role === 'system' || role === 'developer') { if (content) systems.push(content); continue; }
    const tag = role === 'assistant' ? 'Assistant' : role === 'tool' ? 'Tool' : 'User';
    turns.push(`${tag}: ${content}`);
  }
  const preamble = systems.join('\n\n');
  const body = turns.join('\n\n');
  const prompt = `${preamble ? `${preamble}\n\n` : ''}${body}${body ? '\n\nAssistant:' : ''}`;
  if (!prompt.trim()) throw new GatewayError('`messages` produced an empty prompt', 400);
  return prompt;
}

// Approximate token count (~4 chars/token) for the usage block. Clients only
// need a plausible shape; we never have exact provider counts in v1. Shared
// estimator (src/inference/token-budget.js) — same chars/4 + floor-of-1.
const approxTokens = estimateTokens;

function clampMaxTokens(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined; // → adapter default (1024)
  return Math.min(Math.floor(n), MAX_OUTPUT_TOKENS);
}

// `X-Mycelium-Sensitive: true|1|yes` (case-insensitive) → opt this request into
// the §4g hard-block. Anything else (incl. absent) → false.
function headerTrue(v) {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && /^(1|true|yes)$/i.test(s.trim());
}

function buildCompletion({ model, prompt, text, finishReason = 'stop' }) {
  const prompt_tokens = approxTokens(prompt);
  const completion_tokens = approxTokens(text);
  return {
    id: `chatcmpl-${randomUUID().replace(/-/g, '')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    // finish_reason:'length' when the provider hit its output cap — an external
    // harness keys off this to detect a cut-off (e.g. truncated tool-call args)
    // rather than trusting a false 'stop'. Default 'stop' (the normal case).
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finishReason }],
    usage: { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens },
  };
}

// v1 streaming compat shim: emit the whole completion as ONE delta chunk, then a
// terminal stop chunk, then the [DONE] sentinel. Real token-streaming is a
// fast-follow (needs router + adapter streaming, which don't exist yet).
function sendStreamShim(res, { id, created, model, text, finishReason = 'stop' }) {
  res.set('Content-Type', 'text/event-stream; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  res.set('Connection', 'keep-alive');
  const base = { id, object: 'chat.completion.chunk', created, model };
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

// Real token streaming: pipe router.inferStream deltas as OpenAI chunk frames,
// then a terminal stop chunk + [DONE]. A failure BEFORE the first token becomes a
// normal JSON error envelope (headers not yet sent); a failure AFTER tokens have
// streamed ends the SSE with a terminal stop frame. We NEVER echo err.message
// (§1 zero-leak) — provider/plaintext detail can ride along on it.
async function streamCompletion(res, { router, model, prompt, maxTokens, sensitive, onText }) {
  const id = `chatcmpl-${randomUUID().replace(/-/g, '')}`;
  const created = Math.floor(Date.now() / 1000);
  const base = { id, object: 'chat.completion.chunk', created, model };
  let opened = false;
  let full = ''; // accumulate deltas so the memory bridge can capture the reply
  let truncated = false; // provider hit its output cap (finish_reason:'length'/max_tokens)
  const open = () => {
    if (opened) return;
    res.set('Content-Type', 'text/event-stream; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.set('Connection', 'keep-alive');
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
    opened = true;
  };
  try {
    for await (const delta of router.inferStream({ prompt, task: 'complex', maxTokens, sensitive, onTruncated: () => { truncated = true; } })) {
      open();
      full += delta;
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] })}\n\n`);
    }
    open(); // a zero-token stream still emits the role frame for client compat
    // 'length' when the provider truncated at its output cap → the client sees a
    // cut-off, not a false clean 'stop'. Default 'stop' (the normal case).
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: truncated ? 'length' : 'stop' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    if (!opened) { sendError(res, err); return; } // nothing sent yet → normal envelope
    try {
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } catch { try { res.end(); } catch { /* ignore */ } }
  } finally {
    // Capture whatever streamed (even a partial reply on a mid-stream failure).
    if (onText) { try { onText(full); } catch { /* capture must never break egress */ } }
  }
}

function sendError(res, err) {
  if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
  if (err instanceof GatewayError) {
    res.status(err.status).json({ error: { message: err.message, type: err.type, code: null } });
    return;
  }
  // Any other failure (router/adapter) → a safe, generic envelope. NEVER echo
  // err.message: it can carry provider/plaintext detail (§1 zero-leak).
  res.status(502).json({ error: { message: 'inference failed: no provider reachable', type: 'upstream_error', code: null } });
}

// A stable, human-meaningful model id per configured provider (no secrets).
function modelIdForProvider(p) {
  return p?.model_preference || p?.label || p?.provider || null;
}

/**
 * Build the gateway's two route handlers, bound to one shared vault handle.
 * @param {object} opts
 * @param {object} opts.db                  the assembled vault db (providers + audit)
 * @param {string} [opts.userId='local-user']
 * @param {typeof fetch} [opts.fetch=globalThis.fetch]
 * @returns {{ chatCompletions: Function, listModels: Function }}
 */
export function createGatewayHandlers({ db, userId = 'local-user', fetch = globalThis.fetch, getContext, captureMessage } = {}) {
  const onEgress = createEgressAuditSink(db, userId);
  const onUsage = createUsageSink(db, userId, { source: 'gateway' });

  // ── Memory bridge (opt-in via `X-Mycelium-Capture: <conversationId>`) ────────
  // When a harness sends that header AND the deps are wired, the gateway turns a
  // stateless inference call into the universal memory loop: INJECT vault context
  // as a system preamble, and CAPTURE the new user turn + the assistant reply.
  // Absent the header → behavior is the unchanged pass-through proxy. Capture is
  // ALWAYS fire-and-forget: a memory failure must never break inference (§ egress).
  //
  // CRITICAL (capture.js dedup is id-keyed, not content-keyed): capture only the
  // LAST user message of this request — never loop messages[], or every prior turn
  // re-inserts as a fresh row each request (OpenAI calls resend the full history).
  const captureConv = (req) => {
    if (!captureMessage) return null;
    const h = req?.headers?.['x-mycelium-capture'];
    const v = Array.isArray(h) ? h[0] : h;
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  };
  const capId = (conv, role, content) =>
    'cap-' + createHash('sha256').update(`gateway|${conv}|${role}|${content}`).digest('hex').slice(0, 40);
  const fireCapture = (conv, role, content) => {
    const text = String(content ?? '').trim();
    if (!conv || !text) return;
    // Fire-and-forget; swallow everything (incl. the promise rejection).
    Promise.resolve()
      .then(() => captureMessage({ content: text, role, source: `gateway:${conv}`, conversationId: conv, id: capId(conv, role, text) }))
      .catch(() => { /* capture never breaks egress */ });
  };
  // Prepend vault context as a system message (not folded into user content, so it
  // is never captured as the user's turn). Returns a NEW messages array.
  const withInjectedContext = async (messages) => {
    if (!getContext) return messages;
    try {
      const t = await getContext({});
      const ctx = typeof t === 'string' ? t.slice(0, 4000) : '';
      if (ctx.trim()) return [{ role: 'system', content: `# Mycelium memory (the user's vault)\n\n${ctx}` }, ...messages];
    } catch { /* fail-open: no context */ }
    return messages;
  };
  // The last user message of THIS request = the new turn to capture.
  const lastUserContent = (messages) => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (String(messages[i]?.role || '').toLowerCase() === 'user') return coerceContent(messages[i].content);
    }
    return '';
  };

  // Resolve the ACTIVE provider per request so a change in Settings → Intelligence
  // takes effect immediately. Cheap (one indexed read) for a single-user vault.
  async function buildRouter() {
    const cfg = await resolveInferenceConfig(db, userId);
    return createInferenceRouter({ ...cfg, onEgress, onUsage, fetch });
  }

  // Tools pass-through: a request carrying `tools` is transparently proxied to an
  // OpenAI-compatible provider so tool_calls round-trip (the prompt-only router
  // would otherwise flatten the tool contract away). Returns true if handled;
  // false when the active provider is NOT OpenAI-compatible (native Anthropic /
  // local-env) → the caller flattens (dropping tools) as graceful degradation.
  async function toolsPassthrough(req, res, { body, sensitive }) {
    const cfg = await resolveInferenceConfig(db, userId);
    if (!(cfg.baseUrl || cfg.openaiApiKey)) return false;

    const jurisdiction = cfg.jurisdiction || 'us-standard';
    // §4g: a tool call cannot be downgraded to on-box local, so a sensitive
    // request to a US provider fails closed rather than egressing.
    if (sensitive && /^us/.test(jurisdiction)) {
      throw new GatewayError('a sensitive request cannot use a US provider for tool calls', 400, 'sensitive_blocked');
    }
    // Egress audit — sha256 of the serialized messages + length only (§4e); the
    // messages themselves (and the tool schema) are NEVER logged.
    try {
      const msgText = JSON.stringify(body.messages || []);
      let provider = 'openai';
      if (cfg.baseUrl) { try { provider = new URL(cfg.baseUrl).hostname; } catch { provider = 'custom'; } }
      onEgress?.({ provider, jurisdiction, model: cfg.cloudModel || body.model, contentHash: createHash('sha256').update(msgText).digest('hex'), contentLength: msgText.length, decision: 'allowed', reason: 'tools_passthrough' });
    } catch { /* audit must never break the call */ }

    const headers = { 'Content-Type': 'application/json' };
    if (cfg.openaiApiKey) headers.Authorization = `Bearer ${cfg.openaiApiKey}`;
    // mycelium-auto / absent → the provider's configured model; else pass through.
    const model = (typeof body.model === 'string' && body.model && body.model !== CANONICAL_MODEL) ? body.model : (cfg.cloudModel || body.model || undefined);

    let upstream;
    try {
      upstream = await fetchProvider(resolveChatUrl(cfg.baseUrl), { fetch, method: 'POST', headers, body: JSON.stringify({ ...body, model }) });
    } catch {
      throw new GatewayError('inference failed: provider unreachable', 502, 'upstream_error');
    }

    // Stream → pipe the provider's SSE through verbatim (tool_call deltas included).
    if (body.stream === true && upstream.body) {
      res.set('Content-Type', 'text/event-stream; charset=utf-8');
      res.set('Cache-Control', 'no-store');
      res.set('Connection', 'keep-alive');
      const reader = upstream.body.getReader();
      try { for (;;) { const { value, done } = await reader.read(); if (done) break; if (value) res.write(Buffer.from(value)); } }
      catch { /* provider/client dropped mid-stream */ }
      try { res.end(); } catch { /* ignore */ }
      return true;
    }

    const txt = await upstream.text();
    // A provider error body can reflect request content → never forward it raw.
    if (!upstream.ok) throw new GatewayError('inference failed: provider error', 502, 'upstream_error');
    res.status(200).set('Content-Type', 'application/json').send(txt);
    return true;
  }

  async function chatCompletions(req, res) {
    try {
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new GatewayError('request body must be a JSON object', 400);
      }
      const model = typeof body.model === 'string' && body.model ? body.model : CANONICAL_MODEL;
      const stream = body.stream === true;
      const maxTokens = clampMaxTokens(body.max_tokens);
      // §4g opt-in: a harness can mark a request sensitive → router hard-blocks
      // egress to a US provider (falls to on-box local + audits the denial).
      const sensitive = headerTrue(req.headers['x-mycelium-sensitive']);

      // Memory bridge (opt-in): conversation id from the header → capture + inject.
      // Capture the new user turn now (fire-and-forget) from the ORIGINAL messages,
      // BEFORE we prepend the context system message (so context isn't miscaptured).
      const conv = captureConv(req);
      if (conv) fireCapture(conv, 'user', lastUserContent(body.messages || []));

      // Tools pass-through: a request carrying `tools` is proxied raw to an
      // OpenAI-compatible provider so tool_calls round-trip; a non-compatible
      // active provider falls through to the flatten path (tools dropped). When
      // capture is on, inject context into the proxied messages too (assistant-
      // capture on the verbatim-SSE path is a documented deferral).
      if (Array.isArray(body.tools) && body.tools.length > 0) {
        const ptBody = conv ? { ...body, messages: await withInjectedContext(body.messages) } : body;
        if (await toolsPassthrough(req, res, { body: ptBody, sensitive })) return;
      }

      // Inject vault context as a leading system message when capture is on.
      const messages = conv ? await withInjectedContext(body.messages) : body.messages;
      const prompt = flattenMessages(messages);

      const router = await buildRouter();
      // Gateway calls are treated as cloud-capable (the harness wants a capable
      // model) → task:'complex'. The internal simple→local split is for
      // Mycelium's OWN enrichment, not pass-through harness calls (Part B.4).

      // Real token streaming when the router supports it; else the v1 shim.
      if (stream && typeof router.inferStream === 'function') {
        await streamCompletion(res, { router, model, prompt, maxTokens, sensitive, onText: conv ? (t) => fireCapture(conv, 'assistant', t) : undefined });
        return;
      }

      // §4g cascade (opt-in): try EU→frontier→local until one succeeds; a
      // sensitive request skips US providers. Default OFF → the single active
      // provider (router). Streaming above is single-provider by design.
      let truncated = false;
      const onTruncated = () => { truncated = true; };
      const text = (await isCascadeEnabled(db, userId))
        ? await inferWithCascade({ chain: await resolveProviderChain(db, userId, { sensitive }), prompt, task: 'complex', maxTokens, sensitive, onEgress, onUsage, onTruncated, fetch })
        : await router.infer({ prompt, task: 'complex', maxTokens, sensitive, onTruncated });
      if (conv) fireCapture(conv, 'assistant', text);
      // finish_reason:'length' when the provider hit its output cap so a harness can
      // detect a cut-off (e.g. truncated tool-call args) instead of a false 'stop'.
      const finishReason = truncated ? 'length' : 'stop';
      const completion = buildCompletion({ model, prompt, text, finishReason });
      if (stream) {
        sendStreamShim(res, { id: completion.id, created: completion.created, model, text, finishReason });
        return;
      }
      res.json(completion);
    } catch (err) {
      sendError(res, err);
    }
  }

  async function listModels(req, res) {
    // The canonical alias always works (routes to the active provider). Plus one
    // id per configured provider — METADATA ONLY (providers.list omits creds).
    let extra = [];
    try {
      const list = (await db?.providers?.list?.(userId)) || [];
      extra = list.map(modelIdForProvider).filter(Boolean);
    } catch { /* fail-soft: the canonical alias is always available */ }
    // The local Nomic embedding model is always available via /v1/embeddings.
    const ids = [CANONICAL_MODEL, ...new Set(extra), 'nomic-embed-text-v1.5'];
    const created = Math.floor(Date.now() / 1000);
    res.json({ object: 'list', data: ids.map((id) => ({ id, object: 'model', created, owned_by: 'mycelium' })) });
  }

  return { chatCompletions, listModels };
}

export default createGatewayHandlers;
