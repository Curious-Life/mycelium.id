import express from 'express';
import Busboy from 'busboy';
import JSZip from 'jszip';
import { captureMessage } from './ingest/capture.js';
import { detectExportType, processClaudeExport, processOpenAIExport } from './ingest/import-parsers.js';
import { importMyceliumVault } from './ingest/vault-import.js';
import { uploadAttachment } from './ingest/upload.js';
import { describeImage } from './enrich/describe-image.js';

/**
 * portalUploadsRouter — the V1 Import surface for the canonical portal. Mounted
 * under `/api/v1/portal` (the UI's chunked-upload client posts /portal/upload,
 * /portal/upload/chunk, /portal/upload/complete, rewritten by api.ts).
 *
 * Transport: small files arrive single-shot as multipart `file`; large files are
 * sent as 50MB chunks (multipart) then finalized with a JSON /complete. Chunks
 * are assembled IN MEMORY (single-user local vault), hard-capped to avoid OOM,
 * and never written to disk in plaintext (the export holds sensitive data —
 * CLAUDE.md §1). On finalize we detect the format, parse, and funnel every
 * message through captureMessage() (encrypt-at-rest + dedup + enrich enqueue).
 *
 * Returns the exact `{ importResult: { type, imported, skipped, stats } }` shape
 * the import screen consumes. Claude + ChatGPT are supported; other formats
 * return a benign "not supported yet" result (no throw).
 *
 * @param {object} deps
 * @param {object} deps.db
 * @param {string} deps.userId
 * @param {(id:string)=>void} [deps.enqueueEnrichment]
 * @returns {import('express').Router}
 */
export function portalUploadsRouter({ db, userId, enqueueEnrichment = null }) {
  if (!db) throw new Error('portalUploadsRouter: db required');
  const router = express.Router();

  // 8GB default — a full "bring-your-vault-home" export is media-heavy and can
  // run to several GB; env-tunable for bigger vaults / smaller machines. Note
  // the in-memory assembly ceiling (below) is bounded by RAM, not this number —
  // genuinely huge vaults (> heap) are the streaming follow-up.
  const IMPORT_LIMIT = Number(process.env.MYCELIUM_IMPORT_LIMIT_BYTES) || 8_000_000_000;
  const CHUNK_LIMIT = 64 * 1024 * 1024; // 64MB per multipart part (client chunks at 50MB)
  // Bound how much can be pre-allocated across ALL in-flight uploads at once, so
  // a (local, authed) client mis-declaring sizes can't reserve unbounded RAM.
  const MAX_TOTAL_INFLIGHT = Number(process.env.MYCELIUM_IMPORT_MAX_INFLIGHT_BYTES) || IMPORT_LIMIT * 2;
  const MAX_CONCURRENT_UPLOADS = Number(process.env.MYCELIUM_IMPORT_MAX_CONCURRENT) || 8;
  const MAX_CHUNKS = Number(process.env.MYCELIUM_IMPORT_MAX_CHUNKS) || 200_000;
  const UPLOAD_ID_RE = /^up_[a-z0-9_]{4,40}$/i;

  // Assembly: ONE pre-allocated Buffer per upload, filled by offset as chunks
  // arrive (the client sends fileSize + chunkSize per chunk). This avoids the
  // old parts-Map + Buffer.concat, which transiently held the file TWICE (~2×
  // the size) right before processing — the OOM cliff for multi-GB vaults. Bytes
  // stay IN MEMORY, never written to disk in plaintext (CLAUDE.md §1).
  // uploadId → { buf, fileSize, chunkSize, received:Set<index>, filename, ts }.
  const pending = new Map();
  const totalInflight = () => { let n = 0; for (const e of pending.values()) n += e.fileSize; return n; };
  const sweepStale = () => {
    const cutoff = Date.now() - 60 * 60 * 1000; // 1h TTL
    for (const [id, e] of pending) if (e.ts < cutoff) pending.delete(id);
  };

  const fail = (res, code, error) => res.status(code).json({ ok: false, error });

  // Attachment uploads (images / docs) — separate, generous cap from the import path.
  const MAX_ATTACHMENT_BYTES = Number(process.env.MYCELIUM_ATTACHMENT_LIMIT_BYTES) || 25 * 1024 * 1024; // 25MB
  const isImageType = (t) => typeof t === 'string' && t.toLowerCase().startsWith('image/');
  const EXT_MIME = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    heic: 'image/heic', heif: 'image/heif', bmp: 'image/bmp', svg: 'image/svg+xml', tif: 'image/tiff',
    tiff: 'image/tiff', avif: 'image/avif', pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown',
  };
  const mimeFromName = (name) => {
    const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    return (m && EXT_MIME[m[1]]) || 'application/octet-stream';
  };
  const humanizeFilename = (name) => {
    const base = String(name || '').replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    return base || null;
  };

  // Collect a single multipart `file`/`chunk` field into a capped Buffer + fields.
  const readMultipart = (req, fileField, maxBytes) => new Promise((resolve, reject) => {
    let bb;
    try { bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: maxBytes } }); }
    catch { return reject(new Error('bad multipart request')); }
    const fields = {};
    let buf = null, truncated = false, filename = null, mimeType = null;
    bb.on('field', (name, val) => { if (typeof val === 'string' && val.length <= 1024) fields[name] = val; });
    bb.on('file', (name, stream, info) => {
      if (name !== fileField) { stream.resume(); return; }
      filename = info?.filename || null;
      mimeType = info?.mimeType || null;
      const chunks = [];
      stream.on('data', (d) => chunks.push(d));
      stream.on('limit', () => { truncated = true; });
      stream.on('end', () => { buf = Buffer.concat(chunks); });
    });
    bb.on('close', () => resolve({ fields, buffer: buf, truncated, filename, mimeType }));
    bb.on('error', () => reject(new Error('multipart parse failed')));
    req.pipe(bb);
  });

  // Detect + parse an assembled archive buffer → importResult (or a typed error).
  async function processArchive(buffer, filename) {
    let zip;
    try { zip = await JSZip.loadAsync(buffer); }
    catch { return { error: 'unrecognized file — upload a Mycelium vault export, or a Claude/ChatGPT export .zip' }; }

    const detected = await detectExportType(zip);
    const capture = (msg) => captureMessage(db, { userId, ...msg }, enqueueEnrichment);

    if (detected.type === 'mycelium-oversized') {
      return { error: `this Mycelium export's manifest exceeds the inflation cap (${Math.round(detected.limitBytes / 1024 / 1024)}MB) — relaunch with MYCELIUM_IMPORT_MAX_JSON_BYTES raised, then retry` };
    }
    if (detected.type === 'mycelium') {
      // Canonical-Mycelium vault export — the bring-your-vault-home path. All
      // rows land through the auto-encrypting adapter; messages are reset to
      // nlp_processed=0 so the local pipeline re-embeds (the export carries no
      // search vectors). See docs/VAULT-IMPORT-FROM-CANONICAL-DESIGN-2026-06-10.md.
      const r = await importMyceliumVault(zip, detected.manifest, { db, userId, enqueueEnrichment });
      return { importResult: { type: 'mycelium', ...r } };
    }
    if (detected.type === 'claude') {
      const r = await processClaudeExport(zip, { capture, conversations: detected.conversations });
      return { importResult: { type: 'claude', ...r } };
    }
    if (detected.type === 'chatgpt') {
      const r = await processOpenAIExport(detected.conversations, { capture });
      return { importResult: { type: 'chatgpt', ...r } };
    }
    if (detected.type === 'obsidian' || detected.type === 'linkedin') {
      return { importResult: { type: detected.type, imported: 0, skipped: 0, stats: {}, note: `${detected.type} import is not supported yet` } };
    }
    return { error: 'unrecognized export — expected a Mycelium vault export, or a Claude/ChatGPT conversations.json' };
  }

  // ── POST /upload — single-shot multipart `file` ────────────────────────────
  router.post('/upload', async (req, res) => {
    try {
      const { buffer, truncated } = await readMultipart(req, 'file', IMPORT_LIMIT);
      if (truncated) return fail(res, 413, 'file too large — the client should chunk it');
      if (!buffer || buffer.length === 0) return fail(res, 400, 'no file received');
      const out = await processArchive(buffer, null);
      if (out.error) return fail(res, 400, out.error);
      res.json(out);
    } catch { fail(res, 500, 'upload failed'); }
  });

  // ── POST /upload/chunk — copy one multipart `chunk` into the assembly buffer ─
  router.post('/upload/chunk', async (req, res) => {
    try {
      sweepStale();
      const { fields, buffer, truncated } = await readMultipart(req, 'chunk', CHUNK_LIMIT);
      if (truncated) return fail(res, 413, 'chunk too large');
      const uploadId = fields.uploadId;
      const index = parseInt(fields.index, 10);
      const fileSize = parseInt(fields.fileSize, 10);
      const chunkSize = parseInt(fields.chunkSize, 10);
      if (!UPLOAD_ID_RE.test(uploadId || '')) return fail(res, 400, 'invalid uploadId');
      if (!Number.isInteger(index) || index < 0) return fail(res, 400, 'invalid chunk index');
      if (!buffer || buffer.length === 0) return fail(res, 400, 'empty chunk');
      if (!Number.isInteger(fileSize) || fileSize <= 0 || fileSize > IMPORT_LIMIT) return fail(res, 413, 'import exceeds size limit');
      if (!Number.isInteger(chunkSize) || chunkSize <= 0 || chunkSize > CHUNK_LIMIT) return fail(res, 400, 'invalid chunkSize');

      let e = pending.get(uploadId);
      if (!e) {
        if (pending.size >= MAX_CONCURRENT_UPLOADS) return fail(res, 429, 'too many uploads in progress');
        // Pre-allocation guard: don't let in-flight reservations exceed the cap.
        if (totalInflight() + fileSize > MAX_TOTAL_INFLIGHT) return fail(res, 429, 'too many large uploads in progress');
        if (Math.ceil(fileSize / chunkSize) > MAX_CHUNKS) return fail(res, 413, 'too many chunks');
        // allocUnsafe is safe here: we reject on complete unless EVERY index is
        // present (full coverage), so no uninitialized region is ever read.
        e = { buf: Buffer.allocUnsafe(fileSize), fileSize, chunkSize, received: new Set(), filename: fields.filename || null, ts: Date.now() };
        pending.set(uploadId, e);
      }
      // Pin size/chunkSize from the first chunk — later mismatches are rejected.
      if (fileSize !== e.fileSize || chunkSize !== e.chunkSize) return fail(res, 400, 'inconsistent upload metadata');
      const offset = index * e.chunkSize;
      if (offset < 0 || offset + buffer.length > e.fileSize) return fail(res, 400, 'chunk out of range');
      buffer.copy(e.buf, offset);          // write this chunk into its slot (idempotent on retry)
      e.received.add(index);
      e.ts = Date.now();
      res.json({ ok: true, chunk: index, received: e.received.size });
    } catch { fail(res, 500, 'chunk upload failed'); }
  });

  // ── POST /upload/complete — verify full coverage → detect → parse ───────────
  router.post('/upload/complete', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const { uploadId, totalChunks, filename } = req.body || {};
      if (!UPLOAD_ID_RE.test(uploadId || '')) return fail(res, 400, 'invalid uploadId');
      const e = pending.get(uploadId);
      if (!e) return fail(res, 404, 'no such upload (expired or never started)');
      const n = parseInt(totalChunks, 10);
      // Every index 0..n-1 must be present (no gaps → no uninitialized bytes),
      // and n must match the buffer the declared sizes implied.
      const expected = Math.ceil(e.fileSize / e.chunkSize);
      if (!Number.isInteger(n) || n !== expected || e.received.size !== n) {
        pending.delete(uploadId);
        return fail(res, 400, 'incomplete upload — missing chunks');
      }
      for (let i = 0; i < n; i++) {
        if (!e.received.has(i)) { pending.delete(uploadId); return fail(res, 400, 'incomplete upload — missing chunk'); }
      }
      const buf = e.buf;
      pending.delete(uploadId); // drop the reservation; buf stays referenced for the parse
      const out = await processArchive(buf, e.filename || filename || null);
      if (out.error) return fail(res, 400, out.error);
      res.json(out);
    } catch { fail(res, 500, 'finalize failed'); }
  });

  // ── POST /upload/file — store ONE non-archive file (image, doc, …) as an
  // encrypted attachment + a linked message, so it enters the embed → mindscape
  // pipeline. Images get a best-effort caption from a LOCAL vision model (Ollama,
  // src/enrich/describe-image.js); with no vision model the caption falls back to
  // the filename. A real file is NEVER rejected — this is the PNG-rejection fix
  // (the /upload route only understands Claude/ChatGPT export ZIPs).
  router.post('/upload/file', async (req, res) => {
    try {
      const { buffer, truncated, filename, mimeType } = await readMultipart(req, 'file', MAX_ATTACHMENT_BYTES);
      if (truncated) return fail(res, 413, 'file too large (max 25MB)');
      if (!buffer || buffer.length === 0) return fail(res, 400, 'no file received');

      const fileType = mimeType && mimeType !== 'application/octet-stream' ? mimeType : mimeFromName(filename);
      const isImage = isImageType(fileType);

      // 1) Encrypted blob + attachments row (no message yet).
      const { attachmentId } = await uploadAttachment(db, {
        userId, bytes: buffer, fileName: filename, fileType, asMessage: false,
      });

      // 2) Best-effort on-box caption for images (fail-soft → null, never blocks).
      let caption = null;
      if (isImage) {
        try { caption = await describeImage({ bytes: buffer }); } catch { caption = null; }
      }

      // 3) Linked message with the best available text → auto-encrypted by
      //    captureMessage, queued at nlp_processed=0 → embedded by the drainer.
      const label = humanizeFilename(filename);
      const content = caption
        || (isImage ? (label ? `Image: ${label}` : 'Uploaded image')
                    : (label ? `File: ${label}` : 'Uploaded file'));
      const msg = await captureMessage(db, {
        userId, content, source: 'upload', attachmentId,
        metadata: { kind: isImage ? 'image' : 'file', fileName: filename, fileType, captioned: Boolean(caption) },
      }, enqueueEnrichment);

      res.json({
        ok: true, attachmentId, messageId: msg?.id || null, filename: filename || null,
        type: isImage ? 'image' : 'file', captioned: Boolean(caption),
      });
    } catch { fail(res, 500, 'file upload failed'); }
  });

  return router;
}

export default portalUploadsRouter;
