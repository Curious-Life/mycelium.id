/**
 * shadow.js — runner tests (runShadow + compareToShadow).
 *
 * Covers:
 *   • runShadow runs both backends concurrently
 *   • runShadow returns metrics with the documented shape
 *   • runShadow throws on either backend failure (caller decides)
 *   • compareToShadow takes a pre-computed primary, runs only shadow
 *   • compareToShadow swallows shadow errors and logs (returns null)
 *   • Logger receives `mind_search.shadow.compare` event
 *   • k defaults to 5 and respects override
 *   • dep validation
 *
 * Run: npm test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  runShadow,
  compareToShadow,
} from '@mycelium/core/mind-search/shadow.js';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ── Test fakes ──────────────────────────────────────────────────────────

function fakeBackend({ hits = [], tier = 1, takenMs = 10, error = null, delay = 0 } = {}) {
  let calls = 0;
  return {
    get callCount() { return calls; },
    async query(_q) {
      calls++;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      if (error) throw error;
      return { hits, tier, takenMs };
    },
  };
}

function captureLogger() {
  const events = [];
  const logger = {
    child: () => logger,
    debug: (rec) => events.push({ level: 'debug', ...rec }),
    info:  (rec) => events.push({ level: 'info',  ...rec }),
    warn:  (rec) => events.push({ level: 'warn',  ...rec }),
    error: (rec) => events.push({ level: 'error', ...rec }),
  };
  logger.events = events;
  return logger;
}

function hits(...ids) {
  return ids.map((id, i) => ({ id, score: 1 - i * 0.1 }));
}

// ── runShadow — happy path ─────────────────────────────────────────────

describe('runShadow() — happy path', () => {
  it('runs both backends concurrently', async () => {
    const primary = fakeBackend({ hits: hits('a', 'b', 'c'), takenMs: 20, delay: 50 });
    const shadow  = fakeBackend({ hits: hits('a', 'b', 'd'), takenMs: 30, delay: 50 });

    const start = Date.now();
    const metrics = await runShadow({ text: 'q' }, { primary, shadow });
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 90, `expected concurrent ~50ms, got ${elapsed}ms (sequential would be ~100ms)`);
    assert.equal(primary.callCount, 1);
    assert.equal(shadow.callCount, 1);
    assert.ok(metrics);
  });

  it('returns metrics with the documented shape', async () => {
    const primary = fakeBackend({ hits: hits('a', 'b', 'c', 'd'), tier: 1, takenMs: 100 });
    const shadow  = fakeBackend({ hits: hits('a', 'b', 'd', 'e'), tier: 2, takenMs: 130 });
    const metrics = await runShadow({ text: 'q' }, { primary, shadow, k: 4 });

    assert.equal(metrics.k, 4);
    assert.equal(typeof metrics.jaccard_at_k, 'number');
    assert.ok(metrics.jaccard_at_k >= 0 && metrics.jaccard_at_k <= 1);
    assert.ok(metrics.spearman === null || (metrics.spearman >= -1 && metrics.spearman <= 1));
    assert.equal(metrics.latency_delta_ms, 30);
    assert.equal(metrics.primary_tier, 1);
    assert.equal(metrics.shadow_tier, 2);
    assert.equal(metrics.primary_hits, 4);
    assert.equal(metrics.shadow_hits, 4);
    assert.equal(typeof metrics.overlap, 'number');
  });

  it('emits info event on the logger', async () => {
    const logger = captureLogger();
    await runShadow(
      { text: 'q' },
      {
        primary: fakeBackend({ hits: hits('a', 'b') }),
        shadow:  fakeBackend({ hits: hits('a', 'c') }),
        logger,
      },
    );
    const compareEvents = logger.events.filter((e) => e.evt === 'mind_search.shadow.compare');
    assert.equal(compareEvents.length, 1);
    assert.equal(compareEvents[0].level, 'info');
    assert.equal(typeof compareEvents[0].jaccard_at_k, 'number');
  });

  it('k defaults to 5 when not specified', async () => {
    const metrics = await runShadow(
      { text: 'q' },
      {
        primary: fakeBackend({ hits: hits('a') }),
        shadow:  fakeBackend({ hits: hits('a') }),
      },
    );
    assert.equal(metrics.k, 5);
  });

  it('honors custom k', async () => {
    // k=2: top-2 of each list
    // Primary: [a, b]; Shadow: [a, c]; intersection: {a}; union: {a,b,c}
    // jaccard@2 = 1/3
    const metrics = await runShadow(
      { text: 'q' },
      {
        primary: fakeBackend({ hits: hits('a', 'b', 'd', 'e') }),
        shadow:  fakeBackend({ hits: hits('a', 'c', 'd', 'e') }),
        k: 2,
      },
    );
    assert.equal(metrics.k, 2);
    assert.ok(close(metrics.jaccard_at_k, 1 / 3),
      `expected 1/3, got ${metrics.jaccard_at_k}`);
  });

  it('handles identical results: jaccard=1, spearman=1, delta=0', async () => {
    const metrics = await runShadow(
      { text: 'q' },
      {
        primary: fakeBackend({ hits: hits('a', 'b', 'c'), takenMs: 50 }),
        shadow:  fakeBackend({ hits: hits('a', 'b', 'c'), takenMs: 50 }),
      },
    );
    assert.equal(metrics.jaccard_at_k, 1);
    assert.equal(metrics.spearman, 1);
    assert.equal(metrics.latency_delta_ms, 0);
    assert.equal(metrics.overlap, 3);
  });

  it('handles disjoint results: jaccard=0, spearman=null', async () => {
    const metrics = await runShadow(
      { text: 'q' },
      {
        primary: fakeBackend({ hits: hits('a', 'b') }),
        shadow:  fakeBackend({ hits: hits('x', 'y') }),
      },
    );
    assert.equal(metrics.jaccard_at_k, 0);
    assert.equal(metrics.spearman, null);
    assert.equal(metrics.overlap, 0);
  });

  it('handles empty primary: jaccard=0 unless shadow also empty', async () => {
    const metrics = await runShadow(
      { text: 'q' },
      {
        primary: fakeBackend({ hits: [] }),
        shadow:  fakeBackend({ hits: hits('a') }),
      },
    );
    assert.equal(metrics.jaccard_at_k, 0);
    assert.equal(metrics.primary_hits, 0);
    assert.equal(metrics.shadow_hits, 1);
  });

  it('handles both empty: jaccard=1 (vacuous match)', async () => {
    const metrics = await runShadow(
      { text: 'q' },
      {
        primary: fakeBackend({ hits: [] }),
        shadow:  fakeBackend({ hits: [] }),
      },
    );
    assert.equal(metrics.jaccard_at_k, 1);
    assert.equal(metrics.spearman, null);
  });
});

// ── runShadow — error propagation ──────────────────────────────────────

describe('runShadow() — backend errors', () => {
  it('throws when primary throws (caller decides)', async () => {
    const err = new Error('primary down');
    await assert.rejects(
      () => runShadow({ text: 'q' }, {
        primary: fakeBackend({ error: err }),
        shadow:  fakeBackend({ hits: hits('a') }),
      }),
      (e) => e === err,
    );
  });

  it('throws when shadow throws', async () => {
    const err = new Error('shadow down');
    await assert.rejects(
      () => runShadow({ text: 'q' }, {
        primary: fakeBackend({ hits: hits('a') }),
        shadow:  fakeBackend({ error: err }),
      }),
      (e) => e === err,
    );
  });
});

// ── compareToShadow — happy path ───────────────────────────────────────

describe('compareToShadow()', () => {
  it('does NOT call primary again — just shadow', async () => {
    const primaryResult = { hits: hits('a', 'b'), tier: 1, takenMs: 50 };
    const shadow = fakeBackend({ hits: hits('a', 'c'), takenMs: 70 });
    const metrics = await compareToShadow({ text: 'q' }, primaryResult, { shadow });
    assert.equal(shadow.callCount, 1);
    assert.equal(metrics.latency_delta_ms, 20);
  });

  it('emits the compare event', async () => {
    const logger = captureLogger();
    await compareToShadow(
      { text: 'q' },
      { hits: hits('a'), tier: 1, takenMs: 10 },
      {
        shadow: fakeBackend({ hits: hits('a'), takenMs: 12 }),
        logger,
      },
    );
    const compareEvents = logger.events.filter((e) => e.evt === 'mind_search.shadow.compare');
    assert.equal(compareEvents.length, 1);
  });

  it('swallows shadow errors and returns null', async () => {
    const logger = captureLogger();
    const result = await compareToShadow(
      { text: 'q' },
      { hits: hits('a') },
      {
        shadow: fakeBackend({ error: Object.assign(new Error('boom'), { class: 'embed_down' }) }),
        logger,
      },
    );
    assert.equal(result, null);
    const errs = logger.events.filter((e) => e.evt === 'mind_search.shadow.error');
    assert.equal(errs.length, 1);
    assert.equal(errs[0].errorClass, 'embed_down');
  });

  it('returns null even when shadow throws plain Error (no class)', async () => {
    const logger = captureLogger();
    const result = await compareToShadow(
      { text: 'q' },
      { hits: hits('a') },
      {
        shadow: fakeBackend({ error: new Error('plain') }),
        logger,
      },
    );
    assert.equal(result, null);
    const errs = logger.events.filter((e) => e.evt === 'mind_search.shadow.error');
    assert.equal(errs[0].errorClass, 'unknown');
  });
});

// ── Dep validation ─────────────────────────────────────────────────────

describe('shadow runners — dep validation', () => {
  it('runShadow rejects missing deps', async () => {
    await assert.rejects(() => runShadow({}, null), TypeError);
    await assert.rejects(() => runShadow({}, {}), TypeError);
    await assert.rejects(() => runShadow({}, { primary: {} }), TypeError);
    await assert.rejects(() => runShadow({}, { primary: fakeBackend(), shadow: {} }), TypeError);
  });

  it('compareToShadow rejects missing shadow', async () => {
    await assert.rejects(
      () => compareToShadow({}, { hits: [] }, null),
      TypeError,
    );
    await assert.rejects(
      () => compareToShadow({}, { hits: [] }, { shadow: {} }),
      TypeError,
    );
  });
});
