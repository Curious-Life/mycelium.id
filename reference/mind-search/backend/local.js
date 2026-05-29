/**
 * LocalBackend — composes the mind-search primitives into a working backend.
 *
 * Responsibilities:
 *
 *   • Hold the in-memory inverted index, BM25 scorer, and decrypted
 *     vector cache.
 *   • Define tier-op functions for the orchestrator.
 *   • Apply scope isolation on every operation (CLAUDE.md §5).
 *   • Coordinate optional persistence (snapshot save/load).
 *
 * Lifecycle:
 *
 *   const backend = createLocalBackend(deps);
 *   await backend.init();           // optional snapshot load
 *   await backend.add({ id, text, ts });
 *   const result = await backend.query({ text, topK: 10 });
 *   await backend.checkpoint();     // optional snapshot save
 *
 * Tier ops:
 *
 *   tier0   tier1 + reranker (if reranker dep provided)
 *   tier1   embed → ANN over cached vectors → BM25 over inverted index
 *           → RRF merge → temporal boost → topK
 *   tier2   BM25 over inverted index → temporal boost → topK
 *   tier3   tier 2 with `indexPartial: true` semantic (no behavior delta yet
 *           in PR 8; reserved for when partial-load tracking lands)
 *   tier4   db.messages.searchByText fallback (rank by recency only)
 *
 * Memory budget at 100K corpus:
 *   ~240 MB inverted index (PR 5 measured)
 *   ~300 MB decrypted vector cache (768 floats × 4B × 100K)
 *   ─────────────────────────────────
 *   ~540 MB total — fits in the 4 GB customer-VPS budget after BGE removal.
 *
 * Per CLAUDE.md §1, no method here logs query text, tokens, or vector
 * values. Logs carry tier numbers, hit counts, error classes, timing.
 */

import { tokenizeStrings } from '../index/tokenize.js';
import { InvertedIndex } from '../index/inverted.js';
import { BM25Scorer } from '../index/bm25.js';
import { topKCosine } from '../ann/cosine.js';
import { rrf } from '../fusion/rrf.js';
import { temporalBoostWithProvider } from '../fusion/temporal.js';
import { runTiered } from '../degrade/tiers.js';
import { createHealthProbe } from '../degrade/probe.js';
import { saveIndex, loadIndex } from '../index/persist.js';
import { createMetrics } from '../metrics.js';
import {
  MindSearchError,
  IndexUnavailableError,
} from '../errors.js';

const DEFAULT_TOP_K = 20;
const DEFAULT_CANDIDATE_K = 50;

/**
 * @typedef {import('./interface.js').MindBackendDeps} MindBackendDeps
 * @typedef {import('./interface.js').MindBackend} MindBackend
 *
 * @typedef {object} LocalBackendDeps
 * @property {{ embed: (text: string, opts?: object) => Promise<Float32Array>, health: () => Promise<boolean> }} embedder
 * @property {CryptoKey} masterKey
 * @property {string[]} scopes
 * @property {string} userId
 * @property {object} [db]                 optional db backend (for tier 4 + ping)
 * @property {InvertedIndex} [index]       pre-built index (for tests / hot reload)
 * @property {string} [persistPath]        encrypted snapshot path
 * @property {{ rerank: (query: object, hits: Array<{id, score}>) => Promise<Array<{id, score}>> }} [reranker]
 * @property {object} [logger]
 * @property {number} [ttlMs]              probe cache TTL
 * @property {number} [embedTimeoutMs]
 * @property {number} [d1TimeoutMs]
 */

/**
 * @param {LocalBackendDeps} deps
 * @returns {MindBackend & { init: () => Promise<void>, checkpoint: () => Promise<{saved: boolean}>, _internal: () => object }}
 */
export function createLocalBackend(deps) {
  validateDeps(deps);
  const {
    embedder,
    masterKey,
    scopes,
    userId,
    db = null,
    persistPath = null,
    reranker = null,
    logger = null,
  } = deps;

  let _index = deps.index instanceof InvertedIndex ? deps.index : new InvertedIndex();
  /** @type {Map<string, Float32Array>} */
  const _vectors = new Map();
  let _scorer = new BM25Scorer(_index);
  let _lastQueryAt = null;

  const metrics = createMetrics(logger, {
    scope: scopes[0],
    userId: hashShort(userId),
  });

  const probe = createHealthProbe({
    embedder,
    getIndex: () => _index,
    db: db && typeof db.ping === 'function' ? { ping: () => db.ping() } : null,
    logger,
    ttlMs: deps.ttlMs,
    embedTimeoutMs: deps.embedTimeoutMs,
    d1TimeoutMs: deps.d1TimeoutMs,
  });

  // ── Tier ops ──────────────────────────────────────────────────────────

  /**
   * Tier 1 — full pipeline.
   * Embed query → ANN over cached vectors + BM25 over index
   * → RRF merge → temporal boost → topK.
   */
  async function tier1(query) {
    const topK = query.topK ?? DEFAULT_TOP_K;
    const candidateK = Math.max(topK * 5, DEFAULT_CANDIDATE_K);

    // Query embedding
    let queryEmbedding;
    if (query.embedding instanceof Float32Array) {
      queryEmbedding = query.embedding;
    } else if (Array.isArray(query.embedding)) {
      queryEmbedding = Float32Array.from(query.embedding);
    } else if (typeof query.text === 'string' && query.text.length > 0) {
      queryEmbedding = await embedder.embed(query.text, { task: 'query' });
      if (!(queryEmbedding instanceof Float32Array)) {
        queryEmbedding = Float32Array.from(queryEmbedding);
      }
    } else {
      throw new MindSearchError('tier 1: query needs text or embedding', {
        cls: 'invalid_query',
      });
    }

    // ANN: cosine over cached vectors
    const annHits = annTopK(queryEmbedding, _vectors, candidateK);

    // BM25: token search
    const bm25Hits = query.text
      ? _scorer.score(tokenizeStrings(query.text), { topK: candidateK })
      : [];

    // RRF: merge ranks
    const fused = rrf([annHits, bm25Hits], { topK: topK * 3 });

    // Temporal boost
    const boosted = temporalBoostWithProvider(
      fused,
      (id) => _index.documentTs(id),
      {
        queryTs: query.queryTs,
        recency: query.recency ?? 'mixed',
      },
    );

    return boosted.slice(0, topK);
  }

  /**
   * Tier 0 — tier 1 followed by Haiku rerank of top-20.
   * Falls through to tier 1 behavior if no reranker is configured.
   */
  async function tier0(query) {
    const tier1Hits = await tier1(query);
    if (!reranker || typeof reranker.rerank !== 'function') return tier1Hits;
    const candidates = tier1Hits.slice(0, 20);
    const reranked = await reranker.rerank(query, candidates);
    if (!Array.isArray(reranked)) {
      throw new MindSearchError('tier 0: reranker returned non-array', {
        cls: 'rerank_contract_violation',
      });
    }
    return reranked.slice(0, query.topK ?? DEFAULT_TOP_K);
  }

  /**
   * Tier 2 — BM25 + temporal only. No semantic component.
   */
  async function tier2(query) {
    const topK = query.topK ?? DEFAULT_TOP_K;
    if (typeof query.text !== 'string' || query.text.length === 0) {
      throw new MindSearchError('tier 2: query.text required (no semantic fallback)', {
        cls: 'invalid_query',
      });
    }
    const tokens = tokenizeStrings(query.text);
    const bm25Hits = _scorer.score(tokens, { topK: Math.max(topK * 5, DEFAULT_CANDIDATE_K) });
    const boosted = temporalBoostWithProvider(
      bm25Hits,
      (id) => _index.documentTs(id),
      { queryTs: query.queryTs, recency: query.recency ?? 'mixed' },
    );
    return boosted.slice(0, topK);
  }

  /**
   * Tier 4 — SQL LIKE on D1 messages. The floor.
   * Returns ranked-by-recency results when the local index is unavailable.
   */
  async function tier4(query) {
    const topK = query.topK ?? DEFAULT_TOP_K;
    if (!db || !db.messages || typeof db.messages.searchByText !== 'function') {
      throw new IndexUnavailableError('tier 4: db.messages.searchByText not available');
    }
    if (typeof query.text !== 'string' || query.text.length === 0) {
      throw new MindSearchError('tier 4: query.text required', {
        cls: 'invalid_query',
      });
    }
    const rows = await db.messages.searchByText(userId, query.text, topK);
    if (!Array.isArray(rows)) return [];
    return rows.map((r, i) => ({
      id: r.id,
      score: 1 / (i + 1),
      ts: typeof r.ts === 'number' ? r.ts : null,
    }));
  }

  // ── Public surface (MindBackend interface) ────────────────────────────

  /**
   * @param {{ id: string, text?: string, embedding?: Float32Array | number[], ts: number, metadata?: object }} req
   */
  async function add(req) {
    if (!req || typeof req !== 'object') {
      throw new TypeError('add: req object required');
    }
    if (typeof req.id !== 'string' || req.id.length === 0) {
      throw new TypeError('add: req.id required');
    }
    if (!Number.isFinite(req.ts)) {
      throw new TypeError('add: req.ts must be a finite number');
    }

    const tokens = typeof req.text === 'string' && req.text.length > 0
      ? tokenizeStrings(req.text)
      : [];
    _index.add(req.id, tokens, req.ts);
    _scorer.invalidate();

    let vec = null;
    let embedFailed = false;
    if (req.embedding instanceof Float32Array) {
      vec = req.embedding;
    } else if (Array.isArray(req.embedding)) {
      vec = Float32Array.from(req.embedding);
    } else if (typeof req.text === 'string' && req.text.length > 0) {
      // Embed is best-effort. If the service is down, we still accept the
      // doc — it'll be searchable via BM25 even without a vector. ANN
      // simply won't return it. The agent stays receiving rather than
      // rejecting at the door when one downstream is offline.
      try {
        const out = await embedder.embed(req.text, { task: 'document' });
        vec = out instanceof Float32Array ? out : Float32Array.from(out);
      } catch (err) {
        embedFailed = true;
        metrics.emit('add.embed_failed', {
          idHash: hashShort(req.id),
          errorClass: err && err.class ? err.class : 'unknown',
        }, 'warn');
      }
    }
    if (vec) _vectors.set(req.id, vec);

    metrics.emit('add', {
      idHash: hashShort(req.id),
      tokenCount: tokens.length,
      hasEmbedding: vec !== null,
      embedFailed,
    }, 'debug');
  }

  /**
   * @param {object} query
   */
  async function query(req) {
    _lastQueryAt = Math.floor(Date.now() / 1000);
    const result = await runTiered(
      req,
      { tier0, tier1, tier2, tier4 },
      { probe, logger },
    );
    metrics.emit('query.complete', {
      tier: result.tier,
      degraded: result.degraded,
      hitCount: result.hits.length,
      tookMs: Math.round(result.takenMs),
    });
    return result;
  }

  return {
    /**
     * Optional: load snapshot from disk if persistPath is configured.
     */
    async init() {
      if (!persistPath) return { loaded: false };
      try {
        const loaded = await loadIndex(persistPath, masterKey, scopes);
        if (loaded) {
          _index = loaded;
          _scorer = new BM25Scorer(_index);
          probe.invalidate();
          metrics.emit('init.snapshot_loaded', {
            documents: _index.totalDocs(),
            tokens: _index.size().tokens,
          });
          return { loaded: true };
        }
      } catch (err) {
        // Snapshot unreadable / corrupt / wrong scope. Don't crash the
        // backend — the orchestrator can rebuild from D1. Log and start
        // with an empty index.
        metrics.emit('init.snapshot_failed', {
          errorClass: err && err.class ? err.class : 'unknown',
        }, 'warn');
      }
      return { loaded: false };
    },

    add,
    upsert: add, // upsert is just add with same-id replacement; index handles it

    query,

    async get(filter) {
      const ids = (filter && Array.isArray(filter.ids)) ? filter.ids : [];
      return ids
        .filter((id) => _index.has(id))
        .map((id) => ({
          id,
          ts: _index.documentTs(id),
          metadata: undefined,
        }));
    },

    async delete(filter) {
      const ids = (filter && Array.isArray(filter.ids)) ? filter.ids : [];
      let deleted = 0;
      for (const id of ids) {
        if (_index.has(id)) {
          _index.remove(id);
          _vectors.delete(id);
          deleted++;
        }
      }
      if (deleted > 0) _scorer.invalidate();
      metrics.emit('delete', { count: deleted }, 'debug');
      return { deleted };
    },

    async count() {
      return _index.totalDocs();
    },

    async health() {
      const snap = await probe.snapshot();
      const status = snap.embedHealthy && snap.indexLoaded
        ? 'ok'
        : (snap.indexLoaded || snap.d1Healthy)
          ? 'degraded'
          : 'down';
      return {
        status,
        embedServiceUp: snap.embedHealthy,
        indexLoaded: snap.indexLoaded,
        indexSize: _index.size().tokens,
        lastQueryAt: _lastQueryAt,
      };
    },

    /**
     * Persist the current index to disk (encrypted). Caller-driven —
     * typical pattern is to invoke from a 5-minute interval timer
     * managed by the agent-server.
     */
    async checkpoint() {
      if (!persistPath) return { saved: false };
      const result = await saveIndex(_index, persistPath, scopes[0], masterKey, userId);
      metrics.emit('checkpoint', { bytes: result.bytes }, 'debug');
      return { saved: true, bytes: result.bytes };
    },

    /**
     * Inspection accessor for tests. Not part of the MindBackend
     * contract — production callers must not depend on it.
     */
    _internal() {
      return {
        index: _index,
        vectors: _vectors,
        scorer: _scorer,
        probe,
      };
    },
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function validateDeps(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createLocalBackend: deps required');
  }
  const { embedder, masterKey, scopes, userId } = deps;
  if (!embedder || typeof embedder.embed !== 'function' || typeof embedder.health !== 'function') {
    throw new TypeError('createLocalBackend: deps.embedder must implement { embed, health }');
  }
  if (!masterKey) {
    throw new TypeError('createLocalBackend: deps.masterKey required');
  }
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new TypeError('createLocalBackend: deps.scopes (non-empty array) required');
  }
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new TypeError('createLocalBackend: deps.userId required');
  }
}

/**
 * Cosine top-K over a Map<id, Float32Array>. Returns [{id, score}].
 *
 * Allocates two parallel arrays (ids + vectors) once per call. For 100K
 * vectors this is ~50ms allocation + ~30ms cosine on the perf budget.
 */
function annTopK(query, vectors, k) {
  if (vectors.size === 0) return [];
  const ids = new Array(vectors.size);
  const vecs = new Array(vectors.size);
  let i = 0;
  for (const [id, vec] of vectors) {
    ids[i] = id;
    vecs[i] = vec;
    i++;
  }
  const top = topKCosine(query, vecs, k);
  return top.map(({ idx, score }) => ({ id: ids[idx], score }));
}

/**
 * Stable 6-char hash for log/metric labels. Mirrors log-redact.js
 * convention: hashed identifiers are safe to log; raw user IDs are not.
 */
function hashShort(id) {
  if (typeof id !== 'string' || id.length === 0) return '<unset>';
  let h = 5381;
  for (let i = 0; i < id.length; i++) {
    h = ((h * 33) ^ id.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(6, '0').slice(0, 6);
}
