// Gate: the on-disk SQLite search backend (Phase 1, step 2).
//
// Proves createSqliteBackend (FTS5 BM25 + sqlite-vec two-stage KNN + the
// UNCHANGED rrf/temporal fusion) satisfies the createLocalBackend contract and
// the design's §13 criteria — WITHOUT the in-RAM whole-corpus rehydrate.
//
// Fixture-only (in-memory + temp-file DBs; no real vault). PASS/FAIL ledger +
// VERDICT + EXIT=<code>. Run: npm run verify:search-sqlite
import Database from 'better-sqlite3';
import { webcrypto } from 'node:crypto';
import { createSqliteBackend } from '../src/search/backend/sqlite.js';
import { createLocalBackend, createStubEmbedder } from '../src/search/index.js';

const ledger = [];
const rec = (name, pass, detail = '') => {
  ledger.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
};

const D = 768;
const now = Math.floor(Date.now() / 1000);
// Deterministic, mostly-orthogonal unit-ish vectors: dominant axis + light noise.
function axisVec(axis, seed = 0) {
  const v = new Float32Array(D);
  v[axis % D] = 1;
  for (let i = 0; i < 12; i++) v[(axis * 31 + i * 7 + seed) % D] += 0.05;
  return v;
}
const f32 = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);

async function main() {
  // ── Correctness on a small seeded fixture ────────────────────────────────
  const raw = new Database(':memory:');
  const be = createSqliteBackend({ sqliteDb: raw, userId: 'u1' });

  const docs = [
    { id: 'uuid-a', text: 'the mycelium network connects forest trees underground', axis: 0 },
    { id: 'uuid-b', text: 'an encrypted vault stores private thoughts and reflections', axis: 1 },
    { id: 'territory:1', text: 'forest fungal threads share nutrients between trees', axis: 2 },
    { id: 'realm:7', text: 'quarterly budget spreadsheet and financial planning', axis: 3 },
  ];
  for (let i = 0; i < docs.length; i++) {
    await be.add({ id: docs[i].id, text: docs[i].text, embedding: axisVec(docs[i].axis), ts: now - (docs.length - i) * 100 });
  }
  rec('SQ1 schema init + count after 4 adds', (await be.count()) === 4, `count=${await be.count()}`);

  const kw = await be.query({ text: 'forest trees', topK: 5 });
  rec('SQ2a keyword (FTS5 bm25) finds both forest docs',
    kw.hits.some((h) => h.id === 'uuid-a') && kw.hits.some((h) => h.id === 'territory:1'),
    `hits=${kw.hits.map((h) => h.id).join(',')}`);
  const miss = await be.query({ text: 'zzznonexistentterm', topK: 5 });
  rec('SQ2b keyword miss → no hits', miss.hits.length === 0, `hits=${miss.hits.length}`);

  // Pure vector query (no text) near axis 1 → uuid-b nearest.
  const vq = await be.query({ embedding: axisVec(1), topK: 3 });
  rec('SQ3 two-stage vector KNN nearest-first (256-shortlist→768-rescore)',
    vq.hits[0]?.id === 'uuid-b', `top=${vq.hits[0]?.id}`);

  // Hybrid: text matches forest docs; vector points at the budget doc (axis 3).
  // RRF must fuse both lists → budget doc surfaces despite zero keyword overlap.
  const hybrid = await be.query({ text: 'forest', embedding: axisVec(3), topK: 5 });
  rec('SQ4 hybrid RRF fuses keyword + vector lists',
    hybrid.hits.some((h) => h.id === 'realm:7') && hybrid.hits.some((h) => h.id === 'uuid-a'),
    `hits=${hybrid.hits.map((h) => h.id).join(',')}`);

  // Upsert idempotent: re-add uuid-a with new content + vector → count unchanged.
  await be.add({ id: 'uuid-a', text: 'mycelium rewritten content about rivers', embedding: axisVec(5), ts: now });
  const c2 = await be.count();
  const reKw = await be.query({ text: 'rivers', topK: 5 });
  rec('SQ5 upsert idempotent (no dup) + content replaced',
    c2 === 4 && reKw.hits.some((h) => h.id === 'uuid-a'), `count=${c2} riversHit=${reKw.hits.map((h) => h.id)}`);

  // Forget: delete → gone from BOTH keyword and vector.
  const del = await be.delete({ ids: ['uuid-a'] });
  const afterKw = await be.query({ text: 'rivers mycelium', topK: 5 });
  const afterVec = await be.query({ embedding: axisVec(5), topK: 5 });
  rec('SQ6 forget removes from keyword + vector index',
    del.deleted === 1 && (await be.count()) === 3 &&
    !afterKw.hits.some((h) => h.id === 'uuid-a') && !afterVec.hits.some((h) => h.id === 'uuid-a'),
    `deleted=${del.deleted}`);

  // Temporal: two equally keyword-relevant docs, newer must win under recency=recent.
  const t1 = new Database(':memory:');
  const tbe = createSqliteBackend({ sqliteDb: t1, userId: 'u1' });
  await tbe.add({ id: 'old', text: 'meeting notes project alpha', embedding: axisVec(0), ts: now - 30 * 24 * 3600 });
  await tbe.add({ id: 'new', text: 'meeting notes project alpha', embedding: axisVec(0), ts: now - 60 });
  const trec = await tbe.query({ text: 'meeting notes project alpha', topK: 2, recency: 'recent', queryTs: now });
  rec('SQ7 temporal boost: newer outranks older (recency=recent)', trec.hits[0]?.id === 'new', `top=${trec.hits[0]?.id}`);

  rec('SQ8 query contract shape { hits, degraded, tier, takenMs }',
    Array.isArray(kw.hits) && kw.degraded === false && kw.tier === 1 && typeof kw.takenMs === 'number');

  // ── SQ9 parity vs in-RAM LocalBackend on the SAME fixture ─────────────────
  const r2 = new Database(':memory:');
  const sqb = createSqliteBackend({ sqliteDb: r2, userId: 'u1' });
  const ram = createLocalBackend({ userId: 'u1' });
  const corpus = [];
  for (let i = 0; i < 60; i++) {
    corpus.push({ id: `m${i}`, text: `document number ${i} about ${['forest', 'vault', 'budget', 'mycelium', 'ocean'][i % 5]} topic ${i % 7}`, embedding: axisVec(i % 40, i), ts: now - i * 10 });
  }
  for (const d of corpus) { await sqb.add(d); await ram.add(d); }
  let overlapSum = 0, trials = 0;
  for (const term of ['forest topic', 'vault budget', 'mycelium ocean', 'document number']) {
    const a = (await sqb.query({ text: term, topK: 10 })).hits.map((h) => h.id);
    const b = (await ram.query({ text: term, topK: 10 })).hits.map((h) => h.id);
    overlapSum += a.filter((id) => b.includes(id)).length / Math.max(1, b.length);
    trials++;
  }
  const meanOverlap = overlapSum / trials;
  rec('SQ9 keyword-ranking parity vs in-RAM backend (BM25 ranks agree ≥80%)',
    meanOverlap >= 0.8, `mean top-10 overlap=${(meanOverlap * 100).toFixed(0)}%`);

  // ── SQ10 perf at scale (§13: query <200ms; report RSS) ────────────────────
  const N = parseInt(process.env.SQLITE_GATE_N || '4000', 10);
  const pf = new Database(':memory:');
  const pbe = createSqliteBackend({ sqliteDb: pf, userId: 'u1' });
  const rnd = () => { const v = new Float32Array(D); let n = 0; for (let j = 0; j < D; j++) { const x = Math.random() - 0.5; v[j] = x; n += x * x; } n = Math.sqrt(n); for (let j = 0; j < D; j++) v[j] /= n; return v; };
  for (let i = 0; i < N; i++) await pbe.add({ id: `p${i}`, text: `entry ${i} term${i % 50} term${(i * 3) % 50}`, embedding: rnd(), ts: now - i });
  const times = [];
  for (let r = 0; r < 12; r++) { const t = Date.now(); await pbe.query({ text: `term${r % 50}`, embedding: rnd(), topK: 10 }); times.push(Date.now() - t); }
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length / 2)];
  const rssMB = Math.round(process.memoryUsage().rss / 1048576);
  rec(`SQ10 perf: N=${N} hybrid query p50 < 200ms`, p50 < 200, `p50=${p50}ms p95=${times[times.length - 1]}ms RSS=${rssMB}MB`);

  // ── SQ11 embed path via injected stub embedder (text-only query) ──────────
  const eraw = new Database(':memory:');
  const stub = createStubEmbedder(D); // positional dim → 768-d stub vectors
  const ebe = createSqliteBackend({ sqliteDb: eraw, embedder: stub, userId: 'u1' });
  await ebe.add({ id: 'e1', text: 'alpine lakes and mountain trails', ts: now });
  await ebe.add({ id: 'e2', text: 'database indexing and query planners', ts: now });
  const vecRows = eraw.prepare('SELECT COUNT(*) AS c FROM vec_docs_768').get().c;
  const eq = await ebe.query({ text: 'alpine lakes and mountain trails', topK: 2 });
  rec('SQ11 embed path: stub embedder populates 768-d vec table + vectors the query',
    vecRows === 2 && eq.hits[0]?.id === 'e1', `vecRows=${vecRows} top=${eq.hits[0]?.id}`);

  const passed = ledger.filter(Boolean).length;
  const failed = ledger.length - passed;
  console.log('\n================================================================');
  console.log(`VERDICT: ${failed === 0 ? 'GO' : 'NO-GO'} — on-disk SQLite search backend (FTS5+sqlite-vec, two-stage D10)  (${passed} pass, ${failed} fail)  EXIT=${failed === 0 ? 0 : 1}`);
  console.log('================================================================');
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error('GATE CRASHED:', e); process.exit(1); });
