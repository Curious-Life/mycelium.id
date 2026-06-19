// Verify Phase 1 — Obsidian vault folder import
// (POST /api/v1/portal/import/obsidian). Drives both transports (browser
// `files` mode + Tauri `folderPath` mode) and asserts each note lands as BOTH
// a document (upsert on path, placed in a FOLDER tree mirroring the vault) AND
// a memory (captureMessage, path-stable id), encrypted at rest, idempotent.
//
//   P1 parser            parseMarkdownNote → title/tags/body from front-matter
//   O1 files import       1 note → document (with folder_id) + memory; folder tree built
//   O2 encrypted at rest  note text NOT plaintext in the db file
//   O3 re-import dedup     same files → memoriesDeduped, no duplicate folders
//   O4 edit → update       edited body → memory UPDATED in place (1 total), content reflects edit
//   O5 folderPath + tree   temp dir (a.md + sub/b.md) → 2 docs, root+sub folders, b in sub
//   O6 safety              ../traversal rejected (no doc, no '..' folder), non-.md skipped
//   O7 idempotent folders  re-import folderPath → folder count unchanged
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>.

import crypto from 'node:crypto';
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrate.js';
import { startRestServer } from '../src/server-rest.js';
import { parseMarkdownNote } from '../src/ingest/markdown.js';

const DB = 'data/verify-obsidian.db';
const KCV = 'data/verify-obsidian-kcv.json';
const VAULT = path.resolve('data/verify-obsidian-vault');
const VAULT_NAME = path.basename(VAULT);
const hex = () => crypto.randomBytes(32).toString('hex');
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

const NOTE_TEXT = 'unmistakable-obsidian-note-plaintext-marker';

async function main() {
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  try { rmSync(VAULT, { recursive: true, force: true }); } catch {}
  mkdirSync('data', { recursive: true });
  // The import routes confine folderPath to the allowlist (src/ingest/detect-sources.js).
  // This test's fixture vault lives under data/ — grant it via the explicit
  // out-of-band root so the legit folderPath transport can be exercised.
  mkdirSync(VAULT, { recursive: true });
  process.env.MYCELIUM_IMPORT_ALLOWED_ROOTS = VAULT;
  const raw = new Database(DB); applyMigrations(raw); raw.close();

  // ── P1 parser (no server) ──
  const parsed = parseMarkdownNote('---\ntitle: My Idea\ntags: [alpha, beta]\n---\n# Heading\nbody line #gamma', 'notes/idea.md');
  rec('P1. parseMarkdownNote → title/tags/body',
    parsed.title === 'My Idea' && parsed.tags.includes('alpha') && parsed.tags.includes('beta')
      && parsed.tags.includes('gamma') && parsed.body.startsWith('# Heading') && !parsed.body.includes('---'),
    `title=${parsed.title} tags=${JSON.stringify(parsed.tags)}`);

  const srv = await startRestServer({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(), port: 0, host: '127.0.0.1', portalMode: 'legacy' });
  const { url, db } = srv;
  const uid = 'local-user';
  const post = (body) => fetch(`${url}/api/v1/portal/import/obsidian`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const countObsidian = async () => (await db.rawQuery('SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND source = ?', [uid, 'obsidian'])).results?.[0]?.c ?? 0;
  const folders = async () => db.folders.list(uid);

  try {
    // ── O1 files-mode import + folder tree ──
    const filesV1 = [{ relPath: 'notes/idea.md', content: `---\ntitle: My Idea\ntags: [a, b]\n---\n# My Idea\n${NOTE_TEXT}`, mtime: '2026-01-02T00:00:00Z' }];
    const r1 = await post({ files: filesV1, vaultName: 'TestVault' });
    const b1 = await r1.json().catch(() => ({}));
    const doc1 = await db.documents.get(uid, 'import/obsidian/TestVault/notes/idea');
    const f1 = await folders();
    const root1 = f1.find((f) => f.name === 'TestVault' && f.parent_id == null);
    const notesFolder = f1.find((f) => f.name === 'notes' && f.parent_id === root1?.id);
    rec('O1. files import → document (in folder) + memory; tree built',
      r1.status === 200 && b1.documentsUpserted === 1 && b1.memoriesCreated === 1 && b1.folders === 2
        && !!doc1 && doc1.folder_id === notesFolder?.id && !!root1 && !!notesFolder && (await countObsidian()) === 1,
      `${JSON.stringify({ docs: b1.documentsUpserted, mem: b1.memoriesCreated, folders: b1.folders })} docFolder=${doc1?.folder_id === notesFolder?.id} tree=${!!root1 && !!notesFolder}`);

    // ── O2 encrypted at rest ──
    rec('O2. note content encrypted at rest', !readFileSync(DB).includes(Buffer.from(NOTE_TEXT)), `leak=${readFileSync(DB).includes(Buffer.from(NOTE_TEXT))}`);

    // ── O3 re-import unchanged → dedup + no duplicate folders ──
    const foldersBefore = (await folders()).length;
    const r3 = await post({ files: filesV1, vaultName: 'TestVault' });
    const b3 = await r3.json().catch(() => ({}));
    const foldersAfter = (await folders()).length;
    rec('O3. re-import → memoriesDeduped, document upserted, NO duplicate folders',
      b3.memoriesCreated === 0 && b3.memoriesDeduped === 1 && b3.documentsUpserted === 1 && foldersAfter === foldersBefore && (await countObsidian()) === 1,
      `created=${b3.memoriesCreated} deduped=${b3.memoriesDeduped} folders ${foldersBefore}→${foldersAfter}`);

    // ── O4 edited note → UPDATE the same memory in place (path-stable id) ──
    const filesV2 = [{ relPath: 'notes/idea.md', content: `---\ntitle: My Idea\n---\n# My Idea\n${NOTE_TEXT} EDITED`, mtime: '2026-01-03T00:00:00Z' }];
    const r4 = await post({ files: filesV2, vaultName: 'TestVault' });
    const b4 = await r4.json().catch(() => ({}));
    const doc4 = await db.documents.get(uid, 'import/obsidian/TestVault/notes/idea');
    const mem4 = (await db.rawQuery('SELECT content FROM messages WHERE user_id = ? AND id = ?', [uid, 'obsidian:TestVault/notes/idea'])).results?.[0] ?? null;
    rec('O4. edited note → memory UPDATED in place (still 1 total), content reflects edit',
      b4.memoriesUpdated === 1 && b4.memoriesCreated === 0 && (await countObsidian()) === 1
        && doc4?.content?.includes('EDITED') && mem4?.content?.includes('EDITED'),
      `updated=${b4.memoriesUpdated} created=${b4.memoriesCreated} total=${await countObsidian()} docEdited=${doc4?.content?.includes('EDITED')} memEdited=${mem4?.content?.includes('EDITED')}`);

    // ── O5 folderPath mode + nested folder tree ──
    mkdirSync(path.join(VAULT, 'sub'), { recursive: true });
    writeFileSync(path.join(VAULT, 'a.md'), '# Alpha note\nfirst');
    writeFileSync(path.join(VAULT, 'sub', 'b.md'), '# Beta note\nsecond');
    writeFileSync(path.join(VAULT, 'ignore.txt'), 'not markdown');
    const r5 = await post({ folderPath: VAULT });
    const b5 = await r5.json().catch(() => ({}));
    const f5 = await folders();
    const vroot = f5.find((f) => f.name === VAULT_NAME && f.parent_id == null);
    const subF = f5.find((f) => f.name === 'sub' && f.parent_id === vroot?.id);
    const docB = await db.documents.get(uid, `import/obsidian/${VAULT_NAME}/sub/b`);
    rec('O5. folderPath mode → 2 docs, root+sub folders, b.md in sub',
      r5.status === 200 && b5.scanned === 2 && b5.documentsUpserted === 2 && b5.folders === 2
        && !!vroot && !!subF && docB?.folder_id === subF?.id,
      `${JSON.stringify({ scanned: b5.scanned, docs: b5.documentsUpserted, folders: b5.folders })} subTree=${!!subF} bInSub=${docB?.folder_id === subF?.id}`);

    // ── O6 safety: traversal rejected, non-md skipped ──
    const r6 = await post({ vaultName: 'TestVault', files: [
      { relPath: '../escape.md', content: 'should not be written outside' },
      { relPath: 'x.txt', content: 'skip me' },
      { relPath: 'ok.md', content: '# fine\nok' },
    ] });
    const b6 = await r6.json().catch(() => ({}));
    const escaped = await db.documents.get(uid, 'import/obsidian/TestVault/../escape');
    const dotFolder = (await folders()).find((f) => f.name === '..');
    rec('O6. traversal rejected (no doc, no ".." folder) + non-md skipped',
      r6.status === 200 && !escaped && !dotFolder && b6.documentsUpserted === 1 && b6.skipped >= 2 && (b6.errors?.length ?? 0) >= 1,
      `docs=${b6.documentsUpserted} skipped=${b6.skipped} errors=${b6.errors?.length} escaped=${!!escaped} dotFolder=${!!dotFolder}`);

    // ── O7 idempotent folders on re-import ──
    const before7 = (await folders()).length;
    await post({ folderPath: VAULT });
    const after7 = (await folders()).length;
    rec('O7. re-import folderPath → folder count unchanged (idempotent)', after7 === before7, `folders ${before7}→${after7}`);
  } finally {
    srv.server.close(); try { srv.close?.(); } catch {}
    try { rmSync(VAULT, { recursive: true, force: true }); } catch {}
  }

  const allPass = ledger.every(Boolean);
  console.log(`VERDICT: ${allPass ? 'GO — Phase 1: Obsidian folder import → document + folder tree + memory, encrypted, idempotent, edit-aware, safe' : 'NO-GO — see FAIL rows'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('verify-obsidian threw:', e); process.exit(1); });
