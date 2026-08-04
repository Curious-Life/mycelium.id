// src/enrich/transcribe-retry.js — the background transcription drain (D-001, round-2 review #1).
//
// WHY THIS EXISTS. The compute governor makes transcribeAttachment return a RETRYABLE `compute-busy`
// when a BULK ticket is refused (a whisper decode must not stack a 2nd heavy model on live embed +
// a resident describe — the operator's audio-import crash path). But the ONLY import-path caller is
// fire-and-forget with the result DISCARDED (ingest/run-import.js) and the portal /transcribe route
// is user-initiated — NEITHER retries. Without a background drain, a voice note refused under
// pressure is saved untranscribed and NEVER revisited: an audio-heavy import silently
// under-transcribes. This loop closes that: it periodically selects audio attachments still missing
// a transcript and retries them, so a `compute-busy` (or any transient failure) is eventually
// picked up once capacity frees. Self-resolving, no user action.
//
// ATTEMPT DISCIPLINE (the embed-drainer lesson: never a heal→fail→heal loop):
//   • ok                         → transcript written; it leaves the pending set naturally.
//   • compute-busy               → CAPACITY, not a decode failure. Do NOT count it; leave the note
//                                  retriable so it is picked up the moment BULK frees.
//   • any other non-ok reason    → a real decode outcome (no-speech / engine-error / a down
//                                  service). Count it; after ATTEMPT_CAP counted attempts, stop
//                                  retrying THIS boot (a no-speech file must not re-decode forever).
//     The cap is in-memory and resets on restart — a new boot re-attempts (new conditions), exactly
//     like the embed drainer's boot reclaim. No schema change, no migration.
//
// Bounded per cycle. Gated on the transcriber being READY (health ok) so an unconfigured vault
// touches nothing. Every collaborator is injectable so the gate drives it offline + deterministically.
//
// RE-EMBED ON A LATE TRANSCRIPT — INHERITED, DELIBERATELY NOT REPEATED HERE. This drain is the
// path a late transcript most often takes, so the message that owns the attachment is almost
// always ALREADY embedded (from `content` alone — "File: memo.ogg" on the import path) by the
// time the decode lands. Re-queueing it for embedding is therefore mandatory, and it happens
// exactly once, inside `transcribeAttachment` at the transcript write itself
// (transcribe-attachment.js → markMessagesForReembed). Do NOT add a second mark in this loop:
// `doTranscribe` is injectable, so a mark here would fire against a stub in the gates and would
// double-write on the real path for no gain.

import { isImportQuiesced } from '../db/import-quiesce.js';

const DEFAULT_INTERVAL_MS = 20000;
const PER_CYCLE = Number(process.env.MYCELIUM_TRANSCRIBE_RETRY_BATCH) || 2; // decodes are heavy — a couple per cycle
const ATTEMPT_CAP = Number(process.env.MYCELIUM_TRANSCRIBE_RETRY_CAP) || 3;
// A long recording legitimately needs several resume passes; 20 covers a multi-hour file at the
// bounded per-pass budget while still terminating if coverage ever stops being monotonic.
const PASS_CEILING = Number(process.env.MYCELIUM_TRANSCRIBE_PASS_CEILING) || 20;

let _current = null;

/** Live status for the activity feed / readiness — null when no retry loop is running. */
export function getTranscribeRetryStatus() { try { return _current?.status?.() ?? null; } catch { return null; } }
/** Kick the retry loop if one is running (e.g. after an import saved new audio). */
export function nudgeTranscribeRetry() { try { _current?.nudge(); } catch { /* best-effort */ } return Boolean(_current); }

export function startTranscribeRetry({
  db,
  userId,
  intervalMs = DEFAULT_INTERVAL_MS,
  // The real per-attachment transcriber (BULK-ticketed inside). Injectable for the gate.
  transcribe = null,
  // Transcriber-service health read. Injectable; defaults to the live supervisor. Only drains when 'ok'.
  getHealth = null,
  log = (m) => process.stderr.write(`${m}\n`),
} = {}) {
  const attempts = new Map();   // attachmentId → counted decode attempts (compute-busy NOT counted)
  const passes = new Map();     // attachmentId → EVERY pass this boot, progress or not (hard ceiling)
  const capped = new Set();     // attachmentId → gave up THIS boot (ATTEMPT_CAP reached)
  let running = false;
  let pending = false;
  let timer = null;
  let _lastCycleAt = 0;
  let _lastPendingCount = 0;

  const doTranscribe = transcribe || (async (id) => {
    const { transcribeAttachment } = await import('./transcribe-attachment.js');
    return transcribeAttachment(db, userId, id);
  });
  const readHealth = getHealth || (async () => {
    try { const m = await import('../transcribe/supervisor.js'); return m.getTranscriberHealth(); }
    catch { return null; }
  });

  async function cycle() {
    if (running) { pending = true; return; }
    running = true;
    try {
      _lastCycleAt = Date.now();
      // D-128: a bulk import owns the vault — this drain's attachment writes must not
      // interleave with a mass raw restore. Re-checked every cycle; work is deferred, not lost.
      if (isImportQuiesced()) return;
      // ── D-133: AN AUTHORITATIVE DISABLE, RE-CHECKED EVERY CYCLE ──
      // On 2026-07-30 the operator spent a session trying to stop this loop: env throttles
      // didn't stop it, killing :8093 just made the supervisor respawn it, and the only
      // thing that worked was nulling the transcriber model. Embed and categorize both have
      // persisted pauses; this drain had NONE. Two switches, both consulted per cycle (the
      // restorePauseOnce lesson — a disable read once is no disable):
      //   • env  MYCELIUM_TRANSCRIBE_RETRY_DISABLED=1  (operator/session scope)
      //   • settings.transcribeDrainPaused             (persisted, survives restarts)
      if (String(process.env.MYCELIUM_TRANSCRIBE_RETRY_DISABLED || '') === '1') return;
      try {
        const s = await db.users?.getSettings?.(userId);
        if (s && (s.transcribeDrainPaused === true || s.transcribeDrainPaused === 1 || s.transcribeDrainPaused === '1')) return;
      } catch { /* a failed settings read never blocks the drain (fail-soft to RUNNING, like the embed pause) */ }
      // Only drain when the transcriber is actually ready — an unconfigured/loading vault waits.
      let health = null;
      try { health = await readHealth(); } catch { health = null; }
      if (!health || health.status !== 'ok') return;

      let ids = [];
      // +1 over the working limit so the status/log can tell "exactly N pending" from
      // "N+ pending" — a LIMITed count printed as the whole backlog claimed a 500-file
      // queue was '2 pending' (independent review, 2026-08-03: a stronger version of the
      // misleading message D-133 is about).
      const workLimit = PER_CYCLE + capped.size;
      try { ids = await db.attachments.listPendingTranscription(userId, { limit: workLimit + 1 }); }
      catch { ids = []; }
      const backlogMore = ids.length > workLimit;
      _lastPendingCount = ids.length;
      const work = ids.filter((id) => !capped.has(id)).slice(0, PER_CYCLE);
      let done = 0, busy = 0, resumed = 0;
      for (const id of work) {
        passes.set(id, (passes.get(id) || 0) + 1);
        let r;
        try { r = await doTranscribe(id); } catch { r = { ok: false, reason: 'failed' }; }
        if (r?.ok) { attempts.delete(id); done++; continue; }
        if (r?.reason === 'compute-busy') { busy++; continue; } // capacity, not a failure — retry next cycle, do NOT count
        // ── D-076: A RESUME THAT ADVANCED IS PROGRESS, NOT A FAILED ATTEMPT ────────────────────
        // A 30-minute recording can legitimately need SEVERAL passes to finish: each live-turn or
        // drain pass is bounded, and the row now resumes from its recorded coverage. Counting those
        // passes against ATTEMPT_CAP would abandon the file after 3 cycles with, say, 12 of 30
        // minutes transcribed — the same truncation this defect is about, arrived at differently.
        // The exemption is STRICTLY GATED on `progressed`, which transcribe-attachment.js sets only
        // when coverage moved forward by more than half a second. A pass that advances nothing IS
        // counted, so a wedged file can never loop forever.
        // ⚠️ AND A GLOBAL CEILING INDEPENDENT OF `progressed`. The exemption's termination argument
        // rests on coverage being monotonic, which is now enforced in three places — but a loop
        // guard that depends on a property enforced elsewhere is one refactor away from being no
        // guard at all (adversarial review round 2, LOW-8). `passes` counts EVERY pass on an
        // attachment this boot and caps it regardless of progress, so the worst case is bounded by
        // arithmetic rather than by an invariant held in another file.
        if (r?.partial && r?.progressed && (passes.get(id) || 0) < PASS_CEILING) { attempts.delete(id); resumed++; continue; }
        // A real decode outcome (no-speech / engine-error / service-down). Count it; cap eventually.
        const n = (attempts.get(id) || 0) + 1;
        attempts.set(id, n);
        if (n >= ATTEMPT_CAP) { capped.add(id); attempts.delete(id); }
      }
      // D-133: say COMPLETED, and name the backlog. The old line — "transcribed 2,
      // 0 advanced" — read as a stuck loop while it was legitimately draining the
      // oldest 2 of a large backlog each cycle; the operator fought it for a session.
      if (done || busy || resumed) log(`[transcribe-retry] completed ${done} of ${backlogMore ? `${workLimit}+` : _lastPendingCount} pending, resumed ${resumed} partial, deferred ${busy} (compute-busy), ${capped.size} capped this boot`);
    } catch (err) {
      log(`[transcribe-retry] cycle error: ${String(err?.message || err)}`);
    } finally {
      running = false;
      if (pending) { pending = false; setImmediate(cycle); }
    }
  }

  cycle();
  timer = setInterval(cycle, intervalMs);
  if (timer.unref) timer.unref();

  const handle = {
    nudge: () => cycle(),
    stop: () => { if (timer) clearInterval(timer); timer = null; if (_current === handle) _current = null; },
    // Reset the per-boot caps (the retry-failed route / a model swap should re-attempt).
    resetCaps: () => { capped.clear(); attempts.clear(); passes.clear(); },
    status: () => ({ alive: true, running, lastCycleAt: _lastCycleAt, pending: _lastPendingCount, capped: capped.size }),
  };
  _current = handle;
  return handle;
}

export default startTranscribeRetry;
