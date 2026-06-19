// src/account/backfill.js — the shared SQLCipher-collapse backfill engine.
//
// Converts a column's encrypted wrapped-DEK envelopes to PLAINTEXT-inside-SQLCipher
// (content) or RAW little-endian float32 bytes (vectors). Used by Stage A (vectors)
// and Stage B/C (content). @see docs/DESIGN-sqlcipher-backfill-engine-2026-06-19.md
//
// Runs IN-APP on the app's own keyed better-sqlite3 handle (`db._sqlite`) — NOT a
// spawned child: a JS process opens SQLCipher directly, and a second writer would
// contend on SQLCipher's single-writer lock. Reads/writes go through the RAW handle
// (the adapter has no raw-read path — d1Query always auto-decrypts — and a raw
// UPDATE bypasses auto-encrypt, so the engine is correct regardless of the column's
// ENCRYPTED_FIELDS state, on top of the stop-write ordering law).
//
// Safety: per-row fail-closed (a decode error leaves the row as its envelope and is
// surfaced by the 0-envelope assert — never writes garbage); idempotent (skip rows
// that are already plaintext via isEncrypted); keyset-paginated + setImmediate yield
// + suspended WAL autocheckpoint (the proven search-build heavy-write recipe, so a
// 2GB-vault rewrite doesn't freeze the event loop).
import { decrypt, isEncrypted } from '../crypto/crypto-local.js';
import { decryptVector } from '../search/ann/decode.js';

// Never collapse the SYSTEM_KEY table — `secrets` keeps its field-encryption.
// (mirror of crypto-local.js:1654 SYSTEM_KEY_TABLES — not exported there.)
const SYSTEM_KEY_TABLES = new Set(['secrets']);
const IDENT = /^[a-z_][a-z0-9_]*$/i; // code-supplied identifiers; guard anyway (no SQL injection)

/** Count rows in `column` whose stored value is still an envelope (cheap raw probe:
 *  every wrapped-DEK envelope base64-encodes to a string starting 'ey' = base64 of `{"`).
 *  This is the gate that authorizes a Stage-C SQL restore / a writer flip. */
export function countRemainingEnvelopes(rawDb, table, column) {
  if (!IDENT.test(table) || !IDENT.test(column)) throw new Error('backfill: invalid identifier');
  return rawDb.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} LIKE 'ey%'`).get().n;
}

/**
 * Backfill one column's envelopes → plaintext (content) or raw bytes (vector).
 * Idempotent + resumable: re-running converts only the still-encrypted rows.
 *
 * @param {import('better-sqlite3').Database} rawDb  the keyed better-sqlite3 handle (db._sqlite)
 * @param {object} opts
 * @param {string} opts.table
 * @param {string} opts.column
 * @param {{kind:'content'} | {kind:'vector', dim:number}} opts.codec
 * @param {Buffer|CryptoKey} opts.masterKey
 * @param {number} [opts.batch=500]   rows per keyset page / per write transaction
 * @param {string} [opts.pk='id']     primary key for keyset pagination
 * @param {AbortSignal} [opts.signal] cooperative cancel
 * @returns {Promise<{scanned:number, converted:number, skipped:number, failed:number, lastId:string}>}
 */
export async function backfillColumn(rawDb, { table, column, codec, masterKey, batch = 500, pk = 'id', signal } = {}) {
  if (!rawDb || typeof rawDb.prepare !== 'function') throw new Error('backfill: a raw better-sqlite3 handle is required (db._sqlite)');
  if (SYSTEM_KEY_TABLES.has(table)) throw new Error(`backfill: refusing to touch SYSTEM_KEY table '${table}' (secrets keeps field-encryption)`);
  if (!IDENT.test(table) || !IDENT.test(column) || !IDENT.test(pk)) throw new Error('backfill: invalid identifier');
  if (!codec || (codec.kind !== 'content' && codec.kind !== 'vector')) throw new Error(`backfill: codec must be {kind:'content'|'vector'}`);
  if (codec.kind === 'vector' && !(Number.isInteger(codec.dim) && codec.dim > 0)) throw new Error('backfill: vector codec needs a positive integer dim');
  if (!masterKey) throw new Error('backfill: masterKey required');

  // Keyset pagination. The FIRST page has no lower bound; later pages use `pk > lastId`
  // where lastId is a real pk value. This keeps the cursor type-correct for ANY pk —
  // a TEXT id, an INTEGER `rowid` (composite-PK tables like cognitive_anchor_vectors),
  // etc. (A fixed '' sentinel would break an integer pk: `rowid > ''` is always false
  // in SQLite, since INTEGER sorts before TEXT.)
  const selFirst = rawDb.prepare(`SELECT ${pk} AS _id, ${column} AS _v FROM ${table} ORDER BY ${pk} LIMIT ?`);
  const sel = rawDb.prepare(`SELECT ${pk} AS _id, ${column} AS _v FROM ${table} WHERE ${pk} > ? ORDER BY ${pk} LIMIT ?`);
  const upd = rawDb.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${pk} = ?`);
  const writeBatch = rawDb.transaction((ups) => { for (const [val, id] of ups) upd.run(val, id); });

  let scanned = 0, converted = 0, skipped = 0, failed = 0, lastId = null;
  try { rawDb.pragma('wal_autocheckpoint = 0'); } catch { /* best-effort */ }
  try {
    for (;;) {
      if (signal?.aborted) break;
      const rows = lastId === null ? selFirst.all(batch) : sel.all(lastId, batch);
      if (rows.length === 0) break;
      const updates = [];
      for (const r of rows) {
        scanned++;
        lastId = r._id;
        const v = r._v;
        // Idempotent: only string envelopes need converting. Plaintext strings,
        // raw-byte Buffers (already-migrated vectors), and NULLs are left alone.
        if (typeof v !== 'string' || !isEncrypted(v)) { skipped++; continue; }
        try {
          if (codec.kind === 'content') {
            updates.push([await decrypt(v, masterKey, null), r._id]);
          } else {
            const vec = await decryptVector(v, masterKey, null, codec.dim);
            updates.push([Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength), r._id]);
          }
        } catch (err) {
          // Fail-closed per row: leave the envelope in place (still read-safe), surface
          // via the 0-envelope assert. Never log plaintext — id + message only.
          failed++;
          console.error(`[backfill] ${table}.${column} id=${r._id}: decode failed, row kept as envelope (${err?.message || err})`);
        }
      }
      if (updates.length) { writeBatch(updates); converted += updates.length; }
      await new Promise((res) => setImmediate(res)); // yield so the app stays responsive
      if (rows.length < batch) break;
    }
  } finally {
    try { rawDb.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best-effort */ }
    try { rawDb.pragma('wal_autocheckpoint = 1000'); } catch { /* best-effort */ }
  }
  return { scanned, converted, skipped, failed, lastId };
}
