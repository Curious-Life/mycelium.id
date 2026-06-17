/**
 * On-disk search schema (Phase 1) — FTS5 + sqlite-vec virtual tables.
 *
 * These tables live INSIDE the vault DB (so at step 5 they inherit whole-file
 * encryption — see docs/SEARCH-INDEX-PHASE1-DESIGN). They replace the in-RAM
 * inverted index + vector Map (src/search/index/, backend/local.js):
 *   - fts_docs       FTS5 over (id, content) → BM25 keyword ranking
 *   - vec_docs_768   vec0 768-d cosine → rescore source (D10 stage 2)
 *   - vec_docs_256   vec0 256-d cosine → matryoshka shortlist (D10 stage 1)
 *   - doc_meta       (id, ts) → temporal-boost timestamp lookup + existence
 *
 * `id` is the mind-search index id: bare UUID for messages, kind-prefixed
 * (`territory:1`,`realm:N`,`theme:N`) for profiles — same space as d1-loader.
 *
 * Per CLAUDE.md §1: nothing here logs content/ids/vectors.
 */
import * as sqliteVec from 'sqlite-vec';

export const VEC_DIM = 768;
export const VEC_SHORTLIST_DIM = 256; // Nomic v1.5 matryoshka prefix

/** Load the sqlite-vec extension onto a raw better-sqlite3 handle (idempotent-safe). */
export function loadVec(rawDb) {
  sqliteVec.load(rawDb);
  return rawDb;
}

/**
 * Create the search vtables + meta table if absent. Idempotent (IF NOT EXISTS),
 * so safe to call on every open. Assumes loadVec() already ran on this handle.
 * @param {import('better-sqlite3').Database} rawDb
 */
export function ensureSearchSchema(rawDb) {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS doc_meta (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_docs USING fts5(
      id UNINDEXED,
      content,
      tokenize = 'unicode61 remove_diacritics 2'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_docs_768 USING vec0(
      id TEXT PRIMARY KEY,
      embedding float[${VEC_DIM}] distance_metric=cosine
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_docs_256 USING vec0(
      id TEXT PRIMARY KEY,
      embedding float[${VEC_SHORTLIST_DIM}] distance_metric=cosine
    );
  `);
  return rawDb;
}

/** loadVec + ensureSearchSchema in one call. */
export function initSearchSchema(rawDb) {
  loadVec(rawDb);
  ensureSearchSchema(rawDb);
  return rawDb;
}
