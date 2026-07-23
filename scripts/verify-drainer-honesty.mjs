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

const { startEnrichDrainer, getEnrichDrainerStatus, deferCategorizeForEmbed } = await import('../src/enrich/drainer.js');

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
// A healthy service that REALLY returns a 768-float vector, so rows actually get marked and the
// drain loop's counters actually move. ⚠️ `okEmbed` above returns null: service.js treats that as a
// TRANSIENT failure and leaves the row pending, so a gate built on it can only ever observe a
// STALLED drain (which is precisely what D6 wants, and precisely what D5/D7 must not have).
const realEmbed = { async health() { return { status: 'ok', loaded: true, dim: 768 }; },
                    async embed() { return new Array(768).fill(0.01); } };
// Healthy, and embeds everything EXCEPT the POISON rows (see makeDb's `badFrom`) — a real head-of-
// queue wedge that only appears AFTER the pass has already moved rows.
const poisonEmbed = { async health() { return { status: 'ok', loaded: true, dim: 768 }; },
                      async embed(text) { return String(text).startsWith('POISON') ? null : new Array(768).fill(0.01); } };

// ⚠️ CONSENT (§3.10c, increment M): labeling requires an APPROVED on-box model, and the
// approval IS settings.taskModels.categorize.model. These fixtures grant it so that what
// they actually test — "a dead embed sidecar must not silence labeling" — is what fails if
// it regresses. Without it they would go red for an unrelated reason (no consent), which
// would quietly turn D1 into a test of the consent gate instead of the embed gate.
const APPROVED = 'qwen3.5:4b';

// `embedCount` seeds a REAL embed backlog alongside the label backlog (D5-D7, QA6). Rows drain
// exactly as production does: updateEnrichment flips nlp_processed, so selectPendingEnrichment
// shrinks and the drain loop's own `scanned === 0` / no-progress breaks fire for real reasons.
// `badFrom` marks every embed row from that index on as POISON — `poisonEmbed` below returns a null
// vector for them, which service.js treats as a TRANSIENT failure and leaves PENDING. That is the
// partial-progress-then-stall shape D6b needs: rows really move, and then the drain really wedges.
function makeDb(pendingIds, { approved = APPROVED, embedCount = 0, badFrom = Infinity } = {}) {
  const cats = new Map(pendingIds.map((id) => [id, { id, content: `row ${id} about minds`, categories_processed: 0 }]));
  const embRows = new Map(Array.from({ length: embedCount }, (_, i) => [`e${i}`, {
    id: `e${i}`, content: i >= badFrom ? `POISON row e${i}` : `row e${i} about minds`, nlp_processed: 0,
  }]));
  const embPending = () => [...embRows.values()].filter((r) => r.nlp_processed === 0);
  return {
    db: {
      users: { getSettings: async () => (approved ? { taskModels: { categorize: { model: approved }, enrich: { model: approved } } } : {}) },
      // The production self-heal, mirrored (see verify-embed-eta.mjs's note): a no-op stub would let
      // failed rows leave the backlog, which is the OPPOSITE of the resurrection the stuck case is about.
      async rawQuery() {
        for (const r of embRows.values()) if (r.nlp_processed === -1) r.nlp_processed = 0;
        return { rows: [] };
      },
      messages: {
        async selectPendingEnrichment(_u, { limit = 25 } = {}) { return embPending().slice(0, limit); },
        async updateEnrichment(id, _u, patch) {
          const r = embRows.get(id);
          if (r && patch.nlpProcessed !== undefined) r.nlp_processed = patch.nlpProcessed;
          else if (r) r.nlp_processed = 2;
        },
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
    embedPendingCount: () => embPending().length,
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

// ── D5-D7) QA6: ONE STAGE AT A TIME — embed drains BEFORE categorize starts ───
// THE BUG (operator, after a 24GB machine died mid-import): "the embedding model still runs at the
// same time as categorization". The three stages ARE sequential within a cycle — but the embed loop
// is CAPPED at 200 passes × 50 rows, so on a large import it exhausts the cap and FALLS THROUGH to
// the categorize block with the backlog still full. Every 15s tick then alternates a resident
// embedding model and a resident 4B labeling model against the same box.
//
// The gate is a TRIPLE, because the fix's whole risk is the other direction — a deadlock:
//   D5  backlog remains AND embed is progressing  ⇒ categorize does NOT run (the fix)
//   D6  embed CANNOT progress (stuck head of queue) ⇒ categorize RUNS ANYWAY (the starvation guard)
//   D7  backlog drains inside the cycle            ⇒ categorize runs, unchanged (the control)
// D6 + D7 are what make D5 falsifiable rather than a description of "categorize is off".

// D5u — THE DECISION, IN ISOLATION. The integration cases below prove the WIRING; these prove each
// CLAUSE, because a 10,000-row drive cannot cheaply separate them (the stall break masks the
// progress clause — [[two-guards-can-mask-each-other]]). Every line here reds under a different
// mutation to deferCategorizeForEmbed.
await t('D5u. deferCategorizeForEmbed: each clause is load-bearing (defer IFF progressing AND backlog remains)', async () => {
  const base = { embedOk: true, embedPaused: false, embedThrew: false, embedMoved: 500, embedDrained: false, embedStalledOut: false };
  assert.equal(deferCategorizeForEmbed(base), true, 'progressing + backlog remains ⇒ DEFER');
  // progressing half — every one of these is a NOT-progressing state ⇒ must NOT defer (starvation guard)
  assert.equal(deferCategorizeForEmbed({ ...base, embedMoved: 0 }), false, 'moved nothing ⇒ not progressing ⇒ run categorize');
  assert.equal(deferCategorizeForEmbed({ ...base, embedThrew: true }), false, 'threw ⇒ not progressing ⇒ run categorize');
  assert.equal(deferCategorizeForEmbed({ ...base, embedOk: false }), false, 'service unhealthy ⇒ run categorize');
  assert.equal(deferCategorizeForEmbed({ ...base, embedPaused: true }), false, 'embed paused (owner choice) ⇒ run categorize');
  // backlog half — a finished drain must release, by either terminator
  assert.equal(deferCategorizeForEmbed({ ...base, embedDrained: true }), false, 'queue drained ⇒ run categorize');
  assert.equal(deferCategorizeForEmbed({ ...base, embedStalledOut: true }), false, 'no-progress break ⇒ cannot progress ⇒ run categorize');
});

await t('D5. QA6: embed backlog remains AND is progressing ⇒ categorize + enrich do NOT run this cycle', async () => {
  // 10,050 rows against a 200 × 50 = 10,000 cap ⇒ the loop exhausts its budget with 50 still
  // pending, embedding 10,000 of them. That is the EXACT production shape (a big import), reached
  // by the real cap in the real source — not by a stubbed flag.
  const { db, taggedCount, embedPendingCount } = makeDb(['a', 'b', 'c'], { embedCount: 10_050 });
  const d = startEnrichDrainer({
    db, userId: 'u', intervalMs: BIG, embed: realEmbed, classify,
    daemon: makeDaemon(), ollama: makeOllama(), log: () => {},
  });
  // Wait for the boot cycle to FINISH (running back to false), not merely to embed — the categorize
  // block runs at the END of the cycle, so sampling early would "prove" the deferral by looking
  // before the code that would have violated it had even executed.
  const done = await waitFor(() => d.status().embeddedTotal >= 10_000 && d.status().running === false, 120_000);
  const st = d.status();
  const tagged = taggedCount();
  const stillPending = embedPendingCount();
  d.stop?.();
  assert.ok(done, `the boot cycle must complete (embeddedTotal=${st.embeddedTotal} running=${st.running})`);
  assert.equal(stillPending, 50, 'fixture control: the cap must leave rows pending — otherwise this scenario is not the bug');
  assert.equal(tagged, 0,
    `categorize must NOT run while embedding is still draining a backlog it is making progress on — ${tagged} row(s) were tagged. `
    + 'MUTATION: drop `&& !waitOnEmbed` from the categorize gate in drainer.js ⇒ this REDS.');
  assert.equal(st.categorizeWaitingOnEmbed, true,
    'and the deferral must be REPORTED (readiness renders categorize blocked/waiting_embed from this) — a stage that stops '
    + 'for a reason the user did not choose must never be silent');
});

await t('D6. QA6 STARVATION GUARD: an embed backlog that CANNOT progress must NOT starve categorize', async () => {
  // The head of the queue never embeds (a null vector = a transient failure; service.js leaves the
  // row PENDING by design and the self-heal resurrects it). So the backlog REMAINS, forever — the
  // exact state a backlog-only gate would deadlock on. `okEmbed` reports healthy, so nothing else
  // releases the block: only the "is it progressing?" half can.
  const { db, taggedCount, embedPendingCount } = makeDb(['a', 'b', 'c'], { embedCount: 200 });
  const d = startEnrichDrainer({
    db, userId: 'u', intervalMs: BIG, embed: okEmbed, classify,
    daemon: makeDaemon(), ollama: makeOllama(), log: () => {},
  });
  const tagged = await waitFor(() => taggedCount() === 3, 15_000);
  const st = d.status();
  const stillPending = embedPendingCount();
  d.stop?.();
  assert.ok(stillPending > 0, 'fixture control: the embed backlog must still be full — otherwise there is nothing to starve behind');
  assert.ok(tagged,
    'a stuck embed stage must release the other stages, or ONE un-embeddable row deadlocks L1+L2 for the life of the process. '
    + 'MUTATION: delete `embedStalledOut = true` at the no-progress break ⇒ this REDS.');
  assert.equal(st.categorizeWaitingOnEmbed, false, 'and the drainer must not claim to be waiting on a stage that is not moving');
});

await t('D6b. QA6 STARVATION GUARD: embed that PROGRESSES and THEN wedges must NOT starve categorize', async () => {
  // ⚠️ THE CASE D6 CANNOT SEE, and the reason the no-progress break has to feed the decision. In D6
  // nothing moves at all, so the `embedMoved > 0` clause alone releases categorize — delete the
  // stall signal entirely and D6 stays green. HERE the first batch embeds 50 rows (so embed IS
  // progressing by that measure) and the next batch wedges on a poison head of queue: without the
  // stall signal the cycle reads "moved rows, backlog remains" and defers, so categorize is held
  // behind a drain that has already given up for this tick.
  const { db, taggedCount, embedPendingCount } = makeDb(['a', 'b', 'c'], { embedCount: 120, badFrom: 50 });
  const d = startEnrichDrainer({
    db, userId: 'u', intervalMs: BIG, embed: poisonEmbed, classify,
    daemon: makeDaemon(), ollama: makeOllama(), log: () => {},
  });
  const tagged = await waitFor(() => taggedCount() === 3, 15_000);
  const st = d.status();
  const stillPending = embedPendingCount();
  d.stop?.();
  assert.ok(st.embeddedTotal >= 50, `fixture control: rows really embedded before the wedge (embeddedTotal=${st.embeddedTotal})`);
  assert.ok(stillPending > 0, 'fixture control: and the backlog really remains');
  assert.ok(tagged,
    'a drain that moved rows and THEN stopped moving is not "still draining" — it is done for this tick, so the other stages must run. '
    + 'MUTATION: delete `embedStalledOut = true` at the no-progress break ⇒ this REDS.');
  assert.equal(st.categorizeWaitingOnEmbed, false, 'and the drainer must not report a wait it is not actually serving');
});

await t('D6c. QA6 STARVATION GUARD: a throw AFTER embed made progress must NOT starve categorize', async () => {
  // ⚠️ THE TEETH FOR THE embedThrew CLAUSE — and the reason this case had to be rebuilt. The OLD
  // fixture threw on the FIRST selectPendingEnrichment, so `embedMoved` stayed 0 and the
  // `embedMoved > 0` clause ALONE made the drain "not progressing" — deleting `embedThrew = true`
  // changed the verdict for NOTHING, yet the gate's own note claimed that mutation would RED it. A
  // comment laundering an ungated clause ([[gate-comment-can-launder-a-bug]]); the SHIPPED CODE was
  // correct, the GATE was blind. The real case is the one drainer.js:1310 names: a throw AFTER
  // partial writes. Here the FIRST batch embeds a full batch of rows (embedMoved > 0, backlog
  // remains, nothing stalled), and the NEXT select throws — so `embedThrew` is now the ONLY thing
  // that can make the drain "not progressing". Delete `embedThrew = true` (drainer.js:1325) and
  // `progressing` stays true ⇒ categorize is deferred behind a drain that has already given up for
  // this tick ⇒ taggedCount never moves ⇒ this REDS. (Verified: mutating that line reds this case.)
  const okThenThrow = { async health() { return { status: 'ok', loaded: true, dim: 768 }; },
                        async embed() { return new Array(768).fill(0.01); } };   // valid vector ⇒ rows really embed
  const { db, taggedCount, embedPendingCount } = makeDb(['a', 'b'], { embedCount: 60 });
  const realSelect = db.messages.selectPendingEnrichment;
  let selects = 0;
  db.messages.selectPendingEnrichment = async (...a) => {
    // Batch 1 succeeds (a full batch really embeds ⇒ embedMoved > 0, ~50 of 60 drained, 10 remain);
    // every batch after it throws AROUND the pass — the SQLITE_BUSY shape, but AFTER progress.
    if (++selects > 1) throw new Error('SQLITE_BUSY');
    return realSelect(...a);
  };
  const d = startEnrichDrainer({
    db, userId: 'u', intervalMs: BIG, embed: okThenThrow, classify,
    daemon: makeDaemon(), ollama: makeOllama(), log: () => {},
  });
  const tagged = await waitFor(() => taggedCount() === 2, 15_000);
  const st = d.status();
  const stillPending = embedPendingCount();
  d.stop?.();
  assert.ok(st.embeddedTotal >= 1, `fixture control: the first batch really embedded before the throw (embeddedTotal=${st.embeddedTotal}) — else embedMoved is 0 and this reverts to the toothless case`);
  assert.ok(stillPending > 0, `fixture control: and the backlog still remains (${stillPending}/60) — the throw stopped the drain mid-way, so a deferral WOULD have work to defer`);
  assert.ok(tagged, 'a drain that made progress and THEN threw is done for this tick — categorize must still run. '
    + 'MUTATION: delete `embedThrew = true` in the embed catch (drainer.js:1325) ⇒ progressing stays true ⇒ this REDS.');
  assert.equal(st.categorizeWaitingOnEmbed, false, 'a throw is not "waiting on embedding" — even after partial progress');
});

await t('D7. QA6 CONTROL: a backlog that DRAINS inside the cycle ⇒ categorize runs, exactly as before', async () => {
  // The everyday vault. If this reds, the fix did not serialize the stages — it disabled one.
  const { db, taggedCount, embedPendingCount } = makeDb(['a', 'b', 'c'], { embedCount: 120 });
  const d = startEnrichDrainer({
    db, userId: 'u', intervalMs: BIG, embed: realEmbed, classify,
    daemon: makeDaemon(), ollama: makeOllama(), log: () => {},
  });
  const tagged = await waitFor(() => taggedCount() === 3, 15_000);
  const st = d.status();
  d.stop?.();
  assert.equal(embedPendingCount(), 0, 'fixture control: the embed backlog really drained inside one cycle');
  assert.ok(tagged, 'a caught-up embed stage must hand the box straight to categorize — the deferral is not an off switch');
  assert.equal(st.categorizeWaitingOnEmbed, false, 'nothing left to wait for');
});

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — the embed gate skips embedding, not labeling; skips are loud; status is exported' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
