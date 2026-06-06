// verify:claims-discovery — smoke for the discovery CHILD wiring (step-5 glue).
// Boots a seeded vault and runs pipeline/discover-claims.mjs against it. Without
// a local Ollama model the proposal infer() throws → discoverWindow is a no-op →
// the child must exit 0 (Tier-3 FAIL-SOFT), never crash, and write no malformed
// rows. With a model present it would additionally write claims (not asserted
// here — that needs Tier-3). Also asserts the in-process runDiscovery path with a
// STUBBED model actually persists a claim end-to-end (proving the wiring, not the
// model). PASS/FAIL ledger. See docs/PERSONA-CLAIMS-DESIGN-2026-06-06.md.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { runDiscovery } from '../pipeline/discover-claims.mjs';
import { previousCompleteWindow } from '../src/claims/windows.js';
import { createContextDomain } from '../src/tools/context.js';

const DB = 'data/verify-claims-discovery.db', KCV = 'data/verify-claims-discovery-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const U = 'local-user';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

// Seed a handful of messages inside yesterday's (the 'day' cadence) window.
const w = previousCompleteWindow(Date.now(), 'day');
const mid = new Date(Date.parse(w.windowStart) + 12 * 3600 * 1000).toISOString();
const SEED = [
  'Went hiking with friends this morning and it felt restorative.',
  'Cycled along the coast in the afternoon — outdoors is my happy place.',
  'Turned down a noisy indoor party to stay outside instead.',
];
for (let i = 0; i < SEED.length; i++) {
  await db.rawQuery(
    `INSERT INTO messages (id, user_id, role, content, created_at) VALUES (?,?,?,?,?)`,
    [`m-${i}`, U, 'user', SEED[i], mid]);
}

try {
  // ── D1. in-process runDiscovery with a STUBBED model persists a claim ───────
  const infer = async () => JSON.stringify([
    { type: 'value', content: 'The user values spending time outdoors.', support: ['m-0', 'm-1'] },
  ]);
  const validate = async () => ({ omega: 1.0, relation: 'strong_support' });
  const summary = await runDiscovery({ db, userId: U, infer, validate, cadences: ['day'] });
  rec('D1. runDiscovery (stubbed model) creates a claim for the day window',
    summary.day && summary.day.created === 1, `summary.day=${JSON.stringify(summary.day)}`);
  const claims = await db.claims.listActive(U, { limit: 10 });
  rec('D2. claim persisted with support + a snapshot at the window',
    claims.length === 1 && /outdoors/.test(claims[0].content) && Array.isArray(claims[0].support?.messages),
    claims[0] ? `content="${claims[0].content.slice(0, 48)}" support=${claims[0].support?.messages?.length}` : 'no claim');
  const series = await db.claims.readSeries(U, claims[0].id, 'day');
  rec('D3. snapshot series has one window with delta=new', series.length === 1 && series[0].deltaKind === 'new',
    series[0] ? `delta=${series[0].deltaKind} conf=${series[0].confidence?.toFixed?.(3)}` : 'no series');

  // ── D3b. getContext graft surfaces the claim as a support path ──────────────
  {
    const { handlers } = createContextDomain({ getDb: () => db, readMindFile: async () => null, userId: U });
    const brief = await handlers.getContext({ include: ['claims'] });
    rec('D3b. getContext({include:[claims]}) renders the claim section',
      /WHAT YOU'VE LEARNED ABOUT THEM/.test(brief) && /\[Claim\].*outdoors/.test(brief),
      brief.split('\n').find((l) => /\[Claim\]/.test(l)) || 'no claim line');
  }

  // ── D4. the real CHILD process is FAIL-SOFT without a model (exit 0) ─────────
  // (If Ollama happens to be running, it may instead write claims — also exit 0.)
  const run = spawnSync('node', ['pipeline/discover-claims.mjs', '--cadence=day'], {
    encoding: 'utf8',
    env: { ...process.env, MYCELIUM_DB: DB, MYCELIUM_USER_ID: U, USER_MASTER: userHex, SYSTEM_KEY: systemHex },
  });
  rec('D4. discover-claims.mjs child exits 0 (Tier-3 fail-soft, no crash)',
    run.status === 0, run.status !== 0 ? (run.stderr || run.stdout || '').slice(-400) : (run.stdout.trim().split('\n').pop() || ''));
} finally {
  close();
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — discovery wiring persists claims (stubbed model) + child is Tier-3 fail-soft' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
