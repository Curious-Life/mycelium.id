// Broad "bring everything useful from this Mac" sweep importer.
//
// Walks ONE user-chosen, allowlist-confined folder and routes every file by its
// category (file-categories.js — one taxonomy shared with the detector):
//   • TEXT documents (md/txt/csv/…) → a DOCUMENT (editable, upsert-on-path) +
//     a MEMORY (captureMessage → mindscape), exactly like an Obsidian note;
//   • binary documents (pdf/doc/docx/…), images, audio, video → an ENCRYPTED
//     ATTACHMENT (putBlob + attachments row, identical bytes deduped to one
//     blob) PLUS a linked memory row (content empty, attachment_id set) so the
//     file enters the timeline and the enrichment pipeline can caption images /
//     transcribe audio later. Nothing is silently dropped.
//
// source 'import-local-files' (the `import-` prefix bypasses the agent-capture
// consent gate, like every other explicit importer). Caller picks which
// categories to bring; an unselected category is skipped (counted as such).
//
// Caps are generous but real (a sweep can touch tens of thousands of files):
// per-file size, total file budget, recursion depth. Truncation is REPORTED,
// never silent. Symlinks are never followed (no escape out of the chosen root).

import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { captureMessage } from './capture.js';
import { saveDocument } from '../core/document-store.js';
import { putBlob } from './blob-store.js';
import { recordContentFlow } from '../inference/usage.js';
import { categoryOf, extOf, isManagedPackageDir, TEXT_DOC_EXTS, EXT_MIME } from './file-categories.js';

const MAX_FILES = Number(process.env.MYCELIUM_SWEEP_MAX_FILES) || 50000;
const MAX_DEPTH = Number(process.env.MYCELIUM_SWEEP_MAX_DEPTH) || 8;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_MEDIA_BYTES = Number(process.env.MYCELIUM_ATTACHMENT_LIMIT_BYTES) || 25 * 1024 * 1024;
// System/cache dirs that are never "useful context" — pruned so a sweep of
// ~/Documents or ~/Library never walks app caches, VCS internals, node_modules.
const SKIP_DIRS = new Set(['.git', '.svn', '.hg', 'node_modules', '.Trash', '.trash', '.cache', 'Caches', '.npm', '.obsidian', '.smart-env', 'Library']);

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** messageType for a non-text category (so enrichment + UI know what it is). */
const MEDIA_MSG_TYPE = { image: 'image', audio: 'voice', video: 'video', document: 'file' };

/** Bounded recursive walk collecting files whose category is selected. */
async function walkFiles(root, wanted, { maxFiles = MAX_FILES, maxDepth = MAX_DEPTH } = {}) {
  const out = [];
  let truncated = false;
  async function walk(dir, depth) {
    if (out.length >= maxFiles) { truncated = true; return; }
    if (depth > maxDepth) return;
    let ents; try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.length >= maxFiles) { truncated = true; return; }
      if (e.isSymbolicLink()) continue; // never follow symlinks out of the chosen root
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || SKIP_DIRS.has(e.name) || isManagedPackageDir(e.name)) continue;
        await walk(path.join(dir, e.name), depth + 1);
      } else if (e.isFile()) {
        const cat = categoryOf(e.name);
        if (cat && wanted.has(cat)) out.push({ abs: path.join(dir, e.name), relPath: path.relative(root, path.join(dir, e.name)), cat });
      }
    }
  }
  await walk(root, 0);
  return { files: out, truncated };
}

/**
 * Sweep-import a folder.
 * @param {object} db
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.folderPath            already realpath-confined by the route
 * @param {string[]} [opts.categories]        which to import (default all four)
 * @param {(id:string)=>void} [opts.enqueueEnrichment]
 */
export async function importLocalFiles(db, { userId, folderPath, categories, enqueueEnrichment } = {}) {
  if (!db?.messages || !db?.documents) throw new TypeError('importLocalFiles: db.messages + db.documents required');
  if (typeof userId !== 'string' || !userId) throw new Error('importLocalFiles: userId required');
  if (typeof folderPath !== 'string' || !folderPath) throw new Error('importLocalFiles: folderPath required');
  const st = await fs.stat(folderPath).catch(() => null);
  if (!st?.isDirectory()) throw new Error('importLocalFiles: folderPath is not a directory');

  const allCats = ['document', 'image', 'audio', 'video'];
  const wanted = new Set(Array.isArray(categories) && categories.length ? categories.filter((c) => allCats.includes(c)) : allCats);
  // strip trailing path separators without a regex (avoid polynomial backtracking
  // on a pathological all-separator string)
  let trimmedPath = folderPath;
  while (trimmedPath.length > 1 && (trimmedPath.endsWith('/') || trimmedPath.endsWith('\\'))) {
    trimmedPath = trimmedPath.slice(0, -1);
  }
  const rootName = path.basename(trimmedPath) || 'files';
  const summary = {
    scanned: 0, truncated: false,
    documents: { created: 0, deduped: 0, updated: 0 },
    attachments: { imported: 0, deduped: 0, blobsReused: 0 },
    skipped: { oversize: 0, unreadable: 0, unsafe: 0 }, failed: 0,
    categories: [...wanted],
  };

  const { files, truncated } = await walkFiles(folderPath, wanted);
  summary.truncated = truncated;
  summary.scanned = files.length;
  const textContents = [];

  // Preload existing attachment ids + byte-hashes so a re-sweep dedups rows AND
  // shares one encrypted blob for identical bytes (same convention as obsidian).
  // V2 NOTE (multi-tenant): this SELECT spans the whole attachments table — correct
  // for single-user V1 (one user), but when RLS/multi-user lands it MUST add
  // `WHERE user_id = ?` or it would cross-read another tenant's blob paths.
  const existingAttIds = new Set();
  const blobByHash = new Map();
  try {
    const existing = await db.rawQuery?.('SELECT id, local_path, metadata FROM attachments', []);
    for (const row of existing?.results || []) {
      if (row.id) existingAttIds.add(row.id);
      try { const m = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata; if (m?.sha256 && row.local_path) blobByHash.set(m.sha256, row.local_path); } catch { /* */ }
    }
  } catch { /* no preload → still correct, just no cross-sweep byte-dedup */ }

  for (const f of files) {
    // Reject any traversal segment before it ever touches a path/document write.
    const segs = f.relPath.split(path.sep);
    if (!f.relPath || segs.some((s) => s === '' || s === '.' || s === '..')) { summary.skipped.unsafe += 1; continue; }
    const posixRel = segs.join('/');
    const ext = extOf(f.abs);
    const isText = f.cat === 'document' && TEXT_DOC_EXTS.has(ext);
    try {
      const fst = await fs.stat(f.abs).catch(() => null);
      if (!fst) { summary.skipped.unreadable += 1; continue; }
      const mtime = fst.mtime?.toISOString?.();

      if (isText) {
        if (fst.size === 0 || fst.size > MAX_TEXT_BYTES) { summary.skipped.oversize += 1; continue; }
        const content = await fs.readFile(f.abs, 'utf8');
        if (!content.trim()) { summary.skipped.unreadable += 1; continue; }
        const title = path.basename(posixRel);
        await saveDocument({ db }, {
          userId, source: 'import-local-files', sourceType: 'import_local', createdBy: 'import', scope: 'personal',
          path: `import/local-files/${rootName}/${posixRel}`, title, content,
          metadata: { root: rootName, relPath: posixRel, category: f.cat }, createdAt: mtime, updatedAt: mtime,
        });
        summary.documents.created += 1;
        const { deduped, updated } = await captureMessage(db, {
          userId, id: `local:${rootName}/${posixRel}`, content, source: 'import-local-files',
          messageType: 'note', createdAt: mtime,
          metadata: { root: rootName, relPath: posixRel, category: f.cat, title },
        }, enqueueEnrichment);
        if (updated) summary.documents.updated += 1; else if (deduped) summary.documents.deduped += 1;
        if (!deduped && !updated) textContents.push(content);
        continue;
      }

      // Binary (pdf/doc/image/audio/video) → encrypted attachment + linked memory.
      if (fst.size === 0 || fst.size > MAX_MEDIA_BYTES) { summary.skipped.oversize += 1; continue; }
      const attId = sha256(Buffer.from(`local:${folderPath}/${posixRel}`)).slice(0, 32);
      if (existingAttIds.has(attId)) { summary.attachments.deduped += 1; continue; }
      const bytes = await fs.readFile(f.abs);
      const hash = sha256(bytes);
      let localPath = blobByHash.get(hash) || null;
      if (localPath) summary.attachments.blobsReused += 1;
      else { const { path: stored } = await putBlob(bytes, { userId, ext: ext ? `.${ext}` : '' }); localPath = stored; blobByHash.set(hash, stored); }
      await db.attachments.insert({
        id: attId, user_id: userId, file_name: path.basename(posixRel),
        file_type: EXT_MIME[ext] || 'application/octet-stream', file_size: bytes.length,
        local_path: localPath, metadata: JSON.stringify({ root: rootName, relPath: posixRel, sha256: hash, source: 'local-files', category: f.cat }),
      });
      existingAttIds.add(attId);
      summary.attachments.imported += 1;
      // A linked memory so the file enters the timeline + enrichment (caption/transcribe).
      try {
        await captureMessage(db, {
          userId, id: `local-att:${attId}`, content: '', attachmentId: attId,
          source: 'import-local-files', messageType: MEDIA_MSG_TYPE[f.cat] || 'file', createdAt: mtime,
          metadata: { root: rootName, relPath: posixRel, category: f.cat, fileName: path.basename(posixRel) },
        }, enqueueEnrichment);
      } catch { /* attachment already landed; the linked memory is best-effort */ }
    } catch (e) {
      summary.failed += 1;
      if (!summary.firstError) summary.firstError = String(e?.message || e).slice(0, 160);
    }
  }

  if (textContents.length) recordContentFlow(db, userId, { source: 'ingest', area: 'import', content: textContents });
  return summary;
}
