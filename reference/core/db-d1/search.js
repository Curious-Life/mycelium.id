/**
 * Search namespace — semantic match + SQL hydrate for mindscape entities.
 *
 * All three match* methods follow the same pattern:
 *   1. Scan-matcher (in-RAM cosine over the encrypted embedding_768
 *      column for that table) returns top-K matches.
 *   2. SQL IN-clause hydrate of matched ids, scoped by user_id.
 *   3. Merge similarity score, sort DESC.
 *
 * `lookupTerritoryByName` is a plain case-insensitive LIKE match — used
 * as a fast pre-step before falling through to embedding similarity.
 *
 * Wave 4b (2026-05-04): Vectorize fallback removed. The legacy 1024D
 * Vectorize index was retired with the BGE shutdown; mind-search +
 * scan-matchers are the only path. Empty results when a matcher is
 * unregistered/threw — the /internal/v1/search/mindscape endpoint
 * surfaces warming state via 503 + Retry-After.
 *
 * @typedef {object} SearchNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {(val: any) => any} parseJson
 */

export function createSearchNamespace(deps) {
  if (!deps) throw new TypeError('createSearchNamespace: deps required');
  const { d1Query, parseJson } = deps;
  if (typeof d1Query !== 'function')     throw new TypeError('createSearchNamespace: d1Query required');
  if (typeof parseJson !== 'function')   throw new TypeError('createSearchNamespace: parseJson required');

  return {
    async lookupTerritoryByName(userId, name) {
      const result = await d1Query(
        `SELECT territory_id, name FROM territory_profiles
         WHERE user_id = ? AND LOWER(name) LIKE LOWER(?)
         LIMIT 5`,
        [userId, `%${name}%`],
      );
      return result.results || [];
    },

    async matchTerritories(embedding, userId, count = 5) {
      // Scan-matcher only. Vectorize fallback removed (Wave 4b).
      // If the matcher is unregistered/threw, return empty — the
      // /internal/v1/search/mindscape endpoint already surfaces
      // warming state via 503 + Retry-After.
      const { getScanMatcher } = await import('../mind-search/scan-matcher-registry.js');
      const sm = getScanMatcher('territory_profiles');
      if (!sm) return [];

      let matches = [];
      try { matches = await sm.search(embedding, count); }
      catch { return []; }
      if (!matches.length) return [];

      const ids = matches.map((m) => m.id);
      const placeholders = ids.map(() => '?').join(', ');
      const result = await d1Query(
        `SELECT id, territory_id, name, essence, message_count, top_entities FROM territory_profiles WHERE user_id = ? AND id IN (${placeholders})`,
        [userId, ...ids],
      );
      const scoreMap = new Map(matches.map((m) => [m.id, m.score]));
      return (result.results || [])
        .map((row) => ({
          ...row,
          top_entities: parseJson(row.top_entities),
          similarity: scoreMap.get(row.id) || 0,
        }))
        .sort((a, b) => b.similarity - a.similarity);
    },

    async matchRealms(embedding, userId, count = 5) {
      const { getScanMatcher } = await import('../mind-search/scan-matcher-registry.js');
      const sm = getScanMatcher('realms');
      if (!sm) return [];

      let matches = [];
      try { matches = await sm.search(embedding, count); }
      catch { return []; }
      if (!matches.length) return [];

      const ids = matches.map((m) => m.id);
      const placeholders = ids.map(() => '?').join(', ');
      const result = await d1Query(
        `SELECT id, realm_id, name, essence, territory_count, message_count FROM realms WHERE user_id = ? AND id IN (${placeholders})`,
        [userId, ...ids],
      );
      const scoreMap = new Map(matches.map((m) => [m.id, m.score]));
      return (result.results || [])
        .map((row) => ({ ...row, similarity: scoreMap.get(row.id) || 0 }))
        .sort((a, b) => b.similarity - a.similarity);
    },

    async matchThemes(embedding, userId, count = 5) {
      const { getScanMatcher } = await import('../mind-search/scan-matcher-registry.js');
      const sm = getScanMatcher('semantic_themes');
      if (!sm) return [];

      let matches = [];
      try { matches = await sm.search(embedding, count); }
      catch { return []; }
      if (!matches.length) return [];

      const ids = matches.map((m) => m.id);
      const placeholders = ids.map(() => '?').join(', ');
      const result = await d1Query(
        `SELECT id, semantic_theme_id, name, essence, territory_count, message_count FROM semantic_themes WHERE user_id = ? AND id IN (${placeholders})`,
        [userId, ...ids],
      );
      const scoreMap = new Map(matches.map((m) => [m.id, m.score]));
      return (result.results || [])
        .map((row) => ({ ...row, similarity: scoreMap.get(row.id) || 0 }))
        .sort((a, b) => b.similarity - a.similarity);
    },
  };
}
