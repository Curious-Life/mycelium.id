// src/inference/models.js — list a provider's available models, so the
// Settings → Intelligence "connect" form can auto-populate the model dropdown
// (spec #9) instead of making the user type a model id by hand. Mirrors the two
// request shapes in probe.js: native Anthropic (GET /v1/models, x-api-key) and
// OpenAI-compatible (GET {base}/models, Bearer — covers OpenAI, OpenRouter,
// Together, Groq, Regolo, Scaleway, Ollama, LM Studio, …).
//
// SECURITY: the user's key is used for the listing call and NEVER logged or
// echoed. Errors are a CATEGORY only (never the provider's body). The base_url is
// SSRF-guarded before any fetch with the key (H5), same as probe.js.

import { assertSafeBaseUrl, fetchProvider } from './base-url.js';

const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models';
const ANTHROPIC_VERSION = '2023-06-01';
const OPENAI_DEFAULT = 'https://api.openai.com';

/**
 * @param {object} opts
 * @param {string} opts.provider          'anthropic'|'claude'|'openai'|'custom'|…
 * @param {string} [opts.baseUrl]         OpenAI-compatible endpoint override
 * @param {string} [opts.apiKey]          the user's key (never logged)
 * @param {typeof fetch} [opts.fetch]
 * @param {number} [opts.timeoutMs=12000]
 * @returns {Promise<{ok:boolean, models?:string[], error?:string, status?:number}>}
 */
export async function listModels({ provider, baseUrl, apiKey, fetch = globalThis.fetch, timeoutMs = 12000 } = {}) {
  if (typeof fetch !== 'function') return { ok: false, error: 'no_fetch' };
  const isAnthropic = provider === 'anthropic' || provider === 'claude';
  const isLocal = /127\.0\.0\.1|localhost|\[::1\]/.test(baseUrl || '');
  // Hosted providers usually need a key to list; a local OpenAI-compatible server
  // (Ollama / LM Studio) does not. OpenRouter happens to list without a key too,
  // so we don't hard-require one here — let the provider decide (401 → auth_rejected).
  if (!apiKey && !isLocal && !isAnthropic && !baseUrl) return { ok: false, error: 'no_key' };
  // SSRF + exfil guard (H5): refuse to fetch a private/internal or non-http(s)
  // base_url with the user's key. Category-only error, never the key/host.
  if (!isAnthropic) { try { assertSafeBaseUrl(baseUrl); } catch { return { ok: false, error: 'invalid_base_url' }; } }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let url, headers;
    if (isAnthropic) {
      url = ANTHROPIC_MODELS_URL;
      headers = { 'x-api-key': apiKey || '', 'anthropic-version': ANTHROPIC_VERSION };
    } else {
      const base = (baseUrl || OPENAI_DEFAULT).replace(/\/+$/, '');
      // base_url may already end at /v1 (the OpenAI-compatible convention) or not.
      url = /\/v1$/.test(base) ? `${base}/models` : `${base}/v1/models`;
      headers = { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
    }
    // Use-time SSRF pin (defeats DNS rebinding the literal assertSafeBaseUrl
    // can't): resolve-public + connection-pin for hostnames; loopback/local
    // providers fetch directly. Honors the injected `fetch` test seam.
    const r = await fetchProvider(url, { method: 'GET', headers, signal: ctrl.signal, fetch });
    if (!r.ok) {
      if (r.status === 401 || r.status === 403) return { ok: false, error: 'auth_rejected', status: r.status };
      if (r.status === 404) return { ok: false, error: 'not_found', status: r.status };
      if (r.status === 429) return { ok: false, error: 'rate_limited', status: r.status };
      return { ok: false, error: 'provider_error', status: r.status };
    }
    const j = await r.json().catch(() => null);
    // OpenAI / Anthropic / OpenRouter: { data: [{ id }] }; some servers: { models: [...] }.
    const arr = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : [];
    const models = arr
      .map((m) => (typeof m === 'string' ? m : m?.id || m?.name))
      .filter((m) => typeof m === 'string' && m);
    return { ok: true, models: [...new Set(models)] };
  } catch (err) {
    return { ok: false, error: err?.name === 'AbortError' ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

export default listModels;
