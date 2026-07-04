// verify:recent-export-import — restore a mycelium-recent-export bundle
// (src/ingest/recent-export-import.js + restore-core.js).
//
//   R1 format gate: wrong format → invalid_bundle (400-class)
//   R2 messages + documents land with ORIGINAL id + created_at + source preserved
//   R3 an agent-source row (e.g. 'gateway') is NOT consent-gated (restore ≠ capture)
//   R4 empty content + no attachment message is skipped (pipeline-integrity)
//   R5 re-import is idempotent (dedup by id → 0 inserted 2nd run)
//   R6 attachmentsMissing reported when the bundle lacks the binary
//   R7 enrichment nudged for new rows
//
// Boots a temp vault; reads content back DECRYPTED via db (never raw ciphertext).
import Database from 'better-sqlite3';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { importRecentExport } from '../src/ingest/recent-export-import.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

const DB = 'data/verify-recent-export.db', KCV = 'data/verify-recent-export-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex: crypto.randomBytes(32).toString('hex'), systemHex: crypto.randomBytes(32).toString('hex'), embedder: null });
const U = 'local-user';
const cnt = async (sql, p = []) => Number((await db.rawQuery(sql, p)).results?.[0]?.c ?? 0);
const one = async (sql, p = []) => (await db.rawQuery(sql, p)).results?.[0];

// ── seed a synthetic bundle ─────────────────────────────────────────────────────
const BUNDLE = 'data/verify-recent-export-bundle';
rmSync(BUNDLE, { recursive: true, force: true }); mkdirSync(BUNDLE, { recursive: true });
const TS1 = '2026-06-05T10:00:00.000Z', TS2 = '2026-06-06T11:30:00.000Z';
const messages = [
  { id: 'msg-tele-1', role: 'user', content: 'hello from telegram', message_type: 'chat', source: 'telegram', created_at: TS1 },
  { id: 'msg-gw-1', role: 'assistant', content: 'a gateway-sourced reply', message_type: 'chat', source: 'gateway', created_at: TS2 }, // agent-source → must NOT be gated
  { id: 'msg-empty', role: 'user', content: '   ', message_type: 'chat', source: 'telegram', created_at: TS1 }, // empty → skipped
  { id: 'msg-media', role: 'user', content: 'voice: transcription here', message_type: 'file', source: 'telegram', attachment_id: 'att-gone', created_at: TS2 }, // attachment bytes absent
  { id: 'msg-evil', role: 'user', content: 'has a malicious attachment id', message_type: 'file', source: 'telegram', attachment_id: '../../../../../../etc/passwd', created_at: TS2 }, // path-traversal id → must NOT read outside the bundle
];
const documents = [
  { id: 'doc-1', path: 'notes/one', title: 'One', content: 'document one body', source_type: 'note', created_at: TS1, updated_at: TS1 },
  { id: 'doc-2', path: 'notes/two', title: 'Two', content: 'document two body', source_type: 'note', created_at: TS2, updated_at: TS2 },
];
writeFileSync(join(BUNDLE, 'messages.json'), JSON.stringify(messages));
writeFileSync(join(BUNDLE, 'documents.json'), JSON.stringify(documents));
// An attachments/ dir → haveAttDir=true so the per-id readdir path IS exercised
// (without this the traversal guard is never even reached — the false-green trap).
mkdirSync(join(BUNDLE, 'attachments'), { recursive: true });
// A real SECRET directory reachable from attDir via `../../` (a DIRECTORY target,
// which readdir would actually enumerate — the real exploit shape). The guard
// must refuse to read it. Its files must NEVER land as attachments.
const SECRET = 'data/verify-recent-export-secretdir';
rmSync(SECRET, { recursive: true, force: true }); mkdirSync(SECRET, { recursive: true });
writeFileSync(join(SECRET, 'id_rsa'), 'EXFILTRATED-PRIVATE-KEY');
// Re-point the traversal message at the secret DIRECTORY (relative to <bundle>/attachments).
messages[messages.length - 1].attachment_id = '../../verify-recent-export-secretdir';
writeFileSync(join(BUNDLE, 'messages.json'), JSON.stringify(messages));
const writeManifest = (format) => writeFileSync(join(BUNDLE, 'manifest.json'), JSON.stringify({ format, version: 1, window: { days: 30 }, counts: { messages: messages.length, documents: documents.length } }));

// ── R1 format gate ───────────────────────────────────────────────────────────────
writeManifest('mycelium-full-export'); // wrong format for THIS importer
let gated = false;
try { await importRecentExport(db, { userId: U, dirPath: BUNDLE }); } catch (e) { gated = e?.code === 'invalid_bundle'; }
rec('R1 wrong format → invalid_bundle', gated);

// ── import for real ──────────────────────────────────────────────────────────────
writeManifest('mycelium-recent-export');
let nudged = 0;
const enqueue = () => { nudged++; };
const res = await importRecentExport(db, { userId: U, dirPath: BUNDLE, enqueueEnrichment: enqueue });

// ── R2 preservation ──────────────────────────────────────────────────────────────
const mTele = await one(`SELECT id, source, created_at FROM messages WHERE id='msg-tele-1'`);
const dOne = await one(`SELECT id, source_type, created_at FROM documents WHERE id='doc-1'`);
rec('R2 id + created_at + source preserved verbatim',
  mTele?.id === 'msg-tele-1' && mTele?.source === 'telegram' && mTele?.created_at === TS1 &&
  dOne?.id === 'doc-1' && dOne?.created_at === TS1, `msg=${JSON.stringify(mTele)} doc=${JSON.stringify(dOne)}`);

// ── R3 agent-source NOT gated ─────────────────────────────────────────────────────
rec('R3 agent-source (gateway) landed — restore bypasses the consent gate',
  (await cnt(`SELECT COUNT(*) c FROM messages WHERE id='msg-gw-1' AND source='gateway'`)) === 1);

// ── R4 empty skipped ──────────────────────────────────────────────────────────────
rec('R4 empty-content no-attachment message skipped',
  (await cnt(`SELECT COUNT(*) c FROM messages WHERE id='msg-empty'`)) === 0 && res.skipped >= 1);

// ── R6 attachmentsMissing (att-gone + the traversal id are both byte-less) ─────────
rec('R6 attachmentsMissing reported (bytes absent)', res.attachmentsMissing === 2 && !!res.note,
  `missing=${res.attachmentsMissing} note=${res.note}`);

// ── R8 SECURITY: a DIRECTORY-target traversal id (with attachments/ present) must
//    NOT read the reachable secret dir — text lands, zero attachments imported. ──
rec('R8 directory-target path-traversal blocked (secret not read into vault)',
  (await cnt(`SELECT COUNT(*) c FROM messages WHERE id='msg-evil'`)) === 1 &&
  (await cnt(`SELECT COUNT(*) c FROM attachments`)) === 0 &&      // nothing exfiltrated
  res.attachmentsMissing === 2);                                  // att-gone + the blocked traversal

// ── R7 enrichment nudged ──────────────────────────────────────────────────────────
rec('R7 enrichment nudged for new rows', res.imported >= 3 && nudged >= 1 && res.inferredNow === 0,
  `imported=${res.imported} nudged=${nudged} inferredNow=${res.inferredNow}`);

// ── R5 idempotent re-import ───────────────────────────────────────────────────────
const before = await cnt(`SELECT COUNT(*) c FROM messages WHERE user_id=?`, [U]);
const res2 = await importRecentExport(db, { userId: U, dirPath: BUNDLE, enqueueEnrichment: enqueue });
const after = await cnt(`SELECT COUNT(*) c FROM messages WHERE user_id=?`, [U]);
rec('R5 re-import idempotent (dedup by id, 0 new)',
  res2.imported === 0 && res2.deduped >= 3 && before === after, `imported2=${res2.imported} deduped2=${res2.deduped} before=${before} after=${after}`);

for (const f of [BUNDLE, 'data/verify-recent-export-secretdir']) rmSync(f, { recursive: true, force: true });
close?.();
const passed = ledger.filter(Boolean).length;
console.log(`\n${passed}/${ledger.length} checks passed`);
if (passed !== ledger.length) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO — recent-export restore: id/created_at/source preserved, no gate, idempotent, missing-media reported');
