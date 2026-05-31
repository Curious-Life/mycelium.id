/**
 * DB → mind-search rehydrate.
 *
 * Ported from reference/mind-search/d1-loader.js, adapted for V1's encrypted
 * SQLite db layer. In canonical this paginated D1 messages and decrypted the
 * embedding_768 vector envelope per row. Here we read via the assembled db
 * namespace's `rawQuery(sql, params) -> { results }` (the same engine as
 * d1Query; the adapter transparently decrypts content columns) and load
 * `messages` plus the topology profile tables (which carry text) into the
 * LocalBackend.
 *
 * The vector cache is repopulated from the embedder at add() time when a row
 * has no precomputed embedding (the embed-service unit R2 owns the real model;
 * with no embedder injected, rows are BM25-only — still searchable).
 *
 * Per CLAUDE.md §1 this module never logs row text, ids, or vectors — only
 * counts.
 */

/**
 * Tables (with text columns) to index, in priority order.
 * Column names verified against migrations/0001_init.sql + db/search.js.
 *
 * ID-namespace note: messages use UUID string ids, but territory_profiles /
 * realms / semantic_themes use INTEGER pks that overlap each other (a
 * territory_id 1, realm_id 1 and theme_id 1 can all coexist). The in-RAM index
 * keys on a single string id space, so we PREFIX each profile id with its kind
 * (`territory:1`, `realm:1`, `theme:1`) to keep them distinct in the index AND
 * unambiguous when partitioning ranked hits back into layers. See ID_PREFIX +
 * stripPrefix; index.js hydration mirrors this.
 */
export const ID_PREFIX = { territory: 'territory:', realm: 'realm:', theme: 'theme:' };

/** Strip a kind prefix from an index id → the raw DB pk (string). */
export function stripPrefix(id) {
  const colon = id.indexOf(':');
  return colon === -1 ? id : id.slice(colon + 1);
}

const SOURCES = [
  { table: 'messages', sql: 'SELECT id, content AS text, created_at FROM messages WHERE user_id = ?', kind: 'message', prefix: '' },
  { table: 'territory_profiles', sql: "SELECT CAST(territory_id AS TEXT) AS id, name || ' ' || COALESCE(essence,'') AS text, created_at FROM territory_profiles WHERE user_id = ?", kind: 'territory', prefix: ID_PREFIX.territory },
  { table: 'realms', sql: "SELECT CAST(realm_id AS TEXT) AS id, name || ' ' || COALESCE(essence,'') AS text, created_at FROM realms WHERE user_id = ?", kind: 'realm', prefix: ID_PREFIX.realm },
  { table: 'semantic_themes', sql: "SELECT CAST(semantic_theme_id AS TEXT) AS id, name || ' ' || COALESCE(essence,'') AS text, created_at FROM semantic_themes WHERE user_id = ?", kind: 'theme', prefix: ID_PREFIX.theme },
];

function tsFromRow(row) {
  // created_at is an ISO-8601 string (strftime '%Y-%m-%dT%H:%M:%fZ'). Parse →
  // epoch sec. Fall back to "now" when absent/unparseable.
  if (row.created_at == null) return Math.floor(Date.now() / 1000);
  const ms = Date.parse(row.created_at);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : Math.floor(Date.now() / 1000);
}

/**
 * Load the corpus from the DB into the backend.
 * @param {object} deps
 * @param {{ add: Function }} deps.backend
 * @param {object} deps.db        assembled db namespace (needs rawQuery)
 * @param {string} deps.userId
 * @returns {Promise<{ added:number, byKind:Record<string,number> }>}
 */
export async function loadFromDb({ backend, db, userId = 'local-user' }) {
  if (!backend || typeof backend.add !== 'function') {
    throw new TypeError('loadFromDb: backend with add() required');
  }
  if (!db || typeof db.rawQuery !== 'function') {
    throw new TypeError('loadFromDb: db with rawQuery required');
  }
  let added = 0;
  const byKind = {};
  for (const src of SOURCES) {
    let rows;
    try {
      const res = await db.rawQuery(src.sql, [userId]);
      rows = res?.results || [];
    } catch {
      // Table absent or query failed — skip this source (e.g. a partial schema).
      continue;
    }
    for (const row of rows) {
      const rawId = row.id != null ? String(row.id) : '';
      if (!rawId) continue;
      const id = src.prefix + rawId; // kind-prefixed for profiles; bare for messages
      try {
        await backend.add({ id, text: row.text ?? '', ts: tsFromRow(row) });
        added++;
        byKind[src.kind] = (byKind[src.kind] || 0) + 1;
      } catch { /* skip unindexable row */ }
    }
  }
  return { added, byKind };
}
