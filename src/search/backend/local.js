/**
 * LocalBackend — composes the mind-search primitives into a working backend.
 *
 * Ported from reference/mind-search/backend/local.js, reduced for the V1
 * single-user build:
 *   - Embedder is INJECTED (sibling unit R2 owns the real one); no masterKey /
 *     scopes / persist / metrics / degrade-tier orchestrator deps. Those land
 *     with the encryption + degradation units. Documented divergence.
 *   - The tier-1 pipeline is ported verbatim: embed query → ANN over cached
 *     vectors + BM25 over the inverted index → RRF merge → temporal boost.
 *   - When no embedder is wired (or it is down), the backend runs BM25-only and
 *     still returns ranked results (the reference Tier-2 behavior).
 *
 * Per CLAUDE.md §1, no method here logs query text, tokens, or vector values.
 */

import { tokenizeStrings } from '../index/tokenize.js';
import { InvertedIndex } from '../index/inverted.js';
import { BM25Scorer } from '../index/bm25.js';
import { topKCosine } from '../ann/cosine.js';
import { rrf } from '../fusion/rrf.js';
import { temporalBoostWithProvider } from '../fusion/temporal.js';
import { assertEmbedder, safeEmbed } from '../embedder.js';
import { MindSearchError } from '../errors.js';

const DEFAULT_TOP_K = 20;
const DEFAULT_CANDIDATE_K = 50;

/**
 * @param {object} deps
 * @param {{ embed, health }} [deps.embedder]   injected; omit for BM25-only
 * @param {string} [deps.userId]
 * @param {InvertedIndex} [deps.index]          pre-built index (tests)
 */
export function createLocalBackend(deps = {}) {
  const embedder = deps.embedder ? assertEmbedder(deps.embedder) : null;
  // Stub / non-unit embedders need the full-cosine path; unit vectors (real
  // Nomic) use the faster dot-product path.
  const assumeUnit = embedder ? embedder.unit !== false : true;

  let _index = deps.index instanceof InvertedIndex ? deps.index : new InvertedIndex();
  /** @type {Map<string, Float32Array>} */
  const _vectors = new Map();
  let _scorer = new BM25Scorer(_index);
  let _lastQueryAt = null;

  function annTopK(query, vectors, k) {
    if (vectors.size === 0) return [];
    const ids = new Array(vectors.size);
    const vecs = new Array(vectors.size);
    let i = 0;
    for (const [id, vec] of vectors) { ids[i] = id; vecs[i] = vec; i++; }
    const top = topKCosine(query, vecs, k, { assumeUnit });
    return top.map(({ idx, score }) => ({ id: ids[idx], score }));
  }

  /** Tier 1 — embed → ANN + BM25 → RRF → temporal. BM25-only if no vectors. */
  async function tier1(query) {
    const topK = query.topK ?? DEFAULT_TOP_K;
    const candidateK = Math.max(topK * 5, DEFAULT_CANDIDATE_K);

    // Query embedding (precomputed wins; else embed via injected embedder).
    let queryEmbedding = null;
    if (query.embedding instanceof Float32Array) {
      queryEmbedding = query.embedding;
    } else if (Array.isArray(query.embedding)) {
      queryEmbedding = Float32Array.from(query.embedding);
    } else if (embedder && typeof query.text === 'string' && query.text.length > 0) {
      try {
        queryEmbedding = await safeEmbed(embedder, query.text, 'query');
      } catch {
        queryEmbedding = null; // embed down → BM25-only this query
      }
    }

    const annHits = queryEmbedding ? annTopK(queryEmbedding, _vectors, candidateK) : [];
    const bm25Hits = query.text ? _scorer.score(tokenizeStrings(query.text), { topK: candidateK }) : [];

    const lists = annHits.length ? [annHits, bm25Hits] : [bm25Hits];
    const fused = rrf(lists, { topK: topK * 3 });

    const boosted = temporalBoostWithProvider(
      fused,
      (id) => _index.documentTs(id),
      { queryTs: query.queryTs, recency: query.recency ?? 'mixed' },
    );
    return boosted.slice(0, topK);
  }

  /**
   * Add (or replace) a document. Embedding is best-effort: if absent and an
   * embedder is wired, embed with task=document; if that fails, the doc is
   * still BM25-searchable (ANN just won't return it). Pass skipEmbed=true to
   * suppress the live embed-service round-trip entirely (BM25-only) — used by
   * the loader for sources with no stored vector that must not pay a per-row
   * :8091 call at cold start (e.g. documents; DOCUMENT-SEARCH design 2026-06-17).
   * @param {{ id:string, text?:string, embedding?:Float32Array|number[], ts:number, skipEmbed?:boolean }} req
   */
  async function add(req) {
    if (!req || typeof req !== 'object') throw new TypeError('add: req object required');
    if (typeof req.id !== 'string' || req.id.length === 0) throw new TypeError('add: req.id required');
    if (!Number.isFinite(req.ts)) throw new TypeError('add: req.ts must be a finite number');

    const tokens = typeof req.text === 'string' && req.text.length > 0 ? tokenizeStrings(req.text) : [];
    _index.add(req.id, tokens, req.ts);
    _scorer.invalidate();

    let vec = null;
    if (req.embedding instanceof Float32Array) vec = req.embedding;
    else if (Array.isArray(req.embedding)) vec = Float32Array.from(req.embedding);
    else if (!req.skipEmbed && embedder && typeof req.text === 'string' && req.text.length > 0) {
      try { vec = await safeEmbed(embedder, req.text, 'document'); } catch { vec = null; }
    }
    if (vec) _vectors.set(req.id, vec);
  }

  async function query(req) {
    if (!req || typeof req !== 'object') throw new MindSearchError('query: req required', { cls: 'invalid_query' });
    _lastQueryAt = Math.floor(Date.now() / 1000);
    const hits = await tier1(req);
    return { hits, degraded: false, tier: 1, takenMs: 0 };
  }

  // Contract parity with the on-disk backend (loadFromDb feature-detects these).
  // The in-RAM index has no per-doc transaction cost, so bulkAdd is just a loop;
  // resetIndex gives a full rebuild a clean slate (evicts rows deleted from the
  // source since the last build — add() alone only ever replaces-by-id).
  function resetIndex() {
    _index = new InvertedIndex();
    _vectors.clear();
    _scorer = new BM25Scorer(_index);
  }
  async function bulkAdd(docs) {
    if (!Array.isArray(docs)) return 0;
    let n = 0;
    for (const d of docs) { try { await add(d); n++; } catch { /* skip */ } }
    return n;
  }

  return {
    add,
    upsert: add,
    bulkAdd,
    resetIndex,
    query,
    async delete(filter) {
      const ids = (filter && Array.isArray(filter.ids)) ? filter.ids : [];
      let deleted = 0;
      for (const id of ids) {
        if (_index.has(id)) { _index.remove(id); _vectors.delete(id); deleted++; }
      }
      if (deleted > 0) _scorer.invalidate();
      return { deleted };
    },
    async count() { return _index.totalDocs(); },
    async health() {
      const embedHealthy = embedder ? await embedder.health().catch(() => false) : false;
      const indexLoaded = _index.totalDocs() > 0;
      return {
        status: embedHealthy && indexLoaded ? 'ok' : (indexLoaded ? 'degraded' : 'down'),
        embedServiceUp: embedHealthy,
        indexLoaded,
        indexSize: _index.size().tokens,
        lastQueryAt: _lastQueryAt,
      };
    },
    _internal() { return { index: _index, vectors: _vectors, scorer: _scorer }; },
  };
}
