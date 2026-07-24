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

const DEFAULT_INTERVAL_MS = 20000;
const PER_CYCLE = Number(process.env.MYCELIUM_TRANSCRIBE_RETRY_BATCH) || 2; // decodes are heavy — a couple per cycle
const ATTEMPT_CAP = Number(process.env.MYCELIUM_TRANSCRIBE_RETRY_CAP) || 3;

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
      // Only drain when the transcriber is actually ready — an unconfigured/loading vault waits.
      let health = null;
      try { health = await readHealth(); } catch { health = null; }
      if (!health || health.status !== 'ok') return;

      let ids = [];
      try { ids = await db.attachments.listPendingTranscription(userId, { limit: PER_CYCLE + capped.size }); }
      catch { ids = []; }
      _lastPendingCount = ids.length;
      const work = ids.filter((id) => !capped.has(id)).slice(0, PER_CYCLE);
      let done = 0, busy = 0;
      for (const id of work) {
        let r;
        try { r = await doTranscribe(id); } catch { r = { ok: false, reason: 'failed' }; }
        if (r?.ok) { attempts.delete(id); done++; continue; }
        if (r?.reason === 'compute-busy') { busy++; continue; } // capacity, not a failure — retry next cycle, do NOT count
        // A real decode outcome (no-speech / engine-error / service-down). Count it; cap eventually.
        const n = (attempts.get(id) || 0) + 1;
        attempts.set(id, n);
        if (n >= ATTEMPT_CAP) { capped.add(id); attempts.delete(id); }
      }
      if (done || busy) log(`[transcribe-retry] transcribed ${done}, ${busy} deferred (compute-busy), ${capped.size} capped this boot`);
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
    resetCaps: () => { capped.clear(); attempts.clear(); },
    status: () => ({ alive: true, running, lastCycleAt: _lastCycleAt, pending: _lastPendingCount, capped: capped.size }),
  };
  _current = handle;
  return handle;
}

export default startTranscribeRetry;
