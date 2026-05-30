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
} from '../crypto/crypto-local.js';

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
export function createDb({ dbPath, userKey, systemKey, scope = 'personal' }) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  async function query(sql, params = []) {
    let bound = params;
    if (isWrite(sql)) {
      // autoEncryptParams parses the table+columns itself and encrypts only
      // the encrypted columns; no-ops on tables without encrypted fields.
      bound = await autoEncryptParams(sql, params, scope, userKey, null);
    }
    const stmt = db.prepare(sql);
    if (isWrite(sql) && !hasReturning(sql)) {
      const info = stmt.run(...bound);
      return { results: [], success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
    }
    const rows = stmt.all(...bound); // SELECTs + INSERT/UPDATE … RETURNING
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
    parseJson,
    randomUUID: () => webcrypto.randomUUID(),
    now: () => new Date(),
    close: () => db.close(),
  };
}
