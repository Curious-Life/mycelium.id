/**
 * temporal.js — temporal-proximity boost tests.
 *
 * Properties:
 *   • Δt = 0 → boost = 1 → score unchanged
 *   • monotonically non-increasing in Δt
 *   • Δt < 0 (future ts) → boost = 1 (clamped, no amplification)
 *   • recency='reflective' (τ=∞) → identity
 *   • output is finite (no NaN, no Infinity)
 *   • length and id-set preserved
 *
 * Run: npm test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  temporalBoost,
  temporalBoostWithProvider,
  RECENCY_TAU,
} from '@mycelium/core/mind-search/fusion/temporal.js';
import { forAll, gen } from '../../util/property.js';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ── Constants ──────────────────────────────────────────────────────────

describe('RECENCY_TAU', () => {
  it('exposes the documented values', () => {
    assert.equal(RECENCY_TAU.recent,     6 * 3600);
    assert.equal(RECENCY_TAU.mixed,      7 * 24 * 3600);
    assert.equal(RECENCY_TAU.reflective, Infinity);
  });

  it('is frozen (immutable)', () => {
    assert.ok(Object.isFrozen(RECENCY_TAU));
  });
});

// ── Input validation ───────────────────────────────────────────────────

describe('temporalBoost() — input validation', () => {
  it('throws when results is not an array', () => {
    assert.throws(() => temporalBoost(null), TypeError);
    assert.throws(() => temporalBoost('foo'), TypeError);
  });

  it('throws on unknown recency value', () => {
    assert.throws(() => temporalBoost([], { recency: 'urgent' }), /unknown recency/);
    assert.throws(() => temporalBoost([], { recency: '' }), /unknown recency/);
  });

  it('throws on invalid tau override', () => {
    assert.throws(() => temporalBoost([], { tau: 0 }), TypeError);
    assert.throws(() => temporalBoost([], { tau: -1 }), TypeError);
    assert.throws(() => temporalBoost([], { tau: 'fast' }), TypeError);
  });

  it('throws on non-finite queryTs', () => {
    assert.throws(() => temporalBoost([], { queryTs: NaN }), TypeError);
    assert.throws(() => temporalBoost([], { queryTs: Infinity }), TypeError);
    assert.throws(() => temporalBoost([], { queryTs: 'now' }), TypeError);
  });

  it('throws on result missing id', () => {
    assert.throws(
      () => temporalBoost([{ score: 1, ts: 0 }], { queryTs: 0 }),
      /must be an object with string id/,
    );
  });
});

// ── Edge / shape ────────────────────────────────────────────────────────

describe('temporalBoost() — edge cases and shape', () => {
  it('empty input returns empty output', () => {
    assert.deepEqual(temporalBoost([]), []);
  });

  it('does not mutate input', () => {
    const input = [{ id: 'a', score: 1, ts: 1000 }];
    const before = JSON.stringify(input);
    temporalBoost(input, { queryTs: 1000 });
    assert.equal(JSON.stringify(input), before);
  });

  it('preserves length and id set', () => {
    const input = [
      { id: 'a', score: 1.0, ts: 1000 },
      { id: 'b', score: 0.5, ts: 1000 },
      { id: 'c', score: 0.1, ts: 1000 },
    ];
    const out = temporalBoost(input, { queryTs: 1000 });
    assert.equal(out.length, input.length);
    const inputIds = new Set(input.map((r) => r.id));
    const outputIds = new Set(out.map((r) => r.id));
    assert.deepEqual([...outputIds].sort(), [...inputIds].sort());
  });

  it('preserves extra fields on each item', () => {
    const out = temporalBoost(
      [{ id: 'a', score: 1, ts: 1000, sources: [0, 1], custom: 42 }],
      { queryTs: 1000 },
    );
    assert.deepEqual(out[0].sources, [0, 1]);
    assert.equal(out[0].custom, 42);
  });

  it('items without ts pass through unboosted', () => {
    const out = temporalBoost(
      [{ id: 'a', score: 0.7 }],
      { queryTs: 999_999_999, recency: 'recent' },
    );
    assert.equal(out[0].score, 0.7);
  });
});

// ── Behavior at known time deltas ──────────────────────────────────────

describe('temporalBoost() — known multipliers', () => {
  it('Δt = 0 → boost = 1 → score unchanged', () => {
    const out = temporalBoost(
      [{ id: 'a', score: 0.5, ts: 1000 }],
      { queryTs: 1000, recency: 'recent' },
    );
    assert.ok(close(out[0].score, 0.5));
  });

  it('Δt = τ → boost = 1/e ≈ 0.3679', () => {
    const out = temporalBoost(
      [{ id: 'a', score: 1, ts: 0 }],
      { queryTs: RECENCY_TAU.recent, recency: 'recent' },
    );
    assert.ok(close(out[0].score, Math.exp(-1)));
  });

  it('Δt = 2τ → boost = 1/e² ≈ 0.1353', () => {
    const out = temporalBoost(
      [{ id: 'a', score: 1, ts: 0 }],
      { queryTs: 2 * RECENCY_TAU.recent, recency: 'recent' },
    );
    assert.ok(close(out[0].score, Math.exp(-2)));
  });

  it("'mixed' produces gentler decay than 'recent'", () => {
    const dt = 24 * 3600; // 1 day
    const r = temporalBoost([{ id: 'a', score: 1, ts: 0 }], { queryTs: dt, recency: 'recent' });
    const m = temporalBoost([{ id: 'a', score: 1, ts: 0 }], { queryTs: dt, recency: 'mixed' });
    assert.ok(m[0].score > r[0].score, "'mixed' boost should exceed 'recent' boost at same Δt");
  });
});

// ── Reflective is identity ─────────────────────────────────────────────

describe("temporalBoost() — recency='reflective'", () => {
  it('returns identical scores regardless of age', () => {
    const ancient = { id: 'a', score: 0.5, ts: 0 };
    const recent  = { id: 'b', score: 0.7, ts: 1_700_000_000 };
    const out = temporalBoost([ancient, recent], {
      queryTs: 1_700_000_000,
      recency: 'reflective',
    });
    const a = out.find((h) => h.id === 'a');
    const b = out.find((h) => h.id === 'b');
    assert.equal(a.score, 0.5);
    assert.equal(b.score, 0.7);
  });

  it('preserves ts field', () => {
    const out = temporalBoost(
      [{ id: 'a', score: 1, ts: 1234 }],
      { recency: 'reflective' },
    );
    assert.equal(out[0].ts, 1234);
  });
});

// ── Future timestamps clamped ──────────────────────────────────────────

describe('temporalBoost() — future timestamps', () => {
  it('Δt < 0 (item from "future") clamps to boost = 1', () => {
    const out = temporalBoost(
      [{ id: 'a', score: 0.5, ts: 2000 }],
      { queryTs: 1000, recency: 'recent' },
    );
    assert.equal(out[0].score, 0.5);
  });

  it('extreme future timestamp does not produce > 1 boost', () => {
    const out = temporalBoost(
      [{ id: 'a', score: 0.5, ts: 1e18 }], // very far in the future
      { queryTs: 1000, recency: 'recent' },
    );
    assert.equal(out[0].score, 0.5); // exactly 0.5, no amplification
  });
});

// ── Sort behavior ──────────────────────────────────────────────────────

describe('temporalBoost() — sort', () => {
  it('default: sorts desc by boosted score', () => {
    const out = temporalBoost(
      [
        { id: 'old',  score: 1.0, ts: 0 },        // boost ≈ tiny
        { id: 'mid',  score: 0.5, ts: 999_999 },  // boost ≈ 1
        { id: 'now',  score: 0.4, ts: 1_000_000 },// boost = 1
      ],
      { queryTs: 1_000_000, recency: 'recent' },
    );
    assert.deepEqual(out.map((h) => h.id), ['mid', 'now', 'old']);
  });

  it('opts.sort=false preserves input order', () => {
    const out = temporalBoost(
      [
        { id: 'old', score: 1.0, ts: 0 },
        { id: 'now', score: 0.4, ts: 1_000_000 },
      ],
      { queryTs: 1_000_000, recency: 'recent', sort: false },
    );
    assert.deepEqual(out.map((h) => h.id), ['old', 'now']);
  });

  it('ties broken by ascending id (deterministic)', () => {
    const out = temporalBoost(
      [
        { id: 'b', score: 1, ts: 1000 },
        { id: 'a', score: 1, ts: 1000 },
      ],
      { queryTs: 1000 },
    );
    assert.deepEqual(out.map((h) => h.id), ['a', 'b']);
  });
});

// ── Properties ──────────────────────────────────────────────────────────

describe('temporalBoost() — properties', () => {
  it('monotonically non-increasing in Δt (older → not-higher boost)', async () => {
    await forAll(
      [
        gen.float(0.1, 1),                              // base score
        gen.int(0, 1_000_000),                          // dt1
        gen.int(0, 1_000_000),                          // dt2
      ],
      (score, dt1, dt2) => {
        const queryTs = 2_000_000;
        const a = temporalBoost(
          [{ id: 'x', score, ts: queryTs - dt1 }],
          { queryTs, recency: 'mixed' },
        );
        const b = temporalBoost(
          [{ id: 'x', score, ts: queryTs - dt2 }],
          { queryTs, recency: 'mixed' },
        );
        // If dt1 ≤ dt2 then boost1 ≥ boost2 (closer in time → higher score)
        if (dt1 <= dt2) return a[0].score >= b[0].score - 1e-9;
        return a[0].score <= b[0].score + 1e-9;
      },
      { name: 'monotonic-in-dt', iterations: 100 },
    );
  });

  it('all output scores are finite (no NaN or Infinity)', async () => {
    await forAll(
      [
        gen.float(-100, 100),  // arbitrary score (incl. negative)
        gen.int(-1e9, 1e9),    // arbitrary ts
      ],
      (score, ts) => {
        const out = temporalBoost(
          [{ id: 'x', score, ts }],
          { queryTs: 0, recency: 'mixed' },
        );
        return Number.isFinite(out[0].score);
      },
      { name: 'finite-output', iterations: 100 },
    );
  });

  it('boost stays in [0, 1] for all valid inputs', async () => {
    await forAll(
      [gen.int(-1_000_000, 1_000_000)], // dt (any direction)
      (dt) => {
        const out = temporalBoost(
          [{ id: 'x', score: 1, ts: 0 }],
          { queryTs: dt, recency: 'mixed' },
        );
        return out[0].score >= 0 && out[0].score <= 1 + 1e-12;
      },
      { name: 'boost-bounded-0-1', iterations: 100 },
    );
  });

  it('reflective is identity for any (score, ts, queryTs)', async () => {
    await forAll(
      [
        gen.float(-100, 100),
        gen.int(0, 2_000_000_000),
        gen.int(0, 2_000_000_000),
      ],
      (score, ts, queryTs) => {
        const out = temporalBoost(
          [{ id: 'x', score, ts }],
          { queryTs, recency: 'reflective' },
        );
        return out[0].score === score;
      },
      { name: 'reflective-identity', iterations: 100 },
    );
  });
});

// ── Custom tau override ────────────────────────────────────────────────

describe('temporalBoost() — custom tau', () => {
  it('opts.tau overrides recency', () => {
    const out = temporalBoost(
      [{ id: 'a', score: 1, ts: 0 }],
      { queryTs: 100, tau: 100 },
    );
    assert.ok(close(out[0].score, Math.exp(-1))); // dt = tau → 1/e
  });

  it('tau = 1 produces sharp decay', () => {
    const out = temporalBoost(
      [{ id: 'a', score: 1, ts: 0 }],
      { queryTs: 5, tau: 1 },
    );
    assert.ok(close(out[0].score, Math.exp(-5)));
  });
});

// ── temporalBoostWithProvider ──────────────────────────────────────────

describe('temporalBoostWithProvider()', () => {
  it('enriches results from a ts provider', () => {
    const tsMap = new Map([['a', 100], ['b', 200]]);
    const out = temporalBoostWithProvider(
      [
        { id: 'a', score: 1 },
        { id: 'b', score: 1 },
      ],
      (id) => tsMap.get(id) ?? null,
      { queryTs: 200, recency: 'recent' },
    );
    // 'b' is at queryTs (Δt=0 → boost=1), 'a' is older (Δt=100 → boost<1)
    const a = out.find((h) => h.id === 'a');
    const b = out.find((h) => h.id === 'b');
    assert.equal(b.score, 1);
    assert.ok(a.score < 1);
  });

  it('items with provider returning null pass through unboosted', () => {
    const out = temporalBoostWithProvider(
      [{ id: 'a', score: 0.5 }],
      () => null,
      { queryTs: 999_999_999, recency: 'recent' },
    );
    assert.equal(out[0].score, 0.5);
  });

  it('throws on non-function provider', () => {
    assert.throws(
      () => temporalBoostWithProvider([], 'not-a-fn'),
      TypeError,
    );
  });
});
