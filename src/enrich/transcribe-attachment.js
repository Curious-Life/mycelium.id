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
import { transcribeLongAudio } from './transcribe-long.js';
import { getTranscriberHealth } from '../transcribe/supervisor.js';
import { serviceState, isRetryable, transcribeNotReadyReason } from '../system/service-state.js';

const isAudio = (fileType) => {
  const t = String(fileType || '').toLowerCase();
  return t.startsWith('audio/') || t === 'voice' || t === 'audio';
};

/**
 * @param {object} db      wired vault db (attachments + activityFeed)
 * @param {string} userId
 * @param {string} attachmentId
 * @param {object} [opts]
 * @param {(p:{coveredSec:number,durationSec:number,segments:number})=>void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @param {() => object} [opts.getHealth] injectable transcriber-health read (tests); defaults to the live supervisor
 * @returns {Promise<{ok:boolean, reason?:string, detail?:string|null, retryable?:boolean, health?:object|null, transcript?:string}>}
 */
export async function transcribeAttachment(db, userId, attachmentId, { onProgress, signal, getHealth = getTranscriberHealth } = {}) {
  let row;
  try { row = await db.attachments.getById(String(attachmentId), userId); } catch { return { ok: false, reason: 'lookup', retryable: true }; }
  if (!row || row.user_id !== userId) return { ok: false, reason: 'not-found', retryable: false };
  if (!isAudio(row.file_type)) return { ok: false, reason: 'not-audio', retryable: false };
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

  let feedId = null;
  try { feedId = await db.activityFeed?.begin?.({ userId, kind: 'transcribe', stageLabel: 'Transcribing audio', model: health?.model || null }); } catch { /* */ }
  let lastSaved = 0, segCount = 0;
  // The REAL cause, captured out of transcribeLongAudio's out-channel (it still returns
  // string|null so the fallbacks are unchanged). Without this the whole distinction
  // between "the service 503'd on missing deps", "faster-whisper crashed decoding your
  // 30-minute m4a", "the 2h cap fired" and "there was no speech" arrived as one word.
  let fault = null, faultDetail = null;
  const onFault = (reason, detail) => { fault = reason; faultDetail = detail ?? null; };
  try {
    const bytes = await getBlob(row.local_path);
    const format = audioFormatFor(row.file_type, row.file_name);
    const full = await transcribeLongAudio({
      bytes, format, signal, onFault,
      onSegment: async (_seg, assembled) => {
        segCount += 1;
        if (segCount - lastSaved >= 10) { // progressive save every ~10 segments
          lastSaved = segCount;
          try { await db.attachments.update(row.id, { transcript: clampStored(assembled) }); } catch { /* */ }
        }
      },
      onProgress,
    });
    if (full) {
      await db.attachments.update(row.id, { transcript: clampStored(full) });
      try { await db.activityFeed?.finish?.(feedId, { status: 'done' }); } catch { /* */ }
      return { ok: true, transcript: full };
    }
    // No text came back. `fault` says WHY — 'no-speech' (the file really had none) is a
    // completely different answer from 'service-error' / 'engine-error' / 'timeout', and
    // conflating them is what made a failed 30-minute job indistinguishable from a silent
    // recording. The activity feed still stores only the coarse token (§SECURITY: no error
    // text in the feed); the specific reason goes to the CALLER, which is owner-only.
    const reason = fault && fault !== 'no-speech' ? fault : 'no-text';
    try { await db.activityFeed?.finish?.(feedId, { status: 'error', error: reason === 'no-text' ? 'no-text' : 'failed' }); } catch { /* */ }
    return { ok: false, reason, detail: faultDetail, retryable: reason !== 'no-text' };
  } catch (e) {
    try { await db.activityFeed?.finish?.(feedId, { status: 'error', error: 'failed' }); } catch { /* */ }
    return { ok: false, reason: fault || 'failed', detail: faultDetail, retryable: true };
  }
}

export default transcribeAttachment;
