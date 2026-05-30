/**
 * Mind Search — public entry point.
 *
 * `createMindSearch(deps)` is the only public export. It returns a value
 * that conforms to the MindBackend contract defined in `backend/interface.js`.
 *
 * Usage:
 *
 *   import { createMindSearch } from '@mycelium/core/mind-search/index.js';
 *
 *   const mind = createMindSearch({
 *     embedder,                                // { embed, health }
 *     masterKey,                               // CryptoKey from tmpfs
 *     scopes: ['personal'],
 *     userId,
 *     db,                                      // optional: db-d1 backend
 *     persistPath,                             // optional: snapshot file
 *     reranker,                                // optional: { rerank }
 *     logger: parentLogger.child({ mod: 'mind-search' }),
 *   });
 *
 *   await mind.init();                         // optional: load snapshot
 *   await mind.add({ id, text, ts });
 *   const result = await mind.query({ text, topK: 10, recency: 'mixed' });
 *   await mind.checkpoint();                   // optional: persist snapshot
 *
 * The factory mirrors the existing `createSearchNamespace(deps)` shape in
 * [db-d1/search.js] so it slots into the same dependency-injection pattern.
 *
 * Backend selection: PR 8 returns the LocalBackend unconditionally. A
 * future flag (per PR 11 in MIND-SEARCH-IMPLEMENTATION.md) may dispatch to
 * VectorizeBackend during the rollout window; that selection happens at
 * the call site, not here.
 */

import { createLocalBackend } from './backend/local.js';

/**
 * @param {import('./backend/interface.js').MindBackendDeps} deps
 * @returns {import('./backend/interface.js').MindBackend & {
 *   init: () => Promise<{ loaded: boolean }>,
 *   checkpoint: () => Promise<{ saved: boolean, bytes?: number }>,
 *   _internal: () => object,
 * }}
 */
export function createMindSearch(deps) {
  // Dep validation lives in createLocalBackend so we have a single
  // source of truth. Same TypeErrors propagate.
  return createLocalBackend(deps);
}

export { createLocalBackend } from './backend/local.js';
export {
  NotImplementedError,
  MindSearchError,
  EmbedDownError,
  IndexUnavailableError,
  DecryptError,
  ScopeMismatchError,
  MasterKeyMissingError,
  BudgetExceededError,
} from './errors.js';
