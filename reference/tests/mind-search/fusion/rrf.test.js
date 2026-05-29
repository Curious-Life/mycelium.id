/**
 * rrf.js — Reciprocal Rank Fusion tests.
 *
 * Properties:
 *   • result IDs ⊆ union of input IDs
 *   • scores in [0, len(lists) / (k+1)]
 *   • deterministic order under tied ranks
 *   • duplicates within one list count only at the best rank
 *
 * Regression: hand-computed two-list RRF.
 *
 * Run: npm test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { rrf, maxRrfScore } from '@mycelium/core/mind-search/fusion/rrf.js';
import { forAll, gen } from '../../util/property.js';

const close = (a, b, eps = 1e-12) => Math.abs(a - b) < eps;

// ── Input validation ───────────────────────────────────────────────────

describe('rrf() — input validation', () => {
  it('throws when lists is not an array', () => {
    assert.throws(() => rrf(null), TypeError);
    assert.throws(() => rrf({}), TypeError);
    assert.throws(() => rrf('foo'), TypeError);
  });

  it('throws when an inner list is not an array', () => {
    assert.throws(() => rrf([[{ id: 'a' }], 'bad']), TypeError);
    assert.throws(() => rrf([null]), TypeError);
  });

  it('throws on invalid k', () => {
    const lists = [[{ id: 'a' }]];
    assert.throws(() => rrf(lists, { k: 0 }), TypeError);
    assert.throws(() => rrf(lists, { k: -1 }), TypeError);
    assert.throws(() => rrf(lists, { k: NaN }), TypeError);
    assert.throws(() => rrf(lists, { k: Infinity }), TypeError);
  });
});

// ── Edge cases ─────────────────────────────────────────────────────────

describe('rrf() — edge cases', () => {
  it('returns [] for no input lists', () => {
    assert.deepEqual(rrf([]), []);
  });

  it('returns [] for all-empty lists', () => {
    assert.deepEqual(rrf([[], [], []]), []);
  });

  it('skips items with missing or non-string id', () => {
    const out = rrf([[{ id: 'a' }, {}, { id: '' }, { id: null }, { id: 'b' }]]);
    assert.deepEqual(out.map((h) => h.id), ['a', 'b']);
  });

  it('single list preserves order', () => {
    const out = rrf([[{ id: 'a' }, { id: 'b' }, { id: 'c' }]]);
    assert.deepEqual(out.map((h) => h.id), ['a', 'b', 'c']);
    // Scores follow 1/(k+rank): a > b > c
    assert.ok(out[0].score > out[1].score);
    assert.ok(out[1].score > out[2].score);
  });
});

// ── Hand-computed regression ───────────────────────────────────────────

describe('rrf() — hand-computed regression', () => {
  it('two-list RRF with k=60: correct fused scores', () => {
    // List A: a, b, c   (ranks 1, 2, 3)
    // List B: b, c, d   (ranks 1, 2, 3)
    //
    // a: 1/(60+1)                     = 1/61   ≈ 0.01639
    // b: 1/(60+2) + 1/(60+1)          = 1/62 + 1/61 ≈ 0.03252
    // c: 1/(60+3) + 1/(60+2)          = 1/63 + 1/62 ≈ 0.03200
    // d: 0       + 1/(60+3)           = 1/63  ≈ 0.01587
    //
    // Order: b > c > a > d
    const out = rrf([
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      [{ id: 'b' }, { id: 'c' }, { id: 'd' }],
    ]);
    assert.deepEqual(out.map((h) => h.id), ['b', 'c', 'a', 'd']);

    const expectedB = 1 / 62 + 1 / 61;
    const expectedC = 1 / 63 + 1 / 62;
    const expectedA = 1 / 61;
    const expectedD = 1 / 63;
    assert.ok(close(out[0].score, expectedB), `b: ${out[0].score} vs ${expectedB}`);
    assert.ok(close(out[1].score, expectedC), `c: ${out[1].score} vs ${expectedC}`);
    assert.ok(close(out[2].score, expectedA), `a: ${out[2].score} vs ${expectedA}`);
    assert.ok(close(out[3].score, expectedD), `d: ${out[3].score} vs ${expectedD}`);
  });

  it('respects custom k', () => {
    const out1 = rrf([[{ id: 'a' }, { id: 'b' }]], { k: 1 });
    const out2 = rrf([[{ id: 'a' }, { id: 'b' }]], { k: 100 });
    // Smaller k means top-1 dominates more strongly relative to top-2
    const ratio1 = out1[0].score / out1[1].score; // (1/2)/(1/3) = 1.5
    const ratio2 = out2[0].score / out2[1].score; // (1/101)/(1/102) ≈ 1.0099
    assert.ok(ratio1 > ratio2);
  });
});

// ── Duplicate handling ─────────────────────────────────────────────────

describe('rrf() — duplicate handling', () => {
  it('within-list duplicates count only at best rank', () => {
    // A: a, b, a, c    — 'a' appears at ranks 1 and 3; should only count rank 1
    // Expected score for 'a' = 1/(60+1)     ≈ 0.01639
    // If we mistakenly counted both:        = 1/(60+1) + 1/(60+3) ≈ 0.03226
    const out = rrf([[{ id: 'a' }, { id: 'b' }, { id: 'a' }, { id: 'c' }]]);
    const a = out.find((h) => h.id === 'a');
    assert.ok(close(a.score, 1 / 61), `expected only rank-1 contribution: ${a.score}`);
  });

  it('cross-list duplicates DO accumulate (different lists, both count)', () => {
    const out = rrf([
      [{ id: 'a' }],  // a at rank 1 in list 0
      [{ id: 'a' }],  // a at rank 1 in list 1
    ]);
    assert.equal(out.length, 1);
    assert.ok(close(out[0].score, 2 / 61));
  });
});

// ── Sort + tie-break determinism ───────────────────────────────────────

describe('rrf() — sort + determinism', () => {
  it('sorts descending by score', () => {
    const out = rrf([
      [{ id: 'low' }, { id: 'mid' }, { id: 'hi' }],
      [{ id: 'hi' }, { id: 'mid' }],
    ]);
    for (let i = 1; i < out.length; i++) {
      assert.ok(out[i - 1].score >= out[i].score);
    }
  });

  it('ties broken by ascending id', () => {
    // All four ids appear at rank 1 in their own list → identical scores
    const out = rrf([
      [{ id: 'd' }],
      [{ id: 'b' }],
      [{ id: 'c' }],
      [{ id: 'a' }],
    ]);
    assert.deepEqual(out.map((h) => h.id), ['a', 'b', 'c', 'd']);
  });

  it('output independent of input-list order (same lists, different order)', () => {
    const A = [{ id: 'a' }, { id: 'b' }];
    const B = [{ id: 'b' }, { id: 'c' }];
    const r1 = rrf([A, B]);
    const r2 = rrf([B, A]);
    assert.deepEqual(
      r1.map((h) => `${h.id}:${h.score}`),
      r2.map((h) => `${h.id}:${h.score}`),
    );
  });
});

// ── Properties ──────────────────────────────────────────────────────────

describe('rrf() — properties', () => {
  it('result ids ⊆ union of input ids', async () => {
    await forAll(
      [
        gen.array(5, gen.array(10, gen.oneOf('a', 'b', 'c', 'd', 'e'))),
      ],
      (idLists) => {
        const lists = idLists.map((arr) => arr.map((id) => ({ id })));
        const fused = rrf(lists);
        const inputIds = new Set();
        for (const list of lists) for (const it of list) inputIds.add(it.id);
        return fused.every((h) => inputIds.has(h.id));
      },
      { name: 'subset-of-union', iterations: 50 },
    );
  });

  it('scores are bounded by len(lists) / (k+1) = maxRrfScore()', async () => {
    await forAll(
      [
        gen.int(1, 6),  // numLists
        gen.int(1, 20), // listLen
      ],
      (numLists, listLen) => {
        const lists = Array.from({ length: numLists }, (_, li) =>
          Array.from({ length: listLen }, (_, ri) => ({ id: `id-${li}-${ri}` })),
        );
        const fused = rrf(lists, { k: 60 });
        const max = maxRrfScore(numLists, 60);
        return fused.every((h) => h.score >= 0 && h.score <= max + 1e-12);
      },
      { name: 'score-bounds', iterations: 30 },
    );
  });

  it('all scores strictly positive (when id appears at all)', async () => {
    await forAll(
      [gen.array(3, gen.array(5, gen.oneOf('a', 'b', 'c')))],
      (idLists) => {
        const lists = idLists.map((arr) => arr.map((id) => ({ id })));
        return rrf(lists).every((h) => h.score > 0);
      },
      { name: 'positive-scores', iterations: 30 },
    );
  });

  it('topK trims correctly', () => {
    const out = rrf(
      [
        [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        [{ id: 'b' }, { id: 'c' }, { id: 'd' }],
      ],
      { topK: 2 },
    );
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((h) => h.id), ['b', 'c']);
  });

  it('topK >= total returns full list', () => {
    const lists = [[{ id: 'a' }, { id: 'b' }]];
    assert.equal(rrf(lists, { topK: 999 }).length, 2);
    assert.equal(rrf(lists, { topK: 2 }).length, 2);
  });
});

// ── includeSources ─────────────────────────────────────────────────────

describe('rrf() — includeSources', () => {
  it('attaches source-list indices when requested', () => {
    const out = rrf(
      [
        [{ id: 'a' }, { id: 'b' }],
        [{ id: 'b' }, { id: 'c' }],
        [{ id: 'a' }],
      ],
      { includeSources: true },
    );
    const a = out.find((h) => h.id === 'a');
    const b = out.find((h) => h.id === 'b');
    const c = out.find((h) => h.id === 'c');
    assert.deepEqual(a.sources, [0, 2]);
    assert.deepEqual(b.sources, [0, 1]);
    assert.deepEqual(c.sources, [1]);
  });

  it('omits sources when not requested', () => {
    const out = rrf([[{ id: 'a' }]]);
    assert.equal(out[0].sources, undefined);
  });
});

// ── maxRrfScore helper ─────────────────────────────────────────────────

describe('maxRrfScore()', () => {
  it('returns numLists / (k+1)', () => {
    assert.equal(maxRrfScore(0), 0);
    assert.ok(close(maxRrfScore(1), 1 / 61));
    assert.ok(close(maxRrfScore(2), 2 / 61));
    assert.ok(close(maxRrfScore(2, 1), 2 / 2));
  });

  it('throws on invalid input', () => {
    assert.throws(() => maxRrfScore(-1), TypeError);
    assert.throws(() => maxRrfScore(Infinity), TypeError);
    assert.throws(() => maxRrfScore(2, 0), TypeError);
    assert.throws(() => maxRrfScore(2, -5), TypeError);
  });
});
