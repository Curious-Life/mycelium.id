/**
 * shadow.js — pure metrics tests.
 *
 * Hand-computed expected values for jaccard and spearman on small inputs.
 * Properties: bounds, symmetry, identity, vacuous-empty conventions.
 *
 * Run: npm test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { jaccard, jaccardAtK, spearmanByIds } from '@mycelium/core/mind-search/shadow.js';
import { forAll, gen } from '../../util/property.js';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ── jaccard ─────────────────────────────────────────────────────────────

describe('jaccard()', () => {
  it('identity: J(A, A) === 1 for non-empty A', () => {
    assert.equal(jaccard(['a', 'b', 'c'], ['a', 'b', 'c']), 1);
  });

  it('disjoint: J(A, B) === 0 when no overlap', () => {
    assert.equal(jaccard(['a', 'b'], ['x', 'y']), 0);
  });

  it('partial: J({a,b,c}, {b,c,d}) = 2/4 = 0.5', () => {
    assert.equal(jaccard(['a', 'b', 'c'], ['b', 'c', 'd']), 0.5);
  });

  it('asymmetric overlap: J({a,b,c}, {a}) = 1/3', () => {
    assert.ok(close(jaccard(['a', 'b', 'c'], ['a']), 1 / 3));
  });

  it('both empty → 1 (vacuous match)', () => {
    assert.equal(jaccard([], []), 1);
  });

  it('one empty, one not → 0', () => {
    assert.equal(jaccard(['a'], []), 0);
    assert.equal(jaccard([], ['a']), 0);
  });

  it('accepts Sets directly without re-converting', () => {
    assert.equal(jaccard(new Set(['a', 'b']), new Set(['b', 'c'])), 1 / 3);
  });

  it('symmetric: J(A, B) === J(B, A)', () => {
    const cases = [
      [['a'], ['b']],
      [['a', 'b'], ['b', 'c', 'd']],
      [[], ['a']],
      [['a', 'b'], ['a', 'b', 'c']],
    ];
    for (const [a, b] of cases) {
      assert.equal(jaccard(a, b), jaccard(b, a));
    }
  });

  it('property: J in [0, 1] for any inputs', async () => {
    await forAll(
      [
        gen.array(8, gen.oneOf('a', 'b', 'c', 'd', 'e')),
        gen.array(8, gen.oneOf('a', 'b', 'c', 'd', 'e')),
      ],
      (a, b) => {
        const j = jaccard(a, b);
        return j >= 0 && j <= 1;
      },
      { name: 'jaccard-bounds', iterations: 100 },
    );
  });
});

// ── jaccardAtK ──────────────────────────────────────────────────────────

describe('jaccardAtK()', () => {
  it('truncates to top-K of each list', () => {
    // Top-3 of A: [a, b, c]; Top-3 of B: [b, c, d]; J = 2/4 = 0.5
    assert.equal(jaccardAtK(['a', 'b', 'c', 'x', 'y'], ['b', 'c', 'd', 'p', 'q'], 3), 0.5);
  });

  it('K = 1: only top-1 matters', () => {
    assert.equal(jaccardAtK(['a', 'b'], ['a', 'c'], 1), 1);  // both have 'a' at rank 1
    assert.equal(jaccardAtK(['a', 'b'], ['b', 'a'], 1), 0);  // different rank-1
  });

  it('K larger than either list returns set Jaccard over the whole', () => {
    assert.equal(jaccardAtK(['a', 'b'], ['b', 'c'], 99), jaccard(['a', 'b'], ['b', 'c']));
  });

  it('rejects bad K', () => {
    assert.throws(() => jaccardAtK(['a'], ['b'], 0), TypeError);
    assert.throws(() => jaccardAtK(['a'], ['b'], -1), TypeError);
    assert.throws(() => jaccardAtK(['a'], ['b'], 1.5), TypeError);
  });

  it('rejects non-array inputs', () => {
    assert.throws(() => jaccardAtK('abc', ['b']), TypeError);
    assert.throws(() => jaccardAtK(['a'], null), TypeError);
  });
});

// ── spearmanByIds ───────────────────────────────────────────────────────

describe('spearmanByIds()', () => {
  it('identical ranking → ρ = 1', () => {
    assert.equal(spearmanByIds(['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd']), 1);
  });

  it('completely reversed ranking → ρ = -1', () => {
    assert.equal(spearmanByIds(['a', 'b', 'c', 'd'], ['d', 'c', 'b', 'a']), -1);
  });

  it('null when fewer than 2 ids overlap', () => {
    assert.equal(spearmanByIds(['a', 'b'], ['x', 'y']), null);  // no overlap
    assert.equal(spearmanByIds(['a'], ['a']), null);            // n = 1, undefined
  });

  it('null when either list is empty', () => {
    assert.equal(spearmanByIds([], ['a', 'b']), null);
    assert.equal(spearmanByIds(['a', 'b'], []), null);
  });

  it('hand-computed: small list with one swap', () => {
    // A: [a, b, c, d]   ranks: a=1, b=2, c=3, d=4
    // B: [a, c, b, d]   ranks: a=1, c=2, b=3, d=4
    // Diffs (per shared id): a=0, b=2-3=-1, c=3-2=1, d=0
    // Σd² = 0 + 1 + 1 + 0 = 2
    // n = 4
    // ρ = 1 - (6*2) / (4 * 15) = 1 - 12/60 = 1 - 0.2 = 0.8
    const r = spearmanByIds(['a', 'b', 'c', 'd'], ['a', 'c', 'b', 'd']);
    assert.ok(close(r, 0.8), `expected 0.8, got ${r}`);
  });

  it('partial overlap: only shared ids count', () => {
    // A: [a, b, c, d, e]   ranks among shared {a,b,c}: a=1, b=2, c=3
    // B: [c, b, a, x, y]   ranks among shared {a,b,c}: a=3, b=2, c=1
    // Diffs: a=1-3=-2, b=2-2=0, c=3-1=2
    // Σd² = 4 + 0 + 4 = 8
    // n = 3, n(n²-1) = 3*8 = 24
    // ρ = 1 - 6*8 / 24 = 1 - 2 = -1
    const r = spearmanByIds(['a', 'b', 'c', 'd', 'e'], ['c', 'b', 'a', 'x', 'y']);
    assert.ok(close(r, -1), `expected -1, got ${r}`);
  });

  it('within-list duplicates take first-occurrence relative rank', () => {
    // Re-rank semantic: shared = {a, b, c}.
    // A's first-occurrence ordering of shared: [a, b, c]   → ranks 1, 2, 3
    // B: [a, b, c]                                          → ranks 1, 2, 3
    // Diffs: 0, 0, 0   → ρ = 1
    const r = spearmanByIds(['a', 'b', 'a', 'c'], ['a', 'b', 'c']);
    assert.ok(close(r, 1), `expected 1, got ${r}`);
  });

  it('within-list duplicates with cross-list reordering: ρ reflects relative ranks', () => {
    // Shared = {a, b, c}.
    // A's first-occurrence ordering of shared: [a, b, c]   → ranks 1, 2, 3
    // B's first-occurrence ordering of shared: [c, b, a]   → ranks: c=1, b=2, a=3
    // Diffs (id ↦ rankA - rankB): a: 1-3=-2, b: 2-2=0, c: 3-1=2
    // Σd² = 8, n=3, ρ = 1 - 48/24 = -1
    const r = spearmanByIds(['a', 'b', 'a', 'c'], ['c', 'b', 'a']);
    assert.ok(close(r, -1), `expected -1, got ${r}`);
  });

  it('rejects non-array inputs', () => {
    assert.throws(() => spearmanByIds('abc', ['b']), TypeError);
    assert.throws(() => spearmanByIds(['a'], null), TypeError);
  });

  it('property: ρ in [-1, 1] when defined', async () => {
    await forAll(
      [
        gen.array(6, gen.oneOf('a', 'b', 'c', 'd', 'e', 'f')),
        gen.array(6, gen.oneOf('a', 'b', 'c', 'd', 'e', 'f')),
      ],
      (a, b) => {
        const r = spearmanByIds(a, b);
        return r === null || (r >= -1 - 1e-9 && r <= 1 + 1e-9);
      },
      { name: 'spearman-bounds', iterations: 100 },
    );
  });
});
