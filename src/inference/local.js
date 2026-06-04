// src/inference/local.js — local Ollama backend (Component 6).
//
// Privacy-first: this path keeps inference ON-BOX. It POSTs to the Ollama HTTP
// API bound on 127.0.0.1:11434 — plaintext never leaves the machine. This is
// the default for the router and the fallback for every task.
//
// Fail-closed + leak-safe: a non-OK response or unreachable Ollama throws an
// InferenceError; error messages carry status/backend only — NEVER the prompt
// or the model's response (both are user plaintext).

import { InferenceError } from "./errors.js";

export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
export const DEFAULT_LOCAL_MODEL = "llama3.1";

/**
 * Generate text from a local Ollama model.
 * @param {object} opts
 * @param {string} opts.prompt                 non-empty prompt
 * @param {number} [opts.maxTokens=1024]       maps to Ollama num_predict
 * @param {string} [opts.model="llama3.1"]
 * @param {string[]} [opts.images]             base64 image(s) for a VISION model
 *                                             (Ollama's native multimodal input).
 * @param {string} [opts.baseUrl="http://127.0.0.1:11434"]
 * @param {typeof fetch} [opts.fetch]          injectable (defaults to global)
 * @param {number} [opts.timeoutMs=60000]
 * @returns {Promise<string>}                  the generated text
 */
export async function localInfer({
  prompt,
  maxTokens = 1024,
  model = DEFAULT_LOCAL_MODEL,
  images,
  baseUrl = DEFAULT_OLLAMA_URL,
  fetch = globalThis.fetch,
  timeoutMs = 60000,
} = {}) {
  if (typeof fetch !== "function") {
    throw new InferenceError("localInfer: no fetch implementation (Node >= 18 or pass opts.fetch)", { backend: "local" });
  }
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new InferenceError("localInfer: prompt must be a non-empty string", { backend: "local" });
  }

  const url = `${baseUrl.replace(/\/+$/, "")}/api/generate`;
  // Ollama accepts `images: [base64, …]` on /api/generate when the model is
  // multimodal (llava / llama3.2-vision / moondream / …). Omit the key entirely
  // for text models so behaviour is unchanged.
  const body = { model, prompt, stream: false, options: { num_predict: maxTokens } };
  if (Array.isArray(images) && images.length) body.images = images;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const reason = err?.name === "AbortError" ? `timed out after ${timeoutMs}ms` : "is Ollama running?";
    throw new InferenceError(`localInfer: Ollama unreachable at ${url} (${reason})`, { cause: err, backend: "local" });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (err) {
    throw new InferenceError(`localInfer: Ollama returned non-JSON (status ${res.status})`, { cause: err, status: res.status, backend: "local" });
  }
  // Deliberately do NOT echo the body — it can reflect the prompt.
  if (!res.ok) {
    throw new InferenceError(`localInfer: Ollama error (status ${res.status})`, { status: res.status, backend: "local" });
  }
  if (typeof data.response !== "string") {
    throw new InferenceError("localInfer: Ollama response missing .response field", { backend: "local" });
  }
  return data.response;
}

export default localInfer;

/**
 * Streaming variant of localInfer — yields text deltas as Ollama produces them.
 * Ollama's /api/generate with stream:true emits NDJSON: one JSON object per line,
 * each `{ response, done }`. Fail-closed + leak-safe like localInfer.
 * @param {object} opts  same shape as localInfer
 * @returns {AsyncGenerator<string>}  successive text fragments
 */
export async function* localStream({
  prompt,
  maxTokens = 1024,
  model = DEFAULT_LOCAL_MODEL,
  images,
  baseUrl = DEFAULT_OLLAMA_URL,
  fetch = globalThis.fetch,
  timeoutMs = 60000,
} = {}) {
  if (typeof fetch !== "function") {
    throw new InferenceError("localStream: no fetch implementation", { backend: "local" });
  }
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new InferenceError("localStream: prompt must be a non-empty string", { backend: "local" });
  }
  const url = `${baseUrl.replace(/\/+$/, "")}/api/generate`;
  const body = { model, prompt, stream: true, options: { num_predict: maxTokens } };
  if (Array.isArray(images) && images.length) body.images = images;

  // Timeout guards time-to-first-byte (the connection), not the whole stream —
  // a long generation must not be aborted mid-flight.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    const reason = err?.name === "AbortError" ? `timed out after ${timeoutMs}ms` : "is Ollama running?";
    throw new InferenceError(`localStream: Ollama unreachable at ${url} (${reason})`, { cause: err, backend: "local" });
  }
  clearTimeout(timer);
  if (!res.ok) {
    throw new InferenceError(`localStream: Ollama error (status ${res.status})`, { status: res.status, backend: "local" });
  }
  if (!res.body) {
    throw new InferenceError("localStream: Ollama returned no stream body", { backend: "local" });
  }

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
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; } // skip a partial/garbled line
      if (typeof ev.response === "string" && ev.response) yield ev.response;
      if (ev.done) return;
    }
  }
}
