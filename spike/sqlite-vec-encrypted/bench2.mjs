// PIVOT probe: brute-force 768-d KNN was 1.4s p95 @ 58k (too slow). Test the two
// documented sqlite-vec scaling paths for latency AND recall@10 vs the full-768
// brute-force baseline, all on an ENCRYPTED DB:
//   (1) 256-d matryoshka float (codebase already computes this projection)
//   (2) binary quantization (bit[768] hamming) → rescore top-K at full precision
import Database from 'better-sqlite3-multiple-ciphers';
import * as sqliteVec from 'sqlite-vec';
import { rmSync, statSync } from 'node:fs';

const DB = '/tmp/myc-spike-sqlitevec/bench2.db';
const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { rmSync(f); } catch {} }
const open = () => { const db = new Database(DB); db.pragma(`cipher='sqlcipher'`); db.pragma(`key='${KEY}'`); db.pragma('journal_mode=WAL'); db.pragma('synchronous=NORMAL'); db.pragma('mmap_size=268435456'); sqliteVec.load(db); return db; };
// realistic-ish 768-d unit-ish vectors with structure so neighbors are meaningful
const mk = (seed) => { const a = new Float32Array(768); let n = 0; for (let i = 0; i < 768; i++) { const v = Math.sin(seed * 0.013 + i * 0.0007) + 0.5 * Math.cos(seed * 0.0021 * (i + 1)); a[i] = v; n += v * v; } n = Math.sqrt(n) || 1; for (let i = 0; i < 768; i++) a[i] /= n; return a; };
const trunc = (a, d) => { const b = new Float32Array(d); let n = 0; for (let i = 0; i < d; i++) { b[i] = a[i]; n += a[i] * a[i]; } n = Math.sqrt(n) || 1; for (let i = 0; i < d; i++) b[i] /= n; return b; }; // matryoshka: prefix + renorm
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000;
const N = 58000;

let db = open();
db.exec(`CREATE VIRTUAL TABLE v768 USING vec0(embedding float[768])`);
db.exec(`CREATE VIRTUAL TABLE v256 USING vec0(embedding float[256])`);
db.exec(`CREATE VIRTUAL TABLE vbit USING vec0(embedding bit[768])`); // bit cols default to hamming
db.exec(`CREATE TABLE fullvec (rowid INTEGER PRIMARY KEY, embedding BLOB)`); // for rescore

const i768 = db.prepare(`INSERT INTO v768(rowid,embedding) VALUES (?,?)`);
const i256 = db.prepare(`INSERT INTO v256(rowid,embedding) VALUES (?,?)`);
const ibit = db.prepare(`INSERT INTO vbit(rowid,embedding) VALUES (?, vec_quantize_binary(?))`);
const ifull = db.prepare(`INSERT INTO fullvec(rowid,embedding) VALUES (?,?)`);
const build = db.transaction((n) => { for (let i = 1; i <= n; i++) { const a = mk(i); const ab = new Uint8Array(a.buffer); i768.run(BigInt(i), ab); i256.run(BigInt(i), new Uint8Array(trunc(a, 256).buffer)); ibit.run(BigInt(i), ab); ifull.run(BigInt(i), Buffer.from(ab)); } });
const tb = now(); build(N); const buildS = (now() - tb) / 1000;
db.close();

db = open();
const fileMB = (statSync(DB).size / 1048576).toFixed(1);
const QN = 40;
const queries = Array.from({ length: QN }, (_, r) => mk(123 + r * 311)); // not exact matches
const timeIt = (fn) => { const ts = []; for (let r = 0; r < QN; r++) { const a = now(); fn(r); ts.push(now() - a); } ts.sort((x, y) => x - y); return { p50: ts[QN >> 1], p95: ts[Math.floor(QN * 0.95)] }; };

// baseline: full 768 brute force top-10 (ground truth for recall)
const s768 = db.prepare(`SELECT rowid FROM v768 WHERE embedding MATCH ? ORDER BY distance LIMIT 10`);
const truth = queries.map((q) => s768.all(new Uint8Array(q.buffer)).map((h) => Number(h.rowid)));
const t768 = timeIt((r) => s768.all(new Uint8Array(queries[r].buffer)));

// (1) 256-d matryoshka top-10
const s256 = db.prepare(`SELECT rowid FROM v256 WHERE embedding MATCH ? ORDER BY distance LIMIT 10`);
const r256 = queries.map((q) => s256.all(new Uint8Array(trunc(q, 256).buffer)).map((h) => Number(h.rowid)));
const t256 = timeIt((r) => s256.all(new Uint8Array(trunc(queries[r], 256).buffer)));

// (1b) 256-d candidate top-200 → rescore full 768
const s256c = db.prepare(`SELECT rowid FROM v256 WHERE embedding MATCH ? ORDER BY distance LIMIT 200`);
const getFull = db.prepare(`SELECT embedding FROM fullvec WHERE rowid = ?`);
const rescore = (q, cand) => { const out = cand.map((id) => { const buf = getFull.get(BigInt(id)).embedding; const f = new Float32Array(buf.buffer, buf.byteOffset, 768); let dot = 0; for (let i = 0; i < 768; i++) dot += q[i] * f[i]; return [id, dot]; }); out.sort((a, b) => b[1] - a[1]); return out.slice(0, 10).map((x) => x[0]); };
const r256r = queries.map((q) => rescore(q, s256c.all(new Uint8Array(trunc(q, 256).buffer)).map((h) => Number(h.rowid))));
const t256r = timeIt((r) => rescore(queries[r], s256c.all(new Uint8Array(trunc(queries[r], 256).buffer)).map((h) => Number(h.rowid))));

// (2) binary hamming top-400 → rescore full 768
const sbit = db.prepare(`SELECT rowid FROM vbit WHERE embedding MATCH vec_quantize_binary(?) ORDER BY distance LIMIT 400`);
const rbitr = queries.map((q) => rescore(q, sbit.all(new Uint8Array(q.buffer)).map((h) => Number(h.rowid))));
const tbitr = timeIt((r) => rescore(queries[r], sbit.all(new Uint8Array(queries[r].buffer)).map((h) => Number(h.rowid))));
db.close();

const recall = (got) => { let s = 0; for (let i = 0; i < QN; i++) { const t = new Set(truth[i]); s += got[i].filter((id) => t.has(id)).length / Math.max(1, truth[i].length); } return (s / QN * 100).toFixed(1); };
const row = (name, t, rec) => `  ${name.padEnd(34)} p50=${t.p50.toFixed(1).padStart(7)}ms p95=${t.p95.toFixed(1).padStart(7)}ms  recall@10=${rec}%`;
console.log(`\nScale+method probe @ ${N}×768d, encrypted DB ${fileMB}MB, build ${buildS.toFixed(1)}s`);
console.log(row('full 768 brute (baseline)', t768, '100.0'));
console.log(row('256-d matryoshka only', t256, recall(r256)));
console.log(row('256-d top200 → rescore 768', t256r, recall(r256r)));
console.log(row('binary hamming top400 → rescore', tbitr, recall(rbitr)));
console.log('='.repeat(78));
const winners = [['256-only', t256.p95, recall(r256)], ['256+rescore', t256r.p95, recall(r256r)], ['bin+rescore', tbitr.p95, recall(rbitr)]].filter((w) => w[1] < 300 && +w[2] >= 90);
console.log(winners.length ? `CANDIDATES <300ms p95 & recall≥90%: ${winners.map((w) => `${w[0]}(${w[1].toFixed(0)}ms/${w[2]}%)`).join(', ')}` : 'NONE met <300ms & recall≥90% — need a different approach');
console.log('='.repeat(78));
