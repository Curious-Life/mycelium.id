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
import { subscriptionTokenFrom } from './subscription-token.js';
import { importFromClaudeCli } from './claude-oauth.js';
import { readClaudeConfigDirLiveToken, refreshClaudeConfigDirToken } from './claude-config-dir.js';

// ── Live Claude-subscription token refresh (fix: native chat "load failed") ──────
// The subscription oauth token is captured into the DB row at CONNECT time, but the
// `claude` CLI refreshes the REAL token continuously in ~/.claude/.credentials.json /
// the macOS Keychain. So the stored copy goes stale within hours → the native wire
// sends an expired Bearer → Anthropic 401 → the chat SSE closes → the browser shows
// "load failed" (while the Claude Code engine kept working because it delegates to
// `claude`, which holds the live token). Verified by spike: a FRESH keychain token
// streams fine through our own anthropic-wire — the wire was never the problem.
//
// Fix: for a subscription provider, prefer the LIVE token (keychain/disk), briefly
// cached so we don't spawn `security` every turn, and fail-closed to the stored token
// when `claude` isn't present/logged-in. Reading the token `claude` already refreshed
// is NOT an OAuth refresh flow (V1 does none) — it's the "re-import from disk" seam.
let _tokCache = { token: null, at: 0 };
let _negAt = 0;
const TOKEN_TTL_MS = 60_000;
const NEG_TTL_MS = 10_000;
// Prefer the app's ISOLATED config-dir token (the one `claude` keeps refreshed for the CONNECTED
// subscription) over the machine's ~/.claude / Keychain login — so the native harness authenticates
// as the account the user connected, not whatever the machine is signed into.
//
// CRITICAL (fixed 2026-07-07): on macOS `claude` keeps the refreshed token in a config-dir-
// NAMESPACED Keychain item, not in <dir>/.credentials.json — so the old file-only read returned a
// token frozen at connect-time. An expired Bearer 401'd and the provider-fallback chain silently
// served channel turns from local/EU qwen while the feed still showed claude-opus-4-8.
// readClaudeConfigDirLiveToken reads the namespaced store (expiry-aware); when even that has lapsed
// (an owner who only uses channels, so no CLI turn refreshed it), ask `claude` to refresh its own
// token (ToS-clean, #10) before falling back to the machine login.
async function _defaultReader() {
  let t = await readClaudeConfigDirLiveToken();
  if (t) return { claudeOAuthToken: t };
  t = await refreshClaudeConfigDirToken();
  if (t) return { claudeOAuthToken: t };
  return importFromClaudeCli();
}
let _reader = _defaultReader;        // overridable so verify:* is deterministic (no live keychain)

/** Read the live subscription token (cached TTL_MS). `read` overrides the default reader.
 *  NOTE: the cache is checked BEFORE the reader, so a warm cache short-circuits an
 *  explicitly-passed `read` — intended for prod (all call sites use the default reader);
 *  tests that inject a reader call _resetTokenCacheForTests() between cases. */
export async function freshClaudeSubscriptionToken(read = _reader, now = Date.now()) {
  if (_tokCache.token && (now - _tokCache.at) < TOKEN_TTL_MS) return _tokCache.token;
  // Short-lived NEGATIVE cache: withFreshSubscriptionToken runs ≥3×/turn (label + inference +
  // provider-chain). When the token is unresolved (needs refresh), the default reader spawns
  // `security`/`claude` each call; without this, a single degraded turn spawns them repeatedly.
  if (_negAt && (now - _negAt) < NEG_TTL_MS) return null;
  try {
    const creds = await read();
    const t = (typeof creds?.claudeOAuthToken === 'string' && creds.claudeOAuthToken) ? creds.claudeOAuthToken : null;
    if (t) { _tokCache = { token: t, at: now }; _negAt = 0; return t; }
  } catch { /* no live token → caller keeps the stored one (fail-closed) */ }
  _negAt = now;
  return null;
}

/** If cfg is the user's Claude subscription, swap in the live token; else pass through. */
export async function withFreshSubscriptionToken(cfg, read) {
  if (!cfg || cfg.providerName !== 'claude_subscription') return cfg;
  const fresh = await freshClaudeSubscriptionToken(read);
  if (fresh) cfg.claudeOAuthToken = fresh;
  return cfg;
}

/**
 * Drop the short-lived subscription-token cache so the NEXT resolve reads the live token fresh.
 * Called on an EXPLICIT reconnect (persistSubscription) so the new credential takes effect at once
 * rather than after the TTL — otherwise a token cached moments before the reconnect could keep
 * serving the native path for up to TOKEN_TTL_MS (D-021: reconnect must be immediate on BOTH the
 * native and CLI paths). Same effect as the test seam, production-named for a non-test caller. */
export function invalidateSubscriptionTokenCache() { _tokCache = { token: null, at: 0 }; _negAt = 0; }

/** Test seams — clear the cache / swap the live-token reader between cases. */
export function _resetTokenCacheForTests() { _tokCache = { token: null, at: 0 }; _negAt = 0; }
export function _setSubscriptionTokenReaderForTests(fn) { _reader = fn || _defaultReader; _resetTokenCacheForTests(); }

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
  // status='pending' → NOT resolvable. This is the one chokepoint every RESOLVER
  // shares (resolveInferenceConfig, resolveInferenceConfigForTask, resolveProviderChain),
  // so a pending row is unreachable to inference rather than merely unflagged.
  //
  // ⚠️ SCOPE, precisely: this covers RESOLUTION, not every read of the row. A route that
  // reads `ai_providers` directly does NOT pass through here and must make its own
  // decision about pending — GET /providers/:id/models was exactly that gap (it fetched
  // a pending row's base_url; now guarded at portal-providers.js). Said as "the ONE
  // chokepoint" this comment overclaimed, which is the recurring failure in this area:
  // the control is real where it is STATED and absent where the row is REACHABLE FROM.
  // Any NEW reader of ai_providers must decide about 'pending' explicitly.
  //
  // WHY: a restored `ai_providers` row is executable egress config, and `is_active` is
  // NOT sufficient to disarm it — resolveProviderChain enumerates EVERY row (fallback
  // cascade, by design) and resolveInferenceConfigForTask takes a providerId straight
  // out of users.settings. Worse, a bare `base_url` needs no credential at all to
  // resolve (see the OpenAI-compatible branch below), so an imported row could egress
  // the prompt keylessly. restoreTable lands every imported provider 'pending'.
  //
  // NO-OP FOR EXISTING VAULTS (the reason this is safe to add to live inference): no
  // CODE PATH writes 'pending' — db/providers.js create() hardcodes 'active', and the
  // only other status writer (the /providers/:id/test probe) writes 'active'/'error'.
  // The schema DEFAULT at migrations/0001_init.sql:130 IS a writer, reachable by an
  // INSERT omitting the column: pre-2026-07-16 restoreTable did exactly that for a
  // manifest row lacking `status`, so an old hand-built import could have left 'pending'
  // rows that resolved fine. Migration 0050 backfills those to 'active' — they predate
  // this control and were already live; silently disabling them would be the regression.
  //
  // ⚠️ WRITERS ARE THE SOFT SPOT, NOT READERS. This guards every READ (all three
  // resolvers funnel through here), so an attack moves to whatever can WRITE the column.
  // That was a real bypass: /providers/:id/test flipped pending→active (or →'error',
  // which also escapes this refusal) on a click the UI calls "Test" — it now refuses to
  // promote a pending row. Any NEW status writer must make the same decision explicitly.
  if (String(row?.status || '').toLowerCase() === 'pending') return null;
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
  // field). US jurisdiction like any Anthropic provider. See the Claude-subscription
  // driver design (Phase S).
  // Prefer the current key; fall back to older shapes an earlier build may have stored
  // (raw `accessToken`, or the nested `claudeAiOauth.accessToken` from ~/.claude/.credentials.json)
  // so a subscription connected on an old build still resolves instead of failing to null.
  // Shared with the import filter (subscription-token.js) — if this widens to accept
  // a new token shape, the importer must refuse that shape in the same breath.
  const token = subscriptionTokenFrom(creds);
  if (token && !baseUrl && (authType === 'oauth' || provider === 'claude_subscription' || provider === 'anthropic' || provider === 'claude')) {
    return { claudeOAuthToken: token, anthropicApiKey: '', openaiApiKey: '', baseUrl: '', cloudModel: model, jurisdiction: jurisdictionForBaseUrl(undefined, 'anthropic'), label: label || 'Claude (subscription)', providerName: 'claude_subscription' };
  }
  // Native Anthropic (no base_url).
  if (key && !baseUrl && (provider === 'anthropic' || provider === 'claude')) {
    return { anthropicApiKey: key, openaiApiKey: '', baseUrl: '', cloudModel: model, jurisdiction: jurisdictionForBaseUrl(undefined, provider), label, providerName: provider };
  }
  // OpenAI-compatible: native OpenAI, or ANY base_url provider.
  if (baseUrl || (key && provider === 'openai')) {
    // `baseUrl: baseUrl || ''` — NOT `|| undefined`. A native-OpenAI row (no base_url) used to
    // arrive `undefined`, which router.js coalesced to env.INFERENCE_BASE_URL: the user's real
    // OpenAI key was then POSTed to an env-named host, while `jurisdiction` still described the
    // row's (absent) base_url. Same class as the cascade floor, but this one needed no feature
    // flag. '' is falsy, so cloud.js#resolveChatUrl still defaults to the real OpenAI endpoint.
    return { anthropicApiKey: '', openaiApiKey: key || '', baseUrl: baseUrl || '', cloudModel: model, jurisdiction: jurisdictionForBaseUrl(baseUrl, provider), label, providerName: provider };
  }
  return null;
}

export async function resolveInferenceConfig(db, userId) {
  // The try/catch is the FAIL-SOFT boundary, and it must stay OUTSIDE the arming steps.
  // resolveEffectiveAssignment guards its own reads, but applySensitiveExempt and
  // withFreshSubscriptionToken are outside it — a throw in either (a keychain read, a settings
  // read) must degrade to "no cloud provider" the way it always has, not propagate into every
  // caller of the resolver. An earlier draft of this refactor narrowed the boundary to the
  // lookup only (independent review, LOW).
  try {
    const eff = await resolveEffectiveAssignment(db, userId, null);
    if (eff.cfg) { await applySensitiveExempt(db, userId, eff.cfg); return withFreshSubscriptionToken(eff.cfg); }
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

// §4g task sensitivity lives in a LEAF module (router.js needs it too, and must not pull this
// file's claude-oauth/keychain graph in). Re-exported here so it is discoverable next to
// INFERENCE_TASKS / ONBOX_TASKS — the other two task taxonomies.
export { SENSITIVE_TASKS, isSensitiveTask } from './sensitivity.js';

// ── WHERE THE ON-BOX MODEL NAMES ARE READ ────────────────────────────────────
// NOT here. `settings.taskModels.{categorize,enrich}.model` has exactly TWO readers, both in
// src/enrich/drainer.js: defaultLabelModel (categorize) and defaultEnrichModel (enrich).
//
// ⚠️ DO NOT ADD A THIRD. This file used to export `resolveOnBoxModel(db,userId,task,fallback)`
// — a second reader of the SAME key that disagreed with the drainer about what SILENCE means:
// the drainer returns null (unset ⇒ NOT approved), while this one returned `fallback` on unset
// AND on a settings-read throw. Under increment M (#148) that key is not a preference, it is
// the OWNER'S APPROVAL to download and run a model, so "fail-soft to a sensible default" is
// literally "assume consent" — and its one caller (pipeline/lib/narrate-infer.js) passed
// labelingRecommendedModel(), turning a RECOMMENDATION into a silent RUN of qwen3.5:4b on a
// vault that never approved it. Sharpest case: an owner who picks "Off" — portal-providers.js
// DELETES the key, and a fail-open read reinstates the model they just declined.
// Retired 2026-07-16; a fail-open resolver next to a fail-closed one is a trap, not an option.
// If a new caller needs an approved on-box model, IMPORT the drainer's reader — one key, one
// reader, one meaning for silence.

/**
 * Resolve the provider/model for a SPECIFIC task. Reads the per-task assignment
 * from users.settings.taskModels[task] = { providerId, model? }, loads that
 * provider row, and (optionally) overrides its model. Falls back to the ACTIVE
 * provider (resolveInferenceConfig) when no assignment exists or it's
 * unresolvable — so this is always safe to use in place of resolveInferenceConfig.
 */
export async function resolveInferenceConfigForTask(db, userId, task) {
  try {
    return await _forTask(db, userId, task);
  } catch { return {}; }   // same fail-soft boundary as resolveInferenceConfig (see its note)
}
async function _forTask(db, userId, task) {
  const eff = await resolveEffectiveAssignment(db, userId, task);
  // §4g exemption on EVERY branch. It used to be applied only by resolveInferenceConfig (the
  // active-provider fallback), so a subscription assigned to a task explicitly — Settings →
  // Intelligence → narrate → Claude — never got marked exempt, while the SAME provider reached
  // as the "active" one did. Harmless while nothing gated the primary; the moment §4g covers
  // narrate (2026-07-16) it would refuse an opt-in the user had actually given. The exemption
  // is a property of the PROVIDER + the setting, never of the lookup path that found it.
  // Folding both branches into resolveEffectiveAssignment makes that structural.
  if (eff.cfg) { await applySensitiveExempt(db, userId, eff.cfg); return withFreshSubscriptionToken(eff.cfg); }
  return {};
}

// ── THE selection rule — one implementation, two consumers (D-075) ──────────────────────────
//
// WHAT WENT WRONG. The runtime resolved a task's provider here (explicit
// `settings.taskModels[task].providerId`, else `providers.getActive`), while Settings →
// Intelligence decided what to HIGHLIGHT from `taskModels` ALONE
// (IntelligenceScreen.svelte's `class:on={taskModels[f.tasks[0]]?.providerId === p.id}`).
// Those two rules agree only when an explicit assignment exists. After #360 (D-029) a
// connected subscription AUTO-SELECTS as the active provider WITHOUT writing taskModels — so
// the runtime ran Claude for chat + narration while Settings showed nothing selected at all.
// The operator read that as "the system picked a model but the UI doesn't know".
//
// The fix is not "make the screen also check getActive" — that is a SECOND copy of the rule,
// and a second copy is what produced the divergence. Both the runtime and the display now come
// out of THIS function.
//
// ⚠️ `cfg` CARRIES CREDENTIALS (the row's apiKey / OAuth token, via mapRowToConfig). It is for
// in-process callers only. Anything that crosses an HTTP boundary must go through
// `effectiveSelection()` below, which projects the three UI-safe fields and nothing else.
/**
 * Which provider row will ACTUALLY serve `task`, and why.
 * @param {object} db
 * @param {string} userId
 * @param {string|null} task  a task name, or null for "the plain active-provider resolution"
 * @returns {Promise<{source:'explicit'|'active'|'none', providerId:number|null, model:string|null, cfg:object|null}>}
 *   source 'explicit' → the user assigned this provider to this task in Settings.
 *   source 'active'   → nothing assigned; it falls back to the vault's active provider.
 *   source 'none'     → nothing resolvable (the router then reads env, else local Ollama).
 */
export async function resolveEffectiveAssignment(db, userId, task) {
  if (task != null) {
    try {
      const settings = await db?.users?.getSettings?.(userId);
      const a = settings?.taskModels?.[task];
      if (a && a.providerId != null) {
        let row = await db?.providers?.get?.(a.providerId, userId);
        if (row) {
          if (a.model) row = { ...row, model_preference: a.model }; // per-task model override
          const cfg = mapRowToConfig(row);
          // An UNRESOLVABLE explicit assignment (row deleted, or 'pending') falls through to
          // the active provider — exactly what the runtime has always done. Reporting it as
          // 'explicit' here would make Settings highlight a provider the runtime refuses.
          if (cfg) return { source: 'explicit', providerId: row.id ?? a.providerId, model: row.model_preference || null, cfg };
        }
      }
    } catch { /* fail-soft → active provider */ }
  }
  try {
    const active = await db?.providers?.getActive?.(userId); // most-recently-used active row, or null
    if (active) {
      const cfg = mapRowToConfig(active);
      if (cfg) return { source: 'active', providerId: active.id, model: active.model_preference || null, cfg };
    }
  } catch { /* fail-soft: fall back to env/local */ }
  return { source: 'none', providerId: null, model: null, cfg: null };
}

/**
 * The UI-SAFE projection of resolveEffectiveAssignment — what Settings renders.
 * Deliberately a separate function rather than "remember not to serialize cfg": the credential
 * lives on `cfg`, so the only field-list that ever reaches a client is written down once, here.
 * READ-ONLY by construction — it resolves, it never writes settings, so displaying the
 * effective model can never overwrite (or manufacture) the user's explicit choice.
 *
 * ⚠️ KNOWN LIMITATION — it reports the provider the ASSIGNMENT resolves to, which is not always
 * the provider a given REQUEST will egress to. §4g can still refuse a resolved provider at call
 * time: resolveProviderChain drops every us-* provider for a `sensitive: true` request unless the
 * subscription opt-in is on. Today that is inert for this surface — SENSITIVE_TASKS is empty of
 * anything this screen assigns (narrate left it on 2026-07-19; only the explicit claims path
 * passes sensitive:true, and it is not an assignable function) — so the reported selection and
 * the served one coincide. If a task this screen assigns ever rejoins SENSITIVE_TASKS, this
 * projection would report a provider §4g then refuses, and Settings would be confidently wrong
 * again in the other direction. Whoever makes that change must extend this to carry the refusal
 * (independent review ×2, LOW).
 * @returns {Promise<{task:string|null, source:'explicit'|'active'|'none', providerId:number|null, model:string|null}>}
 */
export async function effectiveSelection(db, userId, task) {
  const e = await resolveEffectiveAssignment(db, userId, task);
  return { task: task ?? null, source: e.source, providerId: e.providerId, model: e.model };
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
      cloud.push(await withFreshSubscriptionToken(cfg));
    }
    cloud.sort((a, b) => JURISDICTION_RANK(a.jurisdiction) - JURISDICTION_RANK(b.jurisdiction));
  } catch { /* fail-soft */ }
  // Guaranteed final fallback: on-box local Ollama.
  //
  // ⚠️ The old comment here said "empty cloud cfg → router goes local". THAT WAS FALSE, and the
  // falseness was the bug: an element that merely OMITS its key fields does not arrive at the
  // router empty — `anthropicApiKey ?? env.ANTHROPIC_API_KEY` (router.js) promotes a stray
  // process-env key straight into the floor, so hasCloud() went TRUE, the "local" floor took the
  // CLOUD branch, and because the §4g gate reads this literal `'local'` tag, /^us/ never matched
  // and sensitive content egressed to the US — stamped 'local' in the egress audit.
  //
  // `''` (not null!) blocks the coalesce — `null ?? env.X` still yields env.X, only '' is
  // non-nullish. That is the same convention mapRowToConfig already uses for the unused key
  // field. This is the DATA half of the defence; `localFallback:true` is the STRUCTURAL half
  // (router.js honours it by stripping creds AND refusing the cloud branch), so the floor stays
  // on-box even if a future field is added here and someone forgets to blank it.
  return [...cloud, { jurisdiction: 'local', localFallback: true, anthropicApiKey: '', openaiApiKey: '', baseUrl: '' }];
}

export default resolveInferenceConfig;
