// Importer for the canonical repo's "mycelium-recent-export" bundle — a DECRYPTED
// time-sliced export (e.g. last 30 days). Layout (manifest.json §layout):
//   manifest.json     { format:'mycelium-recent-export', window, counts, … }
//   messages.json     top-level ARRAY, decrypted, ordered by created_at ASC
//   documents.json    top-level ARRAY, decrypted (content + summary)
//   attachments/<id>/<file>   R2 binaries — OFTEN ABSENT (the exporter fails
//                             closed on R2 fetch errors; counts.attachmentsFailed)
//   agents/           agent on-disk files (not ingested here)
//
// This is a RESTORE (not a capture): rows carry their original id + created_at +
// source, so they land through restore-core (restoreTable), which preserves all
// three, dedups by id (idempotent re-import), and does NOT apply the consent
// gate. Contrast full-export-import.js (which wants a `db/*.ndjson` layout +
// format 'mycelium-full-export'); this reads the two top-level JSON arrays.
//
// Attachments: message/document text (incl. voice transcriptions) is preserved
// regardless; when the export lacks the binary (the common case) the linked
// media is simply unavailable and REPORTED as `attachmentsMissing` — never
// silently pretended-present.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { restoreRows } from './restore-core.js';

const ACCEPTED_FORMATS = new Set(['mycelium-recent-export']);

async function readJsonArray(file) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

/**
 * Import a decrypted mycelium-recent-export directory into the open V1 vault.
 * @param {object} db
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.dirPath                already realpath-confined by the route
 * @param {(id:string)=>void} [opts.enqueueEnrichment]
 * @param {(p:object)=>void} [opts.onProgress]
 * @param {()=>boolean} [opts.shouldCancel]
 */
export async function importRecentExport(db, { userId, dirPath, enqueueEnrichment, onProgress, shouldCancel } = {}) {
  if (!db?.rawQuery) throw new TypeError('importRecentExport: db.rawQuery required');
  if (typeof userId !== 'string' || !userId) throw new Error('importRecentExport: userId required');
  if (typeof dirPath !== 'string' || !dirPath) throw new Error('importRecentExport: dirPath required');

  // Resolve the bundle root (accept a wrapper subdir holding manifest.json).
  let root = dirPath;
  if (!(await fs.stat(path.join(root, 'manifest.json')).catch(() => null))) {
    const subs = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const s of subs) {
      if (s.isDirectory() && await fs.stat(path.join(root, s.name, 'manifest.json')).catch(() => null)) { root = path.join(root, s.name); break; }
    }
  }

  const manifestPath = path.join(root, 'manifest.json');
  const manifestRaw = await fs.readFile(manifestPath, 'utf8').catch(() => null);
  if (manifestRaw == null) { const e = new Error('no manifest.json — not a mycelium-recent-export bundle'); e.code = 'invalid_bundle'; throw e; }
  let manifest; try { manifest = JSON.parse(manifestRaw); } catch { manifest = {}; }
  if (!ACCEPTED_FORMATS.has(manifest.format)) {
    const e = new Error(`unexpected bundle format: ${manifest.format} (expected mycelium-recent-export)`); e.code = 'invalid_bundle'; throw e;
  }

  const messages = await readJsonArray(path.join(root, 'messages.json'));
  const documents = await readJsonArray(path.join(root, 'documents.json'));

  // Attachments: attach bytes ONLY when the export actually shipped the binary.
  // The manifest links each media row via a per-id folder; when the fetch failed
  // (counts.attachmentsFailed) that folder is absent → bytes:null → reported missing.
  const attRows = [];
  const attDir = path.join(root, 'attachments');
  const haveAttDir = !!(await fs.stat(attDir).catch(() => null));
  // Reference set: message rows carrying an attachment_id (documents may too via metadata).
  const referenced = messages.filter((m) => m && m.attachment_id).map((m) => ({ id: m.attachment_id, file_name: null }));
  // SECURITY: attachment_id comes from the (untrusted) bundle and indexes a
  // sub-folder of attDir. A crafted id with a path separator / traversal would
  // let readdir+readFile escape attDir and pull an arbitrary local file INTO the
  // vault (a local-file-read). Only a strict id segment (no '/', '\', '..', '.')
  // is ever joined; anything else → treated as missing bytes, never read.
  const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
  for (const ref of referenced) {
    let bytes = null;
    if (haveAttDir && typeof ref.id === 'string' && SAFE_ID.test(ref.id)) {
      try {
        const folder = path.join(attDir, ref.id);
        const files = (await fs.readdir(folder).catch(() => [])).filter((f) => f && !f.includes('/') && !f.includes('\\') && f !== '.' && f !== '..');
        if (files.length) { bytes = await fs.readFile(path.join(folder, files[0])); ref.file_name = files[0]; }
      } catch { bytes = null; }
    }
    attRows.push({ row: { id: String(ref.id), user_id: userId, file_name: ref.file_name || String(ref.id) }, bytes });
  }

  const restore = await restoreRows(db, { documents, messages, attachments: attRows }, { userId, enqueueEnrichment, onProgress, shouldCancel });

  const imported = restore.documents.inserted + restore.messages.inserted;
  const deduped = restore.documents.deduped + restore.messages.deduped;
  const failed = restore.documents.failed + restore.messages.failed;
  return {
    format: manifest.format,
    window: manifest.window ?? null,
    imported, deduped, failed,
    skipped: restore.messages.skippedEmpty,
    inferredNow: restore.documents.inferredNow + restore.messages.inferredNow, // should be 0 (rows carry created_at)
    documents: restore.documents, messages: restore.messages,
    attachmentsMissing: restore.attachments.missing,   // bytes weren't in the bundle
    attachmentsImported: restore.attachments.imported,
    cancelled: restore.cancelled,
    // Human-facing note so the missing media is never a silent surprise.
    note: restore.attachments.missing > 0 ? `${restore.attachments.missing} attachment(s) had no binary in the export (text/transcriptions imported; media unavailable).` : undefined,
  };
}
