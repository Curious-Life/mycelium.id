/**
 * tiers.js — orchestrator tests.
 *
 * Covers:
 *   • chooseTier: table-driven mapping from health × precision → tier
 *   • runTiered: runs the chosen tier when healthy
 *   • runTiered: falls through to next tier when chosen tier throws
 *   • runTiered: emits tier_fallback log events on every transition
 *   • runTiered: invalidates probe cache after a tier op throws
 *   • runTiered: never silent-empty — exhaustion throws all_tiers_exhausted
 *   • runTiered: hits=[] is success, not failure
 *   • runTiered: shape (degraded, tier, reason, takenMs)
 *
 * Run: npm test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { chooseTier, runTiered } from '@mycelium/core/mind-search/degrade/tiers.js';
import { MindSearchError, EmbedDownError, IndexUnavailableError } from '@mycelium/core/mind-search/errors.js';

// ── Test fakes ──────────────────────────────────────────────────────────

function fakeProbe(snapshot) {
  let invalidations = 0;
  return {
    async snapshot() { return snapshot; },
    invalidate() { invalidations++; },
    get invalidationCount() { return invalidations; },
  };
}

function captureLogger() {
  const events = [];
  return {
    events,
    debug(rec) { events.push({ level: 'debug', ...rec }); },
    warn(rec)  { events.push({ level: 'warn', ...rec }); },
  };
}

const HEALTHY = { embedHealthy: true, indexLoaded: true, d1Healthy: true };
const EMBED_DOWN = { embedHealthy: false, indexLoaded: true, d1Healthy: true };
const INDEX_DOWN = { embedHealthy: true, indexLoaded: false, d1Healthy: true };
const ALL_DOWN = { embedHealthy: false, indexLoaded: false, d1Healthy: false };

// ── chooseTier — table-driven ──────────────────────────────────────────

describe('chooseTier()', () => {
  it('selects tier 0 only when precision=high AND healthy', () => {
    assert.equal(chooseTier(HEALTHY, { precision: 'high' }), 0);
    assert.equal(chooseTier(HEALTHY, { precision: 'normal' }), 1);
    assert.equal(chooseTier(HEALTHY), 1);
  });

  it('selects tier 2 when embed is down but index loaded', () => {
    assert.equal(chooseTier(EMBED_DOWN), 2);
    assert.equal(chooseTier(EMBED_DOWN, { precision: 'high' }), 2);
  });

  it('selects tier 4 when index is down but D1 is reachable', () => {
    assert.equal(chooseTier(INDEX_DOWN), 4);
  });

  it('selects tier 3 when index marked indexPartial', () => {
    const partial = { embedHealthy: false, indexLoaded: false, indexPartial: true, d1Healthy: true };
    assert.equal(chooseTier(partial), 3);
  });

  it('returns null when nothing is reachable', () => {
    assert.equal(chooseTier(ALL_DOWN), null);
  });

  it('exhaustive table:', () => {
    const cases = [
      [{ embedHealthy: true,  indexLoaded: true,  d1Healthy: true  }, 'normal', 1],
      [{ embedHealthy: true,  indexLoaded: true,  d1Healthy: true  }, 'high',   0],
      [{ embedHealthy: true,  indexLoaded: true,  d1Healthy: false }, 'normal', 1],
      [{ embedHealthy: true,  indexLoaded: false, d1Healthy: true  }, 'normal', 4],
      [{ embedHealthy: false, indexLoaded: true,  d1Healthy: true  }, 'normal', 2],
      [{ embedHealthy: false, indexLoaded: true,  d1Healthy: true  }, 'high',   2],
      [{ embedHealthy: false, indexLoaded: false, d1Healthy: true  }, 'normal', 4],
      [{ embedHealthy: false, indexLoaded: false, d1Healthy: false }, 'normal', null],
    ];
    for (const [health, precision, expected] of cases) {
      const got = chooseTier(health, { precision });
      assert.equal(
        got,
        expected,
        `chooseTier(${JSON.stringify(health)}, ${precision}) → ${got}, expected ${expected}`,
      );
    }
  });
});

// ── runTiered — happy path ─────────────────────────────────────────────

describe('runTiered() — happy path', () => {
  it('runs tier 1 when default precision and all healthy', async () => {
    let calledTier = null;
    const result = await runTiered(
      { text: 'q' },
      {
        tier1: async () => { calledTier = 1; return [{ id: 'a', score: 1 }]; },
        tier2: async () => { calledTier = 2; return []; },
      },
      { probe: fakeProbe(HEALTHY) },
    );
    assert.equal(calledTier, 1);
    assert.equal(result.tier, 1);
    assert.equal(result.degraded, false);
    assert.equal(result.hits.length, 1);
    assert.equal(result.reason, undefined);
    assert.ok(typeof result.takenMs === 'number' && result.takenMs >= 0);
  });

  it('runs tier 0 when precision=high and all healthy', async () => {
    const result = await runTiered(
      { text: 'q', precision: 'high' },
      {
        tier0: async () => [{ id: 'a', score: 1 }, { id: 'b', score: 0.9 }],
        tier1: async () => [],
      },
      { probe: fakeProbe(HEALTHY) },
    );
    assert.equal(result.tier, 0);
    assert.equal(result.degraded, false);
  });

  it('runs tier 2 when embed is down (degraded=true)', async () => {
    const result = await runTiered(
      { text: 'q' },
      {
        tier1: async () => { throw new Error('should not be called'); },
        tier2: async () => [{ id: 'a', score: 1 }],
      },
      { probe: fakeProbe(EMBED_DOWN) },
    );
    assert.equal(result.tier, 2);
    assert.equal(result.degraded, true);
    assert.match(result.reason, /tier_2_below_semantic/);
  });

  it('runs tier 4 when index is down', async () => {
    const result = await runTiered(
      { text: 'q' },
      {
        tier4: async () => [{ id: 'a', score: 0.5 }],
      },
      { probe: fakeProbe(INDEX_DOWN) },
    );
    assert.equal(result.tier, 4);
    assert.equal(result.degraded, true);
  });
});

// ── runTiered — empty hits is NOT failure ──────────────────────────────

describe('runTiered() — empty hits is success, not failure', () => {
  it('tier 1 returning [] returns degraded=false (genuine empty corpus)', async () => {
    const result = await runTiered(
      { text: 'q' },
      { tier1: async () => [] },
      { probe: fakeProbe(HEALTHY) },
    );
    assert.deepEqual(result.hits, []);
    assert.equal(result.tier, 1);
    assert.equal(result.degraded, false);
  });

  it('tier 4 returning [] returns degraded=true with reason', async () => {
    const result = await runTiered(
      { text: 'q' },
      { tier4: async () => [] },
      { probe: fakeProbe(INDEX_DOWN) },
    );
    assert.deepEqual(result.hits, []);
    assert.equal(result.tier, 4);
    assert.equal(result.degraded, true);
  });
});

// ── runTiered — fallback on throw ──────────────────────────────────────

describe('runTiered() — fallback on tier throw', () => {
  it('falls back from tier 1 to tier 2 when tier 1 throws', async () => {
    const log = captureLogger();
    const result = await runTiered(
      { text: 'q' },
      {
        tier1: async () => { throw new EmbedDownError('embed timeout'); },
        tier2: async () => [{ id: 'a', score: 1 }],
      },
      { probe: fakeProbe(HEALTHY), logger: log },
    );
    assert.equal(result.tier, 2);
    assert.equal(result.degraded, true);
    assert.match(result.reason, /fallback_from_tier_1_to_2/);
    // Fallback event was logged
    const fallbackEvents = log.events.filter((e) => e.evt === 'mind_search.tier.fallback');
    assert.equal(fallbackEvents.length, 1);
    assert.equal(fallbackEvents[0].fromTier, 1);
    assert.equal(fallbackEvents[0].errorClass, 'embed_down');
  });

  it('walks down multiple tiers when each throws', async () => {
    const log = captureLogger();
    const result = await runTiered(
      { text: 'q' },
      {
        tier1: async () => { throw new EmbedDownError('embed'); },
        tier2: async () => { throw new IndexUnavailableError('idx'); },
        tier4: async () => [{ id: 'a', score: 0.1 }],
      },
      { probe: fakeProbe(HEALTHY), logger: log },
    );
    assert.equal(result.tier, 4);
    assert.equal(result.degraded, true);
    const fallbacks = log.events.filter((e) => e.evt === 'mind_search.tier.fallback');
    assert.equal(fallbacks.length, 2);
    assert.deepEqual(fallbacks.map((f) => f.fromTier), [1, 2]);
  });

  it('skips tiers without an op when falling back', async () => {
    const result = await runTiered(
      { text: 'q' },
      {
        tier1: async () => { throw new Error('boom'); },
        // no tier2
        // no tier3
        tier4: async () => [{ id: 'a', score: 0.1 }],
      },
      { probe: fakeProbe(HEALTHY) },
    );
    assert.equal(result.tier, 4);
  });

  it('invalidates probe cache after a tier op throws', async () => {
    const probe = fakeProbe(HEALTHY);
    await runTiered(
      { text: 'q' },
      {
        tier1: async () => { throw new EmbedDownError('embed'); },
        tier2: async () => [{ id: 'a', score: 1 }],
      },
      { probe },
    );
    // Once for the failed tier 1 invocation
    assert.equal(probe.invalidationCount, 1);
  });

  it('does not invalidate probe cache on success', async () => {
    const probe = fakeProbe(HEALTHY);
    await runTiered(
      { text: 'q' },
      { tier1: async () => [{ id: 'a', score: 1 }] },
      { probe },
    );
    assert.equal(probe.invalidationCount, 0);
  });
});

// ── runTiered — exhaustion ─────────────────────────────────────────────

describe('runTiered() — never silent empty', () => {
  it('throws all_tiers_exhausted when chooseTier returns null', async () => {
    await assert.rejects(
      () => runTiered({ text: 'q' }, { tier4: async () => [] }, { probe: fakeProbe(ALL_DOWN) }),
      (err) => {
        assert.ok(err instanceof MindSearchError);
        assert.equal(err.class, 'all_tiers_exhausted');
        return true;
      },
    );
  });

  it('throws all_tiers_exhausted when every available tier throws', async () => {
    await assert.rejects(
      () => runTiered(
        { text: 'q' },
        {
          tier1: async () => { throw new Error('a'); },
          tier2: async () => { throw new Error('b'); },
          tier4: async () => { throw new Error('c'); },
        },
        { probe: fakeProbe(HEALTHY) },
      ),
      (err) => {
        assert.ok(err instanceof MindSearchError);
        assert.equal(err.class, 'all_tiers_exhausted');
        // cause chain points at the last error
        assert.ok(err.cause);
        return true;
      },
    );
  });

  it('throws all_tiers_exhausted when no tier op is registered at the chosen tier or below', async () => {
    await assert.rejects(
      () => runTiered({ text: 'q' }, { tier0: async () => [] }, { probe: fakeProbe(HEALTHY) }),
      (err) => err instanceof MindSearchError && err.class === 'all_tiers_exhausted',
    );
  });
});

// ── runTiered — input validation ───────────────────────────────────────

describe('runTiered() — input validation', () => {
  it('throws when ops missing', async () => {
    await assert.rejects(
      () => runTiered({}, null, { probe: fakeProbe(HEALTHY) }),
      TypeError,
    );
  });

  it('throws when probe.snapshot missing', async () => {
    await assert.rejects(
      () => runTiered({}, {}, { probe: { snapshot: 'not-fn' } }),
      TypeError,
    );
  });

  it('throws when tier op returns non-array (contract violation)', async () => {
    await assert.rejects(
      () => runTiered(
        { text: 'q' },
        { tier1: async () => 'not an array' },
        { probe: fakeProbe(HEALTHY) },
      ),
      // tier_contract_violation gets caught by the orchestrator and falls through.
      // With no other tiers, it surfaces as all_tiers_exhausted.
      (err) => err instanceof MindSearchError && err.class === 'all_tiers_exhausted',
    );
  });
});

// ── Result shape contract ───────────────────────────────────────────────

describe('runTiered() — result shape', () => {
  it('always returns { hits, degraded, tier, takenMs, reason? }', async () => {
    const result = await runTiered(
      { text: 'q' },
      { tier1: async () => [{ id: 'a', score: 1 }] },
      { probe: fakeProbe(HEALTHY) },
    );
    assert.ok(Array.isArray(result.hits));
    assert.equal(typeof result.degraded, 'boolean');
    assert.equal(typeof result.tier, 'number');
    assert.equal(typeof result.takenMs, 'number');
  });

  it('reason is present iff degraded is true', async () => {
    const ok = await runTiered(
      { text: 'q' },
      { tier1: async () => [] },
      { probe: fakeProbe(HEALTHY) },
    );
    assert.equal(ok.reason, undefined);

    const degraded = await runTiered(
      { text: 'q' },
      { tier2: async () => [] },
      { probe: fakeProbe(EMBED_DOWN) },
    );
    assert.ok(typeof degraded.reason === 'string' && degraded.reason.length > 0);
  });
});
