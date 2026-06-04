// Verify Phase 1 — Obsidian vault folder import
// (POST /api/v1/portal/import/obsidian). Drives both transports (browser
// `files` mode + Tauri `folderPath` mode) and asserts each note lands as BOTH
// a document (upsert on path) AND a memory (captureMessage, content-addressed),
// encrypted at rest, idempotent on re-import, with edits creating a new memory.
//
//   P1 parser            parseMarkdownNote → title/tags/body from front-matter
//   O1 files import       1 note → {documentsUpserted:1, memoriesCreated:1}; doc + msg(source=obsidian, nlp_processed=0)
//   O2 encrypted at rest  note text NOT plaintext in the db file
//   O3 re-import dedup     same files → memoriesCreated:0, memoriesDeduped:1, document upserted (1 msg total)
//   O4 edit → new memory   edited body → memoriesCreated:1 (2 msgs), document content updated
//   O5 folderPath mode     temp dir of 2 .md → scanned:2, documentsUpserted:2, memoriesCreated:2
//   O6 safety              ../traversal rejected (no doc written outside), non-.md skipped
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
const hex = () => crypto.randomBytes(32).toString('hex');
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

const NOTE_TEXT = 'unmistakable-obsidian-note-plaintext-marker';

async function main() {
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  try { rmSync(VAULT, { recursive: true, force: true }); } catch {}
  mkdirSync('data', { recursive: true });
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
  const countObsidian = async () => {
    const r = await db.rawQuery('SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND source = ?', [uid, 'obsidian']);
    return r.results?.[0]?.c ?? 0;
  };

  try {
    // ── O1 files-mode import ──
    const filesV1 = [{ relPath: 'notes/idea.md', content: `---\ntitle: My Idea\ntags: [a, b]\n---\n# My Idea\n${NOTE_TEXT}`, mtime: '2026-01-02T00:00:00Z' }];
    const r1 = await post({ files: filesV1 });
    const b1 = await r1.json().catch(() => ({}));
    const doc1 = await db.documents.get(uid, 'import/obsidian/notes/idea');
    const nlp = await db.rawQuery('SELECT nlp_processed FROM messages WHERE user_id = ? AND source = ? LIMIT 1', [uid, 'obsidian']);
    rec('O1. files import → document + memory (nlp_processed=0)',
      r1.status === 200 && b1.scanned === 1 && b1.documentsUpserted === 1 && b1.memoriesCreated === 1
        && b1.memoriesDeduped === 0 && !!doc1 && (await countObsidian()) === 1 && (nlp.results?.[0]?.nlp_processed === 0),
      `status=${r1.status} ${JSON.stringify({ scanned: b1.scanned, docs: b1.documentsUpserted, mem: b1.memoriesCreated })} doc=${!!doc1} nlp=${nlp.results?.[0]?.nlp_processed}`);

    // ── O2 encrypted at rest ──
    const plaintextLeak = readFileSync(DB).includes(Buffer.from(NOTE_TEXT));
    rec('O2. note content encrypted at rest (no plaintext in db file)', !plaintextLeak, `plaintextLeak=${plaintextLeak}`);

    // ── O3 re-import unchanged → dedup ──
    const r3 = await post({ files: filesV1 });
    const b3 = await r3.json().catch(() => ({}));
    rec('O3. re-import unchanged → memoriesDeduped, document upserted, 1 msg total',
      b3.memoriesCreated === 0 && b3.memoriesDeduped === 1 && b3.documentsUpserted === 1 && (await countObsidian()) === 1,
      `created=${b3.memoriesCreated} deduped=${b3.memoriesDeduped} docs=${b3.documentsUpserted}`);

    // ── O4 edited note → new memory, document content updated ──
    const filesV2 = [{ relPath: 'notes/idea.md', content: `---\ntitle: My Idea\n---\n# My Idea\n${NOTE_TEXT} EDITED`, mtime: '2026-01-03T00:00:00Z' }];
    const r4 = await post({ files: filesV2 });
    const b4 = await r4.json().catch(() => ({}));
    const doc4 = await db.documents.get(uid, 'import/obsidian/notes/idea');
    rec('O4. edited note → +1 memory (2 total), document content updated',
      b4.memoriesCreated === 1 && (await countObsidian()) === 2 && typeof doc4?.content === 'string' && doc4.content.includes('EDITED'),
      `created=${b4.memoriesCreated} total=${await countObsidian()} docUpdated=${doc4?.content?.includes('EDITED')}`);

    // ── O5 folderPath mode ──
    mkdirSync(path.join(VAULT, 'sub'), { recursive: true });
    writeFileSync(path.join(VAULT, 'a.md'), '# Alpha note\nfirst');
    writeFileSync(path.join(VAULT, 'sub', 'b.md'), '# Beta note\nsecond');
    writeFileSync(path.join(VAULT, 'ignore.txt'), 'not markdown');
    const r5 = await post({ folderPath: VAULT });
    const b5 = await r5.json().catch(() => ({}));
    rec('O5. folderPath mode walks *.md (skips .txt)',
      r5.status === 200 && b5.scanned === 2 && b5.documentsUpserted === 2 && b5.memoriesCreated === 2,
      `${JSON.stringify({ scanned: b5.scanned, docs: b5.documentsUpserted, mem: b5.memoriesCreated })}`);

    // ── O6 safety: traversal rejected, non-md skipped ──
    const r6 = await post({ files: [
      { relPath: '../escape.md', content: 'should not be written outside' },
      { relPath: 'x.txt', content: 'skip me' },
      { relPath: 'ok.md', content: '# fine\nok' },
    ] });
    const b6 = await r6.json().catch(() => ({}));
    const escaped = await db.documents.get(uid, '../escape');
    rec('O6. traversal rejected + non-md skipped (only ok.md imports)',
      r6.status === 200 && !escaped && b6.documentsUpserted === 1 && b6.skipped >= 1 && (b6.errors?.length ?? 0) >= 1,
      `docs=${b6.documentsUpserted} skipped=${b6.skipped} errors=${b6.errors?.length} escapedDoc=${!!escaped}`);
  } finally {
    srv.server.close(); try { srv.close?.(); } catch {}
    try { rmSync(VAULT, { recursive: true, force: true }); } catch {}
  }

  const allPass = ledger.every(Boolean);
  console.log(`VERDICT: ${allPass ? 'GO — Phase 1: Obsidian folder import → document + memory, encrypted, idempotent, edit-aware, safe' : 'NO-GO — see FAIL rows'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('verify-obsidian threw:', e); process.exit(1); });
