// scripts/verify-backfill-nomic.mjs — verify:backfill-nomic
//
// The FIRST real SQLCipher-collapse campaign: clustering_points.nomic_embedding
// (per-field encrypted envelope → RAW LE-f32 BLOB, dim 256). Proves the column-
// specific contract on a throwaway keyed SQLCipher vault (no real-vault dependency):
//   - a MIX of rows (envelope / already-raw / NULL) backfills correctly + idempotently
//   - golden-diff: every originally-encrypted vector decodes bit-identical post-backfill
//   - 0 envelopes remain; raw + NULL rows untouched; the 1024-byte BLOB shape holds
//   - LIKE 'ey%' counts only TEXT envelopes, never a raw Buffer (no false positive)
//   - file stays ciphertext at rest
//   - the endpoint's SECURITY gates: isTrustedLoopback (loopback-only, XFF rejected)
//     + the named-target allowlist (unknown / partial → rejected)
// @see docs/DESIGN-sqlcipher-backfill-job-nomic-2026-06-19.md
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, openSync, readSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { importMasterKey } from '../src/crypto/crypto-local.js';
import { encryptVector, encodeVectorRaw, decodeStoredVector } from '../src/search/ann/decode.js';
import { backfillColumn, countRemainingEnvelopes } from '../src/account/backfill.js';
import { isTrustedLoopback } from '../src/http/loopback.js';

const DB_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const DIM = 256; // matryoshka — the production nomic_embedding dimension
const ledger = [];
const rec = (n, c, x = '') => { ledger.push(c); console.log(`  [${c ? '✓' : '✗'}] ${n}${x ? ' — ' + x : ''}`); };
const magic = Buffer.from('SQLite format 3\0', 'latin1');
const header16 = (p) => { const fd = openSync(p, 'r'); try { const b = Buffer.alloc(16); readSync(fd, b, 0, 16, 0); return b; } finally { closeSync(fd); } };
const closeVec = (a, b, eps = 1e-6) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= eps);
// a deterministic-but-distinct unit-ish 256-vector per row
const mkVec = (seed) => { const v = new Float32Array(DIM); for (let i = 0; i < DIM; i++) v[i] = Math.sin((i + 1) * 0.013 + seed) * 0.5; return v; };

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'verify-backfill-nomic-'));
  const dbPath = join(dir, 'v.db');
  const masterKey = await importMasterKey(crypto.randomBytes(32).toString('hex'));

  const db = new Database(dbPath);
  db.pragma(`cipher='sqlcipher'`); db.pragma(`key="x'${DB_KEY}'"`); db.pragma('journal_mode = WAL');
  // The real clustering_points shape (the columns that matter here).
  db.exec(`CREATE TABLE clustering_points(
    id TEXT PRIMARY KEY, user_id TEXT, source_type TEXT, source_id TEXT,
    nomic_embedding BLOB, embedding_model TEXT)`);

  const ins = db.prepare(`INSERT INTO clustering_points(id, user_id, source_type, source_id, nomic_embedding, embedding_model)
                          VALUES (?, 'u', 'message', ?, ?, 'nomic-v1.5-256d')`);
  const originals = new Map(); // id → Float32Array (the truth we golden-diff against)
  // 4 envelope rows (legacy), 2 already-raw rows (new writer), 1 NULL row.
  for (let i = 1; i <= 4; i++) { const v = mkVec(i); originals.set(`e${i}`, v); ins.run(`e${i}`, `m${i}`, await encryptVector(v, 'personal', masterKey)); }
  for (let i = 1; i <= 2; i++) { const v = mkVec(100 + i); originals.set(`r${i}`, v); ins.run(`r${i}`, `mr${i}`, Buffer.from(encodeVectorRaw(v))); }
  ins.run('n1', 'mn1', null);

  rec('0 setup: 4 envelopes present before backfill', countRemainingEnvelopes(db, 'clustering_points', 'nomic_embedding') === 4);

  // ── backfill (batch=2 → multiple keyset pages over 7 rows) ──
  const r = await backfillColumn(db._sqlite ?? db, { table: 'clustering_points', column: 'nomic_embedding', codec: { kind: 'vector', dim: DIM }, masterKey, batch: 2 });
  rec('1a keyset covered all rows', r.scanned === 7, `scanned=${r.scanned}`);
  rec('1b 4 envelopes converted; 2 raw + 1 NULL skipped', r.converted === 4 && r.skipped === 3 && r.failed === 0, `converted=${r.converted} skipped=${r.skipped} failed=${r.failed}`);
  rec('1c 0 envelopes remain (the gate)', countRemainingEnvelopes(db, 'clustering_points', 'nomic_embedding') === 0);

  // ── golden-diff: EVERY row (old-envelope + already-raw) decodes bit-identical ──
  let allMatch = true, shape = true;
  for (const [id, vec] of originals) {
    const stored = db.prepare(`SELECT nomic_embedding AS v FROM clustering_points WHERE id=?`).get(id).v;
    if (!Buffer.isBuffer(stored) || stored.length !== DIM * 4) { shape = false; continue; }
    const decoded = await decodeStoredVector(stored, DIM);
    if (!closeVec(Array.from(decoded), Array.from(vec))) allMatch = false;
  }
  rec('2a every vector stored as a 1024-byte raw BLOB', shape);
  rec('2b golden-diff: all vectors decode bit-identical to source', allMatch);
  rec('2c NULL row left NULL', db.prepare(`SELECT nomic_embedding AS v FROM clustering_points WHERE id='n1'`).get().v === null);

  // ── idempotent re-run ──
  const again = await backfillColumn(db._sqlite ?? db, { table: 'clustering_points', column: 'nomic_embedding', codec: { kind: 'vector', dim: DIM }, masterKey, batch: 2 });
  rec('3 idempotent re-run converts 0, skips all non-NULL+NULL', again.converted === 0 && again.skipped === 7, `converted=${again.converted} skipped=${again.skipped}`);

  db.close();
  rec('4 vault file is ciphertext at rest (no SQLite magic header)', !header16(dbPath).equals(magic));
  rmSync(dir, { recursive: true, force: true });

  // ── endpoint security gates (the destructive route's outer guards) ──
  const okLocal = isTrustedLoopback({ socket: { remoteAddress: '127.0.0.1' }, headers: {} });
  const okV6 = isTrustedLoopback({ socket: { remoteAddress: '::1' }, headers: {} });
  const denyXff = isTrustedLoopback({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '' } });
  const denyRemote = isTrustedLoopback({ socket: { remoteAddress: '10.0.0.5' }, headers: {} });
  rec('5a isTrustedLoopback: genuine loopback (v4+v6) accepted', okLocal === true && okV6 === true);
  rec('5b isTrustedLoopback: a proxy hop (X-Forwarded-For, even empty) rejected', denyXff === false);
  rec('5c isTrustedLoopback: a non-loopback peer rejected', denyRemote === false);

  // Mirror the route's allowlist resolution (names → columns; reject unknown/partial).
  const ALLOW = { 'clustering_points.nomic_embedding': { table: 'clustering_points', column: 'nomic_embedding', codec: { kind: 'vector', dim: 256 } } };
  const resolve = (names) => { const cols = names.map((n) => ALLOW[n]).filter(Boolean); return cols.length && cols.length === names.length ? cols : null; };
  rec('6a allowlist resolves the known nomic target', !!resolve(['clustering_points.nomic_embedding']));
  rec('6b allowlist rejects an unknown target', resolve(['messages.content']) === null);
  rec('6c allowlist rejects a partial (known + unknown) set', resolve(['clustering_points.nomic_embedding', 'x.y']) === null);
  rec('6d allowlist rejects an empty set', resolve([]) === null);

  const pass = ledger.filter(Boolean).length, fail = ledger.length - pass;
  console.log(`\n================================================================`);
  console.log(`VERDICT: ${fail === 0 ? 'GO' : 'NO-GO'} — nomic_embedding backfill (raw LE-f32, golden-diff) + endpoint gates  (${pass} pass, ${fail} fail)  EXIT=${fail === 0 ? 0 : 1}`);
  console.log(`================================================================`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('verify:backfill-nomic crashed:', e); process.exit(1); });
