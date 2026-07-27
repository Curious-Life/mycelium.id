// src/portal-attachments.js — the Media library surface the portal already
// ships UI for (portal-app routes/(app)/media) but V1 never served: list,
// preview bytes, edit description, delete. Attachment rows come from portal
// uploads AND the channel inbound-media pipeline (encrypted blob + row).
//
// Filtering/search happen IN JS AFTER the adapter decrypts: file_name /
// description / transcript are ENCRYPTED_FIELDS columns, so SQL LIKE can never
// match them (the ported canonical buildFilters assumed plaintext columns),
// and our file_type holds MIME strings, not canonical kind labels. Personal
// scale (hundreds of rows) makes post-decrypt filtering the honest choice.
//
// Security: mounted under the vault sub-app's /api gate (vaultAuth: portal
// session / loopback). Bytes are served DECRYPTED to the authenticated owner
// only — same trust boundary as documents/portal data. Cross-user ids 404
// without existence leak; Cache-Control: no-store keeps plaintext out of
// caches (CLAUDE.md §1).
import express from 'express';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { getBlob } from './ingest/blob-store.js';
import { uploadsRoot } from './paths.js';
import { clampStored } from './enrich/text-limits.js';
import { transcribeAttachment } from './enrich/transcribe-attachment.js';
import { markMessagesForReembed } from './enrich/derived-text.js';
import { getTranscriberHealth } from './transcribe/supervisor.js';
import { serviceState, isRetryable, transcribeNotReadyReason } from './system/service-state.js';
import { readCoverage } from './enrich/transcript-coverage.js';
import { parseByteRange } from './portal-audio-stream.js';

const LIST_SCAN_CAP = 2000; // rows decrypted per list call — personal-scale guard

// MIME families safe to render INLINE same-origin in the portal. Attachment
// file_type is attacker-controlled (Telegram mime_type rides verbatim through
// the inbound-media pipeline), so anything outside this allowlist — text/html,
// image/svg+xml, application/pdf, unknown — is forced to download as an opaque
// octet-stream so it can never execute script in the portal (cognitive-vault)
// origin. Always paired with X-Content-Type-Options: nosniff so a mislabelled
// blob can't be sniffed back into html. (CLAUDE.md §1/§2.)
const INLINE_SAFE_MIME = /^(image\/(png|jpe?g|gif|webp|avif|bmp|x-icon)|audio\/[\w.+-]+|video\/[\w.+-]+)$/i;

/** mime / legacy-kind → the Media page's type facet. */
export function mediaTypeOf(fileType) {
  const t = String(fileType || '').toLowerCase();
  if (t.startsWith('image/') || t === 'image') return 'image';
  if (t.startsWith('audio/') || t === 'voice' || t === 'audio') return 'voice';
  if (t.startsWith('video/') || t === 'video') return 'video';
  return 'file';
}

// Owner-facing copy per transcription FAULT REASON (the enum transcribe-attachment.js
// returns). Exported so verify:transcription asserts the mapping directly and can
// mutation-prove it. Fail-SAFE: an unmapped reason falls back to `failed` — never a
// blank, and never the "download a model" line, which belongs to exactly one reason.
export const TRANSCRIBE_FAULT_MESSAGE = Object.freeze({
  'no-model': 'Download a transcription model in Settings first.',
  'not-ready-yet': 'The transcription engine is still starting — try again in a moment.',
  'not-ready': 'Transcription isn’t ready yet — check the Transcription model in Settings.',
  'engine-down': 'The transcription engine isn’t running — retry, or re-select the model in Settings.',
  'service-error': 'The transcription service refused the job — retry, or re-select the model in Settings.',
  'engine-error': 'The transcription engine failed part-way through this recording. Any text it did produce was kept — you can retry.',
  // ── D-076: the vocabulary for a PARTIAL transcript ────────────────────────────────────────
  // These reasons did not exist because the state did not exist: a transcription that covered
  // only part of a recording was recorded as finished, so there was nothing to say. Each one
  // promises the SAME two things, because both are now true: the text so far is kept, and the
  // remainder is picked up automatically (the background drain resumes from recorded coverage).
  'stream-truncated': 'The transcription service stopped sending part-way through this recording. The text so far is saved and the rest will be picked up automatically.',
  incomplete: 'Only part of this recording has been transcribed so far. The text so far is saved and the rest will be picked up automatically.',
  partial: 'Only part of this recording has been transcribed so far. The text so far is saved and the rest will be picked up automatically.',
  'audio-truncated': 'Decoding this recording ran past its budget, so only part of the audio was transcribed. The rest will be picked up automatically.',
  'window-failed': 'One or more sections of this recording could not be transcribed. The rest is saved and the missing parts will be retried automatically.',
  // ⚠️ THIS ONE DELIBERATELY DOES NOT PROMISE AUTOMATIC RECOVERY. It is written when the only
  // available engine was the general chat model, which returns text with no timestamps, no
  // segment stream and no completion signal — so we cannot verify it covered the whole recording,
  // and we mark it unverified rather than assert it is done. But the background drain hard-gates on
  // Whisper health, so on a vault with an audio-capable Ollama and NO transcription model there is
  // nothing to pick it up (second adversarial review, HIGH-2). Telling the owner it will be
  // handled automatically would be a promise the system cannot keep; this names the actual action.
  'unverified-engine': 'This was transcribed by the chat model, which can’t confirm it captured the whole recording. Set up a transcription model in Settings to have it re-done accurately.',
  timeout: 'This recording took longer than the transcription time limit. Try again, or split the file.',
  'transport-error': 'Lost contact with the transcription service part-way through — retry.',
  canceled: 'Transcription was canceled.',
  'no-speech': 'No speech was detected in this recording.',
  'no-text': 'No speech was detected in this recording.',
  'empty-audio': 'This file has no audio data.',
  'no-blob': 'The audio file is missing from the vault.',
  'not-audio': 'This file isn’t audio.',
  'not-found': 'That file no longer exists.',
  lookup: 'Couldn’t read that file just now — retry.',
  failed: 'Transcription failed — retry, or check the Transcription model in Settings.',
});

/**
 * @param {object} deps
 * @param {object} deps.db      wired vault db (attachments namespace)
 * @param {string} deps.userId
 * @param {() => object} [deps.getHealth] injectable transcriber-health read (tests); defaults to the live supervisor
 */
export function portalAttachmentsRouter({ db, userId, getHealth = getTranscriberHealth }) {
  const router = express.Router();
  const json = express.json({ limit: '64kb' });

  // GET /attachments?type=&search=&limit=&offset= → { attachments, total }
  router.get('/attachments', async (req, res) => {
    try {
      const type = String(req.query.type || '');
      const search = String(req.query.search || '').toLowerCase();
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const offset = Math.max(Number(req.query.offset) || 0, 0);

      // Filtering on encrypted fields (file_name/description/transcript) can't be
      // done in SQL, so it still needs a decrypting scan (capped). The common
      // open has no filter → page at the DB and decrypt only the requested
      // window instead of LIST_SCAN_CAP rows.
      const filtering = Boolean(type || search);
      const rows = filtering
        ? await db.attachments.listByUser(userId, { limit: LIST_SCAN_CAP, offset: 0 })
        : await db.attachments.listByUser(userId, { limit, offset });
      const filtered = filtering
        ? rows.filter((r) => {
          if (type && mediaTypeOf(r.file_type) !== type) return false;
          if (search) {
            const hay = `${r.file_name || ''} ${r.description || ''} ${r.transcript || ''}`.toLowerCase();
            if (!hay.includes(search)) return false;
          }
          return true;
        })
        : rows;
      const page = filtering ? filtered.slice(offset, offset + limit) : filtered;

      const attachments = page.map((r) => ({
        id: r.id,
        type: mediaTypeOf(r.file_type),
        url: `/api/v1/portal/attachments/${r.id}/file`,
        // Browser-playable source: Telegram voice notes are OGG/Opus, which
        // WKWebView (the Tauri shell) cannot play — ?format=wav transcodes
        // in-process on serve (ogg-opus.js). Other types play/show as-is.
        playbackUrl: /ogg|opus/i.test(r.file_type || '')
          ? `/api/v1/portal/attachments/${r.id}/file?format=wav`
          : `/api/v1/portal/attachments/${r.id}/file`,
        streamUid: r.stream_uid || null,
        filename: r.file_name || null,
        fileSize: r.file_size ?? null,
        description: r.description || null,
        transcript: r.transcript || null,
        createdAt: r.created_at || null,
      }));
      res.json({ attachments, total: filtered.length });
    } catch (err) {
      console.error('[portal-attachments] list failed:', err.message);
      res.status(500).json({ error: 'list-failed' });
    }
  });

  // GET /attachments/:id/file — the decrypted bytes (image previews, audio src).
  router.get('/attachments/:id/file', async (req, res) => {
    try {
      const row = await db.attachments.getById(String(req.params.id), userId);
      if (!row || row.user_id !== userId) return res.status(404).json({ error: 'not-found' });
      if (!row.local_path) return res.status(404).json({ error: 'no-local-blob' }); // legacy r2-only rows
      const bytes = await getBlob(row.local_path);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff'); // covers both the wav and raw branches
      res.setHeader('Accept-Ranges', 'bytes');

      // WKWebView (the Tauri/iOS shell) REQUIRES HTTP Range (206 Partial Content)
      // for <audio>/<video> playback — a plain 200 full-body response makes the
      // media element silently refuse to play (every view was broken). Serve the
      // requested byte range when asked; full body otherwise. Headers (Content-
      // Type / Content-Disposition) are already set by each branch before calling.
      const sendRange = (buf) => {
        const total = buf.length;
        const range = parseByteRange(req.headers.range, total); // shared with the streamed WAV path
        if (range === 'unsatisfiable') {
          res.status(416).setHeader('Content-Range', `bytes */${total}`);
          return res.end();
        }
        if (range) {
          res.status(206);
          res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${total}`);
          res.setHeader('Content-Length', range.end - range.start + 1);
          return res.end(buf.subarray(range.start, range.end + 1));
        }
        res.setHeader('Content-Length', total);
        return res.send(buf);
      };

      // ?format=wav — in-process OGG/Opus → WAV transcode for browser playback
      // (WKWebView can't decode Opus; Telegram voice notes are always OGG).
      //
      // ⚠️ STREAMED, NOT BUFFERED — AND THAT IS THE FIX, NOT AN OPTIMISATION. This branch used to
      // call `oggOpusToWav(bytes)`, whose `maxSeconds` defaults to 900: every recording over 15
      // minutes was served as a 15-minute WAV that just stopped, with nothing in the response
      // saying so (the playback sibling of D-076). The cap could not simply be raised because the
      // buffered decode holds the whole thing in one Buffer — ~172 MB for 30 minutes. The stream
      // takes the exact length from the Ogg granule, serves any byte range from it, and holds one
      // ~2.9 MB window at a time; a decode that cannot deliver what the header promised fails the
      // transfer instead of completing a short body. See src/portal-audio-stream.js.
      //
      // Fail-soft is preserved: `false` means "not a decodable Opus stream" and the original
      // bytes are served below, exactly as before.
      if (req.query.format === 'wav' && /ogg|opus/i.test(row.file_type || '')) {
        try {
          const { streamOggAsWav } = await import('./portal-audio-stream.js');
          if (await streamOggAsWav({ req, res, ogg: bytes, fileName: row.file_name })) return;
        } catch (err) {
          if (res.headersSent) { res.destroy(); return; } // mid-body fault: never finish a short body
          console.error('[portal-attachments] wav stream failed:', err?.message);
          /* fall through to raw bytes */
        }
      }

      // Inline ONLY for allowlisted media; everything else downloads as an
      // opaque octet-stream so attacker-supplied html/svg can't run in-origin.
      const inlineSafe = INLINE_SAFE_MIME.test(String(row.file_type || ''));
      res.setHeader('Content-Type', inlineSafe ? row.file_type : 'application/octet-stream');
      if (row.file_name) {
        const safeName = String(row.file_name).replace(/[^\w. -]/g, '_');
        res.setHeader('Content-Disposition', `${inlineSafe ? 'inline' : 'attachment'}; filename="${safeName}"`);
      }
      return sendRange(bytes);
    } catch (err) {
      console.error('[portal-attachments] serve failed:', err.message); // message only — never content
      res.status(404).json({ error: 'not-found' }); // fail closed, no detail leak
    }
  });

  // PATCH /attachments/:id { description } — encrypted at the db layer.
  router.patch('/attachments/:id', json, async (req, res) => {
    try {
      const row = await db.attachments.getById(String(req.params.id), userId);
      if (!row || row.user_id !== userId) return res.status(404).json({ error: 'not-found' });
      const description = typeof req.body?.description === 'string' ? clampStored(req.body.description) : null; // store the FULL description (was a silent 4000-char cut)
      if (description === null) return res.status(400).json({ error: 'description required' });
      await db.attachments.update(row.id, { description });
      // A hand-written description is derived text arriving late in exactly the same
      // sense a transcript is: the owning message was embedded from `content` alone
      // ("File: photo.jpg" on the import path), so re-queue it for embedding or the
      // owner's own words stay keyword-only. Never throws (src/enrich/derived-text.js).
      await markMessagesForReembed(db, userId, row.id);
      res.json({ ok: true });
    } catch (err) {
      console.error('[portal-attachments] patch failed:', err.message);
      res.status(500).json({ error: 'update-failed' });
    }
  });

  // DELETE /attachments/:id — row (user-scoped) + best-effort blob unlink.
  // SHARED-BLOB GUARD: byte-identical attachments share ONE encrypted blob via
  // the same local_path (vault-import + obsidian-import dedup, #152/#154) — so
  // the file is unlinked ONLY when no other row still references it. Without
  // this, deleting one duplicate destroys its siblings' bytes (embeds → 404).
  router.delete('/attachments/:id', async (req, res) => {
    try {
      const row = await db.attachments.getById(String(req.params.id), userId);
      if (!row || row.user_id !== userId) return res.status(404).json({ error: 'not-found' });
      await db.attachments.delete(row.id, userId);
      if (row.local_path) {
        try {
          const sharers = await db.rawQuery('SELECT COUNT(*) AS c FROM attachments WHERE local_path = ? AND id != ?', [row.local_path, row.id]);
          const stillReferenced = (sharers?.results?.[0]?.c ?? 0) > 0;
          if (!stillReferenced) await unlink(join(uploadsRoot(), row.local_path));
        } catch { /* row is gone; an orphan blob is unreachable ciphertext */ }
      }
      res.json({ ok: true });
    } catch (err) {
      console.error('[portal-attachments] delete failed:', err.message);
      res.status(500).json({ error: 'delete-failed' });
    }
  });

  // ── Transcription (owner-gated): robust LONG-audio via the streaming service ──
  // Owner-facing copy per FAULT REASON (the enum transcribeAttachment now returns).
  // Exported-in-spirit as a table so verify:transcription can assert the mapping is
  // total and mutation-testable — the point of §2 is that a failed transcription can
  // never again read as a blank "unavailable". Every message names WHAT went wrong and,
  // where a retry is honest, says so; the client renders Retry off `retryable`, not off
  // the string. NO reason maps to "download a model" except the one that means it.
  // In-memory per-attachment job state (progress the UI polls). Runs IN-PROCESS so
  // every transcript write stays on the app's single DB writer (no 2nd vault writer).
  const jobs = new Map(); // attachmentId → { status, coveredSec, durationSec, segments, error, message, detail, retryable }

  // POST /attachments/:id/transcribe — start (or restart) transcription. Non-blocking:
  // returns 202 immediately; the UI polls .../transcribe/status. Overwrites any prior
  // transcript (Re-transcribe). Saves progressively so nothing is lost if interrupted.
  router.post('/attachments/:id/transcribe', async (req, res) => {
    try {
      const row = await db.attachments.getById(String(req.params.id), userId);
      if (!row || row.user_id !== userId) return res.status(404).json({ error: 'not-found' });
      if (mediaTypeOf(row.file_type) !== 'voice') return res.status(400).json({ error: 'not-audio' });
      if (!row.local_path) return res.status(409).json({ error: 'no-blob' });
      const cur = jobs.get(row.id);
      if (cur && cur.status === 'running') return res.status(202).json({ ok: true, status: cur });
      const health = (() => { try { return getHealth(); } catch { return null; } })();
      // ⚠️ ONE MESSAGE FOR SIX STATES — the lie removed here. This returned
      // "Download a transcription model in Settings first." for EVERY non-'ok' health:
      // loading, starting, downloading the weights, installing_deps, deps_missing, down.
      // Four of those mean "wait, it's coming", one means "an install failed", one means
      // "it crashed" — and none of them mean "you have no model". Now the REAL state drives
      // the copy: the reason token is the SHARED derivation (transcribeNotReadyReason) that
      // transcribeAttachment also uses, so the pre-flight 409 and the in-flight job can never
      // disagree on what a given health status means; `retryable` tells the client whether a
      // Retry is honest. Copy prefers the supervisor's own message where it has one
      // (loading/failed), else the fixed per-reason line — never audio, never vault content.
      if (health?.status !== 'ok') {
        const state = serviceState(health?.status);
        const reason = transcribeNotReadyReason(health?.status);
        const retryable = state === 'loading' || isRetryable(health?.status);
        const message = (state === 'loading' || state === 'failed') && health?.message
          ? health.message
          : (TRANSCRIBE_FAULT_MESSAGE[reason] || TRANSCRIBE_FAULT_MESSAGE.failed);
        return res.status(409).json({
          error: reason,
          message,
          retryable,
          // Enum + supervisor hint only — never vault content, never audio (§1).
          health: { status: String(health?.status || 'unknown'), state, detail: health?.detail ?? null, model: health?.model ?? null, progress: health?.progress ?? null },
        });
      }

      const state = { status: 'running', coveredSec: 0, durationSec: 0, segments: 0, error: null };
      jobs.set(row.id, state);
      res.status(202).json({ ok: true, status: state });

      // Fire-and-forget the shared in-process job (already responded); onProgress feeds
      // the in-memory state the UI polls. The activity-feed entry is registered inside.
      transcribeAttachment(db, userId, row.id, {
        onProgress: (p) => { state.coveredSec = p.coveredSec; state.durationSec = p.durationSec; state.segments = p.segments; },
      }).then((r) => {
        // D-076: a partial run is NOT 'done' and it is NOT a flat 'error' either — it is work that
        // advanced and will continue. Reporting it as 'done' is the defect; reporting it as 'error'
        // would tell the owner their recording failed when most of it succeeded.
        state.status = r.ok ? 'done' : (r.partial ? 'partial' : 'error');
        if (r.ok === false && r.partial) { state.coveredSec = r.coveredSec ?? state.coveredSec; state.durationSec = r.durationSec ?? state.durationSec; }
        if (!r.ok) {
          // Carry the CAUSE, not just "error". `message` is owner-facing copy derived from a
          // fixed reason enum (never a raw service string); `detail` is the supervisor/service
          // hint (an HTTP code, faster-whisper's own message) — no audio, no vault content (§1).
          state.error = r.reason || 'failed';
          state.message = TRANSCRIBE_FAULT_MESSAGE[r.reason] || TRANSCRIBE_FAULT_MESSAGE.failed;
          state.detail = r.detail ?? null;
          state.retryable = r.retryable !== false;
        }
      }).catch(() => {
        state.status = 'error'; state.error = 'failed';
        state.message = TRANSCRIBE_FAULT_MESSAGE.failed; state.detail = null; state.retryable = true;
      });
    } catch (err) {
      console.error('[portal-attachments] transcribe start failed:', err?.message);
      res.status(500).json({ error: 'transcribe-failed' });
    }
  });

  // GET /attachments/:id/transcribe/status — poll progress.
  router.get('/attachments/:id/transcribe/status', async (req, res) => {
    try {
      const id = String(req.params.id);
      const row = await db.attachments.getById(id, userId);
      if (!row || row.user_id !== userId) return res.status(404).json({ error: 'not-found' });
      const job = jobs.get(id);
      const cov0 = readCoverage(row.metadata);
      // ⚠️ A TERMINAL JOB IS A MEMORY OF ONE PASS; COVERAGE IS THE CURRENT TRUTH.
      // `jobs` is never cleared, and 'partial' is specifically a state the BACKGROUND DRAIN is
      // expected to resolve — so serving the stale entry meant the owner kept reading "the rest
      // will be picked up automatically" long after the drain HAD finished the row, with frozen
      // coveredSec/durationSec beside it (adversarial review, MEDIUM-7). The entry is not simply
      // dropped, because that would also discard the fault REASON + owner copy on the first poll
      // after a failure (the QA6 §2 guarantee). Instead: coverage retires the entry once the row is
      // genuinely complete, and otherwise the live row's coverage refreshes the stale numbers.
      if (job && job.status !== 'running' && cov0?.complete) jobs.delete(id);
      const live = jobs.get(id);
      // transcript is the PROGRESSIVELY-saved text, so the UI can show it fill in live.
      if (live) return res.json({
        status: live.status,
        coveredSec: live.status === 'running' ? live.coveredSec : (cov0?.coveredSec ?? live.coveredSec),
        durationSec: live.status === 'running' ? live.durationSec : (cov0?.durationSec ?? live.durationSec),
        segments: live.status === 'running' ? live.segments : (cov0?.segments ?? live.segments),
        error: live.error,
        // The REASON, in words, plus whether a Retry is honest — so the Media page can stop
        // rendering the raw enum ("no-text") as the owner's whole explanation.
        message: live.message ?? null, detail: live.detail ?? null, retryable: live.retryable ?? null,
        hasTranscript: !!row.transcript, transcript: row.transcript || null,
      });
      // ⚠️ D-076: "HAS TEXT" IS NOT "DONE". With no job in flight this used to answer
      // `row.transcript ? 'done' : 'idle'`, so after a restart a PROGRESSIVELY-SAVED partial read
      // back as a finished transcription — the UI's half of the same lie the drain predicate told.
      // Coverage is the arbiter; 'partial' is the honest third state and carries how far it got.
      const cov = cov0;
      if (row.transcript && cov && cov.incomplete && !cov.complete) {
        return res.json({
          status: 'partial', hasTranscript: true, transcript: row.transcript,
          coveredSec: cov.coveredSec, durationSec: cov.durationSec, segments: cov.segments,
          // The recorded fault picks the copy: 'unverified-engine' must NOT read as "we'll finish
          // it for you", because on that configuration nothing will.
          retryable: true, message: TRANSCRIBE_FAULT_MESSAGE[cov.fault] || TRANSCRIBE_FAULT_MESSAGE.partial,
        });
      }
      return res.json({ status: row.transcript ? 'done' : 'idle', hasTranscript: !!row.transcript, transcript: row.transcript || null });
    } catch (err) {
      res.status(500).json({ error: 'status-failed' });
    }
  });

  return router;
}

export default portalAttachmentsRouter;
