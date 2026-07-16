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
 * @returns {Promise<{ok:boolean, reason?:string, transcript?:string}>}
 */
export async function transcribeAttachment(db, userId, attachmentId, { onProgress, signal } = {}) {
  let row;
  try { row = await db.attachments.getById(String(attachmentId), userId); } catch { return { ok: false, reason: 'lookup' }; }
  if (!row || row.user_id !== userId) return { ok: false, reason: 'not-found' };
  if (!isAudio(row.file_type)) return { ok: false, reason: 'not-audio' };
  if (!row.local_path) return { ok: false, reason: 'no-blob' };
  const health = (() => { try { return getTranscriberHealth(); } catch { return null; } })();
  if (health?.status !== 'ok') return { ok: false, reason: 'no-model' };

  let feedId = null;
  try { feedId = await db.activityFeed?.begin?.({ userId, kind: 'transcribe', stageLabel: 'Transcribing audio', model: health?.model || null }); } catch { /* */ }
  let lastSaved = 0, segCount = 0;
  try {
    const bytes = await getBlob(row.local_path);
    const format = audioFormatFor(row.file_type, row.file_name);
    const full = await transcribeLongAudio({
      bytes, format, signal,
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
    try { await db.activityFeed?.finish?.(feedId, { status: 'error', error: 'no-text' }); } catch { /* */ }
    return { ok: false, reason: 'no-text' };
  } catch (e) {
    try { await db.activityFeed?.finish?.(feedId, { status: 'error', error: 'failed' }); } catch { /* */ }
    return { ok: false, reason: 'failed' };
  }
}

export default transcribeAttachment;
