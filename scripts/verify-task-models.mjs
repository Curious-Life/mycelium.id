// verify:task-models — per-task model selection (Settings → Intelligence).
// A user assigns which configured provider/model handles which task (chat vs
// narrate); unassigned tasks fall back to the ACTIVE provider. Asserts:
//   M1 no assignment → task resolves to the ACTIVE provider (fallback)
//   M2 assign narrate→ProviderB → resolveInferenceConfigForTask('narrate')=B + model override
//   M3 chat stays on the active provider (independent per task)
//   M4 createNarrator uses the 'narrate' assignment (label = B)
//   M5 REST: PUT/GET /providers/task-models round-trips; bad task→400; bad provider→404
//   M6 clear (providerId:null) → narrate falls back to the active provider
// PASS/FAIL ledger; VERDICT GO/NO-GO.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import express from 'express';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { resolveInferenceConfigForTask } from '../src/inference/resolve.js';
import { createNarrator } from '../pipeline/lib/narrate-infer.js';
import { portalProvidersRouter } from '../src/portal-providers.js';

const DB = 'data/verify-task-models.db', KCV = 'data/verify-task-models-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };
const U = 'local-user';
const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');

{ const d = new Database(DB); applyMigrations(d); d.close(); }
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });

try {
  // The settings blob lives on the users row; updateSettings is a plain UPDATE, so
  // a row must exist (the live vault always has one; a fresh test vault does not).
  await db.rawQuery(`INSERT OR IGNORE INTO users (id, type) VALUES (?, 'human')`, [U]);
  // Two cloud providers; A active.
  const provA = await db.providers.create(U, { provider: 'custom', label: 'Active-Provider', authType: 'api_key', baseUrl: 'https://active.example.test/v1' });
  const provB = await db.providers.create(U, { provider: 'custom', label: 'Narrator-Provider', authType: 'api_key', baseUrl: 'https://narrator.example.test/v1' });
  await db.providers.setActive(provA, U);

  // ── M1: no assignment → active ──
  const c0 = await resolveInferenceConfigForTask(db, U, 'narrate');
  rec('M1. no assignment → narrate falls back to ACTIVE provider', c0.label === 'Active-Provider', `label=${c0.label}`);

  // ── M2/M3: assign narrate → B (+ model override), chat stays active ──
  await db.users.updateSettings(U, { taskModels: { narrate: { providerId: provB, model: 'special-narrate-model' } } });
  const cN = await resolveInferenceConfigForTask(db, U, 'narrate');
  rec('M2. narrate assignment resolves to ProviderB + model override',
    cN.label === 'Narrator-Provider' && cN.cloudModel === 'special-narrate-model', `label=${cN.label} model=${cN.cloudModel}`);
  const cC = await resolveInferenceConfigForTask(db, U, 'chat');
  rec('M3. chat (unassigned) stays on the ACTIVE provider', cC.label === 'Active-Provider', `label=${cC.label}`);

  // ── M4: createNarrator uses the narrate assignment ──
  const narrator = await createNarrator({ db, userId: U });
  rec('M4. createNarrator uses the narrate-assigned provider', narrator.label === 'Narrator-Provider', `label=${narrator.label}`);

  // ── M5: REST round-trip + validation ──
  const app = express(); app.use(express.json());
  app.use('/portal', portalProvidersRouter({ db, userId: U }));
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const port = srv.address().port;
  const base = `http://127.0.0.1:${port}/portal`;
  const putRes = await fetch(`${base}/providers/task-models`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: 'chat', providerId: provB }) });
  const getRes = await (await fetch(`${base}/providers/task-models`)).json();
  const badTask = await fetch(`${base}/providers/task-models`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: 'bogus', providerId: provB }) });
  const badProv = await fetch(`${base}/providers/task-models`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: 'narrate', providerId: 999999 }) });
  rec('M5. REST: PUT persists, GET reflects it, bad task→400, bad provider→404',
    putRes.status === 200 && getRes?.taskModels?.chat?.providerId === provB && getRes?.tasks?.includes('narrate') && badTask.status === 400 && badProv.status === 404,
    `put=${putRes.status} getChat=${getRes?.taskModels?.chat?.providerId} badTask=${badTask.status} badProv=${badProv.status}`);

  // ── M6: clear narrate → back to active ──
  await fetch(`${base}/providers/task-models`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: 'narrate', providerId: null }) });
  const cCleared = await resolveInferenceConfigForTask(db, U, 'narrate');
  rec('M6. clearing the narrate assignment → falls back to ACTIVE', cCleared.label === 'Active-Provider', `label=${cCleared.label}`);
  srv.close();
} catch (e) { rec('FATAL', false, e.stack || e.message); }
close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — per-task model selection: assign · resolve · narrator-wired · REST · fallback' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
