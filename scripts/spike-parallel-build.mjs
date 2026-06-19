// Spike 4: END-TO-END parallel index build vs serial. Spike 3 proved the SCAN
// parallelizes (5.2×), but a real build must also (a) get the decrypted rows from
// workers back to the main thread over IPC and (b) insert them into the single
// writer index (FTS5+vec0). This measures whether IPC + single-writer insert
// erase the parallelism win. If parallel still ≫ serial, the worker-pool loader
// is worth building; if not, skip #2.
//
// Faithful-but-simplified: content as TEXT (~16KB), embedding as raw BLOB (3072B,
// the envelope decrypt was proven negligible — 31/1500 samples — so it's omitted;
// the parallelized cost is the SQLCipher page-decrypt scan). Source + index are
// BOTH encrypted SQLCipher DBs, like production. Single writer = main thread.
// Never logs content/vectors — only counts/timings (CLAUDE.md §1).
import Database from 'better-sqlite3';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, rmSync, statSync } from 'node:fs';
import { initSearchSchema, VEC_DIM, VEC_SHORTLIST_DIM } from '../src/search/sqlite/schema.js';

const KEY = 'e'.repeat(64);
const SRC = join(tmpdir(), 'spike-pb-src.db');

function openKeyed(path, { readonly = false } = {}) {
  const db = new Database(path, { readonly });
  db.pragma(`cipher='sqlcipher'`);
  db.pragma(`key="x'${KEY}'"`);
  return db;
}
const f32buf = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
function prefix256(v) {
  const out = new Float32Array(VEC_SHORTLIST_DIM); let n = 0;
  for (let i = 0; i < VEC_SHORTLIST_DIM; i++) { out[i] = v[i]; n += v[i] * v[i]; }
  n = Math.sqrt(n) || 1; for (let i = 0; i < VEC_SHORTLIST_DIM; i++) out[i] /= n;
  return out;
}
function normalize(v) {
  let n = 0; for (let i = 0; i < v.length; i++) n += v[i] * v[i]; n = Math.sqrt(n) || 1;
  const o = new Float32Array(v.length); for (let i = 0; i < v.length; i++) o[i] = v[i] / n; return o;
}

// ── Worker: scan a rowid slice, return batches of {id, text, vecBuf}. ─────────
if (!isMainThread) {
  const { lo, hi } = workerData;
  const db = openKeyed(SRC, { readonly: true });
  const stmt = db.prepare('SELECT rowid AS id, content, embedding FROM messages WHERE rowid >= ? AND rowid < ?');
  let batch = [];
  const transfers = [];
  const flush = () => {
    if (!batch.length) return;
    parentPort.postMessage({ rows: batch }, transfers.slice());
    batch = []; transfers.length = 0;
  };
  for (const r of stmt.iterate(lo, hi)) {
    // Copy the embedding bytes into a fresh ArrayBuffer so it can be TRANSFERRED
    // (zero-copy) to main rather than serialized.
    const ab = r.embedding.buffer.slice(r.embedding.byteOffset, r.embedding.byteOffset + r.embedding.byteLength);
    batch.push({ id: String(r.id), text: r.content, vec: ab });
    transfers.push(ab);
    if (batch.length >= 1000) flush();
  }
  flush();
  db.close();
  parentPort.postMessage({ done: true });
}

else {
  const N = Number(process.argv[2] || 24000);

  function buildSource() {
    for (const s of ['', '-wal', '-shm']) { try { if (existsSync(SRC + s)) rmSync(SRC + s); } catch {} }
    const db = openKeyed(SRC); db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE messages (rowid INTEGER PRIMARY KEY, content TEXT, embedding BLOB)');
    const ins = db.prepare('INSERT INTO messages(rowid, content, embedding) VALUES (?, ?, ?)');
    const content = ('reflection about meaning work people time memory and ideas ').repeat(280); // ~16KB
    const emb = Buffer.alloc(3072);
    for (let i = 0; i < emb.length; i++) emb[i] = (i * 31 + 7) & 0xff;
    const tx = db.transaction(() => { for (let i = 1; i <= N; i++) ins.run(i, content + i, emb); });
    tx();
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  }

  function freshIndex(tag) {
    const p = join(tmpdir(), `spike-pb-idx-${tag}.db`);
    for (const s of ['', '-wal', '-shm']) { try { if (existsSync(p + s)) rmSync(p + s); } catch {} }
    const db = openKeyed(p); db.pragma('journal_mode = WAL');
    initSearchSchema(db);
    db.pragma('wal_autocheckpoint = 0');
    return { db, p };
  }
  function makeInserter(db) {
    const s = {
      meta: db.prepare('INSERT INTO doc_meta(id, ts) VALUES (?, ?)'),
      fts: db.prepare('INSERT INTO fts_docs(id, content) VALUES (?, ?)'),
      v768: db.prepare('INSERT INTO vec_docs_768(id, embedding) VALUES (?, ?)'),
      v256: db.prepare('INSERT INTO vec_docs_256(id, embedding) VALUES (?, ?)'),
    };
    return db.transaction((rows) => {
      for (const r of rows) {
        s.meta.run(r.id, 1700000000);
        s.fts.run(r.id, r.text);
        const v = normalize(new Float32Array(r.vec));
        s.v768.run(r.id, f32buf(v));
        s.v256.run(r.id, f32buf(prefix256(v)));
      }
    });
  }

  async function serial() {
    const { db, p } = freshIndex('serial');
    const insert = makeInserter(db);
    const src = openKeyed(SRC, { readonly: true });
    const t0 = Date.now();
    const stmt = src.prepare('SELECT rowid AS id, content, embedding FROM messages');
    let batch = [];
    for (const r of stmt.iterate()) {
      const ab = r.embedding.buffer.slice(r.embedding.byteOffset, r.embedding.byteOffset + r.embedding.byteLength);
      batch.push({ id: String(r.id), text: r.content, vec: ab });
      if (batch.length >= 1000) { insert(batch); batch = []; }
    }
    if (batch.length) insert(batch);
    const ms = Date.now() - t0;
    src.close(); db.pragma('wal_checkpoint(TRUNCATE)'); const docs = db.prepare('SELECT COUNT(*) c FROM doc_meta').get().c; db.close();
    for (const s of ['', '-wal', '-shm']) { try { rmSync(p + s); } catch {} }
    return { ms, docs };
  }

  async function parallel(K) {
    const { db, p } = freshIndex('par');
    const insert = makeInserter(db);
    const span = Math.ceil(N / K);
    const t0 = Date.now();
    let inserted = 0;
    const tasks = [];
    for (let t = 0; t < K; t++) {
      const lo = 1 + t * span, hi = Math.min(1 + (t + 1) * span, N + 1);
      if (lo >= hi) continue;
      tasks.push(new Promise((resolve, reject) => {
        const w = new Worker(new URL(import.meta.url), { workerData: { lo, hi } });
        w.on('message', (m) => {
          if (m.done) { w.terminate(); resolve(); return; }
          insert(m.rows); inserted += m.rows.length; // main = single writer
        });
        w.on('error', reject);
      }));
    }
    await Promise.all(tasks);
    const ms = Date.now() - t0;
    db.pragma('wal_checkpoint(TRUNCATE)'); const docs = db.prepare('SELECT COUNT(*) c FROM doc_meta').get().c; db.close();
    for (const s of ['', '-wal', '-shm']) { try { rmSync(p + s); } catch {} }
    return { ms, docs, inserted };
  }

  process.stdout.write(`Spike 4: end-to-end parallel build — ${N} rows (~20KB each)\n`);
  if (!existsSync(SRC) || Number(process.env.REBUILD)) {
    const b0 = Date.now(); buildSource();
    process.stdout.write(`  built source: ${(statSync(SRC).size / 1048576).toFixed(0)} MB in ${((Date.now() - b0) / 1000).toFixed(1)}s\n`);
  }
  const s = await serial();
  process.stdout.write(`  SERIAL (scan+insert, main only): ${(s.ms / 1000).toFixed(2)}s  (${s.docs} docs)\n`);
  for (const K of [4, 8]) {
    const r = await parallel(K);
    process.stdout.write(`  PARALLEL K=${K} (workers scan→IPC→main insert): ${(r.ms / 1000).toFixed(2)}s  (${r.docs} docs)  ${(s.ms / r.ms).toFixed(1)}× vs serial\n`);
  }
  for (const x of ['', '-wal', '-shm']) { try { if (existsSync(SRC + x)) rmSync(SRC + x); } catch {} }
}
