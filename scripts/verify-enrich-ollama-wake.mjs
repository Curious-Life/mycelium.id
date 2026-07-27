// verify:enrich-ollama-wake — the enrich drainer must WAKE the lazy on-box Ollama
// daemon for Context Engine L1 categorization. Without this, a vault whose owner
// never opened local chat leaves EVERY message untagged forever (the live-vault
// dormancy bug found 2026-06-20: 0 / 69,600 messages categorized because Ollama
// was down and nothing on the enrich path called ensureUp()).
//
// Drives startEnrichDrainer with offline stubs: a HEALTHY embed stub (so the cycle
// passes the :8091 gate and reaches the categories stage), an injected classify
// (no real Ollama), an in-memory messages store, and a recording daemon stub.
//   W1 pending categories + daemon → ensureUp() IS called, rows get tagged
//   W2 NO pending categories + daemon → ensureUp() NOT called (idle vault never spawns a model)
//   W3 daemon.ensureUp() resolves {ok:false} → cycle does NOT throw; still fail-soft
//   W4 NO daemon (tests / model-less host) → no throw; categories still run (back-compat)
// PASS/FAIL ledger; VERDICT GO/NO-GO.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import crypto from 'node:crypto';
// The cycle's embed stage (drainOnce) fail-closes without a master key. Seed a throwaway
// one (read from process.env at call time) — the categories stage under test writes only
// plaintext label columns, so no real key material is exercised.
process.env.ENCRYPTION_MASTER_KEY ||= crypto.randomBytes(32).toString('hex');
const { startEnrichDrainer, pauseEnrichProcessing, resumeEnrichProcessing, isEnrichProcessingPaused, resetPullBackoff, nudgeEnrichDrainer } = await import('../src/enrich/drainer.js');

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, timeoutMs = 2000, stepMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await pred()) return true; await sleep(stepMs); }
  return false;
}

// A healthy embed stub → embedHealthy() true → cycle proceeds past the :8091 gate.
// .embed() is required at construction but never called here (no embed backlog).
const healthyEmbed = {
  async health() { return { status: 'ok', loaded: true, dim: 768 }; },
  async embed() { return null; },
};
// Injected classifier → no real Ollama call; returns fixed plaintext labels.
const classify = async () => ({ domain: 'Mind & Growth', register: 'Inquiry', subregister: 'Map' });

// In-memory messages namespace. `pending` rows are the categories backlog.
function makeDb(pendingIds, { approved = 'qwen3.5:4b', embedIds = [], paused } = {}) {
  const cats = new Map(pendingIds.map((id) => [id, { id, content: `row ${id} about minds`, categories_processed: 0 }]));
  // The EMBED backlog — separate from the categories backlog above, and the stage §3.9/R3 is
  // actually about (it is the CPU burner). `embedScans` counts what the drain READ: the honest
  // question is "did the drain RUN", not "is a boolean set" — a flag assert cannot tell a
  // stopped drain from a running one.
  const embeds = new Map(embedIds.map((id) => [id, { id, content: `row ${id}`, nlp_processed: 0 }]));
  let embedScans = 0;
  return {
    db: {
      // The owner's approval — see APPROVED/approve below. null ⇒ nothing approved.
      users: {
        getSettings: async () => ({
          ...(approved ? { taskModels: { categorize: { model: approved }, enrich: { model: approved } } } : {}),
          ...(paused === undefined ? {} : { enrichProcessingPaused: paused }),
        }),
      },
      async rawQuery() { return { rows: [] }; }, // self-heal UPDATE → no-op
      messages: {
        async selectPendingEnrichment(_userId, { limit = 25 } = {}) {
          embedScans++;                                          // the drain RAN (what P1 asserts on)
          return [...embeds.values()].filter((r) => r.nlp_processed === 0).slice(0, limit);
        },
        async updateEnrichment() {},
        async selectPendingNlp() { return []; },
        async updateNlp() {},
        async selectPendingCategories(_userId, { limit = 25 } = {}) {
          return [...cats.values()].filter((r) => r.categories_processed === 0).slice(0, limit);
        },
        async updateCategories(id, _userId, patch) {
          const r = cats.get(id); if (r && patch.categoriesProcessed !== undefined) r.categories_processed = patch.categoriesProcessed;
        },
      },
    },
    taggedCount: () => [...cats.values()].filter((r) => r.categories_processed === 1).length,
    embedScans: () => embedScans,
  };
}

// ⚠️ CONSENT (§3.10c). The approval IS the model setting — there is no separate flag. Every
// fixture below must GRANT it, because an unset taskModels.categorize.model now means "the
// owner has not approved a local model", and the drainer then wakes nothing and pulls
// nothing. Before 2026-07-16 these fixtures passed with NO settings at all, because the
// resolver fell back to qwen3.5:4b — which is precisely the implicit default that made a
// fresh vault download 3.4GB unasked. A fixture with no settings must now tag NOTHING.
const APPROVED = 'qwen3.5:4b';
const approve = (model = APPROVED) => ({ users: { getSettings: async () => ({ taskModels: { categorize: { model }, enrich: { model } } }) } });

function makeDaemon(result = { ok: true, running: true, adopted: true }) {
  const stub = { calls: 0, async ensureUp() { stub.calls++; return result; } };
  return stub;
}

// Ollama model-mgmt stub. Default: the labeling model (llama3.1) is already installed, so
// categorize proceeds. Pass installed:[] to exercise the auto-pull path.
function makeOllama({ installed = ['qwen3.5:4b', 'llama3.1:latest'], pullOk = true } = {}) {
  const stub = {
    listCalls: 0, pullCalls: 0, pulled: [], installed: [...installed],
    async listInstalled() { stub.listCalls++; return [...stub.installed]; },
    async pullModel(name) { stub.pullCalls++; stub.pulled.push(name); if (!pullOk) throw new Error('pull failed'); stub.installed.push(name); return true; },
  };
  return stub;
}

const BIG = 10_000_000; // effectively disable the interval; the boot cycle does the work

// ── W1: pending + daemon → ensureUp called, rows tagged ──
{
  const { db, taggedCount } = makeDb(['a', 'b', 'c']);
  const daemon = makeDaemon();
  let threw = null;
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon, ollama: makeOllama(), log: () => {} });
  const woke = await waitFor(() => daemon.calls > 0).catch((e) => { threw = e; return false; });
  const tagged = await waitFor(() => taggedCount() === 3);
  d.stop();
  rec('W1. pending categories + daemon → ensureUp() called', woke && !threw, `calls=${daemon.calls} threw=${threw?.message || 'no'}`);
  rec('W1b. rows actually categorized after wake', tagged, `tagged=${taggedCount()}/3`);
}

// ── W2: no pending + daemon → ensureUp NOT called (don't spawn a model on an idle vault) ──
{
  const { db } = makeDb([]); // empty backlog
  const daemon = makeDaemon();
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon, ollama: makeOllama(), log: () => {} });
  await sleep(400); // let the boot cycle run fully
  d.stop();
  rec('W2. idle vault (no pending) → ensureUp() NOT called', daemon.calls === 0, `calls=${daemon.calls}`);
}

// ── W3: ensureUp resolves {ok:false} → cycle does not throw, stays fail-soft ──
{
  const { db, taggedCount } = makeDb(['a', 'b']);
  const daemon = makeDaemon({ ok: false, running: false, reason: 'not_installed' });
  let threw = null;
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon, ollama: makeOllama(), log: (m) => { if (/error/i.test(m)) threw = new Error(m); } });
  const woke = await waitFor(() => daemon.calls > 0);
  await sleep(200);
  d.stop();
  rec('W3. ensureUp {ok:false} → wake attempted, cycle did not error', woke && !threw, `calls=${daemon.calls} tagged=${taggedCount()} err=${threw?.message || 'no'}`);
}

// ── W4: no daemon → no throw; L1 stays PENDING ──
// ⚠️ CHANGED 2026-07-16, deliberately. This used to assert "categories still run" with no
// daemon: an injected `classify` made the model/daemon irrelevant, so labeling ran while
// `modelReady` sat at its default `true`. That contradicted the drainer's own `daemon` param
// doc — "Null in contexts with no local model → L1 simply stays pending, fail-soft" — which
// was therefore FALSE for exactly this path. L1 now runs iff an approved model is confirmed
// installed, with no exception for an injected classifier: ONE rule, and the comment is now
// true. No production path is affected — server-rest.js always passes hwOllamaDaemon.
{
  const { db, taggedCount } = makeDb(['a', 'b']);
  let threw = null;
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, log: (m) => { if (/error/i.test(m)) threw = new Error(m); } });
  await sleep(150);
  d.stop();
  rec('W4. no daemon param → no throw, L1 stays pending (as the param contract says)',
    !threw && taggedCount() === 0, `tagged=${taggedCount()}/0 err=${threw?.message || 'no'}`);
}

// ── W5: THE CONSENT GATE — no approved model ⇒ nothing is woken, nothing is pulled ──
// The headline of §3.10: a fresh vault must download NOTHING until the owner approves it.
// Both silent paths are covered — the 3.4GB model pull AND the Ollama RUNTIME install that
// ensureUp() performs (ollama-daemon.js autoInstall), which happens BEFORE the pull is even
// considered. Approving labeling approves both; declining fetches neither.
{
  resumeEnrichProcessing();
  const { db, taggedCount } = makeDb(['a', 'b', 'c'], { approved: null }); // owner has NOT approved
  const daemon = makeDaemon();
  const ollama = makeOllama({ installed: [] });
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon, ollama, log: () => {} });
  await sleep(200);
  d.stop();
  rec('W5. NO approved model ⇒ Ollama is never woken and nothing is pulled (the 3.4GB consent gate)',
    daemon.calls === 0 && ollama.pullCalls === 0 && ollama.listCalls === 0 && taggedCount() === 0,
    `ensureUp=${daemon.calls} pulls=${ollama.pullCalls} lists=${ollama.listCalls} tagged=${taggedCount()}`);
}

// ── P1: user PAUSE → EVERY on-box stage stops — embed drain INCLUDED (§3.9/R3) ──
// ⚠️ THIS GATE'S CONTRACT WAS DELIBERATELY REVERSED. It read "paused → no wake + nothing tagged
// (EMBEDDING UNAFFECTED)" — the pause gated L1/L2 only, so the user whose Mac was melting could
// stop labeling but not the thing melting it. D13 overrides that: the pause is the "stop chewing
// my Mac" control, and embedding is the chew.
// ⚠️ AND THE OLD CLAUSE WAS NEVER ASSERTED — the label said "embedding unaffected" while the
// fixture's selectPendingEnrichment returned [] ("no embed backlog"), so NO gate in this file
// ever exercised the embed drain under a pause. The claim rode in prose for free. It asserts on
// what RAN now (embedScans), not on the flag: a boolean cannot tell a stopped drain from a
// running one.
{
  pauseEnrichProcessing();
  const { db, taggedCount, embedScans } = makeDb(['a', 'b', 'c'], { embedIds: ['e1', 'e2'] });
  const daemon = makeDaemon();
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon, ollama: makeOllama(), log: () => {} });
  await sleep(400); // let the boot cycle run fully
  d.stop();
  rec('P1. paused → embed drain STOPS (0 scans) + no wake + nothing tagged, with work pending',
    isEnrichProcessingPaused() && embedScans() === 0 && daemon.calls === 0 && taggedCount() === 0,
    `paused=${isEnrichProcessingPaused()} embedScans=${embedScans()} calls=${daemon.calls} tagged=${taggedCount()}`);
}

// ── P1b: the CONTROL, not the flag — unpaused, the SAME fixture drains. ──
// Without this, P1 passes on a drainer that never embeds for an unrelated reason (a broken
// fixture, a typo'd predicate): "0 scans" only means "the pause stopped it" if the same setup
// scans when resumed. The pair is the assertion; P1 alone is half of it.
{
  resumeEnrichProcessing();
  const { db, embedScans } = makeDb(['a'], { embedIds: ['e1', 'e2'] });
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon: makeDaemon(), ollama: makeOllama(), log: () => {} });
  const ran = await waitFor(() => embedScans() > 0);
  d.stop();
  rec('P1b. resumed → the SAME fixture DOES drain (proves P1 measures the pause)', ran, `embedScans=${embedScans()}`);
}

// ⚠️ GAP, STATED NOT HIDDEN: THE MID-DRAIN PAUSE IS UNGATED (the `if (isEnrichProcessingPaused())
// break;` inside drainer.js's 200-batch loop). P1/P1b/D3 all pause BEFORE the drainer starts;
// the case the user lives is the opposite order — the drain is already running (that is why the
// fans are loud) and they hit Stop.
// A P1c was written for it and CUT because it was GREEN WHILE MEASURING NOTHING: removing the
// break outright left it passing. Root cause, probed: this fixture's `healthyEmbed.embed()`
// returns null, service.js rejects the vector and the embed block aborts after ONE
// selectPendingEnrichment — so the loop never reaches a second batch and no gate here can tell
// a break from its absence. (An entry-only check is likewise invisible: M1 — reverting the gate
// to `if (embedOk)` — leaves every gate below green, because the break then stops the drain
// instead. Both mechanisms are individually removable with the suite green; only removing BOTH
// is caught. The PROPERTY "paused ⇒ no drain" is gated; the RESPONSIVENESS is not.)
// ⇒ To build it: an embed stub returning a real 768-float vector + an updateEnrichment that
// marks rows nlp_processed, so the loop actually iterates; then pause on scan #1 and assert the
// scan count stops. Do NOT re-add a version that passes without proving the break is measured.

// ── D3 (§7): the pause SURVIVES A RESTART — persisted, not in-memory (D13) ──
// The whole point of D13: "pausing it should honor it and only restart when you click restart."
// A fresh drainer over settings carrying enrichProcessingPaused:true must come up PAUSED —
// nothing drained — WITHOUT anyone calling pauseEnrichProcessing() in this process.
{
  resumeEnrichProcessing();                                  // in-memory says RUNNING…
  const { db, taggedCount, embedScans } = makeDb(['a', 'b'], { embedIds: ['e1', 'e2'], paused: true }); // …settings say PAUSED
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon: makeDaemon(), ollama: makeOllama(), log: () => {} });
  await sleep(400);
  d.stop();
  rec('D3. persisted pause → a RESTARTED drainer comes up paused (0 embed, 0 tagged)',
    isEnrichProcessingPaused() && embedScans() === 0 && taggedCount() === 0,
    `paused=${isEnrichProcessingPaused()} embedScans=${embedScans()} tagged=${taggedCount()}`);
}

// ── D5 (§7): ONLY an explicit resume restarts it — a restart/nudge/cycle must not ──
// The failure this pins: a boot that "helpfully" clears the flag, i.e. the app silently undoing
// a choice the user made because their laptop was overheating. Restore is ADDITIVE — it can set
// the pause, never clear it.
{
  pauseEnrichProcessing();
  const { db, embedScans } = makeDb(['a'], { embedIds: ['e1'], paused: false });  // settings: NOT paused
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon: makeDaemon(), ollama: makeOllama(), log: () => {} });
  await sleep(300);
  d.nudge?.(); await sleep(200);                              // a nudge is not a resume
  const stillPaused = isEnrichProcessingPaused() && embedScans() === 0;
  d.stop();
  resumeEnrichProcessing();                                   // the ONLY thing that may restart it
  rec('D5. boot + nudge do NOT resume a paused vault — only an explicit resume does',
    stillPaused && !isEnrichProcessingPaused(), `stillPausedAfterBootAndNudge=${stillPaused} afterExplicitResume=${isEnrichProcessingPaused()}`);
}

// ── D4b: a TRANSIENT read error must not DISCARD the pause — retry until it lands ──
// ⚠️ THE GATE D4 COULD NOT BE. D4 throws FOREVER, so "never retry" and "retry every cycle" look
// identical to it — and the drainer shipped the first: the restore latch was set BEFORE the
// await, so ONE SQLITE_BUSY at boot (peak contention) discarded a persisted pause for the life
// of the process, silently, while every later read still said paused. D13's silent undo, on the
// stage the pause exists to stop (independent review, 2026-07-16).
// Throw SEVERAL times, then answer paused:true — the drainer must end up PAUSED. Six, not one:
// one throw only pins "retries AT LEAST ONCE", which a bounded retry ("give up after 3") passes.
// D4 below pins the unbounded half.
// ⚠️ THE RESOLVERS ARE INJECTED TO NULL SO `reads` MEANS ONE THING. db.users.getSettings is
// called by restorePauseOnce AND by defaultLabel/EnrichModel every cycle (~2 more reads/cycle),
// so a raw counter measures the RESOLVERS, not the restore. My first draft of this pair counted
// all three and was GREEN under a bounded-retry mutation: "reads still growing" was satisfied by
// the resolvers while the restore was latched shut, and 6 throws only ever reached 2 restore
// attempts. Injecting the resolvers is the seam that makes the count honest.
{
  resumeEnrichProcessing();
  const { db, embedScans } = makeDb(['a'], { embedIds: ['e1', 'e2'], paused: true });
  const realGet = db.users.getSettings;
  let reads = 0;
  db.users.getSettings = async (...args) => {
    reads++;
    if (reads <= 4) throw new Error('SQLITE_BUSY: database is locked');   // a SUSTAINED boot hiccup
    return realGet(...args);
  };
  const d = startEnrichDrainer({
    db, userId: 'u', intervalMs: 60, embed: healthyEmbed, classify, daemon: makeDaemon(), ollama: makeOllama(), log: () => {},
    resolveLabelModel: async () => null, resolveEnrichModel: async () => null,   // ⇒ getSettings === the restore
  });
  const recovered = await waitFor(() => isEnrichProcessingPaused());
  d.stop();
  const scans = embedScans();
  resumeEnrichProcessing();
  rec('D4b. FOUR failed settings reads → the pause is still re-read and HONORED (not discarded)',
    recovered, `paused=${recovered} restoreAttempts=${reads} embedScansBeforeRecovery=${scans}`);
}

// ── D4 (§7): a fail-soft settings READ must resolve to RUNNING, never to paused-forever ──
// Direction matters: drainer.js's original rationale ("never silently leave the vault
// permanently un-enriched") picks it. A transient read error must not freeze the vault with no
// user choice behind it.
// It also pins the UNBOUNDED half of the retry, which is the property D4b cannot reach: D4b's
// fixture eventually SUCCEEDS, so any cap higher than its throw count still passes it. Only a
// forever-throwing read can answer "does the drainer ever GIVE UP?" — and giving up is HIGH-1
// restored (a vault that fails N reads at boot silently discards a persisted pause). So: sample
// the read count twice and require it to still be GROWING after many failures.
// ⚠️ Residual, stated: this defeats any cap already exceeded by the first sample; a cap of, say,
// 1000 would survive it. Pinning "no cap whatsoever" is not finitely testable — this pins "still
// retrying long after any plausible cap", which is what the code owes.
{
  resumeEnrichProcessing();
  const { db, embedScans } = makeDb(['a'], { embedIds: ['e1', 'e2'] });
  let reads = 0;
  db.users.getSettings = async () => { reads++; throw new Error('settings read failed'); };
  const d = startEnrichDrainer({
    db, userId: 'u', intervalMs: 60, embed: healthyEmbed, classify, daemon: makeDaemon(), ollama: makeOllama(), log: () => {},
    resolveLabelModel: async () => null, resolveEnrichModel: async () => null,   // ⇒ getSettings === the restore
  });
  const ran = await waitFor(() => embedScans() > 0);
  await waitFor(() => reads > 8);
  const first = reads;                       // many failures in already
  await sleep(300);
  const grew = reads > first;                // …and it is STILL asking
  d.stop();
  rec('D4. settings read throws FOREVER → drainer runs (fail-soft to RUNNING) AND never gives up retrying',
    ran && !isEnrichProcessingPaused() && first > 8 && grew,
    `embedScans=${embedScans()} paused=${isEnrichProcessingPaused()} readsAtSample1=${first} stillGrowing=${grew} (reads=${reads})`);
}

// ── P3: EVERY stage honors a MID-RUN pause — L2 was the one loop of three without the check ──
// Review round 3 of #204 proved it live: the copy says "pause ANY of it at any time", the embed
// loop checks per batch, L1 checks per iteration ("same rule as the embed loop"), and L2 had NO
// check — pause flipped after batch 2, SEVEN more batches ran. Up to 8x50 rows of continued
// full-CPU inference after the click ≈ ~50 min at the measured 8/min, on the stage the import
// copy calls "days". This gate is the reviewer's proof script, made permanent: a REAL drainer,
// only one stage's work pending, the pause flipped from INSIDE the batch-select (so it lands
// mid-run deterministically), batches counted after it.
async function midRunPause(stage) {
  resumeEnrichProcessing();
  const rows = Array.from({ length: 500 }, (_, i) => ({ id: `m${i}`, content: `note ${i} about plans`, nlp_processed: 0 }));
  const pend = () => rows.filter((r) => r.nlp_processed === 0);
  const calls = { n: 0, afterPause: 0 };
  let pausedFlip = false;
  const onSelect = () => {
    calls.n++;
    if (pausedFlip) calls.afterPause++;
    if (calls.n === 2 && !pausedFlip) { pauseEnrichProcessing(); pausedFlip = true; }
    return pend().slice(0, 5);
  };
  const db = {
    users: { getSettings: async () => ({}) },
    async rawQuery() { return { rows: [] }; },
    messages: {
      async selectPendingEnrichment() { return []; },
      async updateEnrichment() {},
      async embedBacklogCached() { return { embedded: 500, total: 500, pending: 0 }; },
      async selectPendingNlp() { return stage === 'l2' ? onSelect() : []; },
      async updateNlp(id) { const r = rows.find((x) => x.id === id); if (r) r.nlp_processed = 1; },
      async selectPendingCategories() { return stage === 'l1' ? onSelect() : []; },
      async updateCategories(id) { const r = rows.find((x) => x.id === id); if (r) r.nlp_processed = 1; },
    },
  };
  const d = startEnrichDrainer({
    db, userId: 'u', intervalMs: 600000, log: () => {},
    embed: healthyEmbed,
    daemon: { async ensureUp() {} },
    ollama: { async listInstalled() { return ['stub:latest']; } },
    resolveLabelModel: async () => (stage === 'l1' ? 'stub:latest' : null),
    resolveEnrichModel: async () => (stage === 'l2' ? 'stub:latest' : null),
    classify: async () => ({ domain: 'Mind & Growth', register: 'Inquiry' }),
  });
  await waitFor(() => calls.n >= 2, 8000);
  await sleep(1500);                       // let the loop run whatever it still will
  d.stop();
  resumeEnrichProcessing();
  return calls;
}
{
  const l2 = await midRunPause('l2');
  // ⚠️ calls.n >= 2 IS THE CONTROL: a fixture that never loops would show afterPause === 0
  // vacuously (the fixture-green trap — E6d passed with the broken proxy because its fixture
  // never established the state under test). Two batches BEFORE the flip proves the loop runs.
  rec('P3. the L2 loop honors a pause MID-RUN (zero batches after the click)',
    l2.n >= 2 && l2.afterPause === 0, `batches=${l2.n} (>=2 proves the loop runs) afterPause=${l2.afterPause} (must be 0; was 7 before the fix)`);
  const l1 = await midRunPause('l1');
  rec('P3b. the L1 loop still honors it (the sibling that was already correct)',
    l1.n >= 2 && l1.afterPause === 0, `batches=${l1.n} afterPause=${l1.afterPause}`);
}

// ── P2: RESUME → categorization runs again, rows tagged (resumable from where it paused) ──
{
  resumeEnrichProcessing();
  const { db, taggedCount } = makeDb(['a', 'b', 'c']);
  const daemon = makeDaemon();
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon, ollama: makeOllama(), log: () => {} });
  const tagged = await waitFor(() => taggedCount() === 3);
  d.stop();
  rec('P2. resume → wake + rows tagged', !isEnrichProcessingPaused() && daemon.calls > 0 && tagged, `paused=${isEnrichProcessingPaused()} calls=${daemon.calls} tagged=${taggedCount()}/3`);
}

// ── A1: labeling MODEL missing → drainer PULLS it (background), then tags once ready ──
// The production bug: ensureUp() starts the server but a fresh app-private Ollama has NO
// models, so classify fails "model not found" forever. The drainer must pull the model.
{
  resumeEnrichProcessing();
  // Approved, but NOT installed — so the pull must fire for the model the OWNER chose.
  const { db, taggedCount } = makeDb(['a', 'b', 'c'], { approved: 'llama3.1' });
  const daemon = makeDaemon();
  const ollama = makeOllama({ installed: [] }); // model NOT installed
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: 60, embed: healthyEmbed, classify, daemon, ollama, log: () => {} });
  const pulled = await waitFor(() => ollama.pullCalls > 0); // it tried to pull the missing model
  const eventually = await waitFor(() => taggedCount() === 3, 3000); // after pull, a later tick tags
  d.stop();
  rec('A1. labeling model missing → pullModel() called for it', pulled && ollama.pulled.includes('llama3.1'), `pullCalls=${ollama.pullCalls} pulled=${ollama.pulled.join(',')}`);
  rec('A1b. once pulled, categorization resumes + tags', eventually, `tagged=${taggedCount()}/3`);
}

// ── A3: a FAILING pull BACKS OFF and keeps ONE feed row — the storm fix (2026-07-17) ──
// The operator watched six "Failed · just now" rows stack in two minutes: a fast-failing pull
// retried EVERY 15s cycle forever, and each attempt minted a NEW feed row (unique-per-attempt is
// deliberate so failures aren't erased — correct alone, spam without backoff). After the k-th
// consecutive failure the drainer now skips min(2^k, 40) cycles, and retries within an episode
// REUSE the episode's row id (begin() reopens it — one row flapping, never six stacking).
{
  resumeEnrichProcessing();
  const { db, taggedCount } = makeDb(['a', 'b', 'c'], { approved: 'llama3.1' });
  const feed = { ids: new Set(), begins: 0, finishes: [] };
  db.activityFeed = {
    begin: async ({ id }) => { feed.ids.add(id); feed.begins++; },
    heartbeat: async () => {},
    finish: async (id, { status }) => { feed.finishes.push(status); },
  };
  const ollama = makeOllama({ installed: [], pullOk: false });   // every pull FAILS, fast
  // ⚠️ THE PRODUCTION SHAPE: BOTH backlogs pending, ONE model for both tasks (an Understanding
  // approval writes categorize AND enrich) ⇒ ensureLabelModel is consulted TWICE per cycle for
  // the SAME model. The first fixture returned selectPendingNlp: [] and was structurally blind
  // to this — the backoff decremented per CONSULT and ran at HALF the design (measured gaps
  // [2,3,5,9,17] vs the designed [3,5,9,17,33]), and this gate stayed green because its own
  // single-consult shape never doubled the clock (review, 2026-07-17). The decrement is now
  // pinned once-per-cycle; this fixture is what keeps it that way.
  db.messages.selectPendingNlp = async () => [{ id: 'n1', content: 'pending L2 row', nlp_processed: 2 }];
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: 30, embed: healthyEmbed, classify, daemon: makeDaemon(), ollama, log: () => {} });
  // ~50 cycles — THE WINDOW IS PART OF THE ASSERTION, derived not guessed:
  //   designed (once-per-cycle) attempts land at cycles 0,3,8,17,34 → 5 in-window; the 6th at 67
  //     is 17 cycles clear of the boundary.
  //   the HALVED bug (per-consult decrement) lands at 0,2,5,10,19,36 → 6 in-window, 14 cycles
  //     clear the other way.
  //   no backoff at all → ~50.
  // A 2000ms window put the designed 6th attempt (cycle 67) ~10ms from the edge — green or red
  // by timer jitter (review LOW, 2026-07-17). BOTH bounds stay load-bearing: >=2 proves the
  // drainer genuinely retries (the zero-trap), <=5 reds BOTH failure shapes.
  await sleep(1500);
  const health = d.labelerHealth();
  d.stop();
  rec('A3. a failing pull backs off exponentially (2-5 attempts across ~60 cycles, not ~60)',
    ollama.pullCalls >= 2 && ollama.pullCalls <= 5 && taggedCount() === 0,
    `pullCalls=${ollama.pullCalls} (want 2..5; ~60 without backoff) tagged=${taggedCount()}`);
  rec('A3b. ONE feed row per episode — retries reopen it, they do not stack',
    feed.ids.size === 1 && feed.finishes.every((st) => st === 'error'),
    `distinct feed ids=${feed.ids.size} (was one PER ATTEMPT before) begins=${feed.begins} finishes=${feed.finishes.length}`);
  rec('A3c. the fault REASON reaches the health surface (what the Retry tooltip shows)',
    health?.status === 'unavailable' && /pull failed/.test(health?.detail || ''),
    `status=${health?.status} detail=${JSON.stringify(health?.detail)}`);
}

// ── A3d: a NUDGE-FLOOD must not advance the backoff clock — ticks do, nudges don't ──
// The clock (`_cycleN`) sat at cycle() ENTRY first, and nudge() IS cycle(): chat/import saves
// nudge PER SAVE, so an import collapsed the 40-cycle cap from ~10min to ~4-8s between retries —
// during exactly the workload that coincides with a failing pull (measured: 9 attempts in 6s vs
// the designed 5 per 15min). The clock now advances only in the timer callback.
// The flood assertion alone would be vacuous on a drainer that never retries at all — the
// tick-recovery control below proves the clock still runs and the retry still happens.
{
  resumeEnrichProcessing();
  const { db } = makeDb(['a'], { approved: 'llama3.1' });
  db.activityFeed = { begin: async () => {}, heartbeat: async () => {}, finish: async () => {} };
  const ollama = makeOllama({ installed: [], pullOk: false });
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: 500, embed: healthyEmbed, classify, daemon: makeDaemon(), ollama, log: () => {} });
  await waitFor(() => ollama.pullCalls >= 1, 4000);              // attempt 1 fails ⇒ skip = 2 ticks
  for (let i = 0; i < 30; i++) { d.nudge(); await sleep(10); }   // an import's save-flood, ~300ms
  const duringFlood = ollama.pullCalls;
  const recovered = await waitFor(() => ollama.pullCalls >= 2, 3000);   // ~2-3 real ticks later
  d.stop();
  resumeEnrichProcessing();
  rec('A3d. 30 nudges do NOT advance the backoff — only ticks do (and ticks still retry)',
    duringFlood === 1 && recovered,
    `attemptsDuringFlood=${duringFlood} (must stay 1; entry-paced clock retried DURING the flood) · tickRecovery=${recovered}`);
}

// ── A4: the owner's explicit retry CLEARS the backoff — and a now-working pull recovers ──
// resetPullBackoff() is what POST /portal/enrichment/trigger calls (the "Try again" button).
// Deliberately NOT wired to nudge: chat/import saves nudge per save and would re-arm the storm.
{
  resumeEnrichProcessing();
  const { db, taggedCount } = makeDb(['a', 'b', 'c'], { approved: 'llama3.1' });
  const feed = { ids: new Set() };
  db.activityFeed = { begin: async ({ id }) => { feed.ids.add(id); }, heartbeat: async () => {}, finish: async () => {} };
  const ollama = makeOllama({ installed: [], pullOk: false });
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: 30, embed: healthyEmbed, classify, daemon: makeDaemon(), ollama, log: () => {} });
  // Drive the backoff DEEP first (5 failures ⇒ skip 32 cycles ≈ 1s at this cadence). At a
  // shallow depth the skip decays in milliseconds and a NO-OP reset would pass this gate
  // vacuously — the discriminating window below only exists when the backoff is still holding.
  await waitFor(() => ollama.pullCalls >= 5, 8000);
  const attemptsBefore = ollama.pullCalls;
  // The daemon recovers: pulls now succeed…
  ollama.pullModel = async (name) => { ollama.pullCalls++; ollama.pulled.push(name); ollama.installed.push(name); return true; };
  // …but WITHOUT the reset the drainer must keep holding: ~13 cycles pass, no attempt. This is
  // the CONTROL half — it is what a no-op resetPullBackoff() cannot get past.
  await sleep(400);
  const heldDuringBackoff = ollama.pullCalls === attemptsBefore;
  resetPullBackoff();                                            // the module export the route calls
  nudgeEnrichDrainer();
  // The release must be IMMEDIATE — the pull on the very next (nudged) cycle, inside ~6 cycles.
  // Without this window, a NO-OP reset still passes: the remaining ~19 skip cycles decay in
  // under a second at this cadence and the 5s tag-wait absorbs it. 200ms is what makes the
  // reset load-bearing rather than decorative.
  const quick = await waitFor(() => ollama.pullCalls > attemptsBefore, 200);
  const tagged = await waitFor(() => taggedCount() === 3, 5000);
  const health = d.labelerHealth();
  d.stop();
  rec('A4. the backoff HOLDS until the explicit retry — then a recovered pull tags NOW',
    heldDuringBackoff && quick && tagged && health?.status === 'ok',
    `heldDuringBackoff=${heldDuringBackoff} retryImmediate=${quick} attempts ${attemptsBefore}->${ollama.pullCalls} tagged=${taggedCount()}/3 health=${health?.status}`);
  // Ids stay bounded per EPISODE (never one per attempt); a fresh episode after recovery may
  // mint a second id — both shapes are honest, six-per-minute was not.
  rec('A4b. episode ids stay bounded (never one per attempt)',
    feed.ids.size <= 2, `distinct ids=${feed.ids.size} across ${ollama.pullCalls} attempts`);
}

// ── A2: Ollama unreachable (listInstalled throws) → no crash, nothing tagged, retries ──
{
  resumeEnrichProcessing();
  const { db, taggedCount } = makeDb(['a', 'b'], { approved: 'llama3.1' });
  const daemon = makeDaemon();
  let threw = null;
  const ollama = { listCalls: 0, async listInstalled() { this.listCalls++; throw new Error('ECONNREFUSED'); }, async pullModel() { throw new Error('down'); } };
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon, ollama, log: (m) => { if (/drain cycle error/i.test(m)) threw = new Error(m); } });
  await waitFor(() => ollama.listCalls > 0);
  await sleep(150);
  d.stop();
  rec('A2. Ollama unreachable → no crash, nothing tagged (fail-soft, retries next tick)', ollama.listCalls > 0 && !threw && taggedCount() === 0, `listCalls=${ollama.listCalls} tagged=${taggedCount()} err=${threw?.message || 'no'}`);
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — enrich drainer wakes the lazy Ollama daemon + AUTO-PULLS the missing labeling model on pending L1 work, idle-safe + fail-soft + user pause/resume' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
