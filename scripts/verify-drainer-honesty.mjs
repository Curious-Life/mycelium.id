// verify:drainer-honesty — DATA-READINESS-DESIGN-2026-07-15 §3.6 + §7 (D1, D2).
//
// D1  the embed health gate skips EMBEDDING, not the CYCLE — labeling still runs when the
//     embed sidecar is down. Two independent pipelines shared one gate: when :8091 died,
//     L1 categorization stopped too, for reasons that had nothing to do with it. Labeling
//     needs OLLAMA, not the embed service, and selectPendingCategories keys on
//     categories_processed alone — there was never a real ordering dependency.
// D2  a skip is never silent — the drainer says so (it sat dead for a MONTH behind a
//     swallowed timeout while the UI rendered "Embedding messages", which is just
//     `pending > 0`).
//
// Doubles mirror scripts/verify-enrich-ollama-wake.mjs so both gates exercise the same
// injected surface (embed / classify / daemon / ollama).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// The enrichment service is fail-closed on the master key ("master key unavailable — vault
// locked, refusing to..."), so a cycle that reaches the EMBED loop throws without one and
// never gets to labeling. Mirrors verify-enrich-ollama-wake.mjs. Must be set BEFORE the
// drainer imports crypto-local (read at call time, but set it first regardless).
process.env.ENCRYPTION_MASTER_KEY ||= crypto.randomBytes(32).toString('hex');

const { startEnrichDrainer, getEnrichDrainerStatus } = await import('../src/enrich/drainer.js');

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
async function t(n, fn) { try { await fn(); rec(n, true); } catch (e) { rec(n, false, e?.message || String(e)); } }

const BIG = 10_000_000;                       // disable the interval; the BOOT cycle does the work
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The boot cycle is ASYNC — startEnrichDrainer kicks it and returns. Poll for the effect,
// exactly as verify-enrich-ollama-wake.mjs does; `await d.nudge()` does not await the cycle.
async function waitFor(pred, timeoutMs = 3000, stepMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await pred()) return true; await sleep(stepMs); }
  return false;
}
const classify = async () => ({ domain: 'Mind & Growth', register: 'Inquiry', subregister: 'Map' });
// A REALLY dead :8091 THROWS (connection refused) → embedHealth() catches → 'unreachable'.
// ⚠️ An earlier version of this double returned `{ status:'down', loaded:false }`, which hits
// `if (h.loaded === false || h.status === 'loading') return 'loading'` FIRST (drainer.js:159)
// — so it exercised LOADING, the one state portal-activity.js treats as NOT a fault
// ("Embedder starting", status: running). The gate would have stayed green while a
// month-dead sidecar rendered "starting" forever — the exact bug class this branch kills
// (independent review, 2026-07-15).
const deadEmbed = { async health() { throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8091'), { code: 'ECONNREFUSED' }); },
                    async embed() { throw new Error('embed service is down'); } };
// The DISTINCT loading state — a model still warming up is not a fault, and must not be
// reported as one. Kept separate so the two can never be conflated again.
const loadingEmbed = { async health() { return { status: 'loading', loaded: false }; }, async embed() { return null; } };
const okEmbed   = { async health() { return { status: 'ok', loaded: true, dim: 768 }; }, async embed() { return null; } };

// ⚠️ CONSENT (§3.10c, increment M): labeling requires an APPROVED on-box model, and the
// approval IS settings.taskModels.categorize.model. These fixtures grant it so that what
// they actually test — "a dead embed sidecar must not silence labeling" — is what fails if
// it regresses. Without it they would go red for an unrelated reason (no consent), which
// would quietly turn D1 into a test of the consent gate instead of the embed gate.
const APPROVED = 'qwen3.5:4b';

function makeDb(pendingIds, { approved = APPROVED } = {}) {
  const cats = new Map(pendingIds.map((id) => [id, { id, content: `row ${id} about minds`, categories_processed: 0 }]));
  return {
    db: {
      users: { getSettings: async () => (approved ? { taskModels: { categorize: { model: approved }, enrich: { model: approved } } } : {}) },
      async rawQuery() { return { rows: [] }; },
      messages: {
        async selectPendingEnrichment() { return []; },
        async updateEnrichment() {},
        async selectPendingNlp() { return []; },
        async updateNlp() {},
        async selectPendingCategories(_u, { limit = 25 } = {}) {
          return [...cats.values()].filter((r) => r.categories_processed === 0).slice(0, limit);
        },
        async updateCategories(id, _u, patch) {
          const r = cats.get(id); if (r && patch.categoriesProcessed !== undefined) r.categories_processed = patch.categoriesProcessed;
        },
      },
    },
    taggedCount: () => [...cats.values()].filter((r) => r.categories_processed === 1).length,
  };
}
const makeDaemon = () => ({ calls: 0, async ensureUp() { this.calls++; return { ok: true, running: true }; } });
const makeOllama = () => ({
  installed: ['qwen3.5:4b'],
  async listInstalled() { return [...this.installed]; },
  async pullModel(n) { this.installed.push(n); return true; },
});

// ── D1) THE FIX: a dead embed service must NOT silence labeling ───────────────
await t('D1. embed service DOWN ⇒ labeling STILL RUNS (the gate skips embedding, not the cycle)', async () => {
  const { db, taggedCount } = makeDb(['a', 'b', 'c']);
  const d = startEnrichDrainer({
    db, userId: 'u', intervalMs: BIG, embed: deadEmbed, classify,
    daemon: makeDaemon(), ollama: makeOllama(), log: () => {},
  });
  const tagged = await waitFor(() => taggedCount() === 3);
  d.stop?.();
  assert.ok(tagged,
    'labeling needs OLLAMA, not :8091 — a dead embed sidecar must not stop categorization. '
    + 'The old `if (!(await embedHealthy())) return;` returned from the WHOLE cycle.');
});

await t('D1b. embed service UP ⇒ labeling also runs (no regression on the happy path)', async () => {
  const { db, taggedCount } = makeDb(['a', 'b']);
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: okEmbed, classify, daemon: makeDaemon(), ollama: makeOllama(), log: () => {} });
  const tagged = await waitFor(() => taggedCount() === 2);
  d.stop?.();
  assert.ok(tagged, 'the healthy path must be unchanged');
});

// ── D2) a skip is never silent ────────────────────────────────────────────────
await t('D2. a dead embed service is LOGGED, and the log says labeling is unaffected', async () => {
  const lines = [];
  const { db } = makeDb(['a']);
  const d = startEnrichDrainer({
    db, userId: 'u', intervalMs: BIG, embed: deadEmbed, classify,
    daemon: makeDaemon(), ollama: makeOllama(), log: (m) => lines.push(String(m)),
  });
  await waitFor(() => lines.some((l) => /SKIPPED/i.test(l)));
  d.stop?.();
  const skip = lines.find((l) => /SKIPPED/i.test(l));
  assert.ok(skip, 'a skipped cycle MUST be logged — silence here hid a dead drainer for a month');
  assert.ok(/embed service not healthy/i.test(skip), 'and it must name the reason');
  assert.ok(/labeling still runs/i.test(skip),
    'the log must state that labeling is unaffected — otherwise the next reader re-couples them');
});

// ── D3) the exported status is the honest surface (§3.5) ──────────────────────
await t('D3. getEnrichDrainerStatus() reports the embed health — it is not closure-local', async () => {
  const { db } = makeDb(['a']);
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: deadEmbed, classify, daemon: makeDaemon(), ollama: makeOllama(), log: () => {} });
  // ⚠️ NOT `health !== undefined` — that is satisfied by the INITIAL `_health = 'unknown'`
  // (drainer.js:119), so it observes nothing and passes on a drainer that never ran a cycle
  // (independent review, 2026-07-15). Wait for the REAL post-cycle verdict.
  await waitFor(() => getEnrichDrainerStatus()?.health === 'unreachable');
  const st = getEnrichDrainerStatus();
  d.stop?.();
  assert.ok(st, 'status must be exported — the readiness model + the popover read it');
  assert.equal(st.health, 'unreachable',
    'a dead :8091 must surface as unreachable — not swallowed, and not softened to "loading"');
  assert.equal(st.stalled, true, 'and it must read as STALLED — a fault, not a warm-up');
});

// ── D4) loading ≠ dead — the distinction portal-activity depends on ──────────
await t('D4. a LOADING embedder is not a fault (and is not conflated with a dead one)', async () => {
  const { db, taggedCount } = makeDb(['a']);
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: loadingEmbed, classify, daemon: makeDaemon(), ollama: makeOllama(), log: () => {} });
  await waitFor(() => getEnrichDrainerStatus()?.health === 'loading');
  const st = getEnrichDrainerStatus();
  const tagged = await waitFor(() => taggedCount() === 1);
  d.stop?.();
  assert.equal(st.health, 'loading', 'a warming model is loading, not unreachable');
  assert.equal(st.stalled, false, 'loading must NOT read as a fault — that is what "Embedder starting" means');
  assert.ok(tagged, 'and labeling still runs while the embedder warms up');
});

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — the embed gate skips embedding, not labeling; skips are loud; status is exported' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
