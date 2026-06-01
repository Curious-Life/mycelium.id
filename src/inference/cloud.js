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

// Defaults are overridable via INFERENCE_CLOUD_MODEL (see router.js). Anthropic
// default favors the capable-but-balanced current Sonnet; both are just strings
// passed through to the provider — the user's key decides what's available.
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
export const DEFAULT_OPENAI_MODEL = "gpt-4o";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Generate text from a BYOK cloud provider. Anthropic is preferred when both
 * keys are present. Throws InferenceError if no key is configured.
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {number} [opts.maxTokens=1024]
 * @param {string} [opts.anthropicApiKey]
 * @param {string} [opts.openaiApiKey]
 * @param {string} [opts.model]               overrides the provider default
 * @param {typeof fetch} [opts.fetch]
 * @param {number} [opts.timeoutMs=60000]
 * @returns {Promise<string>}
 */
export async function cloudInfer({
  prompt,
  maxTokens = 1024,
  anthropicApiKey,
  openaiApiKey,
  model,
  fetch = globalThis.fetch,
  timeoutMs = 60000,
} = {}) {
  if (typeof fetch !== "function") {
    throw new InferenceError("cloudInfer: no fetch implementation", { backend: "cloud" });
  }
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new InferenceError("cloudInfer: prompt must be a non-empty string", { backend: "cloud" });
  }
  if (anthropicApiKey) {
    return anthropicInfer({ prompt, maxTokens, apiKey: anthropicApiKey, model: model || DEFAULT_ANTHROPIC_MODEL, fetch, timeoutMs });
  }
  if (openaiApiKey) {
    return openaiInfer({ prompt, maxTokens, apiKey: openaiApiKey, model: model || DEFAULT_OPENAI_MODEL, fetch, timeoutMs });
  }
  throw new InferenceError("cloudInfer: no cloud API key configured (set ANTHROPIC_API_KEY or OPENAI_API_KEY)", { backend: "cloud" });
}

/** POST JSON with timeout; parse + fail-closed. Never echoes the response body. */
async function postJson(url, headers, body, fetch, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
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

async function anthropicInfer({ prompt, maxTokens, apiKey, model, fetch, timeoutMs }) {
  const data = await postJson(
    ANTHROPIC_URL,
    { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
    { model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] },
    fetch,
    timeoutMs,
  );
  const out = Array.isArray(data?.content)
    ? data.content.filter((b) => b?.type === "text").map((b) => b.text).join("")
    : "";
  if (!out) throw new InferenceError("cloudInfer: Anthropic returned no text content", { backend: "cloud" });
  return out;
}

async function openaiInfer({ prompt, maxTokens, apiKey, model, fetch, timeoutMs }) {
  const data = await postJson(
    OPENAI_URL,
    { Authorization: `Bearer ${apiKey}` },
    { model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] },
    fetch,
    timeoutMs,
  );
  const out = data?.choices?.[0]?.message?.content;
  if (typeof out !== "string" || out.length === 0) {
    throw new InferenceError("cloudInfer: OpenAI returned no message content", { backend: "cloud" });
  }
  return out;
}

export default cloudInfer;
