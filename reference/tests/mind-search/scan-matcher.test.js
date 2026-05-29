/**
 * Contract tests for createScanMatcher — the brute-force topK helper
 * for small encrypted-vector corpora (territories, realms, themes,
 * documents). Pinning the contract:
 *
 *   - First search() call lazy-loads + decrypts; subsequent calls
 *     reuse the cache (d1Query and decryptVector called once each)
 *   - preload() populates the cache eagerly without an enclosing query
 *   - Per-row decrypt failures count and skip; surviving rows still
 *     usable; cache count does not include failures
 *   - Empty table → empty result, never throws
 *   - topK > cache size returns all available
 *   - Vector dim mismatch rejected (counts as decrypt fail)
 *   - reset() clears cache; next call reloads
 *   - Concurrent first-call requests don't double-load (single in-flight
 *     promise; second caller awaits the first)
 *   - tableName / idColumn validated to a safe identifier shape
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createScanMatcher } from '../../packages/core/mind-search/scan-matcher.js';

// ── Helpers ─────────────────────────────────────────────────────────

function vec768(seed) {
  // L2-normalized 768D vector seeded by `seed` so tests can reason
  // about ordering. Each vec is otherwise distinct.
  const v = new Float32Array(768);
  for (let i = 0; i < 768; i++) v[i] = (seed + i) / 1000;
  let norm = 0;
  for (let i = 0; i < 768; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < 768; i++) v[i] /= norm;
  return v;
}

function makeD1Query(rows) {
  let calls = 0;
  return Object.assign(
    async () => {
      calls += 1;
      return { results: rows };
    },
    { calls: () => calls },
  );
}

function makeDecrypter(envelopeToVec) {
  let calls = 0;
  return Object.assign(
    async (envelope) => {
      calls += 1;
      const v = envelopeToVec(envelope);
      if (v === '__throw') throw new Error('decrypt fail');
      if (v === '__bad-dim') return new Float32Array(512);
      return v;
    },
    { calls: () => calls },
  );
}

// ── Tests ───────────────────────────────────────────────────────────

describe('createScanMatcher — input validation', () => {
  it('rejects bad tableName', () => {
    assert.throws(
      () => createScanMatcher({ tableName: 'foo; DROP TABLE bar', d1Query: () => {}, decryptVector: () => {} }),
      /tableName must match/,
    );
  });
  it('rejects bad idColumn', () => {
    assert.throws(
      () => createScanMatcher({ tableName: 'foo', idColumn: '*; DROP', d1Query: () => {}, decryptVector: () => {} }),
      /idColumn must match/,
    );
  });
  it('rejects missing d1Query', () => {
    assert.throws(
      () => createScanMatcher({ tableName: 'foo', decryptVector: () => {} }),
      /d1Query required/,
    );
  });
  it('rejects missing decryptVector', () => {
    assert.throws(
      () => createScanMatcher({ tableName: 'foo', d1Query: () => {} }),
      /decryptVector required/,
    );
  });
});

describe('createScanMatcher — load + cache', () => {
  it('first search() lazy-loads + decrypts', async () => {
    const d1 = makeD1Query([
      { id: 'a', embedding_768: 'env-a' },
      { id: 'b', embedding_768: 'env-b' },
    ]);
    const dec = makeDecrypter((env) => vec768(env === 'env-a' ? 1 : 2));
    const sm = createScanMatcher({
      tableName: 'territory_profiles',
      d1Query: d1,
      decryptVector: dec,
    });
    const out = await sm.search(vec768(1), 5);
    assert.equal(d1.calls(), 1);
    assert.equal(dec.calls(), 2);
    assert.equal(out.length, 2);
    assert.equal(sm._internal().cacheSize, 2);
  });

  it('second search() reuses cache (no extra d1Query / decrypt)', async () => {
    const d1 = makeD1Query([{ id: 'a', embedding_768: 'env-a' }]);
    const dec = makeDecrypter(() => vec768(1));
    const sm = createScanMatcher({ tableName: 'realms', d1Query: d1, decryptVector: dec });
    await sm.search(vec768(1), 5);
    await sm.search(vec768(2), 5);
    assert.equal(d1.calls(), 1);
    assert.equal(dec.calls(), 1);
  });

  it('preload() populates cache eagerly', async () => {
    const d1 = makeD1Query([{ id: 'a', embedding_768: 'env-a' }]);
    const dec = makeDecrypter(() => vec768(1));
    const sm = createScanMatcher({ tableName: 'documents', d1Query: d1, decryptVector: dec });
    const stats = await sm.preload();
    assert.equal(stats.loaded, 1);
    assert.equal(stats.decryptFailed, 0);
    assert.ok(typeof stats.elapsedMs === 'number');
    assert.equal(sm._internal().loaded, true);
    assert.equal(sm._internal().cacheSize, 1);
  });

  it('reset() clears cache; next call reloads', async () => {
    const d1 = makeD1Query([{ id: 'a', embedding_768: 'env-a' }]);
    const dec = makeDecrypter(() => vec768(1));
    const sm = createScanMatcher({ tableName: 'realms', d1Query: d1, decryptVector: dec });
    await sm.search(vec768(1), 5);
    sm.reset();
    assert.equal(sm._internal().loaded, false);
    await sm.search(vec768(1), 5);
    assert.equal(d1.calls(), 2);
  });

  it('concurrent first calls do not double-load', async () => {
    let resolveD1;
    const d1Promise = new Promise((r) => { resolveD1 = r; });
    let d1Calls = 0;
    const d1 = async () => {
      d1Calls += 1;
      return d1Promise;
    };
    const dec = makeDecrypter(() => vec768(1));
    const sm = createScanMatcher({ tableName: 'realms', d1Query: d1, decryptVector: dec });
    // Fire two parallel searches BEFORE the d1 returns.
    const p1 = sm.search(vec768(1), 5);
    const p2 = sm.search(vec768(1), 5);
    resolveD1({ results: [{ id: 'a', embedding_768: 'env' }] });
    await Promise.all([p1, p2]);
    assert.equal(d1Calls, 1, 'd1Query should fire once even under concurrent first calls');
  });
});

describe('createScanMatcher — failure isolation', () => {
  it('per-row decrypt failure counts and skips; surviving rows usable', async () => {
    const d1 = makeD1Query([
      { id: 'a', embedding_768: 'env-good' },
      { id: 'b', embedding_768: 'env-throw' },
      { id: 'c', embedding_768: 'env-good-2' },
    ]);
    const dec = makeDecrypter((env) => {
      if (env === 'env-throw') return '__throw';
      return vec768(env === 'env-good' ? 1 : 2);
    });
    const sm = createScanMatcher({ tableName: 'realms', d1Query: d1, decryptVector: dec });
    const stats = await sm.preload();
    assert.equal(stats.loaded, 2);
    assert.equal(stats.decryptFailed, 1);
    const out = await sm.search(vec768(1), 5);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((h) => h.id).sort(), ['a', 'c']);
  });

  it('vector dim mismatch counted as decrypt failure', async () => {
    const d1 = makeD1Query([{ id: 'a', embedding_768: 'env-bad' }]);
    const dec = makeDecrypter(() => '__bad-dim');
    const sm = createScanMatcher({ tableName: 'realms', d1Query: d1, decryptVector: dec });
    const stats = await sm.preload();
    assert.equal(stats.loaded, 0);
    assert.equal(stats.decryptFailed, 1);
  });

  it('all rows fail → empty result, no throw', async () => {
    const d1 = makeD1Query([{ id: 'a', embedding_768: 'env-bad' }]);
    const dec = makeDecrypter(() => '__throw');
    const sm = createScanMatcher({ tableName: 'realms', d1Query: d1, decryptVector: dec });
    const out = await sm.search(vec768(1), 5);
    assert.deepEqual(out, []);
  });

  it('d1Query throw → search returns [] without bubbling', async () => {
    const sm = createScanMatcher({
      tableName: 'realms',
      d1Query: async () => { throw new Error('D1 down'); },
      decryptVector: async () => vec768(1),
    });
    const out = await sm.search(vec768(1), 5);
    assert.deepEqual(out, []);
  });

  it('skips rows with non-string id or embedding', async () => {
    const d1 = makeD1Query([
      { id: null, embedding_768: 'env' },
      { id: 'a', embedding_768: null },
      { id: 'b', embedding_768: 'env-good' },
    ]);
    const dec = makeDecrypter(() => vec768(1));
    const sm = createScanMatcher({ tableName: 'realms', d1Query: d1, decryptVector: dec });
    const stats = await sm.preload();
    assert.equal(stats.loaded, 1);
  });
});

describe('createScanMatcher — search semantics', () => {
  it('returns at most topK results', async () => {
    const rows = [];
    for (let i = 0; i < 10; i++) rows.push({ id: `m${i}`, embedding_768: `env${i}` });
    const d1 = makeD1Query(rows);
    const dec = makeDecrypter((env) => vec768(parseInt(env.replace('env', ''), 10)));
    const sm = createScanMatcher({ tableName: 'realms', d1Query: d1, decryptVector: dec });
    const out = await sm.search(vec768(0), 3);
    assert.equal(out.length, 3);
  });

  it('topK greater than cache size returns all', async () => {
    const d1 = makeD1Query([
      { id: 'a', embedding_768: 'env-1' },
      { id: 'b', embedding_768: 'env-2' },
    ]);
    const dec = makeDecrypter((env) => vec768(env === 'env-1' ? 1 : 2));
    const sm = createScanMatcher({ tableName: 'realms', d1Query: d1, decryptVector: dec });
    const out = await sm.search(vec768(1), 100);
    assert.equal(out.length, 2);
  });

  it('returns Vectorize-shape hits ({id, score})', async () => {
    const d1 = makeD1Query([{ id: 'm1', embedding_768: 'env' }]);
    const dec = makeDecrypter(() => vec768(1));
    const sm = createScanMatcher({ tableName: 'realms', d1Query: d1, decryptVector: dec });
    const out = await sm.search(vec768(1), 5);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'm1');
    assert.equal(typeof out[0].score, 'number');
  });

  it('search ranks identical query vector first', async () => {
    const target = vec768(42);
    const other = vec768(1);
    const d1 = makeD1Query([
      { id: 'far', embedding_768: 'env-other' },
      { id: 'near', embedding_768: 'env-target' },
    ]);
    const dec = makeDecrypter((env) => env === 'env-target' ? target : other);
    const sm = createScanMatcher({ tableName: 'realms', d1Query: d1, decryptVector: dec });
    const out = await sm.search(target, 2);
    assert.equal(out[0].id, 'near');
  });

  it('empty table → empty result', async () => {
    const d1 = makeD1Query([]);
    const dec = makeDecrypter(() => vec768(1));
    const sm = createScanMatcher({ tableName: 'realms', d1Query: d1, decryptVector: dec });
    const out = await sm.search(vec768(1), 5);
    assert.deepEqual(out, []);
  });
});
