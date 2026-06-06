// tests/claims/store.test.js — db.claims namespace (person_claims +
// person_claim_snapshots). Boots a real encrypted vault; asserts the method
// contracts: create/update upsert, hash + match lookups, snapshot UNIQUE upsert,
// series ASC + sigmoid + honest null gaps, last-window for the heartbeat.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../../src/index.js';
import { applyMigrations } from '../../src/db/migrate.js';

const DB = 'data/test-claims-store.db', KCV = 'data/test-claims-store-kcv.json';
const U = 'local-user';
let db, close;

before(async () => {
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  mkdirSync('data', { recursive: true });
  applyMigrations(new Database(DB));
  ({ db, close } = await boot({
    dbPath: DB, kcvPath: KCV,
    userHex: crypto.randomBytes(32).toString('hex'),
    systemHex: crypto.randomBytes(32).toString('hex'),
    embedder: null,
  }));
});

after(() => {
  try { close?.(); } catch {}
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
});

test('upsert creates a claim; getById decrypts + coerces confidence', async () => {
  await db.claims.upsert({
    id: 'c1', userId: U, subject: 'self', claimType: 'boundary',
    content: 'Severe peanut allergy.', confidenceLogodds: 2.5, decayClass: 'boundary',
    support: { messages: ['m1', 'm2'], territories: [] }, contentHash: 'h1',
    status: 'active', lastEvidenceAt: '2026-06-05T00:00:00Z',
  });
  const c = await db.claims.getById(U, 'c1');
  assert.equal(c.claimType, 'boundary');
  assert.match(c.content, /peanut allergy/);
  assert.equal(c.confidenceLogodds, 2.5);
  assert.deepEqual(c.support, { messages: ['m1', 'm2'], territories: [] });
});

test('upsert by same id updates in place (no duplicate row)', async () => {
  await db.claims.upsert({
    id: 'c1', userId: U, claimType: 'boundary', content: 'Severe peanut + shellfish allergy.',
    confidenceLogodds: 3.1, decayClass: 'boundary', contentHash: 'h1', status: 'active',
    lastEvidenceAt: '2026-06-06T00:00:00Z',
  });
  const c = await db.claims.getById(U, 'c1');
  assert.match(c.content, /shellfish/);
  assert.equal(c.confidenceLogodds, 3.1);
  const all = await db.claims.listActive(U, { limit: 50 });
  assert.equal(all.filter((x) => x.id === 'c1').length, 1, 'must not duplicate');
});

test('findByHash returns the claim (dedup/tombstone key)', async () => {
  const c = await db.claims.findByHash(U, 'h1');
  assert.equal(c?.id, 'c1');
  assert.equal(await db.claims.findByHash(U, 'nope'), null);
});

test('setStatus + listForMatch includes rejected tombstones', async () => {
  await db.claims.upsert({ id: 'c2', userId: U, content: 'Wrong claim.', confidenceLogodds: 0.1,
    decayClass: 'preference', contentHash: 'h2', status: 'active', lastEvidenceAt: '2026-06-01T00:00:00Z' });
  await db.claims.setStatus(U, 'c2', 'rejected');
  const active = await db.claims.listActive(U, { limit: 50 });
  assert.ok(!active.some((x) => x.id === 'c2'), 'rejected not in active');
  const match = await db.claims.listForMatch(U);
  assert.ok(match.some((x) => x.id === 'c2'), 'rejected IS in match set (no resurrection)');
});

test('writeSnapshot + readSeries: ASC by window_end, sigmoid confidence, null gaps', async () => {
  await db.claims.writeSnapshot({ userId: U, claimId: 'c1', windowStart: '2026-05-25T00:00:00Z',
    windowEnd: '2026-05-31T00:00:00Z', granularity: 'week', confidenceLogodds: 1.0,
    content: 'allergy', evidenceCount: 1, deltaKind: 'new' });
  await db.claims.writeSnapshot({ userId: U, claimId: 'c1', windowStart: '2026-06-01T00:00:00Z',
    windowEnd: '2026-06-07T00:00:00Z', granularity: 'week', confidenceLogodds: 2.0,
    content: 'allergy', evidenceCount: 3, deltaKind: 'strengthened' });
  // A window with no confidence (honest gap).
  await db.claims.writeSnapshot({ userId: U, claimId: 'c1', windowStart: '2026-06-08T00:00:00Z',
    windowEnd: '2026-06-14T00:00:00Z', granularity: 'week', confidenceLogodds: null,
    content: null, evidenceCount: 0, deltaKind: 'stable' });

  const series = await db.claims.readSeries(U, 'c1', 'week');
  assert.equal(series.length, 3);
  assert.deepEqual(series.map((s) => s.windowEnd),
    ['2026-05-31T00:00:00Z', '2026-06-07T00:00:00Z', '2026-06-14T00:00:00Z']);
  assert.ok(Math.abs(series[1].confidence - 1 / (1 + Math.exp(-2.0))) < 1e-9);
  assert.equal(series[2].confidence, null, 'null confidence → null (line breaks)');
  assert.equal(series[1].deltaKind, 'strengthened');
});

test('writeSnapshot upserts on UNIQUE(window_end, granularity) — updates, no dup', async () => {
  await db.claims.writeSnapshot({ userId: U, claimId: 'c1', windowStart: '2026-06-01T00:00:00Z',
    windowEnd: '2026-06-07T00:00:00Z', granularity: 'week', confidenceLogodds: 2.7,
    content: 'allergy', evidenceCount: 5, deltaKind: 'strengthened' });
  const series = await db.claims.readSeries(U, 'c1', 'week');
  const w = series.filter((s) => s.windowEnd === '2026-06-07T00:00:00Z');
  assert.equal(w.length, 1, 'no duplicate window');
  assert.equal(w[0].evidenceCount, 5, 'updated in place');
});

test('lastSnapshotWindow returns MAX window_end for the heartbeat', async () => {
  assert.equal(await db.claims.lastSnapshotWindow(U, 'week'), '2026-06-14T00:00:00Z');
  assert.equal(await db.claims.lastSnapshotWindow(U, 'quarter'), null);
});
