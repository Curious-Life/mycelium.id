// Mind-search subsystem proof (Wave 2): exercise the in-RAM index primitives
// (BM25 + ANN cosine + RRF), the searchHelpers bulkSearch contract, and the
// mindscape tool domain end-to-end over a real MCP Client. PASS/FAIL ledger;
// exits 0 only on full GO. Mirrors scripts/verify-mcp.mjs.
//
// EMBEDDER NOTE: the real embedder (Nomic v1.5 ONNX, embed-service :8091) ships
// in a sibling unit (R2) and is NOT available here. To prove the pipeline
// (ANN cosine + RRF fusion + temporal boost) without the model, we inject a
// DETERMINISTIC STUB embedder (fixed-dim, hash-based, L2-normalized). Real-
// embedding parity is therefore gated on R2 — documented here and in
// src/search/helpers.js.
import Database from 'better-sqlite3';
import { readFileSync, rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { boot } from '../src/index.js';
import { createSearchHelpers } from '../src/search/helpers.js';
import { rrf } from '../src/search/fusion/rrf.js';
import { cosine, topKCosine } from '../src/search/ann/cosine.js';
import { BM25Scorer } from '../src/search/index/bm25.js';
import { InvertedIndex } from '../src/search/index/inverted.js';
import { tokenizeStrings } from '../src/search/index/tokenize.js';

const ledger = [];
const rec = (name, pass, detail = '') => {
  ledger.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
};

// ── Deterministic STUB embedder ─────────────────────────────────────────────
const DIM = 64;
function stubVector(text) {
  const v = new Array(DIM).fill(0);
  for (const tok of String(text).toLowerCase().split(/[^a-z0-9]+/)) {
    if (tok.length < 2) continue;
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    v[Math.abs(h) % DIM] += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return Float32Array.from(v.map((x) => x / norm));
}
const stubEmbedder = {
  async embed(text) { return stubVector(text); },
  async health() { return true; },
};

const DOCS = [
  { id: 'd1', text: 'the quick brown fox jumps over the lazy dog in the forest', type: 'message', ts: 1748000000 },
  { id: 'd2', text: 'meditation and mindfulness practice for a calm focused mind', type: 'document', ts: 1747900000 },
  { id: 'd3', text: 'the fox is a clever forest animal that hunts at dusk', type: 'message', ts: 1747800000 },
];

try {
  // ── S1: BM25 over the inverted index ranks the on-topic doc first ─────────
  {
    const idx = new InvertedIndex();
    for (const d of DOCS) idx.add(d.id, tokenizeStrings(d.text), d.ts);
    const hits = new BM25Scorer(idx).score(tokenizeStrings('meditation mindfulness'));
    rec('S1. BM25 ranks the on-topic doc first', hits.length > 0 && hits[0].id === 'd2',
      `top=${hits[0]?.id} score=${hits[0]?.score?.toFixed(3)}`);
  }

  // ── S2: cosine + topKCosine over stub vectors ────────────────────────────
  {
    const q = stubVector('fox forest');
    const cands = DOCS.map((d) => stubVector(d.text));
    const selfOk = Math.abs(cosine(cands[0], cands[0]) - 1) < 1e-5;
    const top = topKCosine(q, cands, 3, { assumeUnit: false });
    const topId = DOCS[top[0].idx].id;
    rec('S2. ANN cosine: self-sim≈1 and fox/forest doc on top', selfOk && (topId === 'd1' || topId === 'd3'),
      `selfSim≈1:${selfOk} topId=${topId}`);
  }

  // ── S3: RRF fuses ranked lists; an id in both lists outranks singletons ───
  {
    const fused = rrf([[{ id: 'x' }, { id: 'y' }], [{ id: 'x' }, { id: 'z' }]]);
    rec('S3. RRF: id present in both lists ranks first', fused[0]?.id === 'x',
      `order=${fused.map((f) => f.id).join('>')}`);
  }

  // ── S4: searchHelpers.search() returns RRF-ranked, enriched hits ──────────
  let helpers;
  {
    helpers = createSearchHelpers({ db: null, embedder: stubEmbedder, userId: 'local-user' });
    for (const d of DOCS) await helpers.addDoc(d);
    const hits = await helpers.search('fox forest', { limit: 3 });
    const ids = hits.map((h) => h.id);
    const descending = hits.every((h, i) => i === 0 || hits[i - 1].score >= h.score);
    const foxBeatsMed =
      ids.includes('d1') && ids.includes('d3') &&
      (!ids.includes('d2') || ids.indexOf('d2') > Math.max(ids.indexOf('d1'), ids.indexOf('d3')));
    rec('S4. search() returns RRF-ranked ids (fox docs ahead of meditation)',
      hits.length > 0 && descending && foxBeatsMed, `ids=${ids.join(',')}`);
  }

  // ── S4b: COLD START — empty index degrades to "no results", never throws ──
  {
    const cold = createSearchHelpers({ db: null, embedder: stubEmbedder, userId: 'local-user' });
    let coldHits, coldBulk, threw = false;
    try {
      coldHits = await cold.search('anything', { limit: 5 });
      coldBulk = await cold.bulkSearch({ query: 'anything', limit: 5, scope: 'all' });
    } catch { threw = true; }
    rec('S4b. cold start (empty index) returns empty, does not throw all_tiers_exhausted',
      !threw && Array.isArray(coldHits) && coldHits.length === 0 &&
        coldBulk && coldBulk.messages.length === 0,
      `threw=${threw} hits=${coldHits?.length}`);
  }

  // ── S5: bulkSearch() buckets hits by mindscape layer (messages/documents) ─
  {
    const bs = await helpers.bulkSearch({ query: 'fox forest', limit: 5, scope: 'all' });
    const shapeOk =
      Array.isArray(bs.messages) && Array.isArray(bs.documents) &&
      bs.territories && Array.isArray(bs.territories.formatted) && Array.isArray(bs.territories.raw) &&
      Array.isArray(bs.realms) && Array.isArray(bs.themes);
    rec('S5. bulkSearch() returns the mindscape-layer shape with results',
      shapeOk && bs.messages.length >= 1, `messages=${bs.messages?.length} documents=${bs.documents?.length}`);
  }

  // ── S6: lexical-only mode (no embedder) still returns BM25 results ────────
  {
    const lex = createSearchHelpers({ db: null, embedder: null, userId: 'local-user' });
    for (const d of DOCS) await lex.addDoc(d);
    const hits = await lex.search('meditation mindfulness', { limit: 2 });
    rec('S6. lexical-only (no embedder) returns BM25 results',
      hits.length > 0 && hits[0].id === 'd2', `top=${hits[0]?.id}`);
  }

  // ── S7: structure() is honest "no topology yet" with no clusters table ────
  {
    const struct = await helpers.structure();
    rec('S7. structure() returns empty clusters until topology runs',
      struct && Array.isArray(struct.clusters) && struct.clusters.length === 0,
      `clusters=${struct?.clusters?.length}`);
  }

  // ── Tool-surface proof: real MCP Client over InMemoryTransport ────────────
  const DB = 'data/verify-search.db';
  const KCV = 'data/verify-search-kcv.json';
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  mkdirSync('data', { recursive: true });
  new Database(DB).exec(readFileSync('migrations/0001_init.sql', 'utf8'));
  const hex = () => crypto.randomBytes(32).toString('hex');

  // Pre-build a searchHelpers with the stub embedder + seeded docs, injected
  // through boot() so the mindscape tools have real content to return.
  const seeded = createSearchHelpers({ db: null, embedder: stubEmbedder, userId: 'local-user' });
  for (const d of DOCS) await seeded.addDoc(d);
  const { server, close, tools } = await boot({
    dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(), searchHelpers: seeded,
  });

  const toolNames = tools.map((t) => t.name);
  rec('T1. boot() registers searchMindscape', toolNames.includes('searchMindscape'),
    `tools=${toolNames.join(', ')}`);
  rec('T2. boot() registers mindscapeStructure', toolNames.includes('mindscapeStructure'));

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'verify-search-client', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);

  const listed = await client.listTools();
  const listedNames = listed.tools.map((t) => t.name);
  rec('T3. tools/list (over the wire) includes both mindscape tools',
    listedNames.includes('searchMindscape') && listedNames.includes('mindscapeStructure'),
    `listed=${listedNames.join(', ')}`);

  let searchText = '';
  try {
    const res = await client.callTool({ name: 'searchMindscape', arguments: { query: 'fox forest', limit: 3 } });
    searchText = res.content?.filter((c) => c.type === 'text').map((c) => c.text).join('\n') || '';
  } catch (e) { searchText = `THREW: ${e.message}`; }
  rec('T4. searchMindscape returns non-empty text content',
    typeof searchText === 'string' && searchText.length > 0 && !searchText.startsWith('THREW'),
    `text="${searchText.slice(0, 80).replace(/\n/g, ' ')}"`);

  let structText = '';
  try {
    const res = await client.callTool({ name: 'mindscapeStructure', arguments: {} });
    structText = res.content?.filter((c) => c.type === 'text').map((c) => c.text).join('\n') || '';
  } catch (e) { structText = `THREW: ${e.message}`; }
  rec('T5. mindscapeStructure returns honest text content',
    typeof structText === 'string' && structText.length > 0 && !structText.startsWith('THREW'),
    `text="${structText.slice(0, 80).replace(/\n/g, ' ')}"`);

  await client.close();
  close();
} catch (err) {
  rec('FATAL — verify-search threw', false, err.stack || err.message);
}

const allPass = ledger.length > 0 && ledger.every(Boolean);
const passCount = ledger.filter(Boolean).length;
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO' : 'NO-GO'} — mind-search + mindscape (${passCount}/${ledger.length})  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
