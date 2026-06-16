// Hard-evidence scale probe: brute-force vec0 KNN + FTS5 BM25 at ~58k rows
// (the live vault size) on an ENCRYPTED better-sqlite3-multiple-ciphers DB.
// Design claim under test: brute-force is fine < 100k. Measure real latency.
import Database from 'better-sqlite3-multiple-ciphers';
import * as sqliteVec from 'sqlite-vec';
import { rmSync, statSync } from 'node:fs';

const DB = '/tmp/myc-spike-sqlitevec/bench.db';
const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { rmSync(f); } catch {} }
const open = () => { const db = new Database(DB); db.pragma(`cipher='sqlcipher'`); db.pragma(`key='${KEY}'`); db.pragma('journal_mode = WAL'); db.pragma('synchronous = NORMAL'); db.pragma('busy_timeout = 5000'); sqliteVec.load(db); return db; };
const mk = (seed) => { const a = new Float32Array(768); for (let i = 0; i < 768; i++) a[i] = Math.sin(seed * 0.013 + i * 0.0007) + Math.cos(seed * 0.0021 * i); return a; };
const WORDS = 'mycelium forest spore thought reflection vault memory cognition relation finance meaning person task health dream signal pattern realm territory chronicle'.split(' ');
const text = (s) => Array.from({ length: 20 }, (_, k) => WORDS[(s * 7 + k * 13) % WORDS.length]).join(' ');
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000; // ms

const N = 58000;
let db = open();
db.exec(`CREATE VIRTUAL TABLE vss USING vec0(embedding float[768])`);
db.exec(`CREATE VIRTUAL TABLE ft USING fts5(content)`);

const t0 = now();
const insV = db.prepare(`INSERT INTO vss(rowid, embedding) VALUES (?, ?)`);
const insF = db.prepare(`INSERT INTO ft(rowid, content) VALUES (?, ?)`);
const build = db.transaction((n) => { for (let i = 1; i <= n; i++) { insV.run(BigInt(i), new Uint8Array(mk(i).buffer)); insF.run(BigInt(i), text(i)); } });
build(N);
const tBuild = now() - t0;
db.close();

// reopen cold (cold page cache-ish) and measure query latency
db = open();
const fileMB = (statSync(DB).size / 1048576).toFixed(1);
const timeIt = (fn, reps = 20) => { const ts = []; for (let r = 0; r < reps; r++) { const a = now(); fn(r); ts.push(now() - a); } ts.sort((x, y) => x - y); return { p50: ts[Math.floor(reps * 0.5)], p95: ts[Math.floor(reps * 0.95)], max: ts[reps - 1] }; };

const knnStmt = db.prepare(`SELECT rowid, distance FROM vss WHERE embedding MATCH ? ORDER BY distance LIMIT 10`);
const knn = timeIt((r) => { knnStmt.all(new Uint8Array(mk(100 + r * 37).buffer)); });

const bm = db.prepare(`SELECT rowid, bm25(ft) s FROM ft WHERE ft MATCH ? ORDER BY s LIMIT 10`);
const fts = timeIt((r) => { bm.all(WORDS[r % WORDS.length]); });

// hybrid: run both + merge in JS (approximates the real RRF path)
const hybrid = timeIt((r) => {
  const v = knnStmt.all(new Uint8Array(mk(100 + r * 37).buffer));
  const f = bm.all(WORDS[r % WORDS.length]);
  const score = new Map();
  v.forEach((h, i) => score.set(Number(h.rowid), (score.get(Number(h.rowid)) || 0) + 1 / (60 + i + 1)));
  f.forEach((h, i) => score.set(Number(h.rowid), (score.get(Number(h.rowid)) || 0) + 1 / (60 + i + 1)));
  [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
});
db.close();

const ms = (o) => `p50=${o.p50.toFixed(1)}ms p95=${o.p95.toFixed(1)}ms max=${o.max.toFixed(1)}ms`;
console.log(`\nScale probe @ ${N} rows × 768-d, encrypted (SQLCipher) DB = ${fileMB} MB`);
console.log(`  build (insert ${N}× into vec0+fts5, one txn): ${(tBuild / 1000).toFixed(1)}s`);
console.log(`  vec0 brute-force KNN (top-10):  ${ms(knn)}`);
console.log(`  fts5 bm25 keyword   (top-10):  ${ms(fts)}`);
console.log(`  hybrid both + RRF merge (JS):  ${ms(hybrid)}`);
const verdict = knn.p95 < 1000;
console.log('='.repeat(60));
console.log(`brute-force KNN < 1s @ 58k on encrypted DB: ${verdict ? 'GO ✅' : 'NO-GO ❌'} (p95=${knn.p95.toFixed(1)}ms)`);
console.log('='.repeat(60));
process.exit(verdict ? 0 : 1);
