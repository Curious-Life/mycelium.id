/**
 * mind-search instance registry — late binding.
 *
 * Ported verbatim from reference/mind-search/registry.js. A small set/get
 * holder so db-layer match* helpers can reach the mind-search backend without
 * crossing import boundaries at construction time. Module-level singleton —
 * acceptable because mind-search is one-tenant-one-index by design.
 *
 * Lifecycle: boot calls setMindSearch(instance); callers getMindSearch() at
 * query time and MUST handle null (fall back). clearMindSearch() is test-only.
 */

let _instance = null;

export function setMindSearch(inst) { _instance = inst || null; }
export function getMindSearch() { return _instance; }
export function clearMindSearch() { _instance = null; }
