// Focused re-test of S6/S9: vec0 insert+KNN+persist on encrypted DB.
// Hypothesis: vec0 xUpdate requires rowid bound as SQLITE_INTEGER; better-sqlite3
// may bind a plain JS number as FLOAT in some paths. Test BigInt rowid + JSON
// vector forms to find the robust pattern.
import Database from 'better-sqlite3-multiple-ciphers';
import * as sqliteVec from 'sqlite-vec';
import { rmSync } from 'node:fs';

const DB = '/tmp/myc-spike-sqlitevec/enc6.db';
const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { rmSync(f); } catch {} }
const open = () => { const db = new Database(DB); db.pragma(`cipher='sqlcipher'`); db.pragma(`key='${KEY}'`); db.pragma('journal_mode = WAL'); sqliteVec.load(db); return db; };
const mk = (seed) => { const a = new Float32Array(768); for (let i = 0; i < 768; i++) a[i] = Math.sin(seed * 0.13 + i * 0.001); return a; };
const log = (n, p, d='') => console.log(`${p?'PASS':'FAIL'}  ${n}${d?` — ${d}`:''}`);

let ok = true;
// Variant A: BigInt rowid + raw float32 bytes as BLOB
try {
  const db = open();
  db.exec(`CREATE VIRTUAL TABLE vss USING vec0(embedding float[768])`);
  const ins = db.prepare(`INSERT INTO vss(rowid, embedding) VALUES (?, ?)`);
  const tx = db.transaction((n) => { for (let i = 1; i <= n; i++) ins.run(BigInt(i), new Uint8Array(mk(i).buffer)); });
  tx(2000);
  const q = new Uint8Array(mk(7).buffer);
  const hits = db.prepare(`SELECT rowid, distance FROM vss WHERE embedding MATCH ? ORDER BY distance LIMIT 5`).all(q);
  db.close();
  const pass = hits[0]?.rowid === 7 || hits[0]?.rowid === 7n;
  ok = ok && pass;
  log('A. BigInt rowid + float32 BLOB: insert(2000)+KNN nearest=7', pass, JSON.stringify(hits.map(h=>({id:Number(h.rowid),d:+h.distance.toFixed(4)}))));
} catch (e) { ok = false; log('A. BigInt rowid + float32 BLOB', false, 'THREW: ' + e.message); }

// Variant B: persistence across cold reopen
try {
  const db = open();
  const n = db.prepare(`SELECT count(*) c FROM vss`).get().c;
  const q = new Uint8Array(mk(7).buffer);
  const top = db.prepare(`SELECT rowid FROM vss WHERE embedding MATCH ? ORDER BY distance LIMIT 1`).get(q);
  db.close();
  const pass = Number(n) === 2000 && Number(top?.rowid) === 7;
  ok = ok && pass;
  log('B. cold reopen (encrypted): count=2000 + KNN still nearest=7', pass, `count=${n} top=${Number(top?.rowid)}`);
} catch (e) { ok = false; log('B. cold reopen persistence', false, 'THREW: ' + e.message); }

// Variant C: incremental delete-on-forget (what jobs/forget needs)
try {
  const db = open();
  db.prepare(`DELETE FROM vss WHERE rowid = ?`).run(BigInt(7));
  const q = new Uint8Array(mk(7).buffer);
  const top = db.prepare(`SELECT rowid, distance FROM vss WHERE embedding MATCH ? ORDER BY distance LIMIT 1`).get(q);
  const n = db.prepare(`SELECT count(*) c FROM vss`).get().c;
  db.close();
  const pass = Number(top?.rowid) !== 7 && Number(n) === 1999;
  ok = ok && pass;
  log('C. incremental DELETE (forget) drops rowid 7 → next-nearest, count=1999', pass, `top=${Number(top?.rowid)} count=${n}`);
} catch (e) { ok = false; log('C. incremental delete', false, 'THREW: ' + e.message); }

console.log('\n' + '='.repeat(60));
console.log(`vec0 full lifecycle on encrypted DB: ${ok ? 'GO ✅' : 'NO-GO ❌'}`);
console.log('='.repeat(60));
process.exit(ok ? 0 : 1);
