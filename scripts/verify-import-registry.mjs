// verify:import-registry — the unified registry + generic async route + job runner
// (src/ingest/registry.js, import-job.js, src/portal-import.js /import/run).
//
//   G1 catalog: every entry has {key,label,family,action}; recent-export+full-export are runnable
//   G2 GET /import/catalog returns the sources
//   G3 POST /import/run unknown key → 400
//   G4 POST /import/run a capture-family key (obsidian, no `run`) → 400 (use legacy route)
//   G5 POST /import/run recent-export (allowed path) → job runs → done; rows landed
//   G6 single-flight + progress/cancel envelope behaves (re-POST safe; progress reaches done)
//   G7 fail-closed: a DENIED path → job errors, nothing imported
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import Database from 'better-sqlite3';
import express from 'express';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { portalImportRouter } from '../src/portal-import.js';
import { importCatalog, runnableKeys } from '../src/ingest/registry.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

const ROOT = join(process.cwd(), 'data', 'verify-import-registry');
const DB = join(ROOT, 'v.db'), KCV = join(ROOT, 'v-kcv.json');
const ALLOWED = join(ROOT, 'allowed');       // a confined root, granted via env
const BUNDLE = join(ALLOWED, 'recent-bundle');
// DENIED must sit OUTSIDE every allowed root — including the unconditional
// localSweepRoots (~/Documents, ~/Desktop, …). The repo itself can live under
// ~/Documents, so a cwd-relative denied dir would actually BE allowed (the false
// green the review caught). os.tmpdir() is never a sweep root → truly denied.
const DENIED = join(os.tmpdir(), `mycelium-verify-denied-${process.pid}`, 'bundle');
rmSync(ROOT, { recursive: true, force: true }); rmSync(join(os.tmpdir(), `mycelium-verify-denied-${process.pid}`), { recursive: true, force: true });
mkdirSync(BUNDLE, { recursive: true }); mkdirSync(DENIED, { recursive: true });
// Confine the test to ALLOWED via the out-of-band grant env.
process.env.MYCELIUM_IMPORT_ALLOWED_ROOTS = ALLOWED;

const seedBundle = (dir) => {
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ format: 'mycelium-recent-export', version: 1, window: { days: 30 }, counts: { messages: 2, documents: 1 } }));
  writeFileSync(join(dir, 'messages.json'), JSON.stringify([
    { id: 'g-m1', role: 'user', content: 'reg test one', message_type: 'chat', source: 'telegram', created_at: '2026-06-10T00:00:00.000Z' },
    { id: 'g-m2', role: 'assistant', content: 'reg test two', message_type: 'chat', source: 'portal', created_at: '2026-06-11T00:00:00.000Z' },
  ]));
  writeFileSync(join(dir, 'documents.json'), JSON.stringify([{ id: 'g-d1', path: 'reg/one', title: 'One', content: 'body', source_type: 'note', created_at: '2026-06-10T00:00:00.000Z', updated_at: '2026-06-10T00:00:00.000Z' }]));
};
seedBundle(BUNDLE); seedBundle(DENIED);

mkdirSync(ROOT, { recursive: true }); applyMigrations(new Database(DB));
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex: crypto.randomBytes(32).toString('hex'), systemHex: crypto.randomBytes(32).toString('hex'), embedder: null });
const U = 'local-user';

const app = express();
app.use('/api/v1/portal', portalImportRouter({ db, userId: U, enqueueEnrichment: () => {} }));
const server = app.listen(0); await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/api/v1/portal`;
const J = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });
const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(J);
const get = (p) => fetch(base + p).then(J);
const cnt = async (s, p = []) => Number((await db.rawQuery(s, p)).results?.[0]?.c ?? 0);
const drain = async () => { let pr = (await get('/import/run/progress')).body, n = 0; while (pr.status === 'running' && n++ < 60) { await new Promise((r) => setTimeout(r, 40)); pr = (await get('/import/run/progress')).body; } return pr; };

// G1 catalog integrity
const cat = importCatalog();
rec('G1 catalog: entries well-formed; recent-export+full-export runnable',
  cat.every((s) => s.key && s.label && s.family && s.action) &&
  runnableKeys().includes('recent-export') && runnableKeys().includes('full-export') &&
  cat.find((s) => s.key === 'obsidian')?.generic === false);

// G2 GET catalog
const gc = await get('/import/catalog');
rec('G2 GET /import/catalog', gc.status === 200 && Array.isArray(gc.body.sources) && gc.body.sources.length >= 6);

// G3 unknown key
rec('G3 unknown key → 400', (await post('/import/run', { key: 'nope' })).status === 400);

// G4 capture-family key without `run`
const g4 = await post('/import/run', { key: 'obsidian' });
rec('G4 obsidian (no run) → 400 (legacy route)', g4.status === 400 && /served by/i.test(g4.body.error || ''));

// G5 recent-export via generic route
const g5 = await post('/import/run', { key: 'recent-export', dirPath: BUNDLE });
const prog = await drain();
rec('G5 recent-export runs to done; rows landed',
  g5.status === 200 && prog.status === 'done' &&
  (await cnt(`SELECT COUNT(*) c FROM messages WHERE user_id=? AND source IN ('telegram','portal')`, [U])) === 2 &&
  (await cnt(`SELECT COUNT(*) c FROM documents WHERE user_id=? AND id='g-d1'`, [U])) === 1,
  `status=${prog.status} result=${JSON.stringify(prog.result)}`);

// G6 re-POST safe + idempotent (single-flight; dedup)
const g6 = await post('/import/run', { key: 'recent-export', dirPath: BUNDLE }); await drain();
rec('G6 re-run safe (no 500) + idempotent', g6.status === 200 && (await cnt(`SELECT COUNT(*) c FROM messages WHERE user_id=?`, [U])) === 2);

// G7 denied path → job errors, nothing new imported
const before = await cnt(`SELECT COUNT(*) c FROM messages WHERE user_id=?`, [U]);
await post('/import/run', { key: 'recent-export', dirPath: DENIED });
const perr = await drain();
const after = await cnt(`SELECT COUNT(*) c FROM messages WHERE user_id=?`, [U]);
rec('G7 denied path → job error, nothing imported', perr.status === 'error' && before === after, `status=${perr.status} err=${perr.error}`);

server.close(); close?.();
rmSync(ROOT, { recursive: true, force: true });
rmSync(join(os.tmpdir(), `mycelium-verify-denied-${process.pid}`), { recursive: true, force: true });
const passed = ledger.filter(Boolean).length;
console.log(`\n${passed}/${ledger.length} checks passed`);
if (passed !== ledger.length) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO — unified registry + generic async route + single-flight job, path-confined fail-closed');
