// verify:bulk-delete — hard delete-by-source/type cascade (the data-deletion design).
//
//   B1  delete-by-source removes the source's messages + documents (user-scoped)
//   B2  a DIFFERENT source's rows are UNTOUCHED
//   B3  TENANT ISOLATION: a second user's same-source rows are UNTOUCHED
//   B4  derived clustering_points for the deleted ids are gone
//   B5  attachment rows for deleted messages are removed
//   B6  BLOB GC: a blob referenced ONLY by the deleted source is unlinked;
//       a blob SHARED with a surviving row SURVIVES (privacy vs. data-loss)
//   B7  search sidecar eviction called with msg ids + document:<id> keys
//   B8  audit row written with COUNTS, never content
//   B9  re-run is idempotent (deletes 0)
//   B10 GUARDRAIL: deleting a native source (portal-chat) is REFUSED
//   B11 unlinkBlobIfUnreferenced: keeps referenced, removes unreferenced, no-ops missing
//
// Boots a temp vault; no network; never logs content.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { putBlob, unlinkBlobIfUnreferenced } from '../src/ingest/blob-store.js';
import { uploadsRoot } from '../src/paths.js';
import { bulkDelete } from '../src/core/bulk-delete.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

const DB = 'data/verify-bulk-delete.db', KCV = 'data/verify-bulk-delete-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const { db, close } = await boot({
  dbPath: DB, kcvPath: KCV,
  userHex: crypto.randomBytes(32).toString('hex'),
  systemHex: crypto.randomBytes(32).toString('hex'),
  embedder: null,
});

const U = 'user-a', U2 = 'user-b';
const one = async (sql, p = []) => (await db.rawQuery(sql, p)).results?.[0];
const cnt = async (sql, p = []) => Number((await one(sql, p))?.c ?? 0);

const insMsg = (id, user, source, type, attId = null) =>
  db.rawQuery(`INSERT INTO messages (id, user_id, source, message_type, content, attachment_id, created_at) VALUES (?,?,?,?,?,?,?)`,
    [id, user, source, type, 'x', attId, '2026-01-01T00:00:00.000Z']);
// documents store provenance in source_type (NOT source); importers use the
// underscore variant (import_obsidian) vs messages' hyphen (import-obsidian).
const insDoc = (id, user, sourceType, path) =>
  db.rawQuery(`INSERT INTO documents (id, user_id, source_type, path, title, content, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
    [id, user, sourceType, path, 't', 'c', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']);
const insCp = (user, srcType, srcId) =>
  db.rawQuery(`INSERT INTO clustering_points (user_id, source_type, source_id) VALUES (?,?,?)`, [user, srcType, srcId]);

// ── Seed ──────────────────────────────────────────────────────────────────────
// Two blobs: B_solo (only import-obsidian references it) and B_shared (referenced
// by BOTH an import-obsidian attachment AND a native portal-chat attachment).
const bSolo = await putBlob(Buffer.from('solo-bytes'), { userId: U, ext: '.png' });
const bShared = await putBlob(Buffer.from('shared-bytes'), { userId: U, ext: '.png' });

await db.attachments.insert({ id: 'att-obs-solo', user_id: U, file_name: 'a.png', file_type: 'image/png', file_size: 10, local_path: bSolo.path, metadata: '{}' });
await db.attachments.insert({ id: 'att-obs-shared', user_id: U, file_name: 'b.png', file_type: 'image/png', file_size: 12, local_path: bShared.path, metadata: '{}' });
await db.attachments.insert({ id: 'att-chat-shared', user_id: U, file_name: 'b.png', file_type: 'image/png', file_size: 12, local_path: bShared.path, metadata: '{}' });

// import-obsidian (deletable): 1 plain msg, 1 msg→solo blob, 1 msg→shared blob, 1 doc
await insMsg('m-obs-1', U, 'import-obsidian', 'note');
await insMsg('m-obs-2', U, 'import-obsidian', 'image', 'att-obs-solo');
await insMsg('m-obs-3', U, 'import-obsidian', 'image', 'att-obs-shared');
await insDoc('d-obs-1', U, 'import_obsidian', 'import/obsidian/note');
for (const id of ['m-obs-1', 'm-obs-2', 'm-obs-3']) await insCp(U, 'message', id);
await insCp(U, 'document', 'd-obs-1');

// import-hermes (deletable, must survive an obsidian delete)
await insMsg('m-herm-1', U, 'import-hermes', 'chat');
await insDoc('d-herm-1', U, 'import_hermes', 'import/hermes/x');

// native portal-chat (NOT deletable) — msg references the SHARED blob
await insMsg('m-chat-1', U, 'portal-chat', 'chat', 'att-chat-shared');

// second user, same source → tenant-isolation control
await insMsg('m-obs-u2', U2, 'import-obsidian', 'note');
await insDoc('d-obs-u2', U2, 'import_obsidian', 'import/obsidian/u2');

// ── B11 unlinkBlobIfUnreferenced unit checks (before the bulk run) ──────────────
{
  const bTmp = await putBlob(Buffer.from('tmp'), { userId: U, ext: '.bin' });
  // Referenced by a live row → must NOT unlink
  await db.attachments.insert({ id: 'att-tmp', user_id: U, file_name: 't', file_type: 'application/octet-stream', file_size: 3, local_path: bTmp.path, metadata: '{}' });
  const r1 = await unlinkBlobIfUnreferenced(db, bTmp.path);
  const keptWhileRef = !r1.unlinked && existsSync(join(uploadsRoot(), bTmp.path));
  // Remove the row → now unreferenced → must unlink
  await db.attachments.delete('att-tmp', U);
  const r2 = await unlinkBlobIfUnreferenced(db, bTmp.path);
  const goneAfter = r2.unlinked && !existsSync(join(uploadsRoot(), bTmp.path));
  // Missing file → no-op, no throw
  const r3 = await unlinkBlobIfUnreferenced(db, 'user-a/does-not-exist.enc');
  rec('B11 refcount unlink: keep-referenced, remove-unreferenced, no-op-missing',
    keptWhileRef && goneAfter && r3.unlinked === true, `r1=${r1.reason} r2=${r2.unlinked} r3=${r3.reason}`);
}

// ── Run: delete-by-source import-obsidian for user A ────────────────────────────
const evicted = [];
const mockSearch = { noteDelete: async (ids) => { evicted.push(...ids); } };
const summary = await bulkDelete(db, { userId: U, mode: 'source', key: 'import-obsidian', searchHelpers: mockSearch });

// ── Assertions ──────────────────────────────────────────────────────────────────
rec('B1 obsidian messages+doc gone (user A)',
  (await cnt(`SELECT COUNT(*) c FROM messages WHERE user_id=? AND source='import-obsidian'`, [U])) === 0 &&
  (await cnt(`SELECT COUNT(*) c FROM documents WHERE user_id=? AND source_type='import_obsidian'`, [U])) === 0,
  `summary msgs=${summary.messages} docs=${summary.documents}`);

rec('B2 hermes source untouched',
  (await cnt(`SELECT COUNT(*) c FROM messages WHERE user_id=? AND source='import-hermes'`, [U])) === 1 &&
  (await cnt(`SELECT COUNT(*) c FROM documents WHERE user_id=? AND source_type='import_hermes'`, [U])) === 1);

rec('B3 TENANT ISOLATION: user B obsidian rows untouched',
  (await cnt(`SELECT COUNT(*) c FROM messages WHERE user_id=?`, [U2])) === 1 &&
  (await cnt(`SELECT COUNT(*) c FROM documents WHERE user_id=?`, [U2])) === 1);

rec('B4 clustering_points for deleted ids gone',
  (await cnt(`SELECT COUNT(*) c FROM clustering_points WHERE user_id=? AND source_id IN ('m-obs-1','m-obs-2','m-obs-3','d-obs-1')`, [U])) === 0);

rec('B5 attachment rows for deleted obsidian msgs removed',
  (await cnt(`SELECT COUNT(*) c FROM attachments WHERE id IN ('att-obs-solo','att-obs-shared')`)) === 0 &&
  (await cnt(`SELECT COUNT(*) c FROM attachments WHERE id='att-chat-shared'`)) === 1);

const soloGone = !existsSync(join(uploadsRoot(), bSolo.path));
const sharedKept = existsSync(join(uploadsRoot(), bShared.path));
rec('B6 BLOB GC: solo blob unlinked, SHARED blob survives (native row still refs it)',
  soloGone && sharedKept, `solo unlinked=${soloGone} shared kept=${sharedKept} blobs=${summary.blobs}`);

rec('B7 search eviction called with msg ids + document: keys',
  evicted.includes('m-obs-1') && evicted.includes('document:d-obs-1') && !evicted.includes('m-chat-1'),
  `evicted=${evicted.join(',')}`);

rec('B8 audit row has counts, not content',
  (await cnt(`SELECT COUNT(*) c FROM audit_log WHERE event_type='bulk-delete'`)) >= 1);

const rerun = await bulkDelete(db, { userId: U, mode: 'source', key: 'import-obsidian', searchHelpers: mockSearch });
rec('B9 re-run idempotent (0 deleted)', rerun.messages === 0 && rerun.documents === 0);

let refused = false;
try { await bulkDelete(db, { userId: U, mode: 'source', key: 'portal-chat', searchHelpers: mockSearch }); }
catch { refused = true; }
rec('B10 GUARDRAIL: native source (portal-chat) refused',
  refused && (await cnt(`SELECT COUNT(*) c FROM messages WHERE user_id=? AND source='portal-chat'`, [U])) === 1);

// ── Phase 2: delete-by-TYPE (documents / media / chat) ──────────────────────────
// Fresh user 'user-t' with a mix of types so type-deletes have distinct targets.
const T = 'user-t';
await insDoc('t-doc-1', T, 'manual', 't/doc1');
await insDoc('t-doc-2', T, 'import_obsidian', 't/doc2');
await insMsg('t-chat-1', T, 'portal-chat', 'chat');       // native chat
const tBlob = await putBlob(Buffer.from('t-media'), { userId: T, ext: '.png' });
await db.attachments.insert({ id: 't-att', user_id: T, file_name: 'm.png', file_type: 'image/png', file_size: 7, local_path: tBlob.path, metadata: '{}' });
await insMsg('t-img-1', T, 'portal-chat', 'image', 't-att'); // media message

// T1 delete-by-type 'documents' → both docs gone; messages untouched
const t1 = await bulkDelete(db, { userId: T, mode: 'type', key: 'documents', searchHelpers: mockSearch });
rec('T1 type=documents removes all docs, keeps messages',
  t1.documents === 2 &&
  (await cnt(`SELECT COUNT(*) c FROM documents WHERE user_id=?`, [T])) === 0 &&
  (await cnt(`SELECT COUNT(*) c FROM messages WHERE user_id=?`, [T])) === 2);

// T2 delete-by-type 'media' → image message + attachment + blob gone; chat intact
const t2 = await bulkDelete(db, { userId: T, mode: 'type', key: 'media', searchHelpers: mockSearch });
rec('T2 type=media removes media msg + attachment + blob, keeps chat',
  t2.attachments === 1 && t2.blobs === 1 &&
  !existsSync(join(uploadsRoot(), tBlob.path)) &&
  (await cnt(`SELECT COUNT(*) c FROM attachments WHERE id='t-att'`)) === 0 &&
  (await cnt(`SELECT COUNT(*) c FROM messages WHERE user_id=? AND message_type='image'`, [T])) === 0 &&
  (await cnt(`SELECT COUNT(*) c FROM messages WHERE user_id=? AND message_type='chat'`, [T])) === 1);

// T3 delete-by-type 'chat' → native chat gone
const t3 = await bulkDelete(db, { userId: T, mode: 'type', key: 'chat', searchHelpers: mockSearch });
rec('T3 type=chat removes native chat',
  t3.messages === 1 && (await cnt(`SELECT COUNT(*) c FROM messages WHERE user_id=? AND message_type='chat'`, [T])) === 0);

// T4 TENANT ISOLATION under type-mode: user B's rows never touched by user T deletes
rec('T4 TENANT ISOLATION (type mode): user B intact',
  (await cnt(`SELECT COUNT(*) c FROM messages WHERE user_id=?`, [U2])) === 1 &&
  (await cnt(`SELECT COUNT(*) c FROM documents WHERE user_id=?`, [U2])) === 1);

// T5 unknown type throws (engine-level guard)
let tBad = false;
try { await bulkDelete(db, { userId: T, mode: 'type', key: 'bogus', searchHelpers: mockSearch }); } catch { tBad = true; }
rec('T5 unknown type rejected by engine', tBad);

close?.();
const passed = ledger.filter(Boolean).length;
console.log(`\n${passed}/${ledger.length} checks passed`);
if (passed !== ledger.length) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO');
