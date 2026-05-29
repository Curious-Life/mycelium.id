/**
 * Scan-based matcher for small corpora — territories, realms, themes,
 * documents. Loads decrypted vectors from a TEXT column once at first
 * call (or via preload), holds them in a Map, and runs brute-force
 * topK cosine on every query.
 *
 * Why not extend mind-search to multi-corpus?
 *   The mind-search backend pays for an inverted index + ANN + degrade
 *   tiers because it serves ~22k messages with sub-100ms latency. The
 *   four corpora here are ~tens to ~hundreds — brute-force cosine is
 *   <1ms per query, decryption is the only real cost, and that gets
 *   paid once per process. Two backends in parallel is simpler than
 *   one backend with corpus-routing.
 *
 * Cache lifecycle:
 *   Lazy load on first call (or via preload() at boot to avoid the
 *   cold-start freeze on whichever search query trips it). Held until
 *   process restart — no TTL, no invalidation. Acceptable because:
 *
 *     - mindscape entities (territories/realms/themes) refresh nightly
 *       via run-clustering.sh; the agent restarts after deploys
 *     - new documents become searchable on next agent restart; the
 *       upload itself is part of the conversation context, so the
 *       new doc isn't "lost" to the agent
 *
 *   Wave 4b can add invalidation if real usage shows it's needed.
 *
 * Failure isolation:
 *   - Per-row decrypt failures count and skip; don't poison the cache
 *   - All-rows decrypt fail still yields a usable empty cache; the
 *     matcher returns [] which falls through to Vectorize
 *   - Re-throwing decrypt errors would make the whole matcher
 *     un-callable; we'd rather degrade
 *
 * Per CLAUDE.md §1, this module never logs query embeddings, document
 * text, or any decrypted bytes. Counters and timing only.
 */

import { topKCosine } from './ann/cosine.js';

const NOMIC_DIM = 768;

/**
 * @param {object} deps
 * @param {string} deps.tableName              e.g. 'territory_profiles'
 * @param {(sql: string, params: any[]) => Promise<{ results?: Array<object> }>} deps.d1Query
 * @param {(envelope: string) => Promise<Float32Array>} deps.decryptVector
 * @param {string} deps.userId                 tenant id — required by Worker SQL enforcement
 * @param {string} [deps.idColumn='id']        primary key column for hydrate
 * @returns {{
 *   search: (queryVec: Float32Array | number[], topK: number) => Promise<Array<{id: string, score: number}>>,
 *   preload: () => Promise<{ loaded: number, decryptFailed: number, elapsedMs: number }>,
 *   reset: () => void,
 *   _internal: () => { cacheSize: number, loaded: boolean },
 * }}
 */
export function createScanMatcher(deps) {
  if (!deps) throw new TypeError('createScanMatcher: deps required');
  const { tableName, d1Query, decryptVector, userId, idColumn = 'id' } = deps;
  if (typeof tableName !== 'string' || !tableName) {
    throw new TypeError('createScanMatcher: tableName required');
  }
  if (typeof d1Query !== 'function') {
    throw new TypeError('createScanMatcher: d1Query required');
  }
  if (typeof decryptVector !== 'function') {
    throw new TypeError('createScanMatcher: decryptVector required');
  }
  if (typeof userId !== 'string' || !userId) {
    throw new TypeError('createScanMatcher: userId required (Worker SQL enforcement requires user_id filter)');
  }
  // Light validation: no SQL injection vector since this string is
  // controlled by the caller (a literal table name in our codebase),
  // but pin it to a [a-zA-Z_]+ shape to make a future caller mistake
  // visible.
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
    throw new TypeError(`createScanMatcher: tableName must match /^[a-zA-Z_][a-zA-Z0-9_]*$/, got ${tableName}`);
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(idColumn)) {
    throw new TypeError(`createScanMatcher: idColumn must match /^[a-zA-Z_][a-zA-Z0-9_]*$/, got ${idColumn}`);
  }

  /** @type {{ ids: string[], vectors: Float32Array[] } | null} */
  let cache = null;
  /** @type {Promise<void> | null} */
  let loadInFlight = null;

  async function _loadOnce() {
    if (cache !== null) return { loaded: cache.ids.length, decryptFailed: 0, elapsedMs: 0 };
    if (loadInFlight) {
      await loadInFlight;
      return { loaded: cache?.ids.length ?? 0, decryptFailed: 0, elapsedMs: 0 };
    }
    const startedAt = Date.now();
    let decryptFailed = 0;
    loadInFlight = (async () => {
      const sql = `SELECT ${idColumn} AS id, embedding_768 FROM ${tableName} WHERE user_id = ? AND embedding_768 IS NOT NULL`;
      const result = await d1Query(sql, [userId]);
      const rows = result?.results || [];
      const ids = [];
      const vectors = [];
      let firstError = null;
      for (const row of rows) {
        if (!row || typeof row.id !== 'string' || typeof row.embedding_768 !== 'string') continue;
        try {
          const vec = await decryptVector(row.embedding_768);
          if (vec instanceof Float32Array && vec.length === NOMIC_DIM) {
            ids.push(row.id);
            vectors.push(vec);
          } else {
            decryptFailed += 1;
            if (!firstError) firstError = `wrong shape: ${vec?.constructor?.name || typeof vec} length=${vec?.length}`;
          }
        } catch (err) {
          decryptFailed += 1;
          if (!firstError) {
            firstError = `${err?.constructor?.name || 'Error'}: ${err?.message || 'unknown'}`;
            if (err?.cause) firstError += ` | cause: ${err.cause?.constructor?.name}: ${err.cause?.message}`;
          }
        }
      }
      if (decryptFailed > 0 && firstError) {
        console.warn(`[scan-matcher ${tableName}] first decrypt-fail (of ${decryptFailed}): ${firstError}`);
      }
      cache = { ids, vectors };
    })();
    try {
      await loadInFlight;
    } finally {
      loadInFlight = null;
    }
    return { loaded: cache?.ids.length ?? 0, decryptFailed, elapsedMs: Date.now() - startedAt };
  }

  return {
    /**
     * Top-K cosine search over the cached vectors. Returns the same
     * `[{id, score}]` shape as Vectorize so it drops into existing
     * matchers as a swap.
     *
     * @param {Float32Array | number[]} queryVec
     * @param {number} topK
     */
    async search(queryVec, topK) {
      try {
        await _loadOnce();
      } catch {
        // Cache unavailable; return empty so caller falls back.
        return [];
      }
      if (!cache || cache.ids.length === 0) return [];
      const q = queryVec instanceof Float32Array ? queryVec : Float32Array.from(queryVec);
      // topKCosine returns [{ idx, score }] — re-key to ids using the
      // parallel arrays so the matcher returns the Vectorize shape.
      const scored = topKCosine(q, cache.vectors, topK);
      return scored.map((s) => ({ id: cache.ids[s.idx], score: s.score }));
    },

    /**
     * Eagerly load + decrypt the cache. Pre-loaded by agent-server at
     * boot to avoid making the first-search request pay the cold-start
     * decryption cost.
     *
     * Returns counters for the boot log line.
     */
    preload: _loadOnce,

    /**
     * Test-only reset. Drops the cache; next call reloads.
     */
    reset() {
      cache = null;
      loadInFlight = null;
    },

    _internal() {
      return {
        cacheSize: cache?.ids.length ?? 0,
        loaded: cache !== null,
      };
    },
  };
}
