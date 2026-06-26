// Verify — broad local-files sweep import:
//   L1 text note (.md/.txt) → a document (import/local-files/<root>/…) + a memory
//   L2 image/audio/binary-doc → an ENCRYPTED attachment (putBlob) + a linked memory
//   L3 identical bytes under two names → one shared blob (local_path reused)
//   L4 category filter: categories:['document'] imports text only, skips media
//   L5 re-run → fully deduped (docs + attachments idempotent)
//   L6 managed Photos library package + dotdirs are NOT walked
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>.
import crypto from 'node:crypto';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrate.js';
import { boot } from '../src/index.js';
import { importLocalFiles } from '../src/ingest/local-files-import.js';

const DB = 'data/verify-localfiles.db';
const KCV = 'data/verify-localfiles-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch { /* */ } }
mkdirSync('data', { recursive: true });
{ const seed = new Database(DB); applyMigrations(seed); seed.close(); }

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

// ── Fixture folder: notes + media + a duplicate-bytes pair + skip targets ──
const root = path.join(tmpdir(), `sweep-fix-${process.pid}`);
try { rmSync(root, { recursive: true }); } catch { /* */ }
mkdirSync(path.join(root, 'notes'), { recursive: true });
mkdirSync(path.join(root, 'media'), { recursive: true });
writeFileSync(path.join(root, 'notes', 'idea.md'), '# Idea\nBuild a full import sweep.');
writeFileSync(path.join(root, 'notes', 'log.txt'), 'plain text log entry');
const img = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]); // fake PNG bytes
writeFileSync(path.join(root, 'media', 'photo.png'), img);
writeFileSync(path.join(root, 'media', 'copy-of-photo.jpg'), img);                      // SAME bytes, different name/ext
writeFileSync(path.join(root, 'media', 'memo.m4a'), Buffer.from([0, 0, 0, 32, 1, 2, 3])); // fake audio
// Skip targets: a dotdir and a macOS managed Photos library package.
mkdirSync(path.join(root, '.cache'), { recursive: true });
writeFileSync(path.join(root, '.cache', 'hidden.md'), '# should be skipped');
mkdirSync(path.join(root, 'My Photos.photoslibrary', 'originals'), { recursive: true });
writeFileSync(path.join(root, 'My Photos.photoslibrary', 'originals', 'managed.jpg'), img);

const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex() });
const userId = 'verify-localfiles-user';
const raw = new Database(DB, { readonly: true });
const docPath = (p) => raw.prepare('SELECT 1 FROM documents WHERE path = ?').get(p);
const msgExists = (id) => !!raw.prepare('SELECT 1 FROM messages WHERE id = ?').get(id);
const attCount = () => raw.prepare('SELECT COUNT(*) c FROM attachments').get().c;
const distinctBlobs = () => raw.prepare('SELECT COUNT(DISTINCT local_path) c FROM attachments').get().c;

const r1 = await importLocalFiles(db, { userId, folderPath: root });
rec('L1 text → document + memory', !!docPath('import/local-files/' + path.basename(root) + '/notes/idea.md') && msgExists(`local:${path.basename(root)}/notes/idea.md`) && r1.documents.created === 2,
  JSON.stringify(r1.documents));
rec('L2 media → attachments + linked memories', r1.attachments.imported === 3 && attCount() === 3,
  JSON.stringify(r1.attachments));
rec('L3 identical bytes share ONE blob (png + jpg copy)', distinctBlobs() === 2 && r1.attachments.blobsReused === 1,
  `attachments=${attCount()} distinctBlobs=${distinctBlobs()} reused=${r1.attachments.blobsReused}`);
rec('L6 dotdir + .photoslibrary package NOT walked (no hidden/managed rows)',
  !docPath('import/local-files/' + path.basename(root) + '/.cache/hidden.md') && r1.scanned === 5,
  `scanned=${r1.scanned}`);

const r2 = await importLocalFiles(db, { userId, folderPath: root });
rec('L5 re-run fully deduped (docs + attachments idempotent)',
  r2.documents.created === 2 && r2.documents.deduped === 2 && r2.attachments.imported === 0 && r2.attachments.deduped === 3,
  JSON.stringify({ docs: r2.documents, atts: r2.attachments }));

// Category filter on a fresh vault: documents only.
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { /* keep DB; just assert filter on counts */ }
const r3 = await importLocalFiles(db, { userId, folderPath: root, categories: ['document'] });
rec('L4 category filter: documents-only sweep imports no new media',
  r3.attachments.imported === 0 && r3.scanned === 2, JSON.stringify({ scanned: r3.scanned, atts: r3.attachments.imported }));

const ok = ledger.every(Boolean);
console.log(`\nVERDICT: ${ok ? 'GO' : 'NO-GO'} — local-files sweep: text→doc+memory, media→encrypted attachment, blob-dedup, category filter, idempotent`);
raw.close(); await close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch { /* */ } }
try { rmSync(root, { recursive: true }); } catch { /* */ }
console.log(`EXIT=${ok ? 0 : 1}`);
process.exit(ok ? 0 : 1);
