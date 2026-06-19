// scripts/verify-streams-spectrum-perf.mjs — the spectrum PERF gate (F1).
//
// Proves the two new guarantees behind the 7-12s → sub-second fix, on a REAL
// vault (getDb + better-sqlite3 + real migrations incl. 0027):
//  P1 the 0027 covering index exists and the aggregate query PLANS to use it
//     (index-only, not a full table SCAN — the SQLCipher page-scan that cost 7-12s)
//  P2 db.streams.spectrum is SWR-CACHED: a 2nd live call returns the SAME object
//     (one compute, not two); bustSpectrum forces a recompute; windowDays is keyed
//  P3 semantics preserved: dropping the unused total_all changed no surfaced field
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
  console.log('\n=== verify:streams-spectrum-perf — covering index + SWR cache (F1) ===\n');
  const dir = mkdtempSync(join(tmpdir(), 'myc-spectrum-perf-'));
  const dbPath = join(dir, 'v.db');
  applyMigrations(new Database(dbPath));
  const userKey = await importMasterKey(crypto.randomBytes(32).toString('hex'));
  const systemKey = await importMasterKey(crypto.randomBytes(32).toString('hex'));
  const { db, close } = getDb({ dbPath, userKey, systemKey });
  const U = 'owner';
  const q = (sql, params = []) => db._base.d1Query(sql, params);

  try {
    await q(`INSERT INTO users (id, display_name, type) VALUES ('owner', 'Owner', 'human')`);
    // Seed enough rows across a few sources that the planner meaningfully prefers
    // the covering index for GROUP BY source (and a small full-scan isn't trivially
    // cheaper). ~600 messages across 4 sources, spread over 14 days.
    const sources = ['telegram', 'discord', 'gmail', 'portal'];
    for (let i = 0; i < 600; i++) {
      await q(`INSERT INTO messages (id, user_id, role, content, source, created_at) VALUES (?,?, 'user', ?, ?, ?)`,
        [`m${i}`, U, `body ${i}`, sources[i % sources.length], iso(NOW - (i % 14) * DAY - i * 1000)]);
    }

    // P1a — the index exists.
    const idx = await q(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_user_source_created'`);
    rec('P1a. 0027 covering index idx_messages_user_source_created exists', (idx.results || []).length === 1);

    // P1b — the aggregate query PLANS to use an index (not a bare table scan).
    const floor = iso(NOW - 7 * DAY);
    const plan = await q(
      `EXPLAIN QUERY PLAN
       SELECT COALESCE(source,'unknown') AS source, MAX(created_at) AS last_activity,
              SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS window_total,
              SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS today_total
       FROM messages WHERE user_id = ? AND forgotten_at IS NULL GROUP BY source`,
      [floor, floor, U]);
    const detail = (plan.results || []).map((r) => r.detail || '').join(' | ');
    const usesIndex = /USING (COVERING )?INDEX idx_messages_user_source_created/.test(detail);
    const bareScan = /SCAN (TABLE )?messages\b(?!.*USING)/.test(detail) && !/USING.*INDEX/.test(detail);
    rec('P1b. aggregate query plans to USE the covering index (index-only, not full scan)',
      usesIndex && !bareScan, `plan="${detail}"`);

    // P2a — second live call (no nowMs) is served from cache: SAME object reference.
    const r1 = await db.streams.spectrum(U, { windowDays: 7 });
    const r2 = await db.streams.spectrum(U, { windowDays: 7 });
    rec('P2a. 2nd live spectrum() served from cache (identical object — one compute)', r1 === r2);

    // P2b — bustSpectrum forces a recompute: NEW object reference.
    bustSpectrum(U);
    const r3 = await db.streams.spectrum(U, { windowDays: 7 });
    rec('P2b. bustSpectrum() forces a fresh recompute', r3 !== r1 && Array.isArray(r3.sources));

    // P2c — cache is keyed by windowDays (different window → different entry).
    const r30a = await db.streams.spectrum(U, { windowDays: 30 });
    const r30b = await db.streams.spectrum(U, { windowDays: 30 });
    rec('P2c. cache keyed by (userId, windowDays)', r30a === r30b && r30a !== r3 && r30a.windowDays === 30);

    // P2d — deterministic nowMs path BYPASSES the cache (fresh object each call).
    const t1 = await db.streams.spectrum(U, { windowDays: 7, nowMs: NOW });
    const t2 = await db.streams.spectrum(U, { windowDays: 7, nowMs: NOW });
    rec('P2d. nowMs (test) path bypasses cache — deterministic, uncached', t1 !== t2);

    // P3 — semantics preserved: each source entry still has the surfaced fields,
    // and the now-removed total_all never appears.
    const s = (r3.sources || [])[0] || {};
    const fieldsOk = ['source', 'kind', 'total', 'today', 'lastActivity', 'status', 'sparkline'].every((k) => k in s);
    rec('P3. surfaced fields intact, total_all (unused) not surfaced',
      fieldsOk && !('total_all' in s) && r3.sources.length === 4, `keys=${Object.keys(s).join(',')}`);
  } finally {
    close?.();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  const allPass = ledger.every(Boolean);
  console.log('\n' + '='.repeat(64));
  console.log(`VERDICT: ${allPass ? 'GO — spectrum: covering index used + SWR-cached + semantics preserved' : 'NO-GO — see [✗] rows'}  EXIT=${allPass ? 0 : 1}`);
  console.log('='.repeat(64));
  process.exit(allPass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
