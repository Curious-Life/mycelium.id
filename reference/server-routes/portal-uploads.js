/**
 * Portal uploads router (Phase 10 PR 7A).
 *
 * Owns every file-delivery surface the portal can hit:
 *
 *   POST /portal/send-file         — worker-gated: file-to-R2 from disk/base64
 *   POST /portal/upload/chunk      — chunk ingress for large uploads
 *   POST /portal/upload/complete   — assemble chunks + auto-import ZIP exports
 *   POST /portal/upload            — single-file upload with import auto-detect
 *
 * Known bugs fixed during PR 7A:
 *   - /portal/upload/complete: `persistentPath` was declared inside the
 *     try block but referenced inside the catch. Always ReferenceError
 *     on the error path. Hoisted to outer scope.
 *   - /portal/upload: same shape — `tempPath` referenced in the catch
 *     while declared inside the try. Hoisted.
 */

import { Router } from 'express';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import Busboy from 'busboy';

import { processAttachment, createAttachmentRecord } from '@mycelium/core/attachments.js';
import { getWorkerUrl, getWorkerSecret, hasWorkerSecret } from '@mycelium/core/env.js';
import { clampDocumentContent } from '@mycelium/core/document-limits.js';
import { saveDocument, SaveDocumentError } from '@mycelium/core/document-store.js';
import {
  detectExportType,
  processClaudeExport,
  processOpenAIExport,
  processObsidianExport,
  processLinkedInExport,
} from '@mycelium/core/import-parsers.js';

/**
 * @typedef {object} CreatePortalUploadsRouterDeps
 * @property {(req: any) => Promise<object|null>}  authenticatePortalRequest
 * @property {(req: any, res: any) => boolean}     requireWorkerSecret
 * @property {() => object|null}                   tryGetDb
 * @property {(type: string, msg: string, meta?: object) => void} addActivity
 * @property {object}   paths                      — { root, repo }
 * @property {(err: any, fallback?: string) => string} safeError
 * @property {(args: object) => Promise<void>}     storeAttachmentRecord
 * @property {(req: any, res: any, endpoint: string, maxPerMinute?: number) => boolean} checkRateLimit
 * @property {(userId: string) => void}            invalidateOnboardingCache
 * @property {(userId: string, event: string, count: number) => Promise<void>} sendEnrichmentEmail
 * @property {object}   config                     — { LOG_PREFIX, MYA_WORKER_URL, REPO_ROOT }
 * @property {object}   [log]
 */

export function createPortalUploadsRouter(deps) {
  if (!deps) throw new TypeError('createPortalUploadsRouter: deps required');
  const {
    authenticatePortalRequest,
    requireWorkerSecret,
    tryGetDb,
    addActivity,
    paths,
    safeError,
    storeAttachmentRecord,
    checkRateLimit,
    invalidateOnboardingCache,
    sendEnrichmentEmail,
    config,
    log,
  } = deps;

  if (typeof authenticatePortalRequest !== 'function') {
    throw new TypeError('createPortalUploadsRouter: authenticatePortalRequest required');
  }
  if (typeof requireWorkerSecret !== 'function') {
    throw new TypeError('createPortalUploadsRouter: requireWorkerSecret required');
  }
  if (typeof tryGetDb !== 'function') {
    throw new TypeError('createPortalUploadsRouter: tryGetDb required');
  }
  if (typeof addActivity !== 'function') {
    throw new TypeError('createPortalUploadsRouter: addActivity required');
  }
  if (!paths?.root || !paths?.repo) {
    throw new TypeError('createPortalUploadsRouter: paths.root and paths.repo required');
  }
  if (typeof safeError !== 'function') {
    throw new TypeError('createPortalUploadsRouter: safeError required');
  }
  if (typeof storeAttachmentRecord !== 'function') {
    throw new TypeError('createPortalUploadsRouter: storeAttachmentRecord required');
  }
  if (typeof checkRateLimit !== 'function') {
    throw new TypeError('createPortalUploadsRouter: checkRateLimit required');
  }
  if (typeof invalidateOnboardingCache !== 'function') {
    throw new TypeError('createPortalUploadsRouter: invalidateOnboardingCache required');
  }
  if (typeof sendEnrichmentEmail !== 'function') {
    throw new TypeError('createPortalUploadsRouter: sendEnrichmentEmail required');
  }
  if (!config?.LOG_PREFIX || !config?.REPO_ROOT) {
    throw new TypeError('createPortalUploadsRouter: config.LOG_PREFIX and REPO_ROOT required');
  }

  const { LOG_PREFIX, MYA_WORKER_URL, REPO_ROOT } = config;
  const logger = log || console;
  const router = Router();

  // ── Chunked upload state ────────────────────────────────────────────
  // Client streams 50MB chunks via /portal/upload/chunk, then calls
  // /portal/upload/complete to assemble. Entries expire after 30 min.
  const activeChunkedUploads = new Map();
  const cleanup = setInterval(() => {
    for (const [id, u] of activeChunkedUploads) {
      if (Date.now() > u.expiresAt) {
        fs.rm(u.dir, { recursive: true, force: true }).catch(() => {});
        activeChunkedUploads.delete(id);
      }
    }
  }, 10 * 60 * 1000);
  // Let the interval not keep the process alive — tests import this router
  // without starting an HTTP server and would otherwise hang on exit.
  if (typeof cleanup.unref === 'function') cleanup.unref();

  // ── POST /portal/send-file ──────────────────────────────────────────
  // Worker-gated: reads arbitrary files from disk (within allowlist) OR
  // accepts base64, uploads to R2 via Worker, returns a portal URL.
  router.post('/portal/send-file', async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;

    const { filePath, base64, filename, mimeType } = req.body;
    if (!filePath && !base64) {
      return res.status(400).json({ error: 'filePath or base64 required' });
    }

    // Either MYA_WORKER_SECRET (owner VPS) or a per-agent token (customer
    // VPS) must be present — both deployment modes need R2 access.
    if (!getWorkerSecret() && !process.env.AGENT_TOKEN_MYA && !process.env.AGENT_TOKEN) {
      return res.status(503).json({ error: 'R2 storage not configured' });
    }

    addActivity('action', `Uploading file for portal: ${filename || filePath || 'base64'}`, { type: 'portal-send-file' });

    try {
      let data;
      let name = filename;
      let mime = mimeType || 'application/octet-stream';

      if (filePath) {
        const resolved = path.resolve(filePath);
        const allowed = [path.resolve(paths.root), path.resolve(paths.repo), '/tmp'];
        if (process.env.WARROOM_PATH) allowed.push(path.resolve(process.env.WARROOM_PATH));
        if (!allowed.some((p) => resolved.startsWith(p + '/'))) {
          return res.status(403).json({ error: 'File path outside allowed directories' });
        }
        data = await fs.readFile(filePath);
        name = name || path.basename(filePath);
      } else {
        data = Buffer.from(base64, 'base64');
        name = name || 'document';
      }

      const base64Data = Buffer.from(data).toString('base64');
      const userId = process.env.USER_ID || 'agent';

      const response = await fetch(`${MYA_WORKER_URL}/api/store-attachment`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${getWorkerSecret()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          data: base64Data,
          userId,
          type: 'file',
          filename: name,
          mimeType: mime,
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`R2 storage failed: ${response.status} ${error}`);
      }

      const result = await response.json();
      const portalUrl = `${MYA_WORKER_URL}/attachments/${encodeURIComponent(result.key)}`;

      storeAttachmentRecord({
        filename: name,
        mimeType: mime,
        fileSize: data.length,
        source: 'portal',
        caption: req.body.content || req.body.caption,
        r2Key: result.key,
      }).catch((err) => logger.error?.(`[${LOG_PREFIX}] Attachment record failed:`, err.message));

      logger.info?.(`[${LOG_PREFIX}] File uploaded for portal: ${name} → ${result.key}`);
      res.json({ ok: true, r2Key: result.key, url: portalUrl, filename: name });
    } catch (error) {
      logger.error?.(`[${LOG_PREFIX}] Portal send file error:`, error.message);
      res.status(500).json({ error: safeError(error, 'Upload failed') });
    }
  });

  // ── POST /portal/upload/chunk ───────────────────────────────────────
  router.post('/portal/upload/chunk', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const bb = Busboy({ headers: req.headers, limits: { fileSize: 55_000_000, files: 1, fields: 5 } });
      let chunkBuf = null;
      let uploadId = null;
      let chunkIdx = null;
      let fname = null;
      const parseP = new Promise((resolve, reject) => {
        const chunks = [];
        bb.on('file', (_, stream) => {
          stream.on('data', (c) => chunks.push(c));
          stream.on('end', () => { chunkBuf = Buffer.concat(chunks); });
        });
        bb.on('field', (n, v) => {
          if (n === 'uploadId') uploadId = v;
          if (n === 'index') chunkIdx = parseInt(v);
          if (n === 'filename') fname = v;
        });
        bb.on('close', resolve);
        bb.on('error', reject);
      });
      req.pipe(bb);
      await parseP;
      if (!uploadId || chunkIdx == null || !chunkBuf) {
        return res.status(400).json({ error: 'Missing chunk data' });
      }
      if (!/^up_[a-z0-9_]{6,30}$/.test(uploadId)) {
        return res.status(400).json({ error: 'Invalid uploadId' });
      }
      let upload = activeChunkedUploads.get(uploadId);
      if (!upload) {
        const dir = path.join(os.tmpdir(), `mycelium-chunked-${uploadId}`);
        await fs.mkdir(dir, { recursive: true });
        upload = {
          dir,
          chunks: new Set(),
          userId: user.id,
          filename: fname || 'file.zip',
          expiresAt: Date.now() + 30 * 60 * 1000,
        };
        activeChunkedUploads.set(uploadId, upload);
      }
      if (upload.userId !== user.id) return res.status(403).json({ error: 'Session mismatch' });
      await fs.writeFile(path.join(upload.dir, `chunk_${String(chunkIdx).padStart(6, '0')}`), chunkBuf);
      upload.chunks.add(chunkIdx);
      logger.info?.(`[${LOG_PREFIX}] Chunk ${chunkIdx} for ${uploadId} (${chunkBuf.length} bytes, ${upload.chunks.size} total)`);
      res.json({ ok: true, chunk: chunkIdx, received: upload.chunks.size });
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Chunk upload failed') });
    }
  });

  // ── POST /portal/upload/complete ────────────────────────────────────
  router.post('/portal/upload/complete', async (req, res) => {
    // Bug-fix: `persistentPath` was declared inside the try in the pre-PR-7A
    // version, but the catch block references it — always ReferenceError on
    // any error after assignment. Hoisted here so the catch can log it.
    let persistentPath = null;
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const { uploadId, filename, totalChunks, fileSize } = req.body || {};
      if (!uploadId || !totalChunks) return res.status(400).json({ error: 'Missing params' });
      const upload = activeChunkedUploads.get(uploadId);
      if (!upload) return res.status(404).json({ error: 'Upload expired' });
      if (upload.userId !== user.id) return res.status(403).json({ error: 'Session mismatch' });
      if (upload.chunks.size < totalChunks) {
        return res.status(400).json({ error: `${upload.chunks.size}/${totalChunks} chunks received` });
      }

      logger.info?.(`[${LOG_PREFIX}] Assembling ${totalChunks} chunks for ${uploadId} (~${Math.round((fileSize || 0) / 1e6)}MB)`);
      const assembled = path.join(os.tmpdir(), `mycelium-assembled-${uploadId}`);
      const { createWriteStream: cws } = await import('fs');
      const ws = cws(assembled);
      for (let i = 0; i < totalChunks; i++) {
        ws.write(await fs.readFile(path.join(upload.dir, `chunk_${String(i).padStart(6, '0')}`)));
      }
      await new Promise((ok, fail) => { ws.on('finish', ok); ws.on('error', fail); ws.end(); });
      await fs.rm(upload.dir, { recursive: true, force: true }).catch(() => {});
      activeChunkedUploads.delete(uploadId);

      const uploadsDir = path.join(REPO_ROOT, 'uploads');
      await fs.mkdir(uploadsDir, { recursive: true }).catch(() => {});
      persistentPath = path.join(uploadsDir, `${uploadId}-${filename || 'file'}`);
      await fs.rename(assembled, persistentPath).catch(async () => {
        await fs.copyFile(assembled, persistentPath);
        await fs.unlink(assembled).catch(() => {});
      });
      logger.info?.(`[${LOG_PREFIX}] Assembled: ${persistentPath} (${Math.round((await fs.stat(persistentPath)).size / 1e6)}MB)`);

      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'DB unavailable — file saved, retry later', file: persistentPath });

      const isZip = (filename || '').endsWith('.zip');
      const aSize = (await fs.stat(persistentPath)).size;
      let fileBuffer;

      if (isZip && aSize > 200_000_000) {
        const extractDir = persistentPath + '-extract';
        await fs.mkdir(extractDir, { recursive: true });
        try {
          const { execSync } = await import('child_process');
          execSync(`unzip -j -o "${persistentPath}" "*.json" "*.md" "*.csv" "*.txt" -d "${extractDir}" 2>/dev/null || true`, { timeout: 300_000, maxBuffer: 1024 * 1024 });
          const files = await fs.readdir(extractDir);
          if (!files.length) throw new Error('No text files in ZIP');
          logger.info?.(`[${LOG_PREFIX}] Extracted ${files.length} text files, skipped media`);
          const JSZip = (await import('jszip')).default;
          const tz = new JSZip();
          for (const f of files) tz.file(f, await fs.readFile(path.join(extractDir, f)));
          fileBuffer = await tz.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
          logger.info?.(`[${LOG_PREFIX}] Repacked: ${Math.round(fileBuffer.length / 1e6)}MB`);
        } finally {
          await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});
        }
      } else {
        fileBuffer = await fs.readFile(persistentPath);
      }

      if (isZip) {
        const JSZip = (await import('jszip')).default;
        const zip = await JSZip.loadAsync(fileBuffer);
        const detected = await detectExportType(zip);
        if (detected) {
          let importResult;
          if (detected.type === 'claude') {
            const s = await processClaudeExport(zip, user.id, db);
            importResult = { type: 'claude', imported: s.messages + (s.project_docs || 0), skipped: s.skipped_duplicates, stats: s };
          } else if (detected.type === 'chatgpt') {
            const s = await processOpenAIExport(detected.conversations, user.id, db, detected.extras || {});
            importResult = { type: 'chatgpt', imported: s.messages, skipped: s.skipped_duplicates, stats: s };
          } else if (detected.type === 'obsidian') {
            const s = await processObsidianExport(zip, user.id, db);
            importResult = { type: 'obsidian', imported: s.imported, skipped: s.skipped, stats: s };
          } else if (detected.type === 'linkedin') {
            const s = await processLinkedInExport(zip, user.id, db);
            importResult = { type: 'linkedin', imported: s.connections + s.messages, skipped: s.skipped_duplicates || 0, stats: s };
          }
          if (importResult) {
            invalidateOnboardingCache(user.id);
            if (importResult.imported > 0) {
              try {
                const enrichUrl = process.env.ENRICHMENT_URL || 'http://127.0.0.1:8095';
                const jobId = `enr_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;
                await db.rawQuery(
                  `INSERT INTO background_jobs (id, user_id, kind, status, step, total_steps, stage_label, started_at, last_heartbeat) VALUES (?, ?, 'enrichment', 'running', 0, 2, 'Starting…', datetime('now'), datetime('now'))`,
                  [jobId, user.id],
                );
                fetch(`${enrichUrl}/enrich-all`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ userId: user.id, jobId }),
                  signal: AbortSignal.timeout(5000),
                }).catch(() => {});
                importResult.enrichmentJobId = jobId;
              } catch {}
            }
            logger.info?.(`[${LOG_PREFIX}] Chunked import: ${detected.type}, ${importResult.imported} imported`);
            if (importResult.imported > 0) {
              await fs.unlink(persistentPath).catch(() => {});
              logger.info?.(`[${LOG_PREFIX}] Cleaned up uploaded file after successful import`);
            } else {
              logger.info?.(`[${LOG_PREFIX}] Import reported 0 items — keeping file for retry: ${persistentPath}`);
            }
            return res.json({ importResult });
          }
        }
      }
      logger.info?.(`[${LOG_PREFIX}] Unrecognized export — keeping file for retry: ${persistentPath}`);
      res.status(400).json({ error: 'Not recognized as a supported export', file: persistentPath });
    } catch (err) {
      logger.error?.(`[${LOG_PREFIX}] Chunked complete error:`, err.message);
      logger.info?.(`[${LOG_PREFIX}] File retained for retry: ${persistentPath || 'unknown'}`);
      if (!res.headersSent) {
        res.status(500).json({ error: safeError(err, 'Import failed — file saved for retry') });
      }
    }
  });

  // ── POST /portal/upload ─────────────────────────────────────────────
  router.post('/portal/upload', async (req, res) => {
    if (!checkRateLimit(req, res, 'upload', 10)) return;
    // Bug-fix: `tempPath` was declared inside the try in the pre-PR-7A
    // version, but the catch references it — always ReferenceError on
    // error. Hoisted here so the catch can clean up the temp file.
    let tempPath = null;
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const maxUploadBytes = parseInt(process.env.MAX_UPLOAD_MB || '3000') * 1_000_000;
      const bb = Busboy({ headers: req.headers, limits: { fileSize: maxUploadBytes, files: 1 } });
      let filename = 'file';
      let mimeType = 'application/octet-stream';
      let fileSize = 0;

      const parsePromise = new Promise((resolve, reject) => {
        bb.on('file', async (fieldname, stream, info) => {
          filename = info.filename || 'file';
          mimeType = info.mimeType || 'application/octet-stream';
          tempPath = path.join(os.tmpdir(), `mycelium-upload-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
          const { createWriteStream } = await import('fs');
          const ws = createWriteStream(tempPath);
          stream.on('data', (chunk) => { fileSize += chunk.length; });
          stream.pipe(ws);
          ws.on('finish', () => resolve());
          ws.on('error', reject);
          stream.on('error', reject);
        });
        bb.on('error', reject);
        bb.on('close', () => { if (!tempPath) resolve(); });
      });

      req.pipe(bb);
      await parsePromise;

      if (!tempPath || fileSize === 0) {
        if (tempPath) try { await fs.unlink(tempPath); } catch {}
        return res.status(400).json({ error: 'No file uploaded' });
      }

      logger.info?.(`[${LOG_PREFIX}] Portal upload: ${filename} (${fileSize} bytes → ${tempPath})`);

      // Large ZIPs (>200MB): extract only text files (JSON, MD, CSV, TXT)
      // using system unzip, then repack. Avoids loading 2GB+ into Node memory.
      let fileBuffer;
      const isZip = mimeType === 'application/zip' || filename.endsWith('.zip');
      const isLarge = fileSize > 200_000_000;

      if (isZip && isLarge) {
        logger.info?.(`[${LOG_PREFIX}] Large ZIP (${(fileSize / 1_000_000).toFixed(0)}MB) — extracting text files via CLI`);
        const extractDir = tempPath + '-extract';
        await fs.mkdir(extractDir, { recursive: true });
        try {
          const { execSync } = await import('child_process');
          execSync(`unzip -j -o "${tempPath}" "*.json" "*.md" "*.csv" "*.txt" -d "${extractDir}" 2>/dev/null || true`, {
            timeout: 120_000,
            maxBuffer: 1024 * 1024,
          });
          const extracted = await fs.readdir(extractDir);
          logger.info?.(`[${LOG_PREFIX}] Extracted ${extracted.length} text files from ZIP (skipped media)`);

          if (extracted.length === 0) {
            throw new Error('No importable text files found in ZIP');
          }

          const JSZip = (await import('jszip')).default;
          const textZip = new JSZip();
          for (const fname of extracted) {
            const content = await fs.readFile(path.join(extractDir, fname));
            textZip.file(fname, content);
          }
          fileBuffer = await textZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
          logger.info?.(`[${LOG_PREFIX}] Repacked ZIP: ${(fileBuffer.length / 1_000_000).toFixed(1)}MB (was ${(fileSize / 1_000_000).toFixed(0)}MB)`);
        } finally {
          await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});
        }
      } else {
        fileBuffer = await fs.readFile(tempPath);
      }

      try { await fs.unlink(tempPath); tempPath = null; } catch {}

      if (isZip) {
        try {
          const JSZip = (await import('jszip')).default;
          const zip = await JSZip.loadAsync(fileBuffer);
          const detected = await detectExportType(zip);

          if (detected) {
            let importResult;
            const { type: exportType } = detected;

            if (exportType === 'claude') {
              const stats = await processClaudeExport(zip, user.id, db);
              const parts = [];
              if (stats.messages > 0) parts.push(`${stats.messages} messages from ${stats.conversations} conversations`);
              if (stats.skipped_duplicates > 0) parts.push(`${stats.skipped_duplicates} duplicates skipped`);
              if (stats.artifacts_deduplicated > 0) parts.push(`${stats.artifacts_kept} artifacts kept, ${stats.artifacts_deduplicated} deduplicated`);
              if (stats.projects > 0) parts.push(`${stats.projects} projects, ${stats.project_docs} project docs`);
              if (stats.memories > 0) parts.push(`${stats.memories} memories`);
              importResult = {
                type: 'claude',
                imported: stats.messages + stats.project_docs + stats.memories,
                skipped: stats.skipped_duplicates,
                stats,
              };
              logger.info?.(`[${LOG_PREFIX}] Claude import complete: ${parts.join(', ')}`);
            } else if (exportType === 'chatgpt') {
              const stats = await processOpenAIExport(detected.conversations, user.id, db, detected.extras || {});
              const parts = [`${stats.messages} messages from ${stats.conversations} conversations`];
              if (stats.skipped_duplicates > 0) parts.push(`${stats.skipped_duplicates} duplicates skipped`);
              if (stats.feedback_count > 0) parts.push(`${stats.feedback_count} ratings`);
              if (stats.media_references > 0) parts.push(`${stats.media_references} media references`);
              if (stats.shared_conversations > 0) parts.push(`${stats.shared_conversations} shared conversations`);
              importResult = {
                type: 'chatgpt',
                imported: stats.messages,
                skipped: stats.skipped_duplicates,
                stats,
              };
              logger.info?.(`[${LOG_PREFIX}] ChatGPT import complete: ${parts.join(', ')}`);
            } else if (exportType === 'obsidian') {
              const stats = await processObsidianExport(zip, user.id, db);
              importResult = {
                type: 'obsidian',
                imported: stats.imported,
                skipped: stats.skipped,
                stats,
              };
            } else if (exportType === 'linkedin') {
              const stats = await processLinkedInExport(zip, user.id, db);
              const parts = [];
              if (stats.connections > 0) parts.push(`${stats.connections} contacts`);
              if (stats.messages > 0) parts.push(`${stats.messages} messages from ${stats.conversations} conversations`);
              if (stats.noise_filtered > 0) parts.push(`${stats.noise_filtered} noise filtered`);
              if (stats.skipped_duplicates > 0) parts.push(`${stats.skipped_duplicates} duplicates skipped`);
              importResult = {
                type: 'linkedin',
                imported: stats.connections + stats.messages,
                skipped: stats.skipped_duplicates + stats.noise_filtered,
                stats,
              };
              logger.info?.(`[${LOG_PREFIX}] LinkedIn import complete: ${parts.join(', ')}`);
            }

            if (importResult) {
              invalidateOnboardingCache(user.id);
              if (importResult.imported > 0) {
                try {
                  const enrichUrl = process.env.ENRICHMENT_URL || 'http://127.0.0.1:8095';
                  const jobId = `enr_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;
                  await db.rawQuery(
                    `INSERT INTO background_jobs (id, user_id, kind, status, step, total_steps, stage_label, started_at, last_heartbeat)
                     VALUES (?, ?, 'enrichment', 'running', 0, 2, 'Starting…', datetime('now'), datetime('now'))`,
                    [jobId, user.id],
                  );
                  fetch(`${enrichUrl}/enrich-all`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId: user.id, jobId }),
                    signal: AbortSignal.timeout(5000),
                  }).catch(() => {});
                  sendEnrichmentEmail(user.id, 'started', importResult.imported).catch(() => {});
                  importResult.enrichmentJobId = jobId;
                } catch (enrichErr) {
                  logger.warn?.(`[${LOG_PREFIX}] Auto-enrichment trigger failed (non-fatal): ${enrichErr.message}`);
                }
              }

              const label = exportType === 'obsidian'
                ? 'Obsidian vault'
                : exportType === 'linkedin'
                  ? 'LinkedIn data'
                  : `${exportType} export`;
              return res.json({
                attachmentId: null,
                type: 'import',
                content: `[Imported ${label}: ${importResult.imported} items imported${importResult.skipped > 0 ? `, ${importResult.skipped} skipped` : ''}]`,
                filename,
                importResult,
              });
            }
          }
        } catch (zipErr) {
          logger.error?.(`[${LOG_PREFIX}] ZIP auto-detect failed:`, zipErr.message);
          // Fall through to normal file processing
        }
      }

      // Process through existing attachment pipeline (R2 storage + AI processing)
      const result = await processAttachment(
        { name: filename, data: fileBuffer, size: fileBuffer.length, contentType: mimeType },
        user.id,
      );

      const attachmentId = await createAttachmentRecord(null, {
        userId: user.id,
        type: result.type,
        filename,
        mimeType,
        size: fileBuffer.length,
        r2Key: result.r2Key,
        streamInfo: result.streamInfo,
        description: result.description,
        transcript: result.transcript,
        discordMetadata: { source: 'portal' },
      });

      // Create document record so the file appears in the library. For text
      // files, use the full raw text (not the truncated description).
      let docContent = '';
      if (result.type === 'text' && fileBuffer) {
        docContent = new TextDecoder().decode(fileBuffer);
      } else {
        docContent = result.description || result.transcript || result.content || '';
      }
      const docTitle = filename.replace(/\.[^.]+$/, '');
      let docRecord = null;
      try {
        // Same content clamp as messages-io's agent-file path. ~750 KB
        // plaintext (vs. legacy 50 KB) with explicit truncation marker
        // on overflow. Covers multi-hour transcripts; full file remains
        // in R2 via attachments.r2_key.
        const saveRes = await saveDocument({ db }, {
          userId: user.id,
          source: 'portal-upload',
          // Library list UI maps source_type='upload' → "Upload" pill.
          // Preserve that mapping; the canonical `source` value still
          // drives path strategy + events.
          sourceType: 'upload',
          scope: 'personal',
          createdBy: 'user',
          pathArgs: { filename },
          title: docTitle,
          content: clampDocumentContent(docContent),
          summary: docContent.substring(0, 200),
        });
        docRecord = saveRes?.row || null;
      } catch (docErr) {
        if (docErr instanceof SaveDocumentError) {
          logger.error?.(`[${LOG_PREFIX}] saveDocument refused: ${docErr.code} — ${docErr.message}`);
        } else {
          logger.error?.(`[${LOG_PREFIX}] Document record failed:`, docErr.message);
        }
      }

      // Generate embedding for semantic search (fire-and-forget).
      // Writes encrypted Nomic 768D vector to documents.embedding_768
      // (in D1). The mind-search scan-matcher loads this at agent boot
      // and serves searchMindscape queries from RAM.
      if (docRecord?.id && docContent.length > 10) {
        (async () => {
          try {
            const { generateEmbedding } = await import('@mycelium/core/local-ai-client.js');
            const { encryptVector } = await import('@mycelium/core/mind-search/ann/decode.js');
            const { getMasterKeyFromBestSource } = await import('@mycelium/core/crypto-local.js');
            const masterKey = await getMasterKeyFromBestSource().catch(() => null);
            if (!masterKey) {
              logger.warn?.(`[${LOG_PREFIX}] Document embed skipped — no master key`);
              return;
            }
            const arr = await generateEmbedding(docContent.slice(0, 8000), { task: 'document' });
            const vec = Float32Array.from(arr);
            const scope = docRecord.scope || 'org';
            const envelope = await encryptVector(vec, scope, masterKey, user.id);
            const { tryGetDb } = await import('@mycelium/core/db.js');
            const db = tryGetDb();
            if (!db?.d1Query) {
              logger.warn?.(`[${LOG_PREFIX}] Document embed skipped — db not ready`);
              return;
            }
            await db.d1Query(
              `UPDATE documents SET embedding_768 = ? WHERE id = ? AND user_id = ?`,
              [envelope, docRecord.id, user.id],
            );
            logger.info?.(`[${LOG_PREFIX}] Embedded document: ${docRecord.path}`);
          } catch (embedErr) {
            logger.error?.(`[${LOG_PREFIX}] Embedding failed:`, embedErr.message);
          }
        })();
      }

      logger.info?.(`[${LOG_PREFIX}] Portal upload processed: ${filename} → ${result.type} (attachment: ${attachmentId})`);
      res.json({
        attachmentId,
        type: result.type,
        content: result.content || `[File: ${filename}]`,
        filename,
      });
    } catch (error) {
      logger.error?.(`[${LOG_PREFIX}] Portal upload error:`, error.message);
      if (tempPath) try { await fs.unlink(tempPath); } catch {}
      if (!res.headersSent) res.status(500).json({ error: safeError(error, 'Upload failed') });
    }
  });

  logger.info?.('[portal-uploads-router] mounted 4 handlers');
  return router;
}
