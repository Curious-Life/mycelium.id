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
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
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

  // ── M7: ON-BOX task (categorize) stores a LOCAL model NAME — no providerId, no provider row ──
  const j = (r) => r.json();
  const setLabel = await fetch(`${base}/providers/task-models`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: 'categorize', model: 'qwen3.5:4b' }) });
  const afterSet = await j(await fetch(`${base}/providers/task-models`));
  const cat = afterSet?.taskModels?.categorize;
  rec('M7a. categorize stores { model } only — no providerId (on-box, no provider row needed)',
    setLabel.status === 200 && cat?.model === 'qwen3.5:4b' && cat?.providerId === undefined, `cat=${JSON.stringify(cat)}`);
  // Invalid model name rejected (defense in depth — value later feeds localInfer as a model tag).
  const badName = await fetch(`${base}/providers/task-models`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: 'categorize', model: 'rm -rf /; evil model' }) });
  rec('M7b. invalid labeling model name → 400 (shape-validated)', badName.status === 400, `status=${badName.status}`);
  // Path-traversal-shaped name rejected even though '/' is legal for Ollama namespaces (defense in depth).
  const badTraversal = await fetch(`${base}/providers/task-models`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: 'categorize', model: '../../etc/passwd' }) });
  rec('M7b2. path-traversal-shaped labeling model name → 400 (no ".." )', badTraversal.status === 400, `status=${badTraversal.status}`);
  // Empty model clears → NOT approved. (This said "the drainer's default takes over" until
  // 2026-07-16; that implicit fallback WAS the bug increment M removed — nothing pulls, nothing runs.)
  await fetch(`${base}/providers/task-models`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: 'categorize', model: '' }) });
  const afterClear = await j(await fetch(`${base}/providers/task-models`));
  rec('M7c. empty labeling model clears the assignment → NOT approved (nothing pulls/runs)',
    afterClear?.taskModels?.categorize === undefined, `cat=${JSON.stringify(afterClear?.taskModels?.categorize)}`);
  // M7d: 'enrich' is ALSO on-box — must store { model } (a local name the drainer reads),
  // not a cloud { providerId } it would silently ignore. Regression guard for the bug fix.
  const setEnrich = await fetch(`${base}/providers/task-models`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: 'enrich', model: 'qwen3.5:4b' }) });
  const afterEnrich = await j(await fetch(`${base}/providers/task-models`));
  rec('M7d. enrich is on-box → stores { model }, no providerId; GET exposes onboxTasks incl. enrich',
    setEnrich.status === 200 && afterEnrich?.taskModels?.enrich?.model === 'qwen3.5:4b'
    && afterEnrich?.taskModels?.enrich?.providerId === undefined
    && Array.isArray(afterEnrich?.onboxTasks) && afterEnrich.onboxTasks.includes('enrich') && afterEnrich.onboxTasks.includes('categorize'),
    `enrich=${JSON.stringify(afterEnrich?.taskModels?.enrich)} onbox=${JSON.stringify(afterEnrich?.onboxTasks)}`);
  // ── M6/M7: assign by FUNCTION — one approval, every task the function owns ──────────
  // The Intelligence screen (§3.11) assigns by function, and Understanding owns BOTH
  // categorize and enrich. While the ONLY way to assign was per-task, a vault could approve
  // categorize and leave enrich unset ⇒ L2 (entities + gist) sat SILENTLY DEAD with no surface
  // reporting it (M's re-review). These drive the REAL route.
  const putJson = (body) => fetch(`${base}/providers/task-models`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  {
    // Start clean: clear both on-box tasks via the per-task path.
    await putJson({ task: 'categorize', model: '' });
    await putJson({ task: 'enrich', model: '' });
    const r = await putJson({ function: 'understanding', model: 'qwen3.5:4b' });
    const after = await (await fetch(`${base}/providers/task-models`)).json();
    rec('M8. ⭐ approving the `understanding` FUNCTION writes BOTH categorize and enrich (one approval)',
      r.status === 200
      && after?.taskModels?.categorize?.model === 'qwen3.5:4b'
      && after?.taskModels?.enrich?.model === 'qwen3.5:4b',
      `status=${r.status} categorize=${JSON.stringify(after?.taskModels?.categorize)} enrich=${JSON.stringify(after?.taskModels?.enrich)}`);
  }
  {
    // Clearing a function un-approves BOTH — declining must be as atomic as approving.
    const r = await putJson({ function: 'understanding', model: '' });
    const after = await (await fetch(`${base}/providers/task-models`)).json();
    rec('M8b. clearing the function un-approves BOTH (declining is atomic too)',
      r.status === 200 && !after?.taskModels?.categorize && !after?.taskModels?.enrich,
      `categorize=${JSON.stringify(after?.taskModels?.categorize)} enrich=${JSON.stringify(after?.taskModels?.enrich)}`);
  }
  {
    // An INVALID model must reject the whole function — never half-apply (categorize set,
    // enrich rejected) — because a half-applied function IS the split this route exists to end.
    await putJson({ function: 'understanding', model: 'qwen3.5:4b' });   // both approved
    const r = await putJson({ function: 'understanding', model: '../etc/passwd' });
    const after = await (await fetch(`${base}/providers/task-models`)).json();
    rec('M9. ⭐ an invalid model rejects the WHOLE function — no half-applied split',
      r.status === 400
      && after?.taskModels?.categorize?.model === 'qwen3.5:4b'
      && after?.taskModels?.enrich?.model === 'qwen3.5:4b',
      `status=${r.status} categorize=${JSON.stringify(after?.taskModels?.categorize)} enrich=${JSON.stringify(after?.taskModels?.enrich)}`);
  }
  {
    const r = await putJson({ function: 'no-such-function', model: 'x' });
    rec('M9b. an unknown function → 400 (fail-closed, never a silent no-op)', r.status === 400, `status=${r.status}`);
  }
  {
    // ⭐ M9e — THE ATOMICITY MECHANISM, PINNED. The fan-out is atomic because the route builds
    // the whole next state and writes it ONCE. That invariant was documented in a comment and
    // pinned by NOTHING: a reviewer moved `updateSettings` inside the loop and every gate stayed
    // GO (2026-07-16). The same commit pinned its OTHER invariant (F6b: "so the drift is
    // impossible rather than reviewed-for") — that standard belongs here too.
    // A write-count spy distinguishes them exactly: one write ⇒ atomic; per-target writes ⇒ 2.
    const realUpdate = db.users.updateSettings.bind(db.users);
    let writes = 0;
    db.users.updateSettings = async (...a) => { writes += 1; return realUpdate(...a); };
    try {
      await putJson({ function: 'understanding', model: 'qwen3.5:4b' });
    } finally {
      db.users.updateSettings = realUpdate;
    }
    rec('M9e. ⭐ a 2-task function persists in exactly ONE write (build-then-write-once = atomic)',
      writes === 1,
      `updateSettings called ${writes}× for a 2-task fan-out — >1 means it can half-apply on a mid-loop failure`);
  }
  {
    // Both keys is a caller bug. Silently honouring `function` would write two tasks the caller
    // never asked for AND skip the one it did — a precedence footgun with no signal.
    const r = await putJson({ task: 'chat', function: 'understanding', model: 'qwen3.5:4b' });
    const after = await (await fetch(`${base}/providers/task-models`)).json();
    rec('M9c. `task` AND `function` together → 400 (no silent precedence)',
      r.status === 400 && after?.taskModels?.chat?.model !== 'qwen3.5:4b',
      `status=${r.status}`);
  }
  {
    // transcription/voice ARE functions — they just own no INFERENCE_TASK (their rails are
    // whisper's download route + the TTS catalog). "unknown function" would be a lie.
    const r = await putJson({ function: 'transcription', model: 'x' });
    const body = await r.json().catch(() => ({}));
    rec('M9d. a REAL but task-less function (transcription) → 400 that says WHY, not "unknown"',
      r.status === 400 && /no inference task/i.test(body?.error || ''),
      `status=${r.status} error=${body?.error}`);
  }
  srv.close();
} catch (e) { rec('FATAL', false, e.stack || e.message); }
close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — per-task model selection: assign · resolve · narrator-wired · REST · fallback' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
