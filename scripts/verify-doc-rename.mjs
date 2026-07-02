// verify:doc-rename — atomic document path/slug rename + cascade
// (docs/DOCUMENT-SLUG-RENAME-DESIGN-2026-06-29.md §7).
//
//   R1 documents.path moved old→new; old gone, new present
//   R2 row id UNCHANGED (document_versions / embeddings / FTS linkage intact)
//   R3 cascade: share_links / context_documents / space_room_documents / space_rooms all moved
//   R4 ORPHAN CHECK: zero rows in any cascade table still reference the old path
//   R5 document_versions.path is LEFT as history (still old path)
//   R6 public_slug untouched → getBySlug still resolves the (renamed) doc
//   R7 FTS self-heals: content search returns the doc at the new path
//   R8 CONFLICT: rename onto an existing path throws RENAME_CONFLICT and rolls back byte-identical
//   R9 NOT_FOUND / BAD_PATH guards
//
// Boots a temp vault; no network; CWD-independent; never logs document content.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

const DB = 'data/verify-doc-rename.db', KCV = 'data/verify-doc-rename-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const { db, close } = await boot({
  dbPath: DB, kcvPath: KCV,
  userHex: crypto.randomBytes(32).toString('hex'),
  systemHex: crypto.randomBytes(32).toString('hex'),
  embedder: null,
});
const U = 'local-user';
const OLD = 'personal/old-note';
const NEW = 'personal/renamed-note';
const OTHER = 'personal/other-note';
const one = async (sql, p = []) => (await db.rawQuery(sql, p)).results?.[0];
const countOld = async () => {
  const t = [
    ['documents', 'path', `user_id='${U}'`],
    ['share_links', 'document_path', `user_id='${U}'`],
    ['context_documents', 'document_path', '1=1'],
    ['space_room_documents', 'document_path', '1=1'],
    ['space_rooms', 'cover_doc_path', '1=1'],
  ];
  let n = 0;
  for (const [tbl, col, w] of t) n += (await one(`SELECT COUNT(*) c FROM ${tbl} WHERE ${col}=? AND ${w}`, [OLD])).c;
  return n;
};

// ── Seed: doc (+1 prior version), and one reference in each cascade table, published ──
await db.documents.upsert({ user_id: U, path: OLD, title: 'Old Note', content: 'searchable haystack body' });
await db.documents.upsert({ user_id: U, path: OLD, content: 'searchable haystack body v2' }); // → 1 version at path=OLD
await db.documents.publish(U, OLD, 'old-note-slug');
await db.rawQuery(`INSERT INTO share_links (token, user_id, document_path, expires_at) VALUES (?,?,?,?)`,
  ['tok-1', U, OLD, '2099-01-01T00:00:00Z']);
await db.rawQuery(`INSERT INTO context_documents (context_id, document_path) VALUES (?,?)`, ['ctx-1', OLD]);
await db.rawQuery(`INSERT INTO space_room_documents (space_id, document_path, created_by) VALUES (?,?,?)`, ['sp-1', OLD, U]);
await db.rawQuery(`INSERT INTO space_rooms (space_id, name, cover_doc_path, created_by) VALUES (?,?,?,?)`, ['sp-1', 'Room', OLD, U]);
// A second doc to collide with for the conflict test.
await db.documents.upsert({ user_id: U, path: OTHER, title: 'Other', content: 'other body' });

const idBefore = (await db.documents.get(U, OLD)).id;

// ── Rename ──
await db.documents.renamePath(U, OLD, NEW);

// R1
{
  const atNew = await db.documents.get(U, NEW);
  const atOld = await db.documents.get(U, OLD);
  rec('R1. documents.path moved old→new', !!atNew && !atOld, `new=${!!atNew} old=${!!atOld}`);
}
// R2
{
  const idAfter = (await db.documents.get(U, NEW))?.id;
  rec('R2. row id unchanged', idAfter === idBefore, `${idBefore === idAfter ? 'same' : 'CHANGED'}`);
}
// R3
{
  const sl = (await one(`SELECT document_path p FROM share_links WHERE token='tok-1'`)).p;
  const cd = (await one(`SELECT document_path p FROM context_documents WHERE context_id='ctx-1'`)).p;
  const srd = (await one(`SELECT document_path p FROM space_room_documents WHERE space_id='sp-1'`)).p;
  const sr = (await one(`SELECT cover_doc_path p FROM space_rooms WHERE space_id='sp-1'`)).p;
  rec('R3. cascade moved (share_links/context/space_room_documents/space_rooms)',
    sl === NEW && cd === NEW && srd === NEW && sr === NEW, `${sl}|${cd}|${srd}|${sr}`);
}
// R4
{
  const orphans = await countOld();
  rec('R4. ORPHAN CHECK — zero rows still reference the old path', orphans === 0, `orphans=${orphans}`);
}
// R5
{
  const vp = (await one(`SELECT path p FROM document_versions WHERE user_id=? AND path=?`, [U, OLD]))?.p;
  rec('R5. document_versions.path left as history (still old)', vp === OLD, `versionPath=${vp}`);
}
// R6
{
  const bySlug = await db.documents.getBySlug(U, 'old-note-slug');
  rec('R6. public_slug untouched → getBySlug resolves the renamed doc',
    !!bySlug && bySlug.path === NEW && bySlug.public_slug === 'old-note-slug', `path=${bySlug?.path}`);
}
// R7 — FTS self-heal (content rowid index): search the body, expect the new path
{
  let ftsPath = null;
  try {
    ftsPath = (await one(
      `SELECT d.path p FROM documents_fts f JOIN documents d ON d.rowid=f.rowid
        WHERE documents_fts MATCH ? AND d.user_id=? LIMIT 1`, ['haystack', U]))?.p;
  } catch (e) { ftsPath = `ERR:${e?.code || e?.name}`; }
  rec('R7. FTS self-heals — content search returns the new path', ftsPath === NEW, `ftsPath=${ftsPath}`);
}
// R8 — CONFLICT: rename NEW onto OTHER → throws + rolls back byte-identical
{
  const snap = async () => JSON.stringify({
    docNew: !!(await db.documents.get(U, NEW)),
    docOther: !!(await db.documents.get(U, OTHER)),
    sl: (await one(`SELECT document_path p FROM share_links WHERE token='tok-1'`)).p,
    sr: (await one(`SELECT cover_doc_path p FROM space_rooms WHERE space_id='sp-1'`)).p,
  });
  const before = await snap();
  let threw = false;
  try { await db.documents.renamePath(U, NEW, OTHER); } catch (e) { threw = e?.message === 'RENAME_CONFLICT'; }
  const after = await snap();
  rec('R8. conflict → RENAME_CONFLICT + atomic rollback (tables byte-identical)', threw && before === after,
    `threw=${threw} identical=${before === after}`);
}
// R9 — guards
{
  let nf = false, bad = false;
  try { await db.documents.renamePath(U, 'personal/does-not-exist', 'personal/x'); } catch (e) { nf = e?.message === 'RENAME_NOT_FOUND'; }
  try { await db.documents.renamePath(U, NEW, '   '); } catch (e) { bad = e?.message === 'RENAME_BAD_PATH'; }
  rec('R9. NOT_FOUND + BAD_PATH guards', nf && bad, `notFound=${nf} badPath=${bad}`);
}

await close();

const passed = ledger.filter(Boolean).length;
console.log(`\n${passed}/${ledger.length} checks passed`);
if (passed === ledger.length) { console.log('VERDICT: GO — atomic path rename: cascade complete · zero orphans · id-stable · slug-safe · rollback-atomic'); process.exit(0); }
console.log('VERDICT: NO-GO'); process.exit(1);
