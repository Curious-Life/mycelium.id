// src/ingest/run-import.js — the single import spine (Phase 2a).
//
// One orchestrator behind every import transport: normalize input → detect the
// source → dispatch to a registered adapter → return a uniform result. Routes
// (portal-uploads / portal-import / server-http) become thin wrappers; the
// parsers/writers (captureMessage, saveDocument, importMyceliumVault, …) are
// unchanged — we unify the ENTRY, not the writers.
//
// Design: the import-unification design §2.1.
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
  readEntryBytes, hasNestedVaultManifest, BUNDLE_MAX_ENTRY_BYTES,
} from './import-parsers.js';
import {
  findEntryByBasename, ambiguousEntryError, isBundleEntry, safeEntryBasename,
  nestedVaultExportError,
} from './archive-entries.js';
import { listEntries, openEntryStream, readEntriesSequential } from './zip-stream.js';
import { streamJsonArray } from './json-array-stream.js';

// Streaming-path bounds. Entry cap matches import-parsers'. The streamed
// conversations.json no longer hits the 512MB V8 string cap, so its byte cap is
// just a decompression-bomb backstop, not a real-history limit (8GB default).
const STREAM_MAX_ENTRIES = Number(process.env.MYCELIUM_IMPORT_MAX_ENTRIES) || 500_000;
const STREAM_MAX_JSON_BYTES = Number(process.env.MYCELIUM_IMPORT_STREAM_MAX_JSON_BYTES) || 8 * 1024 * 1024 * 1024;
// `bundle` bounds. The bundle kind ENUMERATES entries (the AI-export kinds read
// one known entry), so it gets its own caps on top of the shared entry-count cap:
// how many files we will import, and how many OBSERVED bytes we will inflate in
// total. Both are fail-loud: hitting one reports `truncated: true`, never a
// silent short import.
const BUNDLE_MAX_FILES = Number(process.env.MYCELIUM_IMPORT_BUNDLE_MAX_FILES) || 5_000;
const BUNDLE_MAX_TOTAL_BYTES = Number(process.env.MYCELIUM_IMPORT_BUNDLE_MAX_TOTAL_BYTES) || 8 * 1024 * 1024 * 1024;
import { importMyceliumVault } from './vault-import.js';
import { captureMessage } from './capture.js';
import { deriveCreatedAt, TS_PROVENANCE } from './timestamp.js';
import { extractExifDate } from './exif.js';
import { uploadAttachment } from './upload.js';
import { saveDocument } from '../core/document-store.js';
import { extractDocumentText } from '../enrich/extract-document.js';
import { describeImage } from '../enrich/describe-image.js';
import { transcribeAttachment } from '../enrich/transcribe-attachment.js';

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
const isAudioType = (t) => typeof t === 'string' && (t.toLowerCase().startsWith('audio/') || t.toLowerCase() === 'voice');
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
  // A plain zip of documents/media (no recognized export manifest): every
  // allowlisted entry goes through the SAME loose-file router a single upload
  // takes, so md/txt → document, pdf/docx → extracted document, images →
  // encrypted attachment. Also covers Google Takeout (a zip of exported Docs)
  // with zero auth and zero egress.
  bundle: async (detected, ctx) => runBundle(
    (names) => readBufferedEntries(detected.zip, names), detected.entries, ctx,
  ),
};

// Detected-but-not-importable archive types → an honest error (NEVER a
// success-shaped {imported:0}). A function so the message can use detection data.
const ARCHIVE_UNSUPPORTED = {
  'mycelium-oversized': (d) => `this Mycelium export's manifest exceeds the inflation cap (${Math.round(d.limitBytes / 1024 / 1024)}MB) — relaunch with MYCELIUM_IMPORT_MAX_JSON_BYTES raised, then retry`,
  linkedin: () => 'LinkedIn export import is not supported yet — nothing was imported.',
  // A vault export nested in a folder: refuse honestly. Falling through to
  // `bundle` reported success while dropping the whole history (FIX 1).
  'mycelium-nested': () => nestedVaultExportError(),
  // Several same-named signature files: say WHICH ambiguity, never guess.
  ambiguous: (d) => d.ambiguity,
};

/**
 * Run an import. The single entry point behind every upload/import transport.
 * @param {{ kind: 'archive'|'loose-file', buffer?: Buffer, zip?: object,
 *   bytes?: Buffer, filename?: string, mimeType?: string, lastModified?: any }} input
 * @param {{ db: object, userId: string, enqueueEnrichment?: Function,
 *   onProgress?: (p:{total:number,processed:number,imported:number,deduped:number,skipped:number,failed:number}) => void,
 *   shouldCancel?: () => boolean }} ctx
 *   `onProgress`/`shouldCancel` are the import-job runner's seam (import-job.js);
 *   only the `bundle` kind (many files, one archive) reports through them today —
 *   the upload routes are synchronous and pass neither. Payload is COUNTS ONLY.
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
  // Original occurrence time (R4-TIMESTAMPS): for an IMAGE, prefer EXIF
  // DateTimeOriginal (when the photo was taken) over the file mtime (the copy
  // moment); for any file, the client mtime beats import-now. Recorded with
  // provenance so a now()-fallback is a countable fact, never a silent stamp.
  const exifDate = isImage ? extractExifDate(bytes) : null;
  const { iso: createdAtIso, provenance: tsProvenance } = deriveCreatedAt([
    ...(exifDate ? [{ value: exifDate, provenance: TS_PROVENANCE.EXIF }] : []),
    { value: input.lastModified, provenance: TS_PROVENANCE.FILE_MTIME },
  ]);
  let caption = null;
  if (isImage) { try { caption = await describeImage({ bytes }); } catch { caption = null; } }
  else if (isAudioType(fileType)) {
    // C4 — auto-transcribe uploaded audio (fire-and-forget; self-gates on a ready
    // Whisper model, so it's a no-op when transcription isn't configured — cost §10).
    // In-process = the app's single vault writer; the transcript fills in async and
    // surfaces in the Media view once done.
    //
    // ⛔ `interactive: false` IS EXPLICIT, NOT A DEFAULT WE INHERITED (D-068, D-001 tripwire).
    // Import transcription is BULK and must stay BULK. runBundle() funnels EVERY audio entry of
    // a zip through this exact line (run-import.js runBundle → runLooseFile), so flipping it to
    // INTERACTIVE would put a 5,000-file audio archive onto the single resident model slot,
    // preempting describe/categorize in a loop — reopening D-001 from the other side. Only the
    // LIVE inbound turn (internal-router /attachment-context) is INTERACTIVE. Nobody is blocked
    // here: this call is fire-and-forget with its result discarded, and a `compute-busy` refusal
    // is recovered by the background transcription drain (transcribe-retry.js). Gate C18 pins it.
    Promise.resolve().then(() => transcribeAttachment(ctx.db, ctx.userId, attachmentId, { interactive: false })).catch(() => {});
  }
  const label = humanizeFilename(filename);
  const msgText = caption
    || (isImage ? (label ? `Image: ${label}` : 'Uploaded image') : (label ? `File: ${label}` : 'Uploaded file'));
  const msg = await captureMessage(ctx.db, {
    userId: ctx.userId, content: msgText, source: 'upload', attachmentId,
    createdAt: createdAtIso,
    metadata: { kind: isImage ? 'image' : 'file', fileName: filename, fileType, captioned: Boolean(caption), ts_provenance: tsProvenance },
  }, ctx.enqueueEnrichment);
  return { importResult: { type: isImage ? 'image' : 'file', attachmentId, messageId: msg?.id || null, captioned: Boolean(caption) } };
}

// ── The `bundle` kind ──────────────────────────────────────────────────────────
// SECURITY, the invariants this path must never break (it is the FIRST importer
// that ENUMERATES archive entries — the AI-export kinds read one known entry):
//   • ZIP-SLIP: an entry name is a lookup key into the archive's own directory,
//     never joined to a filesystem path. The only thing derived from it is
//     `safeEntryBasename()` (separator/traversal/control-stripped, capped), and
//     even that is a LABEL: documents get a validated logical path
//     (document-store validatePath) and attachment bytes get a random-UUID blob
//     name (blob-store putBlob). Bytes stay in memory; nothing is written to disk
//     in plaintext.
//   • BOMBS: entry-count cap (shared), per-entry OBSERVED-byte cap, total
//     OBSERVED-byte cap, and the ratio guard. Observed, not declared — a lying
//     header buys nothing.
//   • WRITERS: every file lands through runLooseFile → saveDocument / putBlob /
//     captureMessage. No new plaintext path, no new crypto boundary.
//   • PROGRESS: counts only. Never a filename, never a path — the activity feed
//     is content-free by contract (verify:import-activity A2).

/** Buffered (JSZip) source for the bundle walk — same shape as the streaming one. */
export async function* readBufferedEntries(zip, names) {
  let total = 0;
  for (const name of names) {
    let read = 0;
    const bytes = await readEntryBytes(zip, name, BUNDLE_MAX_ENTRY_BYTES, { onRead: (n) => { read = n; } });
    // Charge ATTEMPTED inflation, not just accepted bytes (OBSERVED, never
    // declared). An entry that trips the per-entry cap was still inflated up to
    // that cap — CPU we already spent. Charging only what we KEPT let a small
    // archive of refused bombs burn unbounded CPU for free (FIX 2).
    total += read;
    const halted = total > BUNDLE_MAX_TOTAL_BYTES;
    if (bytes === null) { yield { name, skipped: 'oversize', read, ...(halted ? { halted: true } : {}) }; if (halted) return; continue; }
    if (halted) { yield { name, skipped: 'total-cap', halted: true, read }; return; }
    if (bytes.length === 0) { yield { name, skipped: 'empty', read }; continue; }
    yield { name, bytes, read };
  }
}

/**
 * Import every allowlisted entry of a plain archive through the loose-file router.
 * @param {(names:string[]) => AsyncIterable<{name:string,bytes?:Buffer,skipped?:string,halted?:boolean}>} open
 * @param {string[]} entries  allowlisted entry names (from this archive's listing)
 */
async function runBundle(open, entries, ctx) {
  const names = (Array.isArray(entries) ? entries : []).filter(isBundleEntry);
  const planned = names.slice(0, BUNDLE_MAX_FILES);
  let truncated = planned.length < names.length;   // fail-loud: say we stopped short
  let documents = 0, attachments = 0, deduped = 0, skipped = 0, failed = 0, processed = 0;
  // Basename-flattening (safeEntryBasename) can map two distinct entries in
  // different folders (`chapterA/notes.md`, `chapterB/notes.md`) onto one document
  // path (uploads/notes.md) — a SILENT OVERWRITE. Disambiguate the 2nd+ occurrence
  // deterministically (order is the archive's stable listing), so no distinct file
  // is lost AND a re-import maps every entry to the SAME path (idempotent). Only
  // documents key on the name; attachments get a random-UUID blob and never collide.
  const usedDocNames = new Map();
  const uniqueDocName = (name) => {
    const seen = usedDocNames.get(name) || 0;
    usedDocNames.set(name, seen + 1);
    if (seen === 0) return name;
    const dot = name.lastIndexOf('.');
    return dot > 0 ? `${name.slice(0, dot)}-${seen + 1}${name.slice(dot)}` : `${name}-${seen + 1}`;
  };
  // CONTENT-FREE progress: counts and a percent, never a name.
  const emit = () => {
    try { ctx.onProgress?.({ total: planned.length, processed, imported: documents + attachments, deduped, skipped, failed }); }
    catch { /* the mirror must never break the import */ }
  };
  emit();
  for await (const entry of open(planned)) {
    if (ctx.shouldCancel?.()) { truncated = true; break; }
    processed += 1;
    if (entry.skipped || !entry.bytes) {
      skipped += 1;
      if (entry.halted) truncated = true;
      emit();
      if (entry.halted) break;
      continue;
    }
    const base = safeEntryBasename(entry.name);
    if (!base) { skipped += 1; emit(); continue; }   // nothing safe survived → never guess a name
    // A document keys on its name (uploads/<name>) so disambiguate collisions; an
    // attachment gets a random-UUID blob and never collides, so keep its basename.
    const willBeDocument = classifyLooseFile(mimeFromName(base), base) !== 'attachment';
    const filename = willBeDocument ? uniqueDocName(base) : base;
    try {
      const out = await runLooseFile({ kind: 'loose-file', bytes: entry.bytes, filename }, ctx);
      // A re-import of an unchanged document is an idempotent UPDATE at the same
      // path (document-store action='updated'), not a new item — count it as a
      // dedup so a re-run doesn't inflate the "imported" total.
      if (out?.importResult?.type === 'document') {
        if (out.importResult.action === 'updated') deduped += 1; else documents += 1;
      } else attachments += 1;
      // ⚠️ HONEST LIMIT: attachments are NOT idempotent. A document keys on its
      // logical path, so a re-import updates it; an attachment gets a fresh
      // random-UUID blob every time, so re-importing the same zip ADDS A SECOND
      // COPY of every image. Deduping them needs a content-hash column (a
      // migration), so until that lands the UI says so out loud rather than
      // implying a re-run is free (upload-handlers.ts importFiles).
    } catch { failed += 1; /* FAIL-LOUD accounting; never surface file contents */ }
    emit();
  }
  const imported = documents + attachments;
  return {
    type: 'bundle', imported, skipped, deduped, failed, truncated,
    stats: { files: planned.length, documents, attachments, deduped, skipped, failed, truncated },
  };
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

  // Mycelium vault export: IMPORTED only from a ROOT-ANCHORED manifest.json (the
  // vault importer resolves attachments/agent files by root-relative paths — see
  // the note in import-parsers.js detectExportType). It's the only format needing
  // the whole archive in memory → the JSZip importer.
  if (names.includes('manifest.json')) {
    const buf = Buffer.isBuffer(src) ? src : await fsp.readFile(src);
    return dispatchPreloadedZip(await JSZip.loadAsync(buf), ctx);
  }
  // …but a NESTED vault export is DETECTED and honestly REFUSED, never imported
  // as a `bundle`. Bundling it returns {type:'bundle', imported:N} — a couple of
  // loose media files — while the entire message/document history is dropped with
  // no error, on the one path where the user is restoring a backup (FIX 1).
  if (await hasNestedVaultManifest((n) => readOneEntryText(src, n), names)) {
    return { error: nestedVaultExportError() };
  }
  // Claude / ChatGPT — the gig-scale case: stream conversations.json. Resolved by
  // BASENAME AT ANY DEPTH, so a re-zipped / one-folder-deep export detects like a
  // root one; two same-named ones ⇒ an honest ambiguity error, never a guess.
  const convHit = findEntryByBasename(names, 'conversations.json');
  if (convHit?.ambiguous) return { error: ambiguousEntryError('conversations.json', convHit.count) };
  if (convHit) {
    let stream;
    try { stream = await openEntryStream(src, convHit.name, { maxEntries: STREAM_MAX_ENTRIES, maxBytes: STREAM_MAX_JSON_BYTES }); }
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
  if (names.some((n) => /connections\.csv|messages\.csv/i.test(n))) return { error: ARCHIVE_UNSUPPORTED.linkedin() };
  // No recognized export → a plain BUNDLE of documents/media. A zip of markdown
  // used to dead-end here ("use the folder importer"); it now imports.
  const bundleNames = names.filter(isBundleEntry);
  if (bundleNames.length) {
    return { importResult: await runBundle(
      (planned) => readEntriesSequential(src, planned, {
        maxEntries: STREAM_MAX_ENTRIES,
        maxEntryBytes: BUNDLE_MAX_ENTRY_BYTES,
        maxTotalBytes: BUNDLE_MAX_TOTAL_BYTES,
      }),
      bundleNames, ctx,
    ) };
  }
  return { error: UNRECOGNIZED_EXPORT };
}

// Read a BOUNDED PREFIX of one entry as text, for detection probes only. A vault
// manifest can be hundreds of MB, so we never buffer the whole thing: we pull the
// head (constant memory) and let `isVaultManifest` decide on parse-or-marker.
// Returns null when the entry is absent/unreadable (a bomb-refused entry included
// — a decompression bomb is not a vault export).
const MANIFEST_PROBE_BYTES = Number(process.env.MYCELIUM_IMPORT_MANIFEST_PROBE_BYTES) || 8 * 1024 * 1024;
async function readOneEntryText(src, name) {
  let stream;
  // Pass a FINITE maxBytes so the streaming layer-2 observed-byte counter is LIVE
  // on this path — not Infinity. It's the generous absolute cap (not the 8MB head
  // cap): the manual head loop below is the primary bound (destroys at
  // MANIFEST_PROBE_BYTES), and layer-0's ratio guard is what actually stops a bomb,
  // so this is the defense-in-depth backstop that survives a refactor dropping the
  // manual loop. Deliberately NOT MANIFEST_PROBE_BYTES: layer-1's declared-size
  // reject would then FAIL-OPEN — a legit hundreds-of-MB nested vault manifest
  // (whose marker sits in the head) would be refused here, fall through to `bundle`
  // and silently drop the history — the exact bug this PR closes.
  try { stream = await openEntryStream(src, name, { maxEntries: STREAM_MAX_ENTRIES, maxBytes: STREAM_MAX_JSON_BYTES }); }
  catch { return null; }                                   // ratio-bomb / unreadable
  if (!stream) return null;
  const chunks = [];
  let n = 0;
  try {
    for await (const chunk of stream) {
      chunks.push(chunk);
      n += chunk.length;
      if (n >= MANIFEST_PROBE_BYTES) { stream.destroy(); break; }
    }
  } catch { /* truncated read is fine — we only need the head */ }
  // NOTE (QA6 P7 review round-2 #3, low severity): only the first MANIFEST_PROBE_BYTES
  // are returned, so `isVaultManifest` can miss a nested vault whose `"format"`
  // marker sits beyond the 8MB head — it would then bundle instead of refuse.
  // Genuine exports emit the format marker at the TOP of the manifest, and the
  // archive layout is attacker-controlled anyway, so this is accepted, not fixed:
  // raising the head cap trades a real memory bound for a marginal case.
  return chunks.length ? Buffer.concat(chunks).toString('utf8') : null;
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
