// src/inference/probe.js — provider connectivity probe (used by the
// /portal/providers/:id/test endpoint). Sends a minimal 1-token request with the
// user's own key and reports a CATEGORY only — never the key, never the response
// body (CLAUDE.md §1). `fetch` is injectable so the verify gate runs offline.
//
// Two shapes: native Anthropic (/v1/messages) and OpenAI-compatible
// (/v1/chat/completions, base_url-overridable — covers OpenAI, OpenRouter,
// Together, Groq, Regolo, Scaleway, Ollama, LM Studio, vLLM, …). The full
// inference router adopts the same split when the outbound widening (S3) lands;
// this probe is the seed.

import { assertSafeBaseUrl } from './base-url.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const OPENAI_DEFAULT = 'https://api.openai.com';

/**
 * @param {object} opts
 * @param {string} opts.provider           'anthropic'|'claude'|'openai'|'custom'|…
 * @param {string} [opts.baseUrl]          OpenAI-compatible endpoint override
 * @param {string} [opts.model]            model id to probe
 * @param {string} [opts.apiKey]           the user's key (never logged)
 * @param {typeof fetch} [opts.fetch]
 * @param {number} [opts.timeoutMs=15000]
 * @returns {Promise<{ok:boolean,status?:number,error?:string}>}  category only
 */
export async function probeProvider({ provider, baseUrl, model, apiKey, fetch = globalThis.fetch, timeoutMs = 15000 } = {}) {
  if (typeof fetch !== 'function') return { ok: false, error: 'no_fetch' };
  const isAnthropic = provider === 'anthropic' || provider === 'claude';
  const isLocal = /127\.0\.0\.1|localhost|\[::1\]/.test(baseUrl || '');
  // Hosted providers require a key; a local OpenAI-compatible server (Ollama /
  // LM Studio) usually does not.
  if (!apiKey && !isLocal) return { ok: false, error: 'no_key' };
  if (provider === 'custom' && !baseUrl) return { ok: false, error: 'no_base_url' };
  // SSRF + exfil guard (H5): refuse to probe a private/internal or non-http(s)
  // base_url with the user's key. Category-only error, never the key/host.
  if (!isAnthropic) { try { assertSafeBaseUrl(baseUrl); } catch { return { ok: false, error: 'invalid_base_url' }; } }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let url, headers, body;
    if (isAnthropic) {
      url = ANTHROPIC_URL;
      headers = { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION };
      body = { model: model || 'claude-sonnet-4-6', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] };
    } else {
      const base = (baseUrl || OPENAI_DEFAULT).replace(/\/+$/, '');
      // base_url may already end at /v1 (the OpenAI-compatible convention) or not.
      url = /\/v1$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
      headers = { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
      body = { model: model || 'gpt-4o-mini', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] };
    }
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    if (r.ok) return { ok: true, status: r.status };
    // Category only — NEVER the provider's error body (it can echo request content).
    if (r.status === 401 || r.status === 403) return { ok: false, error: 'auth_rejected', status: r.status };
    if (r.status === 404) return { ok: false, error: 'not_found', status: r.status };
    if (r.status === 429) return { ok: false, error: 'rate_limited', status: r.status };
    return { ok: false, error: 'provider_error', status: r.status };
  } catch (err) {
    return { ok: false, error: err?.name === 'AbortError' ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

export default probeProvider;
