/**
 * probe.js — health-probe tests.
 *
 * Covers:
 *   • dep validation
 *   • each probe returns the expected boolean from its dep
 *   • TTL caching: repeated calls within ttlMs reuse cached value
 *   • TTL expiration: after ttlMs, re-probe
 *   • timeout: hung probe times out and reports unhealthy
 *   • invalidate(): drops cached entries by name or all
 *   • snapshot() shape
 *
 * Run: npm test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createHealthProbe } from '@mycelium/core/mind-search/degrade/probe.js';

// ── Test fakes ──────────────────────────────────────────────────────────

function fakeEmbedder({ healthy = true, delayMs = 0, throws = false } = {}) {
  let calls = 0;
  return {
    get callCount() { return calls; },
    async health() {
      calls++;
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      if (throws) throw new Error('embed-service down');
      return healthy;
    },
  };
}

function fakeIndex({ docs = 0 } = {}) {
  return {
    totalDocs() { return docs; },
  };
}

function fakeDb({ healthy = true, delayMs = 0, throws = false } = {}) {
  let calls = 0;
  return {
    get callCount() { return calls; },
    async ping() {
      calls++;
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      if (throws) throw new Error('d1 timeout');
      return healthy;
    },
  };
}

// ── Constructor / dep validation ───────────────────────────────────────

describe('createHealthProbe — dep validation', () => {
  it('throws when deps missing', () => {
    assert.throws(() => createHealthProbe(), TypeError);
    assert.throws(() => createHealthProbe(null), TypeError);
  });

  it('throws when embedder.health is not a function', () => {
    assert.throws(
      () => createHealthProbe({ embedder: {}, getIndex: () => null }),
      /embedder\.health/,
    );
  });

  it('throws when getIndex is not a function', () => {
    assert.throws(
      () => createHealthProbe({ embedder: fakeEmbedder(), getIndex: 'oops' }),
      /getIndex must be a function/,
    );
  });

  it('throws on negative ttlMs', () => {
    assert.throws(
      () => createHealthProbe({
        embedder: fakeEmbedder(),
        getIndex: () => null,
        ttlMs: -1,
      }),
      TypeError,
    );
  });
});

// ── Basic probe behavior ───────────────────────────────────────────────

describe('embedHealthy()', () => {
  it('returns true when embedder.health resolves true', async () => {
    const p = createHealthProbe({
      embedder: fakeEmbedder({ healthy: true }),
      getIndex: () => null,
    });
    assert.equal(await p.embedHealthy(), true);
  });

  it('returns false when embedder.health resolves false', async () => {
    const p = createHealthProbe({
      embedder: fakeEmbedder({ healthy: false }),
      getIndex: () => null,
    });
    assert.equal(await p.embedHealthy(), false);
  });

  it('returns false when embedder.health throws', async () => {
    const p = createHealthProbe({
      embedder: fakeEmbedder({ throws: true }),
      getIndex: () => null,
    });
    assert.equal(await p.embedHealthy(), false);
  });

  it('returns false when embedder.health hangs past timeout', async () => {
    const p = createHealthProbe({
      embedder: fakeEmbedder({ delayMs: 200 }),
      getIndex: () => null,
      embedTimeoutMs: 30,
    });
    const start = Date.now();
    const result = await p.embedHealthy();
    const elapsed = Date.now() - start;
    assert.equal(result, false);
    assert.ok(elapsed < 100, `expected timeout to fire fast, took ${elapsed} ms`);
  });
});

describe('indexLoaded()', () => {
  it('false for null index', async () => {
    const p = createHealthProbe({
      embedder: fakeEmbedder(),
      getIndex: () => null,
    });
    assert.equal(await p.indexLoaded(), false);
  });

  it('false for empty index', async () => {
    const p = createHealthProbe({
      embedder: fakeEmbedder(),
      getIndex: () => fakeIndex({ docs: 0 }),
    });
    assert.equal(await p.indexLoaded(), false);
  });

  it('true for index with documents', async () => {
    const p = createHealthProbe({
      embedder: fakeEmbedder(),
      getIndex: () => fakeIndex({ docs: 1 }),
    });
    assert.equal(await p.indexLoaded(), true);
  });

  it('reads via getIndex() each time (sees swapped index after invalidate)', async () => {
    let docs = 0;
    const p = createHealthProbe({
      embedder: fakeEmbedder(),
      getIndex: () => fakeIndex({ docs }),
      ttlMs: 0, // disable cache for this test
    });
    assert.equal(await p.indexLoaded(), false);
    docs = 5;
    assert.equal(await p.indexLoaded(), true);
  });
});

describe('d1Healthy()', () => {
  it('true when no db provided (assume healthy)', async () => {
    const p = createHealthProbe({
      embedder: fakeEmbedder(),
      getIndex: () => null,
    });
    assert.equal(await p.d1Healthy(), true);
  });

  it('true when db provided without ping (assume healthy)', async () => {
    const p = createHealthProbe({
      embedder: fakeEmbedder(),
      getIndex: () => null,
      db: {},
    });
    assert.equal(await p.d1Healthy(), true);
  });

  it('reflects db.ping result when present', async () => {
    const p1 = createHealthProbe({
      embedder: fakeEmbedder(),
      getIndex: () => null,
      db: fakeDb({ healthy: true }),
    });
    assert.equal(await p1.d1Healthy(), true);

    const p2 = createHealthProbe({
      embedder: fakeEmbedder(),
      getIndex: () => null,
      db: fakeDb({ healthy: false }),
    });
    assert.equal(await p2.d1Healthy(), false);
  });

  it('false when db.ping throws', async () => {
    const p = createHealthProbe({
      embedder: fakeEmbedder(),
      getIndex: () => null,
      db: fakeDb({ throws: true }),
    });
    assert.equal(await p.d1Healthy(), false);
  });

  it('false on db.ping timeout', async () => {
    const p = createHealthProbe({
      embedder: fakeEmbedder(),
      getIndex: () => null,
      db: fakeDb({ delayMs: 200 }),
      d1TimeoutMs: 30,
    });
    assert.equal(await p.d1Healthy(), false);
  });
});

// ── TTL caching ─────────────────────────────────────────────────────────

describe('TTL caching', () => {
  it('repeated calls within ttlMs reuse cached value', async () => {
    const e = fakeEmbedder();
    const p = createHealthProbe({
      embedder: e,
      getIndex: () => null,
      ttlMs: 100,
    });
    await p.embedHealthy();
    await p.embedHealthy();
    await p.embedHealthy();
    assert.equal(e.callCount, 1, 'embedder.health should be called only once within ttl');
  });

  it('after ttlMs expires, re-probe', async () => {
    const e = fakeEmbedder();
    const p = createHealthProbe({
      embedder: e,
      getIndex: () => null,
      ttlMs: 20,
    });
    await p.embedHealthy();
    await new Promise((r) => setTimeout(r, 30));
    await p.embedHealthy();
    assert.equal(e.callCount, 2);
  });

  it('different probes are cached independently', async () => {
    const e = fakeEmbedder();
    const d = fakeDb({ healthy: true });
    const p = createHealthProbe({
      embedder: e,
      getIndex: () => fakeIndex({ docs: 1 }),
      db: d,
      ttlMs: 100,
    });
    await p.snapshot();
    await p.snapshot();
    assert.equal(e.callCount, 1);
    assert.equal(d.callCount, 1);
  });
});

// ── invalidate() ────────────────────────────────────────────────────────

describe('invalidate()', () => {
  it('invalidate(name) drops only that probe', async () => {
    const e = fakeEmbedder();
    const d = fakeDb({ healthy: true });
    const p = createHealthProbe({
      embedder: e,
      getIndex: () => fakeIndex({ docs: 1 }),
      db: d,
      ttlMs: 1000,
    });
    await p.snapshot();
    p.invalidate('embed');
    await p.snapshot();
    assert.equal(e.callCount, 2, 'embed should re-probe');
    assert.equal(d.callCount, 1, 'd1 should still be cached');
  });

  it('invalidate() (no arg) drops everything', async () => {
    const e = fakeEmbedder();
    const d = fakeDb({ healthy: true });
    const p = createHealthProbe({
      embedder: e,
      getIndex: () => fakeIndex({ docs: 1 }),
      db: d,
      ttlMs: 1000,
    });
    await p.snapshot();
    p.invalidate();
    await p.snapshot();
    assert.equal(e.callCount, 2);
    assert.equal(d.callCount, 2);
  });
});

// ── snapshot() shape ────────────────────────────────────────────────────

describe('snapshot()', () => {
  it('returns all expected fields', async () => {
    const p = createHealthProbe({
      embedder: fakeEmbedder({ healthy: true }),
      getIndex: () => fakeIndex({ docs: 5 }),
      db: fakeDb({ healthy: true }),
    });
    const snap = await p.snapshot();
    assert.equal(snap.embedHealthy, true);
    assert.equal(snap.indexLoaded, true);
    assert.equal(snap.d1Healthy, true);
    assert.ok(typeof snap.observedAt === 'number');
    assert.ok(snap.observedAt > 0);
  });

  it('reflects partial degradation correctly', async () => {
    const p = createHealthProbe({
      embedder: fakeEmbedder({ healthy: false }),
      getIndex: () => fakeIndex({ docs: 5 }),
      db: fakeDb({ healthy: true }),
    });
    const snap = await p.snapshot();
    assert.equal(snap.embedHealthy, false);
    assert.equal(snap.indexLoaded, true);
    assert.equal(snap.d1Healthy, true);
  });

  it('parallelizes the three probes (faster than sequential)', async () => {
    const p = createHealthProbe({
      embedder: fakeEmbedder({ delayMs: 30 }),
      getIndex: () => null,
      db: fakeDb({ delayMs: 30 }),
      ttlMs: 0, // force re-probe
    });
    const start = Date.now();
    await p.snapshot();
    const elapsed = Date.now() - start;
    // Sequential would be ~60 ms; parallel should be ~30 ms.
    assert.ok(elapsed < 50, `expected parallel < 50 ms, got ${elapsed} ms`);
  });
});
