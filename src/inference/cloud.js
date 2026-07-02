// src/inference/cloud.js — BYOK cloud backend (Component 6).
//
// ⚠️ EGRESS BOUNDARY. This path sends the prompt — which is user plaintext — to
// a third-party API (Anthropic or OpenAI) authenticated with the USER'S OWN key.
// That is an explicit, opt-in privacy tradeoff: it only happens when the user
// has configured a key AND the router decided the task warrants cloud (see
// router.js — default and fallback are always local/on-box). No key → this
// throws; the router then stays local. We send the prompt over TLS to the
// user's chosen provider and nowhere else, and NEVER log the prompt or response.
//
// Implemented directly over the providers' REST APIs with the built-in fetch —
// no SDK dependency to install, no model pinned by a transitive package.

import { InferenceError } from "./errors.js";
import { assertSafeBaseUrl, fetchProvider } from "./base-url.js";
import { ANTHROPIC_URL, anthropicAuthHeaders, anthropicSystem } from "./anthropic-wire.js";

// Defaults are overridable via INFERENCE_CLOUD_MODEL (see router.js). Anthropic
// default favors the capable-but-balanced current Sonnet; both are just strings
// passed through to the provider — the user's key decides what's available.
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
export const DEFAULT_OPENAI_MODEL = "gpt-4o";

// ANTHROPIC_URL + the Anthropic auth headers now live in ./anthropic-wire.js (the
// single Anthropic-wire definition shared with src/agent/harness.js).
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

/**
 * Generate text from a BYOK cloud provider. Anthropic is preferred when both
 * keys are present. Throws InferenceError if no key is configured.
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {number} [opts.maxTokens=1024]
 * @param {string} [opts.anthropicApiKey]
 * @param {string} [opts.openaiApiKey]
 * @param {string} [opts.baseUrl]               OpenAI-compatible endpoint (Regolo/OpenRouter/Ollama/…)
 * @param {string} [opts.model]               overrides the provider default
 * @param {typeof fetch} [opts.fetch]
 * @param {number} [opts.timeoutMs=60000]
 * @returns {Promise<string>}
 */
export async function cloudInfer({
  prompt,
  maxTokens = 1024,
  anthropicApiKey,
  claudeOAuthToken,
  openaiApiKey,
  baseUrl,
  model,
  fetch = globalThis.fetch,
  timeoutMs = 60000,
  onUsage,
  onTruncated,
  noThink,
} = {}) {
  if (typeof fetch !== "function") {
    throw new InferenceError("cloudInfer: no fetch implementation", { backend: "cloud" });
  }
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new InferenceError("cloudInfer: prompt must be a non-empty string", { backend: "cloud" });
  }
  if (anthropicApiKey || claudeOAuthToken) {
    const auth = claudeOAuthToken ? { mode: "subscription", token: claudeOAuthToken } : { mode: "apiKey", apiKey: anthropicApiKey };
    return anthropicInfer({ prompt, maxTokens, auth, model: model || DEFAULT_ANTHROPIC_MODEL, fetch, timeoutMs, onUsage, onTruncated });
  }
  // OpenAI-compatible path — native OpenAI, or any base_url provider (OpenRouter,
  // Together, Groq, Regolo, Scaleway, Ollama, LM Studio, vLLM …). A base_url with
  // no key is valid (some local servers are keyless).
  if (openaiApiKey || baseUrl) {
    return openaiCompatibleInfer({ prompt, maxTokens, apiKey: openaiApiKey, baseUrl, model: model || DEFAULT_OPENAI_MODEL, fetch, timeoutMs, onUsage, onTruncated, noThink });
  }
  throw new InferenceError("cloudInfer: no cloud provider configured (set a key or a base_url)", { backend: "cloud" });
}

// Fire a usage event (counts only, never content) — fail-soft. §12.
function emitCloudUsage(onUsage, inputTokens, outputTokens) {
  if (typeof onUsage !== "function") return;
  try { onUsage({ inputTokens, outputTokens }); } catch { /* never break inference */ }
}

// Fire a truncation event when the provider stopped at the OUTPUT CAP (Anthropic
// `stop_reason:'max_tokens'`, OpenAI `finish_reason:'length'`). Additive + fail-
// soft like onUsage; the reason string is a safe category, never content. Lets a
// caller (the gateway) report finish_reason:'length' instead of a false 'stop'.
function emitTruncated(onTruncated, reason) {
  if (typeof onTruncated !== "function") return;
  try { onTruncated({ reason }); } catch { /* never break inference */ }
}

/** POST JSON with timeout; parse + fail-closed. Never echoes the response body.
 *  Exported so the agent harness (src/agent/harness.js) can speak the same wire
 *  protocol + share the same fail-closed/no-echo discipline. */
export async function postJson(url, headers, body, fetch, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchProvider(url, {
      fetch,
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const reason = err?.name === "AbortError" ? `timed out after ${timeoutMs}ms` : "network error";
    throw new InferenceError(`cloudInfer: ${url} unreachable (${reason})`, { cause: err, backend: "cloud" });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (err) {
    throw new InferenceError(`cloudInfer: provider returned non-JSON (status ${res.status})`, { cause: err, status: res.status, backend: "cloud" });
  }
  if (!res.ok) {
    // Include only the provider's error *type* (a safe category), never the
    // message/body — those can reflect request content.
    const type = data?.error?.type ? ` (${data.error.type})` : "";
    throw new InferenceError(`cloudInfer: provider error ${res.status}${type}`, { status: res.status, backend: "cloud" });
  }
  return data;
}

async function anthropicInfer({ prompt, maxTokens, auth, model, fetch, timeoutMs, onUsage, onTruncated }) {
  // Subscription auth requires the "You are Claude Code" system block; apiKey auth
  // sends no system field (anthropicSystem returns undefined → byte-identical).
  const body = { model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] };
  const sys = anthropicSystem(auth);
  if (sys !== undefined) body.system = sys;
  const data = await postJson(ANTHROPIC_URL, anthropicAuthHeaders(auth), body, fetch, timeoutMs);
  const out = Array.isArray(data?.content)
    ? data.content.filter((b) => b?.type === "text").map((b) => b.text).join("")
    : "";
  if (!out) throw new InferenceError("cloudInfer: Anthropic returned no text content", { backend: "cloud" });
  emitCloudUsage(onUsage, data?.usage?.input_tokens, data?.usage?.output_tokens);
  if (data?.stop_reason === "max_tokens") emitTruncated(onTruncated, "max_tokens");
  return out;
}

/** base_url → the chat-completions URL. Accepts a host, a `…/v1`, or a full URL.
 *  Validates the base_url (SSRF + exfil guard, H5) before building — throws on a
 *  private/internal or non-http(s) target so a malicious base_url can't redirect
 *  the prompt+key to an internal service. */
export function resolveChatUrl(baseUrl) {
  if (!baseUrl) return OPENAI_URL;
  assertSafeBaseUrl(baseUrl);
  const b = String(baseUrl).replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(b)) return b;
  return /\/v1$/.test(b) ? `${b}/chat/completions` : `${b}/v1/chat/completions`;
}

// OpenAI-compatible chat completion against any base_url (OpenAI is the default).
// Covers OpenAI, OpenRouter, Together, Groq, Regolo, Scaleway, Ollama, LM Studio,
// vLLM — anything speaking /v1/chat/completions. API key optional (local servers
// are often keyless). Never echoes the key or the response body.
async function openaiCompatibleInfer({ prompt, maxTokens, apiKey, baseUrl, model, fetch, timeoutMs, onUsage, onTruncated, noThink }) {
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const body = { model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] };
  // Reasoning models (the Qwen3 family on vLLM/Regolo, etc.) otherwise spend the whole
  // token budget on hidden reasoning_content and return an EMPTY `content` — which we
  // treat as a failure → silent local fallback (the 2026-06-29 "ran llama3.1, overheated"
  // bug; confirmed: qwen3.6-27b max_tokens=80 → content:null, finish:length). For
  // structured tasks (narrate) we disable thinking so the answer comes straight back in
  // `content`. vLLM-standard chat_template_kwargs; non-Qwen OpenAI-compat servers ignore
  // the extra field. Mirrors the LOCAL narrate path's think:false.
  if (noThink) body.chat_template_kwargs = { enable_thinking: false };
  const data = await postJson(
    resolveChatUrl(baseUrl),
    headers,
    body,
    fetch,
    timeoutMs,
  );
  const out = data?.choices?.[0]?.message?.content;
  if (typeof out !== "string" || out.length === 0) {
    throw new InferenceError("cloudInfer: provider returned no message content", { backend: "cloud" });
  }
  emitCloudUsage(onUsage, data?.usage?.prompt_tokens, data?.usage?.completion_tokens);
  if (data?.choices?.[0]?.finish_reason === "length") emitTruncated(onTruncated, "length");
  return out;
}

// ── Streaming variants ───────────────────────────────────────────────────────
// Same egress boundary as cloudInfer (prompt → user's chosen provider over TLS,
// never logged), but tokens are yielded as they arrive. The router decides WHEN
// to stream + audits the egress; these functions just speak the wire protocol.

/** Open a streaming POST. Times out the connection (TTFB), not the whole stream.
 *  Exported for the agent harness (see postJson note). */
export async function openStream(url, headers, body, fetch, timeoutMs, extraSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // An external signal (turn abort / inactivity watchdog / client disconnect) must
  // be able to force-close the connection — including AFTER headers arrive, while
  // the body is streaming. The listener stays bound for the life of the response.
  if (extraSignal) {
    if (extraSignal.aborted) controller.abort();
    else extraSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  let res;
  try {
    res = await fetchProvider(url, { fetch, method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    const reason = err?.name === "AbortError" ? `timed out after ${timeoutMs}ms` : "network error";
    throw new InferenceError(`cloudStream: ${url} unreachable (${reason})`, { cause: err, backend: "cloud" });
  }
  clearTimeout(timer);
  if (!res.ok) {
    // Surface only the provider's error *type* (a safe category), never the body.
    let type = "";
    try { const t = await res.text(); const d = t ? JSON.parse(t) : {}; type = d?.error?.type ? ` (${d.error.type})` : ""; } catch { /* non-JSON error body */ }
    throw new InferenceError(`cloudStream: provider error ${res.status}${type}`, { status: res.status, backend: "cloud" });
  }
  if (!res.body) throw new InferenceError("cloudStream: provider returned no stream body", { backend: "cloud" });
  return res;
}

/** Yield each SSE `data:` payload string from a Response body (skips `[DONE]`).
 *  Exported for the agent harness (see postJson note). */
export async function* ssePayloads(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;
      if (payload) yield payload;
    }
  }
}

async function* openaiCompatibleStream({ prompt, maxTokens, apiKey, baseUrl, model, fetch, timeoutMs, onUsage, onTruncated }) {
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  // stream_options.include_usage → the provider emits a final usage chunk (§12).
  const res = await openStream(resolveChatUrl(baseUrl), headers, { model, max_tokens: maxTokens, stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: prompt }] }, fetch, timeoutMs);
  let inTok, outTok, truncated = false;
  for await (const payload of ssePayloads(res)) {
    let ev; try { ev = JSON.parse(payload); } catch { continue; }
    if (ev?.usage) { inTok = ev.usage.prompt_tokens ?? inTok; outTok = ev.usage.completion_tokens ?? outTok; }
    if (ev?.choices?.[0]?.finish_reason === "length") truncated = true;
    const delta = ev?.choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta) yield delta;
  }
  emitCloudUsage(onUsage, inTok, outTok);
  if (truncated) emitTruncated(onTruncated, "length");
}

async function* anthropicStream({ prompt, maxTokens, auth, model, fetch, timeoutMs, onUsage, onTruncated }) {
  const body = { model, max_tokens: maxTokens, stream: true, messages: [{ role: "user", content: prompt }] };
  const sys = anthropicSystem(auth);
  if (sys !== undefined) body.system = sys;
  const res = await openStream(ANTHROPIC_URL, anthropicAuthHeaders(auth), body, fetch, timeoutMs);
  let inTok, outTok, truncated = false;
  for await (const payload of ssePayloads(res)) {
    let ev; try { ev = JSON.parse(payload); } catch { continue; }
    if (ev?.type === "message_start") inTok = ev.message?.usage?.input_tokens ?? inTok;
    if (ev?.type === "message_delta" && ev.usage?.output_tokens) outTok = ev.usage.output_tokens;
    if (ev?.type === "message_delta" && ev.delta?.stop_reason === "max_tokens") truncated = true;
    if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string" && ev.delta.text) yield ev.delta.text;
  }
  emitCloudUsage(onUsage, inTok, outTok);
  if (truncated) emitTruncated(onTruncated, "max_tokens");
}

/**
 * Stream text from a BYOK cloud provider (Anthropic preferred when both keys are
 * present; otherwise any OpenAI-compatible base_url). Throws if none configured.
 * @returns {AsyncGenerator<string>}
 */
export async function* cloudStream({
  prompt, maxTokens = 1024, anthropicApiKey, claudeOAuthToken, openaiApiKey, baseUrl, model,
  fetch = globalThis.fetch, timeoutMs = 60000, onUsage, onTruncated,
} = {}) {
  if (typeof fetch !== "function") throw new InferenceError("cloudStream: no fetch implementation", { backend: "cloud" });
  if (typeof prompt !== "string" || prompt.length === 0) throw new InferenceError("cloudStream: prompt must be a non-empty string", { backend: "cloud" });
  if (anthropicApiKey || claudeOAuthToken) {
    const auth = claudeOAuthToken ? { mode: "subscription", token: claudeOAuthToken } : { mode: "apiKey", apiKey: anthropicApiKey };
    yield* anthropicStream({ prompt, maxTokens, auth, model: model || DEFAULT_ANTHROPIC_MODEL, fetch, timeoutMs, onUsage, onTruncated }); return;
  }
  if (openaiApiKey || baseUrl) { yield* openaiCompatibleStream({ prompt, maxTokens, apiKey: openaiApiKey, baseUrl, model: model || DEFAULT_OPENAI_MODEL, fetch, timeoutMs, onUsage, onTruncated }); return; }
  throw new InferenceError("cloudStream: no cloud provider configured (set a key or a base_url)", { backend: "cloud" });
}

export default cloudInfer;
