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
import { applyMigrations } from '../src/db/migrate.js';
import { readFileSync, rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { boot, resolveDefaultEmbedder } from '../src/index.js';
import { createServiceEmbedder, assertEmbedder, safeEmbed } from '../src/search/embedder.js';
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
  applyMigrations(raw);
  return raw;
}

function seedRows(raw) {
  const ins = raw.prepare('INSERT INTO messages (id, user_id, role, content, source, agent_id, created_at) VALUES (?,?,?,?,?,?,?)');
  ins.run('m-forest-1', 'local-user', 'user', ROWS[0].content, 'chat', 'personal-agent', '2026-05-01 10:00:00');
  ins.run('m-forest-2', 'local-user', 'user', ROWS[1].content, 'chat', 'research-agent', '2026-05-02 10:00:00');
  ins.run('m-money-1', 'local-user', 'user', ROWS[2].content, 'chat', 'wealth-agent', '2026-05-03 10:00:00');
  const t = raw.prepare('INSERT INTO territory_profiles (territory_id, user_id, name, essence, message_count, top_entities, created_at) VALUES (?,?,?,?,?,?,?)');
  t.run(101, 'local-user', 'Forest Ecology', 'mycelium networks and forest roots', 12, '[]', '2026-05-01 10:00:00');
  // Seed realms + semantic_themes so the realm/theme layers of bulkSearch and
  // structure() are exercised (not just the territory layer). Guards against a
  // column-mismatch SELECT silently dropping a whole layer.
  const r = raw.prepare('INSERT INTO realms (realm_id, user_id, name, essence, message_count) VALUES (?,?,?,?,?)');
  r.run(201, 'local-user', 'Forest Realm', 'the broad forest mycelium realm', 30);
  // semantic_themes.realm_id is NOT NULL (composite UNIQUE(user_id,realm_id,semantic_theme_id)).
  const s = raw.prepare('INSERT INTO semantic_themes (semantic_theme_id, realm_id, user_id, name, essence, message_count) VALUES (?,?,?,?,?,?)');
  s.run(301, 201, 'local-user', 'Forest Theme', 'mycelium forest roots theme', 8);
  // Documents (BM25-only — no embedding_768). Explicit ids so the cold-start
  // "no live embed" assertion can address them. d-internal must NOT surface.
  // DOCUMENT-SEARCH design 2026-06-17.
  const d = raw.prepare('INSERT INTO documents (id, user_id, path, title, summary, content, is_internal, sensitive, created_at) VALUES (?,?,?,?,?,?,?,?,?)');
  d.run('d-forest-1', 'local-user', 'notes/forest.md', 'Forest Notes', 'mycelium networks beneath the forest floor', 'a document about the forest and its deep mycelium roots', 0, 0, '2026-05-04 10:00:00');
  d.run('d-internal-1', 'local-user', '_internal/model.md', 'Internal Model', 'internal forest mycelium scaffolding', 'internal-model document about forest mycelium', 1, 0, '2026-05-05 10:00:00');
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
    res.territories.raw.some((t) => t.id === '101')
    && res.territories.formatted.some((f) => /Forest Ecology/.test(f)));
  // realm + theme layers are indexed and partitioned correctly (kind-prefixed
  // ids keep the overlapping INTEGER pk space disjoint).
  rec('bulkSearch: realm layer indexed + returned',
    res.realms.some((r) => /Forest Realm/.test(r)),
    `realms=${res.realms.length}`);
  rec('bulkSearch: theme layer indexed + returned',
    res.themes.some((th) => /Forest Theme/.test(th)),
    `themes=${res.themes.length}`);

  // ── Document layer (DOCUMENT-SEARCH design 2026-06-17) ───────────────────
  rec('bulkSearch: document layer indexed + returned in scope=all',
    res.documents.some((dd) => /Forest Notes/.test(dd)),
    `documents=${res.documents.length}`);
  rec('bulkSearch: internal-model doc (is_internal=1) never surfaces',
    !res.documents.some((dd) => /Internal Model/.test(dd)));

  const docRes = await sh.bulkSearch({ query: 'forest mycelium roots', limit: 5, scope: 'documents' });
  rec('bulkSearch: scope=documents returns only the documents layer',
    docRes.documents.some((dd) => /Forest Notes/.test(dd))
    && docRes.messages.length === 0 && docRes.territories.raw.length === 0,
    `documents=${docRes.documents.length} messages=${docRes.messages.length}`);
  rec('bulkSearch: scope=documents excludes internal-model doc',
    !docRes.documents.some((dd) => /Internal Model/.test(dd)));

  // Cold-start guarantee: documents are BM25-only (skipEmbed) — they must NOT
  // trigger a live embed at load. Messages (no stored vector here) DO embed via
  // the stub, so the contrast proves skipEmbed is wired, not that embedding is
  // globally off.
  const vecs = sh.backend._internal().vectors;
  rec('bulkSearch: documents are BM25-only (no vector cached at load — skipEmbed)',
    !vecs.has('document:d-forest-1') && !vecs.has('document:d-internal-1'),
    `docVecCached=${vecs.has('document:d-forest-1')}`);
  rec('bulkSearch: messages still embed at load (skipEmbed is doc-scoped, not global)',
    vecs.has('m-forest-1'));

  // agent filter
  const filtered = await sh.bulkSearch({ query: 'forest mycelium roots', limit: 5, scope: 'messages', agent: 'research-agent' });
  rec('bulkSearch: agent filter restricts message results',
    filtered.messages.every((m) => /research-agent/.test(m)) && filtered.messages.length > 0,
    `messages=${JSON.stringify(filtered.messages)}`);

  // structure() reads topology tables
  const struct = await sh.structure();
  rec('structure: reads territory profiles from DB', struct.counts.territories === 1
    && struct.territories[0].name === 'Forest Ecology');
  // realms/semantic_themes have no dissolved_at column — structure() must NOT
  // reference it for those tables (only territory_profiles has it).
  rec('structure: reads realms from DB (no dissolved_at filter)',
    struct.counts.realms === 1 && struct.realms[0].name === 'Forest Realm',
    `realms=${struct.counts.realms}`);
  rec('structure: reads semantic themes from DB',
    struct.counts.themes === 1 && struct.themes[0].name === 'Forest Theme',
    `themes=${struct.counts.themes}`);

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

// ── R2 wiring: the service-embedder adapter + boot resolver ────────────────
// A MOCK :8091 (no real model). Proves the embed-service client is correctly
// adapted to the search embedder contract — including the call-shape bridge
// ({task} object → positional string) whose absence would silently disable
// semantic search even with :8091 up.
function makeEmbedFetch(captured = {}) {
  const json = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });
  const fn = async (url, opts = {}) => {
    if (url.endsWith('/health')) return json({ status: 'ok', model: 'mock', loaded: true, dim: 768 });
    if (url.endsWith('/embed')) {
      captured.body = JSON.parse(opts.body);
      const vec = new Array(768).fill(0); vec[0] = 1; // unit vector
      return json({ embedding: vec, dim: 768, model: 'mock', task: captured.body.task });
    }
    throw new Error(`mock embed-service: unexpected ${url}`);
  };
  fn.captured = captured;
  return fn;
}

async function serviceEmbedderWiring() {
  // E1 — the bridge: embed(text, { task }) must reach the client as a positional
  // string and return a 768-vector. Pre-fix this threw "unknown task {…}".
  {
    const fetch = makeEmbedFetch();
    const emb = createServiceEmbedder({ fetch });
    let vec = null, threw = null;
    try { vec = await emb.embed('hello world', { task: 'query' }); } catch (e) { threw = e; }
    rec('E1. service embedder bridges embed(text,{task}) → 768-vector (no "unknown task")',
      !threw && Array.isArray(vec) && vec.length === 768, threw ? `threw=${threw.message}` : `len=${vec?.length}`);
    rec('E2. the task reaches /embed as the STRING "query" (correct wire format)',
      fetch.captured.body?.task === 'query', `body.task=${JSON.stringify(fetch.captured.body?.task)}`);
  }

  // E3 — satisfies the { embed, health } contract + reports unit:true (L2-normalized).
  {
    const emb = createServiceEmbedder({ fetch: makeEmbedFetch() });
    let ok = true; try { assertEmbedder(emb); } catch { ok = false; }
    rec('E3. service embedder satisfies assertEmbedder + reports unit:true',
      ok && emb.unit === true, `unit=${emb.unit}`);
  }

  // E4 — the exact backend call path: safeEmbed → Float32Array.
  {
    const emb = createServiceEmbedder({ fetch: makeEmbedFetch() });
    const out = await safeEmbed(emb, 'hi', 'query');
    rec('E4. safeEmbed(serviceEmbedder, …) returns a Float32Array (backend call path)',
      out instanceof Float32Array && out.length === 768, `len=${out?.length}`);
  }

  // E5 — end-to-end: a search through searchHelpers with the service embedder up
  // actually embeds the query (semantic path active, not silent BM25 fallback).
  {
    const fetch = makeEmbedFetch();
    const emb = createServiceEmbedder({ fetch });
    const sh = createSearchHelpers({ db: null, embedder: emb });
    for (let i = 0; i < ROWS.length; i++) await sh.indexDocument({ id: ROWS[i].id, text: ROWS[i].content, ts: 1000 + i });
    const hits = await sh.search('forest mycelium roots', { limit: 3 });
    rec('E5. searchHelpers with the service embedder embeds the query (semantic path live)',
      fetch.captured.body?.task === 'query' && Array.isArray(hits) && hits.length > 0,
      `queryEmbedded=${fetch.captured.body?.task === 'query'} hits=${hits?.length}`);
  }

  // E6 — boot resolver: default wires an embedder; opt-out yields null (BM25).
  {
    const def = resolveDefaultEmbedder({ env: {} });
    let ok = true; try { assertEmbedder(def); } catch { ok = false; }
    const off = resolveDefaultEmbedder({ env: { MYCELIUM_DISABLE_EMBED: '1' } });
    rec('E6. resolveDefaultEmbedder: default → valid embedder; MYCELIUM_DISABLE_EMBED=1 → null',
      ok && off === null, `defaultOk=${ok} disabled=${off}`);
  }

  // E7 — health() is coerced to a boolean per the contract (and false on error).
  {
    const up = createServiceEmbedder({ fetch: makeEmbedFetch() });
    const down = createServiceEmbedder({ fetch: async () => { throw new Error('refused'); } });
    const hUp = await up.health(); const hDown = await down.health();
    rec('E7. health() → boolean (true when up, false when :8091 unreachable)',
      hUp === true && hDown === false, `up=${hUp} down=${hDown}`);
  }
}

async function main() {
  console.log('— Layer 1: ported primitives —');
  unitPrimitives();
  console.log('\n— Layer 1: searchHelpers pipeline (stub embedder) —');
  await unitPipeline();
  console.log('\n— Layer 1: bulkSearch grouping against real DB —');
  await bulkSearchDb();
  console.log('\n— Layer 1b: service-embedder wiring (mock :8091) —');
  await serviceEmbedderWiring();
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
