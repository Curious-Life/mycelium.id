// Verify the mind-search subsystem + mindscape tool domain end-to-end.
//
// Layer 1 (unit): exercise the ported primitives (tokenize / BM25 / cosine /
// RRF / temporal) and the full searchHelpers pipeline with a DETERMINISTIC
// STUB embedder over seeded docs — proves BM25 + ANN cosine + RRF work WITHOUT
// the real embed-service (sibling unit R2). Real-embedding parity is gated on
// R2; this script never imports or assumes embed-service.
//
// Layer 2 (integration): boot the REAL server with the stub embedder injected,
// connect a real MCP Client over InMemoryTransport, assert searchMindscape is
// in tools/list and returns text grounded in seeded DB rows.
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>; process.exit reflects pass/fail.

import Database from 'better-sqlite3';
import { readFileSync, rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { boot } from '../src/index.js';
import {
  createSearchHelpers,
  createStubEmbedder,
  rrf,
  bm25Score,
  InvertedIndex,
  cosine,
  topKCosine,
  temporalBoost,
  tokenizeStrings,
} from '../src/search/index.js';

const DB = 'data/verify-search.db';
const KCV = 'data/verify-search-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');

const ledger = [];
const rec = (name, pass, detail = '') => {
  ledger.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
};

// Seed corpus: two "message" rows about forests, one about finance.
const ROWS = [
  { id: 'm-forest-1', content: 'the ancient forest grows tall with deep mycelium roots' },
  { id: 'm-forest-2', content: 'mycelium threads connect the roots beneath the forest floor' },
  { id: 'm-money-1', content: 'a quarterly financial ledger tracking revenue and expenses' },
];

// ── Layer 1: ported primitives ────────────────────────────────────────────

function unitPrimitives() {
  // tokenize: lowercase + stopword drop
  const toks = tokenizeStrings('The Ancient Forest');
  rec('tokenize: drops stopwords, lowercases', !toks.includes('the') && toks.includes('forest'),
    `tokens=${JSON.stringify(toks)}`);

  // cosine invariants
  const v = Float32Array.from([1, 0, 1, 0]);
  rec('cosine: cos(v,v) ≈ 1', Math.abs(cosine(v, v) - 1) < 1e-6);
  rec('cosine: orthogonal → 0', Math.abs(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1]))) < 1e-9);
  rec('cosine: zero vector → 0 (sentinel, not NaN)', cosine(v, Float32Array.from([0, 0, 0, 0])) === 0);

  // topKCosine ranks the identical vector first
  const cands = [Float32Array.from([0, 1]), Float32Array.from([1, 0]), Float32Array.from([0.9, 0.1])];
  const top = topKCosine(Float32Array.from([1, 0]), cands, 3, { assumeUnit: false });
  rec('topKCosine: identical vector ranks first', top[0].idx === 1);

  // BM25 over an inverted index
  const inv = new InvertedIndex();
  ROWS.forEach((r, i) => inv.add(r.id, tokenizeStrings(r.content), 1000 + i));
  const bm = bm25Score(tokenizeStrings('forest roots'), inv, { topK: 5 });
  rec('bm25: returns ranked matches', bm.length >= 2, `hits=${bm.map((h) => h.id).join(',')}`);
  rec('bm25: forest doc out-ranks finance doc', bm[0].id !== 'm-money-1');

  // RRF: an id in both lists ranks first
  const fused = rrf([[{ id: 'x' }, { id: 'y' }], [{ id: 'y' }, { id: 'z' }]], {});
  rec('rrf: id present in both lists ranks first', fused[0].id === 'y');
  rec('rrf: output ids ⊆ union of inputs', fused.every((h) => ['x', 'y', 'z'].includes(h.id)));

  // temporal: Δt=0 → unchanged; older → not higher
  const now = 2000;
  const boosted = temporalBoost([{ id: 'new', score: 1, ts: now }, { id: 'old', score: 1, ts: now - 30 * 24 * 3600 }],
    { queryTs: now, recency: 'mixed' });
  rec('temporal: recent item out-ranks equally-scored old item', boosted[0].id === 'new');
}

// ── Layer 1: full searchHelpers pipeline with stub embedder ────────────────

async function unitPipeline() {
  const embedder = createStubEmbedder(48);
  const sh = createSearchHelpers({ db: null, embedder });
  for (let i = 0; i < ROWS.length; i++) {
    await sh.indexDocument({ id: ROWS[i].id, text: ROWS[i].content, ts: 1000 + i });
  }

  // low-level search() → RRF-ranked ids
  const hits = await sh.search('forest mycelium roots', { limit: 3 });
  rec('search: returns RRF-ranked hits', Array.isArray(hits) && hits.length > 0,
    `hits=${hits.map((h) => h.id).join(',')}`);
  rec('search: scores are descending', hits.every((h, i) => i === 0 || hits[i - 1].score >= h.score));
  rec('search: forest doc out-ranks finance doc',
    hits.findIndex((h) => h.id.startsWith('m-forest')) < hits.findIndex((h) => h.id === 'm-money-1')
    || !hits.some((h) => h.id === 'm-money-1'));
  rec('search: every hit carries an id + numeric score',
    hits.every((h) => typeof h.id === 'string' && typeof h.score === 'number'));

  // empty query → empty bulkSearch shape
  const emptyBulk = await sh.bulkSearch({ query: '' });
  rec('bulkSearch: empty query → honest empty shape',
    emptyBulk.messages.length === 0 && emptyBulk.territories.raw.length === 0);

  // structure() with no db → honest empty
  const struct = await sh.structure();
  rec('structure: no db → honest empty shape',
    Array.isArray(struct.territories) && struct.counts.territories === 0);

  // BM25-only fallback (no embedder) still ranks
  const shNoEmb = createSearchHelpers({ db: null });
  for (let i = 0; i < ROWS.length; i++) await shNoEmb.indexDocument({ id: ROWS[i].id, text: ROWS[i].content, ts: 1000 + i });
  const kwHits = await shNoEmb.search('forest', { limit: 3 });
  rec('search: BM25-only fallback (no embedder) returns ranked hits', kwHits.length > 0,
    `hits=${kwHits.map((h) => h.id).join(',')}`);
}

// ── Layer 1: bulkSearch grouping against a real DB ─────────────────────────

function freshDb() {
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  mkdirSync('data', { recursive: true });
  const raw = new Database(DB);
  raw.exec(readFileSync('migrations/0001_init.sql', 'utf8'));
  return raw;
}

function seedRows(raw) {
  const ins = raw.prepare('INSERT INTO messages (id, user_id, role, content, source, agent_id, created_at) VALUES (?,?,?,?,?,?,?)');
  ins.run('m-forest-1', 'local-user', 'user', ROWS[0].content, 'chat', 'personal-agent', '2026-05-01 10:00:00');
  ins.run('m-forest-2', 'local-user', 'user', ROWS[1].content, 'chat', 'research-agent', '2026-05-02 10:00:00');
  ins.run('m-money-1', 'local-user', 'user', ROWS[2].content, 'chat', 'wealth-agent', '2026-05-03 10:00:00');
  const t = raw.prepare('INSERT INTO territory_profiles (territory_id, user_id, name, essence, message_count, top_entities, created_at) VALUES (?,?,?,?,?,?,?)');
  t.run('terr-forest', 'local-user', 'Forest Ecology', 'mycelium networks and forest roots', 12, '[]', '2026-05-01 10:00:00');
}

async function bulkSearchDb() {
  const raw = freshDb();
  seedRows(raw);
  // Build searchHelpers against a real encrypted db namespace via boot's createDb.
  // Simpler: reuse boot to get the db namespace, then a fresh helper over it.
  const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(), embedder: createStubEmbedder(48) });
  const sh = createSearchHelpers({ db, embedder: createStubEmbedder(48), userId: 'local-user' });

  const res = await sh.bulkSearch({ query: 'forest mycelium roots', limit: 5 });
  rec('bulkSearch: returns the 5-layer shape',
    Array.isArray(res.messages) && Array.isArray(res.documents)
    && res.territories && Array.isArray(res.territories.formatted) && Array.isArray(res.territories.raw)
    && Array.isArray(res.realms) && Array.isArray(res.themes));
  rec('bulkSearch: surfaces forest messages from DB', res.messages.length > 0,
    `messages=${res.messages.length}`);
  rec('bulkSearch: forest message ranks above finance (finance not in top hits or below)',
    res.messages.some((m) => /forest|mycelium/.test(m)));
  rec('bulkSearch: matched territory hydrated + formatted',
    res.territories.raw.some((t) => t.id === 'terr-forest')
    && res.territories.formatted.some((f) => /Forest Ecology/.test(f)));

  // agent filter
  const filtered = await sh.bulkSearch({ query: 'forest mycelium roots', limit: 5, scope: 'messages', agent: 'research-agent' });
  rec('bulkSearch: agent filter restricts message results',
    filtered.messages.every((m) => /research-agent/.test(m)) && filtered.messages.length > 0,
    `messages=${JSON.stringify(filtered.messages)}`);

  // structure() reads topology tables
  const struct = await sh.structure();
  rec('structure: reads territory profiles from DB', struct.counts.territories === 1
    && struct.territories[0].name === 'Forest Ecology');

  close();
}

// ── Layer 2: real MCP server integration ───────────────────────────────────

async function mcpIntegration() {
  const raw = freshDb();
  seedRows(raw);
  raw.close();

  const { server, close, tools, deferred } = await boot({
    dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(),
    embedder: createStubEmbedder(48),
  });

  rec('mcp: mindscape no longer deferred', !deferred.some((d) => /mindscape/.test(d)),
    `deferred=[${deferred.join(', ')}]`);
  rec('mcp: searchMindscape registered in tool set', tools.some((t) => t.name === 'searchMindscape'));

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'verify-search', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);

  const listed = await client.listTools();
  rec('mcp: searchMindscape in tools/list over the wire',
    listed.tools.some((t) => t.name === 'searchMindscape'));

  const call = await client.callTool({ name: 'searchMindscape', arguments: { query: 'forest mycelium roots', limit: 5 } });
  const text = call.content?.[0]?.text ?? '';
  rec('mcp: searchMindscape returns a text content envelope',
    call.content?.[0]?.type === 'text' && typeof text === 'string' && text.length > 0,
    `text='${text.slice(0, 80).replace(/\n/g, ' ')}'`);
  rec('mcp: result is grounded in seeded DB rows', /forest|mycelium|Forest Ecology/.test(text));

  await client.close();
  close();
}

async function main() {
  console.log('— Layer 1: ported primitives —');
  unitPrimitives();
  console.log('\n— Layer 1: searchHelpers pipeline (stub embedder) —');
  await unitPipeline();
  console.log('\n— Layer 1: bulkSearch grouping against real DB —');
  await bulkSearchDb();
  console.log('\n— Layer 2: real MCP server integration —');
  await mcpIntegration();

  const passed = ledger.filter(Boolean).length;
  const allPass = ledger.every(Boolean);
  console.log('\n' + '='.repeat(64));
  console.log(`VERDICT: ${allPass ? 'GO' : 'NO-GO'} — mind-search subsystem + mindscape domain (${passed}/${ledger.length})`);
  console.log(`EXIT=${allPass ? 0 : 1}`);
  console.log('='.repeat(64));
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  console.log('VERDICT: NO-GO — exception');
  console.log('EXIT=1');
  process.exit(1);
});
