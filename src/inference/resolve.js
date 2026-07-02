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

function parseCredentials(credentials) {
  if (typeof credentials !== 'string' || credentials.length === 0) return null;
  try { return JSON.parse(credentials); } catch { return null; }
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
  const creds = parseCredentials(row.credentials);
  const key = (typeof creds?.apiKey === 'string' && creds.apiKey) ? creds.apiKey : null;
  const model = row.model_preference || undefined;
  const provider = String(row.provider || '').toLowerCase();
  const authType = String(row.auth_type || '').toLowerCase();
  const baseUrl = row.base_url || undefined;
  // Carry the row's own label so the chat chip names the REAL provider (e.g.
  // "Regolo.ai") instead of guessing "OpenAI" from the presence of a key.
  const label = (typeof row.label === 'string' && row.label.trim()) ? row.label.trim() : undefined;
  // Claude subscription (OAuth token) — provider anthropic/claude, auth_type 'oauth',
  // credentials carrying a claudeOAuthToken (sk-ant-oat…). Routed through the same
  // anthropicAdapter, but anthropic-wire swaps in Bearer + Claude-Code identity
  // headers + the "You are Claude Code" preamble (anthropicAuthFromCfg keys on this
  // field). US jurisdiction like any Anthropic provider. See docs/CLAUDE-SUBSCRIPTION-
  // DRIVER-DESIGN-2026-06-26.md (Phase S).
  const token = (typeof creds?.claudeOAuthToken === 'string' && creds.claudeOAuthToken) ? creds.claudeOAuthToken : null;
  if (token && !baseUrl && (authType === 'oauth' || provider === 'claude_subscription' || provider === 'anthropic' || provider === 'claude')) {
    return { claudeOAuthToken: token, anthropicApiKey: '', openaiApiKey: '', cloudModel: model, jurisdiction: jurisdictionForBaseUrl(undefined, 'anthropic'), label: label || 'Claude (subscription)', providerName: 'claude_subscription' };
  }
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
    if (active) {
      const cfg = mapRowToConfig(active);
      if (cfg) { await applySensitiveExempt(db, userId, cfg); return cfg; }
    }
  } catch { /* fail-soft: fall back to env/local */ }
  return {}; // router reads env (ANTHROPIC_API_KEY / OPENAI_API_KEY) when unset
}

// §4g opt-in: by default sensitive content (persona/claim abstractions) never
// egresses to a US provider. If the cfg IS the user's own Claude subscription AND
// they've explicitly enabled allowSubscriptionSensitive, mark it exempt so the
// router lets sensitive content reach it. NEVER applied to a plain US API key.
async function applySensitiveExempt(db, userId, cfg) {
  if (cfg?.providerName !== 'claude_subscription') return;
  try {
    if ((await db?.users?.getSettings?.(userId))?.allowSubscriptionSensitive === true) cfg.sensitiveUsExempt = true;
  } catch { /* default: not exempt */ }
}

// Inference tasks the user can route to a specific provider/model (Settings →
// Intelligence). Unlisted tasks (or no assignment) fall back to the ACTIVE provider.
//
// 'categorize' (L1 per-message labeling) and 'enrich' (L2 per-message semantic entities + gist)
// are ON-BOX by design — bulk (every message) + privacy-sensitive + cost-prohibitive on cloud —
// so unlike the other tasks their assignment selects a LOCAL model NAME (settings.taskModels
// .{categorize,enrich}.model), not a cloud provider. The drainer resolves them directly and
// defaults to DEFAULT_LABEL_MODEL (categories.js); it never routes message-level work to cloud.
// 'narrate' (mindscape names + chronicles) is the narrative tier → route it to cloud (e.g. Regolo).
export const INFERENCE_TASKS = ['chat', 'narrate', 'harness', 'reflection', 'categorize', 'enrich'];

// ON-BOX tasks select a LOCAL Ollama model NAME (no cloud provider row). Their per-task
// assignment is stored as { model } in settings.taskModels[task] and resolved directly by
// the owning pipeline (the drainer for 'categorize'), NOT through resolveInferenceConfigForTask.
// Kept here so the PUT /providers/task-models endpoint and the resolver agree on which tasks
// are local-name-only. 'enrich' (L2) is on-box for the SAME reasons as 'categorize' (the
// drainer resolves it via defaultEnrichModel → a local model NAME); it MUST be in this set or
// the PUT endpoint mis-stores it as a cloud { providerId } that the drainer never reads.
export const ONBOX_TASKS = new Set(['categorize', 'enrich']);

/**
 * Resolve the LOCAL model NAME a user assigned to an on-box task (categorize/enrich),
 * or `fallback` when unset. Single source for the drainer (L1/L2) AND the narrate
 * router's on-box fallback model — so a cloud-narrate failure degrades to the small
 * local model the user actually chose, never the generic DEFAULT_LOCAL_MODEL. Fail-soft.
 */
export async function resolveOnBoxModel(db, userId, task, fallback) {
  try {
    const s = await db?.users?.getSettings?.(userId);
    const m = s?.taskModels?.[task]?.model;
    if (typeof m === 'string' && m.trim()) return m.trim();
  } catch { /* fail-soft → fallback */ }
  return fallback;
}

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
  // §4g opt-in (only consulted for sensitive requests): keep the user's own Claude
  // subscription in the chain even though it's US, when they've explicitly enabled it.
  let allowSubSensitive = false;
  if (sensitive) {
    try { allowSubSensitive = (await db?.users?.getSettings?.(userId))?.allowSubscriptionSensitive === true; } catch { /* default off */ }
  }
  try {
    const rows = (await db?.providers?.list?.(userId)) || []; // list() omits credentials…
    for (const r of rows) {
      const full = await db.providers.get(r.id, userId); // …so fetch the full row for the key
      const cfg = full ? mapRowToConfig(full) : null;
      if (!cfg) continue;
      if (sensitive && /^us/.test(cfg.jurisdiction || 'us-standard')) {
        // §4g: never cascade sensitive → US, EXCEPT the opted-in subscription (mark it exempt).
        if (allowSubSensitive && cfg.providerName === 'claude_subscription') cfg.sensitiveUsExempt = true;
        else continue;
      }
      cloud.push(cfg);
    }
    cloud.sort((a, b) => JURISDICTION_RANK(a.jurisdiction) - JURISDICTION_RANK(b.jurisdiction));
  } catch { /* fail-soft */ }
  // Guaranteed final fallback: on-box local Ollama (empty cloud cfg → router goes local).
  return [...cloud, { jurisdiction: 'local', localFallback: true }];
}

export default resolveInferenceConfig;
