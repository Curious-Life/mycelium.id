/**
 * cosine.js — property + regression tests.
 *
 * Properties: identity, commutativity, bounds, zero-vector sentinel.
 * Regression: hand-computed expected values for fixed inputs.
 * Top-K: ordering, length bounds, stable tie-break.
 *
 * Run: npm test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cosine, cosineUnit, topKCosine } from '@mycelium/core/mind-search/ann/cosine.js';
import { forAll, gen } from '../../util/property.js';

const EPS = 1e-5;
const close = (actual, expected, eps = EPS) => Math.abs(actual - expected) < eps;

// ── cosine() — identity, commutativity, bounds ─────────────────────────

describe('cosine()', () => {
  it('cos(v, v) ≈ 1 for any non-zero vector', async () => {
    await forAll(
      [gen.float32Array(64)],
      (v) => {
        // Skip the genuine zero vector (probability ≈ 0 with float, but be safe)
        let nz = false;
        for (let i = 0; i < v.length; i++) if (v[i] !== 0) { nz = true; break; }
        if (!nz) return true;
        return close(cosine(v, v), 1);
      },
      { name: 'cos(v,v) ≈ 1', iterations: 100 },
    );
  });

  it('cos(v, w) === cos(w, v) (commutative)', async () => {
    await forAll(
      [gen.float32Array(64), gen.float32Array(64)],
      (a, b) => close(cosine(a, b), cosine(b, a)),
      { name: 'commutative', iterations: 100 },
    );
  });

  it('-1 ≤ cos(v, w) ≤ 1 for any vectors', async () => {
    await forAll(
      [gen.float32Array(64), gen.float32Array(64)],
      (a, b) => {
        const c = cosine(a, b);
        return c >= -1 - EPS && c <= 1 + EPS;
      },
      { name: 'bounds', iterations: 200 },
    );
  });

  it('cos(v, 0) === 0 (zero vector sentinel, not NaN)', () => {
    const v = new Float32Array([1, 2, 3, 4]);
    const zero = new Float32Array(4);
    assert.equal(cosine(v, zero), 0);
    assert.equal(cosine(zero, v), 0);
    assert.equal(cosine(zero, zero), 0);
  });

  it('throws on dim mismatch', () => {
    const a = new Float32Array(4);
    const b = new Float32Array(8);
    assert.throws(() => cosine(a, b), /dim mismatch/);
  });

  it('regression: hand-computed values', () => {
    // [1,0] · [1,0] / (1*1) = 1
    assert.ok(close(cosine(new Float32Array([1, 0]), new Float32Array([1, 0])), 1));

    // [1,0] · [0,1] / (1*1) = 0   (orthogonal)
    assert.ok(close(cosine(new Float32Array([1, 0]), new Float32Array([0, 1])), 0));

    // [1,0] · [-1,0] / (1*1) = -1 (antiparallel)
    assert.ok(close(cosine(new Float32Array([1, 0]), new Float32Array([-1, 0])), -1));

    // [1,1,1] · [1,1,1] / (sqrt(3)*sqrt(3)) = 3/3 = 1
    const ones = new Float32Array([1, 1, 1]);
    assert.ok(close(cosine(ones, ones), 1));

    // [1,2,3] · [4,5,6] / (sqrt(14)*sqrt(77)) = 32 / sqrt(1078) ≈ 0.974631846
    const c = cosine(new Float32Array([1, 2, 3]), new Float32Array([4, 5, 6]));
    assert.ok(close(c, 0.974631846, 1e-5), `expected ≈ 0.9746, got ${c}`);
  });
});

// ── cosineUnit() — same properties, assumes pre-normalized ─────────────

describe('cosineUnit()', () => {
  it('cosineUnit(v, v) ≈ 1 for unit vectors', async () => {
    await forAll(
      [gen.unitVector(128)],
      (v) => close(cosineUnit(v, v), 1),
      { name: 'unit identity', iterations: 100 },
    );
  });

  it('cosineUnit and cosine agree for unit-vector inputs', async () => {
    await forAll(
      [gen.unitVector(128), gen.unitVector(128)],
      (a, b) => close(cosineUnit(a, b), cosine(a, b), 1e-5),
      { name: 'agreement', iterations: 100 },
    );
  });

  it('cosineUnit commutative', async () => {
    await forAll(
      [gen.unitVector(64), gen.unitVector(64)],
      (a, b) => close(cosineUnit(a, b), cosineUnit(b, a)),
      { name: 'unit commutative', iterations: 100 },
    );
  });

  it('throws on dim mismatch', () => {
    const a = new Float32Array(4);
    const b = new Float32Array(8);
    assert.throws(() => cosineUnit(a, b), /dim mismatch/);
  });
});

// ── topKCosine() — ordering, length, ties ──────────────────────────────

describe('topKCosine()', () => {
  it('returns at most k results', () => {
    const q = new Float32Array([1, 0, 0]);
    const cs = [
      new Float32Array([1, 0, 0]),
      new Float32Array([0, 1, 0]),
      new Float32Array([0, 0, 1]),
      new Float32Array([1, 1, 0]),
    ];
    const result = topKCosine(q, cs, 2, { assumeUnit: false });
    assert.equal(result.length, 2);
  });

  it('returns all when k >= candidates.length', () => {
    const q = new Float32Array([1, 0]);
    const cs = [new Float32Array([1, 0]), new Float32Array([0, 1])];
    const result = topKCosine(q, cs, 99, { assumeUnit: false });
    assert.equal(result.length, 2);
  });

  it('returns empty when no candidates', () => {
    const q = new Float32Array([1, 0]);
    assert.deepEqual(topKCosine(q, [], 5), []);
  });

  it('orders results by score descending', async () => {
    await forAll(
      [gen.unitVector(32), gen.array(20, gen.unitVector(32))],
      (q, cs) => {
        const result = topKCosine(q, cs, 10);
        for (let i = 1; i < result.length; i++) {
          if (result[i].score > result[i - 1].score) return false;
        }
        return true;
      },
      { name: 'descending order', iterations: 30 },
    );
  });

  it('idx values are valid indices into candidates', async () => {
    await forAll(
      [gen.unitVector(32), gen.array(15, gen.unitVector(32))],
      (q, cs) => {
        const result = topKCosine(q, cs, 5);
        return result.every((r) => r.idx >= 0 && r.idx < cs.length);
      },
      { name: 'idx valid', iterations: 30 },
    );
  });

  it('breaks ties by lower idx first (stable)', () => {
    // All identical candidates → all score the same → idx 0..k-1 order
    const q = new Float32Array([1, 0]);
    const cs = [
      new Float32Array([1, 0]),
      new Float32Array([1, 0]),
      new Float32Array([1, 0]),
      new Float32Array([1, 0]),
    ];
    const result = topKCosine(q, cs, 3, { assumeUnit: false });
    assert.deepEqual(result.map((r) => r.idx), [0, 1, 2]);
  });

  it('the perfect match is always rank 0', () => {
    const q = new Float32Array([0.6, 0.8]); // unit vector
    const cs = [
      new Float32Array([0, 1]),
      new Float32Array([1, 0]),
      new Float32Array([0.6, 0.8]), // identical to q
      new Float32Array([-0.6, -0.8]),
    ];
    const result = topKCosine(q, cs, 1, { assumeUnit: false });
    assert.equal(result[0].idx, 2);
    assert.ok(close(result[0].score, 1));
  });
});
