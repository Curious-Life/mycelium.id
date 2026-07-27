// src/enrich/transcribe-attachment.js — transcribe ONE stored attachment, IN-PROCESS.
//
// The shared job behind both the owner-gated Transcribe button (portal-attachments)
// and auto-transcribe-on-upload. Runs in the app process so every transcript write
// stays on the app's SINGLE DB writer (a 2nd writer corrupts the vault — the failure
// mode we hardened against). Decrypts the blob, streams via the long-audio path with
// PROGRESSIVE save (nothing lost if interrupted), and registers in the activity feed
// so the "a model is working — transcribing audio" monitor shows it. NEVER throws.

import { getBlob } from '../ingest/blob-store.js';
import { clampStored } from './text-limits.js';
import { audioFormatFor } from './transcribe-audio.js';
import { admit, abandonPreempt, CLASS } from '../core/compute-governor.js';
import { transcribeLongAudio } from './transcribe-long.js';
import { getTranscriberHealth } from '../transcribe/supervisor.js';
import { serviceState, isRetryable, transcribeNotReadyReason } from '../system/service-state.js';
import { readCoverage, writeCoverage, resumeStartSec, stitchTranscript, coverageDominates } from './transcript-coverage.js';
import { markMessagesForReembed } from './derived-text.js';

const isAudio = (fileType) => {
  const t = String(fileType || '').toLowerCase();
  return t.startsWith('audio/') || t === 'voice' || t === 'audio';
};

// ════════════════════════════════════════════════════════════════════════════════════════════
//  LIVE-TURN TRANSCRIPTION IS INTERACTIVE; BULK/IMPORT TRANSCRIPTION IS BULK (D-068, QA9)
// ════════════════════════════════════════════════════════════════════════════════════════════
// Reported: "when a voice message comes in for transcription, it got stopped, perhaps because
// there is a message description process happening in the background. We should treat chat
// messages as primary."
//
// Confirmed, and the product had TWO different transcription paths with two different problems —
// state both, because a single sentence gets one of them wrong (QA9 review, F6):
//   • THIS function (the portal Transcribe button, import, the retry drain) took a BULK ticket
//     unconditionally, so a voice note was refused `compute-busy` whenever the drainer's
//     describe/enrich (L2 "message description") pass held capacity, then deferred to the 20 s
//     background drain.
//   • THE LIVE CHANNEL TURN never came through here at all. It calls `transcribeAudio()` from
//     `src/internal-router.js` and took NO TICKET WHATSOEVER — ungoverned.
// Neither path had any notion of priority, because `CLASS.INTERACTIVE` had ZERO production call
// sites: it existed only in the governor and in verify:compute-lanes' own fixtures (the L11/L13
// residual in scripts/compute-lanes-allowlist.json).
//
// INTERACTIVE is the governor's answer, and it is a PRIORITY, not an exemption (design §3.4): it
// PREEMPTS a background RESIDENT holder by setting its yield flag — which the drainer's categorize
// AND enrich loops both poll between batches (drainer.js `catAdm.shouldYield()`) — and then takes
// the slot the holder frees.
//
// ⛔ WHY *NOT* MAKE ALL TRANSCRIPTION INTERACTIVE — this is the D-001 tripwire. INTERACTIVE
// `holdsSlot` (compute-governor.js): it counts against RESIDENT_MAX, which is 1, PERMANENTLY. An
// interactive transcription therefore takes the SINGLE model slot BY PREEMPTING; it never stacks a
// second resident model. Flipping the default would put every voice note in a 5,000-file audio
// import onto the resident slot, evicting describe/categorize in a loop — reopening D-001's
// thrash from the other side. The live-chat vs import distinction IS the fix, so the class is
// threaded from the CALL SITE and never inferred here.
//   • live inbound channel turn (internal-router /attachment-context) → INTERACTIVE
//   • import (run-import), the portal Transcribe button, the retry drain → BULK (unchanged)
const YIELD_WAIT_MS = Number(process.env.MYCELIUM_GOV_YIELD_MS) || 2000;
// ⚠️ THE PREEMPT BUDGET IS SIZED AGAINST THE HOLDER'S YIELD GRANULARITY, NOT AGAINST "feels fast".
// The holder polls `shouldYield()` BETWEEN BATCHES (drainer.js, L1 and L2), and at the measured
// rates one L1 pass (batchSize 25 @ ~41/min) is ~37 s. A 4 s budget — the first draft — therefore
// expired before the holder could possibly reach a yield point, so the preempt NEVER won and the
// reported defect was not actually fixed (QA9 adversarial review, HIGH-3). 45 s covers one L1 pass.
// It deliberately does NOT cover one L2 pass (~6 min at 8/min × 50) — waiting six minutes in a live
// turn is not "priority", it is a hang; that case takes the BULK fallback below.
const PREEMPT_BUDGET_MS = Number(process.env.MYCELIUM_TRANSCRIBE_PREEMPT_BUDGET_MS) || 45_000;
// A refusal we can win by WAITING (the holder was asked to yield / an aged background lane is
// taking its promoted ticket). A `memory-pressure:*` refusal is the OPPOSITE — the box is already
// out of headroom, and spinning on it to grab the slot anyway is precisely the crash. Never retry
// those; fall straight through so the caller degrades instead.
const isWaitable = (reason) => /^(model-busy-preempting|aged-background-priority)$/.test(String(reason || ''));
// ⚠️ LEASE SIZING IS A D-001 SAFETY PROPERTY, NOT A TUNABLE. The lease must exceed the WORST-CASE
// HOLD, or it reclaims while the decode is still running and the drainer then loads a second
// resident model beside it — a self-inflicted double admit, the exact crash shape.
// An earlier draft set 25 min and justified it against the channel daemon's 660 s client abort.
// That was wrong three ways (QA9 adversarial review, CRITICAL-1): a client abort does not stop an
// express handler, the server-side cap is `transcribe-long.js`'s 2 h default, and the route's
// `withRetry` runs the decode TWICE. Worst case was ~4 h against a 25-minute lease.
// It is fixed from BOTH ends: the live decode is now BOUNDED by an AbortSignal
// (LIVE_DECODE_BUDGET_MS, plumbed through transcribeAudio → transcribeLongAudio), and the lease is
// derived from that bound rather than guessed — the same `× 2` convention describe-image.js uses.
// Real per-window progress also heartbeats the ticket, which re-arms the lease independently.
export const LIVE_DECODE_BUDGET_MS = Number(process.env.MYCELIUM_TRANSCRIBE_LIVE_BUDGET_MS) || 240_000;
const LIVE_DECODE_ATTEMPTS = 2;   // internal-router's withRetry — count it, do not discover it later
export const INTERACTIVE_LEASE_MS = LIVE_DECODE_BUDGET_MS * LIVE_DECODE_ATTEMPTS * 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Admit a transcription decode under the compute governor, at the class the CALL SITE asks for.
 *
 * Exported because the live channel-turn path transcribes through a different function
 * (`transcribeAudio`, called by the /internal/attachment-context route) and must use the SAME
 * admission policy — two copies of a rule this load-bearing is how one of them drifts.
 *
 * INTERACTIVE-PREFERRED, BULK-FALLBACK. A live turn asks for the model slot first (preempting a
 * background holder); if the holder will not yield inside the budget it takes a BULK ticket
 * instead, and only a BULK refusal is a real refusal.
 *
 * ⚠️ THE FALLBACK IS A SAFETY PROPERTY, NOT A CONVENIENCE. Before this change the live route was
 * UNGOVERNED — it always decoded, ticket or no ticket. Refusing it outright would be a REGRESSION
 * on two real configurations the review found (QA9, HIGH-2): a vault with an audio-capable Ollama
 * and no Whisper service, and an attachment stored with a NULL `file_type` — in both the
 * background drain structurally cannot recover the note, so "refused" means "lost forever", not
 * "later". BULK is what the OTHER transcription entry points already use, it is sum-gated and
 * pressure-gated, and it can never become a second resident model. So the fallback is strictly
 * safer than main and strictly safer than refusing.
 *
 * @param {{interactive?: boolean, estimateGb?: number, timeoutMs?: number}} o
 *   `timeoutMs` is the BULK lease. The interactive lease is NOT caller-settable — it is derived
 *   from LIVE_DECODE_BUDGET_MS above, because getting it wrong is a double-admit.
 * @returns {Promise<object>} the admit() handle; `ok:false` carries `reason`. On success,
 *   `klass` says which class was actually granted.
 */
export async function admitTranscribe({ interactive = false, estimateGb = 3, timeoutMs = 3 * 60 * 60 * 1000 } = {}) {
  const bulk = () => {
    const a = admit({ lane: 'transcribe', klass: CLASS.BULK, estimateGb, timeoutMs });
    if (a.ok) a.klass = CLASS.BULK;
    return a;
  };
  if (!interactive) return bulk();

  // Ask for the model slot, and if a background lane holds it, give that lane time to reach a
  // yield point and ask again. A holder that will not yield is NEVER killed (killing a mid-write
  // describe pass corrupts a chronicle, design §3.4).
  const deadline = Date.now() + PREEMPT_BUDGET_MS;
  let last = null;
  for (;;) {
    last = admit({ lane: 'transcribe-live', klass: CLASS.INTERACTIVE, estimateGb, timeoutMs: INTERACTIVE_LEASE_MS });
    if (last.ok) { last.klass = CLASS.INTERACTIVE; return last; }
    if (!isWaitable(last.reason) || Date.now() >= deadline) break;
    await sleep(Math.min(Number(last.retryAfterMs) || YIELD_WAIT_MS, YIELD_WAIT_MS));
  }
  // GIVING UP — WITHDRAW THE PREEMPT FIRST. `preemptRequested` has no other clearing path, so
  // leaving it set makes the holder abort its cycle at the next batch boundary and free the slot
  // for a requester that has already gone to BULK. Under a stream of voice notes that degrades the
  // drainer to ~one pass per cycle while buying chat nothing (QA9 review, HIGH-3).
  if (last?.preemptedTicketId) abandonPreempt(last.preemptedTicketId, 'transcribe-live');
  return bulk();
}

/**
 * @param {object} db      wired vault db (attachments + activityFeed)
 * @param {string} userId
 * @param {string} attachmentId
 * @param {object} [opts]
 * @param {(p:{coveredSec:number,durationSec:number,segments:number})=>void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @param {() => object} [opts.getHealth] injectable transcriber-health read (tests); defaults to the live supervisor
 * @param {typeof fetch} [opts.fetchImpl] injectable transport (tests); defaults to the global fetch
 * @param {(rel:string)=>Promise<Buffer>} [opts.getBlob] injectable blob read (tests); defaults to the
 *   real vault-decrypting reader. Injected ONLY so the D-076 gate can drive the resume/coverage
 *   state machine end-to-end without a master key — production callers never pass it.
 * @returns {Promise<{ok:boolean, reason?:string, detail?:string|null, retryable?:boolean, health?:object|null,
 *   transcript?:string, partial?:boolean, progressed?:boolean, coveredSec?:number, durationSec?:number}>}
 */
export async function transcribeAttachment(db, userId, attachmentId, {
  onProgress, signal, getHealth = getTranscriberHealth, interactive = false,
  fetchImpl, getBlob: getBlobImpl = getBlob,
} = {}) {
  let row;
  try { row = await db.attachments.getById(String(attachmentId), userId); } catch { return { ok: false, reason: 'lookup', retryable: true }; }
  if (!row || row.user_id !== userId) return { ok: false, reason: 'not-found', retryable: false };
  // A row that already carries a transcription coverage record IS audio, whatever its `file_type`
  // says — only the transcriber writes that key, and it only runs on audio. The channel daemon
  // decides `kind` itself and can store a voice note with a NULL/non-audio `file_type`, so without
  // this the live turn writes a partial that this function then refuses to resume with a
  // non-retryable `not-audio` — stuck forever while the portal promises it will be picked up
  // (adversarial review, MEDIUM-8). Mirrored by db/attachments.js's drain predicate.
  if (!isAudio(row.file_type) && !readCoverage(row.metadata)) return { ok: false, reason: 'not-audio', retryable: false };
  if (!row.local_path) return { ok: false, reason: 'no-blob', retryable: false };
  const health = (() => { try { return getHealth(); } catch { return null; } })();
  // ⚠️ THE LIE THIS REPLACES. Every non-'ok' health returned reason 'no-model', which the
  // portal rendered as "Download a transcription model in Settings first." So a model that
  // WAS downloaded and was merely loading, starting, still fetching its weights, or
  // crash-looping all told the owner to go download the thing they already had — a red
  // dead-end over a service that was, in two of those cases, working perfectly and about to
  // succeed. The state now comes from the ONE taxonomy (transcribeNotReadyReason, the shared
  // derivation the route's 409 branch uses too): only a genuine owner CHOICE is 'no-model';
  // 'loading' says so and IS retryable-by-waiting; a fault says it is a fault.
  if (health?.status !== 'ok') {
    const state = serviceState(health?.status);
    const reason = transcribeNotReadyReason(health?.status);
    return { ok: false, reason, detail: health?.status || 'unknown', retryable: state === 'loading' || isRetryable(health?.status), health: health || null };
  }

  // COMPUTE GOVERNOR (D-001, review finding #2 / L14 — the operator's P7 run): faster_whisper is a
  // ~1–3 GB model runtime, NOT Ollama-resident, and voice-note imports (WhatsApp/Telegram) routinely
  // carry audio → whisper co-loads with the ONNX embed drain and a resident vision/describe model.
  // That is the memory pile-up a count-of-1 RESIDENT gate does not catch. Transcription is a BULK
  // lane. Reserve a BULK ticket for the whole decode; refused under memory pressure / a full BULK
  // budget → return a RETRYABLE `compute-busy`, never a second concurrent heavy model. A leased
  // backstop bounds a wedged decode (2 h cap upstream).
  //
  // ⚠️ WHO ACTUALLY RE-QUEUES A `compute-busy`: the BACKGROUND transcription drain
  // (src/enrich/transcribe-retry.js), NOT this function's callers. The import path
  // (ingest/run-import.js) is fire-and-forget and DISCARDS this result, and the portal
  // /transcribe route is user-initiated — neither retries. Without the background drain a
  // compute-busy voice note would be saved untranscribed and never revisited (round-2 review
  // finding #1). The drain selects audio attachments with no transcript and retries them once
  // capacity frees; a `compute-busy` there does NOT count against the per-attachment attempt cap
  // (it is capacity, not a decode failure), so a busy note stays retriable until it succeeds.
  //
  // ⚠️ CLASS COMES FROM THE CALL SITE (`interactive`), never from this function. See
  // admitTranscribe above for why a global flip to INTERACTIVE would reopen D-001. The DEFAULT is
  // BULK, so every existing caller (import, the portal Transcribe button, the retry drain) is
  // byte-for-byte unchanged.
  const adm = await admitTranscribe({ interactive });
  if (!adm.ok) return { ok: false, reason: 'compute-busy', detail: adm.reason, retryable: true };

  let feedId = null;
  try { feedId = await db.activityFeed?.begin?.({ userId, kind: 'transcribe', stageLabel: 'Transcribing audio', model: health?.model || null }); } catch { /* */ }
  let lastSaved = 0, segCount = 0;
  // The REAL cause, captured out of transcribeLongAudio's out-channel (it still returns
  // string|null so the fallbacks are unchanged). Without this the whole distinction
  // between "the service 503'd on missing deps", "faster-whisper crashed decoding your
  // 30-minute m4a", "the 2h cap fired" and "there was no speech" arrived as one word.
  let fault = null, faultDetail = null;
  const onFault = (reason, detail) => { fault = reason; faultDetail = detail ?? null; };

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  RESUME (D-076): finish the MISSING TAIL, do not re-decode 30 minutes, never overwrite text
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // Prior coverage is the row's own record of how much audio the stored transcript covers. When it
  // says INCOMPLETE, this pass starts at `coveredSec − RESUME_LOOKBACK_SEC` and STITCHES onto the
  // text already there (seam de-dup removes the deliberate re-transcription of the lookback).
  //
  // ⚠️ THE PRIOR TEXT IS ONLY A BASE WHEN THE SERVICE CONFIRMS IT HONOURED THE OFFSET. The service
  // echoes `meta.offset`; a build that predates the field ignores `start` and returns a FULL
  // transcript, whose coverage comes back with `startSec === 0`. Appending that to the prior partial
  // would duplicate minutes of speech, so `startSec === 0` means REPLACE. Old service ⇒ still
  // correct, merely not incremental.
  const priorCoverage = readCoverage(row.metadata);
  const priorText = String(row.transcript || '');
  const resumeFrom = priorText && priorCoverage ? resumeStartSec(priorCoverage) : 0;
  const priorCoveredSec = priorCoverage?.coveredSec || 0;
  let coverage = null;
  const onCoverage = (c) => { coverage = c; };
  // A resume BUILDS ON the stored text; a fresh pass (or an un-honoured offset) replaces it.
  const compose = (assembled) => {
    if (!assembled) return priorText && (coverage?.startSec || resumeFrom) ? priorText : '';
    const honoured = coverage ? coverage.startSec > 0 : resumeFrom > 0;
    return honoured && priorText ? stitchTranscript(priorText, assembled) : String(assembled).trim();
  };
  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  COVERAGE IS MONOTONIC PER STORED TRANSCRIPT — a failed pass may never walk it backwards
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // An earlier draft wrote `coverage?.coveredSec ?? priorCoveredSec`, and `??` does NOT fall
  // through on 0 — but EVERY failure path in transcribe-long.js reports `reportCoverage(false)`
  // with `coveredSec` still at its initial 0 (a 503, an abort, a transport death before the first
  // segment). So one transient failure overwrote a good `coveredSec: 1500` with `0`, and the
  // damage compounded (adversarial review, HIGH-2): the next pass then resumed from 0, its
  // progressive save composed against a fresh start instead of stitching, and a row holding 25
  // minutes of transcript was TRUNCATED BACK to two — data loss strictly worse than the original
  // defect. It also defeated the drain's loop guard, because a flapping service could alternate
  // "advanced / reset" forever without ever reaching ATTEMPT_CAP, starving every other audio row.
  // Coverage only ever moves FORWARD; a pass that learned nothing leaves the record alone.
  // ⚠️ THE CLAMP ONLY APPLIES WHEN THE TEXT WAS ACTUALLY STITCHED ONTO THE PRIOR TRANSCRIPT.
  // Clamping unconditionally was itself a silent-truncation bug (second adversarial review, HIGH-3
  // — introduced by the first fix for HIGH-2, which is exactly why the fix had to be reviewed too).
  // `compose` REPLACES rather than stitches whenever the resume offset was not honoured, so a pass
  // that produced 300 s of text could be stored beside a clamped `coveredSec: 1000` inherited from
  // the run before it. The row would then claim coverage it does not have, the next resume would
  // start at 998.5 s, and seconds 300–998.5 would be permanently blank with NO gap recorded — the
  // precise shape of the defect this PR exists to kill. Coverage must describe the text it is
  // stored with: clamp forward only when the stored text CONTAINS the prior text.
  const stitchedOnto = () => (coverage ? coverage.startSec > 0 : resumeFrom > 0) && Boolean(priorText);
  const maxCovered = (next) => (stitchedOnto() ? Math.max(Number(next) || 0, priorCoveredSec) : (Number(next) || 0));
  const maxDuration = (next) => Math.max(Number(next) || 0, Number(priorCoverage?.durationSec) || 0);
  // ONE UPDATE carries text AND coverage. Splitting them would leave a window where a crash strands
  // a partial transcript with no incomplete marker — exactly the state that made D-076 permanent.
  const persist = async (text, complete, extra = {}) => {
    // ⚠️ COMPARE-AND-SET AGAINST A FRESH READ. `row` was snapshotted before a decode that can run for
    // minutes, and three other writers can touch this attachment meanwhile (see coverageDominates).
    // Merging into the stale snapshot is how a completed 30-minute transcript got replaced by a
    // 4-minute partial. Re-read, refuse to downgrade, and merge into the CURRENT metadata so no
    // unrelated key written during the decode is dropped either.
    const fresh = await db.attachments.getById(row.id, userId).catch(() => null);
    const stored = readCoverage(fresh?.metadata);
    const nextCov = { complete, coveredSec: extra.coveredSec ?? coverage?.coveredSec ?? 0 };
    if (coverageDominates(stored, nextCov)) return;
    const fields = { transcript: clampStored(text) };
    fields.metadata = writeCoverage(fresh?.metadata ?? row.metadata, {
      complete,
      coveredSec: maxCovered(extra.coveredSec ?? coverage?.coveredSec),
      durationSec: maxDuration(extra.durationSec ?? coverage?.durationSec),
      segments: extra.segments ?? coverage?.segments ?? 0,
      gaps: extra.gaps ?? coverage?.gaps ?? [],
      engine: extra.engine ?? coverage?.engine ?? 'whisper-stream',
      fault: complete ? null : (fault || extra.fault || null),
    });
    await db.attachments.update(row.id, fields);
    // ── THE TRANSCRIPT IS FINAL — RE-QUEUE THE MESSAGE THAT OWNS IT ────────────────────────────
    // The owning message was embedded from `content` ALONE — on the import path literally
    // "File: memo.ogg" — so without this the speech stays BM25-only, invisible to a paraphrase
    // (src/enrich/derived-text.js). This is the single chokepoint for all three BULK entry points:
    // the portal Transcribe button, import's fire-and-forget call, and the background retry drain
    // (transcribe-retry.js calls THIS function).
    //
    // ⚠️ INSIDE persist(), GATED ON `complete` — NOT at the ok-return above, and NOT on every save.
    // D-076 made multi-pass the NORM: a 30-minute recording is transcribed across several resumed
    // passes, each persisting a longer partial, plus a progressive save every ~10 segments. Marking
    // on any of those would re-queue the same message repeatedly and re-embed a half-finished
    // transcript each time — burning the BULK embed lane on text that is about to change. Marking
    // at the ok-return instead would MISS the other completion path (a resumed pass that reaches
    // `coverage.complete` with no new text of its own, and 'no-speech'), which is exactly the kind
    // of second exit a future branch adds without noticing. One guard, at the one write.
    //
    // The empty-text guard keeps a genuine 'no-speech' completion from re-embedding a message whose
    // derived text is still nothing. A stale-write return (coverageDominates, above) never reaches
    // here — a write that did not land must not claim new text arrived.
    if (complete && String(text || '').trim()) await markMessagesForReembed(db, userId, row.id);
  };

  try {
    const bytes = await getBlobImpl(row.local_path);
    const format = audioFormatFor(row.file_type, row.file_name);
    const full = await transcribeLongAudio({
      bytes, format, signal, onFault, onCoverage, startSec: resumeFrom,
      // ⚠️ ONE HEALTH READ, NOT TWO. This was NOT forwarded, so transcribe-long.js re-read the LIVE
      // supervisor while this function had already gated on an injected/earlier read. The two could
      // disagree (they always did under injection, and they can genuinely disagree in production
      // when the supervisor flips between the two reads) and the job then failed with a
      // health-derived reason AFTER passing its own health gate — an unexplainable outcome for the
      // owner. Found by the D-076 gate, which is the point of driving the real call site.
      getHealth,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
      onSegment: async (_seg, assembled, live) => {
        segCount += 1;
        if (segCount - lastSaved >= 10) { // progressive save every ~10 segments
          lastSaved = segCount;
          // ⚠️ A PROGRESSIVE SAVE IS BY DEFINITION INCOMPLETE. It used to write `transcript` ALONE,
          // and db/attachments.js's `transcript IS NULL OR transcript = ''` predicate then excluded
          // the row from the background drain FOREVER — the single line that turned every
          // interruption into permanent silent truncation. The marker rides the SAME update.
          const honoured = (live?.startSec || 0) > 0;
          const text = honoured && priorText ? stitchTranscript(priorText, assembled) : assembled;
          // ⚠️ A PROGRESSIVE SAVE MAY NEVER SHRINK THE STORED TRANSCRIPT. When a pass restarts from
          // 0 (nothing to resume, or an un-honoured offset), `text` is only the segments seen SO
          // FAR — at segment 10 of a 30-minute file that is ~2 minutes. Writing it over a stored
          // 25-minute transcript destroys real speech that the row already held, and the row is
          // then worse off than before the job ran. Progress saves are an optimisation against
          // interruption; they must never be a regression (adversarial review, HIGH-2).
          if (String(text || '').length < priorText.length) return;
          try {
            // Same compare-and-set as persist(): a progressive save must not stamp its in-flight
            // partial over a transcript another writer has meanwhile COMPLETED.
            const fresh = await db.attachments.getById(row.id, userId).catch(() => null);
            if (coverageDominates(readCoverage(fresh?.metadata), { complete: false, coveredSec: live?.coveredSec ?? 0 })) return;
            await db.attachments.update(row.id, {
              transcript: clampStored(text),
              metadata: writeCoverage(fresh?.metadata ?? row.metadata, {
                complete: false,
                coveredSec: maxCovered(live?.coveredSec),
                durationSec: maxDuration(live?.durationSec),
                segments: live?.segments ?? segCount,
                engine: 'whisper-stream',
                fault: 'in-progress',
              }),
            });
          } catch { /* */ }
        }
      },
      onProgress,
    });

    // ⚠️ `full` BEING TRUTHY IS NOT COMPLETION — this branch is where the primary defect lived.
    // The old code was `if (full) { save; feed done; return {ok:true} }`, so a mid-stream
    // engine-error (which had ALREADY called onFault) and a stream cut off at EOF both landed here
    // and were recorded as finished work. Coverage is now the arbiter: only a run that reported
    // `complete` may claim `ok`.
    const complete = coverage?.complete === true;
    const text = compose(full);

    if (complete && text) {
      await persist(text, true);
      try { await db.activityFeed?.finish?.(feedId, { status: 'done' }); } catch { /* */ }
      return { ok: true, transcript: text, coveredSec: coverage?.coveredSec ?? 0, durationSec: coverage?.durationSec ?? 0 };
    }

    if (!complete && (text || coverage)) {
      // INCOMPLETE BUT REAL PROGRESS. Persist what we have WITH the incomplete marker, so the
      // background drain (transcribe-retry.js) picks the row up again and resumes only the tail.
      const advanced = (coverage?.coveredSec || 0) > priorCoveredSec + 0.5;
      // ⚠️ AN INCOMPLETE PASS MAY NEVER SHRINK THE STORED TRANSCRIPT. Same rule as the progressive
      // save, and it has to be here too because this is the FINAL write: when a resume offset is not
      // honoured (an old service, a rejected echo) `compose` REPLACES rather than stitches, so a
      // pass that reached two minutes before dying would overwrite a stored twenty-five. A COMPLETE
      // pass is exempt — a verified full transcript legitimately replaces anything, including a
      // deliberate Re-transcribe that is genuinely shorter. An INCOMPLETE one has no such standing.
      //
      // THREE OUTCOMES, and the coverage record must match the TEXT in each:
      //   • new text that keeps everything we had  → store it with THIS pass's coverage
      //   • the pass produced nothing new          → keep prior text AND prior coverage
      //   • new text shorter than what we hold     → same as above; discard the pass entirely
      // Storing this pass's numbers beside the PRIOR text is the HIGH-3 hole: a 503 reports
      // `coveredSec: 0` (its initial value) and would zero a cursor describing 25 stored minutes.
      const producedNew = Boolean(full) && String(text || '').length >= priorText.length && text !== priorText;
      if (producedNew) { try { await persist(text, false); } catch { /* */ } }
      else if (priorText) {
        // Nothing better to store. Keep the existing text AND its existing coverage — the two must
        // stay consistent (HIGH-3), so a pass being discarded may not leave its numbers behind.
        // Only the incomplete marker is refreshed, so the row stays drain-eligible.
        try {
          await persist(priorText, false, {
            coveredSec: priorCoveredSec,
            durationSec: priorCoverage?.durationSec ?? 0,
            segments: priorCoverage?.segments ?? 0,
            gaps: priorCoverage?.gaps ?? [],
            engine: priorCoverage?.engine ?? 'whisper-stream',
          });
        } catch { /* */ }
      }
      const reason = fault && fault !== 'no-speech' ? fault : 'incomplete';
      try { await db.activityFeed?.finish?.(feedId, { status: 'error', error: 'partial' }); } catch { /* */ }
      return {
        ok: false, reason, detail: faultDetail, retryable: true,
        partial: true, progressed: advanced,
        transcript: text || null,
        coveredSec: coverage?.coveredSec ?? priorCoveredSec, durationSec: coverage?.durationSec ?? 0,
      };
    }

    // No text and no coverage at all — the run never reached the stream (health/HTTP/abort).
    // `fault` says WHY: 'no-speech' (the file really had none) is a completely different answer
    // from 'service-error' / 'engine-error' / 'timeout', and conflating them is what made a failed
    // 30-minute job indistinguishable from a silent recording. The activity feed still stores only
    // the coarse token (§SECURITY: no error text in the feed); the reason goes to the CALLER
    // (owner-only). A genuine 'no-speech' IS a completed pass — record it as complete so the drain
    // stops re-decoding a silent file.
    const reason = fault && fault !== 'no-speech' ? fault : 'no-text';
    if (fault === 'no-speech' || coverage?.complete === true) {
      try { await persist(priorText, true, { engine: coverage?.engine || 'whisper-stream' }); } catch { /* */ }
    }
    try { await db.activityFeed?.finish?.(feedId, { status: 'error', error: reason === 'no-text' ? 'no-text' : 'failed' }); } catch { /* */ }
    return { ok: false, reason, detail: faultDetail, retryable: reason !== 'no-text' };
  } catch (e) {
    try { await db.activityFeed?.finish?.(feedId, { status: 'error', error: 'failed' }); } catch { /* */ }
    return { ok: false, reason: fault || 'failed', detail: faultDetail, retryable: true };
  } finally {
    adm.release(); // crash-release #1 (finally) — always free the BULK transcribe ticket
  }
}

export default transcribeAttachment;
