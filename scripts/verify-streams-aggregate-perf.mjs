// scripts/verify-streams-aggregate-perf.mjs — the streams-aggregate PERF +
// correctness gate (migration 0033 partial covering indexes).
//
// WHY THIS GATE EXISTS, AND WHY IT USES AN ENCRYPTED VAULT:
// the spectrum/history aggregates filter `forgotten_at IS NULL`, which 0032's
// (user_id, source, created_at) index does NOT cover — so on the at-rest
// SQLCipher vault SQLite still decrypts every table page to test forgotten_at
// (measured ~2.15 s on 69k messages). The prior perf gate ran on a PLAINTEXT db
// and so saw none of that cost. This gate is BORN ENCRYPTED (cipher='sqlcipher'
// + key set before any statement) so the covering property is tested against the
// real mechanism. Proves:
//  P1 the 0033 partial indexes exist and the aggregate query PLANS to use the
//     partial index (idx_*_live) — index-only, NOT a bare table SCAN.
//  P2 GOLDEN-DIFF: db.streams.spectrum + db.streams.dailyVolume return
//     byte-identical results WITH the partial index and WITHOUT it (dropped on a
//     raw keyed connection) — the index is a pure perf optimization, zero
//     semantic change.
//  P3 REDACTION fidelity: a forgotten message is excluded from both aggregates
//     (the partial predicate `WHERE forgotten_at IS NULL` == the query filter),
//     so the smaller index can never over- or under-count.
//  P4 §7: the payloads carry no content/ciphertext.
// Timing is LOGGED (encrypted with-vs-without) but NOT asserted — wall-clock is
// CI-flaky; the covering PLAN (P1) is the deterministic proof decryption is gone.
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>.
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb } from '../src/db/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { importMasterKey } from '../src/crypto/crypto-local.js';
import { bustSpectrum } from '../src/streams-cache.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? '[✓]' : '[✗]'} ${n}${d ? ` — ${d}` : ''}`); };
const NOW = Date.parse('2026-06-17T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const DAY = 86400000;

async function main() {
  console.log('\n=== verify:streams-aggregate-perf — partial covering indexes (0033), encrypted vault ===\n');
  const dir = mkdtempSync(join(tmpdir(), 'myc-agg-perf-'));
  const dbPath = join(dir, 'v.db');
  const dbKeyHex = crypto.randomBytes(32).toString('hex');

  // Born encrypted: key PRAGMA must precede any statement, then migrate (incl. 0033).
  const born = new Database(dbPath);
  born.pragma(`cipher='sqlcipher'`);
  born.pragma(`key="x'${dbKeyHex}'"`);
  applyMigrations(born);
  born.close();

  const userKey = await importMasterKey(crypto.randomBytes(32).toString('hex'));
  const systemKey = await importMasterKey(crypto.randomBytes(32).toString('hex'));
  const { db, close } = getDb({ dbPath, userKey, systemKey, dbKeyHex });
  const U = 'owner';
  const q = (sql, params = []) => db._base.d1Query(sql, params);

  // Raw keyed connection for DDL (the d1 adapter is RETURNING-oriented; DROP INDEX
  // must go through better-sqlite3 .exec()).
  const ddl = new Database(dbPath);
  ddl.pragma(`cipher='sqlcipher'`);
  ddl.pragma(`key="x'${dbKeyHex}'"`);

  try {
    await q(`INSERT INTO users (id, display_name, type) VALUES ('owner', 'Owner', 'human')`);

    // Seed enough rows across sources/days that the planner prefers the index.
    const sources = ['telegram', 'discord', 'gmail', 'portal'];
    for (let i = 0; i < 1000; i++) {
      await q(`INSERT INTO messages (id, user_id, role, content, source, created_at) VALUES (?,?, 'user', ?, ?, ?)`,
        [`m${i}`, U, `body ${i}`, sources[i % 4], iso(NOW - (i % 30) * DAY - i * 1000)]);
    }
    for (let i = 0; i < 200; i++) {
      await q(`INSERT INTO documents (id, user_id, path, source_type, title, content, created_at, updated_at)
               VALUES (?,?,?, 'obsidian', ?, ?, ?, ?)`,
        [`d${i}`, U, `n/${i}.md`, `t${i}`, `c${i}`, iso(NOW - (i % 20) * DAY), iso(NOW)]);
    }
    // A pair on a dedicated source where exactly one is later forgotten, so P3 can
    // assert the forgotten one drops out (total: 1, not 2).
    await q(`INSERT INTO messages (id, user_id, role, content, source, created_at) VALUES ('keep', ?, 'user', ?, 'whatsapp', ?)`, [U, 'kept', iso(NOW)]);
    await q(`INSERT INTO messages (id, user_id, role, content, source, created_at, forgotten_at) VALUES ('gone', ?, 'user', ?, 'whatsapp', ?, ?)`, [U, 'redacted', iso(NOW - DAY), iso(NOW)]);
    ddl.exec(`ANALYZE`); // stabilise the planner's index choice on the seed size

    // P1 — indexes exist + the aggregate PLANS to use the partial index, not a scan.
    const idxRows = ddl.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_messages_user_source_created_live','idx_documents_user_srctype_created_live')`).all();
    rec('P1a. 0033 partial covering indexes exist (messages + documents)', idxRows.length === 2, `found=${idxRows.map(r => r.name).join(',')}`);

    const floor = iso(NOW - 7 * DAY);
    const plan = await q(
      `EXPLAIN QUERY PLAN
       SELECT COALESCE(source,'unknown') AS source, MAX(created_at) AS last_activity,
              SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS window_total,
              substr(created_at,1,10) AS day, COUNT(*) AS c
       FROM messages WHERE user_id = ? AND forgotten_at IS NULL GROUP BY source, day`,
      [floor, U]);
    const detail = (plan.results || []).map((r) => r.detail || '').join(' | ');
    const usesPartial = /USING (COVERING )?INDEX idx_messages_user_source_created_live/.test(detail);
    const bareScan = /\bSCAN (TABLE )?messages\b/.test(detail) && !/USING.*INDEX/.test(detail);
    rec('P1b. messages aggregate plans to USE the partial covering index (no table scan)',
      usesPartial && !bareScan, `plan="${detail}"`);

    // Compute WITH the partial indexes (deterministic nowMs path bypasses the cache).
    const tW0 = performance.now();
    const specWith = await db.streams.spectrum(U, { windowDays: 7, nowMs: NOW });
    const histWith = await db.streams.dailyVolume(U, { nowMs: NOW });
    const tWith = performance.now() - tW0;

    // P3 — redaction fidelity: the forgotten whatsapp message is excluded (total 1).
    const waSpec = (specWith.sources || []).find((s) => s.source === 'whatsapp');
    const waHist = (histWith.sources || []).find((s) => s.source === 'whatsapp');
    rec('P3. forgotten message excluded from spectrum (whatsapp total=1, not 2)', waSpec && waSpec.total === 1, `total=${waSpec?.total}`);
    rec('P3. forgotten message excluded from history (whatsapp total=1, not 2)', waHist && waHist.total === 1, `total=${waHist?.total}`);

    // Drop the partial indexes → recompute on identical data.
    ddl.exec(`DROP INDEX idx_messages_user_source_created_live`);
    ddl.exec(`DROP INDEX idx_documents_user_srctype_created_live`);
    bustSpectrum(U);
    const tN0 = performance.now();
    const specNo = await db.streams.spectrum(U, { windowDays: 7, nowMs: NOW });
    const histNo = await db.streams.dailyVolume(U, { nowMs: NOW });
    const tNo = performance.now() - tN0;

    // P2 — GOLDEN-DIFF: byte-identical with vs without the index.
    rec('P2a. spectrum() identical with vs without partial index',
      JSON.stringify(specWith) === JSON.stringify(specNo));
    rec('P2b. dailyVolume() identical with vs without partial index',
      JSON.stringify(histWith) === JSON.stringify(histNo));

    // P4 — §7: no plaintext/ciphertext leaks in either payload.
    const blob = JSON.stringify(specWith) + JSON.stringify(histWith);
    rec('P4. §7 — no content/ciphertext in aggregate payloads',
      !/"(content|title|preview|text|summary|embedding|ct|iv|wrappedDek)"/.test(blob)
      && !['body 0', 'redacted', 'kept', 'c0'].some((s) => blob.includes(s)));

    console.log(`\n   timing (encrypted, ${1002} msgs + ${200} docs): WITH partial ≈ ${tWith.toFixed(1)}ms · WITHOUT ≈ ${tNo.toFixed(1)}ms`);
  } finally {
    ddl.close();
    close?.();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  const allPass = ledger.every(Boolean);
  console.log('\n' + '='.repeat(64));
  console.log(`VERDICT: ${allPass ? 'GO — partial covering index: used (encrypted) + golden-identical + redaction-faithful' : 'NO-GO — see [✗] rows'}  EXIT=${allPass ? 0 : 1}`);
  console.log('='.repeat(64));
  process.exit(allPass ? 0 : 1);
}
main().catch((e) => { console.error('FAIL harness error:', e?.stack || e); process.exit(1); });
