// SPIKE (throwaway): does sqlite-vec load + run inside an ENCRYPTED
// better-sqlite3-multiple-ciphers DB? + FTS5/BM25 in same build + WAL+cipher +
// persist/reopen. This is the Phase-1 hard gate. Running code, not assumption.
import Database from 'better-sqlite3-multiple-ciphers';
import * as sqliteVec from 'sqlite-vec';
import { readFileSync, rmSync, statSync } from 'node:fs';

const DB = '/tmp/myc-spike-sqlitevec/enc.db';
const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; // 64-hex like USER_MASTER
for (const f of [DB, `${DB}-wal`, `${DB}-shm`, `${DB}-journal`]) { try { rmSync(f); } catch {} }

const ledger = [];
const rec = (n, pass, d = '') => { ledger.push({ n, pass }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const fail = (n, e) => { ledger.push({ n, pass: false }); console.log(`FAIL  ${n} — THREW: ${e.message}`); };

// helper: open + key (SQLCipher-compat cipher) in the required order
function openKeyed(path, key, { wal = false } = {}) {
  const db = new Database(path);
  db.pragma(`cipher='sqlcipher'`);
  db.pragma(`key='${key}'`);
  if (wal) db.pragma('journal_mode = WAL');
  return db;
}

// ── S1) create encrypted DB, write a row, close ──────────────────────────────
try {
  const db = openKeyed(DB, KEY);
  db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)`);
  db.prepare(`INSERT INTO t (id, v) VALUES (?, ?)`).run(1, 'hello vault');
  db.close();
  rec('S1. create encrypted DB + write row + close', true);
} catch (e) { fail('S1. create encrypted DB', e); }

// ── S2) the file is actually encrypted (no plaintext SQLite header) ──────────
try {
  const head = readFileSync(DB).subarray(0, 16).toString('binary');
  const isPlain = head.startsWith('SQLite format 3');
  rec('S2. on-disk file is ciphertext (no "SQLite format 3" header)', !isPlain, `header="${head.replace(/[^\x20-\x7e]/g, '.')}" size=${statSync(DB).size}`);
} catch (e) { fail('S2. ciphertext header check', e); }

// ── S3) wrong key fails to read (fail-closed) ────────────────────────────────
try {
  const db = new Database(DB);
  db.pragma(`cipher='sqlcipher'`);
  db.pragma(`key='ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'`);
  let threw = false;
  try { db.prepare(`SELECT count(*) c FROM t`).get(); } catch { threw = true; }
  db.close();
  rec('S3. WRONG key cannot read (fail-closed)', threw);
} catch (e) { fail('S3. wrong-key check', e); }

// ── S4) right key reopens + reads the row ────────────────────────────────────
try {
  const db = openKeyed(DB, KEY);
  const row = db.prepare(`SELECT v FROM t WHERE id=1`).get();
  db.close();
  rec('S4. RIGHT key reopens + reads persisted row', row?.v === 'hello vault', JSON.stringify(row));
} catch (e) { fail('S4. right-key reopen', e); }

// ── S5) THE GATE: load sqlite-vec on the ENCRYPTED connection ─────────────────
let vecLoaded = false, vecVersion = null;
try {
  const db = openKeyed(DB, KEY);
  sqliteVec.load(db); // calls db.loadExtension(getLoadablePath())
  vecVersion = db.prepare(`SELECT vec_version() AS v`).get().v;
  vecLoaded = true;
  db.close();
  rec('S5. sqlite-vec loads + runs on an ENCRYPTED connection (THE GATE)', true, `vec_version=${vecVersion}`);
} catch (e) { fail('S5. sqlite-vec on encrypted DB (THE GATE)', e); }

// ── S6) vec0 virtual table: insert 768-d vectors + KNN query ─────────────────
if (vecLoaded) {
  try {
    const db = openKeyed(DB, KEY);
    sqliteVec.load(db);
    db.exec(`CREATE VIRTUAL TABLE vss USING vec0(embedding float[768])`);
    const mk = (seed) => { const a = new Float32Array(768); for (let i = 0; i < 768; i++) a[i] = Math.sin(seed * 0.13 + i * 0.001); return a; };
    const ins = db.prepare(`INSERT INTO vss (rowid, embedding) VALUES (?, ?)`);
    const tx = db.transaction((n) => { for (let i = 1; i <= n; i++) ins.run(i, new Uint8Array(mk(i).buffer)); });
    tx(2000); // 2k rows to exercise brute-force KNN
    const q = new Uint8Array(mk(7).buffer); // query near row 7
    const hits = db.prepare(`SELECT rowid, distance FROM vss WHERE embedding MATCH ? ORDER BY distance LIMIT 5`).all(q);
    db.close();
    const top = hits[0]?.rowid;
    rec('S6. vec0 768-d insert(2000) + KNN query returns nearest (rowid 7)', top === 7, JSON.stringify(hits.map(h => ({ id: h.rowid, d: +h.distance.toFixed(4) }))));
  } catch (e) { fail('S6. vec0 KNN on encrypted DB', e); }
} else rec('S6. vec0 KNN (skipped — gate S5 failed)', false, 'skipped');

// ── S7) FTS5 / BM25 available in the same build ──────────────────────────────
try {
  const db = openKeyed(DB, KEY);
  db.exec(`CREATE VIRTUAL TABLE ft USING fts5(content)`);
  const ins = db.prepare(`INSERT INTO ft (rowid, content) VALUES (?, ?)`);
  ins.run(1, 'the mycelium grows beneath the forest floor');
  ins.run(2, 'encrypted cognitive vault of thoughts and reflections');
  const hit = db.prepare(`SELECT rowid, bm25(ft) AS score FROM ft WHERE ft MATCH 'vault' ORDER BY score`).all();
  db.close();
  rec('S7. FTS5 + bm25() available in the same build', hit.length === 1 && hit[0].rowid === 2, JSON.stringify(hit));
} catch (e) { fail('S7. FTS5/bm25', e); }

// ── S8) WAL + cipher: write under WAL, checkpoint, reopen, read ──────────────
try {
  const db = openKeyed(DB, KEY, { wal: true });
  const jm = db.pragma('journal_mode', { simple: true });
  db.exec(`CREATE TABLE wtest (id INTEGER PRIMARY KEY, v TEXT)`);
  db.prepare(`INSERT INTO wtest VALUES (1, ?)`).run('wal+cipher row');
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  const db2 = openKeyed(DB, KEY, { wal: true });
  const row = db2.prepare(`SELECT v FROM wtest WHERE id=1`).get();
  // confirm the -wal file (if present) is also not plaintext
  let walPlain = false;
  try { walPlain = readFileSync(`${DB}-wal`).subarray(0, 16).toString('binary').startsWith('SQLite format 3'); } catch {}
  db2.close();
  rec('S8. WAL + cipher: journal_mode=wal, write+checkpoint+reopen reads row', jm === 'wal' && row?.v === 'wal+cipher row', `jm=${jm} row=${JSON.stringify(row)} walPlaintext=${walPlain}`);
} catch (e) { fail('S8. WAL+cipher', e); }

// ── S9) persist everything, reopen cold, confirm vec0 survives reopen ────────
try {
  const db = openKeyed(DB, KEY);
  sqliteVec.load(db);
  const n = db.prepare(`SELECT count(*) c FROM vss`).get().c;
  const q = new Uint8Array((() => { const a = new Float32Array(768); for (let i = 0; i < 768; i++) a[i] = Math.sin(7 * 0.13 + i * 0.001); return a; })().buffer);
  const top = db.prepare(`SELECT rowid FROM vss WHERE embedding MATCH ? ORDER BY distance LIMIT 1`).get(q);
  db.close();
  rec('S9. vec0 data persists across cold reopen (encrypted)', n === 2000 && top?.rowid === 7, `count=${n} top=${top?.rowid}`);
} catch (e) { fail('S9. vec0 persistence', e); }

// ── verdict ──────────────────────────────────────────────────────────────────
const gatePass = ledger.find((l) => l.n.startsWith('S5'))?.pass === true;
const all = ledger.every((l) => l.pass);
console.log('\n' + '='.repeat(72));
console.log(`GATE (S5 sqlite-vec on encrypted DB): ${gatePass ? 'GO ✅' : 'NO-GO ❌'}`);
console.log(`ALL ${ledger.length} CHECKS: ${all ? 'GO ✅' : 'NO-GO ❌ — see FAIL rows'}`);
console.log('='.repeat(72));
process.exit(all ? 0 : 1);
