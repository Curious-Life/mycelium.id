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

import { randomUUID } from 'node:crypto';
import { resolveInferenceConfig } from '../inference/resolve.js';
import { createInferenceRouter } from '../inference/router.js';
import { createEgressAuditSink } from '../inference/egress.js';

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
// need a plausible shape; we never have exact provider counts in v1.
const approxTokens = (s) => Math.max(1, Math.ceil(String(s || '').length / 4));

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

function buildCompletion({ model, prompt, text }) {
  const prompt_tokens = approxTokens(prompt);
  const completion_tokens = approxTokens(text);
  return {
    id: `chatcmpl-${randomUUID().replace(/-/g, '')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens },
  };
}

// v1 streaming compat shim: emit the whole completion as ONE delta chunk, then a
// terminal stop chunk, then the [DONE] sentinel. Real token-streaming is a
// fast-follow (needs router + adapter streaming, which don't exist yet).
function sendStreamShim(res, { id, created, model, text }) {
  res.set('Content-Type', 'text/event-stream; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  res.set('Connection', 'keep-alive');
  const base = { id, object: 'chat.completion.chunk', created, model };
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
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
export function createGatewayHandlers({ db, userId = 'local-user', fetch = globalThis.fetch } = {}) {
  const onEgress = createEgressAuditSink(db, userId);

  // Resolve the ACTIVE provider per request so a change in Settings → Intelligence
  // takes effect immediately. Cheap (one indexed read) for a single-user vault.
  async function buildRouter() {
    const cfg = await resolveInferenceConfig(db, userId);
    return createInferenceRouter({ ...cfg, onEgress, fetch });
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
      const prompt = flattenMessages(body.messages);
      // §4g opt-in: a harness can mark a request sensitive → router hard-blocks
      // egress to a US provider (falls to on-box local + audits the denial).
      const sensitive = headerTrue(req.headers['x-mycelium-sensitive']);

      const router = await buildRouter();
      // Gateway calls are treated as cloud-capable (the harness wants a capable
      // model) → task:'complex'. The internal simple→local split is for
      // Mycelium's OWN enrichment, not pass-through harness calls (Part B.4).
      const text = await router.infer({ prompt, task: 'complex', maxTokens, sensitive });

      const completion = buildCompletion({ model, prompt, text });
      if (stream) {
        sendStreamShim(res, { id: completion.id, created: completion.created, model, text });
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
    const ids = [CANONICAL_MODEL, ...new Set(extra)];
    const created = Math.floor(Date.now() / 1000);
    res.json({ object: 'list', data: ids.map((id) => ({ id, object: 'model', created, owned_by: 'mycelium' })) });
  }

  return { chatCompletions, listModels };
}

export default createGatewayHandlers;
