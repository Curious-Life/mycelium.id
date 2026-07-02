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

import { promises as fsp } from 'node:fs';
import JSZip from 'jszip';
import {
  detectExportType, processClaudeExport, processOpenAIExport, assertEntryCount,
} from './import-parsers.js';
import { listEntries, openEntryStream } from './zip-stream.js';
import { streamJsonArray } from './json-array-stream.js';

// Streaming-path bounds. Entry cap matches import-parsers'. The streamed
// conversations.json no longer hits the 512MB V8 string cap, so its byte cap is
// just a decompression-bomb backstop, not a real-history limit (8GB default).
const STREAM_MAX_ENTRIES = Number(process.env.MYCELIUM_IMPORT_MAX_ENTRIES) || 500_000;
const STREAM_MAX_JSON_BYTES = Number(process.env.MYCELIUM_IMPORT_STREAM_MAX_JSON_BYTES) || 8 * 1024 * 1024 * 1024;
import { importMyceliumVault } from './vault-import.js';
import { captureMessage } from './capture.js';
import { deriveCreatedAt, TS_PROVENANCE } from './timestamp.js';
import { uploadAttachment } from './upload.js';
import { saveDocument } from '../core/document-store.js';
import { extractDocumentText } from '../enrich/extract-document.js';
import { describeImage } from '../enrich/describe-image.js';

// A capture() bound to this import's context — the message write boundary every
// conversation-export adapter funnels through.
// `ctx.capture` is an optional injected write seam (used by gates to exercise the
// pipeline without a real vault); production passes none and goes through the
// audited, encrypting captureMessage choke-point.
const captureFor = (ctx) => ctx.capture || ((msg) => captureMessage(ctx.db, { userId: ctx.userId, ...msg }, ctx.enqueueEnrichment));

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

const UNRECOGNIZED_EXPORT = 'unrecognized export — expected a Mycelium vault export, or a Claude/ChatGPT conversations.json';
const BAD_ARCHIVE = 'unrecognized file — upload a Mycelium vault export, or a Claude/ChatGPT export .zip';
const ARCHIVE_BOMB = 'this archive has too many entries — refusing to import (possible archive bomb)';

// Streaming archive path (gig-scale): read entry NAMES + the one needed entry out
// of a (possibly multi-GB) archive — from a Buffer (yauzl.fromBuffer, in-memory,
// NO disk write — preserves the "bytes never hit disk in plaintext" invariant) OR
// a file path — WITHOUT loading the whole zip or conversations.json into memory.
// Claude/ChatGPT conversations.json streams ONE conversation at a time, so the
// 512MB V8 string cap + the full-array heap are gone (constant memory, any size).
async function runArchiveStreaming(src, ctx) {
  let names;
  try { names = await listEntries(src, { maxEntries: STREAM_MAX_ENTRIES }); }
  catch (e) { return { error: e?.code === 'TOO_MANY_ENTRIES' ? ARCHIVE_BOMB : BAD_ARCHIVE }; }

  // Mycelium vault export first (priority, as detectExportType orders it): it's the
  // only format with manifest.json → the JSZip importer (vault streaming is future;
  // large vault exports arrive via the off-disk dirPath importer, not an upload).
  if (names.includes('manifest.json')) {
    const buf = Buffer.isBuffer(src) ? src : await fsp.readFile(src);
    return dispatchPreloadedZip(await JSZip.loadAsync(buf), ctx);
  }
  // Claude / ChatGPT — the gig-scale case: stream conversations.json.
  if (names.includes('conversations.json')) {
    let stream;
    try { stream = await openEntryStream(src, 'conversations.json', { maxEntries: STREAM_MAX_ENTRIES, maxBytes: STREAM_MAX_JSON_BYTES }); }
    catch (e) { if (e?.code === 'ENTRY_TOO_LARGE') return { error: 'conversations.json exceeds the import byte cap (possible decompression bomb)' }; throw e; }
    if (!stream) return { error: UNRECOGNIZED_EXPORT };
    const gen = streamJsonArray(stream);
    let first;
    try { first = await gen.next(); } catch { return { error: UNRECOGNIZED_EXPORT }; } // malformed JSON
    if (first.done) return { error: UNRECOGNIZED_EXPORT };
    const f = first.value || {};
    async function* all() { yield first.value; yield* gen; } // chain peeked-first + rest (single pass, no re-open)
    if (f.mapping && typeof f.mapping === 'object') {
      return { importResult: { type: 'chatgpt', ...(await processOpenAIExport(all(), { capture: captureFor(ctx) })) } };
    }
    if (Array.isArray(f.chat_messages)) {
      return { importResult: { type: 'claude', ...(await processClaudeExport(null, { capture: captureFor(ctx), conversations: all() })) } };
    }
    return { error: UNRECOGNIZED_EXPORT };
  }
  if (names.some((n) => n.toLowerCase().endsWith('.md'))) return { error: ARCHIVE_UNSUPPORTED.obsidian() };
  if (names.some((n) => /connections\.csv|messages\.csv/i.test(n))) return { error: ARCHIVE_UNSUPPORTED.linkedin() };
  return { error: UNRECOGNIZED_EXPORT };
}

// Dispatch a fully-loaded JSZip (mycelium vault export, or a caller-supplied zip)
// through the detect→adapter path. Holds the whole archive in memory — only used
// for the manifest-driven mycelium importer, not the streamed conversations path.
async function dispatchPreloadedZip(zip, ctx) {
  try { assertEntryCount(zip); } catch { return { error: ARCHIVE_BOMB }; }
  const detected = await detectExportType(zip);
  detected.zip = zip; // adapters that need the archive (mycelium) read it here
  const adapter = ARCHIVE_ADAPTERS[detected.type];
  if (adapter) return { importResult: await adapter(detected, ctx) };
  const unsupported = ARCHIVE_UNSUPPORTED[detected.type];
  if (unsupported) return { error: unsupported(detected) };
  return { error: UNRECOGNIZED_EXPORT };
}

// Transport normalization for archives. Route the bytes (a Buffer, or a spooled
// file path) through the STREAMING reader — entry-count/zip-bomb guard included —
// so conversations.json never explodes into one >512MB string. A caller already
// holding a parsed JSZip (rare) dispatches directly.
async function runArchive(input, ctx) {
  if (input.zip) return dispatchPreloadedZip(input.zip, ctx);
  const src = input.filePath || input.buffer;
  if (!src) return { error: BAD_ARCHIVE };
  return runArchiveStreaming(src, ctx);
}
