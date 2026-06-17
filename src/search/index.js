/**
 * Mind-search subsystem — public entry point.
 *
 * createSearchHelpers({ db, embedder, userId }) returns the searchHelpers
 * object src/tools/mindscape.js depends on. The load-bearing method is
 * `bulkSearch(args)` (the real mindscape.js contract, verified at
 * src/tools/mindscape.js:29,57):
 *
 *   bulkSearch({ query, limit, agent, scope, includeTopology }) -> {
 *     messages:    string[],
 *     documents:   string[],
 *     territories: { formatted: string[], raw: object[] },
 *     realms:      string[],
 *     themes:      string[],
 *   }
 *
 * Implementation: one in-RAM mind-search index (BM25 + ANN cosine + RRF +
 * temporal) holds all indexable rows (messages + topology profiles). bulkSearch
 * embeds the query (via the INJECTED embedder — embed-service :8091 is sibling
 * unit R2; absent → BM25-only), runs the tier, then groups the ranked ids back
 * into their source layer by hydrating from the DB via `db.rawQuery`.
 * structure() reads the topology profile tables directly (honest empty shape
 * when empty).
 *
 * Single-user (PORT-PRIORITY): the index is unconditional — no per-user filter
 * wrapper. The legacy user_id column is still passed to SQL for canonical
 * parity but is always the one local user.
 *
 * DB contract (verified against src/db/index.js + src/adapter/d1.js):
 *   db.rawQuery(sql, params) -> { results: [...] }   (adapter auto-decrypts)
 *   db.topology.getCoFiring({ p_user_id, p_territory_id, p_scale, p_limit })
 */

import { createLocalBackend } from './backend/local.js';
import { createSqliteBackend } from './backend/sqlite.js';
import { loadFromDb, ID_PREFIX, stripPrefix } from './d1-loader.js';
import { setMindSearch } from './registry.js';

const DEFAULT_USER = 'local-user';

/**
 * Select the search backend. Default = the in-RAM LocalBackend (rebuilt from the
 * whole corpus per boot). Opt-in (Phase 1) = the on-disk SqliteBackend (FTS5 +
 * sqlite-vec inside the vault DB; no rebuild, page-cache memory). The on-disk
 * path stays OFF by default until incremental maintenance owns every write —
 * otherwise the disk index goes stale between Generates. Enable with
 * MYCELIUM_SEARCH_BACKEND=sqlite (requires db._sqlite, the raw handle).
 */
function chooseBackend({ db, embedder, userId, searchBackend }) {
  const want = (searchBackend ?? process.env.MYCELIUM_SEARCH_BACKEND ?? '').toLowerCase();
  if (want === 'sqlite' && db && db._sqlite) {
    return { backend: createSqliteBackend({ sqliteDb: db._sqlite, embedder, userId }), kind: 'sqlite' };
  }
  return { backend: createLocalBackend({ embedder, userId }), kind: 'local' };
}

export function createSearchHelpers(deps = {}) {
  const { db = null, embedder = null, userId = DEFAULT_USER, getMasterKey = null, searchBackend = null } = deps;

  const { backend, kind: backendKind } = chooseBackend({ db, embedder, userId, searchBackend });
  let built = false;

  async function ensureBuilt() {
    if (built) return;
    if (db && typeof db.rawQuery === 'function') {
      try {
        // On-disk backend persists across boots: populate ONCE (the same
        // loadFromDb path the in-RAM backend uses every boot), tracked by a
        // PERSISTED flag — NOT count()>0, which incremental writes (noteUpsert)
        // would trip before the first query, skipping the full corpus load. The
        // in-RAM backend always (re)builds.
        if (backendKind === 'sqlite' && typeof backend.isCorpusBuilt === 'function' && backend.isCorpusBuilt()) {
          // already populated on disk — no rebuild
        } else {
          await loadFromDb({ backend, db, userId, getMasterKey });
          if (backendKind === 'sqlite' && typeof backend.markCorpusBuilt === 'function') backend.markCorpusBuilt();
        }
      } catch { /* fall through */ }
    }
    built = true;
  }

  // Incremental index maintenance (§8). NO-OP unless the on-disk backend is
  // active: the in-RAM backend is rebuilt per boot, so per-write upserts would
  // just grow it unboundedly between Generates. Best-effort everywhere — a
  // maintenance failure NEVER blocks the originating write. Reached from the
  // write paths via getMindSearch() (registry), so capture/enrich keep the
  // on-disk index fresh without a rebuild.
  const incremental = backendKind === 'sqlite';
  async function noteUpsert(doc) {
    if (!incremental || !doc || typeof doc.id !== 'string' || !doc.id) return;
    try {
      await backend.add({
        id: doc.id,
        text: doc.text ?? doc.content ?? '',
        embedding: doc.embedding,
        ts: Number.isFinite(doc.ts) ? doc.ts : Math.floor(Date.now() / 1000),
      });
    } catch { /* best-effort: never block the write */ }
  }
  async function noteDelete(ids) {
    if (!incremental) return;
    const list = Array.isArray(ids) ? ids : [ids];
    try { await backend.delete({ ids: list.filter((id) => typeof id === 'string' && id) }); } catch { /* best-effort */ }
  }
  // Vector-ready hook (enrichment): update only this id's vector, preserve ts/fts.
  function noteVector(id, embedding) {
    if (!incremental || typeof id !== 'string' || !id || !embedding) return;
    try { backend.noteVector?.(id, embedding); } catch { /* best-effort */ }
  }

  // Index a document directly (tests / incremental updates). Marks built so a
  // later ensureBuilt() does not clobber a hand-loaded in-RAM corpus.
  async function indexDocument(doc) {
    await backend.add({
      id: doc.id,
      text: doc.text ?? doc.content ?? '',
      embedding: doc.embedding,
      ts: Number.isFinite(doc.ts) ? doc.ts : Math.floor(Date.now() / 1000),
    });
    built = true;
  }

  // Force a rebuild from the DB.
  async function rebuild() {
    built = false;
    await ensureBuilt();
    return backend.count();
  }

  // Low-level ranked search (id + score) over the whole corpus.
  async function search(query, opts = {}) {
    await ensureBuilt();
    const q = (query ?? '').toString();
    const { hits } = await backend.query({ text: q, topK: opts.limit ?? 10 });
    return hits;
  }

  // ── DB hydration helpers (group ranked ids back into their layer) ─────────

  async function rawRows(sql, params) {
    if (!db || typeof db.rawQuery !== 'function') return [];
    try {
      const res = await db.rawQuery(sql, params);
      return res?.results || [];
    } catch {
      return [];
    }
  }

  // Message ids are bare UUID strings (no kind prefix).
  //
  // forgotten_at IS NULL is UNCONDITIONAL (defense-in-depth: forget evicts the
  // in-RAM index, but hydration is a second read path — a forgotten row must
  // never surface here even if the index is briefly stale). `excludeSensitive`
  // additionally drops sensitive=1 rows for proactive recall (relatedTo) — §3.6.
  async function hydrateMessages(ids, { excludeSensitive = false } = {}) {
    const msgIds = ids.filter((id) => !id.includes(':'));
    if (msgIds.length === 0) return new Map();
    const placeholders = msgIds.map(() => '?').join(',');
    const sensitiveClause = excludeSensitive ? ' AND sensitive = 0' : '';
    const rows = await rawRows(
      `SELECT id, content, agent_id, created_at FROM messages WHERE user_id = ? AND id IN (${placeholders}) AND forgotten_at IS NULL${sensitiveClause}`,
      [userId, ...msgIds],
    );
    return new Map(rows.map((r) => [String(r.id), r]));
  }

  // Profile ids in the index are kind-prefixed (`territory:1`); the DB pk is
  // the bare integer. Select only this kind's ids, strip the prefix for the IN
  // clause, then re-key the returned map by the prefixed id so partitioning in
  // bulkSearch matches the ranked hit ids exactly (no cross-table collision).
  async function hydrateProfiles(table, idCol, prefix, ids, extraCols) {
    const mine = ids.filter((id) => id.startsWith(prefix));
    if (mine.length === 0) return new Map();
    const rawIds = mine.map(stripPrefix);
    const placeholders = rawIds.map(() => '?').join(',');
    const cols = `CAST(${idCol} AS TEXT) AS id, name, essence${extraCols}`;
    const rows = await rawRows(
      `SELECT ${cols} FROM ${table} WHERE user_id = ? AND CAST(${idCol} AS TEXT) IN (${placeholders})`,
      [userId, ...rawIds],
    );
    return new Map(rows.map((r) => [prefix + String(r.id), r]));
  }

  /**
   * The contract method. Runs the fused tier, then partitions ranked hits into
   * the 5 mindscape layers by checking which table owns each id.
   */
  async function bulkSearch(args = {}) {
    const query = (args.query ?? '').toString();
    const limit = args.limit || 5;
    const scope = args.scope || 'all';
    const agent = args.agent || null;
    const includeTopology = !!args.includeTopology;
    const excludeSensitive = !!args.excludeSensitive; // proactive recall (relatedTo)

    const empty = {
      messages: [],
      documents: [],
      territories: { formatted: [], raw: [] },
      realms: [],
      themes: [],
    };
    if (!query.trim()) return empty;

    await ensureBuilt();

    // Over-fetch so each layer can fill up to `limit` after partitioning.
    const { hits } = await backend.query({ text: query, topK: Math.max(limit * 10, 50) });
    if (hits.length === 0) return empty;

    const ids = hits.map((h) => h.id);
    const want = (layer) => scope === 'all' || scope === layer;

    // Hydrate each layer's matching ids. The id space is shared but each row
    // exists in exactly one table, so these maps are disjoint.
    const [msgMap, terrMap, realmMap, themeMap] = await Promise.all([
      want('messages') ? hydrateMessages(ids, { excludeSensitive }) : Promise.resolve(new Map()),
      want('territories') ? hydrateProfiles('territory_profiles', 'territory_id', ID_PREFIX.territory, ids, ', message_count') : Promise.resolve(new Map()),
      want('realms') ? hydrateProfiles('realms', 'realm_id', ID_PREFIX.realm, ids, ', message_count') : Promise.resolve(new Map()),
      want('themes') ? hydrateProfiles('semantic_themes', 'semantic_theme_id', ID_PREFIX.theme, ids, ', message_count') : Promise.resolve(new Map()),
    ]);

    const result = {
      messages: [],
      documents: [], // documents layer arrives with the mind-files unit; honest empty here
      territories: { formatted: [], raw: [] },
      realms: [],
      themes: [],
    };

    for (const id of ids) {
      if (result.messages.length >= limit && result.territories.raw.length >= limit
        && result.realms.length >= limit && result.themes.length >= limit) break;

      if (msgMap.has(id)) {
        if (result.messages.length >= limit) continue;
        const m = msgMap.get(id);
        if (agent && m.agent_id && m.agent_id !== agent) continue;
        result.messages.push(formatMessage(m));
      } else if (terrMap.has(id)) {
        if (result.territories.raw.length >= limit) continue;
        const t = terrMap.get(id);
        result.territories.raw.push(t);
        result.territories.formatted.push(formatProfile(t));
      } else if (realmMap.has(id)) {
        if (result.realms.length >= limit) continue;
        result.realms.push(formatProfile(realmMap.get(id)));
      } else if (themeMap.has(id)) {
        if (result.themes.length >= limit) continue;
        result.themes.push(formatProfile(themeMap.get(id)));
      }
    }

    // Optional topology expansion for matched territories. t.id here is the
    // bare DB pk (hydrateProfiles selected it CAST AS TEXT, unprefixed).
    if (includeTopology && result.territories.raw.length) {
      for (const t of result.territories.raw) {
        t.topology = await coFiringNeighbors(t.id);
      }
    }

    return result;
  }

  // Co-firing neighbors for a territory via db.topology.getCoFiring. Returns
  // [{ name, weight }] for the renderer; best-effort (empty on any failure).
  async function coFiringNeighbors(territoryId) {
    const topo = db && db.topology;
    if (!topo || typeof topo.getCoFiring !== 'function') return [];
    try {
      const rows = await topo.getCoFiring({
        p_user_id: userId,
        p_territory_id: territoryId,
        p_scale: 'weekly',
        p_limit: 5,
      });
      return (Array.isArray(rows) ? rows : []).map((r) => ({
        name: r.name,
        weight: r.cofire_strength,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Read the topology profile tables directly. Returns the three layers plus
   * counts; honest empty shape when the tables are empty.
   */
  async function structure() {
    const territories = await rawRows(
      'SELECT CAST(territory_id AS TEXT) AS id, name, essence, message_count FROM territory_profiles WHERE user_id = ? AND dissolved_at IS NULL ORDER BY message_count DESC LIMIT 100',
      [userId],
    );
    const realms = await rawRows(
      'SELECT CAST(realm_id AS TEXT) AS id, name, essence, message_count FROM realms WHERE user_id = ? ORDER BY message_count DESC LIMIT 100',
      [userId],
    );
    const themes = await rawRows(
      'SELECT CAST(semantic_theme_id AS TEXT) AS id, name, essence, message_count FROM semantic_themes WHERE user_id = ? ORDER BY message_count DESC LIMIT 100',
      [userId],
    );
    return {
      territories, realms, themes,
      counts: { territories: territories.length, realms: realms.length, themes: themes.length },
    };
  }

  const helpers = {
    bulkSearch,
    search,
    structure,
    rebuild,
    indexDocument,
    noteUpsert,
    noteDelete,
    noteVector,
    backend,
    backendKind,
    // expose isScoped for parity with the canonical searchHelpers shape
    isScoped: () => false,
  };

  // Register as the active instance for late-binding db helpers.
  setMindSearch(helpers);
  return helpers;
}

// ── Formatters (plaintext-safe; bounded snippets) ──────────────────────────

function snippet(text, n = 240) {
  return (text ?? '').toString().replace(/\s+/g, ' ').trim().slice(0, n);
}

function formatMessage(m) {
  const who = m.agent_id ? `[${m.agent_id}] ` : '';
  return `${who}${snippet(m.content)}`;
}

function formatProfile(p) {
  const count = p.message_count != null ? ` (${p.message_count} messages)` : '';
  return `**${p.name}**${count}\n${snippet(p.essence)}`;
}

// Re-exports for tests + downstream units.
export { createLocalBackend } from './backend/local.js';
export { createStubEmbedder, assertEmbedder } from './embedder.js';
export { setMindSearch, getMindSearch, clearMindSearch } from './registry.js';
export { rrf, maxRrfScore } from './fusion/rrf.js';
export { temporalBoost, temporalBoostWithProvider } from './fusion/temporal.js';
export { BM25Scorer, score as bm25Score } from './index/bm25.js';
export { InvertedIndex } from './index/inverted.js';
export { cosine, cosineUnit, topKCosine } from './ann/cosine.js';
export { tokenize, tokenizeStrings } from './index/tokenize.js';
export { loadFromDb } from './d1-loader.js';
export default createSearchHelpers;
