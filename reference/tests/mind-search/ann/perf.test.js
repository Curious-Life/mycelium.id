/**
 * cosine.js — performance budget enforcement.
 *
 * Per packages/core/mind-search/PERFORMANCE-BUDGET.md:
 *
 *   Cosine over 5000 candidates (768D)        < 30 ms
 *
 * The CI runner is not always equivalent to the customer VPS class. We
 * tolerate ±10% on latency budgets by default. Set MIND_SEARCH_PERF_STRICT=1
 * to enforce the exact budget (used on owner-VPS pre-merge runs).
 *
 * Skipped on slow CI: set MIND_SEARCH_PERF_SKIP=1 to skip these tests
 * (perf budget then enforced separately on the owner VPS).
 *
 * Run: npm test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cosine, cosineUnit, topKCosine } from '@mycelium/core/mind-search/ann/cosine.js';

const SKIP = process.env.MIND_SEARCH_PERF_SKIP === '1';
const STRICT = process.env.MIND_SEARCH_PERF_STRICT === '1';
const TOLERANCE = STRICT ? 1.0 : 1.1;

// ── Helpers ─────────────────────────────────────────────────────────────

function randomUnitVector(dim) {
  const v = new Float32Array(dim);
  let sum = 0;
  for (let i = 0; i < dim; i++) {
    v[i] = Math.random() * 2 - 1;
    sum += v[i] * v[i];
  }
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}

function generateCandidates(n, dim) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = randomUnitVector(dim);
  return out;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('cosine.js — performance budget', { skip: SKIP }, () => {
  it('cosineUnit on 5000 × 768D candidates: median < 30 ms', () => {
    const dim = 768;
    const n = 5000;
    const query = randomUnitVector(dim);
    const candidates = generateCandidates(n, dim);

    // Warm up — V8 needs a few runs to optimize the hot loop.
    for (let w = 0; w < 3; w++) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += cosineUnit(query, candidates[i]);
      // Use sum to prevent dead-code elimination
      assert.ok(typeof sum === 'number');
    }

    // Measure
    const trials = 5;
    const durations = [];
    for (let t = 0; t < trials; t++) {
      const start = performance.now();
      let sum = 0;
      for (let i = 0; i < n; i++) sum += cosineUnit(query, candidates[i]);
      const ms = performance.now() - start;
      durations.push(ms);
      assert.ok(typeof sum === 'number');
    }

    const med = median(durations);
    const budget = 30 * TOLERANCE;
    assert.ok(
      med < budget,
      `cosineUnit 5000×768D median ${med.toFixed(2)} ms exceeds budget ${budget.toFixed(2)} ms (trials: ${durations.map((d) => d.toFixed(1)).join(', ')})`,
    );
  });

  it('topKCosine on 5000 × 768D: median < 50 ms (cosine + sort)', () => {
    const dim = 768;
    const n = 5000;
    const query = randomUnitVector(dim);
    const candidates = generateCandidates(n, dim);

    // Warm up
    for (let w = 0; w < 3; w++) {
      const r = topKCosine(query, candidates, 50);
      assert.ok(r.length === 50);
    }

    const trials = 5;
    const durations = [];
    for (let t = 0; t < trials; t++) {
      const start = performance.now();
      const r = topKCosine(query, candidates, 50);
      const ms = performance.now() - start;
      durations.push(ms);
      assert.equal(r.length, 50);
    }

    const med = median(durations);
    // Cosine 30ms + sort+slice on 5000 entries ≈ ~50ms total budget
    const budget = 50 * TOLERANCE;
    assert.ok(
      med < budget,
      `topKCosine 5000×768D median ${med.toFixed(2)} ms exceeds budget ${budget.toFixed(2)} ms (trials: ${durations.map((d) => d.toFixed(1)).join(', ')})`,
    );
  });

  it('full cosine() (with norms) on 5000 × 768D: median < 60 ms', () => {
    // Full path is ~3× cosineUnit because of two extra inner-loop accumulators.
    // 30 ms × 2 = 60 ms is a generous but realistic budget; if we ever
    // need full cosine in the hot path we'd revisit.
    const dim = 768;
    const n = 5000;
    const query = randomUnitVector(dim);
    const candidates = generateCandidates(n, dim);

    for (let w = 0; w < 3; w++) {
      for (let i = 0; i < n; i++) cosine(query, candidates[i]);
    }

    const trials = 5;
    const durations = [];
    for (let t = 0; t < trials; t++) {
      const start = performance.now();
      let sum = 0;
      for (let i = 0; i < n; i++) sum += cosine(query, candidates[i]);
      const ms = performance.now() - start;
      durations.push(ms);
      assert.ok(typeof sum === 'number');
    }

    const med = median(durations);
    const budget = 60 * TOLERANCE;
    assert.ok(
      med < budget,
      `cosine 5000×768D median ${med.toFixed(2)} ms exceeds budget ${budget.toFixed(2)} ms (trials: ${durations.map((d) => d.toFixed(1)).join(', ')})`,
    );
  });
});
