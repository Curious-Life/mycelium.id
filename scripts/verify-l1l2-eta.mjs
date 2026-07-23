// verify:l1l2-eta — the 8-day gap (R2-review): L1 (categorize) and L2 (enrich) get REAL ETAs.
//
// Measured on an M1 (floor hardware, shipped params, real endpoints): embed 313/min (~4h for 76k,
// had an ETA since R1) · L1 41/min (~31h) · L2 8/min (~153h). The two on-box-model stages are
// ~98% of the ~188h a user on the recommended model waits — and until this unit L1's ETA was
// hardcoded null and L2 had NO feed row at all. This gate pins the arithmetic, the honest nulls,
// the WIRING through the real projections, the "a skip is progress" rule for L1, the L2 stall
// signal, and the COST of the new backlog counter — each falsified by mutating the source.
//
// This is the SIBLING of verify-embed-eta.mjs and reuses its disciplines verbatim:
//   • real vectors / real rows (a stub that moves nothing lets a gate only ever observe zero);
//   • assert the EXACT seconds, never "a number appeared" (a plausible-wrong number is the bug);
//   • a stall is an OUTCOME (barren passes), never a clock — no time windows anywhere;
//   • sample STATE TRANSITIONS, not a wall-clock (blanks are instant — a ms-sampler walks past);
//   • give stubs a REAL delay (an instant classify banks activeMs 0 ⇒ one hiccup from Infinity);
//   • WRITE A CONTROL (a fixture that never loops shows zero VACUOUSLY — prove n>=2 passes ran).
//
// ⚠️ PER-PASS, NOT PER-CYCLE, AND WHY PER-PASS SUFFICES: the embed loop is ≤200 batches × 50 =
// 10,000 rows/cycle (~4.2h), so it needed mid-cycle sampling (E8). The L1/L2 loops cap at 8 passes
// (drainer.js), and each pass banks its own active time + count the instant the service call
// returns — so a single ~50-min L2 cycle (8×50 at 8/min) still advances its rate every ≤50 rows.
// Per-pass is the fix (per-cycle would freeze a 50-min run) AND is sufficient (a pass is a bounded
// ≤50-row unit) — so this gate does not need embed's long-cycle E8, and G_WIRE proves the rate is
// live after ONE cycle's worth of passes.
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>.

import crypto from 'node:crypto';
import Database from 'better-sqlite3';
process.env.ENCRYPTION_MASTER_KEY ||= crypto.randomBytes(32).toString('hex');

const { categorizeEta, enrichEta, categorizeProjection, enrichProjection, portalActivityRouter } =
  await import('../src/portal-activity.js');
const { startEnrichDrainer, resumeEnrichProcessing, pauseEnrichProcessing } =
  await import('../src/enrich/drainer.js');
const { createMessagesNamespace } = await import('../src/db/messages.js');

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(20); }
  return false;
};

const MODEL = 'qwen3.5:4b';

// ── The in-memory vault. L1 rows carry categories_processed (0→1); L2 rows carry nlp_processed
// (2→1 enriched, 2→-1 poison). `blankCatIds` are whitespace-only: they pass the `content != ''`
// filter so the drain SELECTS them, and service.js trims + marks categories_processed = 1
// (TERMINAL) without calling the classifier — the L1 analog of the embed loop's skip. A gate that
// never drives one cannot see the "a skip is progress" hole (verify-embed-eta's E6e lesson).
function makeVault({ l1Ids = [], l2Ids = [], blankCatIds = [], embedInfinite = false } = {}) {
  const rows = new Map([
    ...l1Ids.map((id) => [id, { id, content: `row ${id} about minds`, categories_processed: 0, nlp_processed: 3 }]),
    ...blankCatIds.map((id) => [id, { id, content: '   \n  ', categories_processed: 0, nlp_processed: 3 }]),
    ...l2Ids.map((id) => [id, { id, content: `row ${id} about minds`, categories_processed: 2, nlp_processed: 2 }]),
  ]);
  // ⚠️ MIRROR THE REAL SQL PREDICATE EXACTLY: `content IS NOT NULL AND content != ''` — whitespace
  // PASSES it (a blank row IS selected, then service.js trims + skips it). A `.trim()` filter here
  // would EXCLUDE the blanks the real drain selects, so the L1-skip blank run would never execute
  // and its gate would pass VACUOUSLY (caught: an "else if scanned>0" mutant stayed green because
  // no blank was ever drained). Non-empty STRING, not non-blank.
  const pendCat = () => [...rows.values()].filter((r) => r.categories_processed === 0 && r.content != null && r.content !== '');
  const pendNlp = () => [...rows.values()].filter((r) => r.nlp_processed === 2 && r.content != null && r.content !== '');
  // ERRS fixture: when locked, BOTH write paths throw — the locked-vault state service.js
  // documents ("master key unavailable — vault locked, refusing to write"). This reproduces the
  // MED's exact production shape: L1's updateCategories throw propagates out of
  // enrichCategoriesOnce (it sits OUTSIDE the row's try — only fn(content) is guarded), and L2's
  // updateNlp throws in the success path AND in the catch's −1 write, so it too escapes the
  // service entirely. Neither moves `failed`, so neither moves barren — only the block-level
  // errs counters can see it.
  let writesLocked = false;
  let embedCounter = 0;   // unique-id source for the inexhaustible embed backlog (embedInfinite)
  const lockedThrow = () => { throw new Error('enrichment: master key unavailable — vault locked, refusing to write'); };
  const db = {
    users: { getSettings: async () => ({ taskModels: { categorize: { model: MODEL }, enrich: { model: MODEL } } }) },
    async rawQuery() { return { rows: [] }; },   // self-heal no-op (the embed loop's, not relevant to L1/L2 here)
    activityFeed: { async reap() {}, async active() { return []; }, async recent() { return []; } },
    messages: {
      async selectPendingCategories(_u, { limit = 25 } = {}) { return pendCat().slice(0, limit).map((r) => ({ id: r.id, content: r.content, scope: null })); },
      async updateCategories(id) { if (writesLocked) lockedThrow(); const r = rows.get(id); if (r) r.categories_processed = 1; },
      async selectPendingNlp(_u, { limit = 50 } = {}) { return pendNlp().slice(0, limit).map((r) => ({ id: r.id, content: r.content, scope: null })); },
      async updateNlp(id, _u, patch) { if (writesLocked) lockedThrow(); const r = rows.get(id); if (r) r.nlp_processed = patch.nlpProcessed ?? 1; },
      // embed is out of scope for the ETA math (default: empty ⇒ the embed loop drains instantly and
      // never defers). `embedInfinite` seeds an INEXHAUSTIBLE backlog — 50 fresh, unique rows every
      // call — so the embed loop hits its 200-batch/cycle cap while STILL progressing (embedded > 0,
      // scanned never 0, nothing stalls). That is the exact precondition for deferCategorizeForEmbed
      // to defer L1+L2 this cycle (drainer.js waitOnEmbed) — the state the DEFER-wire block needs.
      async selectPendingEnrichment(_u, { limit = 50 } = {}) {
        if (!embedInfinite) return [];
        return Array.from({ length: limit }, () => ({ id: `emb${embedCounter++}`, content: 'row about minds', scope: null, nlp_error: null }));
      },
      async updateEnrichment() {},   // no-op: the drain's job in the DEFER fixture is only to keep MOVING
      async embedBacklogCached() { return embedInfinite ? { embedded: 0, total: rows.size + 100000, pending: 100000 } : { embedded: 0, total: rows.size, pending: 0 }; },
      async categoriesBacklogCached() { const total = rows.size; const p = pendCat().length; return { tagged: total - p, total, pending: p }; },
      async nlpBacklogCached() { const total = rows.size; const done = [...rows.values()].filter((r) => r.nlp_processed === 1).length; return { done, total, pending: pendNlp().length }; },
    },
  };
  return { db, pendCat, pendNlp, rows, setWriteLock: (v) => { writesLocked = Boolean(v); } };
}
const daemon = () => ({ calls: 0, async ensureUp() { this.calls++; return { ok: true, running: true }; } });
const ollama = () => ({ async listInstalled() { return [MODEL]; }, async pullModel() { return true; } });
// Delayed so ACTIVE time is measurable (see the header). classifyOk tags; enrichOk enriches.
const classifyOk = async () => { await sleep(2); return { domain: 'Mind & Growth', register: 'Inquiry', subregister: 'Map' }; };
const enrichOk = async () => { await sleep(2); return { entities: ['x'], tags: ['y'], entitySummary: 'z' }; };

// ─────────────────────────── PURE: the arithmetic + the honest nulls ───────────────────────────
// Assert the EXACT seconds. "eta is a number" passes on any arithmetic — the bug is a plausible
// wrong number (§3.9). Same three-plus-stall shape as embed-eta's E1/E2/E3/E7, per stage.
{
  const st = { l1Total: 100, l1ActiveMs: 10_000 };   // 100ms/msg measured
  rec('L1-null. paused ⇒ null · no approved model ⇒ null (a choice, never a countdown that cannot run)',
    categorizeEta(st, 50, true, false) === null && categorizeEta(st, 50, false, true) === null,
    `paused=${categorizeEta(st, 50, true, false)} noModel=${categorizeEta(st, 50, false, true)}`);

  const noneYet = categorizeEta({ l1Total: 0, l1ActiveMs: 5_000 }, 50, false, false);
  const noWork = categorizeEta(st, 0, false, false);
  const noDrainer = categorizeEta(null, 50, false, false);
  rec('L1-empty. nothing tagged yet / no work left / no drainer ⇒ null',
    noneYet === null && noWork === null && noDrainer === null,
    `noneYet=${noneYet} noWork=${noWork} noDrainer=${noDrainer}`);

  // 10_000ms / 100 = 100ms each; 50 left ⇒ 5s.  ·  3_000ms / 2 = 1_500ms each; 7 left ⇒ 11s (round).
  const e1 = categorizeEta(st, 50, false, false);
  const e2 = categorizeEta({ l1Total: 2, l1ActiveMs: 3_000 }, 7, false, false);
  rec('L1-math. activeMs/tagged × remaining, to the exact second',
    e1 === 5 && e2 === 11, `eta(100@10s,50 left)=${e1} (want 5) · eta(2@3s,7 left)=${e2} (want 11)`);

  // A stall is an OUTCOME, never a clock — a ONE-pass blip must not blink; TWO withdraws.
  const blip = categorizeEta({ l1Total: 100, l1ActiveMs: 10_000, l1BarrenPasses: 1 }, 50, false, false);
  const wedged = categorizeEta({ l1Total: 100, l1ActiveMs: 10_000, l1BarrenPasses: 2 }, 50, false, false);
  rec('L1-stall. barrenPasses ≥ 2 ⇒ null (rate unknowable); a single blip keeps the estimate',
    blip === 5 && wedged === null, `blip[barren=1]=${blip} (5) · wedged[barren=2]=${wedged} (null)`);
  // #210 MED: a throw AROUND the pass (updateCategories is outside service.js's row try) moves
  // l1Errs, not barren — the estimate must withdraw on it too, exactly like embedEta's embedErrs.
  const errBlip = categorizeEta({ l1Total: 100, l1ActiveMs: 10_000, l1Errs: 1 }, 50, false, false);
  const throwing = categorizeEta({ l1Total: 100, l1ActiveMs: 10_000, l1Errs: 2 }, 50, false, false);
  rec('L1-errs. block throws (l1Errs ≥ 2) ⇒ null — a frozen rate must not keep promising; one throw is a blip',
    errBlip === 5 && throwing === null, `blip[errs=1]=${errBlip} (5) · throwing[errs=2]=${throwing} (null)`);
}
{
  const st = { l2Total: 100, l2ActiveMs: 10_000 };
  rec('L2-null. paused ⇒ null · no approved model ⇒ null',
    enrichEta(st, 50, true, false) === null && enrichEta(st, 50, false, true) === null,
    `paused=${enrichEta(st, 50, true, false)} noModel=${enrichEta(st, 50, false, true)}`);
  const noneYet = enrichEta({ l2Total: 0, l2ActiveMs: 5_000 }, 50, false, false);
  const noWork = enrichEta(st, 0, false, false);
  const noDrainer = enrichEta(null, 50, false, false);
  rec('L2-empty. nothing enriched yet / no work left / no drainer ⇒ null',
    noneYet === null && noWork === null && noDrainer === null,
    `noneYet=${noneYet} noWork=${noWork} noDrainer=${noDrainer}`);
  const e1 = enrichEta(st, 50, false, false);
  const e2 = enrichEta({ l2Total: 2, l2ActiveMs: 3_000 }, 7, false, false);
  rec('L2-math. activeMs/enriched × remaining, to the exact second',
    e1 === 5 && e2 === 11, `eta(100@10s,50 left)=${e1} (want 5) · eta(2@3s,7 left)=${e2} (want 11)`);
  const blip = enrichEta({ l2Total: 100, l2ActiveMs: 10_000, l2BarrenPasses: 1 }, 50, false, false);
  const wedged = enrichEta({ l2Total: 100, l2ActiveMs: 10_000, l2BarrenPasses: 2 }, 50, false, false);
  rec('L2-stall. barrenPasses ≥ 2 ⇒ null; a single blip keeps the estimate',
    blip === 5 && wedged === null, `blip[barren=1]=${blip} (5) · wedged[barren=2]=${wedged} (null)`);
  const errBlip = enrichEta({ l2Total: 100, l2ActiveMs: 10_000, l2Errs: 1 }, 50, false, false);
  const throwing = enrichEta({ l2Total: 100, l2ActiveMs: 10_000, l2Errs: 2 }, 50, false, false);
  rec('L2-errs. block throws (l2Errs ≥ 2) ⇒ null; one throw is a blip',
    errBlip === 5 && throwing === null, `blip[errs=1]=${errBlip} (5) · throwing[errs=2]=${throwing} (null)`);
}

// ─────────── WIRING: a REAL drainer, really tagging/enriching, asked through the REAL rows ───────────
// The gate must call the FUNCTION THAT RENDERS THE ROW, not re-implement it or drive a status stub
// (the models-slice lesson: a re-implemented projection proves the stub, not the wiring — deleting
// the field left that gate green). So: one real drainer, injected classify+enrich (offline,
// deterministic), and categorizeProjection / enrichProjection / the router asked what they render.
let wiredRow = { cat: null, enr: null, active: null };
{
  resumeEnrichProcessing();
  // Backlogs sized to SURVIVE ONE CYCLE: L1 caps at 8×25=200/cycle, L2 at 8×50=400/cycle, and the
  // interval is huge so cycle 2 never starts — so 1200 of each leaves ~1000/~800 pending and the
  // rows keep rendering. (Sized like embed-eta's E4, which read its ceiling from source; do not
  // guess it.)
  const { db, pendCat, pendNlp } = makeVault({
    l1Ids: Array.from({ length: 1200 }, (_, i) => `c${i}`),
    l2Ids: Array.from({ length: 1200 }, (_, i) => `n${i}`),
  });
  const d = startEnrichDrainer({
    db, userId: 'u', intervalMs: 10_000_000, log: () => {},
    classify: classifyOk, enrich: enrichOk, daemon: daemon(), ollama: ollama(),
    embed: { async health() { return { status: 'ok', loaded: true, dim: 768 }; }, async embed() { return new Array(768).fill(0.01); } },
  });
  const ran = await waitFor(() => (d.status().l1Total || 0) >= 100 && (d.status().l2Total || 0) >= 100);
  const s = d.status();
  const cat = await categorizeProjection(db, 'u');   // reads the module-singleton status (this drainer)
  const enr = await enrichProjection(db, 'u');
  wiredRow = { cat, enr };

  // CONTROL: prove the loop actually ran (l1/l2 Total ≥ 100), else zeros are vacuous.
  rec('L1-wire. a REAL drainer tagging real rows ⇒ categorizeProjection renders a real, NON-ZERO etaSeconds',
    ran && s.l1Total >= 100 && s.l1ActiveMs > 0 && s.l1BarrenPasses === 0
      && cat !== null && cat.kind === 'categorize' && typeof cat.etaSeconds === 'number' && cat.etaSeconds > 0,
    `l1Total=${s.l1Total} l1ActiveMs=${s.l1ActiveMs} barren=${s.l1BarrenPasses} · row eta=${cat?.etaSeconds} done=${cat?.done}/${cat?.total} remaining=${cat?.remaining} model=${cat?.model}`);

  rec('L2-wire. a REAL drainer enriching real rows ⇒ enrichProjection renders a real, NON-ZERO etaSeconds',
    ran && s.l2Total >= 100 && s.l2ActiveMs > 0 && s.l2BarrenPasses === 0
      && enr !== null && enr.kind === 'enrich' && typeof enr.etaSeconds === 'number' && enr.etaSeconds > 0
      && enr.stage === 'Understanding messages' && enr.process === 'on-device' && enr.model === MODEL,
    `l2Total=${s.l2Total} l2ActiveMs=${s.l2ActiveMs} barren=${s.l2BarrenPasses} · row eta=${enr?.etaSeconds} done=${enr?.done}/${enr?.total} remaining=${enr?.remaining} stage="${enr?.stage}"`);

  // AGGREGATION: the row must reach the FEED, not just exist. Drive the real /activity route and
  // assert BOTH continuous rows are in active[] (a projection returning a row proves nothing if the
  // route drops it — "wire into the feed's active() aggregation"). The router is invoked directly.
  const router = portalActivityRouter({ db, userId: 'u', authenticatePortalRequest: () => 'u' });
  const call = (url) => new Promise((resolve) => {
    const req = { method: 'GET', url, headers: {} };
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, body: o }); } };
    router(req, res, (e) => resolve({ status: 500, body: { e: String(e) } }));
  });
  const r = await call('/activity');
  const kinds = (r.body?.active || []).map((x) => x.kind);
  wiredRow.active = kinds;
  rec('AGG-wire. the /activity feed aggregates the L2 (enrich) row alongside L1 (categorize)',
    r.status === 200 && kinds.includes('categorize') && kinds.includes('enrich'),
    `active kinds = [${kinds.join(', ')}] (must include both categorize AND enrich)`);
  d.stop();
}

// ─────────── DEFERRED: while embedding still drains, L1+L2 do NOT run — the rows must SAY SO ───────────
// The drainer serializes the on-box stages (drainer.js `waitOnEmbed`): an embed backlog that hits the
// 200-batch/cycle cap while still progressing DEFERS categorize + enrich for the cycle. Before this
// arm the two projections read `categorizeWaitingOnEmbed` NOWHERE, so they rendered `running` + "on
// device" + a live categorizeEta — and because l1Barren/l1Errs cannot move while the loop is idle,
// that ETA FROZE at its last value and ticked a stable, plausible, WRONG countdown for the whole
// import, while PipelineStatus on the SAME screen said "Waiting for embedding to finish". This is the
// §3.9 plausible-wrong class the PR already fixes for the pipeline slice (readiness.js waiting_embed),
// applied to the activity feed too. Drive a REAL deferral (not a status stub — the models-slice
// lesson) and ask the REAL projections what they render.
{
  resumeEnrichProcessing();
  const { db } = makeVault({
    l1Ids: Array.from({ length: 400 }, (_, i) => `dc${i}`),
    l2Ids: Array.from({ length: 400 }, (_, i) => `dn${i}`),
    embedInfinite: true,   // the embed loop caps out every cycle ⇒ categorize + enrich are deferred
  });
  const d = startEnrichDrainer({
    db, userId: 'u', intervalMs: 10_000_000, log: () => {},
    classify: classifyOk, enrich: enrichOk, daemon: daemon(), ollama: ollama(),
    embed: { async health() { return { status: 'ok', loaded: true, dim: 768 }; }, async embed() { return new Array(768).fill(0.01); } },
  });
  // The deferral ARMS only AFTER the embed loop completes its 200-batch cap this cycle. With a huge
  // interval, cycle 2 never starts, so once true it stays true while we read the projections.
  const deferred = await waitFor(() => d.status()?.categorizeWaitingOnEmbed === true, 20_000);
  const s = d.status();
  const cat = await categorizeProjection(db, 'u');
  const enr = await enrichProjection(db, 'u');
  d.stop();

  // CONTROL: the deferral really armed AND the L1/L2 loops really did NOT run (l1Total/l2Total 0) —
  // else these assertions are vacuous (a stage that actually ran would legitimately carry an ETA).
  rec('DEFER-wire. categorize deferred behind embedding ⇒ the row WITHDRAWS its ETA, drops "on device", stops claiming "running"',
    deferred && (s.l1Total || 0) === 0 && s.categorizeWaitingOnEmbed === true
      && cat !== null && cat.kind === 'categorize'
      && cat.etaSeconds === null && cat.process === null && cat.status === 'waiting' && cat.status !== 'running'
      && / waiting for embedding$/.test(cat.stage) && typeof cat.remaining === 'number' && cat.remaining > 0,
    `deferred=${deferred} l1Total=${s.l1Total} (0 — loop idle) waiting=${s.categorizeWaitingOnEmbed} · row: eta=${cat?.etaSeconds} (null) process=${JSON.stringify(cat?.process)} (null) status=${cat?.status} (waiting) stage="${cat?.stage}" remaining=${cat?.remaining}`);

  rec('DEFER-wire-L2. enrich deferred behind embedding ⇒ same: ETA withdrawn, no "on device", not "running"',
    deferred && (s.l2Total || 0) === 0
      && enr !== null && enr.kind === 'enrich'
      && enr.etaSeconds === null && enr.process === null && enr.status === 'waiting'
      && / waiting for embedding$/.test(enr.stage) && typeof enr.remaining === 'number' && enr.remaining > 0,
    `l2Total=${s.l2Total} (0) · row: eta=${enr?.etaSeconds} (null) process=${JSON.stringify(enr?.process)} (null) status=${enr?.status} (waiting) stage="${enr?.stage}" remaining=${enr?.remaining}`);
}

// ─────────── L1: a SKIP is progress — a blank run must not blank a KNOWN estimate (E6e analog) ───────────
// A whitespace-only L1 row is marked categories_processed = 1 (TERMINAL) with NO classify call, so
// `pending` shrinks while `enriched` stays 0 — the exact shape that must NOT be barren. Reals FIRST
// (so a rate exists to preserve), then a blank run; SAMPLED PER BATCH (blanks are instant — a
// clock-sampler walks past). The estimate must never go null across the blank run.
{
  resumeEnrichProcessing();
  const { db, pendCat } = makeVault({
    l1Ids: Array.from({ length: 200 }, (_, i) => `r${i}`),
    blankCatIds: Array.from({ length: 600 }, (_, i) => `b${i}`),
    l2Ids: [],
  });
  let dref = null, maxBarren = 0, nulls = 0, samples = 0;
  const inner = db.messages.selectPendingCategories;
  db.messages.selectPendingCategories = async (...a) => {
    const st = dref?.status?.();
    if (st && (st.l1Total || 0) > 0 && pendCat().length > 0) {   // a rate exists AND work remains
      maxBarren = Math.max(maxBarren, st.l1BarrenPasses || 0);
      samples++;
      if (categorizeEta(st, pendCat().length, false, false) === null) nulls++;
    }
    return inner(...a);
  };
  const startPending = pendCat().length;
  // Multiple cycles (interval short) so the 8-pass cap doesn't stop the blank run early.
  dref = startEnrichDrainer({
    db, userId: 'u', intervalMs: 30, log: () => {},
    classify: classifyOk, enrich: enrichOk, daemon: daemon(), ollama: ollama(),
    embed: { async health() { return { status: 'ok', loaded: true, dim: 768 }; }, async embed() { return new Array(768).fill(0.01); } },
  });
  await waitFor(() => pendCat().length === 0, 20_000);
  dref.stop();
  rec('L1-skip. a BLANK-CONTENT run is progress — the estimate never blinks while pending drains',
    samples > 4 && maxBarren < 2 && nulls === 0,
    `samples=${samples} (>4 — the loop really ran) · maxBarrenPasses=${maxBarren} (must stay <2 — a skip is NOT barren) · ${nulls}/${samples} batches with NO estimate (must be 0) · pending ${startPending}->${pendCat().length}`);
}

// ─────────── L2: a non-empty batch that enriches NOTHING is stalled — the estimate withdraws ───────────
// L2 has no skip path — every scanned row enriches (nlp_processed=1) or is isolated to -1
// (service.js). So `enriched === 0` on a non-empty batch means every row FAILED: those rows leave
// the backlog, but nothing was enriched, so the rate is unknowable and the ETA must withdraw.
// Establish a rate first (200 enriched), THEN poison every enrich; assert on the SIGNAL (timing-free
// — a -1 row's pending oscillation makes a row-level sample a coin toss, per embed-eta's E6d).
{
  resumeEnrichProcessing();
  const { db } = makeVault({ l1Ids: [], l2Ids: Array.from({ length: 2000 }, (_, i) => `p${i}`) });
  let poison = false;
  const enrichMaybePoison = async () => { await sleep(2); if (poison) throw new Error('enrich failed'); return { entities: ['x'], tags: ['y'], entitySummary: 'z' }; };
  const d = startEnrichDrainer({
    db, userId: 'u', intervalMs: 30, log: () => {},
    classify: classifyOk, enrich: enrichMaybePoison, daemon: daemon(), ollama: ollama(),
    embed: { async health() { return { status: 'ok', loaded: true, dim: 768 }; }, async embed() { return new Array(768).fill(0.01); } },
  });
  await waitFor(() => (d.status().l2Total || 0) >= 200, 20_000);   // a real rate exists…
  poison = true;                                                    // …then every enrich throws
  const fired = await waitFor(() => (d.status().l2BarrenPasses || 0) >= 2, 8000);
  const st = d.status();
  d.stop();
  rec('L2-fail. every row fails (enriched=0 of a non-empty batch) ⇒ still a stall — the estimate withdraws',
    fired && st.l2Total >= 200 && enrichEta(st, 100, false, false) === null,
    `l2BarrenPasses=${st.l2BarrenPasses} (>=2 — fires) · l2Total=${st.l2Total} (>=200: a REAL rate existed, then was lost) · eta=${enrichEta(st, 100, false, false)} (must be null)`);
}

// ─────────── ERRS: a throw AROUND the pass withdraws BOTH etas (#210 MED — probeN, permanent) ───────────
// The barren counters can only move INSIDE a pass, but both write paths throw AROUND it: L1's
// updateCategories sits outside service.js's row try, and L2 on a locked vault throws in updateNlp
// AND in the catch's −1 write. Before the fix both throws landed in cycle()'s outer catch — no
// bank, no failed, no barren — so the counters froze at their last honest value and both rows
// rendered a constant "eta · running" forever, while the EMBED row on the same screen went honest
// (embedErrs ≥ 2). Asymmetric honesty = the §3.9 plausible-wrong-number class.
// Shape: establish a REAL rate (the control — rows genuinely processed, n large), lock every
// write, assert BOTH etas go null within ~2 cycles WHILE pending holds; then the RECOVERY leg —
// writes work again ⇒ a banking pass resets errs ⇒ the estimate returns.
{
  resumeEnrichProcessing();
  const { db, pendCat, pendNlp, setWriteLock } = makeVault({
    l1Ids: Array.from({ length: 20_000 }, (_, i) => `c${i}`),
    l2Ids: Array.from({ length: 20_000 }, (_, i) => `n${i}`),
  });
  const d = startEnrichDrainer({
    db, userId: 'u', intervalMs: 30, log: () => {},
    classify: classifyOk, enrich: enrichOk, daemon: daemon(), ollama: ollama(),
    embed: { async health() { return { status: 'ok', loaded: true, dim: 768 }; }, async embed() { return new Array(768).fill(0.01); } },
  });
  // 1. CONTROL: a real rate exists on both stages, and both rows promise a finish.
  const rateReady = await waitFor(() => (d.status().l1Total || 0) >= 50 && (d.status().l2Total || 0) >= 50, 20_000);
  const etaCat0 = (await categorizeProjection(db, 'u'))?.etaSeconds;
  const etaEnr0 = (await enrichProjection(db, 'u'))?.etaSeconds;
  // 2. The vault locks: every write throws, AROUND the pass. Sample pending AFTER the lock so a
  //    mid-flight row can't race the counts (the stubs throw before mutating once locked).
  setWriteLock(true);
  const pendCatAtLock = pendCat().length;
  const pendNlpAtLock = pendNlp().length;
  const fired = await waitFor(() => (d.status().l1Errs || 0) >= 2 && (d.status().l2Errs || 0) >= 2, 8000);
  const sLock = d.status();
  const catLocked = await categorizeProjection(db, 'u');
  const enrLocked = await enrichProjection(db, 'u');
  const pendingHeld = pendCat().length === pendCatAtLock && pendNlp().length === pendNlpAtLock && pendCatAtLock > 0 && pendNlpAtLock > 0;
  rec('ERRS-wire. a locked vault (write throws AROUND the pass) ⇒ BOTH real rows withdraw their estimate while pending holds',
    rateReady && etaCat0 > 0 && etaEnr0 > 0
      && fired && sLock.l1BarrenPasses === 0 && sLock.l2BarrenPasses === 0   // barren is BLIND here — only errs can see it
      && catLocked !== null && catLocked.etaSeconds === null
      && enrLocked !== null && enrLocked.etaSeconds === null && pendingHeld,
    `rate first: catEta=${etaCat0}s enrEta=${etaEnr0}s (both > 0 — the control) · locked: l1Errs=${sLock.l1Errs} l2Errs=${sLock.l2Errs} (both >=2, ~2 cycles) · `
    + `barren=${sLock.l1BarrenPasses}/${sLock.l2BarrenPasses} (both 0 — THE PROXY IS BLIND, the throw is around the pass) · `
    + `row etas=${catLocked?.etaSeconds}/${enrLocked?.etaSeconds} (both null) · pending held at ${pendCatAtLock}/${pendNlpAtLock}`);

  // 3. RECOVERY: the key returns, a banking pass resets errs, the estimate comes back. Without
  //    this leg "increment on throw" could be quietly widened into "never reset" and every gate
  //    above would stay green (the E6c lesson: only the recovery path distinguishes a consecutive
  //    counter from a lifetime one).
  setWriteLock(false);
  const totalAtLock = d.status().l1Total;
  const recovered = await waitFor(() => {
    const s = d.status();
    return (s.l1Errs || 0) === 0 && (s.l2Errs || 0) === 0 && (s.l1Total || 0) > totalAtLock;
  }, 8000);
  const catBack = await categorizeProjection(db, 'u');
  const enrBack = await enrichProjection(db, 'u');
  d.stop();
  rec('ERRS-recover. writes work again ⇒ a banking pass resets errs ⇒ both estimates return',
    recovered && pendCat().length > 0 && pendNlp().length > 0
      && typeof catBack?.etaSeconds === 'number' && catBack.etaSeconds > 0
      && typeof enrBack?.etaSeconds === 'number' && enrBack.etaSeconds > 0,
    `errs reset + progress resumed=${recovered} · etas back: cat=${catBack?.etaSeconds}s enr=${enrBack?.etaSeconds}s (both > 0, pending ${pendCat().length}/${pendNlp().length} still real)`);
}

// ─────────── BLANK: L2's `done` counts only what L2 owns (#210 LOW) ───────────
// nlp_processed = 1 has TWO writers: L2 success (service.js enrichNlpOnce) AND the embed stage's
// blank-skip (drainOnce sends a whitespace-only row 0→1 DIRECTLY — L2 never touches it). The
// filter used to be `content != ''` (empty-string only), so blanks landed in `total` AND `done`
// and the bar overfilled with rows L2 never processed. Run the REAL SQL against a REAL sqlite
// table (not a stub of the query — the predicate IS the thing under test).
{
  const raw = new Database(':memory:');
  raw.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, user_id TEXT, content TEXT, nlp_processed INTEGER, forgotten_at TEXT)');
  const ins = raw.prepare('INSERT INTO messages (id,user_id,content,nlp_processed,forgotten_at) VALUES (?,?,?,?,?)');
  ins.run('done1', 'u', 'a real enriched row', 1, null);     // L2 success — counted in done
  ins.run('done2', 'u', 'another enriched row', 1, null);    // L2 success — counted in done
  ins.run('blank1', 'u', '   \n  ', 1, null);                // embed's blank-skip: 0→1 directly, L2 never saw it — EXCLUDED from total AND done
  ins.run('blank2', 'u', '\t \t', 1, null);                  // tab-only blank — same
  ins.run('pend1', 'u', 'awaiting enrichment', 2, null);     // L2 pending — counted
  ins.run('unproc1', 'u', 'not yet embedded', 0, null);      // pre-embed — in total, in neither done nor pending
  ins.run('empty1', 'u', '', 1, null);                       // already excluded by content != ''
  ins.run('forgot1', 'u', 'forgotten row', 2, '2026-01-01'); // forgotten — excluded entirely
  const d1Query = async (sql, params = []) => ({ results: raw.prepare(sql).all(...params) });
  const ns = createMessagesNamespace({ d1Query, d1Batch: async () => ({}), firstRow: (r) => (r.results || [])[0] });
  const v = await ns.nlpBacklogCached('u');
  // total = done1,done2,pend1,unproc1 = 4 (blanks + empty + forgotten OUT of total AND done
  // CONSISTENTLY) · done = 2 (NOT 4 — the blank-skips are not L2's work) · pending = 1 (exact
  // either way: a blank can never sit at nlp_processed=2 — it goes 0→1 without embedding).
  rec('BLANK. the blank-skip population (embed writes nlp_processed=1 too) is out of total AND done; pending stays exact',
    v.total === 4 && v.done === 2 && v.pending === 1,
    `got ${JSON.stringify(v)} · want {done:2,total:4,pending:1} — blanks excluded consistently, done counts only L2's own writes`);
}

// ─────────── COST: nlpBacklogCached is polled @2.5s — a repeat within TTL must touch the db ZERO times ───────────
// The C1 pattern (memory: gates-assert-shape-never-cost). The underlying COUNT is a multi-second
// full-table decrypt on a large at-rest vault; polled per-call it queues unbounded → boot hang.
// Count db touches ACROSS two calls: cold = 1, warm (within TTL) = 0. Falsify by removing the cache
// (making nlpBacklogCached call _computeNlpBacklog every time) ⇒ warm touches > 0.
{
  let touches = 0;
  const d1Query = async () => { touches++; return { results: [{ total: 1000, done: 100, pending: 500 }] }; };
  // d1Batch/firstRow are required by the constructor but unused by nlpBacklogCached — no-op stubs.
  const ns = createMessagesNamespace({ d1Query, d1Batch: async () => ({}), firstRow: (r) => (r.results || [])[0] });
  const cold = await ns.nlpBacklogCached('u');
  const afterCold = touches;                 // must be 1 (the scan ran once)
  await ns.nlpBacklogCached('u');            // within the 8s pending>0 TTL
  await ns.nlpBacklogCached('u');
  const warm = touches - afterCold;          // must be 0 (served from cache)
  rec('COST. nlpBacklogCached: cold scans once; a repeat within TTL touches the db ZERO times',
    afterCold === 1 && warm === 0 && cold.pending === 500 && cold.done === 100 && cold.total === 1000,
    `coldTouches=${afterCold} (want 1) · warmTouches=${warm} (want 0 — polled @2.5s) · value=${JSON.stringify(cold)}`);

  // CONTROL: the predicate is COUNTED, not projected — pending must reflect a real query, and the
  // shape must be {done,total,pending}. (A projection off total would strand -1/0 rows forever, the
  // embed-backlog trap; this proves the value came from the compute, not a hardcoded 0.)
  rec('COST-shape. the cached value is the compute’s real {done,total,pending} shape',
    typeof cold.done === 'number' && typeof cold.total === 'number' && typeof cold.pending === 'number',
    `keys=${Object.keys(cold).join(',')}`);
}

const passed = ledger.filter(Boolean).length;
const failed = ledger.length - passed;
console.log('\n================================================================');
console.log(`wiring evidence: cat.eta=${wiredRow.cat?.etaSeconds}s enr.eta=${wiredRow.enr?.etaSeconds}s active=[${(wiredRow.active || []).join(',')}]`);
console.log(failed === 0
  ? 'VERDICT: GO — L1 + L2 ETAs are measured from real throughput, honest when unknowable, wired into the feed, and cheap to poll  EXIT=0'
  : 'VERDICT: NO-GO — see FAIL rows  EXIT=1');
console.log('================================================================');
process.exit(failed === 0 ? 0 : 1);
