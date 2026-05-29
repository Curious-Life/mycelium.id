/**
 * Per-corpus scan-matcher registry — late binding across packages.
 *
 * Same role as mind-search/registry.js but for the four small corpora
 * (territories, realms, themes, documents) that don't go through the
 * full mind-search pipeline.
 *
 * agent-server constructs the matchers (each with its own decryptVector
 * closure bound to the master key) and registers them by table name.
 * matchTerritories/matchRealms/matchThemes/matchDocuments call
 * getScanMatcher(tableName) at query time and fall back to Vectorize
 * if the registry is empty (e.g., bootstrap not yet complete, or
 * mind-search disabled entirely).
 *
 * Module-level mutable state. Singleton-by-design — one tenant per
 * agent process.
 */

const _matchers = new Map();

/**
 * @param {string} tableName
 * @param {{ search: Function, preload: Function } | null} matcher
 */
export function setScanMatcher(tableName, matcher) {
  if (typeof tableName !== 'string' || !tableName) {
    throw new TypeError('setScanMatcher: tableName required');
  }
  if (matcher === null || matcher === undefined) {
    _matchers.delete(tableName);
    return;
  }
  if (typeof matcher.search !== 'function') {
    throw new TypeError('setScanMatcher: matcher.search required');
  }
  _matchers.set(tableName, matcher);
}

/**
 * @param {string} tableName
 * @returns {{ search: Function, preload: Function } | null}
 */
export function getScanMatcher(tableName) {
  return _matchers.get(tableName) || null;
}

/**
 * Test-only reset.
 */
export function clearScanMatchers() {
  _matchers.clear();
}
