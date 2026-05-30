/**
 * search/helpers.js — `searchHelpers`, the dependency the mindscape tool
 * domain consumes (src/tools/mindscape.js).
 *
 *   createSearchHelpers({ db, embedder, userId, scopes }) -> {
 *     bulkSearch(args),   // REAL contract used by searchMindscape
 *     structure(),        // topology snapshot used by mindscapeStructure
 *     isScoped(),         // single-user: always false
 *     search(query,opts), // thin convenience over the mind-search tier
 *     addDoc(doc),        // feed a document into the in-RAM index
 *     backend,            // the underlying LocalBackend (tests/inspection)
 *   }
 *
 * This wires the in-RAM mind-search tier (BM25 + ANN cosine + RRF + temporal
 * boost, via src/search/backend/local.js) behind the bulkSearch shape the
 * MCP tool expects. Per the V1 plan this is the REAL searchMindscape — an
 * in-RAM index, not SQLite FTS5.
 *
 * EMBEDDER INJECTION (decision D2 / unit R2):
 *   The query→vector embedder (Nomic v1.5 ONNX, embed-service :8091) is built
 *   by a sibling unit and is NOT available here. It is therefore INJECTED.
 *   When no embedder is supplied, a lexical-only stub is used whose health()
 *   reports DOWN — the tier orchestrator then selects Tier 2 (BM25 + temporal,
 *   no semantic), so search still returns results without the model. Real
 *   semantic recall (ANN over Nomic vectors) is gated on R2.
 *
 * SINGLE-USER SIMPLIFICATION:
 *   The index is unconditional — there is no per-user filter wrapper. One
 *   process, one user, one in-RAM index (per reference/PORT-PRIORITY.md).
 *
 * Per CLAUDE.md §1/§7 nothing here logs query text, snippets, or vectors.
 */

import { createMindSearch } from './index.js';

/**
 * Lexical-only embedder stub. Conforms to the { embed, health } interface
 * (src/search/embedder.js) but advertises itself as DOWN so the tier
 * orchestrator never routes to the semantic (ANN) tier. embed() throws if
 * ever reached — a loud signal that tier selection misbehaved, never a
 * silent wrong-answer.
 */
function lexicalOnlyEmbedder() {
  return {
    async embed() {
      throw new Error(
        'mind-search: embedder not configured (lexical-only mode); ' +
          'real embed-service (R2) not wired',
      );
    },
    async health() {
      return false;
    },
  };
}

/**
 * Build an in-RAM mind-search backend pre-loaded from a list of docs.
 * Each doc: { id, text, type?, ts?, embedding? }. Returns the backend +
 * the metadata store (id -> { text, type, ts }) used to render results.
 *
 * Exposed so callers (and verify) can construct a ready index synchronously
 * without a D1 loader. ts defaults to now; type defaults to 'message'.
 */
export async function buildBackendFromDocs(docs = [], deps = {}) {
  const helpers = createSearchHelpers(deps);
  for (const d of docs) await helpers.addDoc(d);
  return helpers;
}

export function createSearchHelpers({
  db = null,
  embedder = null,
  userId = 'local-user',
  scopes = ['personal'],
} = {}) {
  // The LocalBackend requires a non-null masterKey purely as a presence
  // check (it's used only by the persistence path, which V1 does not wire).
  // A sentinel satisfies the guard without enabling any disk/crypto path.
  const masterKey = { _v1InRamSentinel: true };

  const backend = createMindSearch({
    embedder: embedder ?? lexicalOnlyEmbedder(),
    masterKey,
    scopes,
    userId,
    // no persistPath, no reranker, no db.ping -> no Tier-4 SQL fallback
    // (the in-RAM index is the floor for the single-user vault).
  });

  // id -> { text, type, ts }. Lets us bucket results by mindscape layer and
  // render snippets (the backend returns only { id, score, ts }).
  const meta = new Map();

  /**
   * Add a document to the in-RAM index.
   * @param {{ id, text, type?, ts?, embedding? }} doc
   */
  async function addDoc(doc) {
    if (!doc || typeof doc.id !== 'string') {
      throw new TypeError('addDoc: doc.id (string) required');
    }
    const ts = Number.isFinite(doc.ts)
      ? doc.ts
      : Math.floor(Date.now() / 1000);
    const type = doc.type || 'message';
    meta.set(doc.id, { text: doc.text ?? '', type, ts });
    await backend.add({
      id: doc.id,
      text: doc.text ?? '',
      embedding: doc.embedding,
      ts,
    });
  }

  /**
   * Run the mind-search tier and enrich hits with stored text/type/ts.
   * @returns {Promise<Array<{ id, score, ts, type, text, snippet }>>}
   */
  async function search(query, opts = {}) {
    if (typeof query !== 'string' || query.length === 0) return [];
    // Cold start: an empty index makes every tier's health probe fail
    // (indexLoaded=false, no db.ping for the SQL floor), so the orchestrator
    // throws `all_tiers_exhausted`. For a fresh single-user vault that is the
    // normal state, not an error — degrade to "no results" so searchMindscape
    // returns "No results for …" rather than surfacing an error envelope.
    if ((await backend.count()) === 0) return [];
    const topK = opts.limit ?? opts.topK ?? 10;
    const recency = opts.recency ?? 'mixed';
    let result;
    try {
      result = await backend.query({ text: query, topK, recency });
    } catch (err) {
      // Every tier exhausted (e.g. embed down AND index unavailable mid-rebuild)
      // is a degraded-to-empty case for the tool surface, not a crash. Other
      // error classes (invalid query, etc.) still propagate.
      if (err && err.class === 'all_tiers_exhausted') return [];
      throw err;
    }
    const hits = Array.isArray(result?.hits) ? result.hits : [];
    return hits.map((h) => {
      const m = meta.get(h.id) || {};
      const text = m.text ?? '';
      return {
        id: h.id,
        score: h.score,
        ts: h.ts ?? m.ts ?? null,
        type: m.type ?? 'message',
        text,
        snippet: snippetOf(text),
      };
    });
  }

  /**
   * The contract searchMindscape depends on. Routes ranked hits into the
   * mindscape layers (messages / documents / territories / realms / themes)
   * by each doc's stored `type`. A `scope` of 'all' searches everything;
   * a specific scope restricts the buckets that get populated.
   *
   * territories/realms/themes are TOPOLOGY layers produced by the
   * AnalysisEngine / enrichment pipeline (a separate V1 unit). Until that
   * runs there are no topology docs in the index, so those buckets are
   * honestly empty. Messages + documents come from the in-RAM index.
   */
  async function bulkSearch(args = {}) {
    const query = args.query ?? '';
    const limit = args.limit ?? 5;
    const scope = args.scope ?? 'all';

    const empty = {
      messages: [],
      documents: [],
      territories: { formatted: [], raw: [] },
      realms: [],
      themes: [],
    };
    if (!query) return empty;

    // Pull a generous candidate set, then bucket by type. Buckets are each
    // trimmed to `limit`. Filtering by `agent` is a no-op in V1 (single
    // user, single agent) — accepted and ignored, documented in the schema.
    const hits = await search(query, { limit: limit * 5 });

    const wantsAll = scope === 'all';
    const out = {
      messages: [],
      documents: [],
      territories: { formatted: [], raw: [] },
      realms: [],
      themes: [],
    };

    for (const h of hits) {
      const t = h.type;
      if ((wantsAll || scope === 'messages') && t === 'message' && out.messages.length < limit) {
        out.messages.push(h.snippet || h.text || h.id);
      } else if ((wantsAll || scope === 'documents') && t === 'document' && out.documents.length < limit) {
        out.documents.push(h.snippet || h.text || h.id);
      } else if ((wantsAll || scope === 'territories') && t === 'territory' && out.territories.formatted.length < limit) {
        out.territories.formatted.push(h.snippet || h.text || h.id);
        out.territories.raw.push({ id: h.id, name: h.text || h.id, topology: [] });
      } else if ((wantsAll || scope === 'realms') && t === 'realm' && out.realms.length < limit) {
        out.realms.push(h.snippet || h.text || h.id);
      } else if ((wantsAll || scope === 'themes') && t === 'theme' && out.themes.length < limit) {
        out.themes.push(h.snippet || h.text || h.id);
      }
    }
    return out;
  }

  /**
   * Structural snapshot of the mindscape (clusters / harmonic topology).
   * Reads topology tables via `db` when they exist; returns an empty, honest
   * structure when they do not (topology is populated by the enrichment
   * pipeline, a separate unit). Never fabricates topology.
   */
  async function structure() {
    const clusters = await readClusters(db);
    return { clusters };
  }

  return {
    backend,
    bulkSearch,
    structure,
    isScoped: () => false,
    search,
    addDoc,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────

function snippetOf(text, max = 200) {
  if (typeof text !== 'string') return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * Read topology clusters from the db if a clusters table exists. Returns an
 * empty array when the table is absent or empty. Probes sqlite_master so a
 * missing table degrades cleanly rather than throwing.
 */
async function readClusters(db) {
  if (!db || typeof db.rawQuery !== 'function') return [];
  let rows;
  try {
    const probe = await db.rawQuery(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='clustering_points' LIMIT 1",
    );
    const found = Array.isArray(probe) ? probe.length > 0 : !!probe;
    if (!found) return [];
  } catch {
    return [];
  }
  try {
    rows = await db.rawQuery(
      'SELECT territory_id AS id, COUNT(*) AS size FROM clustering_points ' +
        'WHERE territory_id IS NOT NULL GROUP BY territory_id ORDER BY size DESC LIMIT 50',
    );
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({ id: r.id, size: r.size }));
}
