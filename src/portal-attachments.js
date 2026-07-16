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
import { getTranscriberHealth } from './transcribe/supervisor.js';

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

/**
 * @param {object} deps
 * @param {object} deps.db      wired vault db (attachments namespace)
 * @param {string} deps.userId
 */
export function portalAttachmentsRouter({ db, userId }) {
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
        const hdr = req.headers.range;
        const m = hdr && /^bytes=(\d*)-(\d*)$/.exec(String(hdr).trim());
        if (m) {
          let start = m[1] === '' ? NaN : parseInt(m[1], 10);
          let end = m[2] === '' ? NaN : parseInt(m[2], 10);
          if (Number.isNaN(start)) { // suffix range: bytes=-N → last N bytes
            const n = Number.isNaN(end) ? total : end;
            start = Math.max(0, total - n); end = total - 1;
          }
          if (Number.isNaN(end) || end >= total) end = total - 1;
          if (Number.isFinite(start) && start >= 0 && start <= end && start < total) {
            res.status(206);
            res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
            res.setHeader('Content-Length', end - start + 1);
            return res.end(buf.subarray(start, end + 1));
          }
          res.status(416).setHeader('Content-Range', `bytes */${total}`); // unsatisfiable
          return res.end();
        }
        res.setHeader('Content-Length', total);
        return res.send(buf);
      };

      // ?format=wav — in-process OGG/Opus → WAV transcode for browser playback
      // (WKWebView can't decode Opus; Telegram voice notes are always OGG).
      // Fail-soft: a failed transcode serves the original bytes.
      if (req.query.format === 'wav' && /ogg|opus/i.test(row.file_type || '')) {
        try {
          const { oggOpusToWav } = await import('./enrich/ogg-opus.js');
          const wav = await oggOpusToWav(bytes);
          if (wav) {
            res.setHeader('Content-Type', 'audio/wav');
            if (row.file_name) res.setHeader('Content-Disposition', `inline; filename="${String(row.file_name).replace(/[^\w. -]/g, '_')}.wav"`);
            return sendRange(wav);
          }
        } catch { /* fall through to raw bytes */ }
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
  // In-memory per-attachment job state (progress the UI polls). Runs IN-PROCESS so
  // every transcript write stays on the app's single DB writer (no 2nd vault writer).
  const jobs = new Map(); // attachmentId → { status, coveredSec, durationSec, segments, error }

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
      const health = (() => { try { return getTranscriberHealth(); } catch { return null; } })();
      if (health?.status !== 'ok') return res.status(409).json({ error: 'no-model', message: 'Download a transcription model in Settings first.' });

      const state = { status: 'running', coveredSec: 0, durationSec: 0, segments: 0, error: null };
      jobs.set(row.id, state);
      res.status(202).json({ ok: true, status: state });

      // Fire-and-forget the shared in-process job (already responded); onProgress feeds
      // the in-memory state the UI polls. The activity-feed entry is registered inside.
      transcribeAttachment(db, userId, row.id, {
        onProgress: (p) => { state.coveredSec = p.coveredSec; state.durationSec = p.durationSec; state.segments = p.segments; },
      }).then((r) => {
        state.status = r.ok ? 'done' : 'error';
        if (!r.ok) state.error = r.reason || 'failed';
      }).catch(() => { state.status = 'error'; state.error = 'failed'; });
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
      // transcript is the PROGRESSIVELY-saved text, so the UI can show it fill in live.
      if (job) return res.json({ status: job.status, coveredSec: job.coveredSec, durationSec: job.durationSec, segments: job.segments, error: job.error, hasTranscript: !!row.transcript, transcript: row.transcript || null });
      return res.json({ status: row.transcript ? 'done' : 'idle', hasTranscript: !!row.transcript, transcript: row.transcript || null });
    } catch (err) {
      res.status(500).json({ error: 'status-failed' });
    }
  });

  return router;
}

export default portalAttachmentsRouter;
