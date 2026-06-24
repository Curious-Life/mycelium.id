// Spike 3: can the one-time corpus decrypt-read (the 312.9s single-threaded
// SQLCipher page-decrypt scan that dominates the at-rest index build) be
// PARALLELIZED across worker threads? SQLite scans one connection on one thread,
// but the file is encrypted — the cost is CPU (AES + HMAC-SHA512 per page), which
// is embarrassingly parallel: K workers each open their OWN read-only keyed
// connection and scan a DISJOINT rowid range concurrently (WAL/readonly allows
// many readers), so K cores decrypt K slices at once.
//
// Builds a synthetic encrypted DB with realistic ~row sizes (long content + an
// inline ~4KB embedding blob), then measures full-scan wall-clock at THREADS=1
// vs 4 vs 8. Never logs row content — only counts/timings (CLAUDE.md §1).
//
// Run: node scripts/spike-parallel-decrypt.mjs [rows]
import Database from 'better-sqlite3';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, rmSync, statSync } from 'node:fs';

const KEY = 'd'.repeat(64);
const DB = join(tmpdir(), 'spike-parallel.db');

function openKeyed(path, { readonly = false } = {}) {
  const db = new Database(path, { readonly });
  db.pragma(`cipher='sqlcipher'`);
  db.pragma(`key="x'${KEY}'"`);
  return db;
}

// ── Worker: scan a rowid slice, decrypt its pages (reading the columns forces
//    SQLCipher to decrypt+HMAC every page), return count + bytes touched. ──────
if (!isMainThread) {
  const { lo, hi } = workerData;
  const db = openKeyed(DB, { readonly: true });
  const t0 = Date.now();
  const stmt = db.prepare('SELECT content, embedding FROM messages WHERE rowid >= ? AND rowid < ?');
  let rows = 0, bytes = 0;
  for (const r of stmt.iterate(lo, hi)) {
    rows++;
    // Touch the bytes so the columns are actually materialized (real decrypt work).
    bytes += (r.content ? r.content.length : 0) + (r.embedding ? r.embedding.length : 0);
  }
  db.close();
  parentPort.postMessage({ rows, bytes, ms: Date.now() - t0 });
} else {
  // ── Main: build (once), then measure single vs multi-thread full scans. ─────
  const N = Number(process.argv[2] || 24000);

  function build() {
    for (const s of ['', '-wal', '-shm']) { try { if (existsSync(DB + s)) rmSync(DB + s); } catch {} }
    const db = openKeyed(DB);
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE messages (rowid INTEGER PRIMARY KEY, content TEXT, embedding BLOB)');
    const ins = db.prepare('INSERT INTO messages(rowid, content, embedding) VALUES (?, ?, ?)');
    // ~16KB content + ~4KB embedding blob → ~20KB/row, like a real message row.
    const contentTpl = ('reflection about meaning work people time and memory ').repeat(300); // ~16KB
    const emb = Buffer.alloc(3120); // 768 f32 (3072B) + GCM/scope overhead, raw bytes
    for (let i = 0; i < emb.length; i++) emb[i] = (i * 31 + 7) & 0xff;
    const tx = db.transaction(() => {
      for (let i = 1; i <= N; i++) ins.run(i, contentTpl + i, emb);
    });
    tx();
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  }

  async function scanParallel(threads) {
    // Partition rowid [1, N+1) into `threads` contiguous slices.
    const span = Math.ceil(N / threads);
    const t0 = Date.now();
    const workers = [];
    for (let t = 0; t < threads; t++) {
      const lo = 1 + t * span;
      const hi = Math.min(1 + (t + 1) * span, N + 1);
      if (lo >= hi) continue;
      workers.push(new Promise((resolve, reject) => {
        const w = new Worker(new URL(import.meta.url), { workerData: { lo, hi } });
        w.once('message', (m) => { w.terminate(); resolve(m); });
        w.once('error', reject);
      }));
    }
    const parts = await Promise.all(workers);
    const wall = Date.now() - t0;
    const rows = parts.reduce((a, p) => a + p.rows, 0);
    const slowest = Math.max(...parts.map((p) => p.ms));
    return { wall, rows, slowest, parts: parts.length };
  }

  process.stdout.write(`Spike 3: parallel corpus decrypt — ${N} rows (~20KB each)\n`);
  if (!existsSync(DB) || Number(process.env.REBUILD)) {
    const b0 = Date.now();
    build();
    process.stdout.write(`  built encrypted DB: ${(statSync(DB).size / 1048576).toFixed(0)} MB in ${((Date.now() - b0) / 1000).toFixed(1)}s\n`);
  }

  const results = {};
  for (const T of [1, 4, 8]) {
    // Two runs; take the 2nd (warm page cache) to compare CPU-bound decrypt fairly,
    // and also report the COLD first run since the real build is cold.
    const cold = await scanParallel(T);
    const warm = await scanParallel(T);
    results[T] = { cold, warm };
    process.stdout.write(`  THREADS=${T}: cold ${(cold.wall / 1000).toFixed(2)}s · warm ${(warm.wall / 1000).toFixed(2)}s  (${cold.rows} rows, ${cold.parts} workers)\n`);
  }
  const s1 = results[1].cold.wall, s4 = results[4].cold.wall, s8 = results[8].cold.wall;
  process.stdout.write(`\nCOLD speedup vs 1 thread:  4T = ${(s1 / s4).toFixed(1)}×   8T = ${(s1 / s8).toFixed(1)}×\n`);
  for (const s of ['', '-wal', '-shm']) { try { if (existsSync(DB + s)) rmSync(DB + s); } catch {} }
}
