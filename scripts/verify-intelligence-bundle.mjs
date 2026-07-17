// verify:intelligence-bundle — the first-run bundle orchestrator (Part I §4.3, A1/A2/A7/W4).
//
// Drives the REAL router (in-process express) with a recording DAL. The write path is the
// real applyTaskModelWrite (portal-providers.js) — never a stub of it: B1's whole claim is
// that the bundle rides the ONE consent mechanism, so the gate must execute that mechanism.
// Only the EDGES are injected (hardware, installed-models probe, disk headroom), each with
// a control arm so a stub can never green a claim its real path would red (the
// gates-fail-on-fixtures discipline).
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { portalIntelligenceRouter, composeBundle } from '../src/portal-intelligence.js';
import { applyTaskModelWrite } from '../src/portal-providers.js';
import { CATALOG } from '../src/hardware/catalog.js';
import { ROLE_RECOMMENDATIONS } from '../src/inference/role-models.js';
import { WHISPER_CATALOG } from '../src/portal-transcription.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const t = async (n, fn) => { try { await fn(); rec(n, true); } catch (e) { rec(n, false, e?.message || String(e)); } };

// ── Fixture DAL: a real settings blob + provider rows, every write recorded ──────────────
function makeDb({ settings = {}, providers = [] } = {}) {
  const store = { settings: structuredClone(settings) };
  const writes = [];
  return {
    store, writes,
    users: {
      getSettings: async () => structuredClone(store.settings),
      updateSettings: async (_u, s) => { writes.push(structuredClone(s)); store.settings = structuredClone(s); },
    },
    providers: {
      list: async () => providers,
      get: async (id) => providers.find((p) => p.id === id) || null,
    },
  };
}
// publicRow-shaped rows AS STORED (base_url drives the server-side jurisdiction — the gate
// must exercise the real parser, so the lookalike host is here on purpose).
const EU_ROW = { id: 1, provider: 'custom', label: 'Regolo (EU)', base_url: 'https://api.regolo.ai/v1' };
const US_ROW = { id: 2, provider: 'openai', label: 'OpenAI (US)', base_url: 'https://api.openai.com/v1' };
const LOOKALIKE = { id: 3, provider: 'custom', label: 'Lookalike', base_url: 'https://localhost.attacker.io/v1' };
const SUB_ROW = { id: 5, provider: 'anthropic', label: 'Claude subscription', auth_type: 'oauth', base_url: null };

const HW32 = async () => ({ cpuName: 'Apple M1', arch: 'arm64', platform: 'darwin', totalRamGb: 32, hasGpu: true, backend: 'metal' });
const HW8 = async () => ({ cpuName: 'Apple M1', arch: 'arm64', platform: 'darwin', totalRamGb: 8, hasGpu: true, backend: 'metal' });
const NOTHING_INSTALLED = async () => [];
const OK_DISK = () => ({ ok: true, freeBytes: 500 * 2 ** 30, needBytes: 3 * 2 ** 30, vaultBytes: 0, freeGb: 500, needGb: 3 });
const TIGHT_DISK = () => ({ ok: true, freeBytes: 4 * 2 ** 30, needBytes: 3 * 2 ** 30, vaultBytes: 0, freeGb: 4, needGb: 3 });

async function serve(router) {
  const app = express();
  app.use(express.json());
  app.use('/portal', router);
  const srv = createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/portal`;
  return {
    base, srv,
    get: async (p) => (await fetch(`${base}${p}`)).json(),
    post: async (p, body) => {
      const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      return { status: r.status, body: await r.json() };
    },
    close: () => srv.close(),
  };
}

// The gate's OWN independent total — from the same single-source catalogs, summed here so a
// hardcoded wrong total in the route cannot agree with it by construction (A2 red-test).
const LABEL = ROLE_RECOMMENDATIONS.labeling.model;
const LABEL_GB = CATALOG.find((m) => m.name === LABEL)?.sizeGb;
const TURBO_GB = Math.round((WHISPER_CATALOG.find((c) => c.model === 'large-v3-turbo').sizeMB / 1000) * 10) / 10;
const SMALL_GB = Math.round((WHISPER_CATALOG.find((c) => c.model === 'small').sizeMB / 1000) * 10) / 10;

await t('B2. A2 — the total equals the sum of NOT-YET-INSTALLED recommended sizes (cold vault, 32 GB)', async () => {
  const db = makeDb({ providers: [EU_ROW] });
  const b = await composeBundle({ db, userId: 'u', detect: HW32, listInstalled: NOTHING_INSTALLED, dbPath: '/x/vault.db', headroom: OK_DISK });
  assert.equal(b.totalDownloadGb, Math.round((LABEL_GB + TURBO_GB) * 10) / 10,
    `cold 32 GB vault = labeling(${LABEL_GB}) + whisper turbo(${TURBO_GB}); got ${b.totalDownloadGb}`);
  assert.equal(b.rows.find((r) => r.key === 'search').downloadGb, 0, 'the bundled embedder costs 0 — it ships in the app');
  assert.equal(b.rows.find((r) => r.key === 'descriptions').downloadGb, 0, 'a cloud row downloads nothing');
  assert.equal(b.disk.freeGb, 500, 'W4: the free-disk fact is served with the total');
});

await t('B2b. A2 — the total RECOMPUTES as installs complete (installed model leaves the sum)', async () => {
  const db = makeDb({ providers: [] });
  const b = await composeBundle({ db, userId: 'u', detect: HW32, listInstalled: async () => [LABEL], dbPath: '/x/vault.db', headroom: OK_DISK });
  assert.equal(b.rows.find((r) => r.key === 'understanding').downloadGb, 0, 'an installed labeling model costs 0');
  assert.equal(b.totalDownloadGb, TURBO_GB, `only whisper remains; got ${b.totalDownloadGb}`);
});

await t('B2c. installed is EXACT-tag (a base or :latest near-miss still costs the download)', async () => {
  const db = makeDb({});
  // ollama-tag-semantics: 'qwen3.5:latest' does NOT satisfy 'qwen3.5:4b'.
  const near = LABEL.split(':')[0];
  const b = await composeBundle({ db, userId: 'u', detect: HW32, listInstalled: async () => [near, `${near}:latest`], dbPath: null });
  assert.equal(b.rows.find((r) => r.key === 'understanding').downloadGb, LABEL_GB,
    'a base-name near-miss must not report installed — the exact tag is the model');
});

await t('B2d. the whisper pick follows RAM (8 GB ⇒ small — the §8-S fix, served to the bundle)', async () => {
  const db = makeDb({});
  const b = await composeBundle({ db, userId: 'u', detect: HW8, listInstalled: NOTHING_INSTALLED, dbPath: null });
  const row = b.rows.find((r) => r.key === 'transcription');
  assert.equal(row.model, 'small', `8 GB must get whisper small; got ${row.model}`);
  assert.equal(row.downloadGb, SMALL_GB);
});

await t('B1. ⭐ A1 — one apply writes EVERY assignable function, atomically per function, through the ONE write path', async () => {
  const db = makeDb({ providers: [EU_ROW, SUB_ROW] });
  const s = await serve(portalIntelligenceRouter({ db, userId: 'u', dbPath: '/x/vault.db', detect: HW32, listInstalled: NOTHING_INSTALLED, headroom: OK_DISK, onApplied: () => {} }));
  const { status, body } = await s.post('/intelligence/bundle/apply', {});
  s.close();
  assert.equal(status, 200);
  assert.deepEqual(body.results, {
    understanding: 'approved', transcription: 'download-required',
    descriptions: 'approved', conversation: 'approved',
  }, JSON.stringify(body.results));
  // Understanding fans out to BOTH tasks in ONE settings write (the dormancy fix, M8's claim
  // carried into the bundle): find the write that set categorize and assert enrich is in it.
  const w = db.writes.find((x) => x.taskModels?.categorize);
  assert.ok(w, 'a settings write must carry the understanding approval');
  assert.equal(w.taskModels.categorize.model, LABEL);
  assert.equal(w.taskModels.enrich.model, LABEL, 'categorize and enrich must land in the SAME write — half-applied Understanding is the L2 dormancy bug');
  // Final state: descriptions → the EU provider row; conversation → the subscription row.
  assert.equal(db.store.settings.taskModels.narrate.providerId, EU_ROW.id);
  assert.equal(db.store.settings.taskModels.chat.providerId, SUB_ROW.id);
  // The client owns the downloads, through the routes that already exist:
  assert.deepEqual(body.downloads.map((d) => d.route).sort(),
    ['/portal/hardware/pull', '/portal/transcription/download'].sort());
  // …and apply NEVER writes transcribeModel — /transcription/download is its one writer.
  assert.equal(db.store.settings.transcribeModel, undefined, 'the whisper choice is persisted by its own route, not here');
});

await t('B1b. the write path IS applyTaskModelWrite — behavioural identity on a shared store', async () => {
  // Same fixture, one write through the exported helper, one through the bundle: the stored
  // shapes must be identical. (The import is also structural — this file imports the helper
  // from portal-providers.js, the module the PUT route executes.)
  const dbA = makeDb({ providers: [EU_ROW] });
  await applyTaskModelWrite({ db: dbA, userId: 'u', body: { function: 'understanding', model: LABEL } });
  const dbB = makeDb({ providers: [EU_ROW] });
  const s = await serve(portalIntelligenceRouter({ db: dbB, userId: 'u', dbPath: '/x/vault.db', detect: HW32, listInstalled: NOTHING_INSTALLED, headroom: OK_DISK, onApplied: () => {} }));
  // ⚠️ ADVERSARIAL BODY, not just the happy scope: what was SHOWN is what gets WRITTEN.
  // A client-supplied model/providerId must be IGNORED — the server composes the assignment
  // from its own recommendation. An example-based body here let an injection mutation
  // (`req.body?.model || row.model`) pass 12/12 green (review of this PR, 2026-07-17) —
  // the consent-gates-must-test-HONORED discipline: assert the IDENTITY of what was stored.
  await s.post('/intelligence/bundle/apply', { functions: ['understanding'], model: 'evil:latest', providerId: 999 });
  s.close();
  assert.deepEqual(dbB.store.settings.taskModels, dbA.store.settings.taskModels,
    'the bundle write and the PUT-route write must produce byte-identical settings — two mechanisms is how consent drifts');
  const stored = JSON.stringify(dbB.store.settings.taskModels);
  assert.ok(!stored.includes('evil:latest') && !stored.includes('999'),
    `a client-supplied model/providerId must never reach the store. Stored: ${stored}`);
});

await t('B3. ⭐ A7 — Descriptions is assigned ONLY an eu-zdr provider (server-side jurisdiction, lookalike refused)', async () => {
  // A vault whose only cloud rows are US + a localhost-lookalike: the bundle must SKIP, never
  // assign — and never crash into a fallback.
  const db = makeDb({ providers: [US_ROW, LOOKALIKE] });
  const s = await serve(portalIntelligenceRouter({ db, userId: 'u', dbPath: '/x/vault.db', detect: HW32, listInstalled: NOTHING_INSTALLED, headroom: OK_DISK, onApplied: () => {} }));
  const { body } = await s.post('/intelligence/bundle/apply', { functions: ['descriptions'] });
  s.close();
  assert.equal(body.results.descriptions, 'skipped:no-provider', JSON.stringify(body.results));
  assert.equal(db.store.settings.taskModels?.narrate, undefined, 'nothing may be assigned to narrate');
  // CONTROL: with a genuine EU row present the same arm assigns it (the guard is not a wall).
  const db2 = makeDb({ providers: [US_ROW, LOOKALIKE, EU_ROW] });
  const s2 = await serve(portalIntelligenceRouter({ db: db2, userId: 'u', dbPath: '/x/vault.db', detect: HW32, listInstalled: NOTHING_INSTALLED, headroom: OK_DISK, onApplied: () => {} }));
  await s2.post('/intelligence/bundle/apply', { functions: ['descriptions'] });
  s2.close();
  assert.equal(db2.store.settings.taskModels.narrate.providerId, EU_ROW.id, 'the EU row must be the one assigned');
});

await t('B4. W4 — a can\'t-fit bundle refuses BEFORE any write, structured disk_low', async () => {
  const db = makeDb({ providers: [EU_ROW] });
  const s = await serve(portalIntelligenceRouter({ db, userId: 'u', dbPath: '/x/vault.db', detect: HW32, listInstalled: NOTHING_INSTALLED, headroom: TIGHT_DISK, onApplied: () => {} }));
  const { status, body } = await s.post('/intelligence/bundle/apply', {});
  s.close();
  assert.equal(status, 409);
  assert.equal(body.error, 'disk_low');
  assert.ok(Number.isFinite(body.shortfallGb) && body.shortfallGb > 0, 'the refusal must say how much to free');
  assert.equal(db.writes.length, 0, 'NO write may land before the disk refusal — refuse before bytes, refuse before state');
  // CONTROL: a zero-download scope (descriptions only) is NOT disk-gated — nothing downloads.
  const s2 = await serve(portalIntelligenceRouter({ db, userId: 'u', dbPath: '/x/vault.db', detect: HW32, listInstalled: NOTHING_INSTALLED, headroom: TIGHT_DISK, onApplied: () => {} }));
  const r2 = await s2.post('/intelligence/bundle/apply', { functions: ['descriptions'] });
  s2.close();
  assert.equal(r2.status, 200, 'assigning a cloud provider moves no bytes and must not be disk-refused');
});

await t('B5. consent — an already-set vault re-applies as no-ops: ZERO settings writes', async () => {
  const db = makeDb({
    settings: { taskModels: { categorize: { model: LABEL }, enrich: { model: LABEL }, narrate: { providerId: 1 }, chat: { providerId: 5 } }, transcribeModel: 'small' },
    providers: [EU_ROW, SUB_ROW],
  });
  const s = await serve(portalIntelligenceRouter({ db, userId: 'u', dbPath: '/x/vault.db', detect: HW32, listInstalled: async () => [LABEL], headroom: OK_DISK, onApplied: () => {} }));
  const { body } = await s.post('/intelligence/bundle/apply', {});
  s.close();
  assert.deepEqual(body.results, {
    understanding: 'already-set', transcription: 'already-set',
    descriptions: 'already-set', conversation: 'already-set',
  }, JSON.stringify(body.results));
  assert.equal(db.writes.length, 0, 'a no-op apply must not touch settings — rewriting an unchanged approval is a phantom consent event');
  assert.deepEqual(body.downloads, [], 'nothing left to download');
});

await t('B6. conversation — no subscription ⇒ skipped (the chip is the only path in), with one ⇒ assigned', async () => {
  const db = makeDb({ providers: [EU_ROW] });   // no oauth row
  const s = await serve(portalIntelligenceRouter({ db, userId: 'u', dbPath: '/x/vault.db', detect: HW32, listInstalled: NOTHING_INSTALLED, headroom: OK_DISK, onApplied: () => {} }));
  const { body } = await s.post('/intelligence/bundle/apply', { functions: ['conversation'] });
  s.close();
  assert.equal(body.results.conversation, 'skipped:no-provider');
  assert.equal(db.store.settings.taskModels?.chat, undefined, 'nothing assigned — the tap cannot OAuth for the user (W2)');
});

await t('B7. #206 retry-means-now — a successful apply fires the drainer nudge exactly once', async () => {
  let nudges = 0;
  const db = makeDb({ providers: [EU_ROW] });
  const s = await serve(portalIntelligenceRouter({ db, userId: 'u', dbPath: '/x/vault.db', detect: HW32, listInstalled: NOTHING_INSTALLED, headroom: OK_DISK, onApplied: () => { nudges++; } }));
  await s.post('/intelligence/bundle/apply', { functions: ['understanding'] });
  s.close();
  assert.equal(nudges, 1, 'the approval must be acted on NOW — the trigger-route semantics, not a parallel pull');
});

await t('B8. GET /intelligence/bundle serves the composition over HTTP, content-free', async () => {
  const db = makeDb({ providers: [EU_ROW, SUB_ROW] });
  const s = await serve(portalIntelligenceRouter({ db, userId: 'u', dbPath: '/x/vault.db', detect: HW32, listInstalled: NOTHING_INSTALLED, headroom: OK_DISK, onApplied: () => {} }));
  const b = await s.get('/intelligence/bundle');
  s.close();
  assert.equal(b.ok, true);
  assert.equal(b.rows.length, 4, 'four bundle rows (understanding/search/transcription/descriptions) — conversation + voice are adjacent, never rows (§4.1a)');
  assert.ok(!b.rows.some((r) => r.key === 'voice'), 'W3: Voice stays OUT of the bundle while the render seam is stubbed');
  assert.ok(!b.rows.some((r) => r.key === 'conversation'), 'W2: Conversation is a connect chip, not a bundle row');
  assert.equal(b.adjacent.conversation.subscriptionConnected, true);
  // §1: identifiers + numbers only — serialize and assert no settings-shaped leakage beyond
  // the fields this module composes (spot-check: no credentials/base_url echo).
  const wire = JSON.stringify(b);
  assert.ok(!/credential|api_key|token/i.test(wire), 'no secret-shaped field may cross this boundary');
});

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — the bundle orchestrator: one write path, honest totals, §4g held, disk-refused before bytes' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
