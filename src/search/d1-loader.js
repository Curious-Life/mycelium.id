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

import { decryptVector } from './ann/decode.js';
import { EMBED_DIM } from '../embed/client.js';

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
 *
 * Documents use UUID string ids like messages (no integer overlap), but we
 * prefix them `document:` anyway so the bare-id space stays message-only —
 * index.js hydrateMessages selects candidates by `!id.includes(':')`, and a
 * `document:` prefix keeps documents out of that filter while making the
 * partition self-describing. See DOCUMENT-SEARCH design 2026-06-17.
 */
export const ID_PREFIX = { territory: 'territory:', realm: 'realm:', theme: 'theme:', document: 'document:' };

/** Strip a kind prefix from an index id → the raw DB pk (string). */
export function stripPrefix(id) {
  const colon = id.indexOf(':');
  return colon === -1 ? id : id.slice(colon + 1);
}

// Column verification against migrations/0001_init.sql: messages,
// territory_profiles, realms, and semantic_themes ALL have created_at, name,
// essence + their respective pk. (Only `dissolved_at` is territory_profiles-
// only — used in structure(), not here.) A SELECT of a column absent on its
// table would throw SQLITE_ERROR, which the per-source try/catch swallows,
// silently dropping that whole layer — so every column below is confirmed.
const SOURCES = [
  // content IS NOT NULL/'' — a content-NULL message can never be a useful search
  // hit (empty doc) and must not enter the pipeline (PIPELINE-INTEGRITY design
  // §P1.3); excludes the quarantined/dead rows that otherwise bloat the index.
  { table: 'messages', sql: "SELECT id, content AS text, created_at, embedding_768 FROM messages WHERE user_id = ? AND forgotten_at IS NULL AND content IS NOT NULL AND content != ''", kind: 'message', prefix: '' },
  { table: 'territory_profiles', sql: "SELECT CAST(territory_id AS TEXT) AS id, name || ' ' || COALESCE(essence,'') AS text, created_at FROM territory_profiles WHERE user_id = ?", kind: 'territory', prefix: ID_PREFIX.territory },
  { table: 'realms', sql: "SELECT CAST(realm_id AS TEXT) AS id, name || ' ' || COALESCE(essence,'') AS text, created_at FROM realms WHERE user_id = ?", kind: 'realm', prefix: ID_PREFIX.realm },
  { table: 'semantic_themes', sql: "SELECT CAST(semantic_theme_id AS TEXT) AS id, name || ' ' || COALESCE(essence,'') AS text, created_at FROM semantic_themes WHERE user_id = ?", kind: 'theme', prefix: ID_PREFIX.theme },
  // Documents have no stored embedding_768 (enrichment embeds messages only),
  // so skipEmbed=true keeps them BM25-only — adding them with a wired embedder
  // would otherwise fire one live :8091 call PER document at cold start (the
  // ~81s freeze PIPELINE-INTEGRITY fought). is_internal=0 + forgotten_at IS NULL
  // exclude internal-model scaffolding and forgotten docs at load (hydrate
  // re-applies both as defense in depth). DOCUMENT-SEARCH design 2026-06-17.
  //
  // title/summary/content are ENCRYPTED columns (ENCRYPTED_FIELDS.documents). The
  // adapter's autoDecryptResults decrypts envelope-shaped VALUES per column, so we
  // SELECT them as individual columns and concatenate the DECRYPTED text in JS
  // (textFrom). Concatenating them in SQL (`title || content`) joins ciphertext
  // envelopes into a non-envelope string the adapter can't decrypt → garbage tokens
  // that never match. Caught by live smoke 2026-06-18; messages dodge it via a
  // single `content AS text` alias, and territory rows on existing vaults are
  // pre-migration plaintext. (The profile sources above carry the same latent risk
  // for newly-encrypted name/essence — tracked separately.)
  { table: 'documents', sql: "SELECT id, title, summary, content, created_at FROM documents WHERE user_id = ? AND is_internal = 0 AND forgotten_at IS NULL AND ((content IS NOT NULL AND content != '') OR (title IS NOT NULL AND title != ''))", kind: 'document', prefix: ID_PREFIX.document, skipEmbed: true, textFrom: (r) => [r.title, r.summary, r.content].filter(Boolean).join(' ') },
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
export async function loadFromDb({ backend, db, userId = 'local-user', getMasterKey = null }) {
  if (!backend || typeof backend.add !== 'function') {
    throw new TypeError('loadFromDb: backend with add() required');
  }
  if (!db || typeof db.rawQuery !== 'function') {
    throw new TypeError('loadFromDb: db with rawQuery required');
  }
  // Resolve the master key ONCE (process-pinned). With it we decrypt each row's
  // stored embedding_768 envelope — written by enrichment via encryptVector
  // (src/enrich/service.js) — and hand the precomputed vector to backend.add,
  // which then SKIPS the per-row embed-service round-trip. Without a key (or on
  // rows with no stored vector) the loader falls back to the prior behavior:
  // text-only add, and backend.add embeds via the injected embedder if wired.
  //
  // This is the cold-start fix: on an enriched vault every message carries a
  // stored vector, so the first search rehydrates from local AES-GCM decrypts
  // (sub-second) instead of N serial :8091 calls (was ~81s, blocking the
  // single-threaded server). allowedScopes=null = admin/backfill mode in
  // crypto-local decrypt — a single-user rehydrate reads its own vectors
  // regardless of per-message scope.
  let masterKey = null;
  if (typeof getMasterKey === 'function') {
    try { masterKey = await getMasterKey(); } catch { masterKey = null; }
  }
  let added = 0;
  let vectorsLoaded = 0;
  let vectorsFailed = 0;
  let processed = 0;
  const byKind = {};
  // Cooperative build: a large vault (tens of thousands of rows) would otherwise
  // run this whole loop as an unbroken microtask chain — `await` over a resolved
  // decrypt/add yields only a MICROTASK, which preempts I/O, so the HTTP event
  // loop is STARVED for the entire build (the user-visible "app frozen" symptom).
  // Yield to the MACROTASK queue every YIELD_EVERY rows so requests are serviced
  // mid-build. (PIPELINE-INTEGRITY design §P2.1.) Negligible wall-clock cost.
  const YIELD_EVERY = 256;
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
      if (++processed % YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
      const rawId = row.id != null ? String(row.id) : '';
      if (!rawId) continue;
      const id = src.prefix + rawId; // kind-prefixed for profiles; bare for messages
      // Reuse the stored vector when present so backend.add does NOT re-embed.
      // Best-effort: a missing/garbled envelope falls through to text-only
      // (never aborts the load; never logs vector bytes — CLAUDE.md §1).
      let embedding;
      if (masterKey && row.embedding_768) {
        try {
          embedding = await decryptVector(row.embedding_768, masterKey, null, EMBED_DIM);
          vectorsLoaded++;
        } catch {
          embedding = undefined;
          vectorsFailed++;
        }
      }
      // text is either a single decrypted column aliased AS text, or built in JS
      // from several decrypted columns (src.textFrom) — see the documents source.
      const text = typeof src.textFrom === 'function' ? src.textFrom(row) : (row.text ?? '');
      try {
        await backend.add({ id, text, embedding, ts: tsFromRow(row), skipEmbed: src.skipEmbed === true });
        added++;
        byKind[src.kind] = (byKind[src.kind] || 0) + 1;
      } catch { /* skip unindexable row */ }
    }
  }
  return { added, byKind, vectorsLoaded, vectorsFailed };
}
