// scripts/verify-backfill.mjs — verify:backfill
//
// The SQLCipher-collapse backfill engine: converts encrypted-envelope columns to
// plaintext (content) / raw bytes (vector) inside a keyed SQLCipher DB. Proves the
// engine on a throwaway vault (no real-vault dependency):
//   - content envelopes → plaintext; 0 envelopes remain; values round-trip
//   - vector envelopes → raw float32 BLOB; 0 envelopes; decode bit-identical
//   - idempotent (re-run converts 0, skips all); plaintext rows untouched
//   - keyset pagination covers all rows across multiple batches
//   - a corrupt envelope is LEFT in place + counted as failed (fail-closed per row)
//   - the SYSTEM_KEY table (secrets) is refused
//   - the file stays ciphertext at rest
// @see docs/DESIGN-sqlcipher-backfill-engine-2026-06-19.md
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, openSync, readSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { encrypt, importMasterKey } from '../src/crypto/crypto-local.js';
import { encryptVector, decryptVector } from '../src/search/ann/decode.js';
import { backfillColumn, countRemainingEnvelopes } from '../src/account/backfill.js';

const DB_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const ledger = [];
const rec = (n, c, x = '') => { ledger.push(c); console.log(`  [${c ? '✓' : '✗'}] ${n}${x ? ' — ' + x : ''}`); };
const magic = Buffer.from('SQLite format 3\0', 'latin1');
const header16 = (p) => { const fd = openSync(p, 'r'); try { const b = Buffer.alloc(16); readSync(fd, b, 0, 16, 0); return b; } finally { closeSync(fd); } };
const closeVec = (a, b, eps = 1e-6) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= eps);

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'verify-backfill-'));
  const dbPath = join(dir, 'v.db');
  const masterKey = await importMasterKey(crypto.randomBytes(32).toString('hex'));
  const DIM = 4;
  const vsample = new Float32Array([0.1, -0.2, 0.333, 1.5]);

  const db = new Database(dbPath);
  db.pragma(`cipher='sqlcipher'`); db.pragma(`key="x'${DB_KEY}'"`); db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE t(id TEXT PRIMARY KEY, body TEXT, vec TEXT); CREATE TABLE secrets(id TEXT PRIMARY KEY, value TEXT);`);

  // seed 5 content+vector envelope rows + 1 already-plaintext body row
  const ins = db.prepare(`INSERT INTO t(id, body, vec) VALUES (?, ?, ?)`);
  for (let i = 1; i <= 5; i++) {
    ins.run(`0${i}`, await encrypt(`secret-body-${i}`, 'personal', masterKey), await encryptVector(vsample, 'personal', masterKey));
  }
  ins.run('06', 'already-plaintext', null); // plaintext body → must be skipped

  // ── content backfill (batch=2 → forces 3+ keyset pages over 6 rows) ──
  const c = await backfillColumn(db._sqlite ?? db, { table: 't', column: 'body', codec: { kind: 'content' }, masterKey, batch: 2 });
  rec('1a content: keyset covered all rows across batches', c.scanned === 6, `scanned=${c.scanned}`);
  rec('1b content: 5 envelopes converted, 1 plaintext skipped', c.converted === 5 && c.skipped === 1, `converted=${c.converted} skipped=${c.skipped}`);
  rec('1c content: 0 envelopes remain (the gate)', countRemainingEnvelopes(db, 't', 'body') === 0);
  const row3 = db.prepare(`SELECT body FROM t WHERE id='03'`).get().body;
  rec('1d content: value round-trips to plaintext', row3 === 'secret-body-3', `body=${row3}`);
  rec('1e content: pre-existing plaintext row untouched', db.prepare(`SELECT body FROM t WHERE id='06'`).get().body === 'already-plaintext');

  // ── vector backfill ──
  const v = await backfillColumn(db._sqlite ?? db, { table: 't', column: 'vec', codec: { kind: 'vector', dim: DIM }, masterKey, batch: 3 });
  rec('2a vector: 5 envelopes converted (1 NULL skipped)', v.converted === 5 && v.skipped === 1, `converted=${v.converted} skipped=${v.skipped}`);
  rec('2b vector: 0 envelopes remain', countRemainingEnvelopes(db, 't', 'vec') === 0);
  const rawVec = db.prepare(`SELECT vec FROM t WHERE id='02'`).get().vec;
  rec('2c vector: stored as a raw Buffer (BLOB)', Buffer.isBuffer(rawVec) && rawVec.length === DIM * 4, `len=${rawVec?.length}`);
  const decoded = new Float32Array(DIM); if (Buffer.isBuffer(rawVec)) for (let i = 0; i < DIM; i++) decoded[i] = rawVec.readFloatLE(i * 4);
  rec('2d vector: decodes bit-identical to the original', closeVec(Array.from(decoded), Array.from(vsample)));

  // ── idempotent re-run ──
  const again = await backfillColumn(db._sqlite ?? db, { table: 't', column: 'body', codec: { kind: 'content' }, masterKey, batch: 2 });
  rec('3 idempotent re-run: converts 0, skips all', again.converted === 0 && again.skipped === 6, `converted=${again.converted} skipped=${again.skipped}`);

  // ── corrupt envelope: isEncrypted-accepts but decrypt-fails → left as envelope, counted failed ──
  const fakeEnv = Buffer.from(JSON.stringify({ v: 1, s: 'personal', iv: 'AAAA', ct: 'AAAA', dk: 'AAAA' })).toString('base64');
  db.exec(`CREATE TABLE c(id TEXT PRIMARY KEY, body TEXT)`);
  db.prepare(`INSERT INTO c(id, body) VALUES ('x1', ?)`).run(fakeEnv);
  db.prepare(`INSERT INTO c(id, body) VALUES ('x2', ?)`).run(await encrypt('valid', 'personal', masterKey));
  const corr = await backfillColumn(db._sqlite ?? db, { table: 'c', column: 'body', codec: { kind: 'content' }, masterKey, batch: 10 });
  rec('4a corrupt row fails closed (left as envelope, counted)', corr.failed === 1 && corr.converted === 1, `failed=${corr.failed} converted=${corr.converted}`);
  rec('4b 0-envelope assert flags the un-converted corrupt row', countRemainingEnvelopes(db, 'c', 'body') === 1);

  // ── secrets refused ──
  let refused = false;
  try { await backfillColumn(db._sqlite ?? db, { table: 'secrets', column: 'value', codec: { kind: 'content' }, masterKey }); } catch { refused = true; }
  rec('5 SYSTEM_KEY table (secrets) is refused', refused);

  db.close();
  rec('6 vault file is ciphertext at rest (no SQLite magic header)', !header16(dbPath).equals(magic));
  rmSync(dir, { recursive: true, force: true });

  const pass = ledger.filter(Boolean).length, fail = ledger.length - pass;
  console.log(`\n================================================================`);
  console.log(`VERDICT: ${fail === 0 ? 'GO' : 'NO-GO'} — SQLCipher-collapse backfill engine (content + vector, idempotent, fail-closed)  (${pass} pass, ${fail} fail)  EXIT=${fail === 0 ? 0 : 1}`);
  console.log(`================================================================`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('verify:backfill crashed:', e); process.exit(1); });
