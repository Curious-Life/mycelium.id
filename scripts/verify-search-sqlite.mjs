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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';
import { createSqliteBackend } from '../src/search/backend/sqlite.js';
import { createLocalBackend, createStubEmbedder, createSearchHelpers } from '../src/search/index.js';
import { loadFromDb } from '../src/search/d1-loader.js';
import { captureMessage } from '../src/ingest/capture.js';

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

  // ── SQ12 step-2b: createSearchHelpers flag-selects sqlite + populates once ─
  // Minimal real-handle "db" namespace: rawQuery routes to the same better-
  // sqlite3 file the backend uses (plaintext fixture; no crypto/migrations).
  const intRaw = new Database(':memory:');
  intRaw.exec(`CREATE TABLE messages (id TEXT, user_id TEXT, content TEXT, created_at TEXT, embedding_768 TEXT, forgotten_at TEXT, sensitive INTEGER DEFAULT 0, agent_id TEXT)`);
  const seed = intRaw.prepare('INSERT INTO messages(id,user_id,content,created_at) VALUES (?,?,?,?)');
  seed.run('m-forest', 'u1', 'the forest canopy and ancient trees', '2026-06-01T00:00:00.000Z');
  seed.run('m-vault', 'u1', 'an encrypted vault of private notes', '2026-06-02T00:00:00.000Z');
  seed.run('m-budget', 'u1', 'quarterly budget and finances', '2026-06-03T00:00:00.000Z');
  const fakeDb = {
    _sqlite: intRaw,
    rawQuery: (sql, params = []) => { try { return { results: intRaw.prepare(sql).all(...params) }; } catch { return { results: [] }; } },
  };
  const sh = createSearchHelpers({ db: fakeDb, userId: 'u1', searchBackend: 'sqlite' });
  const isSqlite = !!sh.backend?._internal && sh.backend._internal().raw === intRaw;
  const bs = await sh.bulkSearch({ query: 'forest trees', limit: 5 });
  rec('SQ12a createSearchHelpers(searchBackend:sqlite) selects + populates the on-disk backend',
    isSqlite && bs.messages.some((m) => m.includes('forest')),
    `kind=${isSqlite ? 'sqlite' : 'local'} msgs=${bs.messages.length}`);

  // Persistence: a SECOND helper over the SAME handle must NOT rebuild (count>0
  // path) yet still return hits — proves no per-boot whole-corpus rehydrate.
  const populated = intRaw.prepare('SELECT COUNT(*) c FROM doc_meta').get().c;
  const sh2 = createSearchHelpers({ db: fakeDb, userId: 'u1', searchBackend: 'sqlite' });
  const bs2 = await sh2.bulkSearch({ query: 'budget', limit: 5 });
  rec('SQ12b on-disk index persists → 2nd boot skips rebuild, still searchable',
    populated === 3 && bs2.messages.some((m) => m.includes('budget')),
    `docMeta=${populated} 2ndHits=${bs2.messages.length}`);

  // Default (no flag) still selects the in-RAM backend — zero behavior change.
  const shDefault = createSearchHelpers({ db: fakeDb, userId: 'u1' });
  rec('SQ12c default (no flag) keeps the in-RAM LocalBackend',
    !!shDefault.backend?._internal && !!shDefault.backend._internal().index,
    'default backend is in-RAM');

  // ── SQ13 build-flag robustness: incremental add before 1st query must NOT
  //    skip the full corpus build (the count()>0 trap the flag fixes) ─────────
  const bfRaw = new Database(':memory:');
  bfRaw.exec(`CREATE TABLE messages (id TEXT, user_id TEXT, content TEXT, created_at TEXT, embedding_768 TEXT, forgotten_at TEXT, sensitive INTEGER DEFAULT 0, agent_id TEXT)`);
  const bfSeed = bfRaw.prepare('INSERT INTO messages(id,user_id,content,created_at) VALUES (?,?,?,?)');
  bfSeed.run('seed-1', 'u1', 'seeded alpha document', '2026-06-01T00:00:00.000Z');
  bfSeed.run('seed-2', 'u1', 'seeded beta document', '2026-06-02T00:00:00.000Z');
  const bfDb = { _sqlite: bfRaw, rawQuery: (s, p = []) => { try { return { results: bfRaw.prepare(s).all(...p) }; } catch { return { results: [] }; } } };
  const bfSh = createSearchHelpers({ db: bfDb, userId: 'u1', searchBackend: 'sqlite' });
  await bfSh.noteUpsert({ id: 'incr-1', text: 'incrementally added before any query', ts: now }); // makes count>0
  const bfBeforeBuilt = bfRaw.prepare("SELECT value FROM search_state WHERE key='corpus_built'").get()?.value;
  await bfSh.search('document', { limit: 5 }); // triggers ensureBuilt
  const bfSeededIndexed = bfRaw.prepare("SELECT COUNT(*) c FROM doc_meta WHERE id LIKE 'seed-%'").get().c;
  const bfBuiltAfter = bfRaw.prepare("SELECT value FROM search_state WHERE key='corpus_built'").get()?.value;
  rec('SQ13 persisted build-flag: incremental add does NOT skip the full loadFromDb',
    bfBeforeBuilt !== '1' && bfSeededIndexed === 2 && bfBuiltAfter === '1',
    `seededIndexed=${bfSeededIndexed} builtBefore=${bfBeforeBuilt} builtAfter=${bfBuiltAfter}`);

  // ── SQ14 capture hook end-to-end: a NEW message is searchable with NO rebuild
  const capRaw = new Database(':memory:');
  capRaw.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY, user_id TEXT, content TEXT, created_at TEXT, embedding_768 TEXT, forgotten_at TEXT, sensitive INTEGER DEFAULT 0, agent_id TEXT)`);
  const capDb = {
    _sqlite: capRaw,
    rawQuery: (s, p = []) => { try { return { results: capRaw.prepare(s).all(...p) }; } catch { return { results: [] }; } },
    messages: {
      getContentMeta: async () => ({ exists: false }),
      insertIgnore: async (rows) => { for (const r of rows) capRaw.prepare('INSERT OR IGNORE INTO messages(id,user_id,content,created_at) VALUES (?,?,?,?)').run(r.id, r.user_id, r.content, r.created_at || '2026-06-05T00:00:00.000Z'); },
    },
    audit: { log: async () => {} },
  };
  const capSh = createSearchHelpers({ db: capDb, userId: 'u1', searchBackend: 'sqlite' }); // registers as active (setMindSearch)
  capSh.backend.markCorpusBuilt(); // steady state: ensureBuilt must NOT rebuild
  await captureMessage(capDb, { userId: 'u1', id: 'cap-1', content: 'a brand new note about kayaking on alpine rivers', source: 'api' });
  const capFound = await capSh.bulkSearch({ query: 'kayaking alpine rivers', limit: 5 });
  rec('SQ14 capture hook: new message searchable immediately, NO rebuild (corpus_built stayed set)',
    capRaw.prepare("SELECT value FROM search_state WHERE key='corpus_built'").get()?.value === '1' &&
    capFound.messages.some((m) => m.includes('kayaking')),
    `msgs=${capFound.messages.length}`);

  // ── SQ15 enrich noteVector: vector added to an existing fts-only doc → vector
  //    query finds it; ts/fts preserved (no clobber) ─────────────────────────
  const enRaw = new Database(':memory:');
  const enbe = createSqliteBackend({ sqliteDb: enRaw, userId: 'u1' });
  await enbe.add({ id: 'en-1', text: 'photosynthesis in deep ocean vents', ts: now - 999 }); // fts + ts, no vector
  enbe.noteVector('en-1', axisVec(9)); // enrichment hands the raw vector
  const enVecHits = await enbe.query({ embedding: axisVec(9), topK: 3 });
  const enTs = enRaw.prepare("SELECT ts FROM doc_meta WHERE id='en-1'").get()?.ts;
  rec('SQ15 noteVector: enrichment vector indexed for an existing doc; ts preserved',
    enVecHits.hits.some((h) => h.id === 'en-1') && enTs === now - 999,
    `vecHit=${enVecHits.hits.some((h) => h.id === 'en-1')} ts=${enTs} (want ${now - 999})`);

  // ── SQ16 maintenance is a NO-OP on the default in-RAM backend ──────────────
  const ramSh = createSearchHelpers({ db: { rawQuery: () => ({ results: [] }) }, userId: 'u1' }); // no flag → in-RAM
  let threw = false;
  try { await ramSh.noteUpsert({ id: 'x', text: 'y', ts: now }); ramSh.noteVector('x', axisVec(1)); await ramSh.noteDelete(['x']); } catch { threw = true; }
  rec('SQ16 maintenance API is a safe no-op on the in-RAM backend', !threw && ramSh.backendKind === 'local');

  // ── SQ17 bulk build: resetIndex + bulkAdd correctness (no dup; eviction) ─────
  // loadFromDb now resets the index then commits rows in batches via bulkAdd. A
  // full rebuild over a SHRUNK source must (a) not duplicate, (b) drop the row
  // that left the source. (Same fixture shape as SQ12 but driven through the
  // real loadFromDb bulk path.)
  const blkRaw = new Database(':memory:');
  blkRaw.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY, user_id TEXT, content TEXT, created_at TEXT, embedding_768 TEXT, forgotten_at TEXT, sensitive INTEGER DEFAULT 0, agent_id TEXT)`);
  const blkSeed = blkRaw.prepare('INSERT INTO messages(id,user_id,content,created_at) VALUES (?,?,?,?)');
  for (let i = 0; i < 5; i++) blkSeed.run(`bk-${i}`, 'u1', `bulk loaded entry ${i} about forest and vault`, `2026-06-0${i + 1}T00:00:00.000Z`);
  const blkBe = createSqliteBackend({ sqliteDb: blkRaw, userId: 'u1' });
  const blkDb = { _sqlite: blkRaw, rawQuery: (s, p = []) => { try { return { results: blkRaw.prepare(s).all(...p) }; } catch { return { results: [] }; } } };
  const r1 = await loadFromDb({ backend: blkBe, db: blkDb, userId: 'u1' });
  const cnt1 = await blkBe.count();
  // Rebuild #2 over the SAME source: count must be identical (no dup).
  await loadFromDb({ backend: blkBe, db: blkDb, userId: 'u1' });
  const cnt2 = await blkBe.count();
  // Shrink the source (delete bk-4), rebuild #3: the row must be evicted.
  blkRaw.prepare("DELETE FROM messages WHERE id='bk-4'").run();
  await loadFromDb({ backend: blkBe, db: blkDb, userId: 'u1' });
  const cnt3 = await blkBe.count();
  const stillFinds = (await blkBe.query({ text: 'forest vault', topK: 10 })).hits.length;
  rec('SQ17 bulk loadFromDb: no dup on rebuild + evicts removed rows + searchable',
    r1.added === 5 && cnt1 === 5 && cnt2 === 5 && cnt3 === 4 && stillFinds === 4,
    `added=${r1.added} cnt1=${cnt1} cnt2=${cnt2} cnt3(afterDelete)=${cnt3} finds=${stillFinds}`);

  // ── SQ18 PERF GUARD (encrypted DB): bulkAdd must be ≫ faster than per-doc add
  //    AND flat (no degradation). This is the permanent guard against regressing
  //    to one-transaction-per-doc — the exact bug that made the at-rest build take
  //    days (spike strategy A: 900/s → 14/min). Runs on a REAL SQLCipher file so
  //    the cipher's per-page crypto cost is in the measurement, not a plaintext :memory:.
  const PN = parseInt(process.env.SQLITE_PERF_N || '4000', 10);
  const KEY = 'b'.repeat(64);
  const mkEnc = (tag) => {
    const p = join(tmpdir(), `verify-sqlite-perf-${tag}-${process.pid}.db`);
    for (const s of ['', '-wal', '-shm']) { try { if (existsSync(p + s)) rmSync(p + s); } catch { /* ignore */ } }
    const d = new Database(p);
    d.pragma(`cipher='sqlcipher'`); d.pragma(`key="x'${KEY}'"`); d.pragma('journal_mode = WAL');
    return { db: d, path: p };
  };
  const mkCorpus = (n) => {
    const out = [];
    for (let i = 0; i < n; i++) { const v = axisVec(i % 64, i); out.push({ id: `pf-${i}`, text: `reflection ${i} term${i % 97} term${i % 53} about meaning and people`, embedding: v, ts: now - i }); }
    return out;
  };
  const corpusPerf = mkCorpus(PN);
  // (a) per-doc add() — measure first vs last window to expose degradation.
  const encA = mkEnc('perdoc');
  const beA = createSqliteBackend({ sqliteDb: encA.db, userId: 'u1' });
  const W = Math.max(500, Math.floor(PN / 4));
  let firstW = 0, lastW = 0, tA0 = Date.now(), wStart = Date.now();
  for (let i = 0; i < PN; i++) {
    await beA.add(corpusPerf[i]);
    if ((i + 1) % W === 0) { const dt = (Date.now() - wStart) / 1000; if (i + 1 === W) firstW = W / dt; lastW = W / dt; wStart = Date.now(); }
  }
  const perDocRate = PN / ((Date.now() - tA0) / 1000);
  encA.db.close();
  // (b) bulkAdd via resetIndex + batched transaction.
  const encB = mkEnc('bulk');
  const beB = createSqliteBackend({ sqliteDb: encB.db, userId: 'u1' });
  beB.resetIndex();
  const tB0 = Date.now();
  for (let i = 0; i < PN; i += 2000) beB.bulkAdd(corpusPerf.slice(i, i + 2000));
  beB.optimize();
  const bulkRate = PN / ((Date.now() - tB0) / 1000);
  const bulkCount = await beB.count();
  encB.db.close();
  for (const e of [encA, encB]) for (const s of ['', '-wal', '-shm']) { try { if (existsSync(e.path + s)) rmSync(e.path + s); } catch { /* ignore */ } }
  const speedup = bulkRate / Math.max(1, perDocRate);
  const perDocDecay = firstW > 0 ? lastW / firstW : 1; // <1 means it slowed down
  // Correctness is the HARD gate. The speedup ratio is the real regression guard
  // (regressing to one-txn-per-doc collapses it toward 1×) — require a safe ≥2×
  // rather than ≥4× so CI's variable shared hardware doesn't flake a genuine
  // 5×+ down to a fail. perDocDecay (proving per-doc DEGRADES) is noise-prone on
  // fast runners with warm caches, so it's informational, not gating.
  rec(`SQ18 PERF GUARD: bulk build ≫ per-doc on encrypted DB`,
    bulkCount === PN && speedup >= 2,
    `N=${PN} bulk=${Math.round(bulkRate)}/s perDoc=${Math.round(perDocRate)}/s speedup=${speedup.toFixed(1)}× perDocDecay(last/first)=${perDocDecay.toFixed(2)} [decay informational]`);

  const passed = ledger.filter(Boolean).length;
  const failed = ledger.length - passed;
  console.log('\n================================================================');
  console.log(`VERDICT: ${failed === 0 ? 'GO' : 'NO-GO'} — on-disk SQLite search backend (FTS5+sqlite-vec, two-stage D10)  (${passed} pass, ${failed} fail)  EXIT=${failed === 0 ? 0 : 1}`);
  console.log('================================================================');
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error('GATE CRASHED:', e); process.exit(1); });
