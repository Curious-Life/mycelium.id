// src/inference/model-profile.js — resolve a model's REAL limits + capabilities.
//
// The single source of truth a generation caller asks "what can THIS model do,
// how big can input/output be" before sizing a request (token-budget.js). Layered
// + fail-soft + cached — a probe/registry miss degrades to a conservative class
// default; this NEVER throws into the caller and NEVER blocks generation.
//
// Resolution order:
//   1. Runtime probe (LOCAL only): POST Ollama /api/show → real context_length +
//      capabilities[]. The /api/show machinery already exists in model-caps.js for
//      vision/audio picking; here we also consume model_info.<arch>.context_length,
//      which that path throws away.
//   2. Static registry (model-registry.js): authoritative for CLOUD; fallback for
//      LOCAL when Ollama is unreachable / too old to report model_info.
//   3. Conservative class defaults: local {8192/1024}, cloud {32768/4096}.
//
// Carries NO secrets — only model name, numeric limits, capability booleans,
// provenance. Safe to log / surface in diagnostics. See
// docs/TEXT-GENERATION-ABSTRACTION-DESIGN-2026-06-15.md.

import { DEFAULT_OLLAMA_URL } from './local.js';
import { lookupModel } from './model-registry.js';

/**
 * @typedef {{
 *   model: string,
 *   isLocal: boolean,
 *   family: string,
 *   contextWindow: number,
 *   maxOutputTokens: number,
 *   capabilities: { tools:boolean, vision:boolean, thinking:boolean, jsonFormat:boolean },
 *   source: 'probe'|'registry'|'default'
 * }} ModelProfile
 */

// Conservative class defaults (fail-safe — never an over-large guess).
const LOCAL_DEFAULT = Object.freeze({ contextWindow: 8192, maxOutputTokens: 1024 });
const CLOUD_DEFAULT = Object.freeze({ contextWindow: 32768, maxOutputTokens: 4096 });

// Cache resolved profiles per (baseUrl|model). Installs/keys change rarely; a boot
// re-probes. Mirrors model-caps.js: cache POSITIVE results; a probe that fell back
// to default is NOT cached (Ollama may have just been busy) so the next call retries.
const cache = new Map();

/** test seam */
export function _resetModelProfileCache() { cache.clear(); }

const LOOPBACK_RE = /(?:\/\/)?(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])/;

/** Decide local vs cloud + the effective model id from a resolveInferenceConfig() cfg. */
function shapeOf(cfg = {}, defaultModel) {
  if (cfg.anthropicApiKey) {
    return { isLocal: false, model: cfg.cloudModel || defaultModel || 'claude-sonnet-4-6' };
  }
  const isLocal = cfg.jurisdiction === 'local' || (!!cfg.baseUrl && LOOPBACK_RE.test(cfg.baseUrl));
  if (cfg.openaiApiKey || cfg.baseUrl) {
    return { isLocal, model: cfg.cloudModel || defaultModel || (isLocal ? 'llama3.1' : 'gpt-4o') };
  }
  // No provider configured → the on-box local floor.
  return { isLocal: true, model: cfg.cloudModel || defaultModel || 'llama3.1' };
}

/** Pull the context window out of Ollama /api/show's model_info (key ends `.context_length`). */
function contextLengthFromShow(show) {
  const info = show?.model_info;
  if (info && typeof info === 'object') {
    for (const [k, v] of Object.entries(info)) {
      if (/\.context_length$/.test(k) && Number.isFinite(v) && v > 0) return Math.floor(v);
    }
  }
  return null;
}

async function probeOllama(model, baseUrl, fetchImpl, timeoutMs) {
  if (typeof fetchImpl !== 'function') return null;
  const base = String(baseUrl || DEFAULT_OLLAMA_URL).replace(/\/+$/, '').replace(/\/v1$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${base}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: controller.signal,
    });
    if (!res || !res.ok) return null;
    const show = await res.json().catch(() => null);
    if (!show) return null;
    const ctx = contextLengthFromShow(show);
    const caps = Array.isArray(show.capabilities) ? show.capabilities : [];
    if (!ctx && !caps.length) return null; // nothing useful (old Ollama)
    return { contextLength: ctx, capabilities: caps };
  } catch {
    return null; // Ollama down / busy / timeout → fall to registry
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve a ModelProfile for a provider config.
 * @param {object} cfg            resolveInferenceConfig() result ({} = local floor)
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetch]
 * @param {boolean} [opts.probe=true]      probe local Ollama (off in pure unit paths)
 * @param {string} [opts.defaultModel]     caller's no-preference default (chat=opus, enrich=sonnet)
 * @param {string} [opts.baseUrl]          override the Ollama base for the probe
 * @param {number} [opts.timeoutMs=2500]
 * @returns {Promise<ModelProfile>}
 */
export async function resolveModelProfile(cfg = {}, { fetch: fetchImpl = globalThis.fetch, probe = true, defaultModel, baseUrl, timeoutMs = 2500 } = {}) {
  const { isLocal, model } = shapeOf(cfg, defaultModel);
  const probeBase = baseUrl || cfg.baseUrl || DEFAULT_OLLAMA_URL;
  const key = `${isLocal ? probeBase : 'cloud'}|${model}`;
  if (cache.has(key)) return cache.get(key);

  const reg = lookupModel(model);
  const family = reg?.family || (isLocal ? 'local' : 'cloud');
  let source = 'default';
  let contextWindow = (isLocal ? LOCAL_DEFAULT : CLOUD_DEFAULT).contextWindow;
  let maxOutputTokens = (isLocal ? LOCAL_DEFAULT : CLOUD_DEFAULT).maxOutputTokens;
  const capabilities = {
    tools: !isLocal,        // cloud assumed tool-capable; local proven by probe
    vision: false,
    thinking: false,
    jsonFormat: true,       // Ollama format:json + cloud structured output both support it
  };

  if (reg) {
    source = 'registry';
    contextWindow = reg.contextWindow;
    maxOutputTokens = reg.maxOutput;
    if (/claude|gpt-4o|gpt-4\.1|o3/.test(model.toLowerCase())) capabilities.vision = true;
    if (/claude|o3/.test(model.toLowerCase())) capabilities.thinking = true;
  }

  // Runtime probe wins for LOCAL: real window + real capability flags.
  if (isLocal && probe) {
    const info = await probeOllama(model, probeBase, fetchImpl, timeoutMs);
    if (info) {
      source = 'probe';
      if (info.contextLength) contextWindow = info.contextLength;
      const caps = info.capabilities;
      capabilities.tools = caps.includes('tools');
      capabilities.vision = caps.includes('vision');
      capabilities.thinking = caps.includes('thinking');
      // Ollama has no separate output cap → reserve at most half the window for output.
      maxOutputTokens = Math.min(maxOutputTokens, Math.max(512, Math.floor(contextWindow / 2)));
    }
  }

  // Never claim output larger than (window - a question's worth of input).
  maxOutputTokens = Math.max(1, Math.min(maxOutputTokens, contextWindow - 256));

  const profile = Object.freeze({ model, isLocal, family, contextWindow, maxOutputTokens, capabilities: Object.freeze(capabilities), source });
  // Cache CLOUD always (no probe to retry — registry/default are stable). Cache
  // LOCAL only when it came from a real probe: a local registry/default result means
  // Ollama was unreachable/busy, so re-probe next call (model-caps.js philosophy).
  if (!isLocal || source === 'probe') cache.set(key, profile);
  return profile;
}

export default resolveModelProfile;
