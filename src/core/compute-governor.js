// src/core/compute-governor.js — the ONE global heavy-compute broker (D-001, third attempt).
// Design: docs/COMPUTE-GOVERNOR-DESIGN-2026-07-23.md. Sprint: QA7 U1.
//
// ════════════════════════════════════════════════════════════════════════════════════════
//  WHY THIS EXISTS — and the ONE invariant you must not "optimize" away
// ════════════════════════════════════════════════════════════════════════════════════════
// D-001 crashed the operator's machine TWICE (v0.1.10, v0.1.12). Root cause: the app had FOUR
// independent single-flight latches (src/jobs.js runningJobId / chronicleChildRunning /
// namingChildRunning / narrationRunning) that each stop a lane from doubling up on ITSELF and
// consult NONE of the others, plus an ONNX embed drainer that consults none of them. So an
// embedding drain + an Ollama describe pass + a categorize pass could all run flat out against
// the same box → RAM exhaustion → macOS hang. This is the cross-lane admission control that
// was missing. It is NOT a fifth latch.
//
//   RESIDENT-MODEL capacity is 1, PERMANENTLY, and here is why it can never be "2 on a big box":
//   `OLLAMA_MAX_LOADED_MODELS=1` is the daemon's contract ONLY on the spawn path
//   (ollama-daemon.js:143 OLLAMA_SPAWN_CAPS). An ADOPTED user Ollama (Homebrew / Ollama.app —
//   most developer machines) returns from start() BEFORE those caps apply (ollama-daemon.js:416),
//   so it is COMPLETELY UNCAPPED — no MAX_LOADED_MODELS, no NUM_PARALLEL. On such a box the
//   governor holding RESIDENT at 1 is the ONLY thing preventing two resident models loading at
//   once (design §3.8, P9). Two RESIDENT tickets is what an OOM looks like. If you raise
//   RESIDENT_MAX to 2, you reopen D-001 on every machine that already had Ollama installed. The
//   gate verify:compute-lanes C1+C9 exist to RED exactly that mutation.
//
// ════════════════════════════════════════════════════════════════════════════════════════
//  THREE ADMISSION CLASSES (design §3.2) — the asymmetry is the whole point
// ════════════════════════════════════════════════════════════════════════════════════════
//   RESIDENT    — model weights that do NOT share. A COUNT gate at 1. (categorize/enrich,
//                 describe-chronicles, describe-clusters, clustering, claim-discovery, chat,
//                 narration walk, vision …)
//   BULK        — compute that degrades gracefully under memory pressure. A SUM gate on a GB
//                 budget, hard cap 2. (embed ONNX drain, clustering-metrics, backfill, whisper,
//                 doc-extract worker, search-index rebuild, integrity scan, backlog scans …)
//   INTERACTIVE — a PRIORITY, not an exemption (§3.4). A chat/channel turn PREEMPTS a background
//                 RESIDENT holder (sets its yield flag) and, if the holder does not yield, is
//                 refused with a retry rather than granted a second concurrent model — killing a
//                 mid-write describe pass corrupts a chronicle.
//
// ════════════════════════════════════════════════════════════════════════════════════════
//  CRASH RELEASE (design §3.5) — a leaked ticket wedging the app is WORSE than the crash
// ════════════════════════════════════════════════════════════════════════════════════════
//   1. `finally` release          — convention; insufficient alone.
//   2. child-process binding      — the ticket binds the ChildProcess's `close` AND `error`
//                                   (first wins; node does not guarantee close after error —
//                                   jobs.js:206-209 documents this trap).
//   3. lease TTL + heartbeat      — a ticket that neither releases nor heartbeats past its lease
//                                   is reclaimed with a loud, content-free log + a
//                                   readiness-visible counter (reclamation is the only path that
//                                   can double-admit, so it is never silent).
//
// Fail-closed elsewhere in this vault means "refuse"; here the governor's OWN failure modes fail
// TOWARD ADMIT (a broken memory probe, a lease we cannot arm), because a governor that refuses on
// its own bug is the dead-pipeline bug (design §3.6). What NEVER fails open is RESIDENT_MAX.
//
// Deliberately in-process, dependency-light, and a process-wide singleton — exactly like
// src/core/delete-lane.js, and for the same reason: V1 is single-user, single-process. It
// CANNOT gate a second OS process (packages/channel-daemon, L13) — that is the largest
// documented residual (design §5); see docs/COMPUTE-GOVERNOR-DESIGN §5/§6 and the PR.

import { AsyncLocalStorage } from 'node:async_hooks';
import { memoryPressure, PRESSURE } from './memory-pressure.js';

export const CLASS = Object.freeze({ RESIDENT: 'resident', BULK: 'bulk', INTERACTIVE: 'interactive' });

// ── Tunables (env-overridable ONLY for tests/ops; the defaults are the contract) ────────────
const RESIDENT_MAX = 1;                                   // ⛔ SEE HEADER — never raise this.
const BULK_MAX = Number(process.env.MYCELIUM_GOV_BULK_MAX) || 2;
const DEFAULT_RESERVE_GB = Number(process.env.MYCELIUM_GOV_RESERVE_GB) || 4;
const AGING_THRESHOLD = Number(process.env.MYCELIUM_GOV_AGING) || 20;   // refusals before a DEFER lane is promoted over INTERACTIVE
const YIELD_MS = Number(process.env.MYCELIUM_GOV_YIELD_MS) || 2000;
const UNLOAD_DEBOUNCE_MS = Number(process.env.MYCELIUM_GOV_UNLOAD_MS) || 30000;
const HW_TTL_MS = 60000;                                  // re-read hardware budget every 60s (§3.1)
const PRESSURE_TTL_MS = Number(process.env.MYCELIUM_GOV_PRESSURE_TTL_MS) || 2000; // cache the probe so admit() stays cheap+sync
const EVENT_RING = 200;                                   // bounded observability ring
const RESIDENT_QUEUE_MAX = Number(process.env.MYCELIUM_GOV_QUEUE_MAX) || 4; // §3.3 bounded FIFO depth for QUEUE lanes

// ── Process-wide state ──────────────────────────────────────────────────────────────────────
let _seq = 0;
const _tickets = new Map();          // ticketId → ticket record
const _laneRefusals = new Map();     // laneId → consecutive refusal count (aging floor input)
const _residentQueue = [];           // §3.3 QUEUE lanes waiting for the resident slot: { lane, fn }
const _events = [];                  // bounded ring of admit/refuse/queue/preempt/reclaim
const _counters = {
  admitted: 0, refused: 0, preempted: 0, reclaimed: 0, released: 0, unloads: 0, agedPromotions: 0,
};
let _budgetGb = null;                 // cached hardware budget
let _budgetAt = 0;
let _pressureCache = null;            // cached memory-pressure reading
let _pressureAt = 0;
let _unloadTimer = null;

// AsyncLocalStorage: which ticket the current async context already holds. The PRIMARY guarantee
// against a priority-inversion cycle is structural — RESIDENT capacity is 1, so there is no
// hold-and-wait cycle to form. This guard is DEFENSE IN DEPTH (CLAUDE.md §2): it FORBIDS a lane
// that wraps its held region in withTicket() from admitting a DIFFERENT class inside it, catching a
// future refactor that raises capacity or nests admissions. It is ACTIVE only for lanes that opt in
// via withTicket(); a lane that admits/releases without withTicket is guarded by the structural
// bound alone. (Reviewer finding: this is scaffolding until lanes adopt withTicket — the claim is
// "available + activated on opt-in", not "enforced on every admission".)
const _als = new AsyncLocalStorage();

// Injectable seams (tests + the unload path). Kept module-private; production uses the defaults.
let _hardwareProbe = null;           // async () => { totalRamGb, unifiedMemory, ... } | null
let _memProbe = memoryPressure;      // () => { level, signal, detail }
let _unloadFn = null;                // async ({ baseUrl }) => void  (POST keep_alive:0)
let _now = () => Date.now();
let _log = (m) => { try { process.stderr.write(`${m}\n`); } catch { /* noop */ } };

function pushEvent(kind, rec) {
  _events.push({ t: _now(), kind, ...rec });
  if (_events.length > EVENT_RING) _events.splice(0, _events.length - EVENT_RING);
}

// ── Capacity (design §3.1) ──────────────────────────────────────────────────────────────────
// budget = min(totalRam × unifiedFrac, totalRam − reserveGb). Read at boot + on a 60s TTL.
// detectHardware() is async; admit() is sync, so we cache the last computed budget and refresh
// it opportunistically (a stale-by-60s budget is fine — it only bounds BULK sum-admission, and
// memory backpressure is the real-time signal). Until the first async refresh lands we fall
// back to a conservative constant so BULK is never UNBOUNDED on a cold start.
const COLD_BUDGET_GB = 8;

export function _setHardwareProbe(fn) { _hardwareProbe = fn; _budgetAt = 0; _budgetGb = null; }
function refreshBudget() {
  // Fire-and-forget async refresh; admit() reads whatever is cached.
  const probe = _hardwareProbe;
  if (!probe) return;
  Promise.resolve()
    .then(() => probe())
    .then((hw) => {
      if (!hw || !(hw.totalRamGb > 0)) return;
      const unifiedFrac = hw.unifiedMemory ? (hw.gpuVramGb && hw.totalRamGb ? hw.gpuVramGb / hw.totalRamGb : 0.7) : 1;
      const byFrac = hw.totalRamGb * unifiedFrac;
      const byReserve = hw.totalRamGb - DEFAULT_RESERVE_GB;
      _budgetGb = Math.max(1, Math.min(byFrac, byReserve));
      _budgetAt = _now();
    })
    .catch(() => { /* fail-open: keep the cold/last budget */ });
}
function budgetGb() {
  if (_budgetGb == null || _now() - _budgetAt > HW_TTL_MS) refreshBudget();
  return _budgetGb == null ? COLD_BUDGET_GB : _budgetGb;
}

function pressure() {
  if (_pressureCache == null || _now() - _pressureAt > PRESSURE_TTL_MS) {
    try { _pressureCache = _memProbe(); } catch { _pressureCache = { level: PRESSURE.OK, signal: 'probe-threw', detail: {} }; }
    _pressureAt = _now();
  }
  return _pressureCache;
}

// The single MODEL slot is occupied by EITHER a RESIDENT or an INTERACTIVE ticket — both load
// model weights that do not share, so both count against RESIDENT_MAX (an interactive chat turn
// and a background describe pass cannot both hold a model at once; that is the OOM).
const holdsSlot = (t) => t.klass === CLASS.RESIDENT || t.klass === CLASS.INTERACTIVE;
function residentCount() { let n = 0; for (const t of _tickets.values()) if (holdsSlot(t)) n++; return n; }
function bulkStats() { let n = 0, gb = 0; for (const t of _tickets.values()) if (t.klass === CLASS.BULK) { n++; gb += t.estimateGb || 0; } return { n, gb }; }
function residentHolder() { for (const t of _tickets.values()) if (holdsSlot(t)) return t; return null; }
function agedBackgroundExists() {
  // Only a PLAIN-RESIDENT (background) lane is ever promoted over interactive — an interactive
  // lane that keeps losing must not promote ITSELF over interactive.
  for (const [lane, r] of _laneRefusals) if (r >= AGING_THRESHOLD && _laneClass.get(lane) === CLASS.RESIDENT) return lane;
  return null;
}
const _laneClass = new Map(); // laneId → the ACTUAL requested class (resident|bulk|interactive)

function bumpRefusal(lane) { _laneRefusals.set(lane, (_laneRefusals.get(lane) || 0) + 1); }
function clearRefusal(lane) { if (_laneRefusals.has(lane)) _laneRefusals.set(lane, 0); }

// ── Lease reclaim (design §3.5.3) ───────────────────────────────────────────────────────────
function childStillRunning(ticket) {
  // A bound ChildProcess that has NOT exited: exitCode and signalCode are both null until it
  // exits (or is signalled). A running child is proof the lane is live — never reclaim it.
  const c = ticket.child;
  return !!(c && typeof c === 'object' && c.exitCode == null && c.signalCode == null);
}

function armLease(ticket) {
  if (!(ticket.timeoutMs > 0)) return; // no lease requested → only finally + child binding guard it
  const rearm = () => { ticket.leaseTimer = setTimeout(fire, ticket.timeoutMs); if (ticket.leaseTimer.unref) ticket.leaseTimer.unref(); };
  const fire = () => {
    if (!_tickets.has(ticket.id)) return;         // already released
    // ⚠️ NEVER reclaim a lane whose bound child is STILL RUNNING (review finding #3). A
    // describe-chronicles gap-fill over many territories can exceed a fixed lease while the child
    // is very much alive; reclaiming it would reopen the slot, let categorize admit a SECOND Ollama
    // model, and cause the exact crash this governor exists to prevent — a self-inflicted double
    // admit. The child-binding (close/error → doRelease) is the real release for a bound lane; the
    // lease is only a backstop for a ticket that has NO live child (an in-process lane that leaked,
    // or a child that exited without emitting close). A truly-hung child is bounded by the job's own
    // MAX_MS SIGKILL (jobs.js), which then fires close → release. So: while the child runs, re-arm.
    if (childStillRunning(ticket)) { rearm(); return; }
    if (_now() - ticket.lastBeatAt < ticket.timeoutMs) { rearm(); return; } // heartbeated → re-arm
    // Reclaim. This is the ONLY path that can momentarily double-admit, so it is LOUD and counted.
    _counters.reclaimed++;
    pushEvent('reclaim', { lane: ticket.lane, klass: ticket.klass, ticketId: ticket.id, ageMs: _now() - ticket.admittedAt });
    _log(`[governor] LEASE RECLAIM lane=${ticket.lane} class=${ticket.klass} — held ${_now() - ticket.admittedAt}ms with no release/heartbeat past its ${ticket.timeoutMs}ms lease and no live child. Reclaimed (a leaked ticket must never wedge the app).`);
    doRelease(ticket.id, 'lease-reclaim');
  };
  rearm();
}

// ── Child-process binding (design §3.5.2) ───────────────────────────────────────────────────
function bindChild(ticket, child) {
  if (!child || typeof child.on !== 'function') return;
  ticket.child = child;
  // FIRST wins. Node documents 'close' as "may or may not" fire after 'error' (child_process
  // docs), so we cannot delegate one to the other — bind both, release on whichever arrives.
  const onEnd = () => doRelease(ticket.id, 'child-exit');
  child.once('close', onEnd);
  child.once('error', onEnd);
}

function doRelease(ticketId, cause) {
  const t = _tickets.get(ticketId);
  if (!t) return; // idempotent — a double-release / close-after-reclaim must not free someone else's ticket
  _tickets.delete(ticketId);
  if (t.leaseTimer) { clearTimeout(t.leaseTimer); t.leaseTimer = null; }
  _counters.released++;
  pushEvent('release', { lane: t.lane, klass: t.klass, ticketId: t.id, cause });
  // §3.7 explicit unload: on the last RESIDENT release with an empty queue, evict the model. This
  // is the only reliable eviction on an ADOPTED daemon (OLLAMA_KEEP_ALIVE is a timer, not an
  // unload, and does not apply to a daemon we did not spawn). Debounced so a burst-gap does not
  // thrash reload latency. ⚠️ Whether POST /api/generate {keep_alive:0} reliably evicts on the
  // pinned Ollama version is UNVERIFIED (design §6) — this is best-effort and never blocks.
  if (holdsSlot(t) && residentCount() === 0) scheduleUnload(t.unloadBaseUrl);
  // §3.3 QUEUE: a user-initiated lane (clustering/Generate) that was refused waits here for the
  // slot to free rather than being dropped. Draining a freed slot to a waiter is what makes a
  // refused Generate EVENTUALLY RUN — the D-004 map-rebuild control must complete, not silently
  // die (round-3 review). Only fires when a slot actually opened.
  if (holdsSlot(t)) drainResidentQueue();
}

/**
 * QUEUE a waiter for the single resident slot (design §3.3 — for user-initiated lanes that MUST
 * eventually run, e.g. clustering/Generate). Coalesces by lane id (a 2nd Generate coalesces onto the
 * queued one, exactly as runningJobId does today) and is bounded (depth RESIDENT_QUEUE_MAX). `fn` is
 * invoked when the slot next frees; it should re-attempt admit() and, on success, start the work —
 * or re-queue itself if it is still refused (e.g. by memory pressure). Returns { queued, ... }.
 */
export function queueForResident(lane, fn) {
  if (!lane || typeof lane !== 'string') throw new TypeError('queueForResident: lane (string) required');
  if (typeof fn !== 'function') throw new TypeError('queueForResident: fn (function) required');
  if (_residentQueue.some((w) => w.lane === lane)) return { queued: true, coalesced: true, depth: _residentQueue.length };
  if (_residentQueue.length >= RESIDENT_QUEUE_MAX) return { queued: false, reason: 'queue-full', depth: _residentQueue.length };
  _residentQueue.push({ lane, fn });
  pushEvent('queue', { lane, depth: _residentQueue.length });
  // If the slot is ALREADY free (the waiter was enqueued without a release to trigger a drain),
  // drain now so a Generate requested while idle does not sit forever.
  if (residentCount() < RESIDENT_MAX) drainResidentQueue();
  return { queued: true, depth: _residentQueue.length };
}

// Drain AT MOST ONE waiter per call. One release frees one slot; the waiter either admits (slot
// now full ⇒ done) or re-queues itself (still refused ⇒ waits for the next release). Draining one
// per call — never a while-loop — is what stops a pressure-refused waiter from spinning forever.
function drainResidentQueue() {
  if (_residentQueue.length === 0 || residentCount() >= RESIDENT_MAX) return;
  const w = _residentQueue.shift();
  pushEvent('dequeue', { lane: w.lane, depth: _residentQueue.length });
  try { w.fn(); } catch { /* the waiter owns its own errors (it set the job to error) */ }
}

function scheduleUnload(baseUrl) {
  if (!_unloadFn) return;
  if (_unloadTimer) clearTimeout(_unloadTimer);
  _unloadTimer = setTimeout(() => {
    _unloadTimer = null;
    if (residentCount() !== 0) return;       // a new resident ticket arrived in the gap — do not evict
    _counters.unloads++;
    pushEvent('unload', { baseUrl: baseUrl || null });
    Promise.resolve().then(() => _unloadFn({ baseUrl })).catch(() => { /* best-effort eviction */ });
  }, UNLOAD_DEBOUNCE_MS);
  if (_unloadTimer.unref) _unloadTimer.unref();
}

export function _setUnloadFn(fn) { _unloadFn = fn; }

/**
 * Request admission for a heavy-compute lane. SYNCHRONOUS (so `finally { release() }` and the
 * child-binding pattern both work, and so no lane can start work in the window between an async
 * admit and its resolution).
 *
 * @param {object}  o
 * @param {string}  o.lane        stable lane id (e.g. 'describe-chronicles', 'embed-drain')
 * @param {string}  o.klass       CLASS.RESIDENT | CLASS.BULK | CLASS.INTERACTIVE
 * @param {number}  [o.estimateGb] BULK sum-gate input (from fit.js estimateMemoryGb)
 * @param {number}  [o.timeoutMs]  lease TTL (default 2× the lane's own timeout; 0 = no lease)
 * @param {object}  [o.child]      a ChildProcess to bind release to (§3.5.2)
 * @param {string}  [o.unloadBaseUrl] Ollama base for the §3.7 post-drain unload
 * @returns {{ok:true, release:Function, heartbeat:Function, shouldYield:Function, ticketId:string}
 *          | {ok:false, reason:string, retryAfterMs:number, state:'waiting'}}
 */
export function admit({ lane, klass, estimateGb = 0, timeoutMs = 0, child = null, unloadBaseUrl = null } = {}) {
  if (!lane || typeof lane !== 'string') throw new TypeError('admit: lane (string) is required');
  if (klass !== CLASS.RESIDENT && klass !== CLASS.BULK && klass !== CLASS.INTERACTIVE) {
    throw new TypeError(`admit: klass must be one of resident|bulk|interactive (got ${JSON.stringify(klass)})`);
  }
  // Class-ordering guard (§3.4): a context already holding a ticket must not admit a DIFFERENT
  // class — that is the hold-and-wait that would let a priority-inversion cycle form. Same-class
  // re-entry (e.g. a describe child that itself describes) is allowed.
  const held = _als.getStore();
  if (held && held.klass !== klass && klass !== CLASS.INTERACTIVE && held.klass !== CLASS.INTERACTIVE) {
    throw new Error(`admit: context already holds a ${held.klass} ticket (lane=${held.lane}); admitting a ${klass} ticket would create a hold-and-wait cycle (design §3.4)`);
  }

  _laneClass.set(lane, klass); // record the real class (aging promotes only plain-RESIDENT lanes)

  const refuse = (reason, retryAfterMs) => {
    _counters.refused++;
    bumpRefusal(lane);
    pushEvent('refuse', { lane, klass, reason, retryAfterMs });
    return { ok: false, reason, retryAfterMs, state: 'waiting' };
  };

  // ── RESIDENT + INTERACTIVE both compete for the single model slot (cap = RESIDENT_MAX) ────────
  if (klass === CLASS.RESIDENT || klass === CLASS.INTERACTIVE) {
    const holder = residentHolder();
    // ⛔ THE CAP IS RESIDENT_MAX — not `if (holder)`. This comparison is what the headline mutation
    // (RESIDENT_MAX 1→2) flips: gate on the count so raising the cap actually admits a second
    // resident lane and verify:compute-lanes C1/C9 go RED (a `holder`-only check would silently
    // ignore the cap — green for the wrong reason, the exact M-001 trap /gate-teeth exists to catch).
    const slotFull = residentCount() >= RESIDENT_MAX;

    // MEMORY BACKPRESSURE ON THE RESIDENT PATH (review round-2 finding #2 — the last narrow crash
    // path). RESIDENT is a COUNT gate, but count-of-1 does NOT stop a single very large model
    // (~13 GB vision on a 16 GB box) loading ON TOP of already-running BULK lanes (embed + whisper,
    // admitted before pressure rose). So a resident model must also respect observed pressure:
    // refuse under CRITICAL, and refuse under WARN while any BULK lane is live (little headroom left
    // for a big model). The refusing lane's own fallback handles it — vision reject-to-filename,
    // describe/clustering busy-retry. This is the mirror of the BULK-under-WARN-with-resident rule.
    const rp = pressure();
    if (rp.level === PRESSURE.CRITICAL) { pushEvent('pressure-refuse', { lane, klass, signal: rp.signal }); return refuse(`memory-pressure:${rp.signal}`, 5000); }
    if (rp.level === PRESSURE.WARN && bulkStats().n > 0) { pushEvent('pressure-refuse', { lane, klass, signal: `${rp.signal}+bulk-live` }); return refuse(`memory-pressure-with-bulk:${rp.signal}`, 5000); }

    if (klass === CLASS.INTERACTIVE) {
      // Aging floor (§3.4, D-017): a DEFER/background lane refused ≥ AGING_THRESHOLD times is
      // promoted OVER interactive for one ticket — otherwise a chatty user's vault never embeds
      // (the mirror of the crash). While a starved background lane is waiting, refuse interactive
      // so the background lane wins the slot on its next attempt.
      if (agedBackgroundExists()) {
        return refuse('aged-background-priority', 250);
      }
      if (!slotFull) return grant(lane, klass, estimateGb, timeoutMs, child, unloadBaseUrl);
      // Preempt the current holder: set its yield flag. It polls shouldYield() between units of
      // work and releases. We do NOT wait-then-kill (killing a mid-write describe corrupts a
      // chronicle) — interactive is refused with a retry (design §3.4 "falls through to 503").
      if (!holder.preemptRequested) {
        holder.preemptRequested = true;
        _counters.preempted++;
        pushEvent('preempt', { lane, targetLane: holder.lane, ticketId: holder.id });
      }
      return refuse('model-busy-preempting', YIELD_MS);
    }

    // Plain RESIDENT (background). Refused while the model slot is full (count ≥ RESIDENT_MAX).
    if (slotFull) return refuse('resident-busy', YIELD_MS);
    // Slot free. If THIS lane was the aged/starved one, its promotion is now spent.
    clearRefusal(lane);
    return grant(lane, klass, estimateGb, timeoutMs, child, unloadBaseUrl);
  }

  // ── BULK: memory backpressure first (§3.6), then the sum + count gate ────────────────────────
  const p = pressure();
  if (p.level === PRESSURE.CRITICAL) {
    pushEvent('pressure-refuse', { lane, signal: p.signal });
    return refuse(`memory-pressure:${p.signal}`, 5000);
  }
  // P1 STRENGTHENING (D-001, the reported symptom): "embeddings are still firing at the same time
  // as describing and it crashed my computer." A resident model being LOADED is a known fact (not
  // an estimate); when one is held AND observed pressure is already WARN, there is little headroom
  // left for a BULK lane (the embed ONNX drain) — so defer it. This couples the certain signal
  // (a model is resident) with the real-time one (pressure), rather than trusting the GB estimate
  // alone (design §5 "estimates are guesses"). A BULK lane refused here re-tries next cycle (DEFER).
  if (p.level === PRESSURE.WARN && residentCount() > 0) {
    pushEvent('pressure-refuse', { lane, signal: `${p.signal}+resident-loaded` });
    return refuse(`memory-pressure-with-resident:${p.signal}`, 5000);
  }
  const { n, gb } = bulkStats();
  if (n >= BULK_MAX) return refuse('bulk-slots-full', 3000);
  // A lane whose estimate ALONE exceeds the budget can never be admitted — refuse it loudly rather
  // than queue it forever (design §3.3 REJECT). Otherwise admit while the running sum fits.
  if (estimateGb > budgetGb()) return refuse('exceeds-budget', 0);
  if (gb + estimateGb > budgetGb() && n > 0) return refuse('bulk-budget-exceeded', 3000);
  clearRefusal(lane);
  return grant(lane, klass, estimateGb, timeoutMs, child, unloadBaseUrl);
}

function grant(lane, klass, estimateGb, timeoutMs, child, unloadBaseUrl) {
  const id = `t${++_seq}_${lane}`;
  const ticket = {
    id, lane, klass, estimateGb: Number(estimateGb) || 0,
    admittedAt: _now(), lastBeatAt: _now(), timeoutMs: Number(timeoutMs) || 0,
    preemptRequested: false, child: null, leaseTimer: null, unloadBaseUrl,
  };
  _tickets.set(id, ticket);
  _counters.admitted++;
  // A lane admitted after being starved past the aging threshold is a promotion — count it so the
  // aging floor is visible in the readiness counters (D-017 was invisible before).
  if ((_laneRefusals.get(lane) || 0) >= AGING_THRESHOLD) _counters.agedPromotions++;
  clearRefusal(lane);
  pushEvent('admit', { lane, klass, ticketId: id, estimateGb: ticket.estimateGb });
  armLease(ticket);
  if (child) bindChild(ticket, child);

  let released = false;
  const release = () => { if (released) return; released = true; doRelease(id, 'release'); };
  const heartbeat = () => { const t = _tickets.get(id); if (t) t.lastBeatAt = _now(); };
  const shouldYield = () => { const t = _tickets.get(id); return t ? t.preemptRequested : true; }; // gone ⇒ yield
  // Bind a child spawned AFTER admission (spawners reserve the slot before they have the child):
  // the governor releases this ticket on the child's close OR error (first wins) — crash-release #2.
  const bind = (childProc) => { const t = _tickets.get(id); if (t) bindChild(t, childProc); };
  return { ok: true, release, heartbeat, shouldYield, bindChild: bind, ticketId: id, _ticket: ticket };
}

/**
 * Run `fn` with a ticket recorded in AsyncLocalStorage so the §3.4 hold-and-wait guard can see
 * it. Used by lanes that await inside their held region. `handle` is the object admit() returned.
 */
export function withTicket(handle, fn) {
  if (!handle || !handle.ok) return fn();
  return _als.run(handle._ticket, fn);
}

/** Observability snapshot for the activity feed + readiness (design §3.5 "readiness-visible"). */
export function governorStatus() {
  const { n: bulkN, gb: bulkGb } = bulkStats();
  return {
    resident: { held: residentCount(), max: RESIDENT_MAX, lane: residentHolder()?.lane || null },
    bulk: { held: bulkN, max: BULK_MAX, gb: Math.round(bulkGb * 10) / 10, budgetGb: Math.round(budgetGb() * 10) / 10 },
    pressure: pressure(),
    counters: { ..._counters },
    tickets: [..._tickets.values()].map((t) => ({ lane: t.lane, klass: t.klass, ageMs: _now() - t.admittedAt })),
    queue: _residentQueue.map((w) => w.lane),
    events: _events.slice(-25),
  };
}

/** Is a resident model lane currently admitted? (readiness "compute busy" surface). */
export function isResidentBusy() { return residentCount() >= RESIDENT_MAX; }

// ── Test seams (never used by production paths) ─────────────────────────────────────────────
export function _resetGovernor() {
  for (const t of _tickets.values()) if (t.leaseTimer) clearTimeout(t.leaseTimer);
  if (_unloadTimer) { clearTimeout(_unloadTimer); _unloadTimer = null; }
  _tickets.clear(); _laneRefusals.clear(); _laneClass.clear(); _events.length = 0; _residentQueue.length = 0;
  for (const k of Object.keys(_counters)) _counters[k] = 0;
  _seq = 0; _budgetGb = null; _budgetAt = 0; _pressureCache = null; _pressureAt = 0;
  _hardwareProbe = null; _memProbe = memoryPressure; _unloadFn = null; _now = () => Date.now();
}
export function _setMemProbe(fn) { _memProbe = fn; _pressureCache = null; _pressureAt = 0; }
export function _setNow(fn) { _now = fn; }
export function _setBudgetGb(gb) { _budgetGb = gb; _budgetAt = _now(); }

export default { admit, withTicket, governorStatus, isResidentBusy, CLASS };
