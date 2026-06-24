// Spike: WHY is the on-disk search index build impractically slow on the
// encrypted vault, and what fixes it? Reproduces the degradation on a REAL
// encrypted SQLCipher DB with the REAL search schema, then measures fixes.
//
// Strategies (all index N synthetic docs: short text + random unit 768-d vec):
//   A current   — per-doc transaction, delete-then-insert  (exact add() behavior)
//   B batched   — 2000 docs/txn, insert-only (no per-row delete)
//   C tuned     — 2000 docs/txn, insert-only, FTS5 automerge OFF + optimize at end
//
// Prints per-window throughput so degradation (10/s -> 14/min) is visible.
// Never logs vectors/text — only counts + timings (CLAUDE.md §1).
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';
import { initSearchSchema, VEC_DIM, VEC_SHORTLIST_DIM } from '../src/search/sqlite/schema.js';

const N = Number(process.argv[2] || 24000);
const KEY = 'a'.repeat(64); // throwaway cipher key for the spike DB
const WINDOW = 2000;

function unitVec(dim, seed) {
  const v = new Float32Array(dim);
  let s = seed >>> 0;
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const x = (s / 4294967296) * 2 - 1;
    v[i] = x; norm += x * x;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}
const f32buf = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
function prefix256(v) {
  const out = new Float32Array(VEC_SHORTLIST_DIM);
  let norm = 0;
  for (let i = 0; i < VEC_SHORTLIST_DIM; i++) { out[i] = v[i]; norm += v[i] * v[i]; }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < VEC_SHORTLIST_DIM; i++) out[i] /= norm;
  return out;
}

// Precompute the corpus once (so embedding/vector-gen cost is excluded — we are
// measuring INDEX WRITE cost, which is the server-rest CPU bottleneck).
const corpus = [];
for (let i = 0; i < N; i++) {
  corpus.push({
    id: `doc-${i}-${Math.floor(i / 7)}`,
    text: `reflection number ${i} about meaning work people and time token${i % 503} token${i % 97}`,
    v768: unitVec(VEC_DIM, i + 1),
    ts: 1700000000 + i,
  });
}

function freshDb(path) {
  if (existsSync(path)) { for (const s of ['', '-wal', '-shm']) try { rmSync(path + s); } catch {} }
  const db = new Database(path);
  db.pragma(`cipher='sqlcipher'`);
  db.pragma(`key="x'${KEY}'"`);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSearchSchema(db);
  return db;
}

function stmts(db) {
  return {
    metaUpsert: db.prepare('INSERT INTO doc_meta(id, ts) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET ts = excluded.ts'),
    metaIns: db.prepare('INSERT INTO doc_meta(id, ts) VALUES (?, ?)'),
    ftsDel: db.prepare('DELETE FROM fts_docs WHERE id = ?'),
    ftsIns: db.prepare('INSERT INTO fts_docs(id, content) VALUES (?, ?)'),
    v768Del: db.prepare('DELETE FROM vec_docs_768 WHERE id = ?'),
    v768Ins: db.prepare('INSERT INTO vec_docs_768(id, embedding) VALUES (?, ?)'),
    v256Del: db.prepare('DELETE FROM vec_docs_256 WHERE id = ?'),
    v256Ins: db.prepare('INSERT INTO vec_docs_256(id, embedding) VALUES (?, ?)'),
  };
}

function reportWindows(label, times) {
  // times: array of cumulative ms sampled every WINDOW docs
  process.stdout.write(`\n[${label}] per-${WINDOW}-doc window throughput (docs/sec):\n`);
  for (let i = 1; i < times.length; i++) {
    const dt = (times[i].ms - times[i - 1].ms) / 1000;
    const rate = WINDOW / dt;
    process.stdout.write(`  rows ${String(times[i - 1].n).padStart(6)}–${String(times[i].n).padStart(6)}: ${rate.toFixed(1)}/s  (${dt.toFixed(2)}s)\n`);
  }
  const total = times[times.length - 1].ms / 1000;
  process.stdout.write(`  TOTAL ${times[times.length - 1].n} docs in ${total.toFixed(1)}s = ${(times[times.length - 1].n / total).toFixed(1)}/s avg\n`);
}

// ── A. current: per-doc transaction, delete-then-insert ──────────────────────
function runA() {
  const path = join(tmpdir(), 'spike-A.db');
  const db = freshDb(path);
  const s = stmts(db);
  const tx = db.transaction((d, v256) => {
    s.metaUpsert.run(d.id, d.ts);
    s.ftsDel.run(d.id); s.ftsIns.run(d.id, d.text);
    s.v768Del.run(d.id); s.v256Del.run(d.id);
    s.v768Ins.run(d.id, f32buf(d.v768));
    s.v256Ins.run(d.id, f32buf(v256));
  });
  const t0 = Date.now(); const times = [{ n: 0, ms: 0 }];
  for (let i = 0; i < corpus.length; i++) {
    tx(corpus[i], prefix256(corpus[i].v768));
    if ((i + 1) % WINDOW === 0) times.push({ n: i + 1, ms: Date.now() - t0 });
  }
  if (times[times.length - 1].n !== corpus.length) times.push({ n: corpus.length, ms: Date.now() - t0 });
  db.close();
  return times;
}

// ── B. batched insert-only ───────────────────────────────────────────────────
function runB() {
  const path = join(tmpdir(), 'spike-B.db');
  const db = freshDb(path);
  const s = stmts(db);
  const t0 = Date.now(); const times = [{ n: 0, ms: 0 }];
  const flush = db.transaction((batch) => {
    for (const d of batch) {
      s.metaIns.run(d.id, d.ts);
      s.ftsIns.run(d.id, d.text);
      s.v768Ins.run(d.id, f32buf(d.v768));
      s.v256Ins.run(d.id, f32buf(prefix256(d.v768)));
    }
  });
  let batch = [];
  for (let i = 0; i < corpus.length; i++) {
    batch.push(corpus[i]);
    if (batch.length >= WINDOW) { flush(batch); batch = []; times.push({ n: i + 1, ms: Date.now() - t0 }); }
  }
  if (batch.length) { flush(batch); times.push({ n: corpus.length, ms: Date.now() - t0 }); }
  db.close();
  return times;
}

// ── C. batched insert-only + FTS5 automerge OFF + optimize at end ────────────
function runC() {
  const path = join(tmpdir(), 'spike-C.db');
  const db = freshDb(path);
  const s = stmts(db);
  const t0 = Date.now(); const times = [{ n: 0, ms: 0 }];
  const flush = db.transaction((batch) => {
    for (const d of batch) {
      s.metaIns.run(d.id, d.ts);
      s.ftsIns.run(d.id, d.text);
      s.v768Ins.run(d.id, f32buf(d.v768));
      s.v256Ins.run(d.id, f32buf(prefix256(d.v768)));
    }
  });
  let batch = [];
  for (let i = 0; i < corpus.length; i++) {
    batch.push(corpus[i]);
    if (batch.length >= WINDOW) { flush(batch); batch = []; times.push({ n: i + 1, ms: Date.now() - t0 }); }
  }
  if (batch.length) { flush(batch); times.push({ n: corpus.length, ms: Date.now() - t0 }); }
  const tOpt = Date.now();
  db.prepare(`INSERT INTO fts_docs(fts_docs) VALUES('optimize')`).run();
  const optMs = Date.now() - tOpt;
  times.push({ n: corpus.length, ms: Date.now() - t0 });
  process.stdout.write(`  (fts optimize: ${(optMs / 1000).toFixed(2)}s)\n`);
  db.close();
  return times;
}

process.stdout.write(`Spike: index ${N} docs into encrypted SQLCipher DB with real search schema (dim=${VEC_DIM}/${VEC_SHORTLIST_DIM})\n`);
const only = process.argv[3];
if (!only || only === 'A') reportWindows('A current (per-doc txn, del+ins)', runA());
if (!only || only === 'B') reportWindows('B batched insert-only', runB());
if (!only || only === 'C') reportWindows('C batched + automerge-off + optimize', runC());
