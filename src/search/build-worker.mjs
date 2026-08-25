#!/usr/bin/env node
// Search-corpus build worker — a spawned CHILD of the app (never run by hand).
//
// WHY A CHILD: the full corpus build over a large SQLCipher vault takes minutes
// of synchronous better-sqlite3 work (observed live 2026-08-22: ~12 min at 100%
// CPU on a 67k-message vault). Run in the serving process it starves the event
// loop — every REST/tool/portal request times out and the connected agent loses
// its vault tools. Every other DB-heavy off-loop job here is a child process
// (snapshot-worker, vault-copy-worker, clustering child); this is the same
// pattern. See the 2026-08-22 search-build off-process design note.
//
// VAULT ACCESS IS READ-ONLY — safe by construction (the fail-stop latch exists
// to stop writes to a damaged vault; this handle cannot write), so no vault
// lease/writer lock is engaged (the snapshot-worker precedent). The SIDECAR is
// opened write-capable through openSidecar (born-encrypted, fail-closed rules
// live there). Keys arrive via the child env OBJECT (allowlisted by the
// spawner) — never argv, never disk, never logged (src/jobs.js doctrine).
//
// RESUME: loadFromDb persists a watermark transactionally with every committed
// batch. A killed build (app quit mid-build — the restart trap) continues from
// the watermark next spawn instead of starting over. MYCELIUM_SEARCH_BUILD_FORCE
// discards that state for a true rebuild (the post-Generate refresh path).
//
// Env in: MYCELIUM_DB, MYCELIUM_DB_KEY (64-hex, present iff the vault file is
// encrypted), USER_MASTER, SYSTEM_KEY, MYCELIUM_USER_ID,
// MYCELIUM_SEARCH_BUILD_FORCE. Progress = JSON lines on stderr — counts,
// source names and timings ONLY, never content/ids/vectors (CLAUDE.md §1).
// Exit: 0 built (corpus_built set) · 1 failed/stopped (state resumable).

import Database from 'better-sqlite3';
import { openSidecar } from './sqlite/sidecar.js';
import { createSqliteBackend } from './backend/sqlite.js';
import { loadFromDb } from './d1-loader.js';
import { loadKey } from '../crypto/keys.js';
import { autoDecryptResults } from '../crypto/crypto-local.js';

const emit = (o) => { try { console.error(JSON.stringify(o)); } catch { /* stderr gone — keep building */ } };

process.on('SIGTERM', () => {
  // Mid-transaction exit is safe: SQLite rolls the in-flight batch back and the
  // last committed watermark stands, so the next spawn resumes exactly there.
  emit({ ev: 'stopped', reason: 'sigterm' });
  process.exit(1);
});

async function main() {
  const dbPath = process.env.MYCELIUM_DB;
  const dbKeyHex = process.env.MYCELIUM_DB_KEY || null;
  const userHex = process.env.USER_MASTER;
  const systemHex = process.env.SYSTEM_KEY;
  const userId = process.env.MYCELIUM_USER_ID || 'local-user';
  const force = process.env.MYCELIUM_SEARCH_BUILD_FORCE === '1';
  if (!dbPath) { emit({ ev: 'error', message: 'MYCELIUM_DB required' }); process.exit(1); }
  if (!userHex || !systemHex) { emit({ ev: 'error', message: 'USER_MASTER and SYSTEM_KEY required' }); process.exit(1); }
  if (dbKeyHex && !/^[0-9a-f]{64}$/i.test(dbKeyHex)) { emit({ ev: 'error', message: 'MYCELIUM_DB_KEY must be 64-hex' }); process.exit(1); }

  const t0 = Date.now();
  const [userKey, systemKey] = await Promise.all([loadKey(userHex), loadKey(systemHex)]);

  const vault = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    if (dbKeyHex) {
      vault.pragma(`cipher='sqlcipher'`);
      vault.pragma(`key="x'${dbKeyHex}'"`);
    }
    vault.pragma('busy_timeout = 5000');

    const side = openSidecar({ dbPath, dbKeyHex });
    try {
      const backend = createSqliteBackend({ sqliteDb: side.raw, embedder: null, userId });
      if (!force && backend.isCorpusBuilt()) { emit({ ev: 'done', added: 0, skipped: 'already-built', tookMs: Date.now() - t0 }); return; }
      if (force) { try { backend.resetIndex(); } catch { /* a partial reset still rebuilds */ } }

      // Minimal db facade for loadFromDb: SELECT-only, decrypt-on-read — the
      // read half of adapter/d1.js query() (autoEncryptParams is write-side).
      const stmts = new Map();
      const db = {
        rawQuery: async (sql, params = []) => {
          let stmt = stmts.get(sql);
          if (!stmt) { stmt = vault.prepare(sql); stmts.set(sql, stmt); }
          const rows = stmt.all(...params);
          const results = await autoDecryptResults(rows, userKey, null, { systemKey });
          return { results, success: true };
        },
      };

      let lastBeat = 0;
      const res = await loadFromDb({
        backend, db, userId,
        getMasterKey: async () => userKey,
        resume: !force,
        onProgress: (p) => {
          const now = Date.now();
          if (now - lastBeat < 2000) return; // bound the stderr volume
          lastBeat = now;
          emit({ ev: 'progress', source: p.source, added: p.added });
        },
      });
      backend.markCorpusBuilt();
      emit({ ev: 'done', added: res.added, byKind: res.byKind, vectorsLoaded: res.vectorsLoaded, vectorsFailed: res.vectorsFailed, tookMs: Date.now() - t0 });
    } finally {
      try { side.raw.close(); } catch { /* already closed */ }
    }
  } finally {
    try { vault.close(); } catch { /* already closed */ }
  }
}

main().then(() => process.exit(0), (e) => {
  // e.message only — never row data (loadFromDb swallows per-row errors itself).
  emit({ ev: 'error', message: String(e?.message || e) });
  process.exit(1);
});
