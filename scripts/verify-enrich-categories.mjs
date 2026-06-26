// scripts/verify-enrich-categories.mjs — Context Engine L1 (Phase 1b) gate.
//
// Fully isolated (no vault, no model): exercises the domain+register tagging as pure units —
//   1. taxonomy shape (7 domains, 12 sub-registers → 4 primaries)
//   2. prompt carries both axes + injection fence
//   3. parser: strict JSON, lenient fallback, garbage → null (never throws)
//   4. classifier: maps a model reply to labels; a model OUTAGE rejects (→ row stays pending)
//   5. enrichCategoriesOnce: writes labels + marks processed; empty content skips the call;
//      a transient failure STOPS the batch and leaves rows pending; absent classifier = no-op
//   6. migration 0038 adds the five plaintext columns + the GROUP BY index; 0041 adds provenance
//   7. restampLegacyCategories: one-shot idempotent 0041 backfill — re-stamps provenance onto
//      legacy/external-backfill rows (processed=1, categorized_at NULL) ONLY, with an honest
//      sentinel (not now()), labels & classifier untouched, user-scoped, idempotent on re-run
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const {
  TAXONOMY_VERSION, DOMAINS, SUBREGISTERS, REGISTER_PARENT,
  buildCategoryPrompt, parseCategoryResponse,
} = await import('../src/enrich/categories-prompt.js');
const { createCategoryClassifier, DEFAULT_LABEL_MODEL } = await import('../src/enrich/categories.js');
const { createEnrichmentService } = await import('../src/enrich/service.js');
const { INFERENCE_TASKS } = await import('../src/inference/resolve.js');
const { defaultLabelModel } = await import('../src/enrich/drainer.js');
const { createMessagesNamespace, CATEGORIES_BACKFILL_SENTINEL } = await import('../src/db/messages.js');
const { labelingRecommendedModel, ROLE_RECOMMENDATIONS } = await import('../src/inference/role-models.js');

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); }
};

// ── 1. taxonomy shape ───────────────────────────────────────────────────────
ok(DOMAINS.length === 7, '7 domains', `(${DOMAINS.length})`);
ok(DOMAINS[6] === 'Self & Inner Life' && DOMAINS[1] === 'Work & Creativity', 'locked domain names present');
ok(SUBREGISTERS.length === 12, '12 sub-registers', `(${SUBREGISTERS.length})`);
ok(new Set(Object.values(REGISTER_PARENT)).size === 4, '12 sub-registers map to 4 primaries');
ok(SUBREGISTERS.every((r) => REGISTER_PARENT[r]), 'every sub-register has a parent');
ok(TAXONOMY_VERSION === 'v2', 'taxonomy version v2 (prompt v2: concrete Self & Inner Life)');

// ── 2. prompt ───────────────────────────────────────────────────────────────
const prompt = buildCategoryPrompt('shipped the auth module');
ok(/Body & Health/.test(prompt) && /Self & Inner Life/.test(prompt), 'prompt lists the 7 domains');
ok(/Build/.test(prompt) && /Store/.test(prompt), 'prompt lists the registers');
ok(prompt.includes('<<<shipped the auth module>>>'), 'prompt fences the message as data');

// ── 3. parser ───────────────────────────────────────────────────────────────
const p1 = parseCategoryResponse('{"domain": 2, "register": "Build"}');
ok(p1.domain === 'Work & Creativity' && p1.register === 'Agency' && p1.subregister === 'Build', 'strict JSON → mapped labels');
const p2 = parseCategoryResponse('the answer is domain 7 and register Bond');
ok(p2.domain === 'Self & Inner Life' && p2.subregister === 'Bond' && p2.register === 'Resonance', 'lenient fallback parses prose');
const p3 = parseCategoryResponse('completely unparseable ~~~');
ok(p3.domain === null && p3.register === null, 'garbage → null labels (no throw)');
const p4 = parseCategoryResponse('{"domain": 9, "register": "Nope"}');
ok(p4.domain === null && p4.subregister === null, 'out-of-range values rejected');

// ── 4. classifier ───────────────────────────────────────────────────────────
const classifyOk = createCategoryClassifier({ infer: async () => '{"domain":3,"register":"Bond"}' });
const got = await classifyOk('called Alice, told her I missed her');
ok(got.domain === 'People & Relationships' && got.subregister === 'Bond', 'classifier maps a model reply');
const classifyDown = createCategoryClassifier({ infer: async () => { throw new Error('ECONNREFUSED'); } });
let rejected = false;
try { await classifyDown('x'); } catch { rejected = true; }
ok(rejected, 'a model outage rejects (so the stage leaves the row pending)');
let ctor = false; try { createCategoryClassifier({}); } catch { ctor = true; }
ok(ctor, 'classifier requires an infer fn');

// ── 5. enrichCategoriesOnce ─────────────────────────────────────────────────
function fakeMessages(rows) {
  const store = new Map(rows.map((r) => [r.id, { ...r }]));
  return {
    _store: store,
    // required by the service constructor (unused here)
    selectPendingEnrichment: async () => [], updateEnrichment: async () => {},
    selectPendingNlp: async () => [], updateNlp: async () => {},
    async selectPendingCategories(_u, { limit = 25 } = {}) {
      // mirror the SQL predicate: content != '' (whitespace-only rows DO pass the DAL and are
      // handled by the stage's own if(!content) guard — that's what we're testing).
      return [...store.values()].filter((r) => !r.categories_processed && r.content != null && r.content !== '').slice(0, limit)
        .map((r) => ({ id: r.id, content: r.content, scope: r.scope }));
    },
    async updateCategories(id, _u, fields) {
      const r = store.get(id); if (!r) return;
      const processed = fields.categoriesProcessed ?? 1;
      Object.assign(r, {
        domain: fields.domain ?? r.domain ?? null, register: fields.register ?? r.register ?? null,
        subregister: fields.subregister ?? r.subregister ?? null,
        taxonomy_version: fields.taxonomyVersion ?? r.taxonomy_version ?? null,
        categories_model: fields.model ?? r.categories_model ?? null,   // provenance (0041)
        categories_processed: processed,
        // mirror messages.js: stamp categorized_at only on a real attempt (=1)
        categorized_at: processed === 1 ? '2026-06-20T00:00:00.000Z' : (r.categorized_at ?? null),
      });
    },
  };
}
const baseDeps = (messages, classify) => ({ messages, embed: { embed: async () => [] }, getMasterKey: async () => 'k', classify });

// happy path: 3 messages tagged
{
  const m = fakeMessages([
    { id: 'a', content: 'shipped the migration', categories_processed: 0 },
    { id: 'b', content: 'sat with my anxiety', categories_processed: 0 },
    { id: 'c', content: '   ', categories_processed: 0 }, // empty → skipped, no classify call
  ]);
  let calls = 0;
  const classify = async () => { calls++; return { domain: 'Work & Creativity', register: 'Agency', subregister: 'Build' }; };
  const svc = createEnrichmentService(baseDeps(m, classify));
  const r = await svc.enrichCategoriesOnce({ userId: 'u' });
  ok(r.enriched === 2, 'tags the 2 non-empty messages', `(${r.enriched})`);
  ok(calls === 2, 'empty-content row never hits the model', `(${calls} calls)`);
  ok(m._store.get('a').domain === 'Work & Creativity' && m._store.get('a').categories_processed === 1, 'labels + processed flag written');
  ok(m._store.get('c').categories_processed === 1 && m._store.get('c').domain == null, 'empty row marked processed, no labels');
}

// transient model outage: stop the batch, leave rows pending
{
  const m = fakeMessages([
    { id: 'a', content: 'first', categories_processed: 0 },
    { id: 'b', content: 'second', categories_processed: 0 },
  ]);
  const classify = async () => { throw new Error('model down'); };
  const svc = createEnrichmentService(baseDeps(m, classify));
  const r = await svc.enrichCategoriesOnce({ userId: 'u' });
  ok(r.failed === 1 && r.enriched === 0, 'outage → failed, nothing enriched');
  ok(![...m._store.values()].some((x) => x.categories_processed), 'rows stay pending after an outage');
}

// no classifier → graceful no-op
{
  const m = fakeMessages([{ id: 'a', content: 'x', categories_processed: 0 }]);
  const svc = createEnrichmentService(baseDeps(m, undefined));
  const r = await svc.enrichCategoriesOnce({ userId: 'u' });
  ok(r.skipped === 'no-classifier', 'absent classifier → no-op skip');
}

// provenance (0041): a tagged row records WHEN + BY WHICH model
{
  const m = fakeMessages([{ id: 'a', content: 'shipped the migration', categories_processed: 0 }]);
  // createCategoryClassifier carries the model label → classify.model → updateCategories.model
  const classify = createCategoryClassifier({ model: 'llama3.1', infer: async () => '{"domain":2,"register":"Build"}' });
  ok(classify.model === 'llama3.1', 'classifier exposes its model label');
  const svc = createEnrichmentService(baseDeps(m, classify));
  await svc.enrichCategoriesOnce({ userId: 'u' });
  const row = m._store.get('a');
  ok(row.categories_model === 'llama3.1', 'tagged row records which model', `(${row.categories_model})`);
  ok(typeof row.categorized_at === 'string' && row.categorized_at.length > 0, 'tagged row records when (categorized_at stamped)');
}

// ── 6. migration ────────────────────────────────────────────────────────────
const mig = readFileSync(join(ROOT, 'migrations/0038_message_categories.sql'), 'utf8');
for (const col of ['domain', 'register', 'subregister', 'taxonomy_version', 'categories_processed']) {
  ok(new RegExp(`ADD COLUMN ${col}\\b`).test(mig), `migration adds column ${col}`);
}
ok(/CREATE INDEX IF NOT EXISTS idx_messages_domain ON messages\(user_id, domain\)/.test(mig), 'migration adds the GROUP BY domain index');

// 0041 provenance columns
const mig41 = readFileSync(join(ROOT, 'migrations/0041_categories_provenance.sql'), 'utf8');
for (const col of ['categorized_at', 'categories_model']) {
  ok(new RegExp(`ADD COLUMN ${col}\\b`).test(mig41), `migration 0041 adds column ${col}`);
}

// ── 7. labeling-model curation (2026-06-21) ──────────────────────────────────
ok(DEFAULT_LABEL_MODEL === 'qwen3.5:4b', 'default labeling model is qwen3.5:4b (won the 4-model eval)', `(${DEFAULT_LABEL_MODEL})`);
// Single source of truth: the "Recommended for labeling" badge and the actual default must not drift.
ok(DEFAULT_LABEL_MODEL === labelingRecommendedModel(), 'DEFAULT_LABEL_MODEL is single-sourced from role-models.js (badge == default)');
ok(ROLE_RECOMMENDATIONS.descriptions.kind === 'cloud-eu-zdr' && ROLE_RECOMMENDATIONS.descriptions.presetId === 'regolo', 'descriptions role recommends EU-ZDR Regolo (never US — §4g)');
ok(INFERENCE_TASKS.includes('categorize'), "'categorize' is a first-class inference task (shows in Settings → Intelligence)");
ok(createCategoryClassifier({ model: DEFAULT_LABEL_MODEL, infer: async () => '{}' }).model === 'qwen3.5:4b', 'classifier carries the default model as provenance');
// defaultLabelModel: settings override wins; else default. Hermetic (no Ollama).
ok((await defaultLabelModel({ users: { getSettings: async () => ({ taskModels: { categorize: { model: 'gemma4:12b' } } }) } }, 'u')) === 'gemma4:12b', 'labeling model honors settings.taskModels.categorize.model');
ok((await defaultLabelModel({ users: { getSettings: async () => ({}) } }, 'u')) === 'qwen3.5:4b', 'labeling model falls back to default when unset');
ok((await defaultLabelModel({}, 'u')) === 'qwen3.5:4b', 'labeling model fail-soft → default on read error');

// ── 8. restampLegacyCategories (0041 backfill provenance) ────────────────────
// Exercises the REAL DAL method (createMessagesNamespace) against an in-memory store. The fake
// d1Query interprets ONLY the one restamp UPDATE: it applies the actual WHERE predicate + binds
// the actual params the production SQL ships, then returns the d1 { meta: { changes } } shape — so
// this proves the real statement (predicate, user-scoping, sentinel binding), not a JS re-implementation.
function fakeStore(rows) {
  const store = new Map(rows.map((r) => [r.id, { ...r }]));
  const d1Query = async (sql, params) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    // restampLegacyCategories issues one of TWO statements; the SQL is pinned exactly (fail closed —
    // any other SQL throws, so the method can't touch labels via some unexpected path).
    let changes = 0;
    if (/categories_model IS NULL/.test(s)) {
      // Model-attribution pass — anchored on categories_model IS NULL; re-attributable, idempotent.
      const m = /^UPDATE messages SET categorized_at = COALESCE\(categorized_at, \?\), categories_model = \? WHERE user_id = \? AND categories_processed = 1 AND categories_model IS NULL AND forgotten_at IS NULL AND \(categorized_at IS NULL OR categorized_at = \?\)$/.exec(s);
      if (!m) throw new Error(`fakeStore: unexpected model-pass SQL: ${s}`);
      const [sentinel, model, userId, sentinel2] = params;
      for (const r of store.values()) {
        if (r.user_id !== userId) continue;                  // user-scoped (tenant guard)
        if (r.categories_processed !== 1) continue;          // never pending rows
        if (r.categories_model != null) continue;            // idempotency anchor: only model-less rows
        if (r.forgotten_at != null) continue;                // never forgotten rows
        if (!(r.categorized_at == null || r.categorized_at === sentinel2)) continue; // legacy rows only
        r.categorized_at = r.categorized_at == null ? sentinel : r.categorized_at;   // COALESCE
        r.categories_model = model;
        changes++;
      }
    } else {
      // Default time-only pass.
      const m = /^UPDATE messages SET categorized_at = \? WHERE user_id = \? AND categories_processed = 1 AND categorized_at IS NULL AND forgotten_at IS NULL$/.exec(s);
      if (!m) throw new Error(`fakeStore: unexpected default-pass SQL: ${s}`);
      const [sentinel, userId] = params;
      for (const r of store.values()) {
        if (r.user_id !== userId) continue;                  // user-scoped (tenant guard)
        if (r.categories_processed !== 1) continue;          // never pending rows
        if (r.categorized_at != null) continue;              // never already-stamped rows
        if (r.forgotten_at != null) continue;                // never forgotten rows
        r.categorized_at = sentinel;
        changes++;
      }
    }
    return { results: [], success: true, meta: { changes } };
  };
  // No classifier/embed/infer in deps at all — the method CANNOT classify by construction; and any
  // SQL other than the single restamp UPDATE throws above (so it can't touch labels via some path).
  const ns = createMessagesNamespace({
    d1Query,
    d1Batch: async () => { throw new Error('d1Batch not expected'); },
    firstRow: (res) => (res?.results || [])[0],
  });
  return { ns, store };
}

{
  const rows = [
    // legacy/backfill: tagged out-of-app, predates provenance → MUST restamp
    { id: 'L1', user_id: 'u', categories_processed: 1, categorized_at: null, categories_model: null,
      domain: 'Work & Creativity', register: 'Agency', subregister: 'Build', forgotten_at: null },
    { id: 'L2', user_id: 'u', categories_processed: 1, categorized_at: null, categories_model: null,
      domain: 'People & Relationships', register: 'Resonance', subregister: 'Bond', forgotten_at: null },
    // already-stamped (forward path) → MUST be left untouched
    { id: 'S1', user_id: 'u', categories_processed: 1, categorized_at: '2026-06-20T12:00:00.000Z', categories_model: 'llama3.1',
      domain: 'Body & Health', register: 'Agency', subregister: 'Build', forgotten_at: null },
    // pending (drainer's job) → MUST be left untouched
    { id: 'P1', user_id: 'u', categories_processed: 0, categorized_at: null, categories_model: null,
      domain: null, register: null, subregister: null, forgotten_at: null },
    { id: 'P2', user_id: 'u', categories_processed: null, categorized_at: null, categories_model: null,
      domain: null, register: null, subregister: null, forgotten_at: null },
    // forgotten legacy row → MUST be left untouched (redacted, no resurrection)
    { id: 'F1', user_id: 'u', categories_processed: 1, categorized_at: null, categories_model: null,
      domain: 'Self & Inner Life', register: 'Resonance', subregister: 'Bond', forgotten_at: '2026-06-19T00:00:00.000Z' },
    // a DIFFERENT user's legacy row → MUST NOT be restamped (tenant isolation)
    { id: 'O1', user_id: 'other', categories_processed: 1, categorized_at: null, categories_model: null,
      domain: 'Work & Creativity', register: 'Agency', subregister: 'Build', forgotten_at: null },
  ];
  const { ns, store } = fakeStore(rows);

  ok(typeof ns.restampLegacyCategories === 'function', 'restampLegacyCategories is a DAL method');

  // (5) accurate {restamped} count — only the 2 legacy rows for user u
  const r1 = await ns.restampLegacyCategories('u');
  ok(r1.restamped === 2, 'restamps ONLY the legacy rows (processed=1, categorized_at NULL)', `(${r1.restamped})`);

  // (4) honest provenance: sentinel (NOT now()), model stays NULL with no model arg
  ok(store.get('L1').categorized_at === CATEGORIES_BACKFILL_SENTINEL, 'legacy row stamped with the backfill sentinel (not now())');
  ok(CATEGORIES_BACKFILL_SENTINEL === '1970-01-01T00:00:00.000Z', 'sentinel is the Unix epoch (honest "time unknown")');
  ok(store.get('L1').categories_model === null && store.get('L2').categories_model === null, 'categories_model stays NULL when no model arg');

  // (3) labels untouched, classifier never invoked
  ok(store.get('L1').domain === 'Work & Creativity' && store.get('L1').register === 'Agency' && store.get('L1').subregister === 'Build',
     'domain/register/subregister labels left intact');
  ok(store.get('L2').domain === 'People & Relationships' && store.get('L2').subregister === 'Bond', 'second legacy row labels intact');

  // (2) already-stamped row untouched
  ok(store.get('S1').categorized_at === '2026-06-20T12:00:00.000Z' && store.get('S1').categories_model === 'llama3.1',
     'already-stamped row left untouched');

  // (3) pending rows untouched (never widens the drain)
  ok(store.get('P1').categorized_at === null && store.get('P1').categories_processed === 0, 'pending row (processed=0) untouched');
  ok(store.get('P2').categorized_at === null && store.get('P2').categories_processed === null, 'pending row (processed NULL) untouched');

  // forgotten row untouched
  ok(store.get('F1').categorized_at === null, 'forgotten legacy row not restamped');

  // (6) user-scoped — the other tenant's legacy row is never touched
  ok(store.get('O1').categorized_at === null && store.get('O1').categories_model === null, 'different user_id rows not restamped (tenant isolation)');

  // (2) idempotent — a SECOND run restamps 0
  const r2 = await ns.restampLegacyCategories('u');
  ok(r2.restamped === 0, 'second run restamps 0 (idempotent)', `(${r2.restamped})`);
}

// (4) explicit model arg — a KNOWN external tagger stamps categories_model
{
  const rows = [
    { id: 'L1', user_id: 'u', categories_processed: 1, categorized_at: null, categories_model: null,
      domain: 'Work & Creativity', register: 'Agency', subregister: 'Build', forgotten_at: null },
  ];
  const { ns, store } = fakeStore(rows);
  const r = await ns.restampLegacyCategories('u', { model: 'external-backfill-v1' });
  ok(r.restamped === 1, 'restamps the legacy row when a model is supplied');
  ok(store.get('L1').categorized_at === CATEGORIES_BACKFILL_SENTINEL, 'still uses the sentinel timestamp with an explicit model');
  ok(store.get('L1').categories_model === 'external-backfill-v1', 'explicit model arg recorded as categories_model');
  // labels still untouched
  ok(store.get('L1').domain === 'Work & Creativity' && store.get('L1').subregister === 'Build', 'labels untouched with explicit model');
}

// (fix) stamp-time-first-then-attribute-model-later must NOT silently no-op (the idempotency trap)
{
  const rows = [
    { id: 'L1', user_id: 'u', categories_processed: 1, categorized_at: null, categories_model: null,
      domain: 'Work & Creativity', register: 'Agency', subregister: 'Build', forgotten_at: null },
  ];
  const { ns, store } = fakeStore(rows);
  const a = await ns.restampLegacyCategories('u'); // default time-only pass first
  ok(a.restamped === 1 && store.get('L1').categorized_at === CATEGORIES_BACKFILL_SENTINEL && store.get('L1').categories_model === null,
     'time-first pass stamps the sentinel, leaves model NULL');
  const b = await ns.restampLegacyCategories('u', { model: 'external-backfill-v1' }); // later model pass
  ok(b.restamped === 1 && store.get('L1').categories_model === 'external-backfill-v1',
     'later model pass STILL attributes the model to an already-time-stamped legacy row (no silent no-op)');
  ok(store.get('L1').categorized_at === CATEGORIES_BACKFILL_SENTINEL, 'time sentinel preserved across the model pass (COALESCE, not overwritten)');
  const c = await ns.restampLegacyCategories('u', { model: 'external-backfill-v1' }); // idempotent
  ok(c.restamped === 0, 'second model pass restamps 0 (idempotent on categories_model IS NULL)');
}

// (fix) model:null is treated as no-model — no false external-tagger attribution
{
  const rows = [
    { id: 'L1', user_id: 'u', categories_processed: 1, categorized_at: null, categories_model: null,
      domain: 'Work & Creativity', register: 'Agency', subregister: 'Build', forgotten_at: null },
  ];
  const { ns, store } = fakeStore(rows);
  const r = await ns.restampLegacyCategories('u', { model: null });
  ok(r.restamped === 1 && store.get('L1').categories_model === null && store.get('L1').categorized_at === CATEGORIES_BACKFILL_SENTINEL,
     'model:null behaves as the default time-only pass (no false attribution)');
}

console.log(`\n${pass} pass · ${fail} fail`);
if (fail === 0) { console.log('VERDICT: GO'); process.exit(0); }
console.log('VERDICT: NO-GO'); process.exit(1);
