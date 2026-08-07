// src/enrich/drainer.js — in-process enrichment for the REST server.
//
// The app spawns only the REST server — no separate `:8095` enrich listener and
// no consumer for its nudge — so UI-imported messages used to sit at
// nlp_processed=0 / embedding_768=NULL forever, and Generate then had nothing to
// cluster. This drains the embed backlog IN-PROCESS against the embed service
// (`:8091`): once on boot, on a timer, and on a post-import nudge.
//
// Robustness: it HEALTH-CHECKS `:8091` before each batch. drainOnce() mass-marks
// a batch failed (-1) if the embed call throws, and failed rows are never
// re-selected — so attempting a drain while the service is down would silently
// burn the backlog. Health-gating keeps rows pending (0) for a later retry.
import { createEmbedClient } from '../embed/client.js';
import { getMasterKey } from '../crypto/crypto-local.js';
import { localInfer } from '../inference/local.js';
import { createOllamaClient, classifyOllamaFault, OLLAMA_FAULT } from '../hardware/ollama.js';
import { createEnrichmentService, EMBED_MAX_ATTEMPTS } from './service.js';
import { createCategoryClassifier, DEFAULT_LABEL_MODEL } from './categories.js';
import { lookupModel } from '../inference/model-registry.js';
import { createMessageEnricher } from './enricher.js';
import { admit, CLASS } from '../core/compute-governor.js';
import { isImportQuiesced } from '../db/import-quiesce.js';

// Wall-clock budget for ONE cycle's L1+L2 (categorize + enrich) block. See the long note at its
// use site: cycle() is single-flight and the embed drain runs above the block, so an unbounded
// block (L2 alone can be ~50 min) freezes embedding for that whole time. 90 s is generous next to
// the 15 s tick — several L1 passes, or one L2 pass — while capping how long the embed drain can
// be locked out. Env-overridable for ops/tests only; the default is the contract.
const CATEGORIZE_CYCLE_BUDGET_MS = Number(process.env.MYCELIUM_CATEGORIZE_BUDGET_MS) || 90_000;

// ── Accurate, actionable copy per fault kind (OLLAMA_FAULT) ──────────────────
// The health surface used to hardcode "The local model runtime is not reachable." for EVERY
// pull/list fault — a lie on a fresh box where Ollama is up but the download failed for another
// reason (no network to the registry, disk full). Each message names WHAT is wrong and points
// at the remedy; the raw `detail` (ollama's own string) rides alongside on the localhost-only
// readiness surface (GET /api/v1/portal/readiness — unauthenticated by design, single-user V1;
// NEVER the content-free activity feed). Exported so verify:model-consent asserts the mapping
// directly (mutation-testable).
export const FAULT_MESSAGE = Object.freeze({
  [OLLAMA_FAULT.RUNTIME_UNREACHABLE]: 'The local model runtime (Ollama) isn’t reachable — is it running?',
  // Deliberately network-generic (not "the registry"): this kind covers a registry that is
  // unreachable/slow AND a non-2xx from the local daemon's own /api/pull, so it must not
  // misdirect the owner to check one specific hop (independent review, 2026-07-18).
  [OLLAMA_FAULT.DOWNLOAD_FAILED]: 'The model download failed — check your network connection, then retry.',
  [OLLAMA_FAULT.OUT_OF_SPACE]: 'Not enough disk space to download the model — free up space, then retry.',
  // TERMINAL: not a network problem — the host Ollama is too OLD for this model (registry 412), so
  // "check your network" would misdirect. The remedy is a runtime upgrade, and retrying is pointless
  // until it happens (see the pull backoff's terminal handling).
  [OLLAMA_FAULT.INCOMPATIBLE_RUNTIME]: 'Your Ollama runtime is too old for this model — upgrade Ollama, or let Mycelium manage its own.',
});
// A stored fault is `{ kind, detail }`. Unknown/legacy kinds fall back to the runtime message
// (fail-safe to the least-specific, never a blank) so a new kind can never render an empty line.
export function faultMessage(fault) {
  return FAULT_MESSAGE[fault?.kind] ?? FAULT_MESSAGE[OLLAMA_FAULT.RUNTIME_UNREACHABLE];
}

// Strip a home-dir USERNAME from an ollama infra string before it is stored as a fault `detail`.
// ollama's disk errors carry a models-dir path (e.g. `/Users/alice/.ollama/blobs/…`), and the
// only fault `detail` surface is the localhost-only readiness route — so this is low-stakes, but
// §1 ("if in doubt, don't log it") and the independent review both say don't ship a username we
// don't need. The meaningful tail ("no space left on device") and the reason are preserved; only
// the user segment of a home path becomes `<user>`. Registry HOSTS (registry.ollama.ai) are not
// touched — they are not home paths and are useful to see.
function scrubFaultDetail(s) {
  return String(s)
    .replace(/(\/(?:Users|home)\/)[^/\s]+/gi, '$1<user>')      // macOS / Linux
    .replace(/([A-Za-z]:\\Users\\)[^\\\s]+/gi, '$1<user>');    // Windows
}

// The live drainer for the booted vault. Set by startEnrichDrainer so a portal
// route (POST /portal/enrichment/trigger) can kick a drain WITHOUT threading the
// drainer handle through buildVaultSubApp — the drainer is created deep in
// completeBoot. Single-user / single-vault, so one module-level handle is exact.
let _current = null;

// User control for ALL on-box processing — the churn the user sees as "my computer is working
// a lot". Module-level: single-user / single-vault, so one flag is exact (same rationale as
// `_current`).
//
// SCOPE — it gates THREE stages, and the name now says so. It used to be `_categorizePaused`
// while already skipping the whole `if (!isEnrichProcessingPaused())` block, i.e. L1 AND L2.
// §3.9/R3 adds the third and most important one: THE EMBED DRAIN. That is the stage actually
// burning the CPU, so before this the user whose Mac was melting could pause labeling but not
// the thing melting it. The name lied about two stages; it is not inheriting a third.
//
// ⚠️ PERSISTED — AND THIS REVERSES A DELIBERATE DECISION. This comment used to read:
//   "NOT persisted across a restart by design — a restart resumes categorizing (the safe
//    default: never silently leave the vault permanently un-enriched)."
// That rationale is STILL TRUE, and it is not overridden — it is SATISFIED (design §3.9/R3a).
// The load-bearing word was "SILENTLY". Non-persistence was the only tool available to
// guarantee a vault is never quietly left half-processed: forget the pause, and it heals
// itself. Now the pause is PERMANENTLY VISIBLE WITH ITS REMAINING COUNT — the activity feed
// renders "· paused" plus `remaining` for both the categorize and embed rows, iff work is
// pending (portal-activity.js) — so the guarantee is met DIRECTLY instead of by overriding a
// choice the user made because their laptop was overheating. D13: "pausing it should honor it
// and only restart when you click restart."
// ⇒ THE VISIBLE REMINDER IS THE PRECONDITION FOR PERSISTING, not a nicety. If a change ever
// removes the paused indicator or its count from the feed, this decision reverts with it.
// ⚠️ SPLIT PER STAGE (QA R2-PIPECTL). This was a single `_processingPaused` gating all three
// on-box stages; the owner could only Stop/Resume EVERYTHING at once. The pipeline overview now
// wants a co-located Pause/Resume per stage (embed vs categorize), so the one flag becomes two:
//   • _embedPaused      — stops the embed drain + its self-heal write (the CPU-heavy vectoriser).
//   • _categorizePaused — stops the L1 label pass AND the L2 semantic-enrich pass (they share one
//                         Ollama-model block in cycle(), so one flag honestly gates both).
// The composite helpers below (pauseEnrichProcessing / isEnrichProcessingPaused) preserve the
// old "all of it" semantics for the global StatusPopover control and the reminder — see there.
let _embedPaused = false;
let _categorizePaused = false;
// D-132 (QA11) — the L2 semantic-enrich pass gets its OWN defer latch, distinct from
// _categorizePaused (which honestly gates L1+L2 together as the shared-model "pause").
// DEFER is an owner posture, not a pause: "run embed + L1 now, do the ~153 h L2 pass
// later" — the first-run answer to "responsive but not done for six days". Deferring
// L2 blocks nothing downstream (readiness has no L2 threshold; generate keys on
// embedded/points), which is exactly why the feed row must stay visible + honest.
let _enrichDeferred = false;
let _pauseRestored = false;           // latch: the persisted flags are read ONCE, at first cycle
// ── D-131(b): stalled-head BACKOFF constants ─────────────────────────────────
// After this many CONSECUTIVE no-progress cycles the drain stops hammering the
// head: it skips exponentially more cycles (2,4,8… capped) instead of re-feeding
// the same unembeddable head to the service every 15s forever — the zero-output
// core burn the operator measured (59,705/67,249 for 44s+, two cores pegged).
// BACKOFF, not row-poisoning: row state is untouched (the outage guard in
// service.js must keep its "never march a backlog to terminal" property), so the
// cost of a stuck head falls to a few probes per 10 minutes instead of a
// continuous burn. Any progress, a nudge, or a resume resets it instantly.
export const STALL_BACKOFF_AFTER = 3;        // consecutive stalled cycles before backing off
export const STALL_BACKOFF_MAX_CYCLES = 40;  // cap ≈ 10 min at the 15s tick

/** Kick the live enrichment drainer if one is running (no-op otherwise). */
/** Live drainer liveness for the activity feed — null when no drainer is running. */
export function getEnrichDrainerStatus() { try { return _current?.status?.() ?? null; } catch { return null; } }

/**
 * Labeler health — the third member of the supervisor-health convention, alongside
 * getEmbedderHealth() (embed/supervisor.js) and getTranscriberHealth() (transcribe/
 * supervisor.js). Same shape, same vocabulary, so readiness can carry one `models` slice
 * with three uniform members instead of a bespoke per-component vocabulary (§3.10b).
 *
 * No drainer ⇒ 'unknown' (a verify script, or before boot) — never a fabricated 'ok'.
 */
export function getLabelerHealth() {
  try {
    return _current?.labelerHealth?.()
      ?? { status: 'unknown', message: 'Labeling has not started.', detail: null, model: null, progress: null };
  } catch {
    return { status: 'unknown', message: 'Labeling has not started.', detail: null, model: null, progress: null };
  }
}

/**
 * Enricher health — the FOURTH member of the supervisor-health convention (embedder, labeler,
 * enricher, transcriber). L2 semantic enrichment had no health surface at all until now, which
 * is why a vault that approved labeling but not enrich ran L2 dormant and silent (§3.10b,
 * re-review 2026-07-16).
 *
 * No drainer ⇒ 'unknown' — never a fabricated 'ok'. Same fail-closed rule as getLabelerHealth.
 */
export function getEnricherHealth() {
  try {
    return _current?.enricherHealth?.()
      ?? { status: 'unknown', message: 'Enrichment has not started.', detail: null, model: null, progress: null };
  } catch {
    return { status: 'unknown', message: 'Enrichment has not started.', detail: null, model: null, progress: null };
  }
}

// DELIBERATE nudge — every caller of this export is a user action (portal
// trigger/retry/restart buttons, the resume paths, Settings-applied), so it may
// clear the stalled-head backoff and re-arm the once-per-episode bounce. The
// INGEST path (enqueueEnrichment — fired on EVERY chat/import save) calls the
// handle's nudge() directly with no options and must NEVER clear it: a stalled
// head + routine save activity would otherwise re-arm a fresh SIGKILL of the
// embed service per save — the kill storm the round-1 review reproduced (10
// saves → 11 SIGKILLs). Same deliberate-vs-automated split resetPullBackoff
// already lives by (see /enrichment/trigger's comment in portal-compat.js).
export function nudgeEnrichDrainer() { try { _current?.nudge({ clearStallBackoff: true }); } catch { /* best-effort */ } return Boolean(_current); }

/**
 * QA6 — EMBED BEFORE CATEGORIZE. Given ONE cycle's embed-loop observations, decide whether the
 * categorize + enrich stages should be DEFERRED to a later cycle so the two on-box stages never burn
 * the box at the same time (the operator's 24GB-crash report: "the embedding model still runs at the
 * same time as categorization"). Pure + exported so every clause is falsifiable directly, with no
 * 10,000-row integration drive — the same discipline as deriveEmbedLiveness.
 *
 * Defer IFF embed is BOTH (a) making progress and (b) not finished:
 *   progressing   = ran on a healthy, unpaused service, did not throw, and rows LEFT the pending set
 *   backlogRemains= the loop neither drained the queue (`scanned === 0`) nor broke on no-progress
 *
 * ⚠️ THE STARVATION GUARD IS THE `progressing` HALF. "Backlog remains" alone is TRUE for every way
 * embed can be broken — service down, vault locked, an un-embeddable head of queue, the owner's own
 * Stop, a throwing drain — and deferring on it would deadlock L1+L2 permanently behind a stage that
 * will never finish. So a backlog that is NOT being drained releases categorize immediately; only a
 * backlog that IS shrinking holds it. Distinguishing "remains and progressing" from "cannot progress"
 * is the difference between a scheduler and a deadlock.
 *
 * Self-correcting: on a caught-up vault `embedDrained` is true on the first pass (scans 0) ⇒ false,
 * no extra read; in the rare case the final pass drained the last rows AT the 200-cap, the next 15s
 * tick scans 0 and releases. The decision is recomputed from scratch every cycle — no latch to wedge.
 *
 * @param {{embedOk:boolean, embedPaused:boolean, embedThrew:boolean, embedMoved:number,
 *          embedDrained:boolean, embedStalledOut:boolean}} o
 * @returns {boolean} true ⇒ defer categorize + enrich this cycle
 */
// ⚠️ 2026-07-26 (D-047 ↻1) — THIS FUNCTION IS NO LONGER THE ORDERING GUARANTEE. It shipped as
// #329's answer to D-047 and it was the ONLY thing keeping embed ahead of categorize; on the
// operator's shipped-v0.1.13 5.5K import it did not hold, and here is precisely why.
//
// Read the `progressing` half again: EVERY way embedding can fail to move — the service is
// unhealthy (`embedOk` false), the drain THREW (a locked vault, SQLITE_BUSY), the governor refused
// the BULK ticket (`embedMoved` stays 0), or the loop broke on no-progress (`embedStalledOut`) —
// evaluates to "do NOT defer", i.e. RELEASES categorize over the whole corpus. That is deliberate
// and it is still correct as an anti-deadlock rule (see the starvation-guard note above): a
// categorize stage held hostage by an embed stage that will never finish is worse than disorder.
// But it means the ordering held only while embedding was SUCCEEDING, which is the one case where
// nobody needed it.
//
// The live trigger was `drainOnce`'s OUTAGE SIGNATURE (enrich/service.js): a pass with several
// candidates and zero embeds writes NOTHING — no counter, no state — and returns
// `{scanned:50, embedded:0, failed:0, skipped:0}`. The drainer reads `moved === 0`, sets
// `embedStalledOut`, and this rule hands the box to categorize. Qwen then tagged 772 rows past a
// stalled embed count of 445: `tagged > embedded`, the reported symptom. The compute governor
// could not have caught it either — embed takes a BULK ticket and categorize a RESIDENT one, which
// are ORTHOGONAL gates; the governor serializes MEMORY, never STAGES.
//
// So the guarantee moved to where it is a fact instead of a schedule: `selectPendingCategories`
// (src/db/messages.js) now requires `embedding_768 IS NOT NULL`, making the tagged set a subset of
// the embedded set by construction, at every entry point.
//
// THIS RULE STAYS, DEMOTED TO WHAT IT ACTUALLY IS: a MEMORY policy. Deferring the L1+L2 block while
// embedding is actively draining keeps Ollama's weights off the box while the ONNX drain has it —
// the D-001 concern — and that is worth keeping. It is no longer load-bearing for CORRECTNESS, so
// its release valves are no longer holes. Do not delete it; do not promote it back.
export function deferCategorizeForEmbed(o) {
  const progressing = Boolean(o?.embedOk) && !o?.embedPaused && !o?.embedThrew && Number(o?.embedMoved || 0) > 0;
  const backlogRemains = !o?.embedDrained && !o?.embedStalledOut;
  return progressing && backlogRemains;
}

/**
 * Clear the live service's in-memory L1 label-attempt counters — the companion to
 * db.messages.resetEnrichmentGiveUps() (the retry-failed route calls both). Without
 * this, a row the route just reset to pending would still carry its old counter and
 * terminal-mark again on its first failure instead of getting a fresh budget.
 * No-op when no drainer is running (the counters die with the process anyway).
 */
export function resetEnrichGiveUpCounters() { try { _current?.resetLabelAttempts?.(); } catch { /* best-effort */ } return Boolean(_current); }

/**
 * SELF-HEAL: re-queue rows that failed for a NON-content reason (service
 * down/slow/timeout) — every cycle, while the embed service is healthy.
 *
 * The single exclusion is the attempt-cap terminal marker 'embed-capped:N'
 * (service.js EMBED_CAPPED_MARK): those rows were retired on purpose after N
 * counted attempts against a provably-up service, and reclaiming them here
 * would re-create the heal→fail→heal loop the cap ends (pending would never
 * settle; the activity labels would never clear). Their recovery paths are
 * reclaimGaveUpRows (once per boot) and POST /portal/enrichment/retry-failed.
 * Every OTHER -1-without-vector row is still reclaimed, unconditionally.
 *
 * Exported for verify-enrich-resilience.mjs, which runs THIS function against a
 * real sqlite fixture — the gate exercises the statement that ships, not a copy.
 */
export async function selfHealStrandedEmbeds(db, userId) {
  const r = await db.rawQuery(
    "UPDATE messages SET nlp_processed = 0, nlp_error = NULL WHERE user_id = ?"
    + " AND nlp_processed = -1 AND embedding_768 IS NULL"
    + " AND (nlp_error IS NULL OR nlp_error NOT LIKE 'embed-capped:%')",
    [userId],
  );
  // D-132 (QA 2026-08-05): bump ONLY when rows actually changed. This runs
  // EVERY cycle; an unconditional bump re-armed the write generation on a
  // fully idle vault, so readiness's multi-second decrypt scan re-ran at every
  // TTL expiry — ~45% server CPU with the window open and everything paused.
  // A 0-change UPDATE proves the numbers cannot have moved.
  if ((r?.meta?.changes ?? 0) > 0) db.messages?.noteBacklogWrite?.();
}

/**
 * BOOT RECLAIM: give every gave-up row ONE fresh chance per drainer start —
 * capped embeds (nlp_processed -1 + 'embed-capped:N', counter cleared) and
 * label-gave-up rows (categories_processed -1 → 0). Capped is set-aside, not
 * deleted: a new boot means new conditions (service fixed, model swapped), so
 * the previous run's verdicts are retried once; between boots they hold, so the
 * backlog still settles. Exported for verify-enrich-resilience.mjs (same
 * real-statement rule as selfHealStrandedEmbeds).
 */
export async function reclaimGaveUpRows(db, userId) {
  const r1 = await db.rawQuery(
    "UPDATE messages SET nlp_processed = 0, nlp_error = NULL WHERE user_id = ?"
    + " AND nlp_processed = -1 AND embedding_768 IS NULL AND nlp_error LIKE 'embed-capped:%'",
    [userId],
  );
  const r2 = await db.rawQuery(
    'UPDATE messages SET categories_processed = 0 WHERE user_id = ? AND categories_processed = -1',
    [userId],
  );
  // D-132: change-gated for the same reason as selfHealStrandedEmbeds above.
  if (((r1?.meta?.changes ?? 0) + (r2?.meta?.changes ?? 0)) > 0) db.messages?.noteBacklogWrite?.();
}

/**
 * Clear the pull-failure backoff — the owner's EXPLICIT "try again". Deliberately NOT cleared by
 * nudgeEnrichDrainer(): chat and import saves nudge enrichment PER SAVE, so a nudge-cleared
 * backoff would re-arm the storm during any conversation. Only a deliberate user action (the
 * trigger route) resets it; a model CHANGE needs no reset (the map is keyed per model), and a
 * restart resets naturally (in-memory).
 */
export function resetPullBackoff() { try { _current?.resetPullBackoff?.(); } catch { /* best-effort */ } return Boolean(_current); }

// ── D-131(c): the embed-service bouncer hook ─────────────────────────────────
// The pause flag stops the DRAINER from sending more work, but it cannot stop
// compute already running/queued inside the single-threaded Python service —
// the operator watched `processing.paused: true` beside embed-service.py at
// 99.3% CPU (QA live confirmation, 2026-08-04). Killing that compute belongs to
// the embed SUPERVISOR (it owns the process); the drainer only signals. Wired by
// server-rest (setEmbedServiceBouncer → bounceEmbedService) — the drainer never
// imports the supervisor, same decoupling rule as onSettled/jobs.js. Fail-soft:
// unwired (tests, verify scripts) → no-op. Fire-and-forget: a pause must never
// block on a kill, and a bounce failure only means the service keeps its current
// batch — the drainer still stops sending.
let _serviceBouncer = null;
export function setEmbedServiceBouncer(fn) { _serviceBouncer = typeof fn === 'function' ? fn : null; }
function fireEmbedServiceBounce(why) {
  try { const p = _serviceBouncer?.(why); if (p && typeof p.catch === 'function') p.catch(() => {}); }
  catch { /* never let a bounce failure break a pause */ }
}

/**
 * STOP all on-box processing — the embed drain AND the L1/L2 passes (§3.9/R3).
 *
 * IN-MEMORY ONLY. The caller PERSISTS FIRST and applies second (portal-compat.js), because a
 * pause that evaporates on restart is exactly the dishonesty D13 names: applying without
 * persisting is INVISIBLE divergence, while refusing to apply is a visible, reported failure.
 */
export function pauseEnrichProcessing() {
  // D-131(c): bounce only on the false→true EDGE — the pause routes fire per
  // POST, and a double-clicked Pause must not SIGKILL the freshly-respawning
  // service again (round-1 review #4).
  const wasEmbedPaused = _embedPaused;
  _embedPaused = true;
  _categorizePaused = true;
  if (!wasEmbedPaused) fireEmbedServiceBounce('pause'); // a pause must IDLE the CPU, not just stop new sends
  return true;
}
/** RESUME processing and kick a cycle immediately so progress moves at once. */
export function resumeEnrichProcessing() {
  _embedPaused = false;
  _categorizePaused = false;
  nudgeEnrichDrainer();
  return true;
}
/**
 * Is on-box processing paused by the user? Composite = ANY stage paused (embed OR categorize).
 * This is the reminder's whole point (readiness.processing.paused → the "Processing paused · Resume"
 * banner): a pause in EITHER stage is a pause in effect the owner should be nudged to lift. The old
 * single-flag semantics ("all of it") is preserved by pauseEnrichProcessing/resumeEnrichProcessing,
 * which flip both together for the GLOBAL StatusPopover control.
 */
export function isEnrichProcessingPaused() { return _embedPaused || _categorizePaused; }

// ── Per-stage pause (QA R2-PIPECTL) ──────────────────────────────────────────
// Each stage's Pause/Resume is IN-MEMORY ONLY; the route PERSISTS FIRST and applies second
// (portal-compat.js), for the same D13 reason the composite does — a pause that evaporates on
// restart is the invisible divergence D13 exists to remove. Resume nudges a cycle so the resumed
// stage moves at once. Resumable by construction: both drains re-select their pending set every
// cycle, so pausing loses nothing.
export function pauseEmbed() { const was = _embedPaused; _embedPaused = true; if (!was) fireEmbedServiceBounce('pause'); return true; }
export function resumeEmbed() { _embedPaused = false; nudgeEnrichDrainer(); return true; }
export function isEmbedPaused() { return _embedPaused; }
export function pauseCategorize() { _categorizePaused = true; return true; }
export function resumeCategorize() { _categorizePaused = false; nudgeEnrichDrainer(); return true; }
export function isCategorizePaused() { return _categorizePaused; }
// D-132 — defer/resume the L2 semantic-enrich pass only (route persists FIRST, applies
// second — portal-compat.js — same D13 rule as the pauses above).
export function deferEnrich() { _enrichDeferred = true; return true; }
export function resumeEnrich() { _enrichDeferred = false; nudgeEnrichDrainer(); return true; }
export function isEnrichDeferred() { return _enrichDeferred; }
// NB: there is deliberately no in-memory `pausedAt`. WHEN the owner paused is persisted
// (settings.enrichProcessingPausedAt) and returned by the pause route; §3.2's
// readiness.processing.pausedAt will read it from settings when that slice is built (it is
// NOT built — B never shipped it). An unread module variable claiming to "feed the reminder"
// is the #190 pattern, not a head start.

/**
 * Restore the persisted pause (§3.9/R3, D13) — ONCE, at the drainer's first cycle.
 *
 * ⚠️ FAIL-CLOSED IN THE DIRECTION THAT RUNS. A settings read that FAILS must resolve to
 * NOT-PAUSED, never to paused: the old non-persistence rationale still picks the direction —
 * "never silently leave the vault permanently un-enriched" — and a vault frozen forever by a
 * transient read error would be exactly that, with no user choice behind it. Only an explicit,
 * successfully-read `true` stops the vault.
 */
async function restorePauseOnce(db, userId, log) {
  if (_pauseRestored) return;
  try {
    const s = await db?.users?.getSettings?.(userId);
    // ⚠️ LATCH ONLY AFTER A SUCCESSFUL READ. It used to be set on ENTRY, before the await — so
    // ONE transient throw (SQLITE_BUSY at boot, this codebase's most-documented failure class,
    // and boot is peak contention) burnt the latch and the persisted pause was NEVER re-read:
    // the drain ran forever while every later settings read still said `paused: true`, with no
    // log and no retry. That is D13's SILENT UNDO — the exact thing this whole change exists to
    // remove — landing on the CPU-burning stage. The comment below picks the fail-soft
    // direction ("a read error must not freeze the vault forever"); latching first overshot it
    // into "a read error UNFREEZES the vault forever" (independent review, 2026-07-16).
    // "Read once" means once SUCCESSFULLY, not once attempted. A failed read costs one retry
    // per 15s cycle until it lands — cheap, and self-healing.
    _pauseRestored = true;
    // Per-stage restore (R2). New vaults persist enrichEmbedPaused / enrichCategorizePaused; a
    // vault paused under the OLD single flag carries only enrichProcessingPaused, which paused
    // everything — so honour it as BOTH stages paused (legacy migration). Only an explicit,
    // successfully-read `true` stops a stage (fail-closed to RUNNING otherwise — see below).
    const legacy = s?.enrichProcessingPaused === true;
    if (s?.enrichEmbedPaused === true || legacy) _embedPaused = true;
    if (s?.enrichCategorizePaused === true || legacy) _categorizePaused = true;
    // D-132: the L2 defer is its own key — NOT implied by legacy (legacy pause already
    // stops L2 via _categorizePaused). Only an explicit, successfully-read true defers.
    if (s?.enrichL2Deferred === true) _enrichDeferred = true;
    if (_embedPaused || _categorizePaused) {
      const which = _embedPaused && _categorizePaused ? 'processing' : (_embedPaused ? 'embedding' : 'categorizing');
      log(`[enrich] ${which} is PAUSED by the owner (persisted) — resume from the activity panel`);
    }
  } catch {
    // Fail-soft to RUNNING **for this cycle only**, deliberately (see above): the vault keeps
    // working rather than freezing on a hiccup, and the next cycle re-reads. Message is a
    // CONSTANT — never the error text (§1: no user content, paths, or driver strings in logs).
    log('[enrich] could not read the saved pause setting — retrying next cycle');
  }
}

// ── THE APPROVAL *IS* THE MODEL SETTING (design §3.10c) ──────────────────────
// There is no separate consent flag. `settings.taskModels.<task>.model` is BOTH the
// choice and the approval, exactly as whisper already works (transcribeModel unset ⇒
// 'no_model' ⇒ nothing downloads, portal-transcription.js). Unset ⇒ we resolve NOTHING,
// and the drainer never wakes Ollama and never pulls.
//
// ⚠️ THIS IS WHY THE FALLBACK IS GONE. It used to default to DEFAULT_LABEL_MODEL, and that
// single default was the whole reason a fresh vault silently downloaded 3.4GB (qwen3.5:4b)
// — plus the Ollama RUNTIME it needs (ollama-daemon.js autoInstall) — with no prompt, no
// progress, and no way to decline. Three of the four local models already required consent
// (embedding is bundled, whisper and Qwen3-TTS voice are click-to-download); labeling was the lone
// offender. This makes the outlier behave like the majority.
//
// DEFAULT_LABEL_MODEL survives as the RECOMMENDATION (what the Intelligence step proposes,
// via role-models.js ROLE_RECOMMENDATIONS.labeling) — never as a SILENT DEFAULT (what runs
// unasked). That distinction is the entire fix; do not "helpfully" restore the fallback.

/**
 * The APPROVED on-box labeling model for this vault, or null if the owner has not approved
 * one. Labeling is on-box by design (bulk + privacy) — this resolves a LOCAL model NAME,
 * not a cloud provider.
 *
 * FAIL-CLOSED: any read error → null (no model), never a default. A settings read that
 * fails must not be read as consent — the old fail-soft-to-default did exactly that.
 */
export async function defaultLabelModel(db, userId, fallback = null) {
  try {
    const s = await db?.users?.getSettings?.(userId);
    const m = s?.taskModels?.categorize?.model;
    if (typeof m === 'string' && m.trim()) return m.trim();
  } catch { /* fail-closed → no model */ }
  return fallback;
}

/**
 * The APPROVED on-box model for L2 message enrichment (semantic entities + gist), or null.
 * Its own SETTING (`taskModels.enrich`) — which is why it has its own health member below.
 *
 * ⚠️ THE APPROVAL HISTORY, because this line has now been wrong in BOTH directions:
 *   • It once said "approving labeling in the Intelligence step sets both" — false at the time.
 *   • It was then corrected to "NOTHING sets both: PUT writes exactly ONE task per call" —
 *     which THIS increment made false again (2026-07-16), and which had the perverse effect of
 *     denying the very design the branch implements.
 * The truth, stated once: the SETTINGS are independent (two keys, two health members), but the
 * Intelligence screen approves Understanding = {categorize, enrich} as ONE choice, and the
 * route fans out — `PUT /providers/task-models {function:'understanding', model}` writes BOTH
 * (portal-providers.js; gate M8 in verify-task-models.mjs). The per-task path still exists and still writes exactly one,
 * so a NON-screen caller can still approve them separately — which is why the enricher keeps
 * its own report rather than inheriting the labeler's.
 *
 * It is no longer STRUCTURALLY ABSENT, which was the actual defect: the dormancy had no report
 * anywhere — readiness's `models` slice carried {embedder, labeler, transcriber} and
 * portal-activity projects only embed + categorize. getEnricherHealth() (below) is now the
 * fourth member of that slice, so enrich is reported on exactly the same terms as the labeler.
 * The SETTING's independence stays (two keys); what changed is that the screen no longer makes
 * the user reason about them separately (operator decision, 2026-07-16).
 *
 * ⚠️ DO NOT read that as "the user can now SEE it". The slice is SERVED — GET /api/v1/portal/
 * readiness (server-rest.js) returns it, and `models` is in readiness.js's ALL, so a slice-less
 * call carries it — but nothing RENDERS it: `portal-app/src` has zero consumers of models.*
 * (verified 2026-07-16). Equally true of `labeler`, which M added the same way. This buys
 * PARITY — enrich is no longer the one on-box task missing from the model — not a visible
 * indicator. (Both halves matter: an earlier draft of this note over-claimed "a state you can
 * SEE", and its own correction then under-claimed "no route serves it". The route serves it;
 * the renderer is what's missing.)
 *
 * STILL OPEN (recorded, not papered over): whatever renders `models` must render four members,
 * not three; increment I's function map owes `enrich` a home — §3.11b's table lists six
 * functions and covers only three of INFERENCE_TASKS' six (harness, reflection and enrich have
 * none); and portal-activity has no enrich PROJECTION row (that needs an nlp-backlog counter —
 * verified absent: only embed + categories have one, and a third polled full-table decrypt
 * scan is a perf decision, not a comment fix).
 *
 * Fail-closed → null.
 */
export async function defaultEnrichModel(db, userId, fallback = null) {
  try {
    const s = await db?.users?.getSettings?.(userId);
    const m = s?.taskModels?.enrich?.model;
    if (typeof m === 'string' && m.trim()) return m.trim();
  } catch { /* fail-closed → no model */ }
  return fallback;
}

export function startEnrichDrainer({
  db,
  userId,
  intervalMs = 15000,
  embed = createEmbedClient(),
  log = (m) => process.stderr.write(`${m}\n`),
  onSettled,
  // The on-box Ollama daemon (lazy: ensureUp() adopts-or-spawns, single-flight, never throws).
  // L1 categorization runs on this local model; the daemon is LAZY and nothing else on the
  // enrich path wakes it, so the cycle wakes it on demand (below). Null in contexts with no
  // local model (tests / model-less hosts) → L1 simply stays pending, fail-soft.
  daemon = null,
  // The APPROVED on-box labeling model, when a caller wants to inject one directly (tests).
  // NULL by default — and that is the consent gate, not an oversight: unset ⇒ nothing is
  // resolved, nothing is woken, nothing is pulled (§3.10c above). It is NOT a fallback for
  // an unset setting; qwen3.5:4b is the RECOMMENDATION (role-models.js), which the
  // Intelligence step offers and the owner approves — writing it to settings.taskModels.
  labelModel = null,
  // Ollama model-management client (listInstalled + pullModel). Injectable so the gate can
  // drive the pull offline. In production leave it null → resolved LAZILY per use from the
  // daemon's EFFECTIVE base (ollamaClient() below), so after an alt-port self-heal the drainer
  // pulls/lists against the healed port instead of the squatter on :11434.
  ollama = null,
  // Context Engine L1: per-message domain+register tagging via the on-box model (cheap,
  // private; format:'json' constrains the reply). INJECTABLE so the gate can drive it offline.
  // In production leave it null → the cycle resolves the model each tick from settings (below)
  // so a Settings → Intelligence change takes effect without a restart. A model outage leaves
  // rows pending (self-heals next cycle), never poisons a row.
  classify = null,
  // L2 message enricher (semantic entities + gist), the exact SIBLING of `classify` for the
  // enrich stage. INJECTABLE so a gate can drive L2 offline and deterministically (the ETA
  // wiring gate needs real rows to actually enrich, the way `classify` lets it drive L1). In
  // production leave it null → messageEnricher() builds the real on-box enricher each tick from
  // the resolved model. A no-op in prod (`typeof enrich === 'function'` is false), a test seam
  // otherwise — same pattern, same safety as `classify`.
  enrich = null,
  // Resolve the APPROVED on-box labeling model NAME from the per-task setting (categorize is
  // on-box by design — see INFERENCE_TASKS). null ⇒ not approved ⇒ labeling pauses honestly.
  // The SAME resolved name feeds the pull below, so an owner-chosen model is what gets pulled.
  resolveLabelModel = () => defaultLabelModel(db, userId, labelModel),
  // L2 message enrichment (semantic entities + gist) model resolver — its OWN setting
  // (taskModels.enrich), same consent rule, same null-means-not-approved.
  // ⚠️ THE FALLBACK IS `null`, NOT `labelModel`. It used to be `labelModel` — i.e. the model
  // approved for LABELING was the fallback for the ENRICH setting, so a caller injecting
  // labelModel would silently make a labeling-only approval count as enrich consent, and
  // enricherHealth would report 'ok' naming it. Inert in production (server-rest passes no
  // labelModel, and nothing else injects it — audited), which is exactly why it survived: a
  // consent crossover that no test could see, so it is closed rather than commented.
  //
  // ⚠️ WHY IT IS STILL WRONG NOW THAT ONE APPROVAL CAN SET BOTH. An earlier version of this
  // line justified the fix with "the Intelligence copy says each on-box task is approved
  // SEPARATELY". That is not a rule to lean on: it is SCOPED, not universal — true of the
  // per-task screen shipping today (AISettings' two on-box selects → the per-task route, which
  // writes exactly one), and false of the function path (role-models.js: Understanding =
  // {categorize, enrich}; portal-providers.js fans out; gate M8 in verify-task-models.mjs).
  // A justification that flips with which screen is mounted is not a justification.
  // The real reason is sharper and survives both:
  // consent must be EXPLICIT. `{function:'understanding'}` approving both is the OWNER'S choice
  // and it WRITES BOTH SETTINGS — `taskModels.enrich` genuinely records it. A resolver fallback
  // invents consent nobody gave and records it in NO SETTING: `taskModels.enrich` stays unset
  // while the code behaves as though it were set (and enricherHealth then reports 'ok' naming a
  // model the owner never approved — see 8 lines up; "nowhere" would contradict that). Joint
  // approval is a decision; an implicit fallback is a lie.
  // (independent review ×3, 2026-07-16 — this site survived two sweeps that claimed to be
  // complete, in the file both of them edited.)
  resolveEnrichModel = () => defaultEnrichModel(db, userId, null),
  // db.activityFeed — a 3.4GB pull is the longest unattended thing the app does, so it
  // publishes to the ONE progress surface (`model-pull`, design §3.10e) instead of being
  // log-only. OPTIONAL: absent ⇒ no publishing, identical behaviour otherwise.
  activityFeed = db?.activityFeed || null,
} = {}) {
  // Re-arm the restore latch: "read the persisted pause ONCE" means once per DRAINER, not once
  // per process. Module-level like `_current` (single-vault) — but a process that opens a
  // second vault, and every gate that starts a second drainer, must still read the flag.
  _pauseRestored = false;
  // Ollama model-management client, resolved at USE time from the daemon's EFFECTIVE base so it
  // follows an alt-port self-heal (ollama-daemon.js getBaseUrl). An injected `ollama` (tests/gate)
  // wins; otherwise a fresh client on the daemon's base — which is the healed alt port once
  // daemon.ensureUp() has run this cycle (it runs before ensureLabelModel below), else the default.
  const ollamaClient = () => ollama || createOllamaClient({ baseUrl: daemon?.getBaseUrl?.() });
  const svc = createEnrichmentService({ messages: db.messages, embed, getMasterKey, classify });
  let running = false;
  let _quiesceNoted = false; // D-128: log the stand-down/resume transition once, not every 15s
  let pending = false;
  let _cappedReclaimed = false; // boot reclaim of gave-up rows runs ONCE per drainer start
  let _skips = 0; // consecutive cycles skipped because the embed service looked unhealthy
  let _embedErrs = 0; // consecutive cycles whose embed block THREW (throttles the log; see the guard)
  // ms of the last cycle that RAN. ⚠️ Meaning changed 2026-07-15: it used to mean "got past
  // the health gate", because the gate returned from the whole cycle. Now the gate only
  // skips EMBEDDING, so a cycle runs (and stamps this) even with :8091 dead — it labels.
  // Liveness of the CYCLE, not evidence that embedding happened. `_skips`/`health` say that.
  let _lastCycleAt = 0;
  let _lastProgressAt = 0; // ms of the last cycle that actually embedded something
  // R1's RATE SOURCE (§3.9). Throughput = messages embedded ÷ time ACTUALLY SPENT EMBEDDING.
  // ⚠️ NOT wall-clock elapsed. Elapsed-since-start includes every second the drainer was idle
  // (caught up, backlog empty) or PAUSED — and R3 just made pausing a first-class, persisted,
  // possibly-overnight state. A vault paused for an hour and resumed would compute a per-item
  // cost ~60x its real one and render "about 3 days left" on a job that takes an hour. §3.9
  // exists to stop the app lying about cost; an ETA derived from idle time is that lie with a
  // progress bar. So: measure only the drain loop's own time.
  let _embeddedTotal = 0;  // messages embedded since this drainer started
  let _embedActiveMs = 0;  // ms spent inside the drain loop ON PASSES THAT EMBEDDED (see the bank)
  // Consecutive passes that ATTEMPTED work and embedded nothing. ⚠️ It never used to reset, so
  // "consecutive" was false — it was a lifetime counter wearing a consecutive name, and only the
  // log throttle read it so nothing noticed. It resets on progress now, which makes the name true.
  let _noProgress = 0;
  // D-131(b): backoff state (see the module constants above). _stallBackoffCycles
  // counts embed-drain cycles still to SKIP; _stallBounced latches the one-per-
  // episode service bounce (the wedged service, not the rows, is often the burn).
  let _stallBackoffCycles = 0;
  let _stallBounced = false;
  let _embedStallBackoff = false; // reported: this cycle skipped the drain (backoff)
  // Consecutive BATCHES that embedded nothing — the ETA's stall signal (R1/§3.9).
  //
  // ⚠️ WHY NOT REUSE `_noProgress`: it keys on `moved === 0`, and `moved = embedded + failed +
  // skipped`. A pass that FAILS every row keeps moved > 0, so `_noProgress` never increments even
  // though NOTHING EMBEDDED — and the self-heal at the top of each cycle resurrects those `-1`
  // rows, so the vault poisons and resurrects the same head forever. Demonstrated: 2,950 failed
  // writes, 2,900 self-heals, `noProgress` and `embedErrs` both 0, and the feed still rendering a
  // frozen "~0s left" over a backlog that can never drain (independent review, 2026-07-17).
  // `moved` is a proxy for "something happened"; the ETA needs "SOMETHING EMBEDDED", which is
  // exactly `batchEmbedded > 0` — already computed at the bank below. Ask the precise question.
  let _barrenPasses = 0;
  // ── L1 (categorize) + L2 (nlp enrich) THROUGHPUT, same shape as the embed counters above ──
  // The measured rates (M1, floor hardware): embed 313/min · L1 41/min (~31h for 76k) · L2 8/min
  // (~153h) — so the two on-box-model stages are ~98% of the wall clock the user waits, and until
  // now only embed carried an ETA. Banked PER PASS inside each loop below (NOT per cycle), for the
  // same reason embed is: an L2 cycle is ≤8 passes × batchSize 50 = 400 rows, which at 8/min is
  // ~50 MINUTES — so a per-cycle bank would freeze the rate for the whole run. Active time, not
  // elapsed; a pass that tags/enriches nothing prices nothing. `barren` is the honest-null signal
  // (the rate is unknowable ⇒ withdraw the estimate), reset the instant real work lands.
  let _l1Total = 0;   // messages categorized (L1) since start — the L1 rate's numerator
  let _l1ActiveMs = 0; // ms spent in L1 passes that TAGGED something — the denominator
  let _l1Barren = 0;  // consecutive L1 passes that FAILED (model down) without tagging — see the bank
  let _l2Total = 0;   // messages semantically enriched (L2) since start — the L2 rate's numerator
  let _l2ActiveMs = 0; // ms spent in L2 passes that ENRICHED something — the denominator
  let _l2Barren = 0;  // consecutive L2 passes that enriched nothing of a non-empty batch — see the bank
  // Consecutive cycles whose L1/L2 BLOCK threw — the exact sibling of `_embedErrs`, and for the
  // exact reason (#210 review, MED): the barren counters can only move INSIDE a pass, but both
  // write paths can throw AROUND the pass. L1's updateCategories sits OUTSIDE the row's try
  // (service.js — only fn(content) is guarded), so a write throw propagates out of
  // enrichCategoriesOnce entirely; L2 on a locked vault throws in updateNlp AND in the catch's
  // −1 write. Both used to land in cycle()'s outer catch — no bank, no failed, no barren — so the
  // counters FROZE at their last honest value and the rows rendered a constant "~18s left ·
  // running" forever, while the embed row on the SAME screen went honest (embedErrs ≥ 2
  // withdraws it). Asymmetric honesty is the §3.9 plausible-wrong-number class. Same semantics
  // as _embedErrs: incremented when the block throws, reset where the pass banks (progress
  // outranks a throw — a cycle that tags 25 rows and THEN throws is still shrinking `pending`)
  // and after any non-throwing block run.
  let _l1Errs = 0;
  let _l2Errs = 0;
  // ── QA6: EMBED BEFORE CATEGORIZE (stage serialization) ──────────────────────────────────────
  // TRUE while THIS cycle deferred the L1+L2 block because the embed stage still had a backlog it
  // was actively draining. The three stages are already sequential WITHIN a cycle, but the embed
  // loop is CAPPED at 200 passes × 50 rows = 10,000 messages — so on a large import it exhausts the
  // cap and FALLS THROUGH to categorize with the backlog still full. From the box's point of view
  // that is embedding and labeling alternating every 15s against the same RAM and the same CPU
  // (the operator watched a 24GB machine die doing exactly this). The deferral makes the ordering
  // the copy already promises: embed drains FIRST, categorize starts after.
  // ⚠️ It is a SCHEDULING state, never a pause and never a fault — the owner chose nothing here, so
  // it must not touch the pause flags or the model healths. It is reported (status() below →
  // readiness `pipeline`, categorize stage `blocked`/`waiting_embed`) so a stopped-looking stage is
  // never silent — the whole point of the pipeline-transparency design.
  let _catWaitingOnEmbed = false;
  // COMPUTE GOVERNOR (D-001): the SIBLING of _catWaitingOnEmbed for the other refusal reason — the
  // model slot is held by another resident lane (a describe child, clustering, chat). Same shape,
  // same discipline: a SCHEDULING state, never a pause and never a fault, reported through status()
  // so a refused categorize renders as `waiting`, never as a broken/silent lane (design §5 — "if
  // refusals are not rendered as waiting, the next bug report is 'embedding stopped working'").
  let _catWaitingOnCompute = false;
  // D-001 (review finding #2): the ONNX embed drain (L1) is NOT an Ollama-resident lane, so it is a
  // BULK ticket — its memory (~1 GB) plus whisper (~1–3 GB) plus a resident vision/describe model
  // is the concurrency that a count-of-1 RESIDENT gate does NOT catch. When the BULK sum/pressure
  // gate refuses embedding this cycle, this flag says so (scheduling `waiting`, never a fault).
  let _embedWaitingOnCompute = false;
  let _govDeferrals = 0;   // consecutive cycles the governor deferred categorize (log throttle only)
  let _embedGovDeferrals = 0; // consecutive cycles the governor deferred the embed drain (log throttle)
  let _catDeferrals = 0;   // consecutive cycles deferred (log throttle only)
  let _health = 'unknown'; // last observed embed-service health: ok | loading | error | unreachable
  const embedBaseUrl = () => `http://127.0.0.1:${Number(process.env.MYCELIUM_EMBED_PORT) || 8091}`;
  let timer = null;
  // Cached on-box labeling classifier, rebuilt only when the resolved model changes (so a
  // Settings change swaps the model live without a restart, and we don't rebuild every cycle).
  let _labelModel = null;
  let _labelClassify = null;
  // The labeling model the last cycle RESOLVED from settings — i.e. what the owner approved.
  // ⚠️ Tri-state, and the distinction is load-bearing for getLabelerHealth():
  //   undefined = no cycle has read the setting yet (boot)  → 'unknown'
  //   null      = read, and nothing is approved             → 'no_model'
  //   string    = approved
  let _approvedModel;
  // Same tri-state, for the L2 ENRICH model (settings.taskModels.enrich). SEPARATE from
  // `_approvedModel` because the two settings are independent — a vault can approve labeling
  // and leave enrich unset. Collapsing them into one slot is precisely the bug M7b in verify-model-consent.mjs caught one
  // layer down (the shared _pulling/_faults slots made the enrich model's download read as the
  // labeler's health); the same trap applies to the approved-model slot itself.
  let _approvedEnrichModel;
  // Return the classifier to use for L1 this cycle: an injected one (tests) wins; otherwise
  // resolve the model from settings (default qwen3.5:4b) and build/reuse a local classifier.
  async function labelClassifier(model) {
    if (typeof classify === 'function') return classify;
    if (_labelClassify && _labelModel === model) return _labelClassify;
    _labelModel = model;
    _labelClassify = createCategoryClassifier({
      model, // recorded as per-row provenance (categories_model, 0041)
      // D-132 (U-C): the second arg carries the BATCH call's scaled budgets
      // (classify.batch computes maxTokens/numCtx from K + prompt size); the
      // single path passes none and keeps today's exact caps. numCtx is clamped
      // to the model's REAL context window (model-registry — the catalog's 8192
      // for the default labeler; prefix-matching 'qwen3' would 5x-overstate it).
      infer: (prompt, o) => localInfer({
        prompt, model, format: 'json', think: false,
        maxTokens: o?.maxTokens ?? 40,
        numCtx: Math.min(o?.numCtx ?? 1024, lookupModel(model)?.contextWindow || 8192),
      }),
    });
    return _labelClassify;
  }
  // Cached on-box message enricher (L2), rebuilt only when the resolved model changes.
  let _enrichModel = null;
  let _enrichFn = null;
  async function messageEnricher(model) {
    if (typeof enrich === 'function') return enrich;   // injected (tests) — mirrors labelClassifier's `classify` seam
    if (_enrichFn && _enrichModel === model) return _enrichFn;
    _enrichModel = model;
    _enrichFn = createMessageEnricher({
      model,
      // maxTokens 160: enough for {people,orgs,places,topics,gist} JSON; numCtx 1024 holds a bounded message.
      infer: (prompt) => localInfer({ prompt, model, format: 'json', maxTokens: 160, numCtx: 1024, think: false }),
    });
    return _enrichFn;
  }

  // Health for the DRAIN GATE: only 'ok' may drain (embedding against a loading/erroring
  // service would burn the backlog). But report WHY, so the caller can tell a model that
  // is still warming up (normal, transient — a 170MB download on first run) from an
  // outage. Conflating the two made onboarding look broken.
  async function embedHealth() {
    try {
      const h = await embed.health(); // /health → { status, loaded, dim, … }
      if (!h) return 'unreachable';
      if (h.loaded === false || h.status === 'loading') return 'loading';
      if (h.status && h.status !== 'ok') return h.status;   // 'error' | anything else
      return 'ok';
    } catch { return 'unreachable'; }
  }
  async function embedHealthy() { return (await embedHealth()) === 'ok'; }

  /**
   * Does `installed` (ollama's tag list) contain the APPROVED `model`?
   *
   * ⚠️ AN APPROVAL THAT NAMES A TAG MEANS *THAT* TAG. This used to be
   * `n === model || n.split(':')[0] === base`, i.e. a bare BASE match in both directions — so a
   * vault that approved `qwen3.5:4b` and had only `qwen3.5:70b-instruct` installed was declared
   * ready, and then reported "Labeling with qwen3.5:4b." while every classify 404'd on a model
   * that does not exist there (independent review, 2026-07-16). Two different tags of one base
   * are two different models — different weights, different size, and in the 4b-vs-70b case a
   * ~40GB difference in what the owner agreed to run on their machine.
   *
   * ⚠️ AND A TAG-LESS APPROVAL MEANS `:latest` — NOT "any tag". The first fix here kept a base
   * match for the tag-less case and commented it as "any installed tag of it satisfies it". That
   * is FALSE, and a re-review proved it against a LIVE ollama daemon rather than by reading —
   * with only `qwen3.5:4b` installed:
   *     qwen3.5              → {"error":"model 'qwen3.5' not found"}
   *     qwen3.5:latest       → {"error":"model 'qwen3.5:latest' not found"}
   *     qwen3.5:70b-instruct → {"error":"model 'qwen3.5:70b-instruct' not found"}
   *     qwen3.5:4b           → runs
   * (reproduced independently here, 2026-07-16). Ollama resolves a tag-less name to `:latest`
   * and nothing else, and localInfer sends the APPROVED NAME VERBATIM — so a tag-less approval
   * matched against `qwen3.5:4b` reported "Labeling with qwen3.5." while every classify 404'd:
   * this commit's own headline defect, re-committed by its own fix, and the gate written to
   * bless it (M9l) asserted the lie as intended behaviour. Hence one rule, no branches: the
   * name ollama will be ASKED for is the name that must be installed.
   *
   * Shared by the pull decision and the health probe ON PURPOSE — two predicates would let
   * health and the classifier disagree about the same model, which is the class M7b exists to
   * catch, one layer down. A tag-less PULL installs `<name>:latest` — VERIFIED against the live
   * daemon (`/api/copy` to a tag-less name lists back as `<name>:latest` and resolves) — so the
   * post-pull list satisfies this predicate and it settles.
   *
   * KNOWN LIMIT, on record rather than rediscovered: `includes(':')` is HOST-UNAWARE. For a
   * port-qualified registry name (`registry.local:5000/library/qwen3.5`) ollama parses the tag
   * as the colon after the LAST slash, so it resolves `:latest` while this reads the PORT colon
   * as a tag. Cosmetic — it costs one no-op re-pull attempt per boot and cannot loop, because
   * the pull's `.then()` adds to `_modelReady` unconditionally without re-consulting this. It
   * needs a hand-typed name to reach at all: the picker only offers `/api/tags` names, which
   * always carry a tag. The old base match survived this case BY ACCIDENT while lying broadly
   * (re-review, 2026-07-16). Fix by splitting on the last '/' before the ':' if a registry with
   * a port ever ships.
   */
  function isInstalled(installed, model) {
    if (!Array.isArray(installed)) return false;
    const want = String(model).includes(':') ? String(model) : `${model}:latest`;
    return installed.some((n) => n === want);
  }

  // PRODUCTION: ensure the APPROVED on-box labeling MODEL is actually installed before we
  // classify. daemon.ensureUp() only starts the Ollama SERVER — but a fresh, app-private
  // Ollama ships with NO models, so the first classify fails "model not found" and L1
  // silently never runs for that user (the model-tier sibling of the lazy-server dormancy
  // bug). We pull ONCE, in the BACKGROUND (the download is minutes — never hold the drain
  // cycle for it), and skip the tagging loop until it's ready. Result cached so we hit
  // `ollama list` at most once per model. Fail-soft: any error leaves rows pending.
  const _modelReady = new Set();   // models confirmed present (or freshly pulled) this session
  // ⚠️ KEYED BY MODEL, not module-global. ensureLabelModel() runs for BOTH the L1 label model
  // and the L2 enrich model, which can differ — so a single shared slot made the ENRICH
  // model's download or failure surface as the LABELER's health: "Downloading gemma4:12b…"
  // while labeling ran fine on qwen, or "runtime not reachable" when only the enrich pull
  // hit a disk-full (independent review, 2026-07-16).
  const _pulling = new Map();      // model → pct (0-100), byte-accurate from ollama's stream
  // model → { kind, detail } for the last non-consent reason it can't run. `kind` is an
  // OLLAMA_FAULT (runtime-unreachable | download-failed | out-of-space), classified from the
  // caught error's SHAPE so the health surface names the RIGHT cause instead of blaming the
  // runtime for a disk-full or a registry-unreachable pull (was a bare string + a hardcoded
  // "runtime not reachable" for every fault — misleading on a fresh box where the tag is valid
  // but the environment isn't; live-test 2026-07-18). `detail` is ollama's own infra string
  // (HTTP status / errno / models-dir path), username-scrubbed + bounded, surfaced only on the
  // localhost-only readiness surface — NEVER the content-free activity feed (see publishPull.end).
  const _faults = new Map();
  // Pull-failure backoff (the STORM fix, 2026-07-17). A fast-failing pull used to retry EVERY
  // 15s cycle forever, each attempt minting a NEW feed row — the operator watched six
  // "Failed · just now" rows stack up in two minutes for a transient daemon blip. OUTCOME-BASED,
  // not a clock (a rule you can't gate at its own timescale is one you can't defend): after the
  // k-th consecutive failure, skip the next min(2^k, 40) CYCLES (≈30s → 10min at the 15s tick),
  // reset on success or on the owner's explicit retry (resetPullBackoff → the trigger route).
  // `episodeId` keeps ONE feed row per failure EPISODE: retries within an episode reuse the id
  // (begin() reopens the row — one row flapping, not six stacking), while success ends the
  // episode so the NEXT failure gets a fresh id and history is preserved across episodes — the
  // exact property the unique-per-attempt id was protecting (drainer.js, re-review 2026-07-16).
  const _pullBackoff = new Map();  // model → { failures, skipCycles, episodeId, decAt }
  // Cycle ordinal for the backoff's once-per-cycle decrement. `skipCycles` used to decrement per
  // CONSULT, and ensureLabelModel is consulted for labelM AND enrichM — which in the common shape
  // are the SAME model (one Understanding approval writes both), so the real backoff ran at HALF
  // the design (measured: gaps [2,3,5,9,17] vs the designed [3,5,9,17,33] — review, 2026-07-17).
  // The signals-answer-adjacent-questions class again: "how many times was I consulted" is not
  // "how many cycles passed". `decAt` pins each decrement to one cycle.
  let _cycleN = 0;
  const _probing = new Set();      // models with a readiness probe in flight (single-flight; see probeModelReady)
  async function ensureLabelModel(model) {
    // ⚠️ NO MODEL ⇒ NOT APPROVED ⇒ NEVER PULL, NEVER RUN (§3.10c). This return is the consent
    // gate. It used to be `if (!model || …) return TRUE` — i.e. an unapproved model reported
    // READY, which is how the classifier ran (and the pull fired) on a vault whose owner was
    // never asked. False is the honest answer: labeling is paused, and §3.5's blocked states
    // make that a legitimate steady state rather than a transient error.
    if (!model) return false;
    if (_modelReady.has(model)) return true;
    if (_pulling.has(model)) return false;               // download in flight → not ready yet
    const bo = _pullBackoff.get(model);
    // TERMINAL faults never re-attempt on the clock: an incompatible runtime (host Ollama too old,
    // registry 412) 412s identically every cycle — a wasted request AND a flapping error row — so
    // it is parked until the owner upgrades Ollama and hits Try again (resetPullBackoff clears it).
    // Same shape as disk-full's terminal treatment one layer down (ollama.js pullModel).
    if (bo?.terminal) return false;
    if (bo && bo.skipCycles > 0) {
      if (bo.decAt !== _cycleN) { bo.skipCycles--; bo.decAt = _cycleN; }   // once per CYCLE, however many consults
      return false;                                                        // backing off — see _pullBackoff
    }
    let installed;
    try { installed = await ollama.listInstalled(); }    // ['qwen3.5:4b', 'llama3.1:latest', …]
    catch (e) {                                          // can't reach Ollama → retry next tick
      // A LIST failure is almost always the daemon being down/hung; classify from the shape so a
      // non-2xx (daemon up, not serving) is still read as a runtime problem, not a download one.
      _faults.set(model, { kind: classifyOllamaFault(e, 'list'), detail: scrubFaultDetail(String(e?.message || e)).slice(0, 120) });
      return false;
    }
    _faults.delete(model);
    if (isInstalled(installed, model)) {
      _modelReady.add(model); return true;               // already have it
    }
    _pulling.set(model, 0);
    log(`[enrich] labeling model "${model}" not installed — pulling it once (a few minutes)…`);
    // A multi-GB download is the longest unattended thing the app does. It was log-only, so
    // it was invisible from every screen (§3.10e). The model NAME is publishable — it is an
    // identifier, never user content — and is what the feed's `model` column exists for.
    // UNIQUE PER ATTEMPT, AND ACROSS RESTARTS. begin() is `ON CONFLICT(id) DO UPDATE SET
    // status='running', finished_at=NULL, error=NULL`, so any id reuse REOPENS the previous
    // attempt's row and erases that failure from history — the user never learns the download
    // keeps failing.
    //
    // ⚠️ It must be a CLOCK, not a counter. A process-local counter (the first fix here) resets
    // to 0 on every app restart, so boot 2's first attempt re-minted boot 1's id and wiped its
    // error row — proven with a two-boot probe (re-review, 2026-07-16). A persistent failure
    // (disk full, no network) is exactly the case that retries across a restart, so the counter
    // failed precisely where it was needed. That review also caught the comment defending it:
    // it cited the import runner as precedent for "not a clock", but import-job.js uses
    // `import-${j.startedAt}` — a wall clock, restart-safe BECAUSE it isn't a counter. The
    // stated rationale was the inverse of its own precedent. This now genuinely matches it.
    // (No hot-path concern: a multi-GB pull happens at most once per model per process.)
    // One row per EPISODE: reuse the episode's id on retries (begin() reopens it), fresh id per
    // episode. See _pullBackoff above for why both halves matter.
    const feedId = bo?.episodeId ?? `model-pull-${model}-${Date.now()}`;
    publishPull.begin(feedId, model);
    ollamaClient().pullModel(model, (ev) => {
      // ollama streams { status, completed, total } per layer.
      const total = Number(ev?.total) || 0, done = Number(ev?.completed) || 0;
      if (total > 0) { _pulling.set(model, Math.max(0, Math.min(100, Math.round((done / total) * 100)))); }
      publishPull.beat(feedId, done, total, model);
    })
      .then(() => { _modelReady.add(model); _pullBackoff.delete(model); publishPull.end(feedId, 'done'); log(`[enrich] labeling model "${model}" ready — L1 resumes`); })
      .catch((e) => {
        // Classify the PULL failure by shape: a disk-full (ENOSPC) or a registry-unreachable
        // mid-stream error is NOT "the runtime is down", and the owner needs the right remedy.
        // ollama.js now preserves ollama's mid-stream ev.error, so `detail` carries the real
        // reason (disk path, registry host) — username-scrubbed, and it reaches only the
        // localhost-only readiness surface, never the feed.
        const kind = classifyOllamaFault(e, 'pull');
        _faults.set(model, { kind, detail: scrubFaultDetail(String(e?.message || e)).slice(0, 120) });
        // A CONSTANT to the feed: the row is content-free by contract (activity-feed.js §SECURITY).
        // An ollama error is a model name + an HTTP status today, but this is not the place to
        // bet on that staying true. The reason stays in _faults, off the feed entirely.
        publishPull.end(feedId, 'error', 'download failed');
        const prev = _pullBackoff.get(model) ?? { failures: 0, skipCycles: 0, episodeId: feedId };
        prev.failures += 1;
        prev.episodeId = feedId;                              // retries stay on THIS episode's row
        if (kind === OLLAMA_FAULT.INCOMPATIBLE_RUNTIME) {
          // TERMINAL — the host runtime is too old for this model; every retry 412s identically.
          // Park it (no backoff clock) so we stop pulling until the owner upgrades Ollama + hits
          // Try again (resetPullBackoff clears it). Mirrors disk-full's terminal stance in ollama.js.
          prev.terminal = true;
          prev.skipCycles = 0;
          _pullBackoff.set(model, prev);
          log(`[enrich] pull "${model}" failed (attempt ${prev.failures}): incompatible runtime — NOT retrying until Ollama is upgraded`);
        } else {
          prev.terminal = false;
          prev.skipCycles = Math.min(2 ** prev.failures, 40);   // 2,4,8,… cycles; cap ≈10min at 15s
          _pullBackoff.set(model, prev);
          log(`[enrich] pull "${model}" failed (attempt ${prev.failures}): ${String(e?.message || e).slice(0, 60)} — retrying in ~${prev.skipCycles} cycle(s)`);
        }
      })
      .finally(() => { _pulling.delete(model); });        // next 15s tick resumes categorize
    return false;
  }

  /**
   * Is the APPROVED model installed, right now? A READ-ONLY probe, and every "not" is
   * load-bearing: it never wakes the daemon, never installs the runtime, never pulls.
   *
   * WHY IT EXISTS: `_modelReady` used to be written ONLY by ensureLabelModel(), which the
   * cycle calls only when `pc.length || pn.length` — so the 'ok' branch of both healths was
   * reachable ONLY while rows were pending. Two vaults identical in settings, model and
   * runtime, differing only in boot history, disagreed:
   *   had a backlog earlier this process → 'ok'      "Enriching with qwen3.5:4b."
   *   caught up at boot (mature vault)   → 'unknown' "Checking the enrichment model…"
   * i.e. the steady state of every mature vault after a restart was 'unknown' — the healthiest
   * configuration reporting as the least known one, and saying "Checking…" while nothing was
   * checking. That is the fabricated liveness this slice exists to remove, pointed the other
   * way (independent review, 2026-07-16). Readiness is a property of the APPROVAL and the
   * MODEL'S INSTALLED-NESS, never of the backlog, so it is resolved here rather than inside the
   * pending gate.
   *
   * ⚠️ HONEST LIMIT — `_modelReady` is a process-lifetime cache and is never cleared, so 'ok'
   * strictly means "confirmed installed at least once THIS PROCESS", not "confirmed right now".
   * Two caught-up vaults whose runtime is unreachable AT THIS MOMENT can therefore still
   * disagree — one confirmed earlier and says 'ok', one never could and says 'unknown' — which
   * is the same boot-history dependence, narrowed rather than eliminated. An earlier draft of
   * this comment claimed readiness was a property of "the APPROVAL and the RUNTIME", which
   * would make that disagreement a bug; it is not what the code does (independent review,
   * 2026-07-16 — it caught the claim by re-running the fix's own premise against it). The cache
   * is deliberate: a SLEEPING daemon does not un-install a model, and re-probing a known model
   * every 15s to re-learn a fact that cannot change would spend requests to say nothing new.
   */
  async function probeModelReady(model) {
    // NOT APPROVED ⇒ NO CALL. The same consent gate as ensureLabelModel's `if (!model)`: an
    // unapproved vault must reach Ollama zero times, not "only to look" (§3.10c, gate M1).
    if (!model) return;
    if (_modelReady.has(model) || _pulling.has(model)) return;  // known, or a pull is in flight
    // SINGLE-FLIGHT PER MODEL. Un-awaiting the probe (so it cannot delay embedding) also dropped
    // it out of cycle()'s `running` guard, which had been bounding it for free: while ollama
    // hangs, `_modelReady` never fills, so every cycle fired a fresh probe and they accumulated
    // — a re-review drove 5,236 concurrent in-flight probes through the un-rate-limited
    // POST /portal/enrichment/trigger route (owner-only, so LOW, but it is a real invariant the
    // await used to hold). The 15s timer alone cannot reach it (the 5s cap settles first); the
    // nudge path can. Bound it explicitly rather than relying on a timing coincidence.
    if (_probing.has(model)) return;
    // ⚠️ THE WHOLE BODY IS INSIDE THE TRY, AND THAT IS NOT TIDINESS. This runs ABOVE the embed
    // gate, so a throw from here would land in cycle()'s outer catch and skip EVERYTHING below
    // — embedding, L1 and L2 — which is precisely the coupling the guard further down exists to
    // break. A health probe that can take down the pipeline it reports on is worse than no probe
    // at all. Not theoretical: listInstalled() is INJECTABLE and reaches the network, so it can
    // reject; isInstalled() absorbs a malformed ANSWER, but only this try absorbs a rejected CALL.
    _probing.add(model);
    try {
      // isInstalled() is the SHARED predicate (see it for why a tagged approval is exact), and
      // it is also total: a non-array answer is `false`, never a throw.
      if (isInstalled(await ollamaClient().listInstalled(), model)) {
        // Clearing the fault only on the INSTALLED path is belt-and-braces, not a mechanism:
        // ensureLabelModel's own unconditional `_faults.delete` dominates in every reachable
        // state (a live pull-fault implies pending rows, which implies that path runs). A
        // counterfactual probe showed identical status histories with and without this
        // condition (independent review, 2026-07-16, which also refuted the 5-line rationale an
        // earlier draft gave it here). It is kept only because a probe that clears a fault it
        // cannot disprove would be wrong on its face — not because a test can tell the
        // difference. Do not cite it as load-bearing.
        _faults.delete(model);
        _modelReady.add(model);
      }
    } catch {
      // ⚠️ DELIBERATELY NOT A FAULT. listInstalled() throws when the daemon is merely ASLEEP —
      // and the daemon is lazy: on a caught-up vault nothing has woken it, because nothing
      // needs it. Recording an 'unavailable' fault (the classified "runtime isn’t reachable")
      // here would trade the 'unknown' lie for a louder one: an alarm on a vault that is working
      // perfectly and would wake the daemon the moment a row arrived. We genuinely cannot see
      // whether the model is installed, so we say so by leaving the state alone → 'unknown'.
      // A fault is still recorded where it is EARNED: ensureLabelModel(), i.e. after a wake was
      // actually attempted for real pending work. Do not "simplify" this into a fault.
    } finally {
      _probing.delete(model);   // release the single-flight slot on EVERY path, including a throw
    }
  }

  // The pull's feed publishing — fire-and-forget and swallowed, exactly like the import
  // runner's: the feed is a mirror, and a broken mirror must never stop a download.
  const publishPull = {
    begin: (id, model) => { try { activityFeed?.begin({ userId, kind: 'model-pull', id, totalSteps: 0, stageLabel: 'Downloading the labeling model', model }).catch(() => {}); } catch { /* never */ } },
    beat: (id, step, totalSteps, model) => { try { activityFeed?.heartbeat(id, { step, totalSteps, stalled: false }).catch(() => {}); } catch { /* never */ } },
    end: (id, status, error = null) => { try { activityFeed?.finish(id, { status, error }).catch(() => {}); } catch { /* never */ } },
  };

  /**
   * Labeler health, in the SAME shape the two supervisors that already exist return
   * (getEmbedderHealth / getTranscriberHealth — {status, message, detail, model, progress}),
   * over the shared vocabulary. The drainer's equivalents were closure-local and never
   * exported, so nothing outside could tell "paused, no model" from "running" (§3.10b).
   *   'ok'          — an approved model is installed; L1 runs
   *   'no_model'    — no model approved yet. NOT an error: a supported configuration.
   *   'downloading' — the approved model is being pulled (progress.pct, byte-accurate)
   *   'paused'      — the owner stopped the churn. A CHOICE, not a fault.
   *   'unavailable' — Ollama unreachable (detail = why); actionable
   *   'unknown'     — no cycle has resolved the setting yet (boot)
   */
  function labelerHealth() {
    // ⚠️ EVERY branch below reports on THE LABELING MODEL specifically (`_approvedModel`).
    // The first draft read module-global pull/fault slots that ensureLabelModel also writes
    // for the L2 ENRICH model — so labeling reported "Downloading gemma4:12b…" while it was
    // happily running on qwen, and an enrich-only disk-full read as a labeling outage.
    // If you add a branch here, key it by model or it will lie the same way.
    const m = _approvedModel;
    // undefined ⇒ no cycle has resolved the setting yet (boot). NOT the same as null, which
    // is a resolved "the owner has not approved one" — conflating them would render
    // "no labeling model" for the first seconds of every boot, which is a lie.
    if (m === undefined) {
      return { status: 'unknown', message: 'Checking the labeling model…', detail: null, model: null, progress: null };
    }
    if (m === null) {
      return { status: 'no_model', message: 'No labeling model approved — messages stay uncategorized.', detail: null, model: null, progress: null };
    }
    if (_pulling.has(m)) {
      return { status: 'downloading', message: `Downloading ${m}…`, detail: null, model: m, progress: { pct: _pulling.get(m) ?? 0 } };
    }
    // The owner stopped the churn (POST /portal/enrichment/processing/pause). A CHOICE, not
    // a fault — and it outranks 'ok' because nothing is actually labeling. It was missing
    // from the vocabulary entirely, so the one state the user explicitly picked was the one
    // this slice could not express (independent review, 2026-07-16).
    if (isCategorizePaused()) {
      return { status: 'paused', message: 'Labeling is paused — pending messages are waiting.', detail: null, model: m, progress: null };
    }
    if (_faults.has(m)) {
      // Message is classified from the fault's SHAPE (runtime down vs download failed vs disk
      // full) — no longer a hardcoded "runtime not reachable" for every cause. `detail` carries
      // ollama's own string for the technically-inclined; both are model-keyed (never leaked
      // from the enrich model's slot — the M7b class).
      const f = _faults.get(m);
      return { status: 'unavailable', message: faultMessage(f), detail: f?.detail ?? null, model: m, progress: null };
    }
    if (_modelReady.has(m)) return { status: 'ok', message: `Labeling with ${m}.`, detail: null, model: m, progress: null };
    return { status: 'unknown', message: 'Checking the labeling model…', detail: null, model: m, progress: null };
  }

  /**
   * Enricher health — L2 (semantic entities + gist), in the SAME shape and vocabulary as
   * labelerHealth() above. It is a near-mirror ON PURPOSE, but it is NOT the labeler's answer
   * copied: every branch keys on `_approvedEnrichModel` and the model-keyed _pulling/_faults/
   * _modelReady slots, so an enrich-only pull or an enrich-only fault reports HERE and nowhere
   * else. (Reading the labeler's slots instead is exactly the lie M7b in verify-model-consent.mjs was written to catch.)
   *
   * WHY IT EXISTS: `taskModels.enrich` is its own setting, and L2 ran dead with NOTHING
   * anywhere reporting it — the readiness `models` slice carried {embedder, labeler,
   * transcriber} and portal-activity projects only embed + categorize (re-review, 2026-07-16).
   * This is the missing REPORT, not a gate.
   * ⚠️ Still needed after the Intelligence screen began approving {categorize, enrich} together
   * (`{function:'understanding'}` fans out — portal-providers.js): the per-task route still
   * writes one task at a time, so enrich can still be approved, paused, pulled or broken on its
   * own. A member that inherited the labeler's answer would be the lie M7b in verify-model-consent.mjs exists to catch.
   *
   *   'ok'          — an approved model is installed; L2 runs
   *   'no_model'    — no model approved yet. NOT an error: a supported configuration.
   *   'downloading' — the approved model is being pulled (progress.pct, byte-accurate)
   *   'paused'      — the owner stopped the churn. A CHOICE, not a fault.
   *   'unavailable' — Ollama unreachable (detail = why); actionable
   *   'unknown'     — no cycle has resolved the setting yet (boot)
   */
  function enricherHealth() {
    const m = _approvedEnrichModel;
    // undefined ⇒ no cycle has resolved the setting yet (boot); null ⇒ resolved, not approved.
    if (m === undefined) {
      return { status: 'unknown', message: 'Checking the enrichment model…', detail: null, model: null, progress: null };
    }
    if (m === null) {
      return { status: 'no_model', message: 'No enrichment model approved — messages keep their entities and gist unextracted.', detail: null, model: null, progress: null };
    }
    if (_pulling.has(m)) {
      return { status: 'downloading', message: `Downloading ${m}…`, detail: null, model: m, progress: { pct: _pulling.get(m) ?? 0 } };
    }
    // ⚠️ L2 shares the CATEGORIZE pause (R2): the categorize block in cycle() gates the L1 label
    // pass AND the L2 semantic-enrich pass together, so `isCategorizePaused()` is the truthful
    // signal for both. When the owner Stops categorizing, enrichment really is not running — do
    // not "fix" this by reporting 'ok', which would resurrect the dormancy this member exposes.
    if (isCategorizePaused()) {
      return { status: 'paused', message: 'Enrichment is paused — pending messages are waiting.', detail: null, model: m, progress: null };
    }
    // D-132: DEFERRED is an owner posture distinct from paused — L2 alone is set aside
    // (embed + L1 keep running). Never 'ok': that would be the dormancy this member exposes.
    if (isEnrichDeferred()) {
      return { status: 'deferred', message: 'Semantic enrichment is deferred — resume it from the pipeline panel when you want entities and gists extracted.', detail: null, model: m, progress: null };
    }
    if (_faults.has(m)) {
      // Same classified message as the labeler (see there) — keyed on `_approvedEnrichModel`
      // and this model's own fault slot, so an enrich-only disk-full never reads as the labeler.
      const f = _faults.get(m);
      return { status: 'unavailable', message: faultMessage(f), detail: f?.detail ?? null, model: m, progress: null };
    }
    if (_modelReady.has(m)) return { status: 'ok', message: `Enriching with ${m}.`, detail: null, model: m, progress: null };
    return { status: 'unknown', message: 'Checking the enrichment model…', detail: null, model: m, progress: null };
  }

  async function cycle() {
    if (running) { pending = true; return; } // single-flight; coalesce concurrent nudges
    running = true;
    try {
      // ── D-128: A BULK IMPORT OWNS THE VAULT — STAND DOWN FOR THE CYCLE ──
      // Re-checked EVERY cycle (the restorePauseOnce lesson: a latch read once is no
      // latch). While full-export-import holds the quiesce, this drain's writes would
      // interleave with a mass raw restore running with FKs off on the shared
      // connection — the proven SQLITE_CORRUPT ingress of 2026-07-30. The import
      // nudges the drainer when it finishes, so no work is lost, only deferred.
      if (isImportQuiesced()) {
        if (!_quiesceNoted) { _quiesceNoted = true; log('[enrich] standing down: a bulk import holds the vault (D-128); resuming after it completes'); }
        return;
      }
      if (_quiesceNoted) { _quiesceNoted = false; log('[enrich] bulk import finished — resuming the drain'); }
      // ── RESOLVE + STAMP THE APPROVED MODELS FIRST, ABOVE EVERYTHING THAT CAN THROW ──
      // These two are pure settings READS: they wake nothing, install nothing, download nothing.
      // Read the resolver bodies for that — defaultLabelModel/defaultEnrichModel call
      // db.users.getSettings and nothing else, and both are try/catch fail-closed, so neither
      // can throw and neither can resolve a model from a failed read. (An earlier draft of this
      // line cited "50 health reads drove 0 settings reads" as proof. That probe measured
      // getEnricherHealth(), which never runs these resolvers — 0 settings reads is what it
      // MEASURED, not evidence about them. True claim, wrong proof; a review caught the
      // mis-citation in the very diff whose subject is over-claimed prose.)
      // They are hoisted to the very top for one reason: THE STAMP MUST NOT BE REACHABLE-ONLY
      // THROUGH THE DRAIN PATH. They used to sit below the `if (embedOk)` block, still inside
      // this try — so any throw in the embed loop (svc.drainOnce() is unguarded) hit the outer
      // catch and skipped the stamp, leaving _approvedModel/_approvedEnrichModel `undefined`
      // and BOTH healths reporting 'unknown' / "Checking the … model…" FOREVER, since the same
      // throw repeats every cycle. That is the identical defect the note below records for the
      // pause block — the stamp was moved out of the pause and left under the throw, i.e. only
      // half-fixed (independent review, 2026-07-16; reproduced with a throwing drain path).
      // A health that says "Checking…" while the cycle crashes every 15s is the fabricated
      // liveness this whole slice exists to remove. Keep them ABOVE the embed gate.
      // ── RESTORE THE PERSISTED PAUSE BEFORE ANY WORK, ONCE (§3.9/R3, D13) ──
      // Above the embed gate on purpose: this is the read that decides whether the drain runs
      // at all, so it cannot sit below the thing it gates. Latched, so it costs one settings
      // read per boot, not one per 15s cycle. Never throws (fail-soft to RUNNING).
      await restorePauseOnce(db, userId, log);

      const labelM = await resolveLabelModel();   // resolve once — feeds the pull AND the classifier
      const enrichM = await resolveEnrichModel();  // ditto for the enrich model
      _approvedModel = labelM ?? null;             // what getLabelerHealth() reports on
      _approvedEnrichModel = enrichM ?? null;      // what getEnricherHealth() reports on

      // ── RESOLVE READINESS FROM THE APPROVAL, NOT FROM THE BACKLOG ──
      // `_modelReady` was written ONLY under `if (pc.length || pn.length)`, so a CAUGHT-UP vault
      // could never reach 'ok' and reported "Checking the … model…" forever. Read-only and
      // fail-soft: probeModelReady never wakes, installs, pulls or throws, and is a no-op on an
      // unapproved model — so an unapproved vault still touches Ollama zero times (M1), and an
      // idle one still spawns nothing (M2).
      //
      // ⚠️ NOT AWAITED, AND THAT IS THE POINT. Awaiting it here put a health question on
      // EMBEDDING'S CRITICAL PATH: listInstalled() is capped at 5s (ollama.js AbortSignal.timeout),
      // and an ollama that accepts connections but hangs — the app's own daemon during boot does
      // exactly this — made every 15s cycle spend 10s (two sequential probes) before the first
      // embed read. Measured on this diff before the fix: first drainOnce read at t+10008ms vs
      // t+4ms on main (independent review, 2026-07-16). Embedding has no stake whatsoever in the
      // model list, so it must not wait on it: a health probe that delays the pipeline it reports
      // on is the coupling this very commit removes from the embed gate, re-introduced by its own
      // fix. Fire-and-forget is safe precisely because the probe cannot throw and writes nothing
      // but two in-memory Sets/Maps; the health resolves a tick later, which is a health surface's
      // whole tolerance. DEDUPED because the two tasks usually name the SAME model — two identical
      // in-flight probes would double the cost of the thing being made free.
      for (const m of new Set([labelM, enrichM].filter(Boolean))) void probeModelReady(m);

      // NEVER skip silently. This early return sat here for a month while the embed
      // service was a single-request HTTPServer: any in-flight batch blocked /health
      // (measured: 7.8s), embedHealthy() swallowed the timeout → false → return, with
      // NO log — every 15s, forever, while the UI still rendered "Embedding messages"
      // (that label is just `pending > 0`, not liveness). A skip you can't see is a
      // failure you can't fix. Throttled so a genuinely-down service can't spam.
      _health = await embedHealth();
      const embedOk = _health === 'ok';
      if (!embedOk) {
        _skips++;
        if (_skips === 1 || _skips % 20 === 0) {
          log(`[enrich] SKIPPED embedding, cycle #${_skips}: embed service not healthy at ${embedBaseUrl()} — nothing is being embedded. `
            + `(backlog stays put; check the service is up and not saturated. Labeling still runs — it needs Ollama, not the embed service)`);
        }
      } else if (_skips) {
        log(`[enrich] embed service healthy again after ${_skips} skipped cycle(s) — resuming`);
        _skips = 0;
      }
      _lastCycleAt = Date.now();

      // ⚠️ THE EMBED HEALTH GATE SKIPS EMBEDDING — NOT THE CYCLE (design §3.6).
      // It used to `return` here, so a dead embed service ALSO silenced L1 labeling — which
      // depends on OLLAMA, not on :8091. Two independent pipelines, one gate:
      // when the embed sidecar died, categorization stopped too, for reasons that had
      // nothing to do with it. Nothing about labeling requires an embedding to exist first
      // (selectPendingCategories keys on categories_processed alone — "INDEPENDENT of the
      // nlp_processed state machine"), so there was never a real ordering dependency — only
      // this early return.
      //   NB on L2: it also moves below the gate and never calls :8091 — but unlike L1 it IS
      //   downstream of embedding (selectPendingNlp requires nlp_processed = 2, which only
      //   the embed loop sets). With the embedder dead L2 drains a pre-existing residue and
      //   then finds nothing new. Correct, but do not read this as "L2 is independent".
      //
      // ⚠️ THE GATE WAS ONLY HALF THE COUPLING — AND THIS COMMENT USED TO STOP HERE, which made
      // it read as a completed decoupling it had not finished. The early `return` was removed,
      // but svc.drainOnce() below was left UNGUARDED inside this block, so a THROW walked to
      // cycle()'s outer catch and skipped the entire L1+L2 block anyway — the exact outcome the
      // paragraph above says was fixed, by a different mechanism. It is not hypothetical:
      // service.js:69 throws BY DESIGN on a locked vault ('master key unavailable … refusing to
      // write') and service.js:72 can throw on SQLITE_BUSY. Demonstrated with pending work every
      // cycle, the model installed and Ollama up: 0 rows tagged, 0 enriched, both healths stuck
      // (independent review, 2026-07-16). Hence the try/catch: an embed failure now costs
      // EMBEDDING, and nothing else. Two independent pipelines, one gate — and now, one throw.
      // ⚠️ `!paused` IS THE POINT OF §3.9/R3 — THIS is the stage that burns the CPU. The pause
      // flag existed before this and gated only the L1/L2 block below, so "Stop" left the
      // embed drain running and the user's Mac exactly as hot: a control that named the churn
      // and then didn't stop it. The health probe above still runs while paused (it is a
      // question, not work) so the feed keeps telling the truth about the sidecar; what stops
      // here is the drain loop and its self-heal write — everything that costs CPU.
      // Resumable by construction: the drain re-selects `nlp_processed = 0` every cycle, so
      // pausing loses nothing and resuming continues exactly where it stopped (design §3.9/R3).
      // BOOT RECLAIM (once per drainer, first unpaused cycle): give every gave-up row a
      // fresh chance — capped embeds AND label-gave-up rows (reclaimGaveUpRows). Set-aside,
      // not deleted: a new boot means new conditions (service fixed, model swapped), so the
      // previous run's verdicts are retried once; between boots they hold, so the backlog
      // still settles. OUTSIDE the embed gate on purpose — the label half must not wait on
      // :8091 being healthy — but never while paused (the pause stops all on-box churn).
      // Boot reclaim covers BOTH stages (embed-capped + label-gave-up rows), so run it while EITHER
      // stage is active — only a fully-paused vault (both stopped) skips it. Otherwise a vault that
      // paused only embedding would never reclaim its label gave-ups, and vice-versa.
      if (!_cappedReclaimed && !(isEmbedPaused() && isCategorizePaused())) {
        _cappedReclaimed = true;
        try { await reclaimGaveUpRows(db, userId); } catch { /* non-fatal */ }
      }

      // ── PER-CYCLE EMBED OBSERVATIONS — the ONLY inputs to the categorize deferral (see below) ──
      // ⚠️ ZERO NEW QUERIES, BY CONSTRUCTION. Every one of these is a byproduct of work the embed
      // loop was already doing: the loop's own `scanned === 0` break IS "the backlog is drained",
      // its no-progress break IS "embed cannot move the head of the queue", and the per-batch
      // counters are already summed for the ETA. Deriving the gate from a COUNT instead —
      // even the SWR-cached one — would have made the drainer a second poller of a multi-second
      // SQLCipher full-table scan every 15s with the UI closed, which is precisely
      // [[gates-assert-shape-never-cost]] ("if it's POLLED, gate the cost") re-shipped inside the
      // fix for a resource complaint. The cached backlog stays where it belongs: on the READ
      // surfaces (readiness/pipeline), which already pay for it.
      let embedDrained = false;   // the loop saw an EMPTY pending set ⇒ nothing left to embed
      let embedStalledOut = false;// the loop broke on no-progress ⇒ embed CANNOT advance right now
      let embedThrew = false;     // the drain threw ⇒ same conclusion: it is not going to progress
      let embedMoved = 0;         // rows that LEFT the pending set this cycle (embedded|skipped|capped)
      // COMPUTE GOVERNOR (D-001, review finding #2 — the operator's P7 import run): the ONNX embed
      // drain is a BULK lane. Reserve a BULK ticket BEFORE the drain loop — refused under CRITICAL
      // memory pressure, or under WARN pressure while a resident model is loaded (the embed×describe
      // concurrency the operator's crash quote names), or when the BULK sum/count budget is full.
      // Refusal is DEFER: skip embedding this cycle, re-select next cycle, render `waiting`.
      _embedWaitingOnCompute = false;
      _embedStallBackoff = false;
      let embedAdm = null;
      // D-131(b): a stalled head is in BACKOFF — skip the drain entirely this
      // cycle (no admission, no selects, no service traffic). embedStalledOut
      // stays true so the categorize deferral keeps treating embed as unable to
      // advance (the starvation guard's contract is unchanged). NEVER SILENT:
      // logged on entry below, and reported via status().embedStallBackoffCycles.
      if (embedOk && !isEmbedPaused() && _stallBackoffCycles > 0) {
        _stallBackoffCycles -= 1;
        _embedStallBackoff = true;
        embedStalledOut = true;
      } else if (embedOk && !isEmbedPaused()) {
        embedAdm = admit({ lane: 'embed-drain', klass: CLASS.BULK, estimateGb: 1, timeoutMs: 0 });
        if (!embedAdm.ok) {
          _embedWaitingOnCompute = true;
          _embedGovDeferrals++;
          if (_embedGovDeferrals === 1 || _embedGovDeferrals % 20 === 0) {
            log(`[enrich] deferring the embed drain this cycle (#${_embedGovDeferrals}): the compute governor is holding capacity (${embedAdm.reason}) `
              + '— avoiding an embed + resident-model memory pile-up (D-001). Resumes as soon as capacity frees.');
          }
        } else if (_embedGovDeferrals) {
          log(`[enrich] embed compute capacity free after ${_embedGovDeferrals} deferred cycle(s) — resuming the drain`);
          _embedGovDeferrals = 0;
        }
      }
      if (embedAdm && embedAdm.ok) {
      try {

      // SELF-HEAL: retry rows that previously failed for a NON-content reason
      // (service down/slow/timeout) now that the service is healthy.
      //
      // The old `AND nlp_error NOT LIKE '%expected 768%'` clause is gone (it quarantined
      // nothing real — see git history; nlp_error is NOT field-encrypted: crypto-local.js
      // ENCRYPTED_FIELDS.messages is `[]`, check the array, not stale prose). The ONE
      // exclusion that exists now is the attempt-cap terminal marker: an 'embed-capped:N'
      // row was retired ON PURPOSE after N counted attempts against a provably-up service
      // (service.js EMBED_MAX_ATTEMPTS). Reclaiming it every cycle would re-create the
      // exact heal→fail→heal loop the cap exists to end — pending would never settle and
      // the activity labels would stay lit forever. Recovery for capped rows is DELIBERATE:
      // the boot reclaim above, or POST /portal/enrichment/retry-failed.
      try { await selfHealStrandedEmbeds(db, userId); } catch { /* non-fatal */ }

      let embedded = 0;
      let capped = 0;
      let stalledPasses = 0;
      // ONE attempt budget per cycle (service.js drainOnce): however many of the ≤200
      // passes re-select a failing row, its retry counter can move at most once here.
      const attemptedThisCycle = new Set();
      for (let i = 0; i < 200; i++) {            // hard cap ≤200 batches/cycle (≤10k msgs)
        // ⚠️ RE-READ EVERY BATCH, NOT ONCE AT THE GATE. This loop is up to 200 batches deep and
        // every batch is real embedding work, so a flag read only on entry left "Stop" pinning
        // the CPU for up to 10k more messages — the control honored at the NEXT cycle, not on
        // the click. §3.9/R3 is "pausing it should HONOR it"; a pause the user watches their
        // fans ignore is the same broken promise as no pause at all.
        if (isEmbedPaused()) break;
        // R1: BANK PER BATCH, NOT PER CYCLE — the rate must be live DURING a long drain.
        // ⚠️ This loop is up to 200 batches x batchSize 50 = 10,000 messages, which at the design's
        // own cited ~40 msgs/min is ~4.2 HOURS in ONE cycle. Banking after the loop meant
        // `lastProgressAt` only stamped when that cycle ENDED, so the feed's 90s no-progress rule
        // blanked the ETA for ~99% of a long import — handing §3.9's headline case (the 29-hour
        // import) back the unbounded spinner R1 exists to remove. It also froze the counters
        // mid-cycle, so the estimate came from the PREVIOUS cycle's rate: measured "~1s left" with
        // 8,402 rows still pending. Both directions of wrong, from one granularity mistake.
        // The warning was already in portal-activity.js, ~30 lines above where I put the guard: "a
        // cycle can legitimately run for MINUTES ... while the drainer is productively embedding
        // thousands of rows" (independent review, 2026-07-17).
        const batchStartedAt = Date.now();
        const e = await svc.drainOnce({ userId, attemptedThisCycle });
        const batchEmbedded = e?.embedded ?? 0;
        capped += e?.capped ?? 0;
        // ROWS THAT LEFT THE PENDING SET — the deferral's "is embed progressing?" evidence, and it
        // is NOT `batchEmbedded`. The three ways a row leaves `nlp_processed = 0` are embedded (→2),
        // skipped as blank (→1, terminal) and capped (→-1, terminal); a FAILED row stays pending by
        // design and the self-heal resurrects it, so it is not progress. Same question the barren
        // signal asks ("is `pending` shrinking?") — asked once, here, so a vault draining a run of
        // blanks is not mistaken for a stalled one and does not release categorize early.
        embedMoved += batchEmbedded + (e?.skipped ?? 0) + (e?.capped ?? 0);
        // Same rule, per batch: bank the work and its cost TOGETHER, and only when work happened —
        // a pass that embeds nothing prices nothing.
        if (batchEmbedded > 0) {
          _embedActiveMs += Date.now() - batchStartedAt;
          _embeddedTotal += batchEmbedded;
          _lastProgressAt = Date.now();
          _noProgress = 0;                      // something embedded ⇒ not stalled (see the decl)
          _stallBackoffCycles = 0; _stallBounced = false; // D-131(b): progress ends the backoff episode
          _barrenPasses = 0;                    // …and the rate is knowable again
          // ⚠️ AND `_embedErrs`, FOR THE SAME REASON — a batch that embedded PROVES the drain works.
          // Its own reset lives after the batch loop, so a cycle that embeds 200 rows and THEN
          // throws never reaches it: the counter rose WITH progress. `service.js`'s per-batch
          // select can throw SQLITE_BUSY on batch 5 after batches 1-4 already embedded, so this is
          // the documented trigger, not a hypothetical. Measured: a vault embedded its ENTIRE
          // 3,000-row backlog (pending 2350 -> 0) with NO ESTIMATE for the whole run, while
          // `barrenPasses` sat at 0 the entire time — the signal asking the right question knew it
          // was progressing, but the guards are OR'd and the wrong one won.
          // `embedErrs` asked "did the cycle throw?"; the ETA needs "is `pending` shrinking?". This
          // narrows it to the case it exists for: a drain that throws BEFORE any batch banks (a
          // locked vault) never reaches this line, so it still climbs and still withdraws the
          // estimate (independent review, 2026-07-17 — the fourth signal in this diff to answer an
          // ADJACENT question).
          _embedErrs = 0;
        } else if ((e?.scanned ?? 0) > 0 && (e?.skipped ?? 0) === 0 && (e?.capped ?? 0) === 0) {
          // ⚠️ BOTH CONDITIONS ARE LOAD-BEARING, AND EACH FIXES A DIFFERENT WRONG QUESTION.
          //
          // `scanned > 0`  — barren means TRIED AND PRODUCED NOTHING, not "had nothing to do". A
          // caught-up vault scans 0 and embeds 0 every cycle; counting that made a HEALTHY IDLE
          // vault look permanently stalled, so the first message after a quiet spell rendered with
          // no estimate.
          //
          // `skipped === 0` — A SKIP IS PROGRESS. This is the third proxy this signal has been, and
          // the precise question is not "did anything EMBED?" but "IS `pending` SHRINKING?":
          //   • a row EMBEDDED  ⇒ leaves the backlog          ⇒ progress
          //   • a row SKIPPED   ⇒ nlp_processed = 1, TERMINAL ⇒ leaves the backlog ⇒ progress
          //   • a row FAILED    ⇒ nlp_processed = -1, and the self-heal at the top of every cycle
          //                       RESURRECTS it              ⇒ pending does NOT shrink ⇒ NOT progress
          // Whitespace-only content passes the `content != ''` filter (db/messages.js) and is
          // skipped by service.js after trimming, so a blank run is real, healthy work. Without
          // this clause it read as a stall AND the loop never breaks (`moved > 0`), so barren
          // climbed unbounded: measured 8 barren passes while `pending` fell 722 -> 367, the
          // estimate blanked for 4/9 samples — WHILE THE VAULT DRAINED FASTER THAN IT EVER DOES
          // EMBEDDING, because a blank needs no inference (independent review, 2026-07-17).
          // The two errors were mirror images: `noProgress` counted `failed` and was too LOOSE
          // (missed the resurrection loop); this counted `skipped` and was too TIGHT (invented
          // stalls during the fastest progress there is).
          _barrenPasses++;
        }
        embedded += batchEmbedded;
        if ((e?.scanned ?? 0) === 0) { embedDrained = true; break; }      // backlog drained
        // NO-PROGRESS BREAK. drainOnce leaves a transiently-failed row PENDING (by design —
        // never poison it), so a batch that embeds nothing re-selects the SAME rows next
        // pass: `scanned` stays 50 and this loop spins all 200 times, re-embedding the same
        // head of the queue and saturating the single-threaded embed service for minutes —
        // which then starves the health check and kills subsequent cycles. If a pass moved
        // nothing at all, the next pass can't either: stop and let the 15s tick retry.
        const moved = (e?.embedded ?? 0) + (e?.failed ?? 0) + (e?.skipped ?? 0);
        if (moved === 0) {
          if (++stalledPasses >= 1) {
            // THE STARVATION GUARD'S TRIGGER. A head-of-queue row that cannot embed right now must
            // never hold categorize hostage: this break says "embed is not progressing", and the
            // deferral below reads it as permission for the other stages to run. Without it, one
            // un-embeddable row would deadlock L1+L2 for the life of the process.
            embedStalledOut = true;
            _noProgress++;
            if (_noProgress === 1 || _noProgress % 20 === 0) log(`[enrich] no progress on ${e?.scanned ?? 0} pending message(s) after ${stalledPasses} pass(es) `
              + `— pausing this cycle (retry in ${Math.round(intervalMs / 1000)}s). The head of the queue is not embeddable right now.`);
            // D-131(b): the head has now failed to move for _noProgress straight
            // cycles. Stop hammering it: back off exponentially (2,4,8… capped
            // ≈10 min) and bounce the service ONCE per episode — a wedged
            // single-threaded service grinding an already-timed-out queue is the
            // usual burn, and a clean restart clears its queue while DEFER
            // re-selects the rows. Row state untouched (outage guard preserved).
            if (_noProgress >= STALL_BACKOFF_AFTER) {
              _stallBackoffCycles = Math.min(2 ** (_noProgress - STALL_BACKOFF_AFTER + 1), STALL_BACKOFF_MAX_CYCLES);
              log(`[enrich] embed head stalled for ${_noProgress} consecutive cycle(s) — backing off for ${_stallBackoffCycles} cycle(s) `
                + '(~' + Math.round((_stallBackoffCycles * intervalMs) / 1000) + 's). Progress, Resume or Retry resets this instantly.');
              if (!_stallBounced) {
                _stallBounced = true;
                fireEmbedServiceBounce('stalled-head');
              }
            }
            break;
          }
        } else stalledPasses = 0;
      }
      // R1: bank the work AND the time it cost, TOGETHER — and ONLY when work happened.
      //
      // WARNING: `embedded > 0` IS THE WHOLE CORRECTNESS ARGUMENT, not a micro-optimisation. This
      // used to bank the time unconditionally while the count came out 0 on the no-progress path,
      // so the ratio had a numerator that could freeze and a denominator that could not. A row
      // that fails TRANSIENTLY is left pending BY DESIGN (service.js: `if (vec == null) continue;`
      // — never poison a valid row), and a head-of-queue row that keeps timing out is a live,
      // documented bug with no attempt cap. Measured: embeddedTotal frozen at 200 while activeMs
      // climbed with wall-clock => perItem 1.7ms -> 51.3ms in TEN SECONDS, unbounded, never
      // recovering — and rendered as "running" with a countdown that GROWS, because health is ok
      // and `skips` is 0 so nothing marks it stalled. Over a day: "~3600m left", rising.
      // §3.9 exists to kill the plausible-but-wrong number; that WAS one, introduced by §3.9.
      // (Independent review, 2026-07-17. The design SAW IT COMING — §3.9: "an ETA over a `pending`
      // that never reaches 0 is infinity" — and I shipped without checking the precondition.)
      //
      // Banking only on progress also makes this field's NAME true: a cycle over an EMPTY backlog
      // still enters the loop and pays for one `drainOnce` probe, and that idle probe used to be
      // banked as "active" as well (~5ms x 5,760 cycles/day at the real 15s interval, zero embeds).
      //
      // A zero-progress pass's time is therefore excluded from the rate. That is the honest trade:
      // its cost was real but it produced nothing, so it cannot price anything. Time lost to
      // failures INSIDE a productive pass still counts — that was part of what those embeds cost.
      if (embedded > 0) {
        // NLP enrichment (embedded → enriched) now runs in the on-box message block below, so it
        // uses the hybrid LLM enricher after the daemon is woken (was a regex pass here).
        log(`[enrich] embedded ${embedded} message(s) in-process`);
        // Embedded SOMETHING this cycle (NOT "backlog drained" — the drain signal is the
        // `scanned === 0` break above, which does not gate this hook) → let the owner decide
        // whether to kick off the topology pipeline (first-run auto-generate). The gate is
        // deliberately progress-based, not completion-based: maybeAutoGenerate reads only
        // `embedded`/`points` and never `pending`, so auto-generate fires on a vault that
        // still has work left — which is what makes it fire at all on a vault carrying
        // permanently un-embeddable rows. Decoupled: the drainer never imports jobs.js;
        // server-rest wires the gate (single-flight + topology-empty).
        try { await onSettled?.({ embedded }); } catch { /* non-fatal */ }
        }
      // NEVER SILENT (the skip-log rule): a retired row left the backlog on purpose,
      // and the log is where that decision is auditable. Count only — no content, no id.
      if (capped > 0) {
        log(`[enrich] retired ${capped} message(s) from embedding after ${EMBED_MAX_ATTEMPTS} failed attempts against a healthy service `
          + '(recoverable: retried once next boot, or POST /portal/enrichment/retry-failed)');
      }
      if (_embedErrs) { log(`[enrich] embedding recovered after ${_embedErrs} failed cycle(s)`); _embedErrs = 0; }
      } catch (err) {
        // EMBEDDING FAILED — LABELING AND ENRICHMENT ARE NOT ITS DEPENDANTS. Swallowed HERE, at
        // the narrowest scope that can contain it, rather than at cycle()'s outer catch: from
        // there the throw skipped L1 + L2 (and the ensureLabelModel calls that feed the healths),
        // silencing two pipelines that never touch :8091 for a reason that has nothing to do with
        // them. The two throws this exists for (service.js: the locked-vault refusal, and a
        // SQLITE_BUSY on the batch read) both fire BEFORE any write, so rows stay pending and the
        // next tick retries for free. (An earlier draft justified that with "drainOnce is
        // transactional per batch" — FALSE, and exactly the kind of comment this repo treats as a
        // defect: service.js has no transaction at all, it is a per-row write loop. The
        // conclusion held; the mechanism was invented. Verified by an independent review,
        // 2026-07-16.) A throw AFTER partial writes leaves those rows written and the rest
        // pending, which is still resumable — but do not read the old claim back into this.
        //
        // NEVER SILENTLY (§the skip-log rule above): a throw you can't see is the month-long
        // dormancy all over again. The first THREE are logged before throttling — a persistent
        // programming error (not just a locked vault) surfaces here too, and one line in twenty
        // buried its 16 siblings; the counter carries the persistence either way. The message is
        // an ERROR STRING, not vault content — the same one cycle()'s outer catch has always
        // logged; bounded anyway, on the principle that this is not the place to bet on an
        // upstream error staying content-free. It names the STAGE that failed, never a cause:
        // a null-row TypeError surfaces here just as a locked vault does.
        // A THROW IS ALSO "EMBED CANNOT PROGRESS" (the starvation guard's second arm). A locked
        // vault throws EVERY cycle; if a throw could still leave the deferral armed, L1+L2 would be
        // starved forever by a stage that is not embedding anything at all — the same coupling the
        // catch itself exists to break, re-created by the scheduler.
        embedThrew = true;
        _embedErrs++;
        if (_embedErrs <= 3 || _embedErrs % 20 === 0) {
          log(`[enrich] embedding FAILED this cycle (#${_embedErrs}): ${String(err?.message || err).slice(0, 120)} `
            + '— backlog stays put; labeling + enrichment continue (they do not use the embed service)');
        }
      }
      finally { embedAdm.release(); } // ALWAYS free the BULK embed ticket — crash-release #1
      } // ← end `if (embedAdm && embedAdm.ok)`. Everything BELOW runs even when the embed sidecar is down.

      // ── EMBED FIRST, THEN CATEGORIZE (QA6) — the deferral decision ──────────────────────────────
      // The decision itself is the PURE function above (deferCategorizeForEmbed); this is only the
      // wiring — what the cycle OBSERVED, handed to the rule. Split that way for the same reason
      // deriveEmbedLiveness is split out of portal-activity: a scheduling rule that can only be
      // exercised by driving a 10,000-row drain is a rule whose individual clauses no gate can red
      // (proved: mutating the `embedMoved > 0` clause left every integration case green, because the
      // stall break masks it — [[two-guards-can-mask-each-other]]).
      const waitOnEmbed = deferCategorizeForEmbed({
        embedOk, embedPaused: isEmbedPaused(), embedThrew, embedMoved, embedDrained, embedStalledOut,
      });
      _catWaitingOnEmbed = waitOnEmbed;
      if (waitOnEmbed) {
        // NEVER SILENT (the skip-log rule this file already lives by): a stage that stops running
        // for a reason the user did not choose must SAY SO, or this is the month-long dormancy with
        // a new cause. Throttled — a big import defers every cycle for hours by design.
        _catDeferrals++;
        if (_catDeferrals === 1 || _catDeferrals % 20 === 0) {
          log(`[enrich] deferring categorize + enrich this cycle (#${_catDeferrals}): embedding is still draining its backlog `
            + `(${embedMoved} row(s) moved this cycle, cap reached) — one stage at a time, on purpose. `
            + 'Labeling resumes as soon as embedding is caught up or cannot progress.');
        }
      } else if (_catDeferrals) {
        log(`[enrich] embedding caught up (or cannot progress) after ${_catDeferrals} deferred cycle(s) — resuming categorize + enrich`);
        _catDeferrals = 0;
      }

      // Context Engine L1: tag new + backfill messages with domain/register. Separate from
      // the embed gate so the historical backfill proceeds on cycles with no new embeds.
      // Bounded per cycle (≤8 batches = 200 msgs); stops on a model outage (failed>0), leaving
      // the rest pending for the next tick. Single-flighted by the outer `running` guard.
      //
      // USER PAUSE: the owner can stop the on-box-model churn (POST /portal/enrichment/
      // categorize/pause). Skip the wake + the tagging loop entirely while paused — rows stay
      // pending and resume exactly where they left off (resumable + idempotent). Embedding above
      // is unaffected. A restart clears the pause (safe default; see the flag's note).
      //
      // `labelM` / `enrichM` were resolved and stamped at the TOP of this try — on EVERY cycle,
      // pause or not, and above anything that can throw. Both placements are load-bearing and
      // were each a real bug: inside the pause block, a paused vault never stamped and reported
      // 'unknown' forever; below the embed gate, a throwing drain did the same. Do not move them
      // back down for tidiness.
      // ⚠️ `!waitOnEmbed` GATES THE WAKE TOO, NOT JUST THE LOOPS — and that is deliberate. The block
      // below calls daemon.ensureUp() (which auto-INSTALLS the Ollama runtime) and pulls the label +
      // enrich models: the single largest RAM commitment in the process, next to the resident
      // embedding model. Gating only the tagging loops would still have spun up a second model
      // alongside the embedder on every cycle of a long import — the memory concurrency the
      // operator's 24GB crash was made of. The healths do NOT read this flag (a deferral is not a
      // pause and not a fault): _approvedModel/_approvedEnrichModel are stamped at the top of every
      // cycle and probeModelReady() still runs, so labelerHealth()/enricherHealth() keep answering
      // exactly what they answered before. The deferral is reported through status() instead.
      // COMPUTE GOVERNOR (D-001, P1 — the reported symptom): the categorize + enrich block below is
      // where the drainer loads Ollama models (daemon.ensureUp + ensureLabelModel + the classify/
      // enrich passes) — a RESIDENT lane. Reserve the single model slot BEFORE the wake. If another
      // resident lane holds it (a describe-chronicles/describe-clusters child, a clustering run, a
      // chat turn), admission is refused and this whole block is skipped THIS CYCLE — so the drainer
      // never loads a second Ollama model alongside a describe pass (the collision the operator's
      // crash was made of). Refusal is DEFER: the block re-selects its pending set next cycle, no
      // queue, no memory growth. Rendered as `waiting` via _catWaitingOnCompute → status(). The lease
      // is 0 (no lease): a synchronous cycle holds the ticket only for its own duration and always
      // releases in the finally, so a leaked ticket is impossible here.
      _catWaitingOnCompute = false;
      let catAdm = null;
      if (!isCategorizePaused() && !waitOnEmbed) {
        catAdm = admit({ lane: 'embed-drain-categorize', klass: CLASS.RESIDENT, timeoutMs: 0 });
        if (!catAdm.ok) {
          _catWaitingOnCompute = true;
          _govDeferrals++;
          if (_govDeferrals === 1 || _govDeferrals % 20 === 0) {
            log(`[enrich] deferring categorize + enrich this cycle (#${_govDeferrals}): the compute governor is holding the model slot for another lane `
              + `(${catAdm.reason}) — one resident model at a time, on purpose (D-001). Resumes as soon as the slot frees.`);
          }
        } else if (_govDeferrals) {
          log(`[enrich] compute slot free after ${_govDeferrals} deferred cycle(s) — resuming categorize + enrich`);
          _govDeferrals = 0;
        }
      }
      if (catAdm && catAdm.ok) {
       // ── THE L1+L2 BLOCK MUST HAND THE CYCLE BACK (D-047 ↻1, the "embeddings are stuck" half) ──
       // cycle() is SINGLE-FLIGHT (`running`), and the embed drain runs ABOVE this block. So for as
       // long as this block runs, THE EMBED DRAIN CANNOT EVEN ATTEMPT. Unbounded, that is a long
       // time: L2 alone is 8 passes x batchSize 50 = 400 rows, which at the measured 8/min is
       // ~50 MINUTES in ONE cycle, with L1 on top. During the operator's 5.5K import that is
       // exactly what "embeddings appear stuck / not moving" looks like from the outside — not a
       // hung embedder, a stage that never got the box back.
       //
       // The row-level ordering invariant (selectPendingCategories' `embedding_768 IS NOT NULL`)
       // bounds the DAMAGE — categorize can only ever chew through rows that are already embedded,
       // so it can never outrun embedding again — but it does not bound the TIME. This does: the
       // block stops starting new passes past the budget and returns, the 15s tick fires, and the
       // embed drain gets its turn. Nothing is lost: both loops re-select their pending set every
       // cycle (the same resumable-by-construction property the pause relies on).
       //
       // Checked BETWEEN passes only, never mid-pass — the same insertion point as the pause and
       // the §3.4 yield, and for the same reason: a half-written label is worse than a slow one.
       const catDeadline = Date.now() + CATEGORIZE_CYCLE_BUDGET_MS;
       const outOfBudget = () => Date.now() > catDeadline;
       try {
        // WAKE THE ON-BOX MODEL FIRST. The Ollama daemon is lazy and the enrich path is the one
        // consumer that nothing else starts it for — so without this, a vault whose owner never
        // opened local chat would leave EVERY message untagged forever (the live-vault dormancy
        // bug). Wake it only when there's actual pending work, so an idle vault never spawns a
        // model. ensureUp() adopts a running daemon instantly (single-flight) and NEVER throws;
        // if it can't come up, the loop below fails-soft (rows stay pending) exactly as before.
        // ⚠️ NOT `true` (§3.10c). These used to default to ready, so an unapproved/unresolved
        // model still ran the classifier. Ready now MEANS an approved model is installed.
        let modelReady = false;
        let enrichReady = false;
        // ⚠️ THE SECOND SILENT PATH. daemon.ensureUp() auto-INSTALLS the Ollama runtime
        // (ollama-daemon.js autoInstall = true) — a download of its own, before the model
        // pull is even considered. So the consent gate must sit ABOVE the wake, not just at
        // the pull: approving labeling approves BOTH; declining fetches NEITHER.
        if (daemon && (labelM || enrichM)) {
          try {
            const [pc, pn] = await Promise.all([
              db.messages.selectPendingCategories(userId, { limit: 1 }),
              db.messages.selectPendingNlp(userId, { limit: 1 }),
            ]);
            if (pc.length || pn.length) {
              await daemon.ensureUp(); // wake the server for tagging OR enrichment work
              // ensure the MODELS are installed (pull once if missing), keyed on the RESOLVED models.
              if (pc.length) modelReady = await ensureLabelModel(labelM);
              if (pn.length) enrichReady = await ensureLabelModel(enrichM);
            }
          } catch { /* never block the cycle on the wake — the loops fail-soft if the model is down */ }
        }
        if (modelReady) {
          // The try/catch is the MED fix (#210 review): a throw AROUND the pass (updateCategories
          // is outside service.js's row try) must move a counter the ETA can see, or the rate
          // freezes at its last honest value and keeps promising. Deliberately NOT fixed by moving
          // updateCategories into the row try — that would change service retry semantics (a
          // per-row write failure would become failed+continue instead of batch abort); the
          // block-level counter covers the whole throw-around-the-pass family uniformly.
          // Rethrows nothing; logs on the same throttle shape as _embedErrs.
          try {
          const cycleClassify = await labelClassifier(labelM);
          let tagged = 0;
          for (let i = 0; i < 8; i++) {
            if (isCategorizePaused()) break;   // same rule as the embed loop: honor it mid-run
            if (catAdm.shouldYield()) break;   // an interactive chat turn is preempting — yield the slot between batches (§3.4)
            if (i > 0 && outOfBudget()) break; // hand the cycle back so the embed drain can run (see the budget note above)
            // BANK PER PASS, exactly like the embed loop (§3.9/R1). enrichCategoriesOnce returns
            // { scanned, enriched, failed } (service.js:194 — NO `skipped` field), so the three
            // cases are read from THOSE fields, not embed's:
            //   • enriched > 0        → progress. Bank the pass's active time + count, reset barren.
            //   • enriched 0, failed 0 (scanned > 0) → a BLANK-CONTENT run: service.js:177 marks
            //     each whitespace-only row categories_processed = 1 (TERMINAL) and `continue`s —
            //     the row LEAVES the backlog, so `pending` shrinks. This is the embed loop's "a
            //     SKIP is progress" case, and it must NOT be barren or the ETA blanks while the
            //     backlog drains fastest (blanks need no inference). Neither bank nor barren.
            //   • failed > 0          → L1's THROW-EQUIVALENT: a transient classify failure leaves
            //     the row pending (categories_processed stays 0) and BREAKS the batch (service.js:183),
            //     so `pending` does NOT shrink and the rate is unknowable. Barren++ (the null signal).
            const passStartedAt = Date.now();
            const c = await svc.enrichCategoriesOnce({ userId, classify: cycleClassify });
            const taggedThisPass = c?.enriched ?? 0;
            tagged += taggedThisPass;
            if (taggedThisPass > 0) {
              _l1ActiveMs += Date.now() - passStartedAt;
              _l1Total += taggedThisPass;
              _l1Barren = 0;
              _l1Errs = 0;   // a pass that TAGGED proves the write path works (the _embedErrs rule: progress outranks a throw)
            } else if ((c?.failed ?? 0) > 0) {
              _l1Barren++;
            }
            if ((c?.scanned ?? 0) === 0 || (c?.failed ?? 0) > 0) break;
          }
          if (tagged > 0) log(`[enrich] tagged ${tagged} message(s) via ${cycleClassify.model || 'local model'}`);
          if (_l1Errs) { log(`[enrich] L1 categorize recovered after ${_l1Errs} failed cycle(s)`); _l1Errs = 0; }
          } catch (err) {
            _l1Errs++;
            if (_l1Errs <= 3 || _l1Errs % 20 === 0) {
              log(`[enrich] L1 categorize FAILED this cycle (#${_l1Errs}): ${String(err?.message || err).slice(0, 120)}`);
            }
          }
        }
        // L2: hybrid semantic enrichment (entities + gist) — gated on the enrich model being present;
        // the enricher degrades to regex if the model is down, so rows never stall.
        // D-132: an owner-deferred L2 skips the block entirely (embed + L1 unaffected);
        // the feed renders the deferred row honestly (portal-activity 'deferred').
        if (enrichReady && !isEnrichDeferred()) {
          // Same MED fix as the L1 block above: on a locked vault updateNlp throws AND the
          // catch's −1 write throws, so the throw escapes enrichNlpOnce entirely — around the
          // pass, past the barren counter. Block-level errs or the rate freezes-and-promises.
          try {
          const cycleEnrich = await messageEnricher(enrichM);
          let enrichedSem = 0;
          for (let i = 0; i < 8; i++) {
            // Same rule as the embed loop (:845) and the L1 loop above: honor a pause MID-RUN.
            // This was the ONE loop of the three without the check — up to 8 batches x 50 rows
            // of continued full-CPU inference after the user pressed Stop, which at the measured
            // 8/min is ~50 MINUTES of ignored click, on the stage the import copy calls "days".
            // Proven live by review round 3: pause flipped after batch 2, SEVEN more batches ran
            // (L1: zero). "A pause the user watches their fans ignore is the same broken promise
            // as no pause at all" — and #204's copy says "pause ANY of it", so this line is what
            // makes that sentence true (independent review HIGH-6, 2026-07-17).
            if (isCategorizePaused() || isEnrichDeferred()) break; // D-132: defer honored mid-run too
            if (catAdm.shouldYield()) break;   // interactive preemption — yield the model slot between batches (§3.4)
            // ⚠️ `i > 0` — L2 IS GUARANTEED ITS FIRST PASS, and reversing this was a real
            // regression the review caught (QA9, MEDIUM-4). The first draft omitted the exemption
            // here on the reasoning that L1 runs first and may legitimately consume the budget, so
            // L2 should be allowed zero passes. The arithmetic says zero is not *allowed*, it is
            // the ONLY outcome: L1's three passes already overshoot the 90 s budget (~110 s), so
            // `outOfBudget()` is ALWAYS true by the time L2 reaches i=0. That would stop L2 running
            // at all for the entire duration of any L1 backlog — turning a slow stage into a dead
            // one, and leaving its ETA with no samples to withdraw. Every loop in this cycle gets
            // its first pass; the budget only caps how many FURTHER passes it takes.
            // HONEST RESIDUAL: one L2 pass is batchSize 50 @ ~8/min ≈ 6 min, so a cycle can still
            // hold the embed drain out for that long. Bounding it properly needs a SMALLER L2 batch
            // (enrichNlpOnce takes batchSize), which is a throughput change with its own gate —
            // recorded, not smuggled in here.
            if (i > 0 && outOfBudget()) break;
            // BANK PER PASS, same discipline as L1 and embed. enrichNlpOnce returns
            // { scanned, enriched, failed } (service.js:227). L2 has NO blank/skip path — every
            // scanned row either enriches (nlp_processed = 1) or is isolated to nlp_processed = -1
            // (service.js:207-224) — so `enriched === 0` on a non-empty batch means every row
            // FAILED. Those rows leave the pending set (-1 is terminal; selectPendingNlp keys on
            // = 2), but nothing was actually enriched, so the rate is unknowable and the estimate
            // must be withdrawn rather than promise a finish built on failures ⇒ barren++.
            const passStartedAt = Date.now();
            const n = await svc.enrichNlpOnce({ userId, enrich: cycleEnrich });
            const enrichedThisPass = n?.enriched ?? 0;
            enrichedSem += enrichedThisPass;
            if (enrichedThisPass > 0) {
              _l2ActiveMs += Date.now() - passStartedAt;
              _l2Total += enrichedThisPass;
              _l2Barren = 0;
              _l2Errs = 0;   // a pass that ENRICHED proves the write path works (progress outranks a throw)
            } else if ((n?.scanned ?? 0) > 0) {
              _l2Barren++;
            }
            if ((n?.scanned ?? 0) === 0 || (n?.failed ?? 0) > 0) break;
          }
          if (enrichedSem > 0) log(`[enrich] enriched ${enrichedSem} message(s) via ${cycleEnrich.model || 'local model'}`);
          if (_l2Errs) { log(`[enrich] L2 enrich recovered after ${_l2Errs} failed cycle(s)`); _l2Errs = 0; }
          } catch (err) {
            _l2Errs++;
            if (_l2Errs <= 3 || _l2Errs % 20 === 0) {
              log(`[enrich] L2 enrich FAILED this cycle (#${_l2Errs}): ${String(err?.message || err).slice(0, 120)}`);
            }
          }
        }
       } finally {
         // ALWAYS free the model slot — crash-release #1 (finally). A cycle throw, a pause mid-run,
         // or a clean drain all release here, so the next resident lane (or the next cycle) can run.
         catAdm.release();
       }
      }
    } catch (err) {
      log(`[enrich] drain cycle error: ${String(err?.message || err)}`);
    } finally {
      running = false;
      if (pending) { pending = false; setImmediate(cycle); } // a nudge arrived mid-cycle
    }
  }

  cycle();                                       // drain any backlog on boot
  // ⚠️ THE BACKOFF CLOCK ADVANCES HERE — per TICK, never per cycle() ENTRY. It sat at cycle()
  // entry first, and nudge() IS cycle(): chat and import saves nudge PER SAVE, so an import
  // nudge-flood ran the ordinal at save pace and collapsed the 40-cycle cap from ~10 minutes to
  // ~4-8 seconds between retries — during exactly the workload (pending L1 rows) that coincides
  // with a failing pull. Measured: 9 attempts in 6s vs the designed 5 per 15 minutes (review
  // round 2, 2026-07-17). The same adjacent-question class as everything else in this file:
  // "how many times did cycle() run" is not "how many ticks passed". Advancing in the timer
  // callback counts wall-time ticks even when single-flight skips the cycle body (time DID pass),
  // and nudged entries reuse the current ordinal, so `decAt` blocks their decrement.
  timer = setInterval(() => { _cycleN++; cycle(); }, intervalMs);
  if (timer.unref) timer.unref();                // never keep the process alive for the timer

  const handle = {
    resetPullBackoff: () => { _pullBackoff.clear(); },
    // retry-failed support: clear the service's in-memory L1 label-attempt counters
    // (see resetEnrichGiveUpCounters above; the DB-side reset is the DAL's job).
    resetLabelAttempts: () => { try { svc.resetLabelAttempts?.(); } catch { /* best-effort */ } },
    labelerHealth,        // → getLabelerHealth(), the readiness `models.labeler` slice
    enricherHealth,       // → getEnricherHealth(), the readiness `models.enricher` slice
    // D-131(b): TWO nudge grades. A DELIBERATE nudge (clearStallBackoff — the
    // operator's Resume/Retry, routed via nudgeEnrichDrainer) clears the backoff
    // and re-arms the once-per-episode bounce: it must not be eaten by a backoff
    // (the honored-at-the-next-cycle bug). An INGEST nudge (default — every
    // chat/import save via enqueueEnrichment) only kicks a cycle: it must NEVER
    // clear the backoff or re-arm the bounce, or a stalled head + routine saves
    // becomes a SIGKILL-per-save storm (round-1 review, reproduced).
    nudge: ({ clearStallBackoff = false } = {}) => {
      if (clearStallBackoff) { _stallBackoffCycles = 0; _stallBounced = false; }
      return cycle();
    }, // returns the cycle promise (callers may ignore it; the gate awaits it)
    // ⚠️ CLEAR THE DEFERRAL ON STOP. It is a statement about a cycle that is ABOUT TO RUN; a stopped
    // drainer has none, so leaving it latched would let a handle nobody drives keep reporting
    // "categorize is waiting on embedding" — a block with no clock behind it, which is the frozen
    // half-truth this whole surface exists to delete.
    stop: () => { if (timer) clearInterval(timer); timer = null; _catWaitingOnEmbed = false; _catWaitingOnCompute = false; _embedWaitingOnCompute = false; if (_current === handle) _current = null; },
    // LIVENESS, for the activity feed. The UI used to render "Embedding messages" purely
    // from `pending > 0` — so a drainer that had been dead for a MONTH still looked busy
    // (it skipped silently every 15s because a single-threaded embed service blocked
    // /health). A progress indicator that can't distinguish "working" from "dead" is worse
    // than none: it hides the outage it exists to reveal.
    status: () => ({
      alive: true,
      running,                         // a cycle is IN FLIGHT right now — the opposite of stalled
      lastCycleAt: _lastCycleAt,       // start of the last cycle that RAN — embedding may have been skipped (see `health`/`skips`). 0 = never
      lastProgressAt: _lastProgressAt, // last time a message was actually embedded
      skips: _skips,                   // consecutive cycles skipped: embed service unhealthy
      // consecutive cycles whose embed block THREW. DISTINCT from `skips`: a skip is the health
      // gate declining to drain (the service looks unhealthy); this is the drain itself failing
      // on a service that looked FINE — a locked vault or a SQLITE_BUSY. It is exposed for the
      // same reason `skips` is: the guard that keeps a throw from silencing L1+L2 also keeps it
      // out of every surface that isn't stderr, so a permanently-locked vault read 'ok' from the
      // healths AND clean from status() while embedding was dead — the exact shape of the
      // month-long dormancy (independent review, 2026-07-16; the review also caught the comment
      // that called this counter "its own surface" while it was a private local).
      embedErrs: _embedErrs,
      embeddedTotal: _embeddedTotal,   // R1: messages embedded since start — the rate's numerator
      embedActiveMs: _embedActiveMs,   // R1: ms spent draining (NOT elapsed) — the rate's denominator
      noProgress: _noProgress,         // consecutive passes where NOTHING moved (log throttle)
      // D-131(b): the drain is in stalled-head BACKOFF — skipping cycles instead of
      // re-hammering an unembeddable head. A SCHEDULING state (rows untouched).
      // Exposed for consumers + the gate; the activity feed does NOT render it yet
      // (residual, recorded in the D-131 ledger row) — the backoff is visible in
      // the server log ("backing off for N cycle(s)") and here.
      embedStallBackoffCycles: _stallBackoffCycles,
      embedStallBackoff: _embedStallBackoff,
      barrenPasses: _barrenPasses,     // R1: consecutive batches that embedded NOTHING — the stall signal
      // L1 (categorize) + L2 (nlp enrich) throughput — the numerators/denominators for
      // categorizeEta / enrichEta, banked per pass in the loops above. Same contract as the
      // embed trio: Total ÷ ActiveMs = the measured rate; Barren ≥ 2 ⇒ withdraw the estimate.
      l1Total: _l1Total,
      l1ActiveMs: _l1ActiveMs,
      l1BarrenPasses: _l1Barren,
      l2Total: _l2Total,
      l2ActiveMs: _l2ActiveMs,
      l2BarrenPasses: _l2Barren,
      // The block-throw counters (#210 MED): barren sees a failure INSIDE a pass; these see a
      // throw AROUND it (updateCategories outside the row try; a locked vault's double-throw in
      // updateNlp). Either ≥ 2 withdraws the stage's ETA — the embedErrs clause, per stage.
      l1Errs: _l1Errs,
      l2Errs: _l2Errs,
      // QA6: the categorize/enrich stages are DEFERRED this cycle because embedding is still
      // draining. Reported so the pipeline slice can render categorize as `blocked`/`waiting_embed`
      // instead of a silent `pending` or a lying `running` with an ETA nothing is working towards.
      // A SCHEDULING state — never a pause (the owner chose nothing) and never a fault.
      categorizeWaitingOnEmbed: _catWaitingOnEmbed,
      // D-001: the categorize/enrich stages are DEFERRED this cycle because the compute governor is
      // holding the single model slot for another resident lane (a describe child, clustering, or a
      // chat turn). SAME contract as categorizeWaitingOnEmbed — a scheduling `waiting`, never a
      // pause, never a fault — so the pipeline slice renders it as `waiting`, not a stalled lane.
      categorizeWaitingOnCompute: _catWaitingOnCompute,
      // D-132: the owner deferred the L2 pass (its own latch — the projections read the
      // drainer's decision, never re-derive it).
      enrichDeferred: _enrichDeferred,
      // D-001 (finding #2): the embed drain itself is deferred this cycle by the BULK governor
      // (memory pressure / a resident model loaded / BULK budget). Same `waiting` contract.
      embedWaitingOnCompute: _embedWaitingOnCompute,
      health: _health,                 // ok | loading | error | unreachable
      // A model still LOADING is not a fault — it's a download. Only a real outage is.
      // ⚠️ `stalled` keys on _skips ALONE, deliberately unchanged: it drives the activity feed's
      // "embedding" indicator, and a throwing drain is already carried by `embedErrs` above.
      // Widening it here without tracing every consumer would be the fix-by-guess this file's
      // history warns about — recorded as the next unit's work, not smuggled into this one.
      stalled: _skips > 0 && _health !== 'loading',
      starting: _health === 'loading',
    }),
  };
  _current = handle; // expose to nudgeEnrichDrainer() for the portal trigger route
  return handle;
}

export default startEnrichDrainer;
