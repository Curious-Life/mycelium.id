// Shared "restore" landing core — the ONE place export-family importers
// (full-export, vault-import, recent-export) land rows. Design:
// the unified-import architecture.
//
// A restore is NOT a capture: it faithfully re-lands the owner's own exported
// rows, so it preserves the original id + created_at + source verbatim, dedups
// by id (idempotent re-import), and does NOT apply the agent-capture consent
// gate (this is an authorized restore of the user's own data). It reuses
// restoreTable() (vault-import.js) unchanged — column-intersect against the live
// schema, force user_id + scope='personal', null embedding_768 (V1 re-embeds),
// INSERT OR IGNORE on preserved ids, skip content-and-attachment-empty messages.
//
// Chunked + cancellable + progress-emitting so a large restore is a background
// job (never one giant transaction, never a blocked request). After the rows
// land, a single best-effort enrichment nudge kicks the drainer, which processes
// the whole nlp_processed=0 backlog → the restored rows become searchable +
// mindscape'd (restoreTable nulled their embeddings on purpose).

import { restoreTable } from './vault-import.js';

const CHUNK = 500;
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const zero = () => ({ attempted: 0, inserted: 0, deduped: 0, failed: 0, skippedEmpty: 0, inferredNow: 0, capped: 0, tableMissing: false });
const add = (a, b) => { for (const k of ['attempted', 'inserted', 'deduped', 'failed', 'skippedEmpty', 'inferredNow', 'capped']) a[k] += b[k] || 0; if (b.tableMissing) a.tableMissing = true; return a; };

/**
 * Land exported documents + messages (+ optional attachments-with-bytes) into the
 * open vault via restoreTable. Preserves id/created_at/source; dedup by id.
 *
 * @param {object} db
 * @param {object} data
 * @param {object[]} [data.documents]   raw exported document rows
 * @param {object[]} [data.messages]    raw exported message rows
 * @param {Array<{row:object, bytes?:Buffer|null}>} [data.attachments]
 *        exported attachment rows; `bytes` present → blob stored + row landed,
 *        absent → skipped and counted as missing (the export lacked the binary).
 * @param {object} opts
 * @param {string} opts.userId
 * @param {(id:string)=>void} [opts.enqueueEnrichment]
 * @param {(p:object)=>void} [opts.onProgress]
 * @param {()=>boolean} [opts.shouldCancel]
 * @param {(bytes:Buffer, o:object)=>Promise<{path:string}>} [opts.putBlob]  injectable for tests
 * @returns {Promise<{documents:object, messages:object, attachments:{imported:number,deduped:number,missing:number,failed:number}, enrichNudged:boolean, cancelled:boolean, total:number, processed:number}>}
 */
export async function restoreRows(db, data = {}, opts = {}) {
  const { userId, enqueueEnrichment, onProgress, shouldCancel } = opts;
  if (!db?.rawQuery) throw new TypeError('restoreRows: db.rawQuery required');
  if (typeof userId !== 'string' || !userId) throw new Error('restoreRows: userId required (fail-closed)');

  const documents = Array.isArray(data.documents) ? data.documents : [];
  const messages = Array.isArray(data.messages) ? data.messages : [];
  const attachments = Array.isArray(data.attachments) ? data.attachments : [];

  const summary = {
    documents: zero(), messages: zero(),
    attachments: { imported: 0, deduped: 0, missing: 0, failed: 0 },
    enrichNudged: false, cancelled: false,
    total: documents.length + messages.length, processed: 0,
  };
  const emit = () => { try { onProgress?.({ total: summary.total, processed: summary.processed, imported: summary.documents.inserted + summary.messages.inserted, deduped: summary.documents.deduped + summary.messages.deduped, skipped: summary.messages.skippedEmpty, failed: summary.documents.failed + summary.messages.failed }); } catch { /* never break the job */ } };
  emit();

  // 1. Documents first (messages may reference them; either order is fine for id-dedup).
  for (const part of chunk(documents, CHUNK)) {
    if (shouldCancel?.()) { summary.cancelled = true; break; }
    add(summary.documents, await restoreTable(db, 'documents', part, { userId }));
    summary.processed += part.length; emit();
  }

  // 2. Attachments with bytes → blob + row. Rows whose bytes weren't exported are
  //    reported missing (the message row still lands in step 3; the media is just
  //    unavailable). Best-effort; a blob failure never aborts the restore.
  if (!summary.cancelled && attachments.length) {
    const putBlob = opts.putBlob || (await import('./blob-store.js')).putBlob;
    for (const { row, bytes } of attachments) {
      if (shouldCancel?.()) { summary.cancelled = true; break; }
      if (!bytes) { summary.attachments.missing += 1; continue; }
      try {
        const ext = typeof row?.file_name === 'string' && row.file_name.includes('.') ? `.${row.file_name.split('.').pop()}` : '';
        const { path } = await putBlob(bytes, { userId, ext });
        const r = await restoreTable(db, 'attachments', [{ ...row, local_path: path, r2_key: null, stream_uid: null }], { userId });
        summary.attachments.imported += r.inserted; summary.attachments.deduped += r.deduped; summary.attachments.failed += r.failed;
      } catch { summary.attachments.failed += 1; }
    }
  }

  // 3. Messages.
  for (const part of chunk(messages, CHUNK)) {
    if (summary.cancelled || shouldCancel?.()) { summary.cancelled = summary.cancelled || !!shouldCancel?.(); break; }
    add(summary.messages, await restoreTable(db, 'messages', part, { userId }));
    summary.processed += part.length; emit();
  }

  // 4. One best-effort enrichment nudge — the drainer then processes the whole
  //    nlp_processed=0 backlog (embeddings + search), so restored rows become
  //    searchable. A missing/failed nudge is harmless: the durable queue remains.
  if (summary.messages.inserted > 0 && typeof enqueueEnrichment === 'function') {
    const anyId = messages.find((m) => m && m.id)?.id;
    if (anyId) { try { enqueueEnrichment(anyId); summary.enrichNudged = true; } catch { /* durable queue still drains */ } }
  }

  emit();
  return summary;
}
