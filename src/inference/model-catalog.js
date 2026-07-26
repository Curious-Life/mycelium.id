// src/inference/model-catalog.js — DISCOVER the models a connected provider actually
// exposes, with an HONEST state when we cannot.
//
// ── WHY THIS FILE EXISTS (D-074) ────────────────────────────────────────────────────────
// The subscription model picker shipped a hand-written roster in the Svelte component
// (`CLAUDE_SUB_MODELS` in AISettings.svelte): four ids, typed once, never revisited. When
// Anthropic shipped a newer Opus the picker still offered the old ones — the operator could
// see the model in their Claude account and NOT in Mycelium. That is meta-defect M-002
// (hand-maintained enumerations rot), and the roster made it invisible: the list looked
// authoritative because it looked complete.
//
// So: the LIST IS THE PROVIDER'S ANSWER. `listModels()` (models.js) is the only thing that
// decides what a provider offers. This module adds the three properties a UI needs on top
// of that call and nothing else:
//
//   1. CACHE   — the picker re-renders on every settings visit; without a cache each one is
//                an outbound request with the user's credential. Short TTL (5 min) so a
//                newly-released model appears on the next visit, and `force` for the
//                explicit Refresh click.
//                ⚠️ ONLY SUCCESSFUL ANSWERS ARE CACHED, deliberately. A failure is not
//                stored, so a token that just regained scope — or a network that came back —
//                takes effect on the very next render instead of after a TTL the user cannot
//                see or clear. The cost is that a persistently-unlistable provider is
//                re-attempted per visit (bounded by listModels' 12s timeout), which is what
//                the pre-fix code already did. Do not "fix" this by caching failures without
//                also giving the user a way to invalidate that cache.
//                (The header used to claim the cache prevented every settings visit from
//                sending the credential; on the documented-common auth_rejected path it does
//                not — independent review, LOW.)
//   2. HONESTY — a failed or cached answer is LABELLED. `source` is one of
//                'live' | 'cache' | 'fallback', and `stale` is true whenever the list is NOT
//                a current answer from the provider. A stale list must never render as if it
//                were live: that is the same lie as the roster, just with fewer entries.
//   3. FLOOR   — when the provider cannot be reached AND nothing is cached, we still return
//                something selectable so the user is not dead-ended mid-configuration. That
//                floor is DERIVED from MODEL_REGISTRY (model-registry.js) — the table that
//                already exists, is already dated, and is already maintained per release —
//                rather than a SECOND enumeration that would rot in its own corner. There is
//                no new roster in this repo, and adding one is the regression to guard.
//
// SECURITY (CLAUDE.md §1/§4): the API key / OAuth token is passed to `listModels` and NEVER
// returned, logged, cached, or put in an error. `error` is a CATEGORY string produced by
// models.js ('auth_rejected' | 'timeout' | 'unreachable' | …) — never the provider's body,
// never the credential, never the host. The cache stores model IDS ONLY, keyed by the
// provider row id; it holds no credential material, so a cache hit cannot leak one either.

import { listModels as defaultListModels } from './models.js';
import { MODEL_REGISTRY } from './model-registry.js';

/** How long a discovered list is served without re-asking the provider. Short on purpose:
 *  a model released today should show up on the user's next visit, not next release. */
export const MODEL_CACHE_TTL_MS = 5 * 60_000;

// Map<string, { models: string[], at: number }>. Model IDs only — no credentials.
//
// ⚠️ The key is `<userId>|<rowId>`, not the row id alone. V1 is single-user and `ai_providers.id`
// is unique per table, so a bare id is sufficient TODAY — but portalProvidersRouter is
// userId-parameterized and every db.providers read is user-scoped, so a process-global keyed
// only by row id would be the one un-scoped read in the path the day a second tenant exists
// (CLAUDE.md §5: isolation is total, and the floor is not "no bug is reachable yet").
const _cache = new Map();
const cacheKey = (userId, key) => `${userId ?? ''}|${key}`;

/** Drop a cached list (or all of them). Called on an explicit reconnect / provider edit, so a
 *  changed account or key re-discovers immediately instead of serving the old account's list. */
export function invalidateModelCatalog(key = null, userId = undefined) {
  if (key == null) { _cache.clear(); return; }
  if (userId === undefined) {
    // No tenant given → drop this row id for EVERY tenant. Fail-safe: over-invalidating costs
    // one extra provider round-trip; under-invalidating serves a dead credential's list.
    for (const k of [..._cache.keys()]) if (k.endsWith(`|${key}`)) _cache.delete(k);
    return;
  }
  _cache.delete(cacheKey(userId, key));
}

/** Test seam — the cache is module state, so a gate must be able to start from empty. */
export function _resetModelCatalogForTests() { _cache.clear(); }

// ── KNOWN LIMITATION: process-global, so it outlives a vault LOCK ────────────────────────────
// The cache is module state, not vault state, so locking the vault does not clear it. What
// survives is a list of MODEL IDS — no credential, no user content — and the next read is still
// gated by the route's auth + a user-scoped db.providers.get, so a locked vault cannot be
// serviced from it. Recorded rather than fixed because clearing it on lock would need a lock
// hook this module has no business owning; if that hook ever exists, call invalidateModelCatalog()
// from it (independent review ×2, LOW).

/**
 * The FALLBACK floor for a provider, derived from the dated MODEL_REGISTRY rather than a
 * second hand-written list. Returns [] for a provider we have no dated rows for (a custom
 * OpenAI-compatible endpoint, a local server) — an empty honest list beats inventing ids for
 * an endpoint we know nothing about.
 * @param {string} provider  the ai_providers.provider value
 * @param {string} [baseUrl]
 * @returns {string[]}
 */
export function fallbackModelsFor(provider, baseUrl = '') {
  const p = String(provider || '').toLowerCase();
  // A base_url provider is OpenAI-COMPATIBLE, not OpenAI: its roster is whatever that server
  // hosts (Regolo, Groq, Ollama, LM Studio…). Guessing 'gpt-4o' for it would be worse than
  // an empty list — it would offer a model the endpoint will 404 on.
  if (baseUrl) return [];
  const family = (p === 'anthropic' || p === 'claude' || p === 'claude_subscription') ? 'claude'
    : (p === 'openai') ? 'gpt'
      : null;
  if (!family) return [];
  return Object.entries(MODEL_REGISTRY).filter(([, v]) => v.family === family).map(([k]) => k);
}

/**
 * Discover the models a provider exposes.
 *
 * @param {object} opts
 * @param {string|number} opts.key        cache key — the ai_providers row id
 * @param {string} [opts.userId]          tenant scope for the cache key (see the cache note)
 * @param {string} opts.provider
 * @param {string} [opts.baseUrl]
 * @param {string} [opts.apiKey]          never logged, never returned
 * @param {string} [opts.token]           subscription OAuth token — never logged, never returned
 * @param {boolean} [opts.force=false]    bypass the TTL (the explicit Refresh click)
 * @param {number} [opts.ttlMs]
 * @param {number} [opts.now]
 * @param {Function} [opts.list]          injectable listModels (gates)
 * @param {typeof fetch} [opts.fetch]
 * @returns {Promise<{ok:boolean, models:string[], source:'live'|'cache'|'fallback', stale:boolean, fetchedAt:number|null, error:string|null}>}
 *   `ok` means "this is a current answer from the provider". `stale` is its inverse for
 *   everything a UI must qualify: a cache served BECAUSE the refresh failed, or the floor.
 */
export async function discoverModels({
  key, userId = '', provider, baseUrl = '', apiKey = null, token = null,
  force = false, ttlMs = MODEL_CACHE_TTL_MS, now = Date.now(),
  list = defaultListModels, fetch = globalThis.fetch,
} = {}) {
  const ck = cacheKey(userId, key ?? `${provider}|${baseUrl}`);
  const hit = _cache.get(ck);

  // Fresh cache and no explicit refresh → serve it, LABELLED as a cache. Not 'live': the UI
  // may legitimately want to say "as of 2 min ago", and calling a cache live is the first
  // step back to a list nobody re-checks.
  if (!force && hit && (now - hit.at) < ttlMs) {
    return { ok: true, models: hit.models, source: 'cache', stale: false, fetchedAt: hit.at, error: null };
  }

  let r;
  try {
    r = await list({ provider, baseUrl: baseUrl || undefined, apiKey: apiKey || undefined, token: token || undefined, fetch });
  } catch {
    r = { ok: false, error: 'unreachable' };
  }

  if (r?.ok && Array.isArray(r.models) && r.models.length) {
    _cache.set(ck, { models: r.models, at: now });
    return { ok: true, models: r.models, source: 'live', stale: false, fetchedAt: now, error: null };
  }

  // ── The fetch did not produce a usable answer. Everything below is EXPLICITLY not-live. ──
  // A provider that answers 200 with an EMPTY list counts as a failure here on purpose: an
  // empty picker is a dead end, and 'empty_list' tells the user which of the two it was.
  const error = r?.ok ? 'empty_list' : (r?.error || 'unreachable');

  // A warm-but-expired cache still beats the registry floor: it is what THIS account actually
  // exposed, only older. It is returned with stale:true + the error, so the UI says so.
  if (hit) return { ok: false, models: hit.models, source: 'cache', stale: true, fetchedAt: hit.at, error };

  return { ok: false, models: fallbackModelsFor(provider, baseUrl), source: 'fallback', stale: true, fetchedAt: null, error };
}

export default discoverModels;
