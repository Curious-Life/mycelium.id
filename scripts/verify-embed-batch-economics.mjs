#!/usr/bin/env node
// verify:embed-batch-economics — D-131 ROOT CAUSE (QA hard evidence, 2026-08-05,
// the 67k vault): the 7,315 stuck rows were the large imported GitHub .md files
// (avg 8k chars, head 21k–77k). Each embeds fine alone (12–16 s) — but the old
// drainer sent 12 per /batch call (>120 s) against a hardcoded 30 s client
// timeout: abort → per-row fallback also times out (the single-threaded service
// is still grinding the aborted batch) → 0 embedded → the outage guard freezes
// the attempt counters at 4-of-5 FOREVER → the same 12 rows re-select every
// cycle → 99% CPU on 2 cores, RSS to 1.8 GB, periodic OOM-kill, repeat. The
// backlog could never finish, and no operator knob could force it through.
//
// The fix under test (all in src/enrich/service.js drainOnce):
//   1. SIZE-BUDGETED packing: chunks close at 12 rows OR ~20k effective chars
//      (~2 large docs — sized so the worst chunk sits at ~50% of its budget,
//      round-2 review #2); an over-budget doc rides alone (effChars caps at
//      the service's own 40k MAX_CHARS mirror).
//   2. SIZE-SCALED call budgets: floor 30 s, 2.5 ms/char + headroom, ceiling
//      EMBED_RESCUE_TIMEOUT_MS — legitimate long compute is never aborted.
//   3. The bounded UNFREEZE — ONCE PER CYCLE (round-2 review BLOCKER): a
//      zero-embed pass counts nothing UNLESS a post-pass health probe answers
//      a STRICT status:'ok' + loaded:true — then exactly ONE row per CYCLE is
//      judged (a sentinel in the shared attemptedThisCycle Set; rescue-first
//      with the 120 s budget). A wedged/loading/erroring/unreachable/empty-200
//      service fails the probe → the mass-loss guard holds exactly as before;
//      worst case is 1 attempt + 1 probe + 1 rescue per 15 s cycle.
// Plus (src/enrich/drainer.js): the per-cycle selfHeal/reclaim generation bumps
// are CHANGE-GATED — a 0-change UPDATE proves the backlog numbers cannot have
// moved, so an idle vault no longer re-arms readiness's multi-second decrypt
// scan every TTL (~45% idle CPU, the QA D-132 correction).
//
// MUTATION-TESTED: (D-131 root, 2026-08-05) the char-budget clause removed from
// the packer (chunks close on row count alone — the pre-fix 12-large-docs-per-
// call shape) → A2 and A4 RED (large docs no longer ride alone; the QA-shaped
// batch goes out as one call) while A1/A5 stay GREEN. Restored → GO.
// MUTATION-TESTED: (D-131 root, 2026-08-05) embedCallBudgetMs hardcoded to
// 30_000 (the pre-fix hardcoded timeout) → A2b RED (all three 40k-char calls
// sent with the 30 s budget: [30000,30000,30000]) and A5 RED (the per-row
// fallback loses its scaled budget too). Restored → GO.
// MUTATION-TESTED: (D-131 root, 2026-08-05) idleHealthOk forced false (the
// unfreeze deleted — a healthy-but-all-null pass counts nothing, the frozen-at-4
// forever state) → B2, B2b, B3 and B4 all RED (no judge, no rescue, no cap —
// B4's evidence cell shows the frozen state verbatim: nlp_error [null,null]
// after ten passes) while B1 (outage guard) stays GREEN. Restored → GO.
// MUTATION-TESTED: (D-131 root, 2026-08-05) judgeCap for the idle-health path
// raised to MAX_JUDGED_PER_PASS (unbounded idle judging — double the worst-case
// pass cost the COST BOUND comment promises) → B2 RED (two attempts counted:
// ["embed-retry:1","embed-retry:1"]), B2b RED (two rescues), B3 RED (the second
// judged row burns an attempt the single-cap design spends on nothing).
// Restored → GO.
// MUTATION-TESTED: (D-132 readiness, 2026-08-05) selfHealStrandedEmbeds' change
// gate removed (unconditional bump — the every-cycle no-op writer that kept
// re-arming the readiness scan on an idle vault) → C1 RED (a 0-change self-heal
// bumps) while C2/C3 stay GREEN. Restored → GO.
// ── Round-2/3 records (gate-integrity review: 3 of 8 author-blind mutations
// survived; correctness review: DO-NOT-LAND with a REPRODUCED blocker — every
// survivor + the blocker's mutant re-run and watched RED after hardening): ────
// MUTATION-TESTED: (review-2 F1/M5, 2026-08-05) the probe's discrimination
// deleted (idleHealthOk = Boolean(h)) → B1b and B1c RED (a LOADING /ERRORING
// service that answers 200 counts attempts — marching the backlog during a
// model download). Restored → GO.
// MUTATION-TESTED: (review-2 F2/M7, 2026-08-05) the cycleSet.has(t.id) guard
// removed → B2c RED with ["embed-retry:2",…] (a row counted twice in one
// cycle). Restored → GO.
// MUTATION-TESTED: (review-2 F3/M8, 2026-08-05) reclaimGaveUpRows' bump gate
// reads only r1 → C3b RED (an r2-only reclaim never bumps — the stale-forever
// inversion). Restored → GO.
// MUTATION-TESTED: (round-3 — THE REPRODUCED BLOCKER, 2026-08-05) the
// IDLE_JUDGE_SENTINEL clause removed (unfreeze bounded per PASS, not per
// CYCLE — the reviewer's repro marched 200 of 300 prior-4 rows terminal in ONE
// cycle against a health-ok fast-503-shedding service) → B2c RED with the
// mass-cap visible verbatim ([-1,"embed-capped:5"] ×3), B2c-b and B2d RED.
// Restored → GO.
// MUTATION-TESTED: (round-3, 2026-08-05) budget rate reverted to 1.5 ms/char
// (zero margin at QA's own 12–16s/8k measured band) → A3 RED (the 77k head's
// clamped budget comes out 75000, not 115000). Restored → GO.
// MUTATION-TESTED: (round-3, 2026-08-05) the strict predicate reverted to the
// fail-open shape (loaded !== false && status !== …) → B1d RED (an EMPTY 200 —
// a port squatter — reads as provably-up and burns attempts). B1b/B1c alone
// did NOT catch this reversion (both predicates reject loading/error) — the
// empty-payload fixture is the distinguishing tooth, recorded so it is not
// dropped as redundant. Restored → GO.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import crypto from 'node:crypto';
process.env.ENCRYPTION_MASTER_KEY ||= crypto.randomBytes(32).toString('hex');
const { createEnrichmentService, EMBED_MAX_ATTEMPTS, EMBED_CAPPED_MARK, EMBED_RETRY_MARK, EMBED_RESCUE_TIMEOUT_MS } = await import('../src/enrich/service.js');
const { selfHealStrandedEmbeds, reclaimGaveUpRows } = await import('../src/enrich/drainer.js');

const ledger = [];
let allPass = true;
function check(name, cond, detail = '') {
  const ok = !!cond;
  allPass = allPass && ok;
  ledger.push(`[${ok ? '✓' : '✗'}] ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}

/** In-memory messages namespace over a row map. */
function makeMessages(rowList) {
  const rows = new Map(rowList.map((r) => [r.id, { nlp_processed: 0, nlp_error: null, ...r }]));
  return {
    rows,
    async selectPendingEnrichment(_u, { limit = 50 } = {}) {
      return [...rows.values()].filter((r) => r.nlp_processed === 0 || r.nlp_processed == null).slice(0, limit);
    },
    async updateEnrichment(id, _u, { embedding768, nlpProcessed, nlpError = null } = {}) {
      const r = rows.get(id);
      if (!r) return;
      if (embedding768 !== undefined) r.embedding_768 = embedding768;
      r.nlp_processed = nlpProcessed;
      r.nlp_error = nlpError;
    },
    async selectPendingNlp() { return []; },
    async updateNlp() {},
    async selectPendingCategories() { return []; },
    async updateCategories() {},
  };
}

const VEC = () => Array.from({ length: 768 }, () => 0.1);
/** Recording embed client. behavior(text) → vector | null; health() → healthPayload. */
function makeEmbed({ behavior = () => VEC(), health = { status: 'ok', loaded: true, dim: 768 } } = {}) {
  const calls = { batch: [], single: [], health: 0 };
  return {
    calls,
    async health() { calls.health += 1; if (health instanceof Error) throw health; return health; },
    async embedBatch(texts, _task, opts = {}) {
      calls.batch.push({ n: texts.length, chars: texts.reduce((a, t) => a + String(t || '').length, 0), timeoutMs: opts.timeoutMs });
      return texts.map((t) => behavior(t));
    },
    async embed(text, _task, opts = {}) {
      calls.single.push({ chars: String(text || '').length, timeoutMs: opts.timeoutMs });
      return behavior(text);
    },
  };
}
const svcFor = (messages, embed) => createEnrichmentService({ messages, embed, getMasterKey: async () => 'k'.repeat(64) });

try {
  // ── Part A: packing + budgets ──────────────────────────────────────────────
  // A1: 24 short rows → two calls of 12 (row-count packing preserved).
  {
    const messages = makeMessages(Array.from({ length: 24 }, (_, i) => ({ id: `s${i}`, content: `short ${i}` })));
    const embed = makeEmbed();
    await svcFor(messages, embed).drainOnce({ userId: 'u', batchSize: 24 });
    check('A1 24 short rows → 2 calls of 12 (short-message packing unchanged)',
      embed.calls.batch.length === 2 && embed.calls.batch.every((c) => c.n === 12));
    check('A1b …each with the 30s floor budget', embed.calls.batch.every((c) => c.timeoutMs === 30_000));
  }
  // A2: three 40k docs → three calls of 1, each with a SCALED budget.
  {
    const big = 'x'.repeat(40_000);
    const messages = makeMessages([{ id: 'd1', content: big }, { id: 'd2', content: big }, { id: 'd3', content: big }]);
    const embed = makeEmbed();
    await svcFor(messages, embed).drainOnce({ userId: 'u', batchSize: 10 });
    check('A2 max-size docs ride ALONE (one per call)', embed.calls.batch.length === 3 && embed.calls.batch.every((c) => c.n === 1));
    check('A2b …with a size-scaled budget well above the 30s floor, capped at the rescue ceiling',
      embed.calls.batch.every((c) => c.timeoutMs > 30_000 && c.timeoutMs <= EMBED_RESCUE_TIMEOUT_MS),
      JSON.stringify(embed.calls.batch.map((c) => c.timeoutMs)));
  }
  // A3 (review-2): the QA head itself — a 77k-char doc. effChars CLAMPS at the
  // 40k mirror, so the budget must be exactly budget(40k) = 15s + 40k*2.5ms =
  // 115s — a wrong mirror in EITHER direction (4k under-scales, 60k
  // over-scales) or a reverted rate breaks the equality.
  {
    const messages = makeMessages([{ id: 'h1', content: 'w'.repeat(77_000) }]);
    const embed = makeEmbed();
    await svcFor(messages, embed).drainOnce({ userId: 'u', batchSize: 5 });
    check('A3 the 77k QA head rides alone with the CLAMPED budget (exactly budget-of-40k-effective = 115s)',
      embed.calls.batch.length === 1 && embed.calls.batch[0].n === 1 && embed.calls.batch[0].timeoutMs === 115_000,
      JSON.stringify(embed.calls.batch));
  }
  // A4: THE QA SHAPE — twelve 8k docs must NOT go out as one 96k-char call.
  {
    const doc = 'y'.repeat(8_000);
    const messages = makeMessages(Array.from({ length: 12 }, (_, i) => ({ id: `g${i}`, content: doc })));
    const embed = makeEmbed();
    await svcFor(messages, embed).drainOnce({ userId: 'u', batchSize: 12 });
    const maxChars = Math.max(...embed.calls.batch.map((c) => c.chars));
    check('A4 the QA shape (12 × 8k .md docs) is split by the char budget (≤2 docs/call), never one >120s call',
      embed.calls.batch.length >= 5 && maxChars <= 20_000,
      `calls=${embed.calls.batch.length} maxChars=${maxChars}`);
  }
  // A5: the per-row fallback carries a scaled budget too.
  {
    const big = 'z'.repeat(40_000);
    const messages = makeMessages([{ id: 'f1', content: big }]);
    const embed = makeEmbed();
    embed.embedBatch = async () => { throw new Error('batch down'); }; // force the fallback
    await svcFor(messages, embed).drainOnce({ userId: 'u', batchSize: 5 });
    check('A5 per-row fallback carries the size-scaled budget',
      embed.calls.single.length >= 1 && embed.calls.single[0].timeoutMs > 30_000 && embed.calls.single[0].timeoutMs <= EMBED_RESCUE_TIMEOUT_MS);
  }

  // ── Part B: the bounded unfreeze ───────────────────────────────────────────
  // B1: zero-embed pass + health probe FAILS → nothing counted (outage guard).
  // Positive preconditions pinned (review-2 vacuousness: an inert drainOnce kept
  // this green): the pass RAN (batch traffic), the probe was CONSULTED, and the
  // rows are still pending — absence alone proves nothing.
  {
    const messages = makeMessages([{ id: 'p1', content: 'aa' }, { id: 'p2', content: 'bb' }, { id: 'p3', content: 'cc' }]);
    const embed = makeEmbed({ behavior: () => null, health: new Error('wedged') });
    await svcFor(messages, embed).drainOnce({ userId: 'u', batchSize: 5 });
    const counted = [...messages.rows.values()].filter((r) => r.nlp_error);
    const stillPending = [...messages.rows.values()].every((r) => r.nlp_processed === 0);
    check('B1 zero-embed pass + unreachable service → ZERO attempts counted (mass-loss guard holds)',
      counted.length === 0 && stillPending && embed.calls.batch.length >= 1 && embed.calls.health >= 1);
  }
  // B1b/B1c (review-2 F1): the probe's DISCRIMINATION is the guard — a service
  // that ANSWERS but is loading (a real multi-minute model download answers 200
  // with loaded:false) or erroring must count nothing, or attempts march the
  // backlog toward embed-capped during every model download.
  {
    const messages = makeMessages([{ id: 'l1', content: 'aa' }, { id: 'l2', content: 'bb' }]);
    const embed = makeEmbed({ behavior: () => null, health: { status: 'loading', loaded: false } });
    await svcFor(messages, embed).drainOnce({ userId: 'u', batchSize: 5 });
    check('B1b LOADING service (answers, loaded:false) → ZERO attempts counted',
      [...messages.rows.values()].every((r) => !r.nlp_error) && embed.calls.health >= 1);
    const messages2 = makeMessages([{ id: 'e1', content: 'aa' }, { id: 'e2', content: 'bb' }]);
    const embed2 = makeEmbed({ behavior: () => null, health: { status: 'error', loaded: true } });
    await svcFor(messages2, embed2).drainOnce({ userId: 'u', batchSize: 5 });
    check('B1c ERRORING service (answers, status:error) → ZERO attempts counted',
      [...messages2.rows.values()].every((r) => !r.nlp_error) && embed2.calls.health >= 1);
    // B1d (round-2 #3, the fail-closed edge): an EMPTY 200 — what the client
    // yields from a bodyless reply, e.g. a port squatter — proves nothing and
    // must count nothing. Only an explicit status:'ok' + loaded:true retires rows.
    const messages3 = makeMessages([{ id: 'z1', content: 'aa' }, { id: 'z2', content: 'bb' }]);
    const embed3 = makeEmbed({ behavior: () => null, health: {} });
    await svcFor(messages3, embed3).drainOnce({ userId: 'u', batchSize: 5 });
    check('B1d EMPTY health payload (port squatter 200) → ZERO attempts counted (fail-closed)',
      [...messages3.rows.values()].every((r) => !r.nlp_error) && embed3.calls.health >= 1);
  }
  // B2: zero-embed pass + health OK → exactly ONE row judged; rescue first; a
  // failed rescue against the responsive service counts ONE attempt.
  {
    const messages = makeMessages([{ id: 'q1', content: 'aa' }, { id: 'q2', content: 'bb' }, { id: 'q3', content: 'cc' }]);
    const embed = makeEmbed({ behavior: () => null }); // healthy, but every embed nulls
    await svcFor(messages, embed).drainOnce({ userId: 'u', batchSize: 5 });
    const counted = [...messages.rows.values()].filter((r) => String(r.nlp_error || '').startsWith(EMBED_RETRY_MARK));
    const rescue = embed.calls.single.filter((c) => c.timeoutMs === EMBED_RESCUE_TIMEOUT_MS);
    check('B2 zero-embed pass + HEALTHY service → exactly ONE attempt counted (the freeze is over)',
      counted.length === 1 && counted[0].nlp_error === `${EMBED_RETRY_MARK}:1`, JSON.stringify(counted.map((r) => r.nlp_error)));
    check('B2b …one rescue call, rescue-first (the 120s budget), never two per pass', rescue.length === 1);
  }
  // B2c (round-2 review BLOCKER, reproduced there as 200 rows capped in ONE
  // cycle): the unfreeze is bounded ONCE PER CYCLE — the drainer shares one
  // attemptedThisCycle Set across ≤200 passes, and a fresh row judged per pass
  // would let a health-ok-but-overloaded service (fast-503 shedding answers
  // /health ok BY DESIGN) mass-march a prior≥4 backlog to terminal inside one
  // cycle. Three shared-Set passes must count exactly ONE row, total.
  {
    const messages = makeMessages([
      { id: 'y1', content: 'aa', nlp_error: 'embed-retry:4' },
      { id: 'y2', content: 'bb', nlp_error: 'embed-retry:4' },
      { id: 'y3', content: 'cc', nlp_error: 'embed-retry:4' },
    ]);
    const embed = makeEmbed({ behavior: () => null });
    const svc = svcFor(messages, embed);
    const cycleSet = new Set();
    const r1 = await svc.drainOnce({ userId: 'u', batchSize: 5, attemptedThisCycle: cycleSet });
    const r2 = await svc.drainOnce({ userId: 'u', batchSize: 5, attemptedThisCycle: cycleSet });
    await svc.drainOnce({ userId: 'u', batchSize: 5, attemptedThisCycle: cycleSet });
    const moved = [...messages.rows.values()].filter((r) => r.nlp_processed !== 0);
    check('B2c THREE passes in ONE cycle (shared Set, prior=4 head) → exactly ONE row judged total (no mass-cap march)',
      moved.length === 1,
      JSON.stringify([...messages.rows.values()].map((r) => [r.nlp_processed, r.nlp_error])));
    check('B2c-b …the judged pass reports idleJudged (the drainer can see the unfreeze acted)',
      r1?.idleJudged === true && r2?.idleJudged !== true);
    // B2d: a NEW cycle (fresh Set) may judge one more — the budget is per cycle.
    const before = moved.length;
    await svc.drainOnce({ userId: 'u', batchSize: 5, attemptedThisCycle: new Set() });
    const after = [...messages.rows.values()].filter((r) => r.nlp_processed !== 0).length;
    check('B2d a NEW cycle judges at most one more (1 attempt per cycle, never per pass)', after === before + 1);
  }
  // B3: the rescue SUCCEEDS → the row lands, no attempt burned.
  {
    const messages = makeMessages([{ id: 'r1', content: 'aa' }, { id: 'r2', content: 'bb' }]);
    let calls = 0;
    const embed = makeEmbed({ behavior: () => { calls += 1; return null; } });
    embed.embed = async (text, _t, opts = {}) => {
      embed.calls.single.push({ chars: text.length, timeoutMs: opts.timeoutMs });
      return opts.timeoutMs === EMBED_RESCUE_TIMEOUT_MS ? VEC() : null; // only the long-budget rescue lands
    };
    await svcFor(messages, embed).drainOnce({ userId: 'u', batchSize: 5 });
    const landed = [...messages.rows.values()].filter((r) => r.nlp_processed === 2);
    const marked = [...messages.rows.values()].filter((r) => r.nlp_error);
    check('B3 a slow-but-valid row LANDS via the rescue — no attempt burned', landed.length === 1 && marked.length === 0);
  }
  // B4: the counter now reaches the cap — the poison head is quarantined.
  {
    const messages = makeMessages([{ id: 'c1', content: 'aa' }, { id: 'c2', content: 'bb' }]);
    const embed = makeEmbed({ behavior: () => null });
    const svc = svcFor(messages, embed);
    for (let pass = 0; pass < 2 * EMBED_MAX_ATTEMPTS; pass++) {
      await svc.drainOnce({ userId: 'u', batchSize: 5 }); // each call = its own cycle (no shared Set)
    }
    const capped = [...messages.rows.values()].filter((r) => r.nlp_processed === -1 && String(r.nlp_error || '').startsWith(EMBED_CAPPED_MARK));
    check('B4 a genuinely-unembeddable head CAPS at EMBED_MAX_ATTEMPTS and leaves the backlog (no more forever-spin)',
      capped.length >= 1, JSON.stringify([...messages.rows.values()].map((r) => r.nlp_error)));
  }

  // ── Part C: the readiness quiescence hole (change-gated bumps) ─────────────
  {
    // Per-CALL changes queue (review-2 F3): reclaim issues TWO statements; a
    // same-value-every-call fake cannot distinguish a gate that reads only r1
    // from one that sums both legs.
    const mk = (...changesQueue) => {
      const noted = { n: 0 };
      const q = [...changesQueue];
      const db = {
        rawQuery: async () => ({ results: [], meta: { changes: q.length > 1 ? q.shift() : q[0] } }),
        messages: { noteBacklogWrite: () => { noted.n += 1; } },
      };
      return { db, noted };
    };
    {
      const { db, noted } = mk(0);
      await selfHealStrandedEmbeds(db, 'u');
      check('C1 self-heal with 0 changes → NO generation bump (idle vault stays quiescent)', noted.n === 0);
    }
    {
      const { db, noted } = mk(3);
      await selfHealStrandedEmbeds(db, 'u');
      check('C2 self-heal with real changes → bumps', noted.n === 1);
    }
    {
      const a = mk(0); await reclaimGaveUpRows(a.db, 'u');
      const b = mk(2); await reclaimGaveUpRows(b.db, 'u');
      check('C3 reclaim: 0-change → no bump; real change → bumps', a.noted.n === 0 && b.noted.n === 1);
      // C3b (review-2 F3): the r2-ONLY leg — a reclaim that resets only
      // categories rows (r1=0, r2>0) must still bump, or the categorize
      // backlog cache goes stale-forever (the inverted D-132 class).
      const c = mk(0, 2); await reclaimGaveUpRows(c.db, 'u');
      check('C3b reclaim with changes ONLY on the second statement → still bumps', c.noted.n === 1);
    }
  }
} catch (e) {
  check(`fatal: ${e?.message || e}`, false);
}

console.log(ledger.join('\n'));
console.log('='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO' : 'NO-GO'}  EXIT=${allPass ? 0 : 1}`);
process.exit(allPass ? 0 : 1);
