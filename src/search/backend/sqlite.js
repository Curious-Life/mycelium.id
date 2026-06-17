/**
 * SqliteBackend — on-disk FTS5 (BM25) + sqlite-vec (KNN) backend.
 *
 * Drop-in replacement for createLocalBackend (backend/local.js): SAME contract
 * — add/upsert, query → { hits:[{id,score}], degraded, tier, takenMs }, delete,
 * count, health — so bulkSearch + every caller are unchanged (search/index.js).
 *
 * The win (Phase 1): no whole-corpus rehydrate into the heap, no JS inverted
 * index / vector Map, no rebuild step. Search is two SQL queries fused by the
 * EXISTING RRF + temporal boost. Memory drops from ~2 GB to the page cache.
 *
 * Vector retrieval is two-stage (Decision D10): KNN a top-N shortlist in 256-d
 * (matryoshka prefix; ~2.9× faster than brute-force 768-d at 58k), then rescore
 * that shortlist by full 768-d cosine in-process. Accuracy ≈ full 768-d.
 *
 * Operates on a RAW better-sqlite3 handle (sync) with sqlite-vec loaded and the
 * search schema present (src/search/sqlite/schema.js). Async method signatures
 * are preserved for contract-compatibility even though the engine is synchronous.
 *
 * Per CLAUDE.md §1: never logs query text, tokens, ids, or vector values.
 */
import { tokenizeStrings } from '../index/tokenize.js';
import { rrf } from '../fusion/rrf.js';
import { temporalBoostWithProvider } from '../fusion/temporal.js';
import { assertEmbedder, safeEmbed } from '../embedder.js';
import { MindSearchError } from '../errors.js';
import { initSearchSchema, VEC_DIM, VEC_SHORTLIST_DIM } from '../sqlite/schema.js';

const DEFAULT_TOP_K = 20;
const DEFAULT_CANDIDATE_K = 50;
const SHORTLIST_K = 200; // D10 stage-1 256-d shortlist depth

/** Float32Array from Float32Array | number[] | null. */
function toF32(v) {
  if (v instanceof Float32Array) return v;
  if (Array.isArray(v)) return Float32Array.from(v);
  return null;
}
/** L2-normalize (in place on a copy); returns null for a zero/empty vector. */
function normalize(vec) {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (!(norm > 0)) return null;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}
/** 256-d matryoshka prefix of a 768-d vector, renormalized. */
function prefix256(vec) {
  return normalize(vec.subarray(0, VEC_SHORTLIST_DIM));
}
const f32buf = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);

/**
 * Build a safe FTS5 MATCH expression from free text: tokenize the same way the
 * in-RAM path did, quote every term (defuses FTS5 operator/syntax injection),
 * OR them together (broad recall, mirrors the inverted-index union). Returns
 * null when the query has no usable terms.
 */
function ftsMatchExpr(text) {
  const tokens = tokenizeStrings(text);
  if (!tokens.length) return null;
  // Dedup, cap, quote. A quoted token is a literal FTS5 string — no operators.
  const seen = new Set();
  const quoted = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    quoted.push(`"${t.replace(/"/g, '""')}"`);
    if (quoted.length >= 64) break;
  }
  return quoted.join(' OR ');
}

/**
 * @param {object} deps
 * @param {import('better-sqlite3').Database} deps.sqliteDb  raw handle (sync)
 * @param {{ embed, health }} [deps.embedder]                injected; omit for BM25-only
 * @param {string} [deps.userId]
 */
export function createSqliteBackend(deps = {}) {
  const raw = deps.sqliteDb;
  if (!raw || typeof raw.prepare !== 'function') {
    throw new TypeError('createSqliteBackend: deps.sqliteDb (better-sqlite3 handle) required');
  }
  const embedder = deps.embedder ? assertEmbedder(deps.embedder) : null;
  initSearchSchema(raw); // loadVec + ensure tables (idempotent)

  // Prepared statements (compiled once).
  const stmts = {
    metaUpsert: raw.prepare('INSERT INTO doc_meta(id, ts) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET ts = excluded.ts'),
    metaTs: raw.prepare('SELECT ts FROM doc_meta WHERE id = ?'),
    metaCount: raw.prepare('SELECT COUNT(*) AS c FROM doc_meta'),
    ftsDel: raw.prepare('DELETE FROM fts_docs WHERE id = ?'),
    ftsIns: raw.prepare('INSERT INTO fts_docs(id, content) VALUES (?, ?)'),
    vec768Del: raw.prepare('DELETE FROM vec_docs_768 WHERE id = ?'),
    vec768Ins: raw.prepare('INSERT INTO vec_docs_768(id, embedding) VALUES (?, ?)'),
    vec256Del: raw.prepare('DELETE FROM vec_docs_256 WHERE id = ?'),
    vec256Ins: raw.prepare('INSERT INTO vec_docs_256(id, embedding) VALUES (?, ?)'),
    metaDel: raw.prepare('DELETE FROM doc_meta WHERE id = ?'),
    bm25: raw.prepare('SELECT id, bm25(fts_docs) AS rank FROM fts_docs WHERE fts_docs MATCH ? ORDER BY rank LIMIT ?'),
    shortlist: raw.prepare('SELECT id FROM vec_docs_256 WHERE embedding MATCH ? ORDER BY distance LIMIT ?'),
    stateGet: raw.prepare('SELECT value FROM search_state WHERE key = ?'),
    stateSet: raw.prepare('INSERT INTO search_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  };
  let _lastQueryAt = null;

  /** Stage 2: rescore a shortlist by full 768-d cosine (best-first), top-K. */
  function rescore768(shortlistIds, queryBuf, topK) {
    if (!shortlistIds.length) return [];
    const placeholders = shortlistIds.map(() => '?').join(',');
    const sql = `SELECT id, vec_distance_cosine(embedding, ?) AS d
                 FROM vec_docs_768 WHERE id IN (${placeholders})
                 ORDER BY d LIMIT ?`;
    const rows = raw.prepare(sql).all(queryBuf, ...shortlistIds, topK);
    // cosine distance → similarity score (higher = better) for downstream RRF/temporal
    return rows.map((r) => ({ id: String(r.id), score: 1 - r.d }));
  }

  /** Embed the query text via the injected embedder (precomputed wins). */
  async function resolveQueryVec(query) {
    let v = toF32(query.embedding);
    if (!v && embedder && typeof query.text === 'string' && query.text.length > 0) {
      try { v = await safeEmbed(embedder, query.text, 'query'); } catch { v = null; }
    }
    return v ? normalize(v) : null;
  }

  /** Tier 1 — FTS5 BM25 + two-stage vec KNN → RRF → temporal boost. */
  async function tier1(query) {
    const topK = query.topK ?? DEFAULT_TOP_K;
    const candidateK = Math.max(topK * 5, DEFAULT_CANDIDATE_K);

    // Keyword list (best-first by bm25; rrf only uses order).
    let bm25Hits = [];
    if (typeof query.text === 'string' && query.text.length > 0) {
      const expr = ftsMatchExpr(query.text);
      if (expr) bm25Hits = stmts.bm25.all(expr, candidateK).map((r) => ({ id: String(r.id), score: -r.rank }));
    }

    // Vector list (two-stage 256→768). Skipped when no query vector (BM25-only).
    let annHits = [];
    const qVec = await resolveQueryVec(query);
    if (qVec && qVec.length === VEC_DIM) {
      const q256 = prefix256(qVec);
      if (q256) {
        const shortlistIds = stmts.shortlist.all(f32buf(q256), Math.max(candidateK, SHORTLIST_K)).map((r) => String(r.id));
        annHits = rescore768(shortlistIds, f32buf(qVec), candidateK);
      }
    }

    const lists = annHits.length ? [annHits, bm25Hits] : [bm25Hits];
    const fused = rrf(lists, { topK: topK * 3 });
    const boosted = temporalBoostWithProvider(
      fused,
      (id) => { const row = stmts.metaTs.get(id); return row ? row.ts : null; },
      { queryTs: query.queryTs, recency: query.recency ?? 'mixed' },
    );
    return boosted.slice(0, topK);
  }

  /** Add or replace a document (idempotent upsert by id). */
  async function add(req) {
    if (!req || typeof req !== 'object') throw new TypeError('add: req object required');
    if (typeof req.id !== 'string' || req.id.length === 0) throw new TypeError('add: req.id required');
    if (!Number.isFinite(req.ts)) throw new TypeError('add: req.ts must be a finite number');
    const id = req.id;

    let vec = toF32(req.embedding);
    if (!vec && embedder && typeof req.text === 'string' && req.text.length > 0) {
      try { vec = await safeEmbed(embedder, req.text, 'document'); } catch { vec = null; }
    }
    const norm = vec ? normalize(vec) : null;
    const norm256 = norm && norm.length === VEC_DIM ? prefix256(norm) : null;

    // One transaction per doc: meta + fts + (optional) vec, replace-then-insert.
    raw.transaction(() => {
      stmts.metaUpsert.run(id, Math.floor(req.ts));
      stmts.ftsDel.run(id);
      if (typeof req.text === 'string' && req.text.length > 0) stmts.ftsIns.run(id, req.text);
      stmts.vec768Del.run(id);
      stmts.vec256Del.run(id);
      // Decoupled inserts: a valid full 768-d vector is ALWAYS stored, even if
      // its 256-d matryoshka prefix is degenerate (all-zero — pathological for
      // sparse vectors; never for dense Nomic embeddings). Coupling them would
      // silently drop the whole vector when only the shortlist prefix is bad.
      if (norm && norm.length === VEC_DIM) {
        stmts.vec768Ins.run(id, f32buf(norm));
        if (norm256) stmts.vec256Ins.run(id, f32buf(norm256));
      }
    })();
  }

  async function query(req) {
    if (!req || typeof req !== 'object') throw new MindSearchError('query: req required', { cls: 'invalid_query' });
    _lastQueryAt = Math.floor(Date.now() / 1000);
    const t0 = Date.now();
    const hits = await tier1(req);
    return { hits, degraded: false, tier: 1, takenMs: Date.now() - t0 };
  }

  return {
    add,
    upsert: add,
    query,
    async delete(filter) {
      const ids = (filter && Array.isArray(filter.ids)) ? filter.ids : [];
      let deleted = 0;
      raw.transaction(() => {
        for (const id of ids) {
          const info = stmts.metaDel.run(id);
          if (info.changes > 0) {
            stmts.ftsDel.run(id);
            stmts.vec768Del.run(id);
            stmts.vec256Del.run(id);
            deleted++;
          }
        }
      })();
      return { deleted };
    },
    async count() { return stmts.metaCount.get().c; },
    // Vector-ready upsert (enrichment): replace ONLY this id's vector entries,
    // leaving its fts row + doc_meta.ts untouched (capture already set those at
    // the message's real created_at — re-add() would clobber ts with now()).
    noteVector(id, embedding) {
      if (typeof id !== 'string' || !id) return;
      const norm = embedding ? normalize(toF32(embedding)) : null;
      if (!norm || norm.length !== VEC_DIM) return;
      const norm256 = prefix256(norm);
      raw.transaction(() => {
        stmts.vec768Del.run(id);
        stmts.vec256Del.run(id);
        stmts.vec768Ins.run(id, f32buf(norm));
        if (norm256) stmts.vec256Ins.run(id, f32buf(norm256));
      })();
    },
    // Persisted "the whole corpus was loaded once" flag — robust against the
    // count()>0 heuristic breaking once incremental writes (noteUpsert) add rows
    // before the first query. ensureBuilt uses this to decide loadFromDb.
    isCorpusBuilt() { return stmts.stateGet.get('corpus_built')?.value === '1'; },
    markCorpusBuilt() { stmts.stateSet.run('corpus_built', '1'); },
    async health() {
      const embedHealthy = embedder ? await embedder.health().catch(() => false) : false;
      const indexLoaded = stmts.metaCount.get().c > 0;
      return {
        status: embedHealthy && indexLoaded ? 'ok' : (indexLoaded ? 'degraded' : 'down'),
        embedServiceUp: embedHealthy,
        indexLoaded,
        lastQueryAt: _lastQueryAt,
      };
    },
    _internal() { return { raw, stmts }; },
  };
}
