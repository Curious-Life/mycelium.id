// src/ingest/run-import.js — the single import spine (Phase 2a).
//
// One orchestrator behind every import transport: normalize input → detect the
// source → dispatch to a registered adapter → return a uniform result. Routes
// (portal-uploads / portal-import / server-http) become thin wrappers; the
// parsers/writers (captureMessage, saveDocument, importMyceliumVault, …) are
// unchanged — we unify the ENTRY, not the writers.
//
// Design: docs/DESIGN-import-unification-phase2-2026-06-19.md §2.1.
// Phase 2a wires the ARCHIVE kind (the dispatch previously inlined in
// portal-uploads.js `processArchive`). Behavior is byte-identical — same
// detection, same parser calls, same { importResult } | { error } shapes —
// so verify:import / verify:vault-import stay GO. Later phases add kinds:
//   'loose-file' (2b → saveDocument/attachment), 'folder' (2c → markdown/obsidian).
//
// The adapter registry is the ONE place a new source lands. Adapters are inline
// here while there are few; they extract to src/ingest/sources/*.js when 2b/2c
// add more (each adapter is already a self-contained {detectType → run} pair).

import JSZip from 'jszip';
import {
  detectExportType, processClaudeExport, processOpenAIExport, assertEntryCount,
} from './import-parsers.js';
import { importMyceliumVault } from './vault-import.js';
import { captureMessage } from './capture.js';
import { deriveCreatedAt, TS_PROVENANCE } from './timestamp.js';
import { uploadAttachment } from './upload.js';
import { saveDocument } from '../core/document-store.js';
import { extractDocumentText } from '../enrich/extract-document.js';
import { describeImage } from '../enrich/describe-image.js';

// A capture() bound to this import's context — the message write boundary every
// conversation-export adapter funnels through.
const captureFor = (ctx) => (msg) => captureMessage(ctx.db, { userId: ctx.userId, ...msg }, ctx.enqueueEnrichment);

// ── Loose-file classification (self-contained; mirrors portal-uploads' table) ──
const EXT_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', bmp: 'image/bmp', svg: 'image/svg+xml', tif: 'image/tiff',
  tiff: 'image/tiff', avif: 'image/avif', pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown',
  markdown: 'text/markdown', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const extOf = (name) => (String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
const mimeFromName = (name) => EXT_MIME[extOf(name)] || 'application/octet-stream';
const isImageType = (t) => typeof t === 'string' && t.toLowerCase().startsWith('image/');
const humanizeFilename = (name) => {
  const base = String(name || '').replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return base || null;
};
const baseName = (name) => String(name || '').split('/').pop().split('\\').pop();

// Which loose files become DOCUMENTS (readable library notes) vs attachments.
//   text-doc   → md/markdown/txt or any text/*  → content is the utf8 body
//   binary-doc → pdf/docx                        → content via extractDocumentText
//   attachment → images + everything else        → encrypted blob + linked message
function classifyLooseFile(fileType, filename) {
  if (isImageType(fileType)) return 'attachment';
  const t = (fileType || '').toLowerCase();
  const ext = extOf(filename);
  if (t.startsWith('text/') || ['md', 'markdown', 'txt', 'text'].includes(ext)) return 'text-doc';
  if (t === 'application/pdf' || t.includes('wordprocessingml') || ['pdf', 'docx'].includes(ext)) return 'binary-doc';
  return 'attachment';
}

// Archive source adapters, keyed by detectExportType().type. Each returns the
// parser's report spread under a `type` tag (the exact shape routes returned
// before). Add a key here to support a new archive source.
const ARCHIVE_ADAPTERS = {
  mycelium: async (detected, ctx) =>
    ({ type: 'mycelium', ...(await importMyceliumVault(detected.zip, detected.manifest, { db: ctx.db, userId: ctx.userId, enqueueEnrichment: ctx.enqueueEnrichment })) }),
  claude: async (detected, ctx) =>
    ({ type: 'claude', ...(await processClaudeExport(detected.zip, { capture: captureFor(ctx), conversations: detected.conversations })) }),
  chatgpt: async (detected, ctx) =>
    ({ type: 'chatgpt', ...(await processOpenAIExport(detected.conversations, { capture: captureFor(ctx) })) }),
};

// Detected-but-not-importable archive types → an honest error (NEVER a
// success-shaped {imported:0}). A function so the message can use detection data.
const ARCHIVE_UNSUPPORTED = {
  'mycelium-oversized': (d) => `this Mycelium export's manifest exceeds the inflation cap (${Math.round(d.limitBytes / 1024 / 1024)}MB) — relaunch with MYCELIUM_IMPORT_MAX_JSON_BYTES raised, then retry`,
  obsidian: () => 'Obsidian vaults import via the folder importer (Settings → Import → Obsidian), not as a .zip upload — nothing was imported.',
  linkedin: () => 'LinkedIn export import is not supported yet — nothing was imported.',
};

/**
 * Run an import. The single entry point behind every upload/import transport.
 * @param {{ kind: 'archive'|'loose-file', buffer?: Buffer, zip?: object,
 *   bytes?: Buffer, filename?: string, mimeType?: string, lastModified?: any }} input
 * @param {{ db: object, userId: string, enqueueEnrichment?: Function }} ctx
 * @returns {Promise<{ importResult: object } | { error: string }>}
 */
export async function runImport(input, ctx) {
  if (!ctx?.db || !ctx?.userId) throw new Error('runImport: ctx.db and ctx.userId are required');
  switch (input?.kind) {
    case 'archive': return runArchive(input, ctx);
    case 'loose-file': return runLooseFile(input, ctx);
    default: throw new Error(`runImport: unknown input kind ${JSON.stringify(input?.kind)}`);
  }
}

// A single loose (non-archive) file: a `.md`/`.txt`/`.pdf`/`.docx` becomes a
// readable LIBRARY DOCUMENT (was: an opaque attachment — the bug this fixes);
// an image or unrecognized binary stays an attachment + linked message. Nothing
// is ever dropped: if document-text extraction yields nothing, we fall back to
// the attachment path so the bytes are still preserved.
async function runLooseFile(input, ctx) {
  const { bytes, filename } = input;
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error('runImport loose-file: bytes required');
  const fileType = (input.mimeType && input.mimeType !== 'application/octet-stream')
    ? input.mimeType : mimeFromName(filename);
  const klass = classifyLooseFile(fileType, filename);

  // Resolve the document body for text/binary-doc kinds.
  let content = null;
  if (klass === 'text-doc') content = bytes.toString('utf8');
  else if (klass === 'binary-doc') {
    try { content = await extractDocumentText({ bytes, mimeType: fileType, fileName: filename }); }
    catch { content = null; }
  }

  if (content && content.trim()) {
    // created_at from the client-supplied file mtime when present, else import
    // time — recorded with provenance so a now()-fallback is never silent.
    const { iso, provenance } = deriveCreatedAt([{ value: input.lastModified, provenance: TS_PROVENANCE.FILE_MTIME }]);
    const name = baseName(filename) || 'untitled';
    const r = await saveDocument({ db: ctx.db }, {
      userId: ctx.userId,
      source: 'portal-upload',          // → path strategy `uploads/<filename>`
      sourceType: 'upload',             // library source pill
      scope: 'personal',
      createdBy: 'user',
      pathArgs: { filename: name },
      title: humanizeFilename(filename) || name,
      content,
      createdAt: iso,
      metadata: { fileName: name, fileType, ts_provenance: provenance },
    });
    return { importResult: { type: 'document', path: r?.row?.path || `uploads/${name}`, action: r?.action } };
  }

  // Attachment fallback (image / unknown binary / extraction produced no text).
  const { attachmentId } = await uploadAttachment(ctx.db, {
    userId: ctx.userId, bytes, fileName: filename, fileType, asMessage: false,
  });
  const isImage = isImageType(fileType);
  let caption = null;
  if (isImage) { try { caption = await describeImage({ bytes }); } catch { caption = null; } }
  const label = humanizeFilename(filename);
  const msgText = caption
    || (isImage ? (label ? `Image: ${label}` : 'Uploaded image') : (label ? `File: ${label}` : 'Uploaded file'));
  const msg = await captureMessage(ctx.db, {
    userId: ctx.userId, content: msgText, source: 'upload', attachmentId,
    metadata: { kind: isImage ? 'image' : 'file', fileName: filename, fileType, captioned: Boolean(caption) },
  }, ctx.enqueueEnrichment);
  return { importResult: { type: isImage ? 'image' : 'file', attachmentId, messageId: msg?.id || null, captioned: Boolean(caption) } };
}

// Transport normalization for archives: bytes → loaded+bomb-guarded zip →
// detect → dispatch. Owns the entry-count/zip-bomb guard (was in portal-uploads).
async function runArchive(input, ctx) {
  let zip = input.zip;
  if (!zip) {
    try { zip = await JSZip.loadAsync(input.buffer); assertEntryCount(zip); }
    catch (e) {
      if (e?.code === 'TOO_MANY_ENTRIES') return { error: 'this archive has too many entries — refusing to import (possible archive bomb)' };
      return { error: 'unrecognized file — upload a Mycelium vault export, or a Claude/ChatGPT export .zip' };
    }
  }
  const detected = await detectExportType(zip);
  detected.zip = zip; // adapters that need the archive (mycelium, claude) read it here
  const adapter = ARCHIVE_ADAPTERS[detected.type];
  if (adapter) return { importResult: await adapter(detected, ctx) };
  const unsupported = ARCHIVE_UNSUPPORTED[detected.type];
  if (unsupported) return { error: unsupported(detected) };
  return { error: 'unrecognized export — expected a Mycelium vault export, or a Claude/ChatGPT conversations.json' };
}
