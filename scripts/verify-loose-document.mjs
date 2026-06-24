// Verify — a loose (non-archive) file imports correctly through the spine:
// a .md/.txt becomes a readable LIBRARY DOCUMENT (was: an opaque attachment),
// while an image / unknown binary stays an attachment + linked message, and a
// document whose text can't be extracted falls back to attachment (no data loss).
//
//   LD1 .md + lastModified → document at uploads/<name>, content kept, created_at = mtime
//   LD2 .txt, no mtime     → document, created_at ≈ now (inferred-now fallback)
//   LD3 binary (.bin)      → attachment (type 'file', attachmentId), NO document row
//   LD4 fake .pdf (garbage)→ extraction yields nothing → attachment fallback (bytes kept)
//   LD5 re-upload same .md → created_at IMMUTABLE (Phase-1 Fix A), content updated
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>.

import crypto from 'node:crypto';
import { rmSync, mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrate.js';
import { boot } from '../src/index.js';
import { runImport } from '../src/ingest/run-import.js';

const DB = 'data/verify-loose-doc.db';
const KCV = 'data/verify-loose-doc-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch { /* */ } }
mkdirSync('data', { recursive: true });
{ const seed = new Database(DB); applyMigrations(seed); seed.close(); }

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex() });
const userId = 'verify-loose-user';
const ctx = { db, userId, enqueueEnrichment: null };
const raw = new Database(DB, { readonly: true });
const docRow = (path) => raw.prepare('select created_at, content_hash from documents where user_id=? and path=?').get(userId, path);
const loose = (filename, mimeType, body, lastModified) =>
  runImport({ kind: 'loose-file', bytes: Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'), filename, mimeType, lastModified }, ctx);

// LD1 — markdown with a mtime → document, content kept, created_at = mtime.
const r1 = await loose('note.md', 'text/markdown', '# Title\nhello world body', '2024-03-09T10:00:00.000Z');
const d1 = docRow('uploads/note.md');
rec('LD1 .md → document at uploads/note.md, created_at = file mtime',
  r1.importResult?.type === 'document' && r1.importResult?.path === 'uploads/note.md' && d1?.created_at === '2024-03-09T10:00:00.000Z',
  `${JSON.stringify(r1.importResult)} created_at=${d1?.created_at}`);

// LD2 — txt, no mtime → document, created_at ≈ now (inferred-now).
const r2 = await loose('plan.txt', 'text/plain', 'just some notes');
const d2 = docRow('uploads/plan.txt');
const drift = d2 ? Math.abs(Date.now() - Date.parse(d2.created_at)) : Infinity;
rec('LD2 .txt (no mtime) → document, created_at ≈ now',
  r2.importResult?.type === 'document' && drift < 10_000, `created_at=${d2?.created_at} drift=${drift}ms`);

// LD3 — binary (.bin) → attachment, NOT a document.
const r3 = await loose('data.bin', 'application/octet-stream', Buffer.from([0, 1, 2, 3, 255, 254]));
rec('LD3 binary → attachment (type file + attachmentId), no document row',
  (r3.importResult?.type === 'file') && !!r3.importResult?.attachmentId && !docRow('uploads/data.bin'),
  JSON.stringify(r3.importResult));

// LD4 — fake pdf (garbage bytes) → extraction null → attachment fallback (no loss).
const r4 = await loose('broken.pdf', 'application/pdf', Buffer.from('not really a pdf'));
rec('LD4 unextractable .pdf → attachment fallback (bytes preserved)',
  (r4.importResult?.type === 'file') && !!r4.importResult?.attachmentId && !docRow('uploads/broken.pdf'),
  JSON.stringify(r4.importResult));

// LD5 — re-upload same .md with a NEWER mtime → created_at immutable (Fix A).
const r5 = await loose('note.md', 'text/markdown', '# Title\nEDITED body', '2026-06-19T00:00:00.000Z');
const d5 = docRow('uploads/note.md');
rec('LD5 re-upload keeps original created_at (immutable)',
  r5.importResult?.type === 'document' && d5?.created_at === '2024-03-09T10:00:00.000Z' && d5?.content_hash !== d1?.content_hash,
  `created_at=${d5?.created_at} contentChanged=${d5?.content_hash !== d1?.content_hash}`);

const ok = ledger.every(Boolean);
console.log(`\nVERDICT: ${ok ? 'GO' : 'NO-GO'} — loose files: .md/.txt → document, binary → attachment, created_at correct + immutable`);
raw.close();
await close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch { /* */ } }
console.log(`EXIT=${ok ? 0 : 1}`);
process.exit(ok ? 0 : 1);
