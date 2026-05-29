/**
 * LocalBackend — end-to-end integration test.
 *
 * Runs the real LocalBackend with a deterministic fake embedder that
 * produces topic-clustered vectors. Verifies the full pipeline from
 * add() through query():
 *
 *   tokenize → embed → inverted index update → cosine ANN over cache
 *   → BM25 over inverted index → RRF fusion → temporal boost → topK
 *
 * No mocks at the boundary — real ANN, real BM25, real RRF, real
 * temporal, real probe, real tier orchestrator. Fakes only at the
 * crypto/db boundary that this PR doesn't yet wire (db: not provided,
 * tier 4 unavailable; reranker: not provided, tier 0 == tier 1).
 *
 * Invariants verified:
 *   • Each topic-keyed query returns the topic's docs in the top-3
 *   • Result scores are monotonically non-increasing
 *   • Tier 1 (default), degraded=false when both embed and index are healthy
 *   • Tier 0 with reranker swaps in
 *   • Tier 2 fallback when embedder reports unhealthy
 *   • Recency='recent' shifts ranking toward newer docs
 *   • count(), get(), delete() work end-to-end
 *
 * Run: npm test
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const TEST_MASTER_KEY_HEX = crypto.randomBytes(32).toString('hex');
process.env.ENCRYPTION_MASTER_KEY = TEST_MASTER_KEY_HEX;

const { importMasterKey } = await import('@mycelium/core/crypto-local.js');
const { createMindSearch } = await import('@mycelium/core/mind-search/index.js');

let masterKey;
before(async () => { masterKey = await importMasterKey(TEST_MASTER_KEY_HEX); });

// ── Topic-clustered fake embedder ───────────────────────────────────────
//
// Produces 64-dim unit vectors where each "topic" has a fixed signature
// vector. Same-topic texts are 0.95+ cosine, cross-topic are ~0.0.
// The embedder is deterministic — same text → same vector.

const DIM = 64;
const TOPIC_SIGNATURES = new Map();

function unitFromSeed(seed, dim = DIM) {
  const v = new Float32Array(dim);
  let h = crypto.createHash('sha256').update(seed).digest();
  let off = 0;
  let sum = 0;
  for (let i = 0; i < dim; i++) {
    if (off + 4 > h.length) {
      h = crypto.createHash('sha256').update(h).digest();
      off = 0;
    }
    v[i] = (h.readInt32LE(off) / 0x80000000);
    sum += v[i] * v[i];
    off += 4;
  }
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}

function topicSignature(topic) {
  if (!TOPIC_SIGNATURES.has(topic)) {
    TOPIC_SIGNATURES.set(topic, unitFromSeed(`topic-${topic}`));
  }
  return TOPIC_SIGNATURES.get(topic);
}

/** Detect the topic of a text by checking which topic words it contains. */
function detectTopic(text) {
  const t = text.toLowerCase();
  if (t.includes('mycelium') || t.includes('agent') || t.includes('search')) return 'work';
  if (t.includes('mom')   || t.includes('kids')   || t.includes('dinner')) return 'family';
  if (t.includes('cosine')|| t.includes('encryption') || t.includes('bug')) return 'code';
  if (t.includes('sovereignty') || t.includes('persistence') || t.includes('memory')) return 'philosophy';
  return 'other';
}

function fakeEmbedder({ healthy = true } = {}) {
  let healthFlag = healthy;
  return {
    setHealthy(v) { healthFlag = v; },
    async embed(text) {
      const topic = detectTopic(text);
      const sig = topicSignature(topic);
      // Add tiny per-text jitter so docs aren't all identical, then renormalize.
      const jitter = unitFromSeed(`text-${text}`);
      const out = new Float32Array(DIM);
      let sum = 0;
      for (let i = 0; i < DIM; i++) {
        out[i] = sig[i] * 0.95 + jitter[i] * 0.05;
        sum += out[i] * out[i];
      }
      const n = Math.sqrt(sum) || 1;
      for (let i = 0; i < DIM; i++) out[i] /= n;
      return out;
    },
    async health() { return healthFlag; },
  };
}

// ── Corpus ──────────────────────────────────────────────────────────────

function makeCorpus() {
  const now = 1700000000;
  const day = 86400;
  return [
    // work
    { id: 'w-1', text: 'redesigning the mycelium search stack to remove BGE',                   ts: now - 0  * day, topic: 'work' },
    { id: 'w-2', text: 'agent server health checks under the new tier orchestrator',             ts: now - 1  * day, topic: 'work' },
    { id: 'w-3', text: 'mycelium agents shadow the old search backend during rollout',           ts: now - 2  * day, topic: 'work' },
    // family
    { id: 'f-1', text: 'mom called about the trip in june',                                      ts: now - 3  * day, topic: 'family' },
    { id: 'f-2', text: 'dinner with the kids tonight, made the pasta',                           ts: now - 5  * day, topic: 'family' },
    { id: 'f-3', text: 'planning the summer trip with mom and the kids',                         ts: now - 8  * day, topic: 'family' },
    // code
    { id: 'c-1', text: 'tracked down the encryption envelope bug in the BLOB decoder',           ts: now - 7  * day, topic: 'code' },
    { id: 'c-2', text: 'cosine implementation needs vectorization, the loop is the hot path',    ts: now - 10 * day, topic: 'code' },
    { id: 'c-3', text: 'wrote unit tests for the BM25 scorer, hand-computed regression values',  ts: now - 12 * day, topic: 'code' },
    // philosophy
    { id: 'p-1', text: 'sovereignty is the freedom to say no without being homeless',            ts: now - 15 * day, topic: 'philosophy' },
    { id: 'p-2', text: 'persistence is what makes a system real instead of performative',        ts: now - 20 * day, topic: 'philosophy' },
    { id: 'p-3', text: 'memory without forgetting is hoarding; the question is what to drop',    ts: now - 25 * day, topic: 'philosophy' },
  ];
}

async function buildBackend(opts = {}) {
  const embedder = fakeEmbedder({ healthy: true });
  const backend = createMindSearch({
    embedder,
    masterKey,
    scopes: ['personal'],
    userId: 'integration-user',
    ttlMs: 0, // disable probe cache so health changes propagate immediately
    ...opts,
  });
  for (const doc of makeCorpus()) {
    await backend.add({ id: doc.id, text: doc.text, ts: doc.ts });
  }
  return { backend, embedder };
}

// ── End-to-end retrieval ────────────────────────────────────────────────

describe('LocalBackend — end-to-end retrieval', () => {
  it('topic-keyed queries return the topic\'s docs in top-3', async () => {
    const { backend } = await buildBackend();

    const cases = [
      { query: 'mycelium search agent rollout', expectedPrefix: 'w-' },
      { query: 'mom kids dinner trip',           expectedPrefix: 'f-' },
      { query: 'encryption cosine BM25 bug',     expectedPrefix: 'c-' },
      { query: 'sovereignty persistence memory', expectedPrefix: 'p-' },
    ];

    for (const c of cases) {
      // recency='reflective' isolates the semantic + lexical signal from
      // temporal decay; the corpus uses fixed 2023 timestamps, and the
      // default 'mixed' decay would amplify position differences over the
      // ~3-year delta between corpus-now and wall-clock-now. The temporal
      // pathway is exercised separately by the recency=recent test below.
      const result = await backend.query({
        text: c.query,
        topK: 3,
        recency: 'reflective',
      });
      assert.ok(result.hits.length > 0, `expected hits for query "${c.query}"`);
      const topicHits = result.hits.filter((h) => h.id.startsWith(c.expectedPrefix));
      assert.ok(
        topicHits.length >= 2,
        `expected ≥ 2 ${c.expectedPrefix}* hits in top-3 for "${c.query}", got ${result.hits.map((h) => h.id).join(',')}`,
      );
    }
  });

  it('returns scores in non-increasing order', async () => {
    const { backend } = await buildBackend();
    const result = await backend.query({ text: 'mycelium agent search', topK: 10 });
    for (let i = 1; i < result.hits.length; i++) {
      assert.ok(
        result.hits[i - 1].score >= result.hits[i].score,
        `scores not sorted at i=${i}: ${result.hits[i - 1].score} < ${result.hits[i].score}`,
      );
    }
  });

  it('default precision runs tier 1 with degraded=false', async () => {
    const { backend } = await buildBackend();
    const result = await backend.query({ text: 'mycelium', topK: 5 });
    assert.equal(result.tier, 1);
    assert.equal(result.degraded, false);
    assert.equal(result.reason, undefined);
    assert.ok(typeof result.takenMs === 'number');
  });

  it('precision=high without reranker stays at tier 0 (no degradation)', async () => {
    const { backend } = await buildBackend();
    const result = await backend.query({ text: 'mycelium', topK: 5, precision: 'high' });
    assert.equal(result.tier, 0);
    assert.equal(result.degraded, false);
  });

  it('precision=high with reranker swaps in the rerank step', async () => {
    let reranked = 0;
    const reranker = {
      async rerank(_query, hits) {
        reranked++;
        return [...hits].reverse(); // arbitrary reordering
      },
    };
    const { backend } = await buildBackend({ reranker });
    const before = await backend.query({ text: 'mycelium', topK: 3 });
    const after = await backend.query({ text: 'mycelium', topK: 3, precision: 'high' });
    assert.equal(reranked, 1, 'reranker should be called once');
    assert.equal(after.tier, 0);
    // Different ordering is observable since the reranker reverses
    assert.notDeepEqual(after.hits.map((h) => h.id), before.hits.map((h) => h.id));
  });

  it('falls back to tier 2 when embedder is unhealthy', async () => {
    const { backend, embedder } = await buildBackend();
    embedder.setHealthy(false);
    const result = await backend.query({ text: 'mycelium', topK: 3 });
    assert.equal(result.tier, 2);
    assert.equal(result.degraded, true);
    assert.match(result.reason, /tier_2_below_semantic/);
    // Even degraded, top results should still be relevant via BM25
    const topicHits = result.hits.filter((h) => h.id.startsWith('w-'));
    assert.ok(topicHits.length >= 1, 'BM25 should still find relevant docs');
  });

  it('recency=recent ranks newer docs above older topical matches', async () => {
    // Add a "fresh but unrelated" doc and verify recency=recent boosts it
    // above older topical matches.
    const { backend } = await buildBackend();
    const now = 1700000000;
    const veryFreshTopic = 'work';
    await backend.add({
      id: 'fresh',
      text: 'mycelium agent search refresh',
      ts: now + 60 * 60, // 1h after the corpus's "now"
    });

    const result = await backend.query({
      text: 'mycelium search',
      topK: 5,
      recency: 'recent',
      queryTs: now + 60 * 60,
    });
    assert.equal(result.hits[0].id, 'fresh', `expected 'fresh' top, got ${result.hits[0].id}`);
  });
});

// ── CRUD via MindBackend interface ──────────────────────────────────────

describe('LocalBackend — CRUD operations', () => {
  it('count() reflects added documents', async () => {
    const { backend } = await buildBackend();
    assert.equal(await backend.count(), 12);
  });

  it('get({ ids }) returns metadata for known ids only', async () => {
    const { backend } = await buildBackend();
    const result = await backend.get({ ids: ['w-1', 'f-1', 'does-not-exist'] });
    assert.equal(result.length, 2);
    assert.ok(result.find((r) => r.id === 'w-1'));
    assert.ok(result.find((r) => r.id === 'f-1'));
    assert.ok(result.every((r) => typeof r.ts === 'number'));
  });

  it('delete({ ids }) removes from index AND vector cache', async () => {
    const { backend } = await buildBackend();
    const inner = backend._internal();
    assert.equal(inner.vectors.has('w-1'), true);

    const result = await backend.delete({ ids: ['w-1', 'unknown'] });
    assert.equal(result.deleted, 1);
    assert.equal(inner.vectors.has('w-1'), false);
    assert.equal(inner.index.has('w-1'), false);
    // Subsequent queries don't return deleted doc
    const q = await backend.query({ text: 'mycelium', topK: 5 });
    assert.ok(!q.hits.find((h) => h.id === 'w-1'));
  });

  it('upsert overwrites an existing doc by id', async () => {
    const { backend } = await buildBackend();
    await backend.upsert({
      id: 'w-1',
      text: 'totally different content about mom and kids',
      ts: 1700000000,
    });
    // The vector and tokens should now reflect the new content
    const result = await backend.query({ text: 'mom kids', topK: 5 });
    assert.ok(result.hits.find((h) => h.id === 'w-1'),
      'upserted w-1 should match the new content');
  });

  it('add() rejects malformed input', async () => {
    const { backend } = await buildBackend();
    await assert.rejects(() => backend.add({}), TypeError);
    await assert.rejects(() => backend.add({ id: '' }), TypeError);
    await assert.rejects(() => backend.add({ id: 'x', ts: 'not a number' }), TypeError);
  });
});

// ── Health endpoint ─────────────────────────────────────────────────────

describe('LocalBackend — health()', () => {
  it('reports ok when embed + index are both healthy', async () => {
    const { backend } = await buildBackend();
    const h = await backend.health();
    assert.equal(h.status, 'ok');
    assert.equal(h.embedServiceUp, true);
    assert.equal(h.indexLoaded, true);
    assert.ok(h.indexSize > 0);
  });

  it('reports degraded when embed is down but index is up', async () => {
    const { backend, embedder } = await buildBackend();
    embedder.setHealthy(false);
    const h = await backend.health();
    assert.equal(h.status, 'degraded');
    assert.equal(h.embedServiceUp, false);
    assert.equal(h.indexLoaded, true);
  });

  it('lastQueryAt updates after a query', async () => {
    const { backend } = await buildBackend();
    const before = (await backend.health()).lastQueryAt;
    await backend.query({ text: 'mycelium', topK: 1 });
    const after = (await backend.health()).lastQueryAt;
    assert.ok(after !== null);
    assert.ok(before === null || after >= before);
  });
});
