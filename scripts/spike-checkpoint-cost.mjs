// Spike 2: reproduce the WAL-CHECKPOINT encrypt-storm the process sample found
// (sqlite3WalCheckpoint → EncryptPageSQLCipherCipher dominating a bulk reload on
// the 2GB encrypted vault) and prove the fix. The first spike used a fresh small
// DB → cheap checkpoints → missed this. Here we GROW the encrypted DB first, then
// DELETE (mimicking resetIndex on the live vault → scattered freelist), then bulk
// RELOAD measuring two checkpoint policies:
//   B1 default  — wal_autocheckpoint=1000 (auto-checkpoint fires mid-build)
//   B2 bulk     — wal_autocheckpoint=0 + synchronous=OFF during load, ONE
//                 wal_checkpoint(TRUNCATE) at the end
// Never logs vectors/text — only counts + timings (CLAUDE.md §1).
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync, statSync } from 'node:fs';
import { initSearchSchema, VEC_DIM, VEC_SHORTLIST_DIM } from '../src/search/sqlite/schema.js';

const N = Number(process.argv[2] || 40000);
const KEY = 'c'.repeat(64);

function unitVec(dim, seed) {
  const v = new Float32Array(dim); let s = seed >>> 0; let norm = 0;
  for (let i = 0; i < dim; i++) { s = (s * 1664525 + 1013904223) >>> 0; const x = (s / 4294967296) * 2 - 1; v[i] = x; norm += x * x; }
  norm = Math.sqrt(norm) || 1; for (let i = 0; i < dim; i++) v[i] /= norm; return v;
}
const f32buf = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
function prefix256(v) {
  const out = new Float32Array(VEC_SHORTLIST_DIM); let norm = 0;
  for (let i = 0; i < VEC_SHORTLIST_DIM; i++) { out[i] = v[i]; norm += v[i] * v[i]; }
  norm = Math.sqrt(norm) || 1; for (let i = 0; i < VEC_SHORTLIST_DIM; i++) out[i] /= norm; return out;
}

// Longer text than spike 1 (closer to real messages → more fts pages per doc).
const corpus = [];
for (let i = 0; i < N; i++) {
  corpus.push({
    id: `doc-${i}`,
    text: `reflection ${i} ` + Array.from({ length: 40 }, (_, k) => `token${(i * 7 + k * 13) % 900}`).join(' '),
    v768: unitVec(VEC_DIM, i + 1), ts: 1700000000 + i,
  });
}

function open(path) {
  const db = new Database(path);
  db.pragma(`cipher='sqlcipher'`); db.pragma(`key="x'${KEY}'"`);
  db.pragma('journal_mode = WAL');
  return db;
}
function freshGrown(path) {
  for (const s of ['', '-wal', '-shm']) try { if (existsSync(path + s)) rmSync(path + s); } catch {}
  const db = open(path); initSearchSchema(db);
  const ins = {
    meta: db.prepare('INSERT INTO doc_meta(id, ts) VALUES (?, ?)'),
    fts: db.prepare('INSERT INTO fts_docs(id, content) VALUES (?, ?)'),
    v768: db.prepare('INSERT INTO vec_docs_768(id, embedding) VALUES (?, ?)'),
    v256: db.prepare('INSERT INTO vec_docs_256(id, embedding) VALUES (?, ?)'),
  };
  // GROW: load once, then DELETE all → leaves a populated-then-scattered file,
  // like the live vault after resetIndex() inside a 2GB DB.
  db.transaction(() => { for (const d of corpus) { ins.meta.run(d.id, d.ts); ins.fts.run(d.id, d.text); ins.v768.run(d.id, f32buf(d.v768)); ins.v256.run(d.id, f32buf(prefix256(d.v768))); } })();
  db.exec('DELETE FROM fts_docs; DELETE FROM vec_docs_768; DELETE FROM vec_docs_256; DELETE FROM doc_meta;');
  db.pragma('wal_checkpoint(TRUNCATE)');
  return { db, ins };
}

function bulkReload(db, ins, { bulkPragmas }) {
  if (bulkPragmas) { db.pragma('wal_autocheckpoint = 0'); db.pragma('synchronous = OFF'); }
  const t0 = Date.now();
  const flush = db.transaction((batch) => { for (const d of batch) { ins.meta.run(d.id, d.ts); ins.fts.run(d.id, d.text); ins.v768.run(d.id, f32buf(d.v768)); ins.v256.run(d.id, f32buf(prefix256(d.v768))); } });
  for (let i = 0; i < corpus.length; i += 2000) flush(corpus.slice(i, i + 2000));
  let ckptMs = 0;
  if (bulkPragmas) { const c = Date.now(); db.pragma('wal_checkpoint(TRUNCATE)'); ckptMs = Date.now() - c; db.pragma('synchronous = NORMAL'); db.pragma('wal_autocheckpoint = 1000'); }
  const totalMs = Date.now() - t0;
  return { totalMs, ckptMs, rate: corpus.length / (totalMs / 1000) };
}

const mb = (p) => { try { return (statSync(p).size / 1048576).toFixed(0); } catch { return '?'; } }

process.stdout.write(`Spike 2: reload ${N} docs into a GROWN+DELETED encrypted DB (reproduces the 2GB-vault checkpoint cost)\n`);

const p1 = join(tmpdir(), 'spike-ck-B1.db');
const g1 = freshGrown(p1);
process.stdout.write(`  (grown file: ${mb(p1)} MB)\n`);
const r1 = bulkReload(g1.db, g1.ins, { bulkPragmas: false });
g1.db.close();
process.stdout.write(`B1 default autocheckpoint:  ${r1.rate.toFixed(0)}/s  (${(r1.totalMs / 1000).toFixed(1)}s)\n`);

const p2 = join(tmpdir(), 'spike-ck-B2.db');
const g2 = freshGrown(p2);
const r2 = bulkReload(g2.db, g2.ins, { bulkPragmas: true });
g2.db.close();
process.stdout.write(`B2 autockpt=0 + sync=OFF:   ${r2.rate.toFixed(0)}/s  (${(r2.totalMs / 1000).toFixed(1)}s, final ckpt ${(r2.ckptMs / 1000).toFixed(1)}s)\n`);

for (const p of [p1, p2]) for (const s of ['', '-wal', '-shm']) try { if (existsSync(p + s)) rmSync(p + s); } catch {}
process.stdout.write(`\nSpeedup B2/B1: ${(r2.rate / r1.rate).toFixed(1)}×\n`);
