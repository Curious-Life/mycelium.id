#!/usr/bin/env node
// verify-drainer-liveness.mjs — the activity indicator MUST be able to go red.
//
// WHY THIS GATE EXISTS. This indicator has hidden a dead enrichment drainer TWICE:
//   1. ~1 month — the embed service was a single-request HTTPServer that blocked /health,
//      the drainer skipped every cycle silently, and the UI still rendered "Embedding
//      messages" (that label was just `pending > 0`, not liveness at all).
//   2. 2026-07-15 — the liveness fix for (1) OVER-corrected. It computed
//        alive = max(lastCycleAt, lastProgressAt)   and treated `running` as healthy.
//      lastCycleAt is stamped by EVERY cycle that clears the health gate — including one
//      that moves ZERO rows — and `running` is true for a cycle wedged on an await that
//      never settles. So `stale` could never become true. Live result: zero rows embedded
//      for 25 minutes while the UI cheerfully said "Embedding messages · running".
//
// An indicator that cannot report a fault is decoration.
//
// NOTE ON THIS FILE'S OWN HISTORY: the first version of this gate stubbed the drainer's
// ES-module export, which is immutable — every case silently no-op'd and returned an
// early PASS. It printed "VERDICT: GO — 6 passed" against code that could never go red.
// That is the false-green trap this repo has already been burned by once. The fix was to
// make the decision a PURE exported function (deriveEmbedLiveness) and test it directly,
// with no stubbing and no skip path. Time is injected, so nothing here is clock-flaky.

import assert from 'node:assert/strict';
import { deriveEmbedLiveness } from '../src/portal-activity.js';

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  [✓] ${n}`); };
const bad = (n, e) => { fail++; console.log(`  [✗] ${n}\n      ${e?.message || e}`); };
const t = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e); } };

const MIN = 60_000;
const NOW = 1_784_000_000_000;   // fixed clock — injected, never Date.now()
const ago = (ms) => NOW - ms;

console.log('\ndrainer liveness — the indicator must be able to go red');

t('REGRESSION: in-flight cycle + no progress for 25min → STALLED (was "running")', () => {
  const r = deriveEmbedLiveness({
    st: { running: true, lastCycleAt: NOW, lastProgressAt: ago(25 * MIN), health: 'ok' },
    health: 'ok', now: NOW,
  });
  assert.equal(r.stalled, true, 'a wedged in-flight cycle must NOT read as healthy');
  assert.equal(r.bad, true);
});

t('REGRESSION: a fresh lastCycleAt must NOT mask a stale lastProgressAt', () => {
  // The exact masking bug: cycles tick every 15s (fresh lastCycleAt) while zero rows move
  // (stale lastProgressAt). max() let the meaningless heartbeat win, forever.
  const r = deriveEmbedLiveness({
    st: { running: false, lastCycleAt: NOW, lastProgressAt: ago(30 * MIN) },
    health: 'ok', now: NOW,
  });
  assert.equal(r.stalled, true, 'progress — not the cycle heartbeat — defines liveness');
});

t('TEETH: the pre-fix formula max(cycle, progress) would call that case HEALTHY', () => {
  // Pin the defect itself so nobody reintroduces it "for stability".
  const st = { running: true, lastCycleAt: NOW, lastProgressAt: ago(30 * MIN) };
  const oldAlive = Math.max(Number(st.lastCycleAt) || 0, Number(st.lastProgressAt) || 0);
  const oldStale = oldAlive > 0 && (NOW - oldAlive) > 90_000;
  const oldStalled = Boolean(st.stalled) || (!st.running && oldStale);
  assert.equal(oldStalled, false, 'sanity: the OLD logic really did report healthy here');
  assert.equal(deriveEmbedLiveness({ st, health: 'ok', now: NOW }).stalled, true,
    'the fix must disagree with the logic that hid a 25-minute outage');
});

t('recent progress → running (must not cry wolf)', () => {
  const r = deriveEmbedLiveness({
    st: { running: true, lastCycleAt: ago(3 * MIN), lastProgressAt: ago(10_000) },
    health: 'ok', now: NOW,
  });
  assert.equal(r.stalled, false);
  assert.equal(r.bad, false);
});

t('a slow-but-working 4-minute cycle is NOT stalled (the over-correction it replaces)', () => {
  const r = deriveEmbedLiveness({
    st: { running: true, lastCycleAt: ago(4 * MIN), lastProgressAt: ago(4 * MIN) },
    health: 'ok', now: NOW,
  });
  assert.equal(r.stalled, false, '90s cried wolf on a healthy on-box-LLM pass; 5min must not');
});

t('booting (no cycle has run yet) is NOT a fault', () => {
  const r = deriveEmbedLiveness({ st: { running: false, lastCycleAt: 0, lastProgressAt: 0 }, health: 'ok', now: NOW });
  assert.equal(r.stalled, false, 'startup is not an outage');
  assert.equal(r.bad, false);
});

t('a loading model is "starting", never a fault', () => {
  const r = deriveEmbedLiveness({
    st: { running: false, lastCycleAt: 0, lastProgressAt: 0, starting: true, stalled: false },
    health: 'loading', now: NOW,
  });
  assert.equal(r.starting, true);
  assert.equal(r.bad, false, 'a model download is not an outage');
});

t('NO drainer at all → bad (nothing is draining the backlog)', () => {
  const r = deriveEmbedLiveness({ st: null, health: 'ok', now: NOW });
  assert.equal(r.bad, true, 'a missing drainer must never render as healthy');
});

t('embed service in error → bad', () => {
  const r = deriveEmbedLiveness({
    st: { running: true, lastCycleAt: NOW, lastProgressAt: NOW }, health: 'error', now: NOW,
  });
  assert.equal(r.bad, true);
});

t('drainer self-reported stalled (skips>0, real outage) → bad even if fresh', () => {
  const r = deriveEmbedLiveness({
    st: { running: false, lastCycleAt: NOW, lastProgressAt: NOW, stalled: true }, health: 'ok', now: NOW,
  });
  assert.equal(r.stalled, true, 'the drainer saying "I am stalled" must be believed');
});

console.log(`\n${fail === 0 ? 'VERDICT: GO' : 'VERDICT: NO-GO'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
