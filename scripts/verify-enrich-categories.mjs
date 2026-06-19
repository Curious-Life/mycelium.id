// scripts/verify-enrich-categories.mjs — Context Engine L1 (Phase 1b) gate.
//
// Fully isolated (no vault, no model): exercises the domain+register tagging as pure units —
//   1. taxonomy shape (7 domains, 12 sub-registers → 4 primaries)
//   2. prompt carries both axes + injection fence
//   3. parser: strict JSON, lenient fallback, garbage → null (never throws)
//   4. classifier: maps a model reply to labels; a model OUTAGE rejects (→ row stays pending)
//   5. enrichCategoriesOnce: writes labels + marks processed; empty content skips the call;
//      a transient failure STOPS the batch and leaves rows pending; absent classifier = no-op
//   6. migration 0038 adds the five plaintext columns + the GROUP BY index
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const {
  TAXONOMY_VERSION, DOMAINS, SUBREGISTERS, REGISTER_PARENT,
  buildCategoryPrompt, parseCategoryResponse,
} = await import('../src/enrich/categories-prompt.js');
const { createCategoryClassifier } = await import('../src/enrich/categories.js');
const { createEnrichmentService } = await import('../src/enrich/service.js');

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
ok(TAXONOMY_VERSION === 'v1', 'taxonomy version v1');

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
      Object.assign(r, {
        domain: fields.domain ?? r.domain ?? null, register: fields.register ?? r.register ?? null,
        subregister: fields.subregister ?? r.subregister ?? null,
        taxonomy_version: fields.taxonomyVersion ?? r.taxonomy_version ?? null,
        categories_processed: fields.categoriesProcessed ?? 1,
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

// ── 6. migration ────────────────────────────────────────────────────────────
const mig = readFileSync(join(ROOT, 'migrations/0038_message_categories.sql'), 'utf8');
for (const col of ['domain', 'register', 'subregister', 'taxonomy_version', 'categories_processed']) {
  ok(new RegExp(`ADD COLUMN ${col}\\b`).test(mig), `migration adds column ${col}`);
}
ok(/CREATE INDEX IF NOT EXISTS idx_messages_domain ON messages\(user_id, domain\)/.test(mig), 'migration adds the GROUP BY domain index');

console.log(`\n${pass} pass · ${fail} fail`);
if (fail === 0) { console.log('VERDICT: GO'); process.exit(0); }
console.log('VERDICT: NO-GO'); process.exit(1);
