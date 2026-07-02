// src/search/sqlite/sidecar.js — the on-disk search index (FTS5 + sqlite-vec)
// lives in a SEPARATE, SQLCipher-encrypted database file next to the vault, NOT
// inside the vault DB.
//
// WHY (docs/SEARCH-SIDECAR-DESIGN-2026-07-02.md + VAULT-DURABILITY-AUDIT-FINDINGS):
// the index is 100% regenerable from content, but a corrupt FTS5/vec0 table
// CANNOT be DROPped or DELETEd (the drop itself throws `database disk image is
// malformed` — proven). Inside the vault that made a regenerable index a FATAL,
// un-repairable vault error, and its heavy bulk-build checkpoint shared a WAL with
// content. In a sidecar, a corrupt index is recovered by a file-level `rm` +
// rebuild (self-healing, non-fatal), and its checkpoint can never tear content.
//
// Embeddings are semantic fingerprints of plaintext (CLAUDE.md §7) → the sidecar
// is keyed with the SAME DB-file key as the vault (whole-file SQLCipher). No
// plaintext ever lands here (temp_store=MEMORY). Nothing here logs content/vectors.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { loadVec, ensureSearchSchema } from './schema.js';
import { vaultIsEncrypted } from '../../db/open.js';

/** Sidecar path for a given vault path: `mycelium.db` → `mycelium.search.db`. */
export function sidecarPath(dbPath) {
  return /\.db$/i.test(dbPath) ? dbPath.replace(/\.db$/i, '.search.db') : `${dbPath}.search.db`;
}

/** Remove the sidecar's {main,-wal,-shm} triad. Only ever the regenerable index. */
function rmTriad(p) {
  for (const sfx of ['', '-wal', '-shm']) { try { fs.rmSync(p + sfx, { force: true }); } catch { /* */ } }
}

/** Apply the vault's keyed-SQLCipher pragma sequence (mirrors src/adapter/d1.js),
 *  minus foreign_keys (the index has none), then load sqlite-vec + ensure schema. */
function openKeyed(path, dbKeyHex) {
  const raw = new Database(path);
  if (dbKeyHex) {
    if (!/^[0-9a-f]{64}$/i.test(dbKeyHex)) throw new Error('sidecar dbKeyHex must be 64-char hex');
    raw.pragma(`cipher='sqlcipher'`);
    raw.pragma(`key="x'${dbKeyHex}'"`);
    raw.pragma('temp_store = MEMORY');
  }
  raw.pragma('journal_mode = WAL');
  raw.pragma('busy_timeout = 5000');
  raw.pragma('journal_size_limit = 67108864');
  loadVec(raw);
  ensureSearchSchema(raw);
  return raw;
}

/** Corruption probe. `deep` (the once-per-boot, under-lock path) runs a full
 *  PRAGMA quick_check — the reliable detector (a shallow count(*) can miss densely
 *  damaged pages). The shallow path (per-process open, after the lock path already
 *  deep-checked) just touches each index b-tree cheaply. Either way a physically
 *  damaged tree surfaces as SQLITE_CORRUPT (`database disk image is malformed`),
 *  which the runtime guard (safeBackendQuery) also catches if a shallow probe misses. */
function probe(raw, deep = false) {
  if (deep) {
    const rows = raw.prepare('PRAGMA quick_check').all().map((r) => r.quick_check ?? Object.values(r)[0]);
    if (!(rows.length === 1 && rows[0] === 'ok')) {
      const e = new Error('database disk image is malformed'); e.code = 'SQLITE_CORRUPT'; throw e;
    }
    return;
  }
  raw.prepare('SELECT count(*) AS c FROM doc_meta').get();
  raw.prepare('SELECT count(*) AS c FROM fts_docs').get();
  raw.prepare('SELECT count(*) AS c FROM vec_docs_256').get();
  raw.prepare('SELECT count(*) AS c FROM vec_docs_768').get();
}

const isCorrupt = (e) => e && (e.code === 'SQLITE_CORRUPT' || /malformed|not a database|SQLITE_NOTADB/i.test(e.message || ''));

/**
 * Open the keyed search sidecar, self-healing a corrupt index by nuking + recreating
 * the file (the index rebuilds from vault content on the next warm() — an empty
 * search_state means isCorpusBuilt()===false). Returns { raw, path, wasReset }.
 * Throws only if a FRESH file also fails to open (a real environment fault).
 *
 * @param {{ dbPath: string, dbKeyHex: string|null }} o
 */
export function openSidecar({ dbPath, dbKeyHex, deep = false }) {
  const path = sidecarPath(dbPath);
  // Fail-closed (CLAUDE.md §3 + §7): embeddings are semantic fingerprints of plaintext,
  // so if the VAULT is encrypted the sidecar MUST be keyed too. Refuse an unkeyed open
  // rather than silently creating (or resetting to) a PLAINTEXT index next to a keyed
  // vault. Belt-and-suspenders vs the boot fail-closed at index.js:147 — closes the
  // vector permanently against any future rewiring that reaches this unkeyed.
  if (!dbKeyHex && vaultIsEncrypted(dbPath)) {
    throw new Error('refusing to open the search sidecar UNKEYED next to an encrypted vault (embeddings are sensitive — CLAUDE.md §7)');
  }
  let raw = null;
  try {
    raw = openKeyed(path, dbKeyHex);
    probe(raw, deep);
    return { raw, path, wasReset: false };
  } catch (e) {
    if (!isCorrupt(e)) { if (raw) { try { raw.close(); } catch { /* */ } } throw e; }
    // Corrupt (or unopenable-as-db) sidecar → the index is regenerable; nuke the
    // FILE (a corrupt vtable can't be DROPped) and rebuild from empty.
    if (raw) { try { raw.close(); } catch { /* */ } }
    rmTriad(path);
    raw = openKeyed(path, dbKeyHex); // fresh empty file, born-encrypted, schema present
    return { raw, path, wasReset: true };
  }
}

/**
 * One-time cleanup: DROP the stale search-index tables left INSIDE the vault by
 * pre-sidecar builds (fts_docs, vec_docs_256/768, doc_meta, search_state). They are
 * regenerable; the live vault's copies read clean so DROP succeeds (a physically
 * corrupt copy throws → caught + skipped; that vault is a separate recovery case).
 * No VACUUM (avoids the multi-GB/near-full-disk cost — DROP frees pages for reuse).
 * Best-effort; never throws. sqlite-vec must be loaded to drop a vec0 vtable.
 * Idempotent: once dropped, `DROP TABLE IF EXISTS` is a cheap no-op on later boots.
 * @param {{ dbPath: string, dbKeyHex: string|null }} o
 */
export function dropLegacyVaultIndex({ dbPath, dbKeyHex }) {
  // Parity with openKeyed (defense-in-depth): a malformed key must never reach the
  // `key="x'…'"` pragma. dbKeyHex is machine-derived (deriveDbKey → 64-hex), so this
  // is belt-and-suspenders; skip the cleanup rather than open unkeyed on a bad key.
  if (dbKeyHex && !/^[0-9a-f]{64}$/i.test(dbKeyHex)) return { dropped: 0 };
  let raw = null; let dropped = 0;
  try {
    raw = new Database(dbPath, { fileMustExist: true });
    if (dbKeyHex) {
      raw.pragma(`cipher='sqlcipher'`);
      raw.pragma(`key="x'${dbKeyHex}'"`);
      raw.pragma('temp_store = MEMORY');
    }
    try { loadVec(raw); } catch { /* vec0 drop will just be skipped below */ }
    for (const t of ['vec_docs_256', 'vec_docs_768', 'fts_docs', 'doc_meta', 'search_state']) {
      try { raw.exec(`DROP TABLE IF EXISTS "${t}"`); dropped++; } catch { /* corrupt/locked → skip */ }
    }
  } catch { /* can't open → skip */ }
  finally { if (raw) { try { raw.close(); } catch { /* */ } } }
  return { dropped };
}

/**
 * Race-safe health pass, run UNDER the cross-process init lock (initVaultStorage):
 * detect + reset a corrupt sidecar once, before any process opens it for use, then
 * close the handle (each process reopens its own via openSidecar). Best-effort —
 * a sidecar problem must never break vault boot. Returns { wasReset, error? }.
 */
export function ensureSidecarHealthy({ dbPath, dbKeyHex }) {
  try {
    // deep=true: the once-per-boot, under-lock pass runs a full quick_check (the
    // reliable detector). Per-process opens (getDb) then use the cheap shallow probe.
    const { raw, wasReset } = openSidecar({ dbPath, dbKeyHex, deep: true });
    try { raw.close(); } catch { /* */ }
    return { wasReset };
  } catch (e) {
    return { wasReset: false, error: e?.message || String(e) };
  }
}
