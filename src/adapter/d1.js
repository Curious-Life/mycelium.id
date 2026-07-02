// D1-compatible adapter over better-sqlite3, with TRANSPARENT envelope
// encryption at the query boundary (the structural heart of the vault).
//
// [4th-sweep finding] The db-d1 namespaces are all async (`await d1Query`)
// but better-sqlite3 is synchronous — so d1Query is an async function that
// Promise-wraps the sync calls and returns the D1 `{ results }` shape.
//
// [Step-3 finding] The db-d1 leaf namespaces receive NO encrypt/decrypt —
// encryption lives HERE: writes run through autoEncryptParams (encrypts the
// table's encrypted columns), reads through autoDecryptResults (decrypts any
// envelope-shaped field). This is the build-new orchestrator glue.
import Database from 'better-sqlite3';
import { webcrypto } from 'node:crypto';
import {
  autoEncryptParams,
  autoDecryptResults,
  ENCRYPTED_FIELDS,
} from '../crypto/crypto-local.js';
import { vaultIsEncrypted } from '../db/open.js';

const isWrite = (sql) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql);
const hasReturning = (sql) => /\bRETURNING\b/i.test(sql);

/**
 * Build the injected dependency bag every db-d1 namespace factory expects.
 * Single-user: crypto userId is null (writes v1 envelopes per the plan);
 * `scope` defaults to 'personal'. SYSTEM_KEY_TABLES (the `secrets` table) are
 * encrypted explicitly via encryptWithSystemKey elsewhere, not auto-encrypted.
 *
 * @returns {{ db, d1Query, d1QueryAdmin, firstRow, d1Batch, parseJson,
 *             randomUUID, now, close }}
 */
export function createDb({ dbPath, userKey, systemKey, scope = 'personal', dbKeyHex = null }) {
  // Fail-closed (CLAUDE.md §3, defense-in-depth): refuse to open an at-rest
  // SQLCipher vault WITHOUT its cipher key. An unkeyed open otherwise surfaces as
  // an opaque SQLITE_NOTADB on the first statement deep inside a query — which is
  // exactly how the older getDb-hex CLI/pipeline openers crashed at boot. Catching
  // it at the single open chokepoint turns a silent deep failure into one clear,
  // actionable error, and guards against any future opener that forgets the key.
  // Plaintext fixtures (the ~104 raw-read verify gates) have a plaintext header →
  // vaultIsEncrypted() is false → unaffected. dbKeyHex present → keyed open below.
  if (!dbKeyHex && vaultIsEncrypted(dbPath)) {
    throw new Error(
      `refusing to open an at-rest-encrypted vault unkeyed (${dbPath}): derive the DB-file key (resolveDbKeyHex/boot) and pass dbKeyHex`,
    );
  }
  const db = new Database(dbPath);
  // At-rest blindness (opt-in): when a whole-file SQLCipher key is supplied, key
  // the connection BEFORE any other statement (the key PRAGMA must be first).
  // Absent dbKeyHex → plaintext open, unchanged — this is what keeps the ~104
  // raw-read verify gates (plaintext temp DBs) green. The aliased driver
  // (better-sqlite3-multiple-ciphers) makes `cipher`/`key` no-op-safe in plain
  // mode. temp_store=MEMORY prevents plaintext spill to on-disk temp files.
  // @see docs/AT-REST-BLINDNESS-DESIGN-2026-06-11.md, keystore.deriveDbKey.
  if (dbKeyHex) {
    if (!/^[0-9a-f]{64}$/i.test(dbKeyHex)) throw new Error('dbKeyHex must be 64-char hex');
    db.pragma(`cipher='sqlcipher'`);
    db.pragma(`key="x'${dbKeyHex}'"`);
    db.pragma('temp_store = MEMORY');
  }
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Two processes hold the vault for write (server-rest.js + index.js). Without a
  // busy timeout, better-sqlite3 defaults to 0 ms → a transaction in one process
  // while the other writes throws SQLITE_BUSY immediately. 5 s lets the loser wait
  // for the WAL writer to commit instead of failing the write. Prerequisite for
  // withTransaction (a db.transaction can hold the write lock longer than a single
  // statement). @see docs/DOCUMENTS-LAYER-HARDENING-DESIGN-2026-06-29.md §8 step 0.
  db.pragma('busy_timeout = 5000');
  // Bound the WAL's on-disk residue: after each checkpoint the -wal file is truncated
  // back to ≤64 MB instead of retaining its high-water mark. Under a heavy pipeline
  // pass the WAL can balloon (31 MB seen in the corruption repro); a long-lived reader
  // (e.g. the once/day integrity check) blocks checkpoints, so without this the file
  // keeps its peak size. Caps disk pressure on a near-full volume (a corruption
  // co-factor). @see docs/VAULT-CONCURRENCY-FIX-DESIGN-2026-07-01.md.
  db.pragma('journal_size_limit = 67108864');

  async function query(sql, params = []) {
    // CONTRACT [crypto-local.js:1318,1396,1408]: autoEncryptParams MUTATES
    // `params` in place (encrypting values; rewriting the array when it injects
    // a scope column) and RETURNS the possibly-rewritten SQL string. So the
    // params we bind are `params` itself; the SQL we prepare is the return value.
    let finalSql = sql;
    if (isWrite(sql)) {
      finalSql = await autoEncryptParams(sql, params, scope, userKey, null, { systemKey });
    }
    const stmt = db.prepare(finalSql);
    if (isWrite(finalSql) && !hasReturning(finalSql)) {
      const info = stmt.run(...params);
      return { results: [], success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
    }
    const rows = stmt.all(...params); // SELECTs + INSERT/UPDATE … RETURNING
    const results = await autoDecryptResults(rows, userKey, null, { systemKey });
    return { results, success: true };
  }

  const d1Query = (sql, params = []) => query(sql, params);
  // Single-user: Admin == Query (no tenant WHERE-injection to bypass).
  const d1QueryAdmin = (sql, params = []) => query(sql, params);

  const firstRow = (result) => {
    if (!result) return null;
    const rows = Array.isArray(result) ? result : result.results;
    return rows && rows.length ? rows[0] : null;
  };

  async function d1Batch(statements = []) {
    const out = [];
    for (const s of statements) out.push(await query(s.sql, s.params || []));
    return out;
  }

  // Atomic, SYNCHRONOUS transaction over the raw better-sqlite3 handle. The
  // callback runs db.prepare(...).run/get(...) DIRECTLY — no async, no
  // auto-encrypt — so it is valid ONLY for PLAINTEXT-column tables: `documents`
  // and `document_versions` (empty ENCRYPTED_FIELDS) plus the plaintext d1Batch
  // tables (wealth/assignments/messages). NEVER wrap a write to an
  // encrypted-field table here: no synchronous cipher exists (autoEncryptParams
  // is async), so the values would land in plaintext. Pass `tables` to get a
  // fail-closed dev assert that every named table is plaintext.
  //
  // better-sqlite3 may RE-RUN `fn` if it hits SQLITE_BUSY, so `fn` MUST be pure
  // synchronous SQL with fixed params — no random IV, no external side effects.
  // @see docs/DOCUMENTS-LAYER-HARDENING-DESIGN-2026-06-29.md §3a.
  function withTransaction(fn, { tables = [] } = {}) {
    for (const t of tables) {
      const enc = ENCRYPTED_FIELDS[t];
      if (enc && enc.length) {
        throw new Error(
          `withTransaction: refusing to wrap encrypted-field table '${t}' (${enc.length} encrypted column(s)); no synchronous cipher exists — plaintext tables only`,
        );
      }
    }
    return db.transaction(fn)();
  }

  const parseJson = (s) => {
    if (s == null) return null;
    if (typeof s !== 'string') return s;
    try { return JSON.parse(s); } catch { return null; }
  };

  return {
    db,
    d1Query,
    d1QueryAdmin,
    firstRow,
    d1Batch,
    withTransaction,
    parseJson,
    randomUUID: () => webcrypto.randomUUID(),
    now: () => new Date(),
    close: () => db.close(),
  };
}
