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
import { loadFromDb, ID_PREFIX, stripPrefix } from './d1-loader.js';
import { setMindSearch } from './registry.js';

const DEFAULT_USER = 'local-user';

export function createSearchHelpers(deps = {}) {
  const { db = null, embedder = null, userId = DEFAULT_USER } = deps;

  const backend = createLocalBackend({ embedder, userId });
  let built = false;

  async function ensureBuilt() {
    if (built) return;
    if (db && typeof db.rawQuery === 'function') {
      try { await loadFromDb({ backend, db, userId }); } catch { /* fall through */ }
    }
    built = true;
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
  async function hydrateMessages(ids) {
    const msgIds = ids.filter((id) => !id.includes(':'));
    if (msgIds.length === 0) return new Map();
    const placeholders = msgIds.map(() => '?').join(',');
    const rows = await rawRows(
      `SELECT id, content, agent_id, created_at FROM messages WHERE user_id = ? AND id IN (${placeholders})`,
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
      want('messages') ? hydrateMessages(ids) : Promise.resolve(new Map()),
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
    backend,
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
