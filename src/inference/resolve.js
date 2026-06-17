// src/inference/resolve.js — the credential-store → inference-router seam (S2/S3).
//
// Connects the BYOK provider store (the /portal/providers UI writes `ai_providers`)
// to the outbound inference router, replacing the env-only path, and tags the
// chosen provider with a jurisdiction (§4g) for the egress policy.
//
// The active provider the user chose in Settings is authoritative over env: when
// one is configured we return BOTH cloud-key fields (the chosen vendor's key + ''
// for the other) so a stray env key can't override the explicit choice
// (createInferenceRouter only falls back to env when a field is `undefined`, not
// when it is '').
//
// Mapping:
//   - native Anthropic (`anthropic`|`claude`, no base_url) → anthropicApiKey
//   - native OpenAI (`openai`, no base_url)               → openaiApiKey
//   - ANY base_url provider (`custom` / EU-sovereign / OpenRouter / Ollama / … or
//     an `openai` row carrying a base_url) → openaiApiKey + baseUrl, via the cloud
//     backend's OpenAI-compatible path. Key optional (local servers are keyless).
// Each result carries `jurisdiction` (local|eu-zdr|us-zdr|us-standard).

import { jurisdictionForBaseUrl } from './presets.js';

function parseApiKey(credentials) {
  if (typeof credentials !== 'string' || credentials.length === 0) return null;
  try { const o = JSON.parse(credentials); return typeof o?.apiKey === 'string' && o.apiKey ? o.apiKey : null; }
  catch { return null; }
}

/**
 * Resolve the active provider into inference-router options.
 * @param {object} db        the assembled vault db (needs db.providers)
 * @param {string} userId
 * @returns {Promise<{anthropicApiKey?:string, openaiApiKey?:string, baseUrl?:string, cloudModel?:string, jurisdiction?:string}>}
 *   Router opts. Empty object → the router falls back to env, else local Ollama.
 *   Never includes the raw credentials blob.
 */
/** Map one `ai_providers` row → router opts, or null if it can't be a cloud provider. */
function mapRowToConfig(row) {
  const key = parseApiKey(row.credentials);
  const model = row.model_preference || undefined;
  const provider = String(row.provider || '').toLowerCase();
  const baseUrl = row.base_url || undefined;
  // Carry the row's own label so the chat chip names the REAL provider (e.g.
  // "Regolo.ai") instead of guessing "OpenAI" from the presence of a key.
  const label = (typeof row.label === 'string' && row.label.trim()) ? row.label.trim() : undefined;
  // Native Anthropic (no base_url).
  if (key && !baseUrl && (provider === 'anthropic' || provider === 'claude')) {
    return { anthropicApiKey: key, openaiApiKey: '', cloudModel: model, jurisdiction: jurisdictionForBaseUrl(undefined, provider), label, providerName: provider };
  }
  // OpenAI-compatible: native OpenAI, or ANY base_url provider.
  if (baseUrl || (key && provider === 'openai')) {
    return { anthropicApiKey: '', openaiApiKey: key || '', baseUrl: baseUrl || undefined, cloudModel: model, jurisdiction: jurisdictionForBaseUrl(baseUrl, provider), label, providerName: provider };
  }
  return null;
}

export async function resolveInferenceConfig(db, userId) {
  try {
    const active = await db?.providers?.getActive?.(userId); // most-recently-used active row, or null
    if (active) { const cfg = mapRowToConfig(active); if (cfg) return cfg; }
  } catch { /* fail-soft: fall back to env/local */ }
  return {}; // router reads env (ANTHROPIC_API_KEY / OPENAI_API_KEY) when unset
}

// Inference tasks the user can route to a specific provider/model (Settings →
// Intelligence). Unlisted tasks (or no assignment) fall back to the ACTIVE provider.
export const INFERENCE_TASKS = ['chat', 'narrate', 'harness'];

/**
 * Resolve the provider/model for a SPECIFIC task. Reads the per-task assignment
 * from users.settings.taskModels[task] = { providerId, model? }, loads that
 * provider row, and (optionally) overrides its model. Falls back to the ACTIVE
 * provider (resolveInferenceConfig) when no assignment exists or it's
 * unresolvable — so this is always safe to use in place of resolveInferenceConfig.
 */
export async function resolveInferenceConfigForTask(db, userId, task) {
  try {
    const settings = await db?.users?.getSettings?.(userId);
    const a = settings?.taskModels?.[task];
    if (a && a.providerId != null) {
      let row = await db?.providers?.get?.(a.providerId, userId);
      if (row) {
        if (a.model) row = { ...row, model_preference: a.model }; // per-task model override
        const cfg = mapRowToConfig(row);
        if (cfg) return cfg;
      }
    }
  } catch { /* fail-soft → active provider */ }
  return resolveInferenceConfig(db, userId);
}

// §4g cascade priority (operator decision): EU-sovereign ZDR → frontier (US) →
// local. Sensitive requests drop US providers entirely.
const JURISDICTION_RANK = (j) => (j === 'eu-zdr' ? 0 : j === 'local' ? 2 : 1);

/**
 * Resolve ALL configured providers into an ORDERED cascade of router opts:
 * eu-zdr → us-* (frontier) → local, with an on-box local fallback ALWAYS last.
 * A `sensitive` request omits every us-* provider (§4g hard-block). Each element
 * is the same shape resolveInferenceConfig returns; the trailing `{}`-like local
 * element makes the router fall through to on-box Ollama as the guaranteed floor.
 * @param {object} db
 * @param {string} userId
 * @param {{sensitive?:boolean}} [opts]
 * @returns {Promise<Array<object>>}
 */
export async function resolveProviderChain(db, userId, { sensitive = false } = {}) {
  const cloud = [];
  try {
    const rows = (await db?.providers?.list?.(userId)) || []; // list() omits credentials…
    for (const r of rows) {
      const full = await db.providers.get(r.id, userId); // …so fetch the full row for the key
      const cfg = full ? mapRowToConfig(full) : null;
      if (!cfg) continue;
      if (sensitive && /^us/.test(cfg.jurisdiction || 'us-standard')) continue; // §4g: never cascade sensitive → US
      cloud.push(cfg);
    }
    cloud.sort((a, b) => JURISDICTION_RANK(a.jurisdiction) - JURISDICTION_RANK(b.jurisdiction));
  } catch { /* fail-soft */ }
  // Guaranteed final fallback: on-box local Ollama (empty cloud cfg → router goes local).
  return [...cloud, { jurisdiction: 'local', localFallback: true }];
}

export default resolveInferenceConfig;
