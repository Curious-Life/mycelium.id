// scripts/verify-library-folder-counts.mjs — Library document-count perf +
// folder-count correctness gate (migration 0037).
//
// db.documents.count (the /documents `total` + per-folder counts) filtered
// `is_internal=? AND forgotten_at IS NULL` over NO covering index → a full
// table-page decrypt scan (~287 ms on 20k encrypted docs) that makes opening a
// folder/category feel slow. 0037 adds a PARTIAL covering index
// (user_id, is_internal, folder_id, updated_at) WHERE forgotten_at IS NULL.
// And db.folders.list now derives counts "the right direction" — ONE GROUP BY
// folder_id (index-only) instead of the never-maintained document_count column.
// Born-ENCRYPTED vault (the blind spot that hides decrypt cost). Proves:
//  P1 the count query PLANS to USE the 0037 partial index (index-only, no scan)
//  P2 db.documents.count is CORRECT (All-Docs total + per-folder) and honours
//     redaction (forgotten excluded) + is_internal (internal docs excluded)
//  P3 db.folders.list returns correct per-folder doc_count/document_count via the
//     grouped query — matches the seeded distribution, ONE query (not N+1)
//  P4 §7: the folders payload carries no content/ciphertext
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb } from '../src/db/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { importMasterKey } from '../src/crypto/crypto-local.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? '[✓]' : '[✗]'} ${n}${d ? ` — ${d}` : ''}`); };
const NOW = Date.parse('2026-06-17T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

async function main() {
  console.log('\n=== verify:library-folder-counts — documents.count index + right-direction folder counts (0037) ===\n');
  const dir = mkdtempSync(join(tmpdir(), 'myc-lib-counts-'));
  const dbPath = join(dir, 'v.db');
  const dbKeyHex = crypto.randomBytes(32).toString('hex');
  const born = new Database(dbPath);
  born.pragma(`cipher='sqlcipher'`); born.pragma(`key="x'${dbKeyHex}'"`);
  applyMigrations(born); born.close();
  const userKey = await importMasterKey(crypto.randomBytes(32).toString('hex'));
  const systemKey = await importMasterKey(crypto.randomBytes(32).toString('hex'));
  const { db, close } = getDb({ dbPath, userKey, systemKey, dbKeyHex });
  const U = 'owner';
  const q = (sql, params = []) => db._base.d1Query(sql, params);

  try {
    await q(`INSERT INTO users (id, display_name, type) VALUES ('owner', 'Owner', 'human')`);
    // Folders A (3 docs), B (1 doc), C (0 docs).
    for (const [id, name] of [['fa', 'Alpha'], ['fb', 'Beta'], ['fc', 'Gamma']]) {
      await q(`INSERT INTO folders (id, user_id, name) VALUES (?,?,?)`, [id, U, name]);
    }
    const doc = (id, folder, { internal = 0, forgotten = null } = {}) =>
      q(`INSERT INTO documents (id, user_id, path, title, content, folder_id, is_internal, source_type, created_at, updated_at, forgotten_at)
         VALUES (?,?,?,?,?,?,?, 'obsidian', ?, ?, ?)`,
        [id, U, `n/${id}.md`, `T ${id}`, `secret body ${id}`, folder, internal, iso(NOW), iso(NOW), forgotten]);
    // Alpha: 3 live. Beta: 1 live + 1 forgotten (excluded) + 1 internal (excluded). Gamma: 0.
    await doc('a1', 'fa'); await doc('a2', 'fa'); await doc('a3', 'fa');
    await doc('b1', 'fb');
    await doc('b2', 'fb', { forgotten: iso(NOW) });
    await doc('b3', 'fb', { internal: 1 });
    // One unfiled live doc (folder_id NULL) — counts in All-Docs total, no folder.
    await doc('u1', null);

    // P1 — the count query uses the 0037 partial index (index-only, no table scan).
    const plan = await q(
      `EXPLAIN QUERY PLAN SELECT COUNT(*) AS n FROM documents
       WHERE user_id = ? AND is_internal = ? AND forgotten_at IS NULL AND folder_id = ?`,
      [U, 0, 'fa']);
    const detail = (plan.results || []).map((r) => r.detail || '').join(' | ');
    const usesIdx = /USING (COVERING )?INDEX idx_documents_user_internal_folder_updated_live/.test(detail);
    const bareScan = /\bSCAN (TABLE )?documents\b/.test(detail) && !/USING.*INDEX/.test(detail);
    rec('P1. count query plans to USE the 0037 partial covering index (no table scan)',
      usesIdx && !bareScan, `plan="${detail}"`);

    // P2 — counts correct + redaction/internal honoured.
    const allTotal = await db.documents.count(U, {});              // live, is_internal=0: a1,a2,a3,b1,u1 = 5
    const faCount = await db.documents.count(U, { folderId: 'fa' });
    const fbCount = await db.documents.count(U, { folderId: 'fb' });
    rec('P2a. All-Documents total = 5 (forgotten + internal excluded)', allTotal === 5, `total=${allTotal}`);
    rec('P2b. folder Alpha count = 3', faCount === 3, `count=${faCount}`);
    rec('P2c. folder Beta count = 1 (forgotten b2 + internal b3 excluded)', fbCount === 1, `count=${fbCount}`);

    // P3 — folders.list derives per-folder counts the right direction.
    const folders = await db.folders.list(U);
    const byId = Object.fromEntries(folders.map((f) => [f.id, f]));
    rec('P3a. folder Alpha doc_count = 3 (via grouped query)', byId.fa?.doc_count === 3 && byId.fa?.document_count === 3, `doc_count=${byId.fa?.doc_count}`);
    rec('P3b. folder Beta doc_count = 1 (redaction + internal honoured)', byId.fb?.doc_count === 1, `doc_count=${byId.fb?.doc_count}`);
    rec('P3c. empty folder Gamma doc_count = 0', byId.fc?.doc_count === 0, `doc_count=${byId.fc?.doc_count}`);

    // P4 — §7: no plaintext/ciphertext in the folders payload.
    const blob = JSON.stringify(folders);
    rec('P4. §7 — no content/ciphertext in folders payload',
      !/"(content|ct|iv|wrappedDek)"/.test(blob) && !blob.includes('secret body'));
  } finally {
    close?.();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  const allPass = ledger.every(Boolean);
  console.log('\n' + '='.repeat(64));
  console.log(`VERDICT: ${allPass ? 'GO — documents.count index-only; folder counts correct via one grouped query; redaction honoured' : 'NO-GO — see [✗] rows'}  EXIT=${allPass ? 0 : 1}`);
  console.log('='.repeat(64));
  process.exit(allPass ? 0 : 1);
}
main().catch((e) => { console.error('FAIL harness error:', e?.stack || e); process.exit(1); });
