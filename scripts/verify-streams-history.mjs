// scripts/verify-streams-history.mjs — the since-start history-graph gate.
//
// Boots a REAL vault (getDb + better-sqlite3 + real migrations) and seeds rows
// across the four ingest tables on several distinct days, then exercises
// db.streams.dailyVolume with a fixed clock. Proves:
//  • the day axis spans the first item → today, one key per day, contiguous
//  • series[source] aligns 1:1 with days, with the right per-day counts
//  • per-source totals are correct and per-platform variants collapse
//    (telegram-group → telegram), sorted by total desc
//  • §7 FAIL-SAFE: the payload carries ZERO content/ciphertext — no decryption path
//  • the /streams/history endpoint is wired and returns the same shape

import Database from 'better-sqlite3';
import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb } from '../src/db/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { importMasterKey } from '../src/crypto/crypto-local.js';
import { portalCompatRouter } from '../src/portal-compat.js';

const ledger = [];
const rec = (name, pass, detail = '') => { ledger.push(pass); console.log(`${pass ? '[✓]' : '[✗]'} ${name}${detail ? ` — ${detail}` : ''}`); };

const NOW = Date.parse('2026-06-17T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const DAY = 86400000;

async function main() {
  console.log('\n=== verify:streams-history — since-start history graph ===\n');
  const dir = mkdtempSync(join(tmpdir(), 'myc-history-'));
  applyMigrations(new Database(join(dir, 'v.db')));
  const userKey = await importMasterKey(crypto.randomBytes(32).toString('hex'));
  const systemKey = await importMasterKey(crypto.randomBytes(32).toString('hex'));
  const { db, close } = getDb({ dbPath: join(dir, 'v.db'), userKey, systemKey });
  const U = 'owner';
  const q = (sql, params = []) => db._base.d1Query(sql, params);

  await q(`INSERT INTO users (id, display_name, type) VALUES ('owner', 'Owner', 'human')`);

  const msg = (id, source, ms) => q(
    `INSERT INTO messages (id, user_id, role, content, source, created_at) VALUES (?, ?, 'user', ?, ?, ?)`,
    [id, U, `body of ${id}`, source, iso(ms)]);
  await msg('m1', 'telegram_555', NOW);              // 06-17 today
  await msg('m2', 'telegram_555', NOW - 2 * DAY);    // 06-15
  await msg('m3', 'telegram-group', NOW - 3 * DAY);  // 06-14, folds into telegram
  await msg('m4', 'gmail', NOW - 1 * DAY);           // 06-16

  // earliest item: an obsidian document on 06-13 → sets the start day.
  await q(`INSERT INTO documents (id, user_id, path, source_type, title, content, created_at, updated_at)
           VALUES (?, ?, ?, 'obsidian', ?, ?, ?, ?)`,
    ['d1', U, 'notes/a.md', 'A note', 'secret body', iso(NOW - 4 * DAY), iso(NOW - 4 * DAY)]);

  await q(`INSERT INTO health_daily (id, user_id, date, source, created_at, updated_at)
           VALUES (?, ?, '2026-06-17', 'apple_health', ?, ?)`,
    ['owner:2026-06-17', U, iso(NOW), iso(NOW)]);

  await q(`INSERT INTO tasks (id, user_id, title, status, created_at) VALUES (?, ?, ?, 'pending', ?)`,
    ['t1', U, 'do the thing', iso(NOW - 1 * DAY)]);

  const h = await db.streams.dailyVolume(U, { nowMs: NOW });
  const by = Object.fromEntries(h.sources.map((s) => [s.source, s]));

  // Day axis: 06-13 … 06-17 inclusive, contiguous, one key per day.
  rec('start = first item day (06-13)', h.start === '2026-06-13', `start=${h.start}`);
  rec('end = today (06-17)', h.end === '2026-06-17', `end=${h.end}`);
  rec('days span = 5, contiguous', h.days.length === 5 && h.days[0] === '2026-06-13' && h.days[4] === '2026-06-17', `days=${h.days.join(',')}`);
  rec('not clamped (short span)', h.clamped === false);

  // Variant collapse + totals.
  rec('telegram folds telegram-group (total 3)', by.telegram?.total === 3, `total=${by.telegram?.total}`);
  rec('no separate telegram-group source', !by['telegram-group']);
  rec('gmail total 1', by.gmail?.total === 1);
  rec('obsidian total 1', by.obsidian?.total === 1);
  rec('apple_health total 1', by.apple_health?.total === 1);
  rec('task total 1', by.task?.total === 1);

  // series alignment: telegram on 06-14, 06-15, 06-17.
  const tg = h.series.telegram || [];
  rec('series.telegram aligns to days (len 5)', tg.length === 5, `len=${tg.length}`);
  rec('telegram per-day = [0,1,1,0,1]', JSON.stringify(tg) === JSON.stringify([0, 1, 1, 0, 1]), `tg=${JSON.stringify(tg)}`);
  rec('series.obsidian on start day only', JSON.stringify(h.series.obsidian) === JSON.stringify([1, 0, 0, 0, 0]), `ob=${JSON.stringify(h.series.obsidian)}`);
  rec('series.apple_health on today only', (h.series.apple_health || [])[4] === 1 && (h.series.apple_health || []).reduce((a, b) => a + b, 0) === 1);

  // Sorted by total desc (telegram, 3, first).
  rec('sources sorted by total desc', h.sources[0]?.source === 'telegram', `first=${h.sources[0]?.source}`);

  // §7 FAIL-SAFE: no content/ciphertext anywhere in the payload.
  const json = JSON.stringify(h);
  rec('§7: no content/title/preview key', !/"(content|title|preview|text|summary|embedding|embedding_768|centroid)"/.test(json));
  rec('§7: no plaintext body leaks', ['body of m1', 'secret body', 'do the thing', 'A note'].every((b) => !json.includes(b)));
  rec('§7: no ciphertext envelope (ct/iv)', !/"(ct|iv|wrappedDek)"/.test(json));

  // Endpoint wired: same shape over HTTP.
  const app = express();
  app.use('/api/v1/portal', portalCompatRouter({ db, userId: U }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/portal/streams/history`);
  const httpJson = await res.json();
  // The endpoint uses the wall clock (no injectable nowMs), so the day count is
  // ≥ the fixed-clock run; assert SHAPE + alignment, not the exact span.
  rec('GET /streams/history returns aligned shape',
    res.status === 200 && Array.isArray(httpJson.days) && httpJson.days.length >= 5
    && httpJson.start === '2026-06-13'
    && Array.isArray(httpJson.sources) && httpJson.sources.length === h.sources.length
    && Array.isArray(httpJson.series.telegram) && httpJson.series.telegram.length === httpJson.days.length);
  server.close();

  close();
  rmSync(dir, { recursive: true, force: true });

  const pass = ledger.filter(Boolean).length;
  console.log(`\n${pass}/${ledger.length} checks passed`);
  console.log(ledger.every(Boolean) ? 'VERDICT: GO — history: plaintext-only, day-aligned series, totals + folding correct' : 'VERDICT: NO-GO');
  process.exit(ledger.every(Boolean) ? 0 : 1);
}

main().catch((e) => { console.error('FAIL harness error:', e?.stack || e); process.exit(1); });
