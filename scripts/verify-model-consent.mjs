// verify:model-consent — the recommended set: nothing downloads until the owner approves it.
// DATA-READINESS-DESIGN-2026-07-15 §3.10 + §7 (M1-M4).
//
// THE FINDING THIS ENFORCES: three of the four local models already required consent —
// embedding is BUNDLED with the app (can't be declined, can't be downloaded), whisper and
// Qwen3-TTS voice are click-to-download with byte-accurate progress. Labeling was the lone offender:
// the drainer silently pulled qwen3.5:4b (3.4GB) — and, via ensureUp()'s autoInstall, the
// Ollama RUNTIME with it — unprompted, log-only, with no way to decline. This gate makes
// the outlier behave like the majority.
//
//   M1  no approval ⇒ ollama.pullModel is NEVER called
//   M2  no approval ⇒ the Ollama BINARY is not auto-installed either (the 2nd silent path)
//   M3  approval ⇒ the pull runs, publishes a `model-pull` feed row with pct, content-free
//   M4  declining is a SUPPORTED CONFIG — the vault still works; labeler.status='no_model'
//   M9  L2 enrichment is REPORTED — `taskModels.enrich` is its own setting, so "approved
//       labeling, declined enrich" was dormant AND silent (no readiness member, no projection)
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.ENCRYPTION_MASTER_KEY ||= crypto.randomBytes(32).toString('hex');

const { startEnrichDrainer, getLabelerHealth, getEnricherHealth, defaultLabelModel } = await import('../src/enrich/drainer.js');
// M11 pins the route to these — the SAME modules server-rest.js wires into createReadiness.
const { getEmbedderHealth: readinessEmbedderHealth } = await import('../src/embed/supervisor.js');
const { getTranscriberHealth: readinessTranscriberHealth } = await import('../src/transcribe/supervisor.js');
const { createReadiness } = await import('../src/readiness.js');
const { labelingRecommendedModel } = await import('../src/inference/role-models.js');
const { DEFAULT_LABEL_MODEL } = await import('../src/enrich/categories.js');

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
async function t(n, fn) { try { await fn(); rec(n, true); } catch (e) { rec(n, false, e?.message || String(e)); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, timeoutMs = 3000, stepMs = 10) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await pred()) return true; await sleep(stepMs); }
  return false;
}

const BIG = 10_000_000;                      // disable the interval; the BOOT cycle does the work
const healthyEmbed = { async health() { return { status: 'ok', loaded: true, dim: 768 }; }, async embed() { return null; } };
const classify = async () => ({ domain: 'Mind & Growth', register: 'Inquiry', subregister: 'Map' });

// A vault with pending L1 work. `approved` = settings.taskModels.categorize.model — which
// IS the consent (§3.10c: the approval is the model setting; there is no separate flag).
function makeDb(pendingIds, { approved = null } = {}) {
  const cats = new Map(pendingIds.map((id) => [id, { id, content: `row ${id}`, categories_processed: 0 }]));
  return {
    db: {
      users: { getSettings: async () => (approved ? { taskModels: { categorize: { model: approved }, enrich: { model: approved } } } : {}) },
      async rawQuery() { return { rows: [] }; },
      messages: {
        async selectPendingEnrichment() { return []; },
        async updateEnrichment() {},
        async selectPendingNlp() { return []; },
        async updateNlp() {},
        async selectPendingCategories(_u, { limit = 25 } = {}) { return [...cats.values()].filter((r) => r.categories_processed === 0).slice(0, limit); },
        async updateCategories(id, _u, patch) { const r = cats.get(id); if (r && patch.categoriesProcessed !== undefined) r.categories_processed = patch.categoriesProcessed; },
      },
    },
    taggedCount: () => [...cats.values()].filter((r) => r.categories_processed === 1).length,
  };
}
// ensureUp() is the SECOND silent path: ollama-daemon.js runs with autoInstall = true, so
// waking the daemon downloads and installs the Ollama BINARY. Counting ensureUp calls is
// therefore counting runtime installs.
const makeDaemon = () => { const s = { calls: 0, async ensureUp() { s.calls++; return { ok: true, running: true }; } }; return s; };
const makeOllama = ({ installed = [], pullOk = true, bytes = 3_400_000_000, pullMs = 5 } = {}) => {
  const s = {
    listCalls: 0, pullCalls: 0, pulled: [], installed: [...installed],
    async listInstalled() { s.listCalls++; return [...s.installed]; },
    async pullModel(name, onProgress) {
      s.pullCalls++; s.pulled.push(name);
      // ollama streams { status, completed, total } per layer — byte-accurate, like whisper's.
      onProgress?.({ status: 'pulling', completed: bytes / 2, total: bytes });
      await sleep(pullMs);
      if (!pullOk) throw new Error(`pull of ${name} failed: /Users/owner/.ollama blew up`);
      onProgress?.({ status: 'pulling', completed: bytes, total: bytes });
      s.installed.push(name);
      return true;
    },
  };
  return s;
};
function mkFeed() {
  const calls = { begin: [], heartbeat: [], finish: [] };
  return { calls, async begin(a) { calls.begin.push(a); return a.id; }, async heartbeat(id, a) { calls.heartbeat.push({ id, ...a }); }, async finish(id, a) { calls.finish.push({ id, ...a }); } };
}

// ── M1 + M2) THE CONSENT GATE ────────────────────────────────────────────────
await t('M1. NO approval ⇒ ollama.pullModel is NEVER called (no silent 3.4GB)', async () => {
  const { db, taggedCount } = makeDb(['a', 'b', 'c']);          // fresh vault: nothing approved
  const daemon = makeDaemon(); const ollama = makeOllama();
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon, ollama, log: () => {} });
  await sleep(200);
  d.stop?.();
  assert.equal(ollama.pullCalls, 0, 'a fresh vault must download NOTHING until the owner approves it');
  assert.equal(ollama.listCalls, 0, 'it must not even probe — no approval means no interest in the model');
  assert.equal(taggedCount(), 0, 'and labeling stays paused, honestly (§3.5: a legitimate steady state)');
});

await t('M2. NO approval ⇒ the Ollama RUNTIME is not auto-installed either (the 2nd silent path)', async () => {
  const { db } = makeDb(['a', 'b', 'c']);
  const daemon = makeDaemon(); const ollama = makeOllama();
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon, ollama, log: () => {} });
  await sleep(200);
  d.stop?.();
  // ensureUp() auto-INSTALLS the binary (ollama-daemon.js autoInstall = true) and runs BEFORE
  // the model pull is considered — so gating only the pull would still fetch a runtime unasked.
  assert.equal(daemon.calls, 0,
    'ensureUp() must not be called: it installs the Ollama binary, so the gate has to sit ABOVE the wake');
});

// ── M3) approval ⇒ it runs, and it is VISIBLE ────────────────────────────────
await t('M3. approval ⇒ the pull runs and publishes a `model-pull` feed row with pct', async () => {
  const { db } = makeDb(['a', 'b', 'c'], { approved: 'qwen3.5:4b' });
  const daemon = makeDaemon(); const ollama = makeOllama({ installed: [] }); const feed = mkFeed();
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: 60, embed: healthyEmbed, classify, daemon, ollama, activityFeed: feed, log: () => {} });
  await waitFor(() => feed.calls.finish.length > 0);
  d.stop?.();
  assert.ok(ollama.pulled.includes('qwen3.5:4b'), 'the approved model is what gets pulled');
  assert.equal(feed.calls.begin.length, 1, 'the download publishes to the ONE progress surface (it was log-only ⇒ invisible)');
  assert.equal(feed.calls.begin[0].kind, 'model-pull', '§3.10e: a `model-pull` kind, exactly as D added `import`');
  assert.equal(feed.calls.begin[0].model, 'qwen3.5:4b', 'the model NAME is publishable — an identifier, never user content');
  const beat = feed.calls.heartbeat.at(-1);
  assert.ok(beat && beat.totalSteps > 0 && beat.step > 0, 'byte-accurate progress rides the feed (pct, ETA) — not a spinner');
  assert.equal(feed.calls.finish[0].status, 'done');
});

await t('M3b. a FAILED pull publishes a CONSTANT, never the reason (the row is content-free by contract)', async () => {
  const { db } = makeDb(['a'], { approved: 'qwen3.5:4b' });
  const daemon = makeDaemon(); const ollama = makeOllama({ installed: [], pullOk: false }); const feed = mkFeed();
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon, ollama, activityFeed: feed, log: () => {} });
  await waitFor(() => feed.calls.finish.length > 0);
  d.stop?.();
  const published = JSON.stringify(feed.calls);
  assert.equal(feed.calls.finish[0].status, 'error', 'the FACT of failure is publishable');
  assert.equal(feed.calls.finish[0].error, 'download failed', 'the feed gets a CONSTANT — background_jobs is content-free by contract');
  assert.ok(!published.includes('/Users/owner'), 'a PATH out of an ollama error must never land in a content-free row');
});

await t('M3c. the pull is published EXACTLY once, not once per drain tick', async () => {
  const { db } = makeDb(['a', 'b'], { approved: 'qwen3.5:4b' });
  const daemon = makeDaemon();
  // ⚠️ pullMs MUST outlast intervalMs. This check was VACUOUS: the pull took 5ms against a
  // 20ms tick, so it finished before tick 2 and `_modelReady` short-circuited — the IN-FLIGHT
  // guard was never reached, and deleting it left the gate printing GO 9/9 (proven by the
  // independent reviewer's mutation, 2026-07-16). A real 3.4GB pull takes MINUTES against a
  // 15s tick, so the in-flight guard is the only thing standing between the user and a
  // re-pull per tick. Now the fixture models that.
  const ollama = makeOllama({ installed: [], pullMs: 300 });
  const feed = mkFeed();
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: 20, embed: healthyEmbed, classify, daemon, ollama, activityFeed: feed, log: () => {} });
  await waitFor(() => feed.calls.finish.length > 0, 4000);
  await sleep(120);                       // several more ticks after it is installed
  d.stop?.();
  assert.equal(ollama.pullCalls, 1, 'the IN-FLIGHT guard must keep a 3.4GB download single-flight across ticks (≈15 ticks elapse during a real pull)');
  assert.equal(feed.calls.begin.length, 1, 'and one feed row per attempt — not one per tick');
});

await t('M3d. a RESTART does not reuse the feed id (it would erase the failed attempt)', async () => {
  // begin() is `ON CONFLICT(id) DO UPDATE SET status='running', finished_at=NULL, error=NULL`,
  // so ANY id reuse reopens the previous attempt's row and wipes its error. The first fix here
  // used a closure-local counter, which resets to 0 on every app restart — so boot 2's first
  // attempt re-minted boot 1's id and erased its failure. A persistent failure (disk full, no
  // network) is EXACTLY the case that retries across a restart, so the counter failed precisely
  // where it was needed (proven by a two-boot probe, re-review 2026-07-16).
  const ids = [];
  const feed = { calls: { begin: [], heartbeat: [], finish: [] },
    async begin(a) { ids.push(a.id); return a.id; }, async heartbeat() {}, async finish() {} };
  for (const boot of [1, 2]) {                       // two SEPARATE drainer instances = two boots
    const { db } = makeDb(['a'], { approved: 'qwen3.5:4b' });
    const ollama = makeOllama({ installed: [], pullOk: false });   // fails, so boot 2 retries
    const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon: makeDaemon(), ollama, activityFeed: feed, log: () => {} });
    await waitFor(() => ids.length === boot);
    d.stop?.();
    await sleep(2);                                  // the id is a clock — do not mint twice in a tick
  }
  assert.equal(ids.length, 2, 'both boots must publish a row');
  assert.notEqual(ids[0], ids[1],
    `a restart must not reuse the id — got ${ids[0]} twice, which reopens boot 1's error row and erases the failure from history`);
});

// ── M4) declining is a supported configuration, not an error ─────────────────
await t('M4. declining labeling is a SUPPORTED CONFIG — labeler.status is `no_model`, not an error', async () => {
  const { db } = makeDb(['a', 'b'], { approved: null });
  const daemon = makeDaemon(); const ollama = makeOllama();
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon, ollama, log: () => {} });
  await waitFor(() => getLabelerHealth()?.status === 'no_model');
  const h = getLabelerHealth();
  d.stop?.();
  assert.equal(h.status, 'no_model', 'declining is a legitimate steady state — NOT `error`, NOT a fabricated `ok`');
  assert.equal(h.model, null);
  // The same shape the other two supervisors return (§3.10b) — one vocabulary, three members.
  for (const k of ['status', 'message', 'detail', 'model', 'progress']) assert.ok(k in h, `getLabelerHealth() must match getEmbedderHealth/getTranscriberHealth: missing ${k}`);
  assert.ok(!/error|fail/i.test(h.message), `the message must not read as a fault: "${h.message}"`);
});

await t('M4b. readiness carries a uniform `models` slice — four members, one vocabulary', async () => {
  const readiness = createReadiness({
    db: { messages: {}, providers: { list: async () => [] }, secrets: { get: async () => null, has: async () => false } },
    userId: 'u',
    embedderHealth: () => ({ status: 'ok', message: 'Ready.', detail: null }),
    labelerHealth: () => ({ status: 'no_model', message: 'No labeling model approved.', detail: null, model: null, progress: null }),
    enricherHealth: () => ({ status: 'ok', message: 'Enriching with qwen3.5:4b.', detail: null, model: 'qwen3.5:4b', progress: null }),
    transcriberHealth: () => ({ status: 'downloading', message: 'Downloading…', detail: null, model: 'large-v3-turbo', progress: { pct: 42 } }),
  });
  const r = await readiness.get({ slices: ['models'] });
  assert.equal(r.models.embedder.status, 'ok', 'the embedder is BUNDLED — ~always ok, and never an approvable card (§3.10d-c)');
  assert.equal(r.models.labeler.status, 'no_model');
  assert.equal(r.models.transcriber.progress.pct, 42, 'byte-accurate progress survives the slice');
  // The fourth member. L2 enrichment was the one on-box task with NO surface anywhere, which is
  // how "approved labeling, declined enrich" ran dormant and silent (re-review, 2026-07-16).
  assert.equal(r.models.enricher.status, 'ok', 'the enricher must be reported, not omitted');
  assert.equal(r.models.enricher.model, 'qwen3.5:4b', 'and it must name its OWN model');
  for (const m of ['embedder', 'labeler', 'enricher', 'transcriber']) {
    for (const k of ['status', 'message', 'detail', 'model', 'progress']) assert.ok(k in r.models[m], `models.${m}.${k} missing — the point is ONE shape for all four`);
  }
});

await t('M4c. the `models` slice is fail-closed: a THROWING health reads `unknown`, never `ok`', async () => {
  const readiness = createReadiness({
    db: { messages: {}, providers: { list: async () => [] }, secrets: { get: async () => null, has: async () => false } },
    userId: 'u',
    embedderHealth: () => { throw new Error('supervisor exploded'); },
    labelerHealth: () => null,
    enricherHealth: () => { throw new Error('enricher exploded'); },
    transcriberHealth: () => ({ status: 'ok' }),
  });
  const r = await readiness.get({ slices: ['models'] });
  assert.equal(r.models.embedder.status, 'unknown', 'a throw must degrade to unknown — a fabricated ok is how a dead component renders as healthy');
  assert.equal(r.models.labeler.status, 'unknown', 'and so must a null');
  assert.equal(r.models.enricher.status, 'unknown', 'the new member is fail-closed on the same terms — never a fabricated ok');
  assert.ok(!JSON.stringify(r).includes('supervisor exploded'), 'the reason must not ride out on the readiness surface');
  assert.ok(!JSON.stringify(r).includes('enricher exploded'), 'and neither must the enricher\'s');
});

// ── The recommendation survives — it just stops being a silent default ───────
await t('M5. qwen3.5:4b is still the RECOMMENDATION — only the silent default is gone', async () => {
  assert.equal(labelingRecommendedModel(), 'qwen3.5:4b', 'role-models.js remains the single source of truth for the badge');
  assert.equal(DEFAULT_LABEL_MODEL, 'qwen3.5:4b', 'and the constant the Intelligence step offers is unchanged');
  // The distinction that IS the fix: recommended ≠ resolved-when-unset.
  assert.equal(await defaultLabelModel({ users: { getSettings: async () => ({}) } }, 'u'), null,
    'unset must resolve to NOTHING — a recommendation is what we OFFER, not what runs unasked');
});


// ── M6) THE APPROVAL PATH — a consent gate with no off-ramp is worse than the bug ────
// The first version of M shipped the gate with the approval UNREACHABLE, and no check here
// noticed: the on-box <select>'s "Recommended · qwen3.5:4b" option carried value="", which
// now CLEARS the setting — so the UI labelled the disable button "Recommended", while
// onboxOptions() deleted the recommended model from the list as "the default". qwen3.5:4b
// was the one model that selector could not store (independent review, 2026-07-16).
// These drive the REAL route the UI calls, end to end.
await t('M6. the recommended model round-trips through the REAL approval route (Settings → Intelligence)', async () => {
  const { startRestServer } = await import('../src/server-rest.js');
  const Database = (await import('better-sqlite3')).default;
  const { applyMigrations } = await import('../src/db/migrate.js');
  const { rmSync, mkdirSync } = await import('node:fs');
  const DB = 'data/verify-model-consent.db', KCV = 'data/verify-model-consent-kcv.json';
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  mkdirSync('data', { recursive: true });
  const raw = new Database(DB); applyMigrations(raw); raw.close();
  const hex = () => crypto.randomBytes(32).toString('hex');
  const srv = await startRestServer({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(), port: 0, host: '127.0.0.1', portalMode: 'legacy' });
  try {
    const put = async (body) => {
      const r = await fetch(`${srv.url}/api/v1/portal/providers/task-models`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    const read = async () => (await (await fetch(`${srv.url}/api/v1/portal/providers/task-models`)).json());

    // 1. A fresh vault approves NOTHING — the premise of M1.
    const fresh = await read();
    assert.ok(!fresh?.taskModels?.categorize?.model, `a fresh vault must have no approved labeling model — got ${JSON.stringify(fresh?.taskModels)}`);

    // 2. The EXACT value the fixed <select> now submits for "Recommended · qwen3.5:4b".
    const rec = labelingRecommendedModel();
    const ok = await put({ task: 'categorize', model: rec });
    assert.equal(ok.status, 200, `approving the RECOMMENDED model must be accepted — got ${ok.status} ${JSON.stringify(ok.body)}`);
    const after = await read();
    assert.equal(after?.taskModels?.categorize?.model, rec,
      'the recommended model must actually PERSIST — this is the whole approval path, and it did not exist before');

    // 3. …and the drainer resolves what the UI stored. Same key, same shape, no drift.
    assert.equal(await defaultLabelModel(srv.db, srv.userId ?? 'local-user', undefined), rec,
      'the drainer must resolve exactly what the approval route wrote');

    // 4. The explicit "Off" option un-approves — and un-approving must be possible too.
    const off = await put({ task: 'categorize', model: '' });
    assert.equal(off.status, 200);
    const cleared = await read();
    assert.ok(!cleared?.taskModels?.categorize?.model, 'clearing must remove the approval — "Off" is a supported choice, not an error');
  } finally {
    try { srv.server.close(); srv.close?.(); } catch {}
    for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  }
});

await t('M6b. the on-box picker REALLY renders + emits the recommended model (mounted, not grepped)', async () => {
  // M6 proves the ROUTE stores 'qwen3.5:4b' — it passed against the BROKEN UI too, because the
  // route was never the problem: the <select> simply had no option able to SEND that value.
  // So this mounts the real component and drives a real change event. It replaces a regex over
  // the component source, which an independent review defeated by commenting the option out
  // and watching the check still pass (2026-07-16).
  const { execFileSync } = await import('node:child_process');
  let raw;
  try {
    // `--conditions browser` is REQUIRED: Node otherwise resolves svelte's SERVER build via
    // the exports map and mount() throws lifecycle_function_unavailable.
    raw = execFileSync('node', ['--conditions', 'browser', 'test/mount-onbox-select.mjs'],
      { cwd: 'portal-app', encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    // FAIL-CLOSED, not skip. CI installs + builds portal-app BEFORE `npm run verify`
    // (.github/workflows/verify.yml), so the deps are always there when this gates a merge.
    throw new Error(`could not mount the component — run \`npm --prefix portal-app ci\` first. ${String(e?.stderr || e?.message || e).slice(0, 300)}`);
  }
  const r = JSON.parse(raw.trim().split('\n').pop());
  const values = r.options.map((o) => o.value);

  assert.ok(values.includes('qwen3.5:4b'),
    `the recommended model must be a REAL option — got ${JSON.stringify(r.options)}`);
  assert.equal(r.pickedRecommended, 'qwen3.5:4b',
    'picking "Recommended" must EMIT the model name — it used to emit "", which CLEARS the setting (i.e. un-approves)');
  assert.equal(r.pickedOff, '', 'and "Off" must emit "" — declining is a supported, explicit choice');

  const off = r.options.find((o) => o.value === '');
  assert.match(off.label, /^Off/i,
    `"" un-approves, so it must be LABELLED as off — it read "${off.label}", which made the disable button look like the approve button`);
  const rec = r.options.find((o) => o.value === 'qwen3.5:4b');
  assert.match(rec.label, /Recommended/i, 'and the recommendation must be labelled as such');

  assert.equal(r.selectedWhenApproved, 'qwen3.5:4b',
    'a vault already approved on the recommendation must SHOW it selected — blank or Off would misreport an approved vault as declined');
  assert.equal(values.filter((v) => v === 'qwen3.5:4b').length, 1,
    'exactly one recommended option — it also lives in the installed list, and a duplicate would be a second, identical-looking choice');
});

// ── M7) labelerHealth must not lie about WHICH model, or about PAUSED ───────────────
await t('M7. a PAUSED labeler says `paused` — not `unknown` forever', async () => {
  const { db } = makeDb(['a'], { approved: 'qwen3.5:4b' });
  const { pauseEnrichProcessing, resumeEnrichProcessing } = await import('../src/enrich/drainer.js');
  pauseEnrichProcessing();
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon: makeDaemon(), ollama: makeOllama({ installed: ['qwen3.5:4b'] }), log: () => {} });
  const got = await waitFor(() => getLabelerHealth()?.status === 'paused');
  const h = getLabelerHealth();
  d.stop?.(); resumeEnrichProcessing();
  // The resolve used to sit INSIDE the pause check, so a paused vault never resolved the
  // model and reported 'unknown' — "Checking the labeling model…" — forever. The one state
  // the user explicitly chose was the one this slice could not express.
  assert.ok(got, `a paused labeler must report 'paused' — got '${h.status}' (${h.message})`);
  assert.equal(h.model, 'qwen3.5:4b', 'and it must still know WHICH model is approved');
});

await t('M7b. the ENRICH model\'s download is not reported as the LABELER\'s health', async () => {
  // ensureLabelModel runs for BOTH the L1 label model and the L2 enrich model. With a single
  // module-global pull slot, labeling reported "Downloading gemma4:12b…" while it was running
  // perfectly well on qwen (independent review, 2026-07-16).
  const cats = new Map([['a', { id: 'a', content: 'row a', categories_processed: 0 }]]);
  const db = {
    users: { getSettings: async () => ({ taskModels: { categorize: { model: 'qwen3.5:4b' }, enrich: { model: 'gemma4:12b' } } }) },
    async rawQuery() { return { rows: [] }; },
    messages: {
      async selectPendingEnrichment() { return []; }, async updateEnrichment() {},
      async selectPendingNlp() { return [{ id: 'n1', content: 'x' }]; }, async updateNlp() {},
      async selectPendingCategories(_u, { limit = 25 } = {}) { return [...cats.values()].filter((r) => r.categories_processed === 0).slice(0, limit); },
      async updateCategories(id, _u, patch) { const r = cats.get(id); if (r && patch.categoriesProcessed !== undefined) r.categories_processed = patch.categoriesProcessed; },
    },
  };
  // qwen is INSTALLED (labeling is fine); gemma is NOT (its pull hangs).
  const ollama = {
    listCalls: 0, pulled: [], installed: ['qwen3.5:4b'],
    async listInstalled() { this.listCalls++; return [...this.installed]; },
    async pullModel(name) { this.pulled.push(name); await sleep(5000); return true; },  // hangs
  };
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon: makeDaemon(), ollama, log: () => {} });
  await waitFor(() => ollama.pulled.includes('gemma4:12b'));
  const h = getLabelerHealth();
  d.stop?.();
  assert.notEqual(h.status, 'downloading', `labeling runs on an INSTALLED qwen — it must not report the enrich model's download: got ${h.status} "${h.message}"`);
  assert.equal(h.model, 'qwen3.5:4b', `and it must never name the enrich model as the labeler: got ${h.model}`);
});

// ── M7c–M7g) the fault MESSAGE names the RIGHT cause, not a hardcoded "runtime down" ────────
// THE FINDING (live-test 2026-07-18): the health `message` was the constant "The local model
// runtime is not reachable." for ANY pull/list fault — a lie on a fresh box where the tag is
// valid and pullable but the ENVIRONMENT failed (Ollama up, download broke: no network to the
// registry, or disk full). The fault is now classified from the caught error's SHAPE
// (classifyOllamaFault) and each kind gets its own accurate, actionable line (faultMessage),
// with ollama's own reason preserved in `detail` (username-scrubbed) on the localhost-only
// readiness surface. A stub ollama that throws the REAL error strings (verified against a live
// spike + a local http server) drives it.

// A stub whose LIST succeeds ([]) but whose PULL throws a chosen error — the drainer will try
// to pull the approved-but-missing model and hit the classifier's catch.
const pullFails = (err) => ({
  listCalls: 0, pullCalls: 0, pulled: [], installed: [],
  async listInstalled() { this.listCalls++; return [...this.installed]; },
  async pullModel() { this.pullCalls++; throw err; },
});
// A stub whose LIST itself throws — the daemon-down path (ensureLabelModel's listInstalled catch).
const listFails = (err) => ({
  pullCalls: 0,
  async listInstalled() { throw err; },
  async pullModel() { this.pullCalls++; return true; },
});

await t('M7c. a disk-full PULL reads `out of space` — NOT "runtime not reachable" — and keeps ollama\'s detail', async () => {
  const { db } = makeDb(['a'], { approved: 'qwen3.5:4b' });   // pending L1 work ⇒ the pull is attempted
  const ollama = pullFails(new Error('ollama pull failed: write /Users/alice/.ollama/blobs/sha256-x: no space left on device'));
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon: makeDaemon(), ollama, log: () => {} });
  await waitFor(() => getLabelerHealth()?.status === 'unavailable');
  const h = getLabelerHealth();
  d.stop?.();
  assert.equal(h.status, 'unavailable', `a failed pull is a fault: got '${h.status}'`);
  // The classified message names the DISK. Under the old hardcode (or a classifier collapsed to
  // one kind) this reads "runtime not reachable" and BOTH asserts fail — the mutation witness.
  assert.match(h.message, /disk space|out of space|free up space/i, `a disk-full pull must name the DISK, not blame the runtime — got "${h.message}"`);
  assert.doesNotMatch(h.message, /reachable|is it running/i, `Ollama IS up (the pull started) — the message must not say it is unreachable: "${h.message}"`);
  // ollama's own reason survives to the detail (the localhost-only readiness surface), NEVER the feed.
  assert.ok(h.detail && /no space left/i.test(h.detail), `ollama's mid-stream reason must reach the detail — got "${h.detail}"`);
  // …but the home-dir USERNAME is scrubbed (§1 + review Finding 2): the reason stays, "alice" goes.
  assert.doesNotMatch(h.detail, /alice/, `the home-dir username must be scrubbed from the detail — got "${h.detail}"`);
  assert.match(h.detail, /<user>/, `the scrub must leave a marker so the path is still legible — got "${h.detail}"`);
});

await t('M7d. a mid-pull DOWNLOAD failure (registry/HTTP) reads `download failed`, not runtime-down', async () => {
  const { db } = makeDb(['a'], { approved: 'qwen3.5:4b' });
  const ollama = pullFails(new Error('ollama pull failed: dial tcp: lookup registry.ollama.ai: no such host'));
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon: makeDaemon(), ollama, log: () => {} });
  await waitFor(() => getLabelerHealth()?.status === 'unavailable');
  const h = getLabelerHealth();
  d.stop?.();
  assert.match(h.message, /download failed|registry/i, `a mid-pull failure with the daemon up is a DOWNLOAD problem — got "${h.message}"`);
  assert.doesNotMatch(h.message, /not reachable|is it running/i, `the runtime answered — do not report it unreachable: "${h.message}"`);
});

await t('M7e. a daemon-down LIST reads `runtime unreachable` (the one case the old hardcode got right)', async () => {
  const { db } = makeDb(['a'], { approved: 'qwen3.5:4b' });
  const ollama = listFails(new TypeError('fetch failed'));   // the REAL connection-refused shape
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon: makeDaemon(), ollama, log: () => {} });
  await waitFor(() => getLabelerHealth()?.status === 'unavailable');
  const h = getLabelerHealth();
  d.stop?.();
  assert.match(h.message, /reachable|is it running/i, `a down daemon IS a runtime-reachability fault — got "${h.message}"`);
  assert.equal(ollama.pullCalls, 0, 'a daemon that cannot be listed must never be asked to pull');
});

await t('M7f. classifyOllamaFault maps every REAL error shape; faultMessage is accurate, distinct, never blank', async () => {
  // The pure units, asserted directly so a regression is pinned at its source, not only through
  // the drainer. Shapes verified against a live spike + a local http server driving each class.
  const { classifyOllamaFault, OLLAMA_FAULT } = await import('../src/hardware/ollama.js');
  const { faultMessage } = await import('../src/enrich/drainer.js');
  const R = OLLAMA_FAULT.RUNTIME_UNREACHABLE, D = OLLAMA_FAULT.DOWNLOAD_FAILED, S = OLLAMA_FAULT.OUT_OF_SPACE;
  const I = OLLAMA_FAULT.INCOMPATIBLE_RUNTIME;
  const cases = [
    // A registry 412 (host Ollama too OLD for the model) is its OWN class — NOT download-failed,
    // which would render "check your network" (N2). Both shapes: a non-2xx and the mid-stream text.
    [new Error('ollama /api/pull 412'), 'pull', I],
    [new Error('ollama pull failed: 412: The model you are trying to pull requires a newer version of Ollama.'), 'pull', I],
    [new TypeError('fetch failed'), 'list', R],
    [new TypeError('fetch failed'), 'pull', R],                                  // connection refused = local daemon
    [Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }), 'list', R],
    [new Error('ollama /api/tags 500'), 'list', R],                             // daemon up but not serving list
    [new Error('ollama /api/pull 500'), 'pull', D],                             // reached daemon, pull HTTP failed
    [new Error('ollama pull failed: dial tcp: lookup registry.ollama.ai: no such host'), 'pull', D],
    [new Error('ollama pull failed: write /x/blobs: no space left on device'), 'pull', S],
    [new Error('ENOSPC: no space left'), 'list', S],                           // disk detection is phase-independent
    // ⚠️ THE PHASE-AWARE TIMEOUT (independent review, 2026-07-18). A pull has NO client timeout,
    // so "timeout"/"aborted" in a pull error is ollama's SERVER-side REGISTRY error text (Go's
    // i/o timeout / TLS handshake timeout / request canceled) — a DOWNLOAD failure, NOT the local
    // runtime. Matching the bare substring blamed the runtime — the exact lie this fix removes.
    [new Error('ollama pull failed: dial tcp 1.2.3.4:443: i/o timeout'), 'pull', D],
    [new Error('ollama pull failed: net/http: TLS handshake timeout'), 'pull', D],
    [new Error('ollama pull failed: Get "https://registry.ollama.ai/…": request canceled (Client.Timeout exceeded while awaiting headers)'), 'pull', D],
    // …but a LIST timeout IS the client (5s AbortSignal.timeout) giving up on the local daemon.
    [Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }), 'list', R],
    [new Error('aborted'), 'list', R],
  ];
  for (const [err, phase, want] of cases) {
    assert.equal(classifyOllamaFault(err, phase), want, `classifyOllamaFault(${JSON.stringify(String(err.message))}, ${phase}) → ${want}`);
  }
  // total + never blank, for every kind AND an unknown/null (fail-safe to the least-specific line)
  for (const k of Object.values(OLLAMA_FAULT)) assert.ok(faultMessage({ kind: k }).length > 0, `blank message for ${k}`);
  assert.ok(faultMessage({ kind: 'made-up-kind' }).length > 0, 'an unknown kind must fall back, never render blank');
  assert.ok(faultMessage(null).length > 0, 'a null fault must neither throw nor blank');
  // …and EVERY kind must be a DISTINCT line — a classifier that collapses them re-hides the cause,
  // which is exactly the bug this closes. (Under the old single hardcode this reads 1.) Count-
  // agnostic so a new fault kind (e.g. incompatible-runtime) is covered the moment it is added.
  const kinds = Object.values(OLLAMA_FAULT);
  const distinct = new Set(kinds.map((k) => faultMessage({ kind: k })));
  assert.equal(distinct.size, kinds.length, `each fault kind needs its OWN message — got ${distinct.size} distinct for ${kinds.length} kinds`);
});

await t('M7g. an enrich-only disk-full is the ENRICHER\'s fault, classified — and never leaks to the labeler', async () => {
  // The M7b/M9b model-keying property, now for a CLASSIFIED fault: qwen (label) is installed and
  // fine; gemma (enrich) fails its pull with ENOSPC. The enricher must read the disk message and
  // name gemma; the labeler must stay healthy and never inherit the enrich model's disk fault.
  const db = {
    users: { getSettings: async () => ({ taskModels: { categorize: { model: 'qwen3.5:4b' }, enrich: { model: 'gemma4:12b' } } }) },
    async rawQuery() { return { rows: [] }; },
    messages: {
      async selectPendingEnrichment() { return []; }, async updateEnrichment() {},
      async selectPendingNlp() { return [{ id: 'n1', content: 'x' }]; }, async updateNlp() {},   // L2 work ⇒ gemma pull attempted
      async selectPendingCategories() { return [{ id: 'a', content: 'row a', categories_processed: 0 }]; }, async updateCategories() {},
    },
  };
  const ollama = {
    installed: ['qwen3.5:4b'],
    async listInstalled() { return [...this.installed]; },
    async pullModel(name) { if (name === 'gemma4:12b') throw new Error('ollama pull failed: no space left on device'); this.installed.push(name); return true; },
  };
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon: makeDaemon(), ollama, log: () => {} });
  await waitFor(() => getEnricherHealth()?.status === 'unavailable');
  const e = getEnricherHealth(); const l = getLabelerHealth();
  d.stop?.();
  assert.equal(e.status, 'unavailable', `the enrich model's pull failed — the enricher must say so: got '${e.status}'`);
  assert.match(e.message, /disk space|out of space/i, `and it must name the DISK, classified: got "${e.message}"`);
  assert.equal(e.model, 'gemma4:12b', `naming the ENRICH model: got ${e.model}`);
  assert.notEqual(l.status, 'unavailable', `qwen is installed and fine — the enrich disk-full must not leak into the labeler: got '${l.status}'`);
  assert.equal(l.model, 'qwen3.5:4b', `the labeler still names its own model: got ${l.model}`);
});

// ── M8) the activity feed must not claim `running` on an unapproved vault ───────────
await t('M8. categorizeProjection: no approved model ⇒ NOT `running`, and no model named', async () => {
  const { categorizeProjection } = await import('../src/portal-activity.js');
  // portal-activity had its OWN resolveLabelModel with the `return 'qwen3.5:4b'` fallback —
  // M's caller audit grepped the NAME (defaultLabelModel) and missed it. The result: a vault
  // with no approved model, nothing running, and qwen not even on disk still rendered
  // "Categorizing messages · qwen3.5:4b · on-device · running" FOREVER — verbatim the bug
  // this file's own comment says was fixed for embed (independent review, 2026-07-16).
  const db = {
    users: { getSettings: async () => ({}) },              // nothing approved
    messages: { categoriesBacklogCached: async () => ({ tagged: 0, total: 100, pending: 100 }) },
  };
  const row = await categorizeProjection(db, 'u');
  assert.ok(row, 'pending work must still be surfaced — the user should see it is waiting');
  assert.notEqual(row.status, 'running', `nothing is running: no model approved, no daemon woken. Got status=${row.status}`);
  assert.equal(row.status, 'paused', 'it is waiting on a DECISION — paused, not stalled: nothing is broken');
  assert.equal(row.model, null, `it must not name a model that was never approved — got ${row.model}`);
  assert.match(row.stage, /no local model/i, `the stage must say WHY it is not running — got "${row.stage}"`);
  assert.equal(row.remaining, 100, 'and the pending count stays honest');
});

await t('M8b. …but an APPROVED vault still reads `running` (no regression on the happy path)', async () => {
  const { categorizeProjection } = await import('../src/portal-activity.js');
  const db = {
    users: { getSettings: async () => ({ taskModels: { categorize: { model: 'qwen3.5:4b' } } }) },
    messages: { categoriesBacklogCached: async () => ({ tagged: 10, total: 100, pending: 90 }) },
  };
  const row = await categorizeProjection(db, 'u');
  assert.equal(row.status, 'running');
  assert.equal(row.model, 'qwen3.5:4b');
  assert.equal(row.process, 'on-device');
});

// ── M9) L2 ENRICHMENT IS REPORTED — the dormancy class M ended, one task over ────────
// THE FINDING (re-review, 2026-07-16): `taskModels.enrich` is its own setting, so a vault could
// approve Labeling and leave Enrichment unset — L2 (entities + gist) then ran dead with NO
// surface reporting it: the readiness `models` slice carried {embedder, labeler, transcriber}
// and portal-activity projects only embed + categorize. The SILENCE is the defect;
// getEnricherHealth() is the missing report.
// ⚠️ The Intelligence screen now approves {categorize, enrich} TOGETHER (`{function}` fans out —
// portal-providers.js, gate M8 in verify-task-models.mjs), so the split is no longer reachable from the screen. The report
// still earns its place: the per-task route writes one task at a time, and enrich can still be
// paused/pulled/broken on its own.
await t('M9. approve LABELING, decline ENRICH ⇒ the enricher says `no_model` (the dormancy is visible)', async () => {
  // The exact MED-2 vault: categorize approved, enrich UNSET.
  const db = {
    users: { getSettings: async () => ({ taskModels: { categorize: { model: 'qwen3.5:4b' } } }) },
    async rawQuery() { return { rows: [] }; },
    messages: {
      async selectPendingEnrichment() { return []; }, async updateEnrichment() {},
      async selectPendingNlp() { return [{ id: 'n1', content: 'x' }]; }, async updateNlp() {},   // L2 work IS waiting
      async selectPendingCategories() { return [{ id: 'a', content: 'row a', categories_processed: 0 }]; },
      async updateCategories() {},
    },
  };
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon: makeDaemon(), ollama: makeOllama({ installed: ['qwen3.5:4b'] }), log: () => {} });
  await waitFor(() => getEnricherHealth()?.status === 'no_model');
  const e = getEnricherHealth(); const l = getLabelerHealth();
  d.stop?.();
  // Before this member existed there was NOTHING to assert on: L2 was simply dead and silent.
  assert.equal(e.status, 'no_model', `enrich is unset — the enricher must SAY so, not stay invisible. Got '${e.status}' ("${e.message}")`);
  assert.equal(e.model, null, 'and it must not name a model that was never approved');
  assert.ok(!/error|fail/i.test(e.message), `declining is a supported choice, not a fault: "${e.message}"`);
  // …and it must not drag the LABELER down with it: the two are independent.
  assert.notEqual(l.status, 'no_model', `labeling WAS approved — the enricher's no_model must not leak into it. Got '${l.status}'`);
  assert.equal(l.model, 'qwen3.5:4b', 'the labeler still names its own approved model');
});

await t('M9b. the LABEL model\'s download is not reported as the ENRICHER\'s health (M7b, mirrored)', async () => {
  // M7b proved the labeler does not report the enrich model's pull. The same trap runs the other
  // way: enricherHealth reads the SAME model-keyed _pulling/_faults slots, so a health keyed on
  // the wrong slot would make an enricher running fine on an installed model report the LABEL
  // model's download. Every branch keys on `_approvedEnrichModel` — this is what proves it.
  const db = {
    users: { getSettings: async () => ({ taskModels: { categorize: { model: 'gemma4:12b' }, enrich: { model: 'qwen3.5:4b' } } }) },
    async rawQuery() { return { rows: [] }; },
    messages: {
      async selectPendingEnrichment() { return []; }, async updateEnrichment() {},
      async selectPendingNlp() { return [{ id: 'n1', content: 'x' }]; }, async updateNlp() {},
      async selectPendingCategories() { return [{ id: 'a', content: 'row a', categories_processed: 0 }]; },
      async updateCategories() {},
    },
  };
  // qwen (ENRICH) is installed; gemma (LABEL) is not — its pull hangs.
  const ollama = {
    pulled: [], installed: ['qwen3.5:4b'],
    async listInstalled() { return [...this.installed]; },
    async pullModel(name) { this.pulled.push(name); await sleep(5000); return true; },
  };
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon: makeDaemon(), ollama, log: () => {} });
  await waitFor(() => ollama.pulled.includes('gemma4:12b') && getEnricherHealth()?.status === 'ok');
  const e = getEnricherHealth(); const l = getLabelerHealth();
  d.stop?.();
  // ⚠️ THIS ASSERT WAS `notEqual(e.status, 'downloading')` — AND IT COULD NOT FAIL FOR THE RIGHT
  // REASON. A negative passes on ANY other status, including the 'unknown' that a caught-up or
  // crashing vault reported forever — so the check went green whether the enricher was healthy
  // or comatose, which is the one distinction it exists to make. It now asserts the POSITIVE:
  // qwen IS installed, so the ONLY honest answer is 'ok'. That still refutes the original trap
  // (gemma's pull leaking in would read 'downloading' ≠ 'ok') and now refutes silence too.
  assert.equal(e.status, 'ok', `enrichment runs on an INSTALLED qwen — the honest report is 'ok', not the LABEL model's download nor silence: got ${e.status} "${e.message}"`);
  assert.equal(e.model, 'qwen3.5:4b', `and it must never name the label model as the enricher: got ${e.model}`);
  // The other half of the trap, made explicit: the LABELER really is downloading gemma. Without
  // this, an implementation that reported 'ok' for BOTH would satisfy the line above.
  assert.equal(l.status, 'downloading', `the labeler's gemma pull is real and must be reported as ITS health: got ${l.status} "${l.message}"`);
  assert.equal(l.model, 'gemma4:12b', `and named as the labeler's model: got ${l.model}`);
});

await t('M9c. a PAUSED vault reports the enricher `paused` — the pause really does stop L2', async () => {
  // pauseEnrichProcessing() skips the whole `if (!isEnrichProcessingPaused())` block in cycle(),
  // which holds the L2 loop too — so 'paused' here is a fact about L2, not a value copied off the
  // labeler. (This note used to read "NAMED for categorize but SCOPED to both". §3.9/R3 fixed the
  // name and widened the scope again: it now gates the embed drain as well. The name no longer
  // lies, so there is no longer a gap between it and the scope to warn about.)
  const db = {
    users: { getSettings: async () => ({ taskModels: { categorize: { model: 'qwen3.5:4b' }, enrich: { model: 'qwen3.5:4b' } } }) },
    async rawQuery() { return { rows: [] }; },
    messages: {
      async selectPendingEnrichment() { return []; }, async updateEnrichment() {},
      async selectPendingNlp() { return [{ id: 'n1', content: 'x' }]; }, async updateNlp() {},
      async selectPendingCategories() { return [{ id: 'a', content: 'row a', categories_processed: 0 }]; },
      async updateCategories() {},
    },
  };
  const { pauseEnrichProcessing, resumeEnrichProcessing } = await import('../src/enrich/drainer.js');
  pauseEnrichProcessing();
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon: makeDaemon(), ollama: makeOllama({ installed: ['qwen3.5:4b'] }), log: () => {} });
  const got = await waitFor(() => getEnricherHealth()?.status === 'paused');
  const h = getEnricherHealth();
  d.stop?.(); resumeEnrichProcessing();
  assert.ok(got, `a paused vault is not enriching — the enricher must report 'paused', not 'ok'. Got '${h.status}' ("${h.message}")`);
  assert.equal(h.model, 'qwen3.5:4b', 'and it must still know WHICH model is approved');
});

await t('M9f. an injected LABEL model is not enrich consent (a fallback is not a decision)', async () => {
  // The enrich resolver's fallback used to be `labelModel`, so injecting the label model made a
  // labeling-only approval silently count as ENRICH approval — a consent crossover that was
  // inert in production (nothing injects labelModel) and therefore invisible to every gate
  // (independent review, 2026-07-16). §3.10c is per-TASK: the approval IS that task's setting.
  const db = {
    users: { getSettings: async () => ({ taskModels: { categorize: { model: 'qwen3.5:4b' } } }) },  // enrich UNSET
    async rawQuery() { return { rows: [] }; },
    messages: {
      async selectPendingEnrichment() { return []; }, async updateEnrichment() {},
      async selectPendingNlp() { return [{ id: 'n1', content: 'x' }]; }, async updateNlp() {},
      async selectPendingCategories() { return [{ id: 'a', content: 'row a', categories_processed: 0 }]; },
      async updateCategories() {},
    },
  };
  const ollama = makeOllama({ installed: ['qwen3.5:4b'] });
  // Inject the label model — the ONLY way the old fallback was reachable.
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon: makeDaemon(), ollama, labelModel: 'qwen3.5:4b', log: () => {} });
  await waitFor(() => getEnricherHealth()?.status === 'no_model');
  const e = getEnricherHealth();
  d.stop?.();
  assert.equal(e.status, 'no_model', `enrich was never approved — an injected LABEL model must not become enrich consent. Got '${e.status}' ("${e.message}")`);
  assert.equal(e.model, null, `and it must not name the label model as the enricher's: got ${e.model}`);
});

await t('M9e. a THROWING drain path does not strand the stamp — the healths still know their model', async () => {
  // CONFIRMED BY PROBE (independent review, 2026-07-16): the resolve+stamp used to sit below the
  // `if (embedOk)` block but still inside cycle()'s try, and svc.drainOnce() is unguarded — so a
  // throw in the embed loop hit the outer catch and skipped the stamp. `_approvedModel` /
  // `_approvedEnrichModel` stayed `undefined`, giving `unknown | model=null` FOREVER (the same
  // throw repeats every cycle). Same defect the pause block already taught us: the stamp had
  // been moved out of the pause and left under the throw — half-fixed. It now sits at the TOP
  // of the try, above everything that can throw. This is what holds it there.
  const mkDb = () => ({
    users: { getSettings: async () => ({ taskModels: { categorize: { model: 'qwen3.5:4b' }, enrich: { model: 'qwen3.5:4b' } } }) },
    async rawQuery() { throw new Error('db read blew up'); },     // the drain path throws…
    messages: {
      async selectPendingEnrichment() { throw new Error('db read blew up'); },
      async updateEnrichment() {}, async updateNlp() {},
      async selectPendingNlp() { return []; },
      async selectPendingCategories() { return []; },
      async updateCategories() {},
    },
  });
  // …on a HEALTHY embed service, so the `if (embedOk)` block really is entered and really throws.
  const d = startEnrichDrainer({ db: mkDb(), userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon: makeDaemon(), ollama: makeOllama({ installed: ['qwen3.5:4b'] }), log: () => {} });
  await waitFor(() => getEnricherHealth()?.model === 'qwen3.5:4b');
  // The embed block throws on every cycle; wait for the guard to have COUNTED one, so the
  // embedErrs assert below reads a settled value rather than racing the stamp (which lands
  // first, above the embed gate).
  await waitFor(() => (d.status?.()?.embedErrs ?? 0) > 0);
  const e = getEnricherHealth(); const l = getLabelerHealth();
  const st = d.status?.() ?? null;
  d.stop?.();
  // THE STAMP SURVIVED. This is the regression that matters: it was `null` before the hoist.
  assert.equal(e.model, 'qwen3.5:4b', `a crashing drain must not un-know the approved enrich model — got ${e.model}`);
  assert.equal(l.model, 'qwen3.5:4b', `nor the labeler's — both are stamped by the same hoisted lines — got ${l.model}`);

  // AND the stamp is what makes the REAL states reachable through a crash. Paused + crashing
  // read 'unknown' before the hoist (no model ⇒ no branch); it now reads the truth.
  const { pauseEnrichProcessing, resumeEnrichProcessing } = await import('../src/enrich/drainer.js');
  pauseEnrichProcessing();
  const d2 = startEnrichDrainer({ db: mkDb(), userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon: makeDaemon(), ollama: makeOllama({ installed: ['qwen3.5:4b'] }), log: () => {} });
  const got = await waitFor(() => getEnricherHealth()?.status === 'paused');
  const p = getEnricherHealth();
  d2.stop?.(); resumeEnrichProcessing();
  assert.ok(got, `a crashing cycle must not mask a state the owner chose — expected 'paused', got '${p.status}' ("${p.message}")`);

  // ⚠️ THE HONEST LIMIT THIS ONCE RECORDED IS NOW CLOSED — and per its own instruction ("if this
  // ever fails, the gap was closed and this assert should become the stronger one"), the assert
  // was inverted rather than deleted. It used to read `equal(e.status, 'unknown')`, documenting
  // that a crashing drain left "Checking the enrichment model…" forever because `_modelReady`
  // was populated only past the throw. Both causes are gone: drainOnce is guarded (the throw no
  // longer skips L1+L2), and probeModelReady() resolves readiness from the APPROVAL above the
  // embed gate. qwen is installed and the runtime is up, so 'ok' is the honest answer even
  // though the drain is crashing: the enricher's model really is installed and L2 really does
  // run (M9h proves it), and EMBEDDING's failure is not the enricher's health to report.
  assert.equal(e.status, 'ok', `a crashing DRAIN must not un-know an installed, approved enrich model — the throw costs embedding, not the health: got '${e.status}' ("${e.message}")`);

  // ⚠️ THE HONEST LIMIT THAT REPLACES THE OLD ONE — do not delete this the way its predecessor
  // was deleted. The first draft of this fix removed the note above and asserted the class
  // closed; a review then showed a permanently locked vault reads GREEN on both healths, so the
  // note had been recording something real. It is narrower now but not gone: `_modelReady` is a
  // process-lifetime cache, so 'ok' means "confirmed installed at least once THIS PROCESS", not
  // "right now" — two caught-up vaults whose runtime is unreachable at this moment can still
  // disagree on boot history alone. What makes the embed failure findable is `status().embedErrs`
  // (asserted below) plus the throttled log — NOT these healths, which are about the MODEL.
  assert.ok(st && st.embedErrs > 0, `a crashing drain must be visible SOMEWHERE that is not stderr — status() must count it: got embedErrs=${st?.embedErrs}`);
});

await t('M9g. a CAUGHT-UP vault reports `ok` — readiness is a property of the APPROVAL, not the backlog', async () => {
  // THE DEFECT (independent review, 2026-07-16): `_modelReady` was written ONLY inside
  // ensureLabelModel(), called only under `if (pc.length || pn.length)` — so the 'ok' branch of
  // BOTH healths was reachable only while rows were pending. Two vaults with identical settings,
  // model and runtime, differing ONLY in boot history, disagreed:
  //   had a backlog earlier this process → 'ok'      "Enriching with qwen3.5:4b."
  //   caught up at boot (mature vault)   → 'unknown' "Checking the enrichment model…"
  // The steady state of every mature vault after a restart was therefore 'unknown' — the
  // healthiest configuration reporting as the least known one, saying "Checking…" while nothing
  // was checking. THIS FIXTURE IS THAT VAULT: approved, installed, reachable, nothing pending.
  const db = {
    users: { getSettings: async () => ({ taskModels: { categorize: { model: 'qwen3.5:4b' }, enrich: { model: 'qwen3.5:4b' } } }) },
    async rawQuery() { return { rows: [] }; },
    messages: {
      async selectPendingEnrichment() { return []; }, async updateEnrichment() {},
      async selectPendingNlp() { return []; }, async updateNlp() {},          // ← caught up:
      async selectPendingCategories() { return []; }, async updateCategories() {},  //   NOTHING pending
    },
  };
  const ollama = makeOllama({ installed: ['qwen3.5:4b'] });
  const daemon = makeDaemon();
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon, ollama, log: () => {} });
  await waitFor(() => getEnricherHealth()?.status === 'ok' && getLabelerHealth()?.status === 'ok');
  const e = getEnricherHealth(); const l = getLabelerHealth();
  d.stop?.();
  assert.equal(l.status, 'ok', `an approved+installed labeling model on a caught-up vault is 'ok' — a mature vault must not read as the least-known one: got '${l.status}' ("${l.message}")`);
  assert.equal(e.status, 'ok', `same for the enricher: got '${e.status}' ("${e.message}")`);
  assert.equal(e.model, 'qwen3.5:4b', `and it names the approved model: got ${e.model}`);
  // ⚠️ THE FIX MUST NOT BUY 'ok' WITH A RESOURCE REGRESSION. These two asserts are why the probe
  // is read-only: an idle vault still spawns NOTHING (ensureUp auto-installs the runtime — M2)
  // and downloads NOTHING. Resolving readiness must cost one /api/tags GET, not a daemon.
  assert.equal(daemon.calls, 0, `an IDLE vault must never wake the daemon just to answer a health question (ensureUp installs the runtime): got ${daemon.calls} call(s)`);
  assert.equal(ollama.pullCalls, 0, `nor pull a 3.4GB model with no work to do: got ${ollama.pullCalls} pull(s)`);
});

await t('M9h. a THROWING embed drain no longer silences L1 + L2 — the throw costs EMBEDDING, nothing else', async () => {
  // THE DEFECT (independent review, 2026-07-16): svc.drainOnce() was unguarded inside
  // `if (embedOk) {`. It throws BY DESIGN on a locked vault (service.js:69) and can throw on
  // SQLITE_BUSY (service.js:72) — and the throw walked to cycle()'s outer catch, skipping the
  // ENTIRE L1+L2 block below it. Demonstrated with pending work every cycle, the model installed
  // and Ollama up: 0 rows tagged, 0 enriched. The comment above the gate CLAIMED this coupling
  // was already removed ("THE EMBED HEALTH GATE SKIPS EMBEDDING — NOT THE CYCLE… when the embed
  // sidecar died, categorization stopped too"): the early `return` was indeed gone, but the
  // throw reinstated the identical outcome by another route. L1 needs OLLAMA, not :8091.
  const nlpLimits = [];                       // records HOW selectPendingNlp was called (see below)
  const cats = new Map([['a', { id: 'a', content: 'row a', categories_processed: 0 }]]);
  const db = {
    users: { getSettings: async () => ({ taskModels: { categorize: { model: 'qwen3.5:4b' }, enrich: { model: 'qwen3.5:4b' } } }) },
    async rawQuery() { return { rows: [] }; },
    messages: {
      // THE THROW, at its real site: drainOnce()'s first read. SQLITE_BUSY is one of the two
      // causes named in the finding — a real, non-hypothetical production throw.
      async selectPendingEnrichment() { throw new Error('SQLITE_BUSY: database is locked'); },
      async updateEnrichment() {},
      // HERMETIC BY CONSTRUCTION. The cycle's pending PROBE reads limit 1; only enrichNlpOnce()
      // reads the batch limit (50). Answering "one row pending" to the probe is what makes
      // `enrichReady` true and drives the L2 loop; answering "none" to the batch lets that loop
      // find nothing and break — so this proves the block was ENTERED without handing a real row
      // to the real enricher, whose infer path is localInfer → a live Ollama on :11434. (That is
      // not hypothetical: it would either hit ECONNREFUSED or, on a dev box with Ollama up,
      // genuinely run qwen3.5:4b. A gate must not depend on which.) The transition it models —
      // pending at check time, drained by read time — is an ordinary production race.
      async selectPendingNlp(_u, { limit = 50 } = {}) { nlpLimits.push(limit); return limit === 1 ? [{ id: 'n1', content: 'x' }] : []; },
      async updateNlp() {},
      async selectPendingCategories(_u, { limit = 25 } = {}) { return [...cats.values()].filter((r) => r.categories_processed === 0).slice(0, limit); },
      async updateCategories(id, _u, patch) { const r = cats.get(id); if (r && patch.categoriesProcessed !== undefined) r.categories_processed = patch.categoriesProcessed; },
    },
  };
  // A HEALTHY embed service, so `if (embedOk)` really is entered and really does throw.
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon: makeDaemon(), ollama: makeOllama({ installed: ['qwen3.5:4b'] }), log: () => {} });
  const tagged = await waitFor(() => [...cats.values()].every((r) => r.categories_processed === 1));
  const e = getEnricherHealth(); const l = getLabelerHealth();
  d.stop?.();
  // THE REGRESSION THAT MATTERS: L1 ran anyway. Before the guard this was 0 rows, forever.
  assert.ok(tagged, 'a crashing EMBED drain must not stop L1 labeling — it needs Ollama, not the embed service. Rows stayed untagged.');
  // L2 reached its loop too. The pending PROBE calls selectPendingNlp with limit 1; only
  // enrichNlpOnce() calls it with the batch limit (50) — so a 50 proves the L2 block was
  // entered past the throw, without needing a live model to enrich with.
  assert.ok(nlpLimits.includes(50), `L2 must be reached past the throw as well — expected an enrichNlpOnce batch read (limit 50), saw limits [${nlpLimits}]`);
  assert.equal(l.status, 'ok', `and the labeler reports the truth through the crash: got '${l.status}' ("${l.message}")`);
  assert.equal(e.status, 'ok', `as does the enricher: got '${e.status}' ("${e.message}")`);
});

await t('M9i. a MALFORMED ollama answer cannot take down the cycle the probe reports on', async () => {
  // The readiness probe runs ABOVE the embed gate, so a throw from IT lands in cycle()'s outer
  // catch and skips embedding, L1 AND L2 — a health check that kills the pipeline it reports on,
  // i.e. M9h's bug reintroduced by its own fix. listInstalled() is injectable and its real
  // implementation swears an array (ollama.js: `Array.isArray(...) ? ... : []`), which is exactly
  // the kind of upstream promise that quietly stops being true. `.some` of null throws.
  // WHAT THIS DOES *NOT* CLAIM, learned by red-testing it: with an unreadable model list, L1 does
  // NOT tag — and that is CORRECT, not the bug. Readiness means "an approved model is confirmed
  // installed" (§3.10c); an answer we cannot read confirms nothing, so the classifier must stay
  // parked. The first draft of this check asserted rows got tagged and failed identically with
  // AND without the defect — an assertion that cannot distinguish the two proves nothing, which
  // is the same vacuity that made the old M9b green forever. The real claim is narrower and is
  // the one that matters: the probe must not ABORT THE CYCLE. EMBEDDING has no stake whatsoever
  // in the model list, so it is the honest witness that execution got past the probe.
  const drainReads = [];
  const db = {
    users: { getSettings: async () => ({ taskModels: { categorize: { model: 'qwen3.5:4b' }, enrich: { model: 'qwen3.5:4b' } } }) },
    async rawQuery() { return { rows: [] }; },
    messages: {
      async selectPendingEnrichment() { drainReads.push(1); return []; },   // ← drainOnce's first read
      async updateEnrichment() {},
      async selectPendingNlp() { return []; }, async updateNlp() {},
      async selectPendingCategories() { return []; }, async updateCategories() {},
    },
  };
  const ollama = { listCalls: 0, pullCalls: 0, pulled: [], async listInstalled() { this.listCalls++; return null; }, async pullModel() { this.pullCalls++; return true; } };
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon: makeDaemon(), ollama, log: () => {} });
  const reached = await waitFor(() => drainReads.length > 0);
  const l = getLabelerHealth();
  d.stop?.();
  assert.ok(reached, 'a garbage answer from the model probe must not abort the cycle — embedding does not depend on the model list, and never reached its first read');
  // …and it must not INVENT readiness from an answer it could not read.
  assert.equal(l.status, 'unknown', `an unreadable model list is 'unknown', never a fabricated 'ok': got '${l.status}'`);
});

await t('M9j. the health probe is NOT on embedding\'s critical path — a hanging ollama must not delay the drain', async () => {
  // INTRODUCED BY THE FIX THIS GATE GUARDS, caught by an independent review (2026-07-16) that
  // measured it: awaiting the probe put a HEALTH question in front of EMBEDDING. listInstalled()
  // is capped at 5s (ollama.js AbortSignal.timeout) and an ollama that accepts connections but
  // hangs — the app's own daemon does this during boot — cost two sequential 5s waits, so the
  // first embed read moved from t+4ms (main) to t+10008ms, every 15s cycle. Embedding has no
  // stake in the model list. A health probe that delays the pipeline it reports on is the very
  // coupling this commit removes from the embed gate, re-introduced by its own fix.
  const t0 = Date.now();
  const drainReadAt = [];
  const db = {
    users: { getSettings: async () => ({ taskModels: { categorize: { model: 'qwen3.5:4b' }, enrich: { model: 'gemma4:12b' } } }) },
    async rawQuery() { return { rows: [] }; },
    messages: {
      async selectPendingEnrichment() { drainReadAt.push(Date.now() - t0); return []; },
      async updateEnrichment() {}, async selectPendingNlp() { return []; }, async updateNlp() {},
      async selectPendingCategories() { return []; }, async updateCategories() {},
    },
  };
  // Ollama ACCEPTS the request and then hangs — the failure mode a plain "is it up?" check misses.
  const ollama = { listCalls: 0, pullCalls: 0, pulled: [], async listInstalled() { this.listCalls++; await sleep(1500); return ['qwen3.5:4b']; }, async pullModel() { this.pullCalls++; return true; } };
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon: makeDaemon(), ollama, log: () => {} });
  const reached = await waitFor(() => drainReadAt.length > 0, 1000);   // ⇐ must beat the 1500ms hang
  d.stop?.();
  assert.ok(reached, `embedding must not wait on the model list — the first drain read had not happened ${1000}ms in (probe hang: 1500ms)`);
  assert.ok(drainReadAt[0] < 1000, `…and it must be prompt: first drain read at t+${drainReadAt[0]}ms behind a 1500ms probe hang`);
});

await t('M9k. an installed SIBLING TAG is not the approved model — `qwen3.5:70b` never satisfies `qwen3.5:4b`', async () => {
  // The predicate was `n === model || n.split(':')[0] === base` — a bare BASE match, so ANY tag
  // of the base counted. A vault that approved qwen3.5:4b with only qwen3.5:70b-instruct
  // installed was declared ready and reported "Labeling with qwen3.5:4b." while every classify
  // 404'd on a model that is not there (independent review, 2026-07-16). The predicate is
  // PRE-EXISTING (ensureLabelModel had it, and the lie is reproducible on main) — but the probe
  // widened its REACH: main's caught-up vault said 'unknown' (honest ignorance), and the fix
  // turned that into a confident lie naming a model the box does not have. Two tags of one base
  // are two different models; 4b vs 70b is ~40GB of difference in what the owner agreed to run.
  const db = {
    users: { getSettings: async () => ({ taskModels: { categorize: { model: 'qwen3.5:4b' }, enrich: { model: 'qwen3.5:4b' } } }) },
    async rawQuery() { return { rows: [] }; },
    messages: {
      async selectPendingEnrichment() { return []; }, async updateEnrichment() {},
      async selectPendingNlp() { return []; }, async updateNlp() {},
      async selectPendingCategories() { return []; }, async updateCategories() {},   // caught up
    },
  };
  const ollama = makeOllama({ installed: ['qwen3.5:70b-instruct'] });   // a SIBLING, not the model
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon: makeDaemon(), ollama, log: () => {} });
  await waitFor(() => ollama.listCalls > 0);
  await sleep(30);
  const l = getLabelerHealth(); const e = getEnricherHealth();
  d.stop?.();
  assert.notEqual(l.status, 'ok', `qwen3.5:4b is NOT installed — a 70b sibling must not report it ready: got '${l.status}' ("${l.message}")`);
  assert.notEqual(e.status, 'ok', `same for the enricher: got '${e.status}' ("${e.message}")`);
  // …and nothing is pulled on a caught-up vault, sibling or not (the probe stays read-only).
  assert.equal(ollama.pullCalls, 0, `an idle vault pulls nothing: got ${ollama.pullCalls}`);
});

await t('M9l. a TAG-LESS approval means `:latest` — an installed `:4b` does NOT satisfy plain `qwen3.5`', async () => {
  // ⚠️ THIS CHECK USED TO ASSERT THE OPPOSITE, AND THE OPPOSITE WAS A LIE. The first fix kept a
  // base match "for the tag-less case" and this gate blessed it: `ok` for a tag-less `qwen3.5`
  // with only `qwen3.5:4b` installed. A re-review refuted it against a LIVE ollama daemon —
  // evidence beating the paper reasoning that wrote it — and it was reproduced here (2026-07-16,
  // only qwen3.5:4b installed):
  //     qwen3.5              → {"error":"model 'qwen3.5' not found"}
  //     qwen3.5:latest       → {"error":"model 'qwen3.5:latest' not found"}
  //     qwen3.5:70b-instruct → {"error":"model 'qwen3.5:70b-instruct' not found"}
  //     qwen3.5:4b           → runs
  // Ollama resolves a tag-less name to `:latest` and NOTHING else, and localInfer sends the
  // approved name VERBATIM. So the old gate certified "Labeling with qwen3.5." on a vault where
  // every classify 404s — this commit's own headline defect, re-committed by its own fix and
  // then asserted as correct. A gate that blesses the bug is worse than no gate.
  const mk = (installed) => {
    const db = {
      users: { getSettings: async () => ({ taskModels: { categorize: { model: 'qwen3.5' }, enrich: { model: 'qwen3.5' } } }) },
      async rawQuery() { return { rows: [] }; },
      messages: {
        async selectPendingEnrichment() { return []; }, async updateEnrichment() {},
        async selectPendingNlp() { return []; }, async updateNlp() {},
        async selectPendingCategories() { return []; }, async updateCategories() {},  // caught up
      },
    };
    return { db, ollama: makeOllama({ installed }) };
  };
  // (i) `:4b` installed, `qwen3.5` approved ⇒ ollama would 404 ⇒ we must NOT say 'ok'.
  const a = mk(['qwen3.5:4b']);
  const d1 = startEnrichDrainer({ db: a.db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon: makeDaemon(), ollama: a.ollama, log: () => {} });
  await waitFor(() => a.ollama.listCalls > 0); await sleep(30);
  const l1 = getLabelerHealth();
  d1.stop?.();
  assert.notEqual(l1.status, 'ok', `ollama resolves 'qwen3.5' to 'qwen3.5:latest', which is NOT installed — a ':4b' sibling must not report it ready: got '${l1.status}' ("${l1.message}")`);
  assert.equal(a.ollama.pullCalls, 0, `and a caught-up vault still pulls nothing: got ${a.ollama.pullCalls}`);

  // (ii) …but `:latest` IS what a tag-less approval names, so it must be honoured — otherwise the
  // predicate would pause labeling on a vault whose model is genuinely there (and a tag-less PULL
  // installs exactly `<name>:latest`, so this is also what makes the post-pull state settle).
  const b = mk(['qwen3.5:latest']);
  const d2 = startEnrichDrainer({ db: b.db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon: makeDaemon(), ollama: b.ollama, log: () => {} });
  const ok = await waitFor(() => getLabelerHealth()?.status === 'ok');
  const l2 = getLabelerHealth();
  d2.stop?.();
  assert.ok(ok, `a tag-less approval IS satisfied by the installed ':latest' it resolves to: got '${l2.status}' ("${l2.message}")`);
  assert.equal(b.ollama.pullCalls, 0, 'and it must not re-pull what is already there');
});

await t('M9m. probes are SINGLE-FLIGHT per model — un-awaiting them must not let them accumulate', async () => {
  // The cost of M9j's fix: un-awaiting the probe (so it cannot delay embedding) also dropped it
  // out of cycle()'s `running` single-flight, which had been bounding it for free. While ollama
  // hangs, `_modelReady` never fills, so every cycle fired ANOTHER probe — a re-review drove
  // 5,236 concurrent in-flight requests through POST /portal/enrichment/trigger (owner-only, so
  // LOW, but a real invariant silently lost). The 15s timer alone cannot expose it (the 5s cap
  // settles first), which is exactly why it needs a gate rather than a timing coincidence.
  let started = 0, concurrent = 0, peak = 0;
  const db = {
    users: { getSettings: async () => ({ taskModels: { categorize: { model: 'qwen3.5:4b' }, enrich: { model: 'gemma4:12b' } } }) },
    async rawQuery() { return { rows: [] }; },
    messages: {
      async selectPendingEnrichment() { return []; }, async updateEnrichment() {},
      async selectPendingNlp() { return []; }, async updateNlp() {},
      async selectPendingCategories() { return []; }, async updateCategories() {},
    },
  };
  const ollama = {
    pullCalls: 0,
    async listInstalled() { started++; concurrent++; peak = Math.max(peak, concurrent); await sleep(300); concurrent--; return ['nothing-matching']; },
    async pullModel() { this.pullCalls++; return true; },
  };
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon: makeDaemon(), ollama, log: () => {} });
  for (let i = 0; i < 60; i++) { d.nudge(); await sleep(1); }   // hammer the nudge path, as the portal route can
  await sleep(40);
  d.stop?.();
  // TWO approved models ⇒ at most two in flight, however hard the trigger is hammered.
  assert.ok(peak <= 2, `probes must be single-flight per model: ${peak} were in flight at once across 60 nudges into a 300ms hang`);
  assert.ok(started <= 2, `and only one CALL per model should have been started while the first still hung: got ${started}`);
});

await t('M9d. no drainer ⇒ the enricher is `unknown`, never a fabricated `ok`', async () => {
  // Same fail-closed rule as getLabelerHealth: a verify script (or a pre-boot read) must not be
  // told enrichment is healthy just because nothing has contradicted it.
  const d = startEnrichDrainer({ db: makeDb([], { approved: 'qwen3.5:4b' }).db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, log: () => {} });
  d.stop?.();                                   // stop() clears the module handle
  const h = getEnricherHealth();
  assert.equal(h.status, 'unknown', `no live drainer must read 'unknown' — got '${h.status}'`);
  for (const k of ['status', 'message', 'detail', 'model', 'progress']) assert.ok(k in h, `the absent shape must still be uniform: missing ${k}`);
});

// ── M10) the slice is RENDERED — a report nobody can see is not a surface ───────────
await t('M10. the owner SEES each member honestly: a choice is not a fault, a pull shows a % (mounted, not grepped)', async () => {
  // WHY MOUNTED. Every claim here is about what the owner SEES — "declining is not an
  // error", "a 3.4GB pull shows a number". Source text cannot witness a rendered colour or a
  // bar's width, and M6b's regex ancestor passed with the option COMMENTED OUT (2026-07-16).
  const { execFileSync } = await import('node:child_process');
  let raw;
  try {
    raw = execFileSync('node', ['--conditions', 'browser', 'test/mount-model-health.mjs'],
      { cwd: 'portal-app', encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    // FAIL-CLOSED, not skip — CI installs portal-app before `npm run verify`.
    throw new Error(`could not mount ModelHealth — run \`npm --prefix portal-app ci\` first. ${String(e?.stderr || e?.message || e).slice(0, 300)}`);
  }
  const r = JSON.parse(raw.trim().split('\n').pop());

  // 1. THE FAULTS ARE RED. This runs FIRST and is what makes the rest non-vacuous: a
  //    component that rendered everything grey would sail through every "is not a fault"
  //    assertion below. This proves the fault rendering exists to be withheld.
  assert.ok(r.error.isFault, 'a genuine error MUST render as a fault — otherwise the "not a fault" rows below prove nothing');
  assert.ok(r.down.isFault, 'and so must a dead component');
  assert.ok(r.deps_missing.isWarn, 'missing deps is actionable — surfaced as a warning, not silence');

  // 1b. A CLASSIFIED fault leads with the accurate MESSAGE; ollama's raw detail rides underneath.
  //     The old code rendered `detail || message`, so with `message` a hardcoded "runtime not
  //     reachable" the owner saw the raw ollama string OR a lie — never the actionable cause.
  //     Now the classified message leads and the detail is a secondary hint. The regex on the
  //     PRIMARY line is the mutation witness: under `detail || message` the primary line is the
  //     raw "ollama pull failed: … no space left" string, which does NOT match /disk space/.
  assert.ok(r.unavailable.isFault, 'a classified runtime/download/disk fault is still red');
  assert.match(r.unavailable.badText, /disk space|free up space/i, `the ACCURATE message must LEAD — not the raw ollama string, not a hardcoded "runtime not reachable": read "${r.unavailable.badText}"`);
  assert.ok(r.unavailable.hint && /no space left/i.test(r.unavailable.hint), `ollama's own detail must still be shown as a secondary hint — read "${r.unavailable.hint}"`);
  assert.notEqual(r.unavailable.badText, r.unavailable.hint, 'message and detail are two DISTINCT lines — the detail must not replace the message');

  // 2. …and the CHOICES are not. 'no_model' and 'paused' are supported configurations
  //    (§3.10): rendering a deliberate choice as a fault trains the owner to "fix" it.
  assert.ok(!r.no_model.isFault && !r.no_model.isWarn, `declining is a supported config — it must not render as a fault (read "${r.no_model.text}")`);
  assert.match(r.no_model.text, /^Off\b/i, `and it must SAY it is off, not imply breakage — read "${r.no_model.text}"`);
  assert.ok(!r.paused.isFault && !r.paused.isWarn, 'the owner stopping the churn is a choice, not a fault');
  assert.match(r.paused.text, /paused/i, 'and a paused member must say so — "unknown forever" is the bug this replaced');

  // 3. 'unknown' is an honest ABSENCE, not a fault. Load-bearing while two health gaps are
  //    open (independent review, 2026-07-16): a CAUGHT-UP vault reads 'unknown' rather than
  //    'ok' (drainer.js `_modelReady` is stamped only when rows are pending), and a crashing
  //    cycle reads 'unknown' too. Until those close, the healthiest vault in the fleet lands
  //    here — painting it red would cry wolf on every mature vault after a restart.
  assert.ok(!r.unknown.isFault && !r.unknown.isWarn, `'unknown' is missing information, not a fault — read "${r.unknown.text}"`);
  assert.ok(!r.missing.isFault, 'and an ABSENT member degrades to the same honest absence, never a fabricated ✓');
  assert.doesNotMatch(r.missing.text, /✓|running on your device/i, 'a missing member must NOT claim the model is running');

  // 4. The pull the owner actually waits on. Byte-accurate, off ollama's stream.
  assert.ok(r.downloading.hasBar, 'a multi-GB pull is the longest unattended thing the app does — it gets a bar');
  assert.match(r.downloading.text, /\b37\s*%/, `the percentage must be RENDERED, not just carried — read "${r.downloading.text}"`);
  assert.match(r.downloading.barWidth, /width:\s*37%/, 'and the bar must actually track it — a bar pinned at 0 is a spinner wearing a costume');
  assert.equal(r.downloading.aria, '37', 'exposed to assistive tech too');
  // No number yet ⇒ indeterminate. A 0% bar on a 3.4GB pull reads as "stuck", which is the
  // one question this surface exists to answer.
  assert.ok(r.dl_nopct.barIndeterminate, 'a pull with no pct yet must read as moving, not as stuck at 0%');
  assert.match(r.dl_over.barWidth, /width:\s*100%/, 'a nonsense pct must clamp — never paint the bar off its track');

  // 5. THE EMBEDDER IS NOT A CHOICE (§3.10d-c). It is bundled: it cannot be declined and
  //    cannot be downloaded. Rendering it as an approvable card with a pre-ticked box is
  //    precisely the dishonesty §3.10 exists to remove.
  assert.match(r.inc_ok.text, /included/i, `the bundled embedder must read as "included" — got "${r.inc_ok.text}"`);
  assert.equal(r.inc_ok.controls, 0, 'and it must offer NO approvable control — a non-choice presented as consent is the dishonesty §3.10 removes');
  assert.doesNotMatch(r.inc_ok.text, /\boff\b|decline|approve/i, 'it has no off switch to report, so it must not imply one');
  assert.ok(r.inc_ok.okDot, 'a REPORTED-healthy embedder does get the green dot — otherwise the checks below prove only that nothing is ever green');

  // 5b. …AND THE BUNDLED MEMBER MUST FAIL CLOSED LIKE EVERY OTHER ONE. It is the only member
  //     with no approval step, which is exactly why it was the only one that failed OPEN: two
  //     independent reviews (2026-07-16) found `status === 'ok' || status === 'unknown'`
  //     painting the green dot, so an embedder that had reported NOTHING rendered "runs on
  //     your device" in green. Not a race — the host passes `models?.embedder`, which is null
  //     until the fetch resolves and forever if it fails (the catch is silent). The earlier
  //     assertions here (`!isFault` + /included/i) were both TRUE of that fabrication, which
  //     is why they never caught it: "not red" and "says included" are true of a lie too.
  for (const [k, r_] of [['inc_unknown', r.inc_unknown], ['inc_missing', r.inc_missing]]) {
    assert.ok(!r_.okDot, `${k}: an embedder that has reported nothing must NOT paint the green health dot — guessing 'ok' fabricates health, which is what this slice exists to remove`);
    assert.ok(!r_.isFault, `${k}: …and it is not BROKEN either — 'unknown' is missing information`);
    assert.match(r_.text, /included/i, `${k}: it is still included — no report must not un-say the one fact that never changes`);
  }
  // …but a genuinely dead embedder is still worth reporting: "not a choice" ≠ "never a fault".
  assert.ok(r.inc_down.isFault, 'a DEAD embedder is a real fault — "not approvable" must not mean "never reported"');
  // …and its most LIKELY real fault is a setup step, not progress. `deps_missing` used to fall
  // to the busy branch and pulse blue — a permanent, actionable fault dressed as work underway,
  // while the SAME status on a consented member correctly read as a warning.
  assert.ok(r.inc_deps.isWarn, 'deps_missing is an actionable setup step — it must warn, exactly as it does for a consented member');
  assert.ok(!r.inc_deps.busyDot, 'and it must NOT pulse as "in progress": nothing is progressing, and nothing will until the owner acts');
});

// ── M11) the members are WIRED in production, not just injectable ───────────────────
await t('M11. the REAL route serves all four members from the REAL supervisors (not a stub)', async () => {
  // WHY THIS EXISTS. M4b/M4c inject health functions as STUBS, so they prove the readiness
  // NORMALIZER and nothing about whether anything wires the real ones in. An independent
  // review (2026-07-16) deleted the live `enricherHealth:` wiring from server-rest.js and the
  // ENTIRE gate stayed green — `models.enricher` would read 'unknown' forever on the real
  // route. That is the same shape as the dormancy this file exists to catch: a report that
  // exists but reaches nobody. So: boot the real server and read the real route.
  const { startRestServer } = await import('../src/server-rest.js');
  const Database = (await import('better-sqlite3')).default;
  const { applyMigrations } = await import('../src/db/migrate.js');
  const { rmSync, mkdirSync } = await import('node:fs');
  const DB = 'data/verify-model-consent-wiring.db', KCV = 'data/verify-model-consent-wiring-kcv.json';
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  mkdirSync('data', { recursive: true });
  const raw = new Database(DB); applyMigrations(raw); raw.close();
  const hex = () => crypto.randomBytes(32).toString('hex');
  const srv = await startRestServer({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(), port: 0, host: '127.0.0.1', portalMode: 'legacy' });
  // Drive the REAL supervisor to a DISTINCTIVE state. This is the whole trick: the health
  // lives in drainer.js's module scope, so a drainer started here is the same instance the
  // server's readiness reads — IF the server actually wired it. 'no_model' is the right
  // probe because an UNWIRED member degrades to 'unknown', so the two are distinguishable.
  //
  // ⚠️ Do NOT weaken this to "a fresh vault reads no_model": it does not. A freshly booted
  // server has no drainer at all (`unknown` / "Labeling has not started."), which is exactly
  // what an unwired member reads — an assertion that cannot tell those apart proves nothing.
  const drainer = startEnrichDrainer({ db: makeDb([], { approved: null }).db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, log: () => {} });
  try {
    await waitFor(() => getLabelerHealth()?.status === 'no_model');
    const liveLabeler = getLabelerHealth(), liveEnricher = getEnricherHealth();
    assert.equal(liveLabeler.status, 'no_model', `probe setup: the real labeler must reach 'no_model' — got '${liveLabeler.status}'`);

    const r = await fetch(`${srv.url}/api/v1/portal/readiness?slices=models`);
    assert.equal(r.status, 200, 'the slice the screen renders must be servable BY SLICE — never `fresh` (a multi-second SQLCipher decrypt)');
    const { models } = await r.json();
    assert.ok(models, 'the `models` slice must be served — the renderer has nothing to render without it');

    // All four, uniform. This is the shape the UI binds to.
    // ⚠️ SHAPE ONLY — this loop proves NOTHING about wiring. readiness.js pads an absent
    // health to `unknown` with all five keys present, so an unwired member sails through
    // `k in models[m]` (the padding trap). The mirror assertions below are the real test.
    for (const m of ['embedder', 'labeler', 'enricher', 'transcriber']) {
      assert.ok(models[m], `models.${m} missing from the REAL route — four members, or a task runs dormant and silent`);
      for (const k of ['status', 'message', 'detail', 'model', 'progress']) {
        assert.ok(k in models[m], `models.${m}.${k} missing — one shape for all four`);
      }
      assert.ok(typeof models[m].status === 'string' && models[m].status, `models.${m}.status must be a real enum`);
    }

    // THE WIRING ASSERTIONS — the route must MIRROR each live supervisor, not merely be shaped
    // like it. Deleting any `*Health:` line from server-rest.js's createReadiness call now trips
    // this: readiness pads the absent member to `unknown` with its OWN fallback message, which
    // is deliberately distinct from every supervisor's real one ("Embedding has not started."
    // vs the embedder's "Embedding engine not started yet."), so the pad can never impersonate
    // the source.
    //
    // ⚠️ An earlier version of this row pinned only the labeler + enricher, and an independent
    // review (2026-07-16) deleted `embedderHealth:` AND `transcriberHealth:` with the gate still
    // GREEN — the exact half-vacuous hole this file exists to close, reopened one member over.
    // Compare against the LIVE fn, never a literal: the messages are the supervisors' to change.
    const live = {
      embedder: readinessEmbedderHealth(),
      labeler: liveLabeler,
      enricher: liveEnricher,
      transcriber: readinessTranscriberHealth(),
    };
    for (const m of ['embedder', 'labeler', 'enricher', 'transcriber']) {
      assert.equal(models[m].status, live[m].status,
        `the route must serve the REAL ${m} health — route '${models[m].status}' vs supervisor '${live[m].status}' (an UNWIRED member reads 'unknown')`);
      assert.equal(models[m].message, live[m].message ?? null,
        `…and the REAL ${m} MESSAGE — route "${models[m].message}" vs supervisor "${live[m].message}". An unwired member reads readiness's own fallback, which is what this catches.`);
      assert.equal(models[m].model, live[m].model ?? null, `…and the REAL ${m} model name`);
    }
    // …and the pair the owner's consent actually rides on, stated positively.
    assert.equal(models.labeler.status, 'no_model', 'nothing approved ⇒ the owner is told so, through the real route');
    assert.equal(models.enricher.status, 'no_model', 'and the enricher says so INDEPENDENTLY — its own member, never the labeler\'s');
    assert.equal(models.enricher.model, null, 'with nothing approved, it must name no model');

    // NO PLAINTEXT (CLAUDE.md §1): the slice carries enums, counts and model NAMES only.
    const body = JSON.stringify(models);
    assert.doesNotMatch(body, /ENCRYPTION_MASTER_KEY|BEGIN [A-Z ]*PRIVATE KEY/, 'the readiness surface must never carry a secret');
  } finally {
    drainer.stop?.();
    try { srv.server.close(); srv.close?.(); } catch {}
    for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  }
});

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — nothing downloads until approved; the pull is visible + content-free; declining is supported' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
