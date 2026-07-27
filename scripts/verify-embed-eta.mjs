// verify:embed-eta — R1 (§3.9): the embed row's ETA is REAL, and honest when it cannot be.
//
// The feed's etaSeconds() needs a background_jobs ROW (step/total_steps/started_at). The embed row
// is a SYNTHETIC PROJECTION from counts — no started_at — so its rate comes from the drainer's own
// measured throughput. These gates pin the arithmetic, the honest nulls, and (E4/E5) the WIRING.
//
//   E1  paused ⇒ null (a countdown to a moment that will never arrive is not an estimate)
//   E2  nothing embedded yet ⇒ null; no work remaining ⇒ null
//   E3  the arithmetic: the EXACT seconds, not "a number appeared"
//   E4  WIRING: a REAL drainer that REALLY embeds ⇒ embedProjection renders a real eta
//   E5  ⭐ the rate is ACTIVE drain time, NOT elapsed — idling must not inflate the estimate
//
// ⚠️ E4/E5 use an embed stub that returns a REAL 768-float vector. That matters: a stub returning
// null makes service.js treat every row as a TRANSIENT failure (`if (vec == null) continue;`) and
// leave it pending, so the drain loop moves nothing, stalls out after one pass, and embeds NOTHING.
// A gate built on that stub can only ever observe zero — which is exactly why the sibling gate
// verify-enrich-ollama-wake.mjs could not test its own drain loop (its P1c was cut for measuring
// nothing). Real vector ⇒ rows actually get marked ⇒ the drainer's counters actually move.
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>.

import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import crypto from 'node:crypto';
process.env.ENCRYPTION_MASTER_KEY ||= crypto.randomBytes(32).toString('hex');

const { embedEta, embedProjection } = await import('../src/portal-activity.js');
const { startEnrichDrainer, pauseEnrichProcessing, resumeEnrichProcessing } = await import('../src/enrich/drainer.js');

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 4000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(20); }
  return false;
};

const EMBED_DIM = 768;
// A REAL vector — see the header. `delayMs` lets E5 make embedding measurably slow, so ACTIVE time
// and ELAPSED time are distinguishable rather than both being ~0.
const realEmbed = (delayMs = 0) => ({
  async health() { return { status: 'ok', loaded: true, dim: EMBED_DIM }; },
  async embed() { if (delayMs) await sleep(delayMs); return new Array(EMBED_DIM).fill(0.01); },
});

// A messages namespace whose embed backlog REALLY drains: updateEnrichment marks rows, so
// selectPendingEnrichment shrinks and the drainer's counters move.
function makeDb(embedIds, { blankIds = [] } = {}) {
  // `blankIds` carry WHITESPACE-ONLY content: it passes db/messages.js's `content != ''` filter, so
  // the drain SELECTS these rows, and service.js trims and skips them (nlp_processed = 1, TERMINAL).
  // Real, healthy, fast work — and nothing in this file drove one until E6e, which is exactly why a
  // blank run could read as a stall unnoticed.
  // Reals FIRST: selectPendingEnrichment serves in insertion order, so a rate is established
  // before the blank run arrives. (Blanks first meant the run was consumed before the first embed,
  // so the probe waiting on `embeddedTotal > 0` never saw it at all.)
  const rows = new Map([
    ...embedIds.map((id) => [id, { id, content: `row ${id} about minds`, nlp_processed: 0 }]),
    ...blankIds.map((id) => [id, { id, content: '   \n  ', nlp_processed: 0 }]),
  ]);
  const pending = () => [...rows.values()].filter((r) => r.nlp_processed === 0);
  return {
    db: {
      users: { getSettings: async () => ({}) },
      // The drainer's SELF-HEAL, mirrored: every cycle it runs
      //   UPDATE messages SET nlp_processed = 0 WHERE nlp_processed = -1 AND embedding_768 IS NULL
      // — resurrecting rows a previous pass poisoned. A no-op stub here is what let E6d "pass" by
      // draining to empty: without the resurrection the failed rows leave the backlog and the row
      // stops rendering, which is the OPPOSITE of the production behaviour the gate is about (the
      // poison/resurrect loop is precisely why a failing head never drains).
      async rawQuery() {
        for (const r of rows.values()) if (r.nlp_processed === -1) r.nlp_processed = 0;
        return { rows: [] };
      },
      messages: {
        async selectPendingEnrichment(_u, { limit = 25 } = {}) { return pending().slice(0, limit); },
        async updateEnrichment(id, _u, patch) {
          const r = rows.get(id);
          if (r && patch.nlpProcessed !== undefined) r.nlp_processed = patch.nlpProcessed;
          else if (r) r.nlp_processed = 2;
        },
        async selectPendingNlp() { return []; },
        async updateNlp() {},
        async selectPendingCategories() { return []; },
        async updateCategories() {},
        async embedBacklogCached() {
          const total = rows.size;
          const p = pending().length;
          return { embedded: total - p, total, pending: p };
        },
      },
    },
    pendingCount: () => pending().length,
  };
}

// ── E1 / E2 / E3: the calculation, in isolation ──
// Assert the EXACT value. "eta is a number" would pass on any arithmetic at all — the bug this
// guards against is a plausible wrong number, which is precisely what §3.9 says made the 29-hour
// import intolerable.
{
  const st = { embeddedTotal: 100, embedActiveMs: 10_000 };   // 100ms per message, measured
  rec('E1. paused ⇒ null (never a countdown that cannot run down)',
    embedEta(st, 50, true) === null, `embedEta(st, 50, paused=true)=${embedEta(st, 50, true)}`);

  const noneYet = embedEta({ embeddedTotal: 0, embedActiveMs: 5_000 }, 50, false);
  const noWork = embedEta(st, 0, false);
  const noDrainer = embedEta(null, 50, false);
  rec('E2. nothing embedded yet / no work left / no drainer ⇒ null',
    noneYet === null && noWork === null && noDrainer === null,
    `noneYet=${noneYet} noWork=${noWork} noDrainer=${noDrainer}`);

  // 10_000ms / 100 msgs = 100ms each; 50 left ⇒ 5_000ms ⇒ 5s.
  const eta = embedEta(st, 50, false);
  // 3_000ms / 2 msgs = 1_500ms each; 7 left ⇒ 10_500ms ⇒ 11s (rounded).
  const eta2 = embedEta({ embeddedTotal: 2, embedActiveMs: 3_000 }, 7, false);
  rec('E3. the arithmetic: activeMs/embedded × remaining, to the exact second',
    eta === 5 && eta2 === 11, `eta(100@10s, 50 left)=${eta} (want 5) · eta(2@3s, 7 left)=${eta2} (want 11)`);
}

// ── E7: a stall is an OUTCOME, not a clock reading ──
// E6 proves the rate FREEZES when nothing embeds. Frozen is not honest: a wedged queue would still
// render a stable "1s left" forever, over a `pending` that never reaches 0 (§3.9 named this: "an
// ETA over a pending that never reaches 0 is ∞"), and it is reachable TODAY — transient rows stay
// pending by design, with no attempt cap. We cannot fix that queue from the feed; we must not PRICE
// it.
// ⚠️ THIS WAS A TIME WINDOW TWICE, AND BOTH VALUES WERE SHORTER THAN SUCCESS. 90s (a healthy vault
// lost its ETA 28% of every long batch) then 240s (derived from the embedBatch path, blind to
// service.js's per-row fallback: 30 + 12x30 per chunk ⇒ ~1,950s for a batch where EVERY ROW
// SUCCEEDS). The honest window is ~32 minutes, which is not a stall detector. A time window at
// batch granularity is underivable — so this asks the drainer what it DID.
// The decisive row is `slowButWorking`: an hour-old stamp with noProgress === 0 KEEPS its estimate.
// No clock can say that; an outcome can.
{
  const moving = { embeddedTotal: 100, embedActiveMs: 10_000, barrenPasses: 0, embedErrs: 0 };
  const slowButWorking = { embeddedTotal: 100, embedActiveMs: 10_000, barrenPasses: 0, embedErrs: 0, lastProgressAt: Date.now() - 3_600_000 };
  const oneBarrenPass = { embeddedTotal: 100, embedActiveMs: 10_000, barrenPasses: 1, embedErrs: 0 };
  const wedged = { embeddedTotal: 100, embedActiveMs: 10_000, barrenPasses: 2, embedErrs: 0 };
  const throwing = { embeddedTotal: 100, embedActiveMs: 10_000, barrenPasses: 0, embedErrs: 2 };
  const eMoving = embedEta(moving, 50, false);
  const eSlow = embedEta(slowButWorking, 50, false);
  const eBlip = embedEta(oneBarrenPass, 50, false);
  const eWedged = embedEta(wedged, 50, false);
  const eThrow = embedEta(throwing, 50, false);
  rec('E7. a stall is an OUTCOME (barren passes), never a clock — a slow batch keeps its estimate',
    eMoving === 5 && eSlow === 5 && eBlip === 5 && eWedged === null && eThrow === null,
    `moving=${eMoving} (5) · slowButWorking[stamp 1 HOUR old, barrenPasses=0]=${eSlow} (5, NOT null — no clock may kill this) · `
    + `oneBarrenPass=${eBlip} (5 — a blip must not make it blink) · wedged[noProgress=2]=${eWedged} (null) · throwingDrain[embedErrs=2]=${eThrow} (null)`);
}

// ── E4 + E5: ONE real drainer, really embedding ──
// The backlog is sized to SURVIVE ONE CYCLE on purpose: the drain loop runs at most 200 batches ×
// `batchSize = 50` (service.js:62) = 10,000 rows per cycle, so 12,000 leaves ~2,000 pending after
// cycle 1 — with the interval long enough that cycle 2 cannot start. Deterministic, not a race.
// ⚠️ TWO FIXTURE FAILURES GOT ME HERE, both of which made the gate say nothing about the code:
// 60 rows drained completely before the probe looked (pending hit 0, so embedProjection correctly
// returned null — no backlog, no row); then 6,000 did too, because I had guessed the cap was
// 200×25. The ceiling is a real number in the source; read it, don't estimate it.
{
  resumeEnrichProcessing();
  const t0 = Date.now();
  const { db, pendingCount } = makeDb(Array.from({ length: 12_000 }, (_, i) => `m${i}`));
  const d = startEnrichDrainer({
    db, userId: 'u', intervalMs: 60_000, embed: realEmbed(5), log: () => {},   // one cycle, then idle
    resolveLabelModel: async () => null, resolveEnrichModel: async () => null,
  });
  const cycleDone = await waitFor(() => (d.status?.().embeddedTotal || 0) >= 10_000, 30_000);

  const row = await embedProjection(db, 'u');
  const s1 = d.status();
  const remaining = pendingCount();
  const eta1 = embedEta(s1, remaining, false);
  rec('E4. a REAL drainer embedding real rows ⇒ the row carries a real, NON-ZERO etaSeconds',
    cycleDone && row !== null && typeof row.etaSeconds === 'number' && row.etaSeconds > 0,
    `cycleDone=${cycleDone} pending=${pendingCount()} etaSeconds=${row?.etaSeconds} done=${row?.done}/${row?.total} embeddedTotal=${s1.embeddedTotal} activeMs=${s1.embedActiveMs}`);

  // ── E5 ⭐ THE DESIGN DECISION: active drain time EXCLUDES idle; elapsed would not ──
  // ⚠️ MY FIRST E5 COULD NOT SEE THIS BUG AT ALL. It sampled activeMs, idled 600ms, sampled again,
  // and asserted the value HELD — which passes under BOTH implementations, because an elapsed-based
  // counter only recomputes INSIDE a cycle, and no cycle runs while idle. Reverting the drainer to
  // wall-clock left all five gates green. The mutation is only visible once a cycle runs AFTER an
  // idle gap: then active time must have grown by the WORK only, while wall-clock grew by work +
  // idle. So the property is "wall-clock minus active ≥ the idle we inserted" — idle is excluded,
  // by measurement rather than by assertion.
  // This matters because after R3 a long gap is NORMAL, not exotic: the pause is persisted and can
  // last overnight. An elapsed-based rate would price every message at its idle-inflated cost and
  // promise days on an hour of work — §3.9's lie, wearing a progress bar.
  const IDLE_MS = 2000;
  await sleep(IDLE_MS);
  const s2 = d.status();
  const heldWhileIdle = s2.embedActiveMs === s1.embedActiveMs;   // necessary, but NOT sufficient
  const eta2 = embedEta(s2, remaining, false);

  // ⚠️ A THRESHOLD IS NOT THE PROPERTY. This asserted `wall - active >= idle * 0.75`, and a
  // reviewer walked a PARTIAL-billing drainer straight through it: bill the drain loop PLUS 25%
  // of the preceding gap and the gate passed by 18ms — while billing idle, and while reporting a
  // fractional "ms spent draining". Over the overnight pause R3 made normal, 25% of 8h is 2h of
  // phantom active time: the catastrophe this gate exists to prevent, at quarter strength, GREEN.
  // The exact property has nothing to do with proportions: A CYCLE CANNOT BANK MORE TIME THAN THE
  // CYCLE ITSELF TOOK. Time it, from outside, and compare.
  const tBefore = Date.now();
  const bankedBefore = d.status().embedActiveMs;
  d.nudge();                                                     // a cycle AFTER the gap — the discriminator
  await waitFor(() => (d.status?.().embeddedTotal || 0) >= 12_000, 30_000);
  const cycleWallMs = Date.now() - tBefore;                      // what that cycle REALLY cost
  const s3 = d.status();
  const banked = s3.embedActiveMs - bankedBefore;                // what it CLAIMED to cost
  // ⚠️ TWO-SIDED, BECAUSE AN UPPER BOUND ALONE IS HALF A PROPERTY — and the missing half is the
  // DANGEROUS half. A reviewer halved the banked time (`* 0.5`) and all 7 gates passed while the
  // ledger PRINTED the discrepancy ("BANKED 633ms but TOOK 1275ms") and called it PASS. That ships
  // an ETA 2x OPTIMISTIC: a 29-hour import advertising "~14h 30m", on the one decision §3.9 exists
  // to inform ("do I leave this running overnight?"). The property is "a cycle banks THE TIME IT
  // TOOK", not "no more than".
  // The lower bound is legitimate ONLY because THIS fixture is all-productive (every batch embeds,
  // resolvers are nulled, the L1 block is skipped) — so banked should be nearly the whole cycle.
  // It would be WRONG as a general rule: a wedged queue banks nothing by design (E6).
  const notOverBilled = banked <= cycleWallMs + 50;              // +50ms: scheduler slop, not a fudge
  // 0.9, NOT 0.7. I picked 0.7 without measuring; the fixture actually bills 98.5-99.4% (it is
  // all-productive by construction), so 0.7 left a 30-POINT GAP WITH NOTHING IN IT — and a 25%
  // under-bill sailed through, printing "BANKED 933ms and TOOK 1253ms" and calling it PASS. A 25%
  // optimistic ETA advertises a 29-hour import as "~21h 45m": the direction that costs the user
  // their evening. 0.9 keeps ~9% headroom over the measured floor (independent review).
  const notUnderBilled = banked >= cycleWallMs * 0.9;            // all batches embed here ⇒ ~all of it is billable
  const wallSinceStart = Date.now() - t0;
  const excludesIdle = (wallSinceStart - s3.embedActiveMs) >= IDLE_MS * 0.75;
  d.stop();
  rec('E5. a cycle cannot bank more time than it took — the idle gap is not billable',
    s1.embedActiveMs > 0 && s1.embeddedTotal > 0 && eta1 > 0
    && heldWhileIdle && eta2 === eta1 && excludesIdle && notOverBilled && notUnderBilled,
    `activeMs ${s1.embedActiveMs}→${s2.embedActiveMs} (held over idle) →${s3.embedActiveMs} after a post-idle cycle · `
    + `that cycle BANKED ${banked}ms and TOOK ${cycleWallMs}ms (must be neither over nor under: ${Math.round(cycleWallMs * 0.9)}..${cycleWallMs + 50}) · `
    + `wall−active=${wallSinceStart - s3.embedActiveMs}ms (≥ the ${IDLE_MS}ms idle) · eta ${eta1}→${eta2}s`);
}

// ── E6 ⭐ A STUCK ROW MUST NOT INFLATE THE RATE (the review's HIGH) ──
// ⚠️ THIS GATE USES THE "BROKEN" STUB I REMOVED — AND THAT REMOVAL WAS THE BUG'S CAMOUFLAGE. This
// file's header used to call a null-returning embed stub a fixture DEFECT ("embeds NOTHING"). It
// is not a defect: it is the PRODUCTION STATE of a row that fails transiently, which service.js
// leaves pending BY DESIGN (`if (vec == null) continue;` — never poison a valid row), and which
// the repo already documents as retried forever with no attempt cap. So the one stub that
// reproduces the failure was the one I deleted, and the gate's blind spot lined up exactly with
// the code's. A reviewer measured 30x perItem inflation in 10 seconds through that hole.
//
// Embed some rows for real, then wedge the queue: the rate must FREEZE, not climb. If activeMs
// banks time while embeddedTotal cannot move, perItem grows with wall-clock forever and the row
// renders a GROWING countdown ("~3600m left" after a day) while claiming 'running' — the
// plausible-wrong-number §3.9 exists to kill, introduced BY §3.9.
{
  resumeEnrichProcessing();
  // 250 rows: 200 embed for real, then the queue wedges with 50 STILL PENDING — so the projection
  // keeps rendering a row and we can ask what the USER would see. (200 alone drains to pending=0
  // and embedProjection correctly returns no row at all.)
  // ⚠️ 800 ROWS OF SLACK, NOT 50. At 250/200 the remaining batch cost ~15ms while `waitFor` polls
  // every 20ms — so the poll could land after the backlog was ALREADY EMPTY, leaving pending=0, no
  // row, and a FALSE RED on correct code. Measured: E6b failed 2/8 under load and ~1/13 idle. That
  // is my own round-4 standard ("a gate that flakes in CI is worse than no gate") applied to my own
  // gate, and it is the same class as E6's activeMs=0 margin: a fixture, not an assertion. 800 rows
  // of slack is ~240ms of drain — twelve poll periods — so the wedge cannot outrun the sampler.
  const { db, pendingCount } = makeDb(Array.from({ length: 1000 }, (_, i) => `g${i}`));
  let wedge = false;
  // ⚠️ A REAL DELAY, NOT 0. `realEmbed(0)` skips the sleep entirely, so activeMs had NO
  // machine-independent floor: measured 2-3ms on this box, and at activeMs === 0 the inflation
  // ratio goes Infinity and reds a CORRECT drainer. A ~2x faster machine false-reds this inside
  // verify:core. The delay knob exists for exactly this and I passed 0 (independent review).
  const stub = realEmbed(3);
  const wedged = {
    async health() { return stub.health(); },
    async embed(...a) {
      if (!wedge) return stub.embed(...a);
      await sleep(8);                 // a slow row that never yields a vector
      return null;                    // TRANSIENT failure => service.js leaves the row PENDING
    },
  };
  const d = startEnrichDrainer({
    db, userId: 'u', intervalMs: 40, embed: wedged, log: () => {},
    resolveLabelModel: async () => null, resolveEnrichModel: async () => null,
  });
  await waitFor(() => (d.status?.().embeddedTotal || 0) >= 200, 20_000);
  wedge = true;                       // from here on NOTHING can embed, but cycles keep running
  // ⚠️ LET THE IN-FLIGHT WORK SETTLE BEFORE THE BASELINE. Flipping the flag does not stop the batch
  // already running: rows queued before the flip still return real vectors, so embeddedTotal kept
  // climbing (200 -> 224) AFTER the baseline and the gate red-flagged its own fixture. Wait for the
  // counter to hold still, THEN measure the freeze — otherwise "frozen" is racing the drainer.
  let settle = -1;
  while (settle !== (d.status?.().embeddedTotal || 0)) {
    settle = d.status?.().embeddedTotal || 0;
    await sleep(200);
  }
  const s1 = d.status();
  const per1 = s1.embedActiveMs / s1.embeddedTotal;
  await sleep(1500);                  // many cycles, all burning time, all embedding nothing
  const s2 = d.status();
  const per2 = s2.embedActiveMs / s2.embeddedTotal;
  const d2status = () => d.status?.();
  const inflation = per1 > 0 ? per2 / per1 : Infinity;
  rec('E6. a wedged queue FREEZES the rate — a pass that embeds nothing prices nothing',
    s1.embeddedTotal >= 200 && s2.embeddedTotal === s1.embeddedTotal
    && s2.embedActiveMs === s1.embedActiveMs && inflation === 1,
    `embeddedTotal ${s1.embeddedTotal}->${s2.embeddedTotal} (frozen, correctly) · `
    + `activeMs ${s1.embedActiveMs}->${s2.embedActiveMs} (MUST NOT grow) · `
    + `perItem ${per1.toFixed(2)}ms->${per2.toFixed(2)}ms · inflation ${inflation.toFixed(2)}x (must be 1.00x)`);

  // ── E6b ⭐ THE GATE THE TIME WINDOW MADE UNAFFORDABLE ──
  // A REAL drainer, really wedged, asked through the REAL projection: what does the USER see?
  // Every previous version of this rule was pure-input only (E7), and a reviewer named that hole
  // exactly — "probeF is the gate you don't have" — because gating a 240s window costs >4 MINUTES
  // in verify:core. An OUTCOME signal is observable the moment the second barren pass returns, so
  // the gate that was unaffordable is now ~1 second. That a rule becomes cheap to verify when
  // stated as an outcome, and unaffordable when stated as a clock, is itself the argument for the
  // shape.
  const sawStall = await waitFor(() => (d2status()?.noProgress || 0) >= 2, 8000);
  const rowNow = await embedProjection(db, 'u');
  rec('E6b. a REALLY wedged drainer ⇒ the REAL row withdraws its estimate (no clock involved)',
    sawStall && pendingCount() > 0 && rowNow !== null && rowNow.etaSeconds === null,
    `noProgress=${d2status()?.noProgress} (>=2) · pending=${pendingCount()} (row still renders) · etaSeconds=${rowNow?.etaSeconds} (must be null) · stage=${rowNow?.stage}`);

  // ── E6c ⭐ A STALL MUST BE RECOVERABLE — and nothing gated this until it was mutated ──
  // `_noProgress` is the stall signal, and it is only a signal if it goes back DOWN. Its comment
  // said "consecutive" while the code never reset it — a lifetime counter wearing a consecutive
  // name, which only a log throttle read, so nothing noticed the lie. As the ETA's stall signal
  // that lie becomes a bug with teeth: a vault that hiccups twice (a sidecar restart) and then
  // works perfectly for hours would NEVER show an estimate again for the life of the process.
  // ⚠️ DELETING THE RESET LEFT ALL NINE GATES GREEN. E6b can't see it (a wedged counter is >= 2
  // either way) and every productive gate has noProgress === 0 throughout, so only the RECOVERY
  // path distinguishes them. The mutation found the hole; reading did not.
  wedge = false;                      // the sidecar comes back
  const recovered = await waitFor(() => (d2status()?.noProgress || 0) === 0 && pendingCount() === 0, 8000);
  const rowBack = await embedProjection(db, 'u');   // pending 0 ⇒ no row at all: the honest end state
  const sBack = d2status();
  rec('E6c. the stall CLEARS when work resumes — the signal resets, so the estimate can return',
    recovered && sBack.noProgress === 0 && embedEta(sBack, 100, false) !== null && rowBack === null,
    `noProgress back to ${sBack?.noProgress} (must be 0) · pending=${pendingCount()} (drained) · `
    + `eta(hypothetical 100 left)=${embedEta(sBack, 100, false)}s (must NOT be null — the vault works again) · `
    + `row=${rowBack === null ? 'none (backlog empty — correct)' : 'still rendering'}`);
  d.stop();
}

// ── E6d ⭐ A QUEUE THAT FAILS EVERY ROW IS STALLED TOO — the shape a proxy cannot see ──
// The first outcome signal keyed on the drainer's `_noProgress`, which increments only when
// `moved === 0` and `moved = embedded + failed + skipped`. So a queue that FAILS every row keeps
// moved > 0 and never registers as stalled — while the self-heal at the top of each cycle
// resurrects those `-1` rows, poisoning and resurrecting the same head forever. A reviewer drove
// it: 2,950 failed writes, 2,900 self-heals, noProgress AND embedErrs both 0, and the feed still
// rendering a frozen "~0s left" over a backlog that can never drain.
// `moved` answers "did something happen"; the ETA needs "did something EMBED". Different questions
// — and the precise one was already computed at the bank (`batchEmbedded > 0`).
// Here: a vector of the WRONG DIMENSION ⇒ service.js poisons the row (failed++, moved > 0) ⇒ the
// cycle's self-heal resurrects it ⇒ forever. Nothing embeds, ever.
{
  resumeEnrichProcessing();
  // ⚠️ 200 ROWS MUST EMBED FIRST. My first E6d failed every row from the start, so embeddedTotal
  // stayed 0 and `embedEta` returned null via the "nothing embedded yet" rule — the gate PASSED with
  // the broken proxy restored, i.e. it was measuring a different rule entirely. A stall gate needs a
  // vault that HAD a rate and then lost it; otherwise there is no estimate to withdraw.
  const { db } = makeDb(Array.from({ length: 400 }, (_, i) => `f${i}`));
  let poison = false;
  const badEmbed = {
    async health() { return { status: 'ok', loaded: true, dim: EMBED_DIM }; },
    async embed() {
      await sleep(1);
      return poison ? new Array(EMBED_DIM - 1).fill(0.01)   // wrong dim ⇒ FAILED (moved>0), not embedded
        : new Array(EMBED_DIM).fill(0.01);
    },
  };
  const d = startEnrichDrainer({
    db, userId: 'u', intervalMs: 40, embed: badEmbed, log: () => {},
    resolveLabelModel: async () => null, resolveEnrichModel: async () => null,
  });
  await waitFor(() => (d.status?.().embeddedTotal || 0) >= 200, 20_000);   // a real rate exists…
  poison = true;                                                           // …then every row starts failing
  const sawStall = await waitFor(() => (d.status?.().barrenPasses || 0) >= 2, 8000);
  const st = d.status();
  d.stop();
  // Assert on the SIGNAL, not the rendered row: a poisoned row sits at nlp_processed = -1 until the
  // next cycle's self-heal flips it back to 0, so `pending` OSCILLATES and a row-level sample here
  // is a coin toss (E6b already pins the rendered row, deterministically). What E6d must prove is
  // precise and timing-free: in the one shape the `moved` proxy cannot see, the signal fires and
  // the estimate withdraws.
  rec('E6d. every row FAILS (moved>0, embedded=0) ⇒ still a stall — the estimate withdraws',
    sawStall && st.embeddedTotal >= 200 && st.noProgress === 0 && st.embedErrs === 0
    && embedEta(st, 100, false) === null,
    `barrenPasses=${st?.barrenPasses} (>=2 — fires) · noProgress=${st?.noProgress} (0 — the PROXY IS BLIND HERE) · `
    + `embedErrs=${st?.embedErrs} (0 — nothing throws) · embeddedTotal=${st?.embeddedTotal} (>=200: a REAL rate existed, then was lost) · eta=${embedEta(st, 100, false)} (must be null)`);
}

// ── E6e ⭐ A SKIP IS PROGRESS — the estimate must survive a blank run ──
// The third proxy this signal has been. `barrenPasses` asked "did anything EMBED?", but the
// question is "IS `pending` SHRINKING?" — and a whitespace-only row shrinks it PERMANENTLY
// (nlp_processed = 1, terminal, never resurrected) while embedding nothing. So a blank run read as
// a stall and the ETA vanished WHILE THE BACKLOG DRAINED FASTER THAN IT EVER DOES EMBEDDING (a
// blank needs no inference): measured `pending` 722 -> 367 with the estimate blanked for 4/9
// samples. And `moved > 0` means the loop never breaks, so barren climbed unbounded — 8 in ~1.3s.
// ⚠️ NOTHING IN THIS FILE HAD EVER DRIVEN A BLANK ROW. The only mentions of skip/blank/trim were
// COMMENTS. The fixture omitted the state, so no gate could see the hole — the same shape as every
// round of this review.
// ⚠️ SAMPLED PER BATCH, NOT PER MILLISECOND. Blanks are INSTANT (no inference), so a 60ms sampler
// walks straight past the run and reports a comfortable max of 0 — my first draft did exactly that
// and "passed" while measuring nothing. The db stub sees every batch, so it cannot miss one.
{
  resumeEnrichProcessing();
  const { db, pendingCount } = makeDb(
    Array.from({ length: 300 }, (_, i) => `r${i}`),
    { blankIds: Array.from({ length: 400 }, (_, i) => `b${i}`) },
  );
  let dref = null;
  let maxBarren = 0;
  let nulls = 0;
  let samples = 0;
  const inner = db.messages.selectPendingEnrichment;
  db.messages.selectPendingEnrichment = async (...a) => {
    const st = dref?.status?.();
    if (st && (st.embeddedTotal || 0) > 0 && pendingCount() > 0) {
      maxBarren = Math.max(maxBarren, st.barrenPasses || 0);
      samples++;
      if (embedEta(st, pendingCount(), false) === null) nulls++;
    }
    return inner(...a);
  };
  const startPending = pendingCount();
  dref = startEnrichDrainer({
    db, userId: 'u', intervalMs: 60_000, embed: realEmbed(2), log: () => {},
    resolveLabelModel: async () => null, resolveEnrichModel: async () => null,
  });
  await waitFor(() => pendingCount() === 0, 20_000);
  dref.stop();
  rec('E6e. a BLANK RUN is progress — the estimate must not blink while pending drains fastest',
    samples > 8 && maxBarren < 2 && nulls === 0,
    `maxBarrenPasses=${maxBarren} (must stay <2 — a skip is NOT barren) · ${nulls}/${samples} batches with NO estimate (must be 0) · `
    + `pending drained ${startPending}->${pendingCount()} — every blank left the backlog PERMANENTLY while this ran`);
}

// ── E6f ⭐ A CYCLE THAT EMBEDS AND *THEN* THROWS IS NOT A STALL ──
// The FOURTH signal in this change to answer an adjacent question. `embedErrs` asks "did the cycle
// THROW?"; the ETA needs "is `pending` SHRINKING?". Its own reset sits AFTER the batch loop, so a
// cycle that embeds 200 rows and then throws never reaches it — the counter rose WITH progress.
// service.js's per-batch select can throw SQLITE_BUSY on batch 5 after batches 1-4 embedded, which
// this repo documents. Measured before the fix: a vault embedded its ENTIRE 3,000-row backlog
// (pending 2350 -> 0) with NO ESTIMATE for the whole run, while `barrenPasses` sat at 0 — the
// right signal knew, and lost the OR.
// E6f drives it, and E6g is the control that keeps the fix from being an erasure: a LOCKED vault
// throws before any batch banks, never reaches the reset, and must still withdraw.
{
  resumeEnrichProcessing();
  // 5,000 rows at 3ms/chunk ≈ 1.2s of drain — enough to sample ~10 times WHILE it works. At 1,500
  // it drained in ~200ms and the sampler only got 4 looks, which is too few to claim "never blank".
  const { db, pendingCount } = makeDb(Array.from({ length: 5000 }, (_, i) => `t${i}`));
  const inner = db.messages.selectPendingEnrichment;
  let calls = 0;
  db.messages.selectPendingEnrichment = async (...a) => {
    // Every 5th batch READ throws — after earlier batches in the same cycle already embedded.
    if (++calls % 5 === 0) throw new Error('SQLITE_BUSY: database is locked');
    return inner(...a);
  };
  const d = startEnrichDrainer({
    db, userId: 'u', intervalMs: 30, embed: realEmbed(3), log: () => {},
    resolveLabelModel: async () => null, resolveEnrichModel: async () => null,
  });
  await waitFor(() => (d.status?.().embeddedTotal || 0) >= 200, 20_000);
  let nulls = 0; let samples = 0; let maxErrs = 0;
  const startPending = pendingCount();
  for (let i = 0; i < 10 && pendingCount() > 0; i++) {
    const st = d.status();
    maxErrs = Math.max(maxErrs, st.embedErrs || 0);
    samples++;
    if (embedEta(st, pendingCount(), false) === null) nulls++;
    await sleep(50);
  }
  const st = d.status();
  d.stop();
  rec('E6f. a cycle that EMBEDS then throws keeps its estimate — progress outranks a throw',
    samples > 4 && nulls === 0 && st.barrenPasses === 0 && pendingCount() < startPending,
    `${nulls}/${samples} samples with NO estimate (must be 0) · maxEmbedErrs=${maxErrs} (rises, but a banked batch resets it) · `
    + `barrenPasses=${st.barrenPasses} (0 — the RIGHT signal knew it was progressing all along) · pending ${startPending}->${pendingCount()} (draining)`);
}

// ── E6g: …but a LOCKED vault still withdraws (the fix must not erase the signal) ──
// drainOnce throws at the TOP (service.js: "master key unavailable — vault locked, refusing to
// write"), so NO batch ever banks, so nothing resets embedErrs. Without this control, "reset it at
// the bank" could be quietly widened into "never fire".
{
  resumeEnrichProcessing();
  const { db } = makeDb(Array.from({ length: 100 }, (_, i) => `L${i}`));
  let lock = false;
  const inner2 = db.messages.selectPendingEnrichment;
  db.messages.selectPendingEnrichment = async (...a) => {
    if (lock) throw new Error('enrichment: master key unavailable — vault locked, refusing to write');
    return inner2(...a);
  };
  const d = startEnrichDrainer({
    db, userId: 'u', intervalMs: 30, embed: realEmbed(1), log: () => {},
    resolveLabelModel: async () => null, resolveEnrichModel: async () => null,
  });
  await waitFor(() => (d.status?.().embeddedTotal || 0) >= 25, 20_000);   // a rate exists…
  lock = true;                                                            // …then the vault locks
  const fired = await waitFor(() => (d.status?.().embedErrs || 0) >= 2, 8000);
  const st = d.status();
  d.stop();
  rec('E6g. a LOCKED vault (throws before any batch banks) STILL withdraws — the fix is not an erasure',
    fired && st.embeddedTotal >= 25 && embedEta(st, 100, false) === null,
    `embedErrs=${st?.embedErrs} (>=2 — still fires) · embeddedTotal=${st?.embeddedTotal} (a real rate existed) · eta=${embedEta(st, 100, false)} (must be null)`);
}

// ── E8 ⭐ THE ETA MUST SURVIVE A LONG CYCLE (the case R1 exists for) ──
// ⚠️ EVERY OTHER GATE HERE USES A SHORT CYCLE, AND THAT BLIND SPOT SHIPPED A HIGH. The drain loop
// runs up to 200 batches × batchSize 50 = 10,000 messages: at the design's cited ~40 msgs/min that
// is ~4.2 HOURS inside ONE cycle. When the counters were banked AFTER the loop, `lastProgressAt`
// only stamped at cycle END, so the 90s no-progress rule blanked the ETA for ~99% of a long import
// — R1 handing the 29-hour import back its unbounded spinner — while mid-cycle the frozen counters
// reported the PREVIOUS rate ("~1s left" with 8,402 pending). E4-E7 could not see either: their
// cycles finish in milliseconds.
// So: sample WHILE a single long cycle is still running.
{
  resumeEnrichProcessing();
  const { db } = makeDb(Array.from({ length: 6000 }, (_, i) => `L${i}`));
  const d = startEnrichDrainer({
    db, userId: 'u', intervalMs: 600_000, embed: realEmbed(5), log: () => {},   // ONE cycle, no second tick
    resolveLabelModel: async () => null, resolveEnrichModel: async () => null,
  });
  await waitFor(() => (d.status?.().embeddedTotal || 0) > 0, 10_000);   // counters move BEFORE the cycle ends
  const a = d.status();
  const etaA = embedEta(a, 3000, false);
  await sleep(700);
  const b2 = d.status();
  const etaB = embedEta(b2, 3000, false);
  const stillRunning = Boolean(b2.running);          // the SAME cycle is still in flight
  const advanced = b2.embeddedTotal > a.embeddedTotal;
  const progressFresh = Date.now() - Number(b2.lastProgressAt) < 90_000;
  d.stop();
  rec('E8. mid-cycle: the counters advance and the ETA stays alive during ONE long drain',
    stillRunning && advanced && etaA !== null && etaB !== null && progressFresh,
    `sameCycleStillRunning=${stillRunning} · embeddedTotal ${a.embeddedTotal}->${b2.embeddedTotal} (must advance MID-cycle) · `
    + `eta ${etaA}->${etaB}s (neither may be null) · lastProgressAt age=${Date.now() - Number(b2.lastProgressAt)}ms`);
}

const passed = ledger.filter(Boolean).length;
const failed = ledger.length - passed;
console.log('\n================================================================');
console.log(failed === 0
  ? 'VERDICT: GO — the embed ETA is measured from real throughput, honest when unknowable, and immune to idle time  EXIT=0'
  : 'VERDICT: NO-GO — see FAIL rows  EXIT=1');
console.log('================================================================');
process.exit(failed === 0 ? 0 : 1);
