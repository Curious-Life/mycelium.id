// src/portal-activity.js — the unified activity feed: one endpoint that aggregates
// every background/inference job into a content-free list for the UI (header stream
// indicator + mindscape chip). Reads db.activityFeed (over background_jobs), reaps
// dead rows first (fail-closed), and computes a live ETA from elapsed/done × queued.
//
// SECURITY: loopback/authed like the rest of /portal; rows are content-free by
// construction (stage labels are constants, never names/text — §1).

import express from 'express';
import { getEmbedderHealth } from './embed/supervisor.js';
import { isEmbedPaused, isCategorizePaused, getEnrichDrainerStatus, defaultLabelModel, defaultEnrichModel } from './enrich/drainer.js';

// Plain, accurate label per job kind — what the operation LITERALLY is (content-free, never
// user text). Deliberately not poetic: the user should be able to tell exactly what's running.
const KIND_LABELS = {
  // W8 (INTELLIGENCE-SCREEN-REDESIGN II.6): the UI's verb glossary is Name / Describe / Map over
  // "areas" — the breadcrumb's own word. "Clusters" is plumbing vocabulary; these labels align
  // with the pipeline's stageLabels ('Naming your areas' / 'Describing your areas').
  'describe:name': 'Naming your areas',
  'describe:chronicle': 'Describing your areas',
  mycelium_generate: 'Clustering messages',
  embed: 'Embedding messages',             // computing 768-dim vectors for search/clustering
  categorize: 'Categorizing messages',     // CE L1: per-message domain + register tags via the on-box model
  enrich: 'Understanding messages',        // CE L2: semantic entities + gist via the on-box model (content-free constant)
  import: 'Importing your data',           // an import in flight — the longest thing a new user waits on
  'model-pull': 'Downloading a local model', // a consented model download (GBs) — was log-only and invisible
  'inference:chat': 'Generating reply',    // live: the chat model is generating a reply
  'inference:channel': 'Replying on a channel', // live: a model is answering an inbound Telegram/Discord message
};

// Where/how each runs — complements the stage (WHAT) + model (WHICH). Only the always-local
// stages claim 'on-device'; chat/describe route by the chosen model/provider, so the model
// name itself carries local-vs-cloud (no process tag → just the model is shown).
const PROCESS_LABELS = {
  embed: 'on-device',
  categorize: 'on-device',
  enrich: 'on-device',
  mycelium_generate: 'on-device · CPU',
  'model-pull': 'downloading',   // the one job here that is NOT compute — it is network + disk
};

// Fixed on-box embedding model in V1 (ONNX Nomic v1.5; the embed-service exposes it at /health).
const EMBED_MODEL = 'nomic-v1.5';

/**
 * Embed-drainer liveness verdict — PURE and time-injected, so the gate
 * (scripts/verify-drainer-liveness.mjs) tests the decision that actually renders,
 * not a stub of it. This indicator has hidden a dead drainer twice; the rules
 * each encode one of those failures:
 *
 *  - PROGRESS defines liveness, never the cycle heartbeat. `lastCycleAt` stamps on
 *    every cycle that runs — including one that moves ZERO rows — so
 *    max(lastCycleAt, lastProgressAt) could never go stale while the timer ticked
 *    (the 2026-07-15 over-correction: 25 min of zero rows rendered "running").
 *    Once progress has EVER happened, the anchor is lastProgressAt alone.
 *  - `running` must not mask staleness: a cycle wedged on an await that never
 *    settles is "in flight" forever.
 *  - STALE_MS is 5 minutes, not 90s: a healthy on-box-LLM cycle legitimately runs
 *    for minutes (90s cried wolf on a working drainer, observed live).
 *  - Boot (no cycle has ever run: both stamps 0) is startup, not a fault.
 *  - A loading model is "starting", never bad. No drainer at all is always bad.
 *  - The drainer saying stalled (skips > 0 — a real embed-service outage) is believed.
 *
 * @param {{st: object|null, health: string, now?: number}} args
 * @returns {{stalled: boolean, starting: boolean, bad: boolean, booting: boolean}}
 */
export function deriveEmbedLiveness({ st, health, now = Date.now() }) {
  const STALE_MS = 5 * 60_000;
  const noDrainer = !st;
  const starting = Boolean(st?.starting) || health === 'loading';
  const booting = !st?.lastCycleAt && !st?.lastProgressAt;
  // The freshest evidence of REAL life. lastProgressAt once set is the only honest
  // anchor; before any progress exists, lastCycleAt covers the first long boot cycle.
  const anchor = Number(st?.lastProgressAt) || Number(st?.lastCycleAt) || 0;
  const stale = anchor > 0 && (now - anchor) > STALE_MS;
  const stalled = Boolean(st?.stalled) || (!booting && stale);
  const bad = !starting && (health === 'error' || noDrainer || stalled);
  return { stalled, starting, bad, booting };
}

// The L1 labeling model the drainer uses — resolved by THE drainer's own resolver.
//
// ⚠️ This file had its OWN COPY of this function, with the implicit `return 'qwen3.5:4b'`
// fallback, and increment M's caller audit MISSED IT: the audit grepped the NAME
// (`defaultLabelModel`), and this copy was called `resolveLabelModel`. That is the exact
// failure the pre-deletion-caller-audit skill warns about — grep the CONCEPT ("who resolves
// a label model?"), not the identifier.
//
// Left un-migrated it re-created, in THIS file, the precise bug the comment 15 lines below
// says was fixed for embed: an unapproved vault (no model, nothing running, qwen not even on
// disk) rendered "Categorizing messages · qwen3.5:4b · on-device · running" FOREVER — "a
// stuck vault and a healthy one looked identical from here" (independent review, 2026-07-16).
// ⇒ imported from the drainer at the top of this file. null now means "not approved", and
// categorizeProjection below must render that state, not paper over it.

/**
 * R1 (§3.9): how long the embed backlog will take, from the drainer's MEASURED throughput.
 *
 * Same shape as etaSeconds() below — per-item cost × work remaining — but the inputs differ for a
 * structural reason: etaSeconds() reads a background_jobs ROW (step / total_steps / started_at),
 * and this row is a SYNTHETIC PROJECTION computed from counts. It has no started_at, so the rate
 * has to come from the drainer itself.
 *
 * ⚠️ THE DENOMINATOR IS ACTIVE DRAIN TIME, NOT ELAPSED — and that is the whole design. Wall-clock
 * elapsed-since-start counts every second the drainer sat idle (backlog empty) or PAUSED, and R3
 * just made pausing a persisted, possibly-overnight state. A vault paused for an hour and resumed
 * would price each message ~60x its true cost and promise "about 3 days" on an hour of work. §3.9
 * exists to stop the app lying about cost; an ETA computed from time it spent doing nothing is
 * that same lie wearing a progress bar.
 *
 * ⚠️ THE RATE DOES NOT SURVIVE A RESTART, unlike etaSeconds() — do not read "same shape" as "same
 * guarantees". etaSeconds() is annotated "robust across restarts" because `started_at` is a
 * PERSISTED column; these counters are in-memory and per-drainer, so a restart mid-import resets
 * them and this row goes from "~5m left" to no estimate until the first embed lands. That is the
 * honest direction (a fresh process genuinely has not measured anything yet), but it is a real
 * difference and the reader must not inherit a property that does not transfer.
 *
 * Honest nulls — an estimate we cannot stand behind is worse than none (§3.9's premise is that a
 * confident wrong number is what made the 29-hour import intolerable):
 *   • paused              → null. Nothing is progressing; a countdown to a moment that will never
 *                           arrive is not an estimate. The row already says "· paused".
 *   • nothing embedded yet → null. Mirrors etaSeconds()'s own "no estimate before the 1st item".
 *   • no work remaining    → null.
 *   • NOT PROGRESSING      → null — measured by OUTCOME (consecutive barren passes), never by a
 *                           clock. See STALL_PASSES below for why a time window is underivable.
 */
// ⚠️ THERE IS DELIBERATELY NO TIME WINDOW HERE, AND THAT IS THE POINT.
// Three attempts died on this: 90s ("matches the row's STALE_MS") — but STALE_MS governs 15s
// CYCLES while progress moves on a BATCH cadence, so a healthy vault lost its ETA for 28% of every
// long batch. Then 240s, derived from "5 chunks x the 30s abort = 150s worst case" — which used
// the `embedBatch` path ONLY. service.js falls back to TWELVE SEQUENTIAL per-row requests, each
// with its own 30s abort, so a chunk costs up to 30 + 12x30 = 390s and a BATCH up to ~1,950s —
// WITH EVERY ROW SUCCEEDING. And the fallback engages exactly when messages are long, i.e. the
// case the window exists for. The honest window is ~32 MINUTES, which is absurd as a stall
// detector — and the absurdity IS the finding: A TIME WINDOW AT BATCH GRANULARITY CANNOT BE
// DERIVED, because one legitimate batch spans 60s to 32min (independent review, 2026-07-17).
// ⇒ Ask the drainer what it DID, not how long it has been. `noProgress` counts consecutive passes
// that ATTEMPTED work and embedded nothing; `embedErrs` counts consecutive cycles whose drain
// THREW. Both are facts about outcomes, need no derivation, and cannot be outrun by a slow box, a
// long message, or the fallback path. A slow-but-working vault has noProgress === 0 no matter how
// many minutes a batch takes.
// 2, not 1: one barren pass can be a blip (a sidecar restart landing mid-cycle), and making the
// estimate blink on a blip is the very complaint that started this. Two consecutive is not a blip.
// ⚠️ Do NOT "simplify" this back to a timestamp. The residual latency (we learn nothing until
// drainOnce returns, which for a wedged queue can itself be minutes) is a GRANULARITY limit, not a
// window: the real fix is progress reporting per row/chunk from service.js. Filed, not faked.
const STALL_PASSES = 2;

export function embedEta(st, remaining, paused) {
  if (paused) return null;
  if (!(Number(remaining) > 0)) return null;
  const embedded = Number(st?.embeddedTotal) || 0;
  const activeMs = Number(st?.embedActiveMs) || 0;
  if (embedded <= 0 || activeMs <= 0) return null;
  // ⚠️ A FROZEN RATE IS STILL A COUNTDOWN THAT NEVER ARRIVES. Fixing the drainer to bank time only
  // on productive passes stops the estimate INFLATING, but a wedged queue then renders a stable
  // "1s left" forever — a `pending` that never reaches 0 (§3.9 predicted exactly this: "an ETA
  // over a pending that never reaches 0 is ∞"). service.js leaves a transiently-failed row pending
  // BY DESIGN, and a head-of-queue row that keeps timing out is retried with no attempt cap, so
  // this state is reachable TODAY, not theoretical.
  // We cannot fix that queue from here — but we must not price it. No progress in a long while ⇒
  // we do not know how long this takes, and saying so is the honest answer. The row keeps its
  // counts; it just stops promising a finish.
  // `barrenPasses`, NOT `noProgress`: the latter keys on `moved = embedded + failed + skipped`, so
  // a queue that FAILS every row keeps moved > 0 and never registers as stalled — while the
  // drainer's self-heal resurrects those rows every cycle, forever. `barrenPasses` asks the exact
  // question the ETA needs ("did anything EMBED?"). `embedErrs` covers the other shape: a drain
  // that THROWS completes no batch at all, so it can't be barren — it's absent.
  if ((Number(st?.barrenPasses) || 0) >= STALL_PASSES) return null;
  if ((Number(st?.embedErrs) || 0) >= STALL_PASSES) return null;
  const perItemMs = activeMs / embedded;
  return Math.max(0, Math.round((perItemMs * Number(remaining)) / 1000));
}

// ── L1 (categorize) + L2 (enrich) ETAs — the same measured-throughput shape as embedEta ──
// R2-review measured (M1, floor hardware): L1 41/min → ~31h for 76k, L2 8/min → ~153h. Together
// they are ~98% of the ~188h a user on the recommended model waits, and embed's ETA covers only
// the ~4h it takes — so R1's "real estimate" promise held for ~2% of the wall clock. These two
// close that gap. They read the drainer's own per-pass counters (drainer.js banks l1/l2 Total,
// ActiveMs, BarrenPasses in the categorize/enrich loops), NOT a clock or a background_jobs row.
//
// WHY PER-PASS BANKING SUFFICES (no mid-cycle window like embed's E8 needs): the embed loop is
// ≤200 batches × 50 = 10,000 rows/cycle (~4.2h) so its counters had to move MID-cycle. The L1/L2
// loops cap at 8 passes (drainer.js) and EACH pass banks its own active time + count the instant
// enrichCategoriesOnce/enrichNlpOnce returns — so the rate advances every ≤25 (L1) or ≤50 (L2)
// rows, which at 41/min (L1) and 8/min (L2) is ≤~36s and ≤~6min of freshness. A single L2 cycle
// can still run ~50min (8×50 rows at 8/min), which is EXACTLY why per-PASS — not per-cycle —
// banking is required; per-pass is sufficient because a pass is a bounded ≤50-row unit.
//
// The honest nulls mirror embedEta plus the two front-door blocks the categorize row already
// renders (paused / no approved on-box model): a countdown to a moment that will never arrive is
// not an estimate. `barren >= STALL_PASSES` is the outcome signal — the rate is unknowable
// (L1: the model keeps failing; L2: a non-empty batch enriched nothing) — never a time window
// (the embed lesson: "a rule you cannot afford to gate at its own timescale you cannot defend").
function throughputEta({ total, activeMs, barren, errs, remaining }) {
  if (!(Number(remaining) > 0)) return null;            // no work left → no countdown
  const done = Number(total) || 0;
  const ms = Number(activeMs) || 0;
  if (done <= 0 || ms <= 0) return null;                // nothing processed yet → no rate (mirrors embed's "nothing embedded yet")
  if ((Number(barren) || 0) >= STALL_PASSES) return null; // stalled → withdraw, don't price a queue that isn't shrinking
  // The embedErrs clause, per stage (#210 MED): `barren` sees a failure INSIDE a pass, but both
  // write paths can throw AROUND it (L1's updateCategories is outside service.js's row try; a
  // locked vault's updateNlp throws twice), and a rate that freezes at its last honest value
  // keeps promising — a constant "~18s left · running" forever, while the embed row on the same
  // screen goes honest. Two consecutive block throws ⇒ the rate is unknowable ⇒ withdraw.
  if ((Number(errs) || 0) >= STALL_PASSES) return null;
  const perItemMs = ms / done;
  return Math.max(0, Math.round((perItemMs * Number(remaining)) / 1000));
}

// EXPORTED for scripts/verify-l1l2-eta.mjs — the gate must call the function that renders the
// row, not re-implement it (the models-slice lesson: a re-implemented projection proves the stub).
export function categorizeEta(st, remaining, paused, noModel) {
  if (paused || noModel) return null;                   // waiting on a decision, not in flight
  return throughputEta({ total: st?.l1Total, activeMs: st?.l1ActiveMs, barren: st?.l1BarrenPasses, errs: st?.l1Errs, remaining });
}

export function enrichEta(st, remaining, paused, noModel) {
  if (paused || noModel) return null;
  return throughputEta({ total: st?.l2Total, activeMs: st?.l2ActiveMs, barren: st?.l2BarrenPasses, errs: st?.l2Errs, remaining });
}

// Embedding/enrichment are CONTINUOUS (a drainer embeds the backlog on a timer),
// not discrete jobs — so they're projected at READ time from the message counts
// rather than written as background_jobs rows. One synthetic row while a backlog
// exists. (Embedding == enrichment in V1: both = messages with embedding_768.)
//
// EXPORTED for scripts/verify-embed-eta.mjs, for the same reason categorizeProjection is: this is
// the function that renders the row, so the gate must call IT. A gate that re-implements the
// projection, or drives a stub of the drainer status, proves the stub — not the wiring (the
// models-slice lesson: deleting the field left that gate green).
export async function embedProjection(db, userId) {
  try {
    // Single source of truth. `pending` is COUNTED with the drainer's own predicate
    // (nlp_processed 0/NULL + content-bearing), so it counts work that will actually be
    // picked up and REACHES 0. It used to be the projection `total - embedded`, which
    // pinned this row at 'running' FOREVER on any vault holding a permanently
    // un-embeddable row — a stuck vault and a healthy one looked identical from here.
    // @see docs/DATA-READINESS-DESIGN-2026-07-15.md §3.3; PIPELINE-INTEGRITY §P1.2.
    const { embedded, total, pending } = await db.messages.embedBacklogCached(userId); // polled @2.5s → cached (see embedBacklogCached)
    if (pending <= 0) return null;                       // nothing left to pick up → not active
    let health = 'unknown';
    try { health = getEmbedderHealth()?.status ?? 'unknown'; } catch { /* supervisor down */ }

    // LIVENESS, not just backlog. `pending > 0` alone says NOTHING about whether anything is
    // actually running: this row rendered "Embedding messages · running" for a MONTH while the
    // drainer was skipping every cycle (a single-request embed service blocked /health, and the
    // skip was silent). A progress bar that can't tell "working" from "dead" hides the very
    // outage it exists to surface — so ask the drainer, and say STALLED when it isn't working.
    const st = (() => { try { return getEnrichDrainerStatus(); } catch { return null; } })();
    // The liveness verdict is deriveEmbedLiveness — a PURE, time-injected function so the
    // gate (verify-drainer-liveness.mjs) tests the decision that renders, not a copy. Its
    // history is the reason it exists: max(lastCycleAt, lastProgressAt) let the meaningless
    // 15s cycle heartbeat mask 25+ minutes of zero progress ("running" over a dead drain),
    // and treating `running` as healthy hid a cycle wedged on an await. See the function.
    const { stalled, starting, bad } = deriveEmbedLiveness({ st, health });
    // ⚠️ THIS ROW IS WHAT LETS THE PAUSE BE PERSISTED AT ALL (§3.9/R3a, D13). Persisting the
    // pause is only safe because it is "permanently visible with its remaining count" — that
    // guarantee is THIS row (and its categorize twin), not a promise elsewhere.
    // It is also newly load-bearing: R3 made the pause stop the EMBED drain, and until this
    // line the row read the drainer's liveness, not the user's choice. A paused vault still
    // stamps `lastCycleAt` every 15s (the cycle runs and skips the drain), so `stale` stays
    // false, `stalled` stays false, and this row rendered "Embedding messages · running" with
    // nothing embedding — §3.9 introducing the exact fabricated liveness §3.9 exists to remove.
    const paused = (() => { try { return isEmbedPaused(); } catch { return false; } })();
    return {
      id: 'embed',
      kind: 'embed',
      // Paused OUTRANKS 'needs attention': nothing is running because the OWNER stopped it.
      // A choice must never render as a fault (same rule as getLabelerHealth's 'paused').
      stage: paused ? `${KIND_LABELS.embed} · paused`
        : bad ? 'Embedder needs attention' : (starting ? 'Embedder starting' : KIND_LABELS.embed),
      model: EMBED_MODEL,                                // what's running
      process: paused ? null : PROCESS_LABELS.embed,     // nothing is on-device while paused
      done: embedded,
      total,
      remaining: pending,                                // D13's "also showing how much"
      // R1 (§3.9): a REAL estimate, from the drainer's own throughput. This was `null` with the
      // note "per-second rate not measured in V1" — true when written, and the reason §3.9 exists:
      // the 29-hour import announced itself as an unbounded spinner.
      etaSeconds: embedEta(st, pending, paused),
      status: paused ? 'paused'                          // waiting on a decision, not in flight
        : bad ? 'stalled' : 'running',                   // never claim "running" when it isn't — but a loading model is not an outage
      startedAt: null,
      finishedAt: null,
    };
  } catch {
    return null;
  }
}

// Context Engine L1 categorization is CONTINUOUS (the enrich drainer tags the backlog
// on a timer via the on-box model), not a discrete background_jobs row — so, like
// embedding, it's projected at READ time from the message counts. One synthetic row
// while a backlog exists. This is what makes the on-box model's heavy churn VISIBLE in
// the activity indicator instead of being invisible CPU/GPU load (the dormancy bug).
// EXPORTED for scripts/verify-model-consent.mjs (M8). It is the function that rendered
// "Categorizing messages · qwen3.5:4b · running" on a vault where nothing ran, so the gate
// must call IT — an earlier M8 asserted on the resolver instead and proved nothing about
// this projection. Not part of the route contract; do not call it from app code.
export async function categorizeProjection(db, userId) {
  try {
    const { tagged, total, pending } = await db.messages.categoriesBacklogCached(userId);
    if (pending <= 0) return null;                       // caught up → not active
    const paused = (() => { try { return isCategorizePaused(); } catch { return false; } })();
    // The drainer's measured L1 throughput (banked per pass) — the rate source for the ETA below.
    const st = (() => { try { return getEnrichDrainerStatus(); } catch { return null; } })();
    // null ⇒ the owner has not approved an on-box labeling model (§3.10c). NOTHING is
    // running: no model, no daemon woken, and the model may not even be on disk. Saying
    // "running" here would be the same lie the embed row told for a month.
    const model = await defaultLabelModel(db, userId);
    const noModel = !model;
    return {
      id: 'categorize',
      kind: 'categorize',
      // Surface the blocked states in the always-on indicator so a user who stopped the
      // churn — or never started it — sees pending work waiting, not just silence.
      // "no local model" is a legitimate STEADY STATE, not a transient (§3.5): it stays
      // until the owner approves one, and it must read as a choice, not a fault.
      stage: noModel ? `${KIND_LABELS.categorize} · no local model`
        : paused ? `${KIND_LABELS.categorize} · paused`
          : KIND_LABELS.categorize,
      model: model || null,                              // the APPROVED on-box labeling model, or none
      process: noModel ? null : PROCESS_LABELS.categorize, // nothing is on-device if nothing runs
      done: tagged,
      total,
      remaining: pending,
      // R2-review (§3.9): a REAL L1 estimate from the drainer's measured throughput (41/min ⇒ ~31h
      // for a 76k import). Was hardcoded `null` with "per-second rate not measured in V1" — true
      // when written, but the June sweep had mislabeled L1's rate as embedding's, which is why this
      // never-measured stage sat unpriced for a year. null on paused / no model / nothing tagged
      // yet / no work / a stalled model (categorizeEta enforces all five).
      etaSeconds: categorizeEta(st, pending, paused, noModel),
      // `paused` covers both: the work is waiting on a decision, not in flight. It is NOT
      // 'stalled' — nothing is broken; the user simply hasn't approved a model.
      status: (paused || noModel) ? 'paused' : 'running',
      startedAt: null,
      finishedAt: null,
    };
  } catch {
    return null;
  }
}

// Context Engine L2 semantic enrichment (entities + gist) is CONTINUOUS (the enrich drainer's
// nlp loop runs the on-box model on a timer), not a discrete background_jobs row — so, exactly
// like embed and categorize, it's projected at READ time from the message counts. One synthetic
// row while a backlog exists. Until this row existed L2 was INVISIBLE: the slowest stage (8/min ⇒
// ~153h for 76k, ~81% of the total wait) had no ETA and no feed entry at all — the app priced the
// one stage it could measure and left this one silent. Mirrors categorizeProjection: same
// noModel-is-a-choice handling (an unapproved on-box enrich model reads as paused, never a fault),
// same paused handling, plus a real ETA from the drainer's measured L2 throughput.
// EXPORTED for scripts/verify-l1l2-eta.mjs — the gate must call the renderer, not re-implement it.
export async function enrichProjection(db, userId) {
  try {
    const { done, total, pending } = await db.messages.nlpBacklogCached(userId);
    if (pending <= 0) return null;                       // caught up (no rows at nlp_processed = 2) → not active
    const paused = (() => { try { return isCategorizePaused(); } catch { return false; } })();
    // The drainer's measured L2 throughput (banked per pass) — the rate source for the ETA.
    const st = (() => { try { return getEnrichDrainerStatus(); } catch { return null; } })();
    // null ⇒ the owner has not approved an on-box enrich model (taskModels.enrich). NOTHING runs —
    // it is a legitimate steady state (§3.5), a CHOICE, not a fault (same rule as categorize).
    const model = await defaultEnrichModel(db, userId);
    const noModel = !model;
    return {
      id: 'enrich',
      kind: 'enrich',
      stage: noModel ? `${KIND_LABELS.enrich} · no local model`
        : paused ? `${KIND_LABELS.enrich} · paused`
          : KIND_LABELS.enrich,
      model: model || null,                              // the APPROVED on-box enrich model, or none
      process: noModel ? null : PROCESS_LABELS.enrich,   // nothing is on-device if nothing runs
      done,
      total,
      remaining: pending,
      // A real L2 estimate from the drainer's measured throughput (8/min ⇒ ~153h for a 76k import).
      // null on paused / no model / nothing enriched yet / no work / a stalled model.
      etaSeconds: enrichEta(st, pending, paused, noModel),
      // `paused` covers both waiting-on-a-decision states (stopped OR no model approved); it is NOT
      // 'stalled' — nothing is broken. Same shape as categorizeProjection.
      status: (paused || noModel) ? 'paused' : 'running',
      startedAt: null,
      finishedAt: null,
    };
  } catch {
    return null;
  }
}

function parseSqliteTs(ts) {
  if (!ts) return NaN;
  // SQLite datetime('now') → 'YYYY-MM-DD HH:MM:SS' (UTC, no zone). Make it ISO-UTC.
  return Date.parse(String(ts).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? '' : 'Z'));
}

function etaSeconds(row, nowMs) {
  const done = Number(row.step) || 0;
  const total = Number(row.total_steps) || 0;
  if (done <= 0 || total <= done) return null;          // no estimate before the 1st item / when complete
  const started = parseSqliteTs(row.started_at);
  const elapsed = nowMs - started;
  if (!(elapsed > 0)) return null;
  const perItem = elapsed / done;                        // overall average (robust across restarts)
  return Math.max(0, Math.round((perItem * (total - done)) / 1000));
}

// History-facing label for the inference kinds: the LIVE stage ("Thinking…" /
// "Replying…") reads oddly in the finished list ("Thinking… · Done 8m ago"), so a
// terminal inference row shows a clear noun of what it WAS instead. Only the inference
// kinds are remapped — describe/embed jobs keep their descriptive stage_label in history.
const INFERENCE_HISTORY_LABEL = {
  'inference:chat': 'Chat reply',
  'inference:channel': 'Channel reply',
};

function shape(row, nowMs) {
  const done = Number(row.step) || 0;
  const total = Number(row.total_steps) || 0;
  const terminal = row.status !== 'running';
  const stage = (terminal && INFERENCE_HISTORY_LABEL[row.kind])
    ? INFERENCE_HISTORY_LABEL[row.kind]
    : (row.stage_label || KIND_LABELS[row.kind] || row.kind);
  return {
    id: row.id,
    kind: row.kind,
    stage,
    model: row.model || null,                       // what's running (if the job recorded it)
    process: PROCESS_LABELS[row.kind] || null,      // what it's doing
    done,
    total,
    remaining: total > done ? total - done : 0,
    etaSeconds: etaSeconds(row, nowMs),
    status: row.status,
    stalled: !!Number(row.stalled),  // watchdog flag → "taking longer than usual" chip hint (Gap #4)
    startedAt: row.started_at,
    finishedAt: row.finished_at || null,
  };
}

export function portalActivityRouter({ db, userId, authenticatePortalRequest }) {
  if (!db) throw new Error('portalActivityRouter: db required');
  if (typeof authenticatePortalRequest !== 'function') throw new Error('portalActivityRouter: authenticatePortalRequest required');
  const router = express.Router();
  const auth = (req, res) => { const u = authenticatePortalRequest(req); if (!u) { res.status(401).json({ error: 'Unauthorized' }); return null; } return u; };

  // GET /activity — the rich feed: active jobs (with ETA) + recent history.
  router.get('/activity', async (req, res) => {
    if (!auth(req, res)) return;
    const now = Date.now();
    try {
      await db.activityFeed.reap(userId);               // flip dead 'running' rows → abandoned
      const rows = (await db.activityFeed.active(userId)).map((r) => shape(r, now));
      const embed = await embedProjection(db, userId);  // continuous embedding/enrichment (projected)
      const categorize = await categorizeProjection(db, userId); // continuous CE L1 tagging (projected)
      const enrich = await enrichProjection(db, userId); // continuous CE L2 semantic enrichment (projected)
      const active = [embed, categorize, enrich, ...rows].filter(Boolean); // pipeline order: embed → L1 → L2
      const recent = (await db.activityFeed.recent(userId, 8)).map((r) => shape(r, now));
      res.json({ active, recent });
    } catch {
      res.json({ active: [], recent: [] });
    }
  });

  // GET /pipeline/status — the compact header summary (one line).
  router.get('/pipeline/status', async (req, res) => {
    if (!auth(req, res)) return;
    const now = Date.now();
    try {
      await db.activityFeed.reap(userId);
      const rows = (await db.activityFeed.active(userId)).map((r) => shape(r, now));
      const embed = await embedProjection(db, userId);
      const categorize = await categorizeProjection(db, userId);
      const enrich = await enrichProjection(db, userId);
      const active = [embed, categorize, enrich, ...rows].filter(Boolean); // pipeline order: embed → L1 → L2
      const lead = active[0] || null;
      res.json({
        state: active.length ? 'running' : 'idle',
        count: active.length,
        currentStage: lead?.stage || null,
        model: lead?.model ?? null,                 // what model is working
        process: lead?.process ?? null,             // what process it's running
        progress: lead ? { completed: lead.done, total: lead.total } : null,
        etaSeconds: lead?.etaSeconds ?? null,
      });
    } catch {
      res.json({ state: 'idle', count: 0, currentStage: null, progress: null, etaSeconds: null });
    }
  });

  return router;
}

export default portalActivityRouter;
