import express from 'express';
import Busboy from 'busboy';
import JSZip from 'jszip';
import { captureMessage } from './ingest/capture.js';
import { detectExportType, processClaudeExport, processOpenAIExport } from './ingest/import-parsers.js';

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

  const IMPORT_LIMIT = Number(process.env.MYCELIUM_IMPORT_LIMIT_BYTES) || 512 * 1024 * 1024; // 512MB
  const CHUNK_LIMIT = 64 * 1024 * 1024; // 64MB per multipart part (client chunks at 50MB)
  const UPLOAD_ID_RE = /^up_[a-z0-9_]{4,40}$/i;

  // In-memory assembly buffer: uploadId → { parts: Map<index,Buffer>, bytes, filename, ts }.
  const pending = new Map();
  const sweepStale = () => {
    const cutoff = Date.now() - 60 * 60 * 1000; // 1h TTL
    for (const [id, e] of pending) if (e.ts < cutoff) pending.delete(id);
  };

  const fail = (res, code, error) => res.status(code).json({ ok: false, error });

  // Collect a single multipart `file`/`chunk` field into a capped Buffer + fields.
  const readMultipart = (req, fileField, maxBytes) => new Promise((resolve, reject) => {
    let bb;
    try { bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: maxBytes } }); }
    catch { return reject(new Error('bad multipart request')); }
    const fields = {};
    let buf = null, truncated = false, filename = null;
    bb.on('field', (name, val) => { if (typeof val === 'string' && val.length <= 1024) fields[name] = val; });
    bb.on('file', (name, stream, info) => {
      if (name !== fileField) { stream.resume(); return; }
      filename = info?.filename || null;
      const chunks = [];
      stream.on('data', (d) => chunks.push(d));
      stream.on('limit', () => { truncated = true; });
      stream.on('end', () => { buf = Buffer.concat(chunks); });
    });
    bb.on('close', () => resolve({ fields, buffer: buf, truncated, filename }));
    bb.on('error', () => reject(new Error('multipart parse failed')));
    req.pipe(bb);
  });

  // Detect + parse an assembled archive buffer → importResult (or a typed error).
  async function processArchive(buffer, filename) {
    let zip;
    try { zip = await JSZip.loadAsync(buffer); }
    catch { return { error: 'unrecognized file — upload a Claude or ChatGPT export .zip' }; }

    const detected = await detectExportType(zip);
    const capture = (msg) => captureMessage(db, { userId, ...msg }, enqueueEnrichment);

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
    return { error: 'unrecognized export — no Claude or ChatGPT conversations.json found' };
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

  // ── POST /upload/chunk — append one multipart `chunk` to the assembly buffer ─
  router.post('/upload/chunk', async (req, res) => {
    try {
      sweepStale();
      const { fields, buffer, truncated } = await readMultipart(req, 'chunk', CHUNK_LIMIT);
      if (truncated) return fail(res, 413, 'chunk too large');
      const uploadId = fields.uploadId;
      const index = parseInt(fields.index, 10);
      if (!UPLOAD_ID_RE.test(uploadId || '')) return fail(res, 400, 'invalid uploadId');
      if (!Number.isInteger(index) || index < 0) return fail(res, 400, 'invalid chunk index');
      if (!buffer || buffer.length === 0) return fail(res, 400, 'empty chunk');

      let e = pending.get(uploadId);
      if (!e) { e = { parts: new Map(), bytes: 0, filename: fields.filename || null, ts: Date.now() }; pending.set(uploadId, e); }
      if (e.bytes + buffer.length > IMPORT_LIMIT) { pending.delete(uploadId); return fail(res, 413, 'import exceeds size limit'); }
      if (!e.parts.has(index)) { e.parts.set(index, buffer); e.bytes += buffer.length; }
      e.ts = Date.now();
      res.json({ ok: true, chunk: index, received: e.parts.size });
    } catch { fail(res, 500, 'chunk upload failed'); }
  });

  // ── POST /upload/complete — assemble (JSON body) → detect → parse ───────────
  router.post('/upload/complete', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const { uploadId, totalChunks, filename } = req.body || {};
      if (!UPLOAD_ID_RE.test(uploadId || '')) return fail(res, 400, 'invalid uploadId');
      const e = pending.get(uploadId);
      if (!e) return fail(res, 404, 'no such upload (expired or never started)');
      const n = parseInt(totalChunks, 10);
      if (!Number.isInteger(n) || n <= 0 || e.parts.size !== n) {
        pending.delete(uploadId);
        return fail(res, 400, 'incomplete upload — missing chunks');
      }
      const ordered = [];
      for (let i = 0; i < n; i++) {
        const part = e.parts.get(i);
        if (!part) { pending.delete(uploadId); return fail(res, 400, 'incomplete upload — missing chunk'); }
        ordered.push(part);
      }
      pending.delete(uploadId); // free memory before the (CPU-bound) parse
      const out = await processArchive(Buffer.concat(ordered), e.filename || filename || null);
      if (out.error) return fail(res, 400, out.error);
      res.json(out);
    } catch { fail(res, 500, 'finalize failed'); }
  });

  return router;
}

export default portalUploadsRouter;
