import express from 'express';
import Busboy from 'busboy';
import { runImport } from './ingest/run-import.js';

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

  // Attachment uploads (images / docs) — separate, generous cap from the import
  // path. Type classification + document-vs-attachment routing now live in the
  // import spine (src/ingest/run-import.js); this router just caps + forwards.
  const MAX_ATTACHMENT_BYTES = Number(process.env.MYCELIUM_ATTACHMENT_LIMIT_BYTES) || 100 * 1024 * 1024; // 100MB (env-tunable)

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
  // Archive imports (Claude/ChatGPT/Mycelium vault zips) now route through the
  // single import spine (src/ingest/run-import.js) — detection, dispatch, the
  // zip-bomb/entry-count guard and the unsupported-format errors all live there.
  // `filename` is currently unused by the archive path (detection is by content)
  // but kept in the signature for the loose-file kind that 2b will add.
  async function processArchive(buffer, filename) { // eslint-disable-line no-unused-vars
    return runImport({ kind: 'archive', buffer }, { db, userId, enqueueEnrichment });
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
      const { buffer, truncated, filename, mimeType, fields } = await readMultipart(req, 'file', MAX_ATTACHMENT_BYTES);
      if (truncated) return fail(res, 413, 'file too large (max 25MB)');
      if (!buffer || buffer.length === 0) return fail(res, 400, 'no file received');

      // The spine decides document-vs-attachment by type: a .md/.txt/.pdf/.docx
      // becomes a readable Library DOCUMENT; an image / unknown binary stays an
      // attachment + linked message. `lastModified` (when the client sends it)
      // preserves the file's original date. @see src/ingest/run-import.js.
      const out = await runImport(
        { kind: 'loose-file', bytes: buffer, filename, mimeType, lastModified: fields?.lastModified },
        { db, userId, enqueueEnrichment },
      );
      if (out.error) return fail(res, 400, out.error);
      res.json({ ok: true, filename: filename || null, ...out.importResult });
    } catch { fail(res, 500, 'file upload failed'); }
  });

  return router;
}

export default portalUploadsRouter;
