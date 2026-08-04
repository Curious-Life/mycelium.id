#!/usr/bin/env node
// verify:enrich-batch — D-132 (U-C) proof: L1 categorize can label K messages in
// ONE model call, WITHOUT weakening any per-row contract. The claims:
//   B1  one batch call labels K substantive rows, id-keyed — a shuffled reply
//       with a bogus item still lands each label on the RIGHT row.
//   B2  a non-array / prose reply matches NOTHING (strict parser — the single
//       parser's digit/word salvage would silently mislabel at batch scale);
//       every row falls back to the single path IN THE SAME PASS and still
//       gets its correct label. Zero attempt burn from the failed batch.
//   B3  a batch OUTAGE (infer throws) burns ZERO attempts: rows stay pending
//       through LABEL_MAX_ATTEMPTS×3 passes (the embed-path mass-loss rule).
//   B4  a PARTIAL reply: matched rows write from the batch; unmatched rows
//       take the single path the same pass.
//   B5  duplicate `i` first-wins; unknown `i` ignored; all-null items are
//       non-answers (fall back, never a null overwrite).
//   B6  MYCELIUM_L1_BATCH=1 → the batch path is fully disabled (revert lever;
//       byte-identical per-row behaviour).
//   B7  the batch call's budgets SCALE: maxTokens = 48·K+16 and num_ctx covers
//       the whole prompt (the numCtx:1024 truncation hazard, sweep v3c) —
//       captured from the real classify.batch's second infer arg.
//
// MUTATION-TESTED: (D-132, 2026-08-04) parseCategoryBatchResponse made lenient
// (top-level-array requirement dropped: a valid non-array object is coerced to
// a one-item batch and applied to item 1) → B2 RED while every other check
// stays GREEN. NOTE the first run of this mutation stayed GREEN: B2's original
// fixture used a PROSE-wrapped reply, which throws at JSON.parse before the
// mutated leniency could activate — the fixture was rewritten to a VALID
// non-array object (the load-bearing case) and the mutation re-run to RED.
// Restored → GO.
// MUTATION-TESTED: (D-132, 2026-08-04) the batch-failure catch in
// enrichCategoriesOnce rethrows instead of nulling (a batch outage escapes the
// zero-burn contract) → the gate REDs with `fatal: model down` (the outage now
// escapes enrichCategoriesOnce entirely — exactly the mass-burn/throw class the
// catch exists to contain). Restored → GO.
// MUTATION-TESTED: (D-132, 2026-08-04) id-keying broken (parseCategoryBatchResponse
// assigns matches positionally by array order instead of the echoed `i`) →
// B1b RED (the shuffled reply lands labels on the WRONG rows: a=Attune,
// b=Build) AND B4 RED (the partial reply mis-aligns) while B2/B3/B5-B7 stay
// GREEN. Restored → GO.
// MUTATION-TESTED: (round-1 gate review H6, 2026-08-04) the batch write's
// categoriesProcessed flipped to -1 (labeled rows land as gave-up terminals —
// the boot reclaim would then relabel them forever) → B1d RED. Restored → GO.
// MUTATION-TESTED: (round-1 gate review H7, 2026-08-04) the drainer's L1 infer
// wiring reverted to the fixed pre-batch caps (second arg dropped — every
// production batch reply would truncate at 40 tokens and fall back, one wasted
// model call per pass, while all behavioural checks stay green) → B8 and B8b
// RED (comment-proof static pins). Restored → GO.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
const { createCategoryClassifier } = await import('../src/enrich/categories.js');
const { createEnrichmentService } = await import('../src/enrich/service.js');

const ledger = [];
let allPass = true;
function check(name, cond, d = '') {
  const ok = !!cond;
  allPass = allPass && ok;
  ledger.push(`[${ok ? '✓' : '✗'}] ${name}${d ? `  ${d}` : ''}`);
}

function fakeMessages(rows) {
  const store = new Map(rows.map((r) => [r.id, { ...r }]));
  return {
    _store: store,
    selectPendingEnrichment: async () => [], updateEnrichment: async () => {},
    selectPendingNlp: async () => [], updateNlp: async () => {},
    async selectPendingCategories(_u, { limit = 25 } = {}) {
      return [...store.values()].filter((r) => !r.categories_processed && r.content != null && r.content !== '').slice(0, limit)
        .map((r) => ({ id: r.id, content: r.content, scope: r.scope }));
    },
    async updateCategories(id, _u, fields) {
      const r = store.get(id); if (!r) return;
      Object.assign(r, {
        domain: fields.domain ?? r.domain ?? null,
        register: fields.register ?? r.register ?? null,
        subregister: fields.subregister ?? r.subregister ?? null,
        categories_model: fields.model ?? r.categories_model ?? null,
        categories_processed: fields.categoriesProcessed ?? 1,
      });
    },
  };
}
const deps = (messages, classify) => ({ messages, embed: { embed: async () => [] }, getMasterKey: async () => 'k', classify });
const ROWS3 = () => [
  { id: 'a', content: 'shipped the auth module today', categories_processed: 0 },
  { id: 'b', content: 'sat with my anxiety this morning', categories_processed: 0 },
  { id: 'c', content: 'planned the family trip budget', categories_processed: 0 },
];

try {
  process.env.MYCELIUM_L1_BATCH = '8';

  // ── B1: one call, id-keyed, shuffled reply + bogus item ────────────────────
  {
    const m = fakeMessages(ROWS3());
    let calls = 0;
    const infer = async (prompt) => {
      calls++;
      // SHUFFLED + a bogus i:9 — item 2 answered first, item 1 last.
      return JSON.stringify([
        { i: 2, domain: 7, register: 'Attune' },
        { i: 9, domain: 1, register: 'Build' },
        { i: 3, domain: 3, register: 'Store' },
        { i: 1, domain: 1, register: 'Build' },
      ]);
    };
    const classify = createCategoryClassifier({ infer, model: 'gate-model' });
    const svc = createEnrichmentService(deps(m, classify));
    const r = await svc.enrichCategoriesOnce({ userId: 'u' });
    check('B1 one batch call labels all 3 rows', calls === 1 && r.enriched === 3, `calls=${calls} enriched=${r.enriched}`);
    check('B1b shuffled reply lands on the RIGHT rows (id-keyed, not positional)',
      m._store.get('a').subregister === 'Build' && m._store.get('b').subregister === 'Attune' && m._store.get('c').subregister === 'Store',
      `a=${m._store.get('a').subregister} b=${m._store.get('b').subregister} c=${m._store.get('c').subregister}`);
    check('B1c provenance recorded from the classifier model', m._store.get('a').categories_model === 'gate-model');
    // Round-1 gate review H6: batch writes must land as ATTEMPTED (=1), never a
    // terminal state — a -1 here would count labeled rows as gave-up and the
    // boot reclaim would relabel them forever.
    check('B1d batch writes land categories_processed = 1 (attempted, never a terminal)',
      ['a', 'b', 'c'].every((id) => m._store.get(id).categories_processed === 1));
  }

  // ── B2: strict parser — prose/non-array matches NOTHING; single-path fallback ──
  {
    const m = fakeMessages(ROWS3());
    const seen = [];
    const infer = async (prompt) => {
      seen.push(prompt);
      // A VALID JSON OBJECT (parses cleanly, top-level non-array) — the exact
      // shape a lenient parser would accept and mis-apply to item 1. The first
      // gate draft used a prose-wrapped reply here; JSON.parse threw on the
      // prose, so a leniency mutation never even activated (watched GREEN,
      // 2026-08-04) — the strictness claim was untested. Valid-but-non-array
      // is the load-bearing case.
      if (seen.length === 1) return JSON.stringify({ i: 1, domain: 1, register: 'Build' });
      return JSON.stringify({ domain: 1, register: 'Build' }); // single-path replies
    };
    const classify = createCategoryClassifier({ infer, model: 'gate-model' });
    const svc = createEnrichmentService(deps(m, classify));
    const r = await svc.enrichCategoriesOnce({ userId: 'u' });
    check('B2 strict: prose/non-array batch reply matches NOTHING; all rows fall back single-path in the same pass',
      seen.length === 4 && r.enriched === 3 && m._store.get('b').subregister === 'Build',
      `calls=${seen.length} enriched=${r.enriched}`);
  }

  // ── B3: batch outage burns ZERO attempts across many passes ────────────────
  {
    const m = fakeMessages(ROWS3());
    const infer = async () => { throw new Error('model down'); };
    const classify = createCategoryClassifier({ infer, model: 'gate-model' });
    const svc = createEnrichmentService(deps(m, classify));
    for (let i = 0; i < 15; i++) await svc.enrichCategoriesOnce({ userId: 'u' }); // LABEL_MAX_ATTEMPTS(5) × 3
    const states = [...m._store.values()].map((r) => r.categories_processed);
    check('B3 outage × 15 passes → every row still PENDING (zero attempt burn, no -1 terminals)',
      states.every((x) => !x), `states=[${states.join(',')}]`);
  }

  // ── B4: partial reply — matched from batch, rest single-path same pass ─────
  {
    const m = fakeMessages(ROWS3());
    const seen = [];
    const infer = async (prompt) => {
      seen.push(prompt);
      if (seen.length === 1) return JSON.stringify([{ i: 1, domain: 1, register: 'Build' }, { i: 3, domain: 3, register: 'Store' }]);
      return JSON.stringify({ domain: 7, register: 'Attune' });
    };
    const classify = createCategoryClassifier({ infer, model: 'gate-model' });
    const svc = createEnrichmentService(deps(m, classify));
    const r = await svc.enrichCategoriesOnce({ userId: 'u' });
    check('B4 partial batch reply → matched rows from batch, unmatched via single path, all labeled this pass',
      r.enriched === 3 && seen.length === 2 && m._store.get('b').subregister === 'Attune' && m._store.get('c').subregister === 'Store',
      `enriched=${r.enriched} calls=${seen.length}`);
  }

  // ── B5: duplicate i first-wins; all-null item is a non-answer ──────────────
  {
    const m = fakeMessages(ROWS3());
    const seen = [];
    const infer = async () => {
      seen.push(1);
      if (seen.length === 1) {
        return JSON.stringify([
          { i: 1, domain: 1, register: 'Build' },
          { i: 1, domain: 7, register: 'Attune' },       // duplicate — must NOT overwrite
          { i: 2, domain: 99, register: 'NotARegister' }, // all-null → non-answer → fallback
          { i: 3, domain: 3, register: 'Store' },
        ]);
      }
      return JSON.stringify({ domain: 7, register: 'Attune' });
    };
    const classify = createCategoryClassifier({ infer, model: 'gate-model' });
    const svc = createEnrichmentService(deps(m, classify));
    await svc.enrichCategoriesOnce({ userId: 'u' });
    check('B5 duplicate i first-wins; an all-null item falls back instead of null-overwriting',
      m._store.get('a').subregister === 'Build' && m._store.get('b').subregister === 'Attune' && seen.length === 2,
      `a=${m._store.get('a').subregister} b=${m._store.get('b').subregister} calls=${seen.length}`);
  }

  // ── B6: the revert lever — K=1 disables batching entirely ──────────────────
  {
    process.env.MYCELIUM_L1_BATCH = '1';
    const m = fakeMessages(ROWS3());
    let calls = 0;
    const infer = async () => { calls++; return JSON.stringify({ domain: 1, register: 'Build' }); };
    const classify = createCategoryClassifier({ infer, model: 'gate-model' });
    const svc = createEnrichmentService(deps(m, classify));
    const r = await svc.enrichCategoriesOnce({ userId: 'u' });
    check('B6 MYCELIUM_L1_BATCH=1 → pure per-row (3 calls, batch never attempted)', calls === 3 && r.enriched === 3, `calls=${calls}`);
    process.env.MYCELIUM_L1_BATCH = '8';
  }

  // ── B7: budgets scale with K and cover the prompt ──────────────────────────
  {
    let captured = null;
    const infer = async (prompt, o) => { captured = { prompt, o }; return JSON.stringify([{ i: 1, domain: 1, register: 'Build' }, { i: 2, domain: 7, register: 'Attune' }]); };
    const classify = createCategoryClassifier({ infer, model: 'gate-model' });
    await classify.batch(['x'.repeat(2000), 'y'.repeat(2000)]);
    const expTokens = 48 * 2 + 16;
    const needCtx = Math.ceil((captured.prompt.length / 3.2 + expTokens) / 2048) * 2048;
    check('B7 batch budgets: maxTokens = 48·K+16, num_ctx covers prompt+reply on the 2048 grid',
      captured.o?.maxTokens === expTokens && captured.o?.numCtx === Math.max(2048, needCtx),
      `maxTokens=${captured.o?.maxTokens} numCtx=${captured.o?.numCtx} promptLen=${captured.prompt.length}`);
  }
  // ── B8 (round-1 gate review H7): the SHIPPING drainer wiring honors the batch
  // budgets — B7 proves the classifier EMITS them; this pins the drainer's infer
  // to pass them through with the model-ctx clamp (dropping the second arg would
  // cap every batch at 40 tokens → permanent truncate-and-fallback in production
  // while every behavioural check here stays green). Non-comment lines only.
  {
    const { readFileSync } = await import('node:fs');
    const code = readFileSync('src/enrich/drainer.js', 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    check('B8 drainer infer passes the batch budgets through (o?.maxTokens / o?.numCtx)',
      /maxTokens: o\?\.maxTokens \?\? 40/.test(code) && /o\?\.numCtx \?\? 1024/.test(code));
    check('B8b …clamped to the model\'s REAL context window (lookupModel)',
      /Math\.min\(o\?\.numCtx \?\? 1024, lookupModel\(model\)\?\.contextWindow \|\| 8192\)/.test(code));
  }
} catch (e) {
  check(`fatal: ${e?.message || e}`, false);
}

console.log(ledger.join('\n'));
console.log('='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO' : 'NO-GO'}  EXIT=${allPass ? 0 : 1}`);
process.exit(allPass ? 0 : 1);
