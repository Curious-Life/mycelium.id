// tests/claims/confidence.test.js — unit tests for the log-odds confidence +
// type-specific decay math (PersonaTree §3.4). Pure functions; no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DECAY_LAMBDA, L_BASE, decayLogOdds, applyEvidence, update, toConfidence, fromConfidence,
} from '../../src/claims/confidence.js';

const DAY = 86400;

test('toConfidence is the sigmoid: σ(0)=0.5, strictly in (0,1) over the realistic range', () => {
  assert.equal(toConfidence(0), 0.5);
  assert.ok(toConfidence(-50) > 0 && toConfidence(-50) < 0.001);
  assert.ok(toConfidence(15) < 1 && toConfidence(15) > 0.999);
  // Strict open-interval over the range confidence can plausibly reach. (At
  // extreme |L|≳37 float64 saturates σ to exactly 0 or 1 — fine; updates move L
  // by small ω/decay steps and never get near that.)
  for (const L of [-15, -1, 0, 1, 15]) {
    const c = toConfidence(L);
    assert.ok(c > 0 && c < 1, `σ(${L})=${c} out of (0,1)`);
  }
});

test('fromConfidence round-trips toConfidence', () => {
  for (const L of [-3, -0.5, 0, 0.5, 2, 4]) {
    assert.ok(Math.abs(fromConfidence(toConfidence(L)) - L) < 1e-9);
  }
});

test('boundary decay_class never fades (λ=0, identity for any Δt)', () => {
  assert.equal(DECAY_LAMBDA.boundary, 0);
  for (const dt of [0, DAY, 365 * DAY, 1000 * 365 * DAY]) {
    assert.equal(decayLogOdds(3.5, dt, 'boundary'), 3.5, `boundary faded at dt=${dt}`);
  }
});

test('decay is monotonic toward L_BASE for non-boundary classes', () => {
  // Positive L decays DOWN toward 0; the longer the gap, the lower.
  const a = decayLogOdds(2, 10 * DAY, 'preference');
  const b = decayLogOdds(2, 40 * DAY, 'preference');
  assert.ok(2 > a && a > b && b > L_BASE, `expected 2 > ${a} > ${b} > 0`);
  // Negative L decays UP toward 0.
  const c = decayLogOdds(-2, 10 * DAY, 'preference');
  const d = decayLogOdds(-2, 40 * DAY, 'preference');
  assert.ok(-2 < c && c < d && d < L_BASE, `expected -2 < ${c} < ${d} < 0`);
});

test('faster decay class fades more over the same interval', () => {
  const dt = 30 * DAY;
  const mood = decayLogOdds(2, dt, 'mood'); // τ ≈ 1 week → mostly gone
  const ident = decayLogOdds(2, dt, 'identity'); // τ ≈ 1 year → barely moved
  assert.ok(mood < ident, `mood(${mood}) should be < identity(${ident})`);
  // identity τ≈1yr → 2·e^(−30/365) ≈ 1.842 over a month: barely moved vs mood (~0.03).
  assert.ok(ident > 1.8, `identity should barely decay over a month, got ${ident}`);
});

test('one decay time-constant τ=1/λ brings (L−base) to ~1/e of its value', () => {
  const L0 = 1;
  const tau = 30 * DAY; // preference τ
  const decayed = decayLogOdds(L0, tau, 'preference');
  assert.ok(Math.abs(decayed - L0 / Math.E) < 1e-6, `expected ≈${L0 / Math.E}, got ${decayed}`);
});

test('applyEvidence: support raises L, conflict lowers it', () => {
  assert.equal(applyEvidence(0, 0.8), 0.8);
  assert.equal(applyEvidence(0, -0.8), -0.8);
  assert.ok(toConfidence(applyEvidence(0, 0.8)) > 0.5);
  assert.ok(toConfidence(applyEvidence(0, -0.8)) < 0.5);
});

test('update applies decay then evidence (Eq. 3 order)', () => {
  // Prior L=2 (preference), 30 days elapsed → decays to ~2/e≈0.736, then +0.5 support.
  const { L, confidence } = update({ L: 2, dtSeconds: 30 * DAY, decayClass: 'preference', omega: 0.5 });
  const expected = 2 / Math.E + 0.5;
  assert.ok(Math.abs(L - expected) < 1e-6, `L=${L} expected ≈${expected}`);
  assert.equal(confidence, toConfidence(L));
});

test('negative Δt (clock skew) is clamped to no-decay', () => {
  assert.equal(decayLogOdds(1.5, -9999, 'mood'), 1.5);
});

test('unknown decay_class throws (fail-closed)', () => {
  assert.throws(() => decayLogOdds(1, DAY, 'nonsense'), /unknown decay_class/);
});

test('invalid inputs throw', () => {
  assert.throws(() => toConfidence('x'), /finite number/);
  assert.throws(() => applyEvidence(0, Infinity), /finite number/);
  assert.throws(() => fromConfidence(0), /\(0,1\)/);
  assert.throws(() => fromConfidence(1), /\(0,1\)/);
  assert.throws(() => decayLogOdds(NaN, DAY, 'fact'), /finite number/);
});
