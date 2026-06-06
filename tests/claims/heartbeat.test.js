// tests/claims/heartbeat.test.js — cadence windows + the zero-LLM heartbeat
// trigger. Fully injected (no model, no child, fixed clock).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previousCompleteWindow, CADENCES } from '../../src/claims/windows.js';
import { startClaimHeartbeat } from '../../src/claims/heartbeat.js';

// Wed 2026-06-10T12:00Z
const NOW = Date.parse('2026-06-10T12:00:00Z');

test('previousCompleteWindow: day = yesterday (UTC)', () => {
  const w = previousCompleteWindow(NOW, 'day');
  assert.equal(w.windowStart, '2026-06-09T00:00:00.000Z');
  assert.equal(w.windowEnd, '2026-06-10T00:00:00.000Z');
});

test('previousCompleteWindow: week = last complete ISO week (Mon..Mon)', () => {
  const w = previousCompleteWindow(NOW, 'week');
  // current ISO week started Mon 2026-06-08 → previous week is 06-01..06-08
  assert.equal(w.windowStart, '2026-06-01T00:00:00.000Z');
  assert.equal(w.windowEnd, '2026-06-08T00:00:00.000Z');
});

test('previousCompleteWindow: month = previous calendar month', () => {
  const w = previousCompleteWindow(NOW, 'month');
  assert.equal(w.windowStart, '2026-05-01T00:00:00.000Z');
  assert.equal(w.windowEnd, '2026-06-01T00:00:00.000Z');
});

test('previousCompleteWindow: quarter = previous calendar quarter', () => {
  const w = previousCompleteWindow(NOW, 'quarter');
  // Q2 starts Apr 1 → previous quarter Q1 = Jan 1 .. Apr 1
  assert.equal(w.windowStart, '2026-01-01T00:00:00.000Z');
  assert.equal(w.windowEnd, '2026-04-01T00:00:00.000Z');
});

test('previousCompleteWindow: unknown granularity throws', () => {
  assert.throws(() => previousCompleteWindow(NOW, 'fortnight'), /unknown granularity/);
});

function fakeDb(lastByCadence = {}) {
  return { claims: { lastSnapshotWindow: async (_u, g) => lastByCadence[g] ?? null } };
}

test('heartbeat spawns each cadence whose window has rolled over', async () => {
  const calls = [];
  const hb = startClaimHeartbeat({
    db: fakeDb({}), userId: 'u', now: () => NOW,
    spawn: (cadence, w) => { calls.push({ cadence, end: w.windowEnd }); },
    intervalMs: 1e9, runOnBoot: false,
  });
  await hb.tick();
  hb.stop();
  assert.deepEqual(calls.map((c) => c.cadence).sort(), [...CADENCES].sort());
});

test('heartbeat skips a cadence already discovered for this window', async () => {
  const calls = [];
  const last = { day: previousCompleteWindow(NOW, 'day').windowEnd }; // day already done
  const hb = startClaimHeartbeat({
    db: fakeDb(last), userId: 'u', now: () => NOW,
    spawn: (cadence) => calls.push(cadence), intervalMs: 1e9, runOnBoot: false,
  });
  await hb.tick();
  hb.stop();
  assert.ok(!calls.includes('day'), 'day should be skipped (already snapshotted)');
  assert.ok(calls.includes('week'), 'week still due');
});

test('heartbeat does not pile onto an in-flight job', async () => {
  const calls = [];
  const hb = startClaimHeartbeat({
    db: fakeDb({}), userId: 'u', now: () => NOW, isJobRunning: () => true,
    spawn: (c) => calls.push(c), intervalMs: 1e9, runOnBoot: false,
  });
  await hb.tick();
  hb.stop();
  assert.equal(calls.length, 0, 'no spawns while a job runs');
});

test('startClaimHeartbeat validates deps', () => {
  assert.throws(() => startClaimHeartbeat({ db: {}, spawn: () => {} }), /db\.claims required/);
  assert.throws(() => startClaimHeartbeat({ db: { claims: {} } }), /spawn required/);
});
