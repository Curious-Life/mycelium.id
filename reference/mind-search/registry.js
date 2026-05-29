/**
 * mind-search instance registry — late binding across packages.
 *
 * Why this exists:
 *   db-d1.js (in @mycelium/core) needs to route matchMessages to the
 *   mind-search backend, but that backend is bootstrapped later from
 *   @mycelium/server. core can't import server, and db-d1 is built
 *   before mind-search is constructed. A small set/get holder fixes
 *   the timing and avoids a constructor-arg cascade through every
 *   place db.messages is used.
 *
 * Lifecycle:
 *   - agent-server bootstrap calls setMindSearch(instance) after
 *     bootstrapMindSearch resolves.
 *   - matchMessages calls getMindSearch() at query time. If it's
 *     null (mind-search disabled, not yet bootstrapped, or torn down
 *     for tests), the caller falls back to Vectorize.
 *   - clearMindSearch() exists for tests; do not call from prod.
 *
 * This is module-level mutable state. Acceptable here because mind-search
 * is a singleton per agent process by design (one tenant, one master
 * key, one in-memory index). For multi-tenant use, a different shape
 * would be needed.
 */

let _instance = null;

/**
 * Register the active mind-search instance. Idempotent — calling
 * with the same value twice is a no-op; calling with a different
 * instance overwrites (last write wins).
 *
 * @param {object | null} inst  the result of createMindSearch(...)
 */
export function setMindSearch(inst) {
  _instance = inst || null;
}

/**
 * @returns {object | null} the active instance, or null if mind-search
 *   isn't running. Callers MUST handle null and fall back to a legacy
 *   path during the rollout window.
 */
export function getMindSearch() {
  return _instance;
}

/**
 * Test-only reset. Do not call from prod code.
 */
export function clearMindSearch() {
  _instance = null;
}
