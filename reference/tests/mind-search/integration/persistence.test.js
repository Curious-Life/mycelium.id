/**
 * LocalBackend — checkpoint/restore integration.
 *
 * The boot-time fix: an agent that has restarted should be able to
 * load its previous state from disk and serve queries without rebuilding
 * from D1.
 *
 * Tests:
 *   • Checkpoint + restart → BM25 query results are byte-identical
 *   • Checkpoint + restart → tier 2 (BM25 + temporal) works without
 *     re-embedding (because vectors are NOT in the snapshot but the
 *     inverted index IS)
 *   • Checkpoint reports byte count
 *   • init() with no snapshot → empty backend, no error
 *   • init() with corrupt snapshot → empty backend, error logged, no crash
 *   • Subsequent checkpoint after restore continues to work
 *
 * Note: the snapshot persists ONLY the inverted index. The vector cache
 * is not persisted in PR 8 (would balloon the snapshot to ~hundreds of
 * MB at scale; the embed-service can re-embed if asked). Tier 1 queries
 * after a fresh restart will need to either re-embed everything OR
 * fall through to tier 2 until the cache warms. Both behaviors are
 * acceptable and tested here.
 *
 * Run: npm test
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const TEST_MASTER_KEY_HEX = crypto.randomBytes(32).toString('hex');
process.env.ENCRYPTION_MASTER_KEY = TEST_MASTER_KEY_HEX;

const { importMasterKey } = await import('@mycelium/core/crypto-local.js');
const { createMindSearch } = await import('@mycelium/core/mind-search/index.js');

let masterKey;
let tmpDir;

before(async () => {
  masterKey = await importMasterKey(TEST_MASTER_KEY_HEX);
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-search-persist-'));
});

after(async () => {
  if (tmpDir) {
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function newPath(prefix = 'snap') {
  return path.join(tmpDir, `${prefix}-${crypto.randomBytes(4).toString('hex')}.bin`);
}

function fakeEmbedder() {
  return {
    async embed(text) {
      const v = new Float32Array(32);
      const h = crypto.createHash('sha256').update(text).digest();
      let sum = 0;
      for (let i = 0; i < 32; i++) {
        v[i] = (h[i] / 255) * 2 - 1;
        sum += v[i] * v[i];
      }
      const n = Math.sqrt(sum) || 1;
      for (let i = 0; i < 32; i++) v[i] /= n;
      return v;
    },
    async health() { return true; },
  };
}

function makeCorpus() {
  return [
    { id: 'doc-1', text: 'mycelium agent search rollout',                 ts: 1700000000 },
    { id: 'doc-2', text: 'inverted index BM25 scorer with IDF cache',     ts: 1700001000 },
    { id: 'doc-3', text: 'encryption envelope and atomic write',          ts: 1700002000 },
    { id: 'doc-4', text: 'temporal proximity boost in result fusion',     ts: 1700003000 },
    { id: 'doc-5', text: 'tier orchestrator with graceful degradation',   ts: 1700004000 },
    { id: 'doc-6', text: 'mom and the kids and the summer trip',          ts: 1700005000 },
    { id: 'doc-7', text: 'sovereignty persistence and the cognitive vault', ts: 1700006000 },
  ];
}

async function buildBackend({ persistPath, scopes = ['personal'] } = {}) {
  return createMindSearch({
    embedder: fakeEmbedder(),
    masterKey,
    scopes,
    userId: 'persist-user',
    persistPath,
    ttlMs: 0,
  });
}

async function populate(backend) {
  for (const doc of makeCorpus()) {
    await backend.add({ id: doc.id, text: doc.text, ts: doc.ts });
  }
}

// ── Round-trip ─────────────────────────────────────────────────────────

describe('LocalBackend — checkpoint + restore', () => {
  it('after checkpoint + restart, BM25 query results round-trip', async () => {
    const filepath = newPath('roundtrip');

    // The snapshot persists ONLY the inverted index. The vector cache is
    // not in the file. So the *invariant* we test is:
    //
    //   tier 2 (BM25 only) before checkpoint
    //   ===
    //   tier 2 (BM25 only) after checkpoint + restore
    //
    // Comparing tier 1 to tier 1 across the boundary would conflate the
    // missing vector cache with any actual snapshot bug.

    // Phase 1: populate and checkpoint
    const original = await buildBackend({ persistPath: filepath });
    await populate(original);

    // Force tier 2 by making the embedder unhealthy on the original
    const downEmbedder = {
      async embed() { throw new Error('embed offline'); },
      async health() { return false; },
    };
    const tier2Original = createMindSearch({
      embedder: downEmbedder,
      masterKey,
      scopes: ['personal'],
      userId: 'persist-user',
      ttlMs: 0,
    });
    // Re-populate against this backend so we have an apples-to-apples view.
    await populate(tier2Original);
    const before = await tier2Original.query({
      text: 'mycelium agent rollout',
      topK: 5,
      recency: 'reflective',
    });
    assert.equal(before.tier, 2);

    const checkpointResult = await original.checkpoint();
    assert.equal(checkpointResult.saved, true);
    assert.ok(checkpointResult.bytes > 0, 'checkpoint must report bytes written');

    // Phase 2: simulate restart — fresh backend, init from snapshot,
    // then force tier 2 to compare apples-to-apples.
    const restored = createMindSearch({
      embedder: downEmbedder,
      masterKey,
      scopes: ['personal'],
      userId: 'persist-user',
      persistPath: filepath,
      ttlMs: 0,
    });
    const initResult = await restored.init();
    assert.equal(initResult.loaded, true);
    assert.equal(await restored.count(), 7);

    const after = await restored.query({
      text: 'mycelium agent rollout',
      topK: 5,
      recency: 'reflective',
    });
    assert.equal(after.tier, 2);

    // BM25-only result IDs must round-trip identically
    assert.deepEqual(
      after.hits.map((h) => h.id),
      before.hits.map((h) => h.id),
    );
    // And so must the scores (BM25 + temporal are deterministic)
    for (let i = 0; i < before.hits.length; i++) {
      assert.ok(
        Math.abs(after.hits[i].score - before.hits[i].score) < 1e-9,
        `score mismatch at i=${i}: ${after.hits[i].score} vs ${before.hits[i].score}`,
      );
    }
  });

  it('without checkpoint, restart yields empty backend', async () => {
    const filepath = newPath('no-checkpoint');
    const populated = await buildBackend({ persistPath: filepath });
    await populate(populated);
    // Don't call checkpoint!

    const restored = await buildBackend({ persistPath: filepath });
    const initResult = await restored.init();
    assert.equal(initResult.loaded, false);
    assert.equal(await restored.count(), 0);
  });

  it('checkpoint + restart preserves count() and metadata access', async () => {
    const filepath = newPath('crud');
    const original = await buildBackend({ persistPath: filepath });
    await populate(original);
    await original.checkpoint();

    const restored = await buildBackend({ persistPath: filepath });
    await restored.init();

    assert.equal(await restored.count(), 7);

    // Document metadata reachable via get()
    const meta = await restored.get({ ids: ['doc-1', 'doc-7'] });
    assert.equal(meta.length, 2);
    assert.equal(meta[0].ts, 1700000000);
    assert.equal(meta[1].ts, 1700006000);
  });

  it('subsequent checkpoint after restore continues to work', async () => {
    const filepath = newPath('rolling');
    const a = await buildBackend({ persistPath: filepath });
    await populate(a);
    await a.checkpoint();

    const b = await buildBackend({ persistPath: filepath });
    await b.init();
    await b.add({ id: 'doc-8', text: 'added after restore', ts: 1700010000 });
    const second = await b.checkpoint();
    assert.equal(second.saved, true);

    const c = await buildBackend({ persistPath: filepath });
    await c.init();
    assert.equal(await c.count(), 8);
    assert.ok((await c.get({ ids: ['doc-8'] })).length === 1);
  });
});

// ── Failure modes ──────────────────────────────────────────────────────

describe('LocalBackend — init() failure handling', () => {
  it('no snapshot file → init() returns { loaded: false }, no throw', async () => {
    const filepath = newPath('does-not-exist');
    const backend = await buildBackend({ persistPath: filepath });
    const result = await backend.init();
    assert.equal(result.loaded, false);
    assert.equal(await backend.count(), 0);
  });

  it('no persistPath → init() returns { loaded: false }', async () => {
    const backend = await buildBackend(); // no persistPath
    const result = await backend.init();
    assert.equal(result.loaded, false);
  });

  it('corrupt snapshot → init() returns { loaded: false } and logs', async () => {
    const filepath = newPath('corrupt');
    await fs.writeFile(filepath, Buffer.from('not a valid mind-search snapshot'));

    const events = [];
    const logger = {
      child: () => logger,
      debug: (r) => events.push({ level: 'debug', ...r }),
      info:  (r) => events.push({ level: 'info',  ...r }),
      warn:  (r) => events.push({ level: 'warn',  ...r }),
      error: (r) => events.push({ level: 'error', ...r }),
    };
    const backend = createMindSearch({
      embedder: fakeEmbedder(),
      masterKey,
      scopes: ['personal'],
      userId: 'corrupt-test',
      persistPath: filepath,
      logger,
      ttlMs: 0,
    });
    const result = await backend.init();
    assert.equal(result.loaded, false);
    // Backend remains usable
    assert.equal(await backend.count(), 0);

    // The failure was logged with the typed error class, not silently swallowed
    const failures = events.filter((e) => e.evt === 'mind_search.init.snapshot_failed');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].errorClass, 'index_unavailable');
  });
});

// ── Cold-start tier behavior ────────────────────────────────────────────

describe('LocalBackend — cold-start query behavior after restore', () => {
  it('tier 1 still selected post-restore (vectors empty, ANN returns nothing, RRF degenerates to BM25 order)', async () => {
    const filepath = newPath('cold');
    const original = await buildBackend({ persistPath: filepath });
    await populate(original);
    await original.checkpoint();

    const restored = await buildBackend({ persistPath: filepath });
    await restored.init();

    const result = await restored.query({
      text: 'mycelium agent',
      topK: 3,
      recency: 'reflective',
    });
    // Tier 1 was selected (embed and index both healthy from probe's view).
    // The result should still be useful: BM25 alone produces the right ranking.
    assert.equal(result.tier, 1);
    assert.ok(result.hits.length > 0);
    assert.ok(result.hits.find((h) => h.id === 'doc-1'),
      'BM25 should match doc-1 ("mycelium agent search rollout")');
  });

  it('tier 2 queries (when forced by embedder failure) work post-restore', async () => {
    const filepath = newPath('cold-tier2');
    const original = await buildBackend({ persistPath: filepath });
    await populate(original);
    await original.checkpoint();

    // Restored backend with an unhealthy embedder
    const downEmbedder = {
      async embed() { throw new Error('embed-service down'); },
      async health() { return false; },
    };
    const restored = createMindSearch({
      embedder: downEmbedder,
      masterKey,
      scopes: ['personal'],
      userId: 'persist-user',
      persistPath: filepath,
      ttlMs: 0,
    });
    await restored.init();

    const result = await restored.query({
      text: 'mycelium agent rollout',
      topK: 3,
      recency: 'reflective',
    });
    assert.equal(result.tier, 2);
    assert.equal(result.degraded, true);
    assert.ok(result.hits.find((h) => h.id === 'doc-1'));
  });
});
