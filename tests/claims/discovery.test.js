// tests/claims/discovery.test.js — per-window claim discovery. Boots a real
// vault for db.claims; stubs infer + validate (no live model). Asserts the
// lifecycle: create → re-evidence strengthens → tombstone never resurrects →
// unsupported/no-evidence are no-ops.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../../src/index.js';
import { applyMigrations } from '../../src/db/migrate.js';
import { discoverWindow, contentHash, similarity, parseProposals } from '../../src/claims/discovery.js';

const DB = 'data/test-claims-discovery.db', KCV = 'data/test-claims-discovery-kcv.json';
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
after(() => { try { close?.(); } catch {} for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} } });

const EV = [
  { id: 'm1', content: 'I went hiking with friends on Saturday and loved it.' },
  { id: 'm2', content: 'Spent the afternoon outdoors cycling, felt great.' },
];
const W = { windowStart: '2026-06-01T00:00:00Z', windowEnd: '2026-06-07T00:00:00Z', granularity: 'week' };
const inferOnce = (proposals) => async () => JSON.stringify(proposals);
const support = async () => ({ omega: 1.0, relation: 'strong_support' });

test('pure helpers: contentHash stable, similarity, parseProposals', () => {
  assert.equal(contentHash('Hello, World!'), contentHash('hello world'));
  assert.ok(similarity('values outdoor activity', 'the user values outdoor activity') > 0.5);
  assert.equal(parseProposals('garbage').length, 0);
  assert.equal(parseProposals('[{"type":"value","content":"x","support":["m1"]}]').length, 1);
});

test('no evidence → no-op, no snapshot (honest gap)', async () => {
  const r = await discoverWindow({ db, userId: U, infer: inferOnce([]), validate: support, evidence: [], ...W });
  assert.deepEqual(r, { created: 0, updated: 0, skipped: 0, claims: [] });
});

test('new proposal → creates a claim + snapshot delta=new', async () => {
  const r = await discoverWindow({
    db, userId: U, validate: support, evidence: EV, ...W,
    infer: inferOnce([{ type: 'value', content: 'The user values outdoor activity with friends.', support: ['m1', 'm2'] }]),
  });
  assert.equal(r.created, 1);
  const claims = await db.claims.listActive(U, { limit: 10 });
  assert.equal(claims.length, 1);
  assert.match(claims[0].content, /outdoor activity/);
  const series = await db.claims.readSeries(U, claims[0].id, 'week');
  assert.equal(series.length, 1);
  assert.equal(series[0].deltaKind, 'new');
  assert.ok(series[0].confidence > 0.5);
});

test('re-evidence in a later window strengthens the same claim (delta=strengthened)', async () => {
  const before = (await db.claims.listActive(U, { limit: 10 }))[0];
  const r = await discoverWindow({
    db, userId: U, validate: support, evidence: EV,
    windowStart: '2026-06-08T00:00:00Z', windowEnd: '2026-06-14T00:00:00Z', granularity: 'week',
    infer: inferOnce([{ type: 'value', content: 'The user values outdoor activity with friends.', support: ['m1'] }]),
  });
  assert.equal(r.updated, 1);
  assert.equal(r.created, 0, 'must match the existing claim, not create a duplicate');
  const after = await db.claims.getById(U, before.id);
  assert.ok(after.confidenceLogodds > before.confidenceLogodds, 'support raises confidence');
  const series = await db.claims.readSeries(U, before.id, 'week');
  assert.equal(series.length, 2);
  assert.equal(series[1].deltaKind, 'strengthened');
});

test('a rejected tombstone is never resurrected', async () => {
  const content = 'The user dislikes all social events.';
  await db.claims.upsert({ id: 'rej', userId: U, claimType: 'personality', content,
    confidenceLogodds: 0.1, decayClass: 'preference', contentHash: contentHash(content),
    status: 'rejected', lastEvidenceAt: '2026-05-01T00:00:00Z' });
  const r = await discoverWindow({
    db, userId: U, validate: support, evidence: EV, ...W,
    infer: inferOnce([{ type: 'personality', content, support: ['m1'] }]),
  });
  assert.equal(r.skipped, 1);
  assert.equal(r.created, 0);
  assert.equal((await db.claims.getById(U, 'rej')).status, 'rejected', 'stays rejected');
});

test('proposal with no support is skipped (never write an unsupported claim)', async () => {
  const r = await discoverWindow({
    db, userId: U, validate: support, evidence: EV, ...W,
    infer: inferOnce([{ type: 'value', content: 'A claim with no evidence.', support: [] }]),
  });
  assert.equal(r.skipped, 1);
  assert.equal(r.created, 0);
});

test('infer throwing → fail-open no-op (Tier-3: no local model)', async () => {
  const r = await discoverWindow({
    db, userId: U, validate: support, evidence: EV, ...W,
    infer: async () => { throw new Error('ollama down'); },
  });
  assert.deepEqual(r, { created: 0, updated: 0, skipped: 0, claims: [] });
});
