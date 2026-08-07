#!/usr/bin/env node
// verify:embed-stall-bounce — D-131(b)+(c): a pause must IDLE the CPU, and a
// stalled head must stop burning it.
//
// The live-confirmed defect (QA, 2026-08-04, v0.1.17): embed-service.py pegged
// at 99.3% CPU with `processing.paused: true` — the pause flag stops the DRAINER
// from sending more work, but nothing could stop compute already running/queued
// inside the single-threaded Python service. And unpaused, a head of the queue
// that cannot embed was re-fed to the service every 15s forever: continuous burn,
// zero output (59,705/67,249 for 44s+, two cores pegged).
//
// The fix under test:
//   (c) pauseEmbed()/pauseEnrichProcessing() fire the SERVICE BOUNCER — the embed
//       supervisor SIGKILLs its own child (or its proven own-orphan on :8091;
//       foreign holders never touched) and respawns clean. Stateless service ⇒
//       nothing lost; DEFER re-selects.
//   (b) after STALL_BACKOFF_AFTER consecutive no-progress cycles the drain BACKS
//       OFF (skips 2,4,8… cycles, capped) instead of hammering the head, bouncing
//       the service once per episode. Row state untouched (the outage guard's
//       "never march a backlog to terminal" is preserved). Progress or nudge
//       resets instantly.
//
// Parts:
//   A. pause hook (module surface): pause fires the bouncer; unwired/throwing
//      bouncers never break a pause.
//   B. supervisor bounce: SIGKILL our child + clean 'bounced' restart (no crash
//      accounting); ANY adopted/no-child holder → REFUSED (round-1 review #2:
//      "never kill a service we merely adopted" applies to bounce too — a
//      hand-started service passes the own-orphan proof); kill-failure honest.
//   C. THE REAL DRAINER, in-cycle: a stalled head triggers exactly one bounce +
//      backoff (service traffic collapses), status() reports it, nudge drains
//      NOW, and real progress ends the episode.
//
// MUTATION-TESTED: (D-131c, 2026-08-04) fireEmbedServiceBounce('pause') removed
// from BOTH pauseEmbed and pauseEnrichProcessing (pause stops new sends but the
// service keeps its compute — the pre-fix behaviour QA watched live) → A1 and A2
// RED while A3/A4 and every B*/C* stay GREEN. Restored → GO.
// MUTATION-TESTED: (D-131b, 2026-08-04) the backoff-scheduling block removed from
// the no-progress break (the drain re-hammers the stalled head every cycle
// forever — the measured two-cores-pegged burn) → C1, C2 and C3 RED (no bounce
// fires, service traffic does not collapse, status never reports backoff) while
// C4/C5 and every A*/B* stay GREEN. Restored → GO.
// MUTATION-TESTED: (D-131c, 2026-08-04) the bounceExitExpected short-circuit
// removed from the supervisor's exit handler (a bounce kill is counted as a
// CRASH — failures++, backoff, eventual 'down'/halt) → B1c RED (health detail is
// the exit code, not 'bounced') while B1a/B1b stay GREEN. Restored → GO.
// MUTATION-TESTED: (D-131b, 2026-08-04) nudge()'s backoff reset removed (the
// operator's Retry/Resume is silently eaten by an active backoff — the
// honored-at-the-next-cycle bug shape) → C4 RED alone (a nudged cycle does not
// drain; C5 stays GREEN because the gate-scale backoff expires inside its wait
// window — at the production 15s tick the same mutation eats the Retry for
// minutes) while C1–C3 and every A*/B* stay GREEN. Restored → GO.
// ── Round-2 records (independent gate-integrity review, 2026-08-04: 8 of its 11
// author-blind mutations survived the original checks; the C1b/C2-pre/C6*/C8/
// B1d/B2b/B3-pre teeth below were added in response, and each survivor was then
// RE-RUN and watched RED): ─────────────────────────────────────────────────────
// MUTATION-TESTED: (review-2 M2, 2026-08-04) `_stallBackoffCycles -= 1` removed
// (backoff never expires — permanent skip wedge, drain dead until nudge) → C6a
// RED (no unaided re-probe) and C6b RED (maxSeen frozen at 2). Restored → GO.
// MUTATION-TESTED: (review-2 M3, 2026-08-04) the Math.min cap removed (unbounded
// 2**n) → C6c RED with maxSeen=64 observed past the 40 cap. Restored → GO.
// MUTATION-TESTED: (review-2 M11, 2026-08-04) schedule hardcoded to a constant 2
// (no exponential growth — a stalled head still probed every ~45s forever at the
// production tick) → C6b RED (maxSeen=2). Restored → GO.
// MUTATION-TESTED: (review-2 M4, 2026-08-04) the `_stallBounced` once-per-episode
// latch removed (SIGKILL-per-stalled-cycle kill loop) → C1b RED (bounces=3 at
// the window end) and C6d RED (bounces=6 across the deep episode). Restored → GO.
// MUTATION-TESTED: (review-2 M6, 2026-08-04) module-level bounceEmbedService()
// hardcoded to the no-supervisor fallback (the exact value B2 expects — the
// production server-rest wiring inert, D-131(c) dead in the shipped app) → B2b
// RED. Restored → GO.
// MUTATION-TESTED: (review-2 M9, 2026-08-04) `bounceExitExpected = false` removed
// from the exit handler (one bounce launders every later real crash as a bounce;
// the restart governor permanently disarmed) → B1d RED (the post-respawn
// UNEXPECTED exit still read detail='bounced'). Restored → GO.
// MUTATION-TESTED: (review-2 M8, 2026-08-04) pauseCategorize() also fires the
// bouncer (over-broad kill: an L1-only pause SIGKILLs the embedder mid-drain) →
// C8 RED. Restored → GO.
// EQUIVALENT-MUTANT RECORD (review-2 M5): dropping `embedStalledOut = true` from
// the backoff-skip branch is BEHAVIORALLY INERT for the categorize deferral —
// deferCategorizeForEmbed requires `progressing` (embedMoved > 0), and a skip
// cycle always has moved=0, so categorize is released either way. The line stays
// for the honesty of the per-cycle observation object; no tooth can distinguish
// the mutant because no behavior differs. Verified by reading deferCategorize-
// ForEmbed (drainer.js) — recorded here so a future reviewer does not re-derive it.
// MUTATION-TESTED: (re-review finding 1 — the HALF-mutant, 2026-08-04) ingest
// nudge zeroes `_stallBackoffCycles` but preserves `_stallBounced` (the
// CPU-hammer half of the storm with no SIGKILLs — C9 alone stays green) → C9b
// RED (drainsBefore=6 after=7: the nudge ran a hammer pass). ⚠️ The FIRST
// attempt at this tooth asserted the COUNTER survived — and the half-mutant
// PASSED it, because the re-run stalled drain immediately re-mints a LARGER
// counter; the honest observable is the drain-pass count (skip branch ⇒ no
// embedBatch traffic), which is what C9b now measures. Recorded so the failed
// tooth shape is not re-invented. Restored → GO.
// ── Round-3 records (independent correctness/security review, 2026-08-04 —
// DO-NOT-LAND round: 1 reproduced BLOCKER + adopted-kill doctrine + pause
// idempotency + kill-boolean; each fix's tooth run and watched RED): ──────────
// MUTATION-TESTED: (round-3 M1 — THE BLOCKER, 2026-08-04) handle.nudge reverted
// to unconditionally clearing the backoff + bounce latch (the reviewer's live
// repro: enqueueEnrichment nudges per chat/import save → 10 saves = 11 SIGKILLs
// of the embed service) → C9 RED with bounces=12 vs 2 — the storm reproduced
// INSIDE the gate. Restored → GO.
// MUTATION-TESTED: (round-3 M2, 2026-08-04) bounce()'s no-child branch restored
// to reaping via the own-orphan proof (kills a user's hand-started service —
// it passes the proof: script path + port + not-in-our-tree) → B3 RED (reap
// consulted, holder killed). Restored → GO.
// MUTATION-TESTED: (round-3 M3, 2026-08-04) pauseEmbed fires the bouncer
// unconditionally (double-clicked Pause SIGKILLs the respawning service again)
// → A5 and A5b RED. Restored → GO.
// MUTATION-TESTED: (round-3 M4, 2026-08-04) child.kill()'s boolean ignored
// (bounced:true reported for a signal never sent; a queued real-crash exit
// laundered as a bounce) → B4 and B4b RED. Restored → GO.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
// drainOnce fail-closes without a master key; seed a throwaway (wake-gate pattern).
process.env.ENCRYPTION_MASTER_KEY ||= crypto.randomBytes(32).toString('hex');
const {
  startEnrichDrainer, setEmbedServiceBouncer,
  pauseEmbed, resumeEmbed, pauseEnrichProcessing, resumeEnrichProcessing,
  pauseCategorize, resumeCategorize,
  STALL_BACKOFF_AFTER, STALL_BACKOFF_MAX_CYCLES,
} = await import('../src/enrich/drainer.js');
const { startEmbedSupervisor, getEmbedderHealth, _resetEmbedSupervisor, bounceEmbedService } = await import('../src/embed/supervisor.js');

const ledger = [];
let allPass = true;
function check(name, cond, detail = '') {
  const ok = !!cond;
  allPass = allPass && ok;
  ledger.push(`[${ok ? '✓' : '✗'}] ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, timeoutMs = 4000, stepMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await pred()) return true; await sleep(stepMs); }
  return Boolean(await pred());
}

let unhandled = 0;
process.on('unhandledRejection', () => { unhandled += 1; });

try {
  // ── Part A: the pause hook ─────────────────────────────────────────────────
  {
    const calls = [];
    setEmbedServiceBouncer((why) => { calls.push(why); return Promise.resolve({ bounced: true }); });
    pauseEmbed();
    check('A1 pauseEmbed() fires the service bouncer', calls.length === 1 && calls[0] === 'pause');
    resumeEmbed();
    pauseEnrichProcessing();
    check('A2 pauseEnrichProcessing() fires the service bouncer', calls.length === 2 && calls[1] === 'pause');
    resumeEnrichProcessing();

    setEmbedServiceBouncer(null);
    check('A3 unwired bouncer → pause still succeeds (fail-soft)', pauseEmbed() === true);
    resumeEmbed();

    setEmbedServiceBouncer(() => Promise.reject(new Error('bounce boom')));
    const ok = pauseEmbed();
    await sleep(30);
    check('A4 rejecting bouncer → pause unaffected, rejection swallowed', ok === true && unhandled === 0);
    resumeEmbed();
    setEmbedServiceBouncer(() => { throw new Error('sync boom'); });
    check('A4b throwing bouncer → pause unaffected', pauseEmbed() === true);
    resumeEmbed();
    // A5 (round-1 #4): bounce only on the false→true EDGE — a double-clicked
    // Pause (routes fire per POST) must not SIGKILL the respawning service again.
    {
      const edge = [];
      setEmbedServiceBouncer((why) => { edge.push(why); return Promise.resolve({ bounced: true }); });
      pauseEmbed(); pauseEmbed(); pauseEnrichProcessing();
      check('A5 repeated pause calls → exactly ONE bounce (edge-triggered)', edge.length === 1);
      resumeEnrichProcessing();
      pauseEmbed();
      check('A5b …and a fresh pause after resume fires again', edge.length === 2);
      resumeEmbed();
    }
    setEmbedServiceBouncer(null);
  }

  // ── Part B: the supervisor bounce ──────────────────────────────────────────
  const stubClient = (payloadOrThrow) => ({
    async health() {
      if (payloadOrThrow instanceof Error) throw payloadOrThrow;
      return payloadOrThrow;
    },
  });
  // B1: our spawned child — SIGKILL + clean 'bounced' restart, no crash accounting.
  {
    _resetEmbedSupervisor();
    const kills = [];
    let serviceChild = null;
    const spawn = (_bin, args) => {
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = (sig) => { kills.push(sig); return true; }; // real ChildProcess.kill returns a boolean
      if (args[0] === '-c') { child.pid = 4242; setImmediate(() => child.emit('close', 0)); }
      else { child.pid = 5001; serviceChild = child; }
      return child;
    };
    const sup = startEmbedSupervisor({ embed: stubClient(new Error('unreachable')), spawn, pythonBin: '/usr/bin/python3' });
    await waitFor(() => serviceChild !== null);
    const r = await sup.bounce('gate-test');
    check('B1a bounce with our live child → SIGKILL + {bounced, how:child}',
      r?.bounced === true && r?.how === 'child' && kills.includes('SIGKILL'));
    serviceChild.emit('exit', null); // the kill lands
    await sleep(20);
    const h = getEmbedderHealth();
    check('B1b bounced exit → restarting, never a crash', h?.status === 'starting');
    check('B1c …and the health detail says WHY (bounced, not an exit code)', h?.detail === 'bounced');
    // B1d (review-2 M9): the expected-bounce latch is ONE-SHOT. After the bounced
    // exit consumed it, the NEXT unexpected exit must be classified as a CRASH
    // (crash accounting re-armed) — a latch that never clears would launder every
    // later real crash as a bounce, permanently disarming the restart governor.
    // The supervisor's 3s tick respawns the service first (client unreachable →
    // tryStart), so this costs one ~3.5s wait.
    const firstChild = serviceChild;
    const respawned = await waitFor(() => serviceChild !== null && serviceChild !== firstChild, 6000, 50);
    serviceChild.emit('exit', 1); // UNEXPECTED exit — no bounce() call preceded it
    await sleep(20);
    const h2 = getEmbedderHealth();
    check('B1d a later UNEXPECTED exit is a crash again (latch is one-shot)',
      respawned && h2?.detail !== 'bounced', `respawned=${respawned} detail=${h2?.detail}`);
    sup.stop();
    _resetEmbedSupervisor();
  }
  // B2: no supervisor at all → honest no-op.
  {
    _resetEmbedSupervisor();
    const r = await bounceEmbedService('gate-test');
    check('B2 no supervisor → {bounced:false, no-supervisor}', r?.bounced === false && r?.reason === 'no-supervisor');
  }
  // B2b (review-2 M6): the PRODUCTION seam — the module-level bounceEmbedService()
  // must DELEGATE to the live instance. server-rest wires exactly this function
  // into the drainer; a hardcoded fallback would leave D-131(c) dead in the
  // shipped app while B2 (which expects the no-instance value) stayed green.
  {
    _resetEmbedSupervisor();
    const kills = [];
    let serviceChild = null;
    const spawn = (_bin, args) => {
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = (sig) => { kills.push(sig); return true; }; // real ChildProcess.kill returns a boolean
      if (args[0] === '-c') { child.pid = 4242; setImmediate(() => child.emit('close', 0)); }
      else { child.pid = 5002; serviceChild = child; }
      return child;
    };
    const sup = startEmbedSupervisor({ embed: stubClient(new Error('unreachable')), spawn, pythonBin: '/usr/bin/python3' });
    await waitFor(() => serviceChild !== null);
    const r = await bounceEmbedService('gate-test');
    check('B2b live supervisor → module bounceEmbedService() delegates to the real bounce',
      r?.bounced === true && r?.how === 'child' && kills.includes('SIGKILL'));
    sup.stop();
    _resetEmbedSupervisor();
  }
  // B3: an ADOPTED service is REFUSED — never killed (round-1 #2). The
  // supervisor's doctrine ("never kill a service we merely adopted", honored by
  // stop()) applies to bounce() too: with no live child of ours, the :8091
  // holder may be the user's own hand-started service. The reap helper must not
  // even be consulted.
  {
    _resetEmbedSupervisor();
    const reaps = [];
    let spawnAttempts = 0;
    const reapOrphan = async (o) => { reaps.push(o); return { reaped: true, pid: 999 }; };
    const sup = startEmbedSupervisor({ embed: stubClient({ status: 'ok', loaded: true, dim: 768 }), spawn: () => { spawnAttempts += 1; throw new Error('must not spawn'); }, pythonBin: '/usr/bin/python3', reapOrphan });
    await sleep(30); // adopt tick — healthy :8091, no child spawned
    check('B3-pre adoption happened (zero spawn attempts) — the precondition is pinned', spawnAttempts === 0);
    const r = await sup.bounce('gate-test');
    check('B3 adopted service → bounce REFUSED, reap never consulted',
      r?.bounced === false && r?.reason === 'adopted' && reaps.length === 0);
    sup.stop();
    _resetEmbedSupervisor();
  }
  // B4 (round-1 #5): child.kill() reports failure by RETURNING false — a bounce
  // whose signal was not sent must say kill-failed and clear the latch so the
  // (possibly already-queued) real-crash exit is classified honestly.
  {
    _resetEmbedSupervisor();
    let serviceChild = null;
    const spawn = (_bin, args) => {
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => false; // already-exited child: signal not deliverable
      if (args[0] === '-c') { child.pid = 4242; setImmediate(() => child.emit('close', 0)); }
      else { child.pid = 5003; serviceChild = child; }
      return child;
    };
    const sup = startEmbedSupervisor({ embed: stubClient(new Error('unreachable')), spawn, pythonBin: '/usr/bin/python3' });
    await waitFor(() => serviceChild !== null);
    const r = await sup.bounce('gate-test');
    check('B4 undeliverable SIGKILL → honest {bounced:false, kill-failed}', r?.bounced === false && r?.reason === 'kill-failed');
    serviceChild.emit('exit', 1); // the real exit lands AFTER the failed bounce
    await sleep(20);
    check('B4b …and the latch was cleared: that exit is a CRASH, not a bounce', getEmbedderHealth()?.detail !== 'bounced');
    sup.stop();
    _resetEmbedSupervisor();
  }

  // ── Part C: the real drainer — stall → one bounce + backoff ────────────────
  {
    const rows = new Map(['a', 'b', 'c', 'd', 'e'].map((id) => [id, { id, content: `row ${id} with words`, nlp_processed: 0 }]));
    const st = { batchCalls: 0, vectors: false };
    const embed = {
      async health() { return { status: 'ok', loaded: true, dim: 768 }; },
      async embedBatch(texts) { st.batchCalls += 1; return texts.map(() => (st.vectors ? Array.from({ length: 768 }, () => 0.1) : null)); },
      async embed() { return st.vectors ? Array.from({ length: 768 }, () => 0.1) : null; },
    };
    const db = {
      users: { getSettings: async () => ({}) }, // no approved models → L1/L2 honestly idle
      async rawQuery() { return { rows: [], results: [] }; },
      messages: {
        async selectPendingEnrichment(_u, { limit = 50 } = {}) {
          return [...rows.values()].filter((r) => r.nlp_processed === 0).slice(0, limit);
        },
        async updateEnrichment(id, _u, patch) {
          const r = rows.get(id);
          if (r && patch.nlpProcessed !== undefined) r.nlp_processed = patch.nlpProcessed;
        },
        async selectPendingNlp() { return []; },
        async updateNlp() {},
        async selectPendingCategories() { return []; },
        async updateCategories() {},
      },
    };
    const bounces = [];
    setEmbedServiceBouncer((why) => { bounces.push(why); return Promise.resolve({ bounced: true }); });

    const d = startEnrichDrainer({ db, userId: 'u', intervalMs: 40, embed, log: () => {} });

    // C1: the stalled head triggers exactly ONE bounce per episode.
    const gotBounce = await waitFor(() => bounces.length >= 1, 5000);
    check('C1 stalled head → the service is bounced once (reason: stalled-head)',
      gotBounce && bounces[0] === 'stalled-head' && bounces.length === 1,
      `bounces=${JSON.stringify(bounces)}`);

    // C2: backoff collapses service traffic — cycles keep ticking, drains do not.
    // Positive precondition first (review-2 vacuousness #1 — the M-001 shape): the
    // pre-backoff phase must have actually drained ≥ STALL_BACKOFF_AFTER times, or
    // "collapse" is indistinguishable from a dead drainer.
    const b0 = st.batchCalls;
    check('C2-pre the drain RAN before backing off (≥3 hammer passes measured)', b0 >= STALL_BACKOFF_AFTER);
    await sleep(450); // ~11 ticks at 40ms
    const drainsDuringBackoff = st.batchCalls - b0;
    check('C2 backoff: service traffic collapses (≤4 drains in ~11 cycles, was 1/cycle)',
      drainsDuringBackoff <= 4, `drains=${drainsDuringBackoff}`);
    // C1b (review-2 M4): once per EPISODE means still exactly one at the END of the
    // window, while still stalled — C1's waitFor samples within ~20ms of the first
    // fire and cannot see a per-cycle re-fire on its own.
    check('C1b …and still exactly ONE bounce at the end of the stalled window', bounces.length === 1, `bounces=${bounces.length}`);

    // C3: the backoff is REPORTED, never a silent skip.
    const reported = await waitFor(() => (d.status()?.embedStallBackoffCycles ?? 0) > 0, 3000);
    check('C3 status() reports embedStallBackoffCycles > 0 during the episode', reported);

    // C4: a DELIBERATE nudge (Resume/Retry — clearStallBackoff) drains NOW —
    // never eaten by the backoff. waitFor guards the single-flight collision
    // (a nudge landing during an in-flight interval cycle returns undefined).
    const b1 = st.batchCalls;
    await d.nudge({ clearStallBackoff: true });
    const c4ok = await waitFor(() => st.batchCalls > b1, 2000);
    check('C4 deliberate nudge during backoff → the drain runs now', c4ok);

    // C9 (round-1 BLOCKER, reproduced there as 10 saves → 11 SIGKILLs): INGEST
    // nudges — enqueueEnrichment fires one per chat/import save — must NEVER
    // clear the backoff or re-arm the bounce. Re-enter a stalled backoff first
    // (the C4 clear reset the episode), then hammer default nudges.
    await waitFor(() => (d.status()?.embedStallBackoffCycles ?? 0) > 0, 5000);
    const bouncesBeforeStorm = bounces.length;
    // C9b (re-review finding 1 — the half-mutant): an ingest nudge during
    // backoff must take the SKIP branch — it must not run a drain pass. The
    // counter alone is NOT the observable (first attempt at this tooth failed:
    // a mutant that zeroes the counter re-runs the stalled drain, which
    // immediately re-mints a LARGER counter — the comparison passed while the
    // CPU-hammer half of the storm was live). The drain-pass count is the
    // honest signal: skip ⇒ no embedBatch traffic.
    const b9 = await waitFor(() => (d.status()?.embedStallBackoffCycles ?? 0) > 2, 5000);
    const drainsBeforeNudge = st.batchCalls;
    await d.nudge(); // ONE ingest nudge — must hit the skip branch
    const drainsAfterNudge = st.batchCalls;
    check('C9b one ingest nudge during backoff → NO drain pass runs (skip branch taken)',
      b9 && drainsAfterNudge === drainsBeforeNudge,
      `deep=${b9} drainsBefore=${drainsBeforeNudge} after=${drainsAfterNudge}`);
    for (let i = 0; i < 10; i++) { await d.nudge(); await sleep(5); }
    await sleep(200);
    check('C9 ten ingest nudges while stalled → ZERO additional bounces (no kill storm)',
      bounces.length === bouncesBeforeStorm, `bounces=${bounces.length} before=${bouncesBeforeStorm}`);

    // C5: real progress ends the episode and the rows land.
    st.vectors = true;
    const bouncesBeforeProgress = bounces.length;
    await d.nudge({ clearStallBackoff: true });
    const settled = await waitFor(() => [...rows.values()].every((r) => r.nlp_processed === 2), 3000);
    const s = d.status();
    check('C5 progress → all rows embedded, backoff cleared, stall counters reset',
      settled && (s?.embedStallBackoffCycles ?? 1) === 0 && (s?.noProgress ?? 1) === 0);
    await sleep(150);
    check('C5b …and no further bounce after progress', bounces.length === bouncesBeforeProgress);

    d.stop();
    setEmbedServiceBouncer(null);
  }

  // ── Part C6: the episode LIFECYCLE — expiry, growth, cap, one bounce ───────
  // (review-2 holes M2/M3/M11/M4: the previous checks proved backoff ENTRY but
  // never that it EXPIRES unaided, GROWS exponentially, or CAPS.) Asserted
  // against the exported constants — the schedule is the contract.
  {
    const rows = new Map(['p', 'q', 'r'].map((id) => [id, { id, content: `row ${id} with words`, nlp_processed: 0 }]));
    const st = { batchCalls: 0 };
    const embed = {
      async health() { return { status: 'ok', loaded: true, dim: 768 }; },
      async embedBatch(texts) { st.batchCalls += 1; return texts.map(() => null); },
      async embed() { return null; },
    };
    const db = {
      users: { getSettings: async () => ({}) },
      async rawQuery() { return { rows: [], results: [] }; },
      messages: {
        async selectPendingEnrichment(_u, { limit = 50 } = {}) { return [...rows.values()].filter((r) => r.nlp_processed === 0).slice(0, limit); },
        async updateEnrichment() {},
        async selectPendingNlp() { return []; },
        async updateNlp() {},
        async selectPendingCategories() { return []; },
        async updateCategories() {},
      },
    };
    const bounces = [];
    setEmbedServiceBouncer((why) => { bounces.push(why); return Promise.resolve({ bounced: true }); });
    const d = startEnrichDrainer({ db, userId: 'u', intervalMs: 20, embed, log: () => {} });

    // Sample the reported backoff continuously; track every distinct value seen.
    const samples = new Set();
    const sampler = setInterval(() => {
      const v = d.status()?.embedStallBackoffCycles ?? 0;
      if (v > 0) samples.add(v);
    }, 5);

    // C6a (kills M2): the backoff EXPIRES UNAIDED — after entering backoff the
    // drain probes again with NO nudge. Wait for entry, then for more drains.
    await waitFor(() => samples.size > 0, 5000);
    const drainsAtEntry = st.batchCalls;
    const resumed = await waitFor(() => st.batchCalls > drainsAtEntry, 5000);
    check('C6a the backoff expires on its own — the drain re-probes with NO nudge', resumed);

    // C6b/C6c (kill M11/M3): run deep into the episode — the schedule must GROW
    // beyond its first step and must CLAMP at STALL_BACKOFF_MAX_CYCLES. At 20ms
    // ticks the 6th entry (2+4+8+16+32 skip cycles + drains) lands well inside
    // this window; an uncapped schedule would surface 2*STALL_BACKOFF_MAX-ish
    // values here.
    await waitFor(() => Math.max(0, ...samples) >= Math.min(32, STALL_BACKOFF_MAX_CYCLES), 15000);
    await sleep(1500); // room for the NEXT entry — where an uncapped 64 would appear
    clearInterval(sampler);
    const maxSeen = Math.max(0, ...samples);
    check('C6b the backoff GROWS exponentially (≥32 observed, not a constant first step)', maxSeen >= 32, `maxSeen=${maxSeen} samples=${[...samples].join(',')}`);
    check('C6c …and CLAMPS at STALL_BACKOFF_MAX_CYCLES', maxSeen <= STALL_BACKOFF_MAX_CYCLES, `maxSeen=${maxSeen}`);
    // C6d (kills M4): one continuous stall = ONE episode = ONE bounce, however deep.
    check('C6d one bounce for the whole continuous episode', bounces.length === 1, `bounces=${bounces.length}`);
    d.stop();
    setEmbedServiceBouncer(null);
  }

  // C8 (review-2 M8, negative space): a categorize-only pause must NOT bounce the
  // embed service — L1 runs on Ollama; killing the embedder for it is over-broad.
  {
    const calls = [];
    setEmbedServiceBouncer((why) => { calls.push(why); return Promise.resolve({ bounced: true }); });
    pauseCategorize();
    check('C8 pauseCategorize() fires NO embed-service bounce', calls.length === 0);
    resumeCategorize();
    setEmbedServiceBouncer(null);
  }

  check('A4-final no unhandled rejections leaked from any bounce path', unhandled === 0);
} catch (e) {
  check(`fatal: ${e?.message || e}`, false);
}

console.log(ledger.join('\n'));
console.log('='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO' : 'NO-GO'}  EXIT=${allPass ? 0 : 1}`);
process.exit(allPass ? 0 : 1);
