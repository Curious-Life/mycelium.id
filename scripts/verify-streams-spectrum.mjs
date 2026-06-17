// scripts/verify-streams-spectrum.mjs — the source-spectrum gate.
//
// Boots a REAL vault (getDb + better-sqlite3 + real migrations) and seeds rows
// across ALL four ingest tables (messages/documents/health_daily/tasks) + two
// connectors, then exercises db.streams.spectrum with a fixed clock. Proves:
//  • plaintext aggregates GROUP BY source across all 4 tables (real SQL, real schema)
//  • per-platform variants collapse (telegram-group→telegram, discord-thread→discord)
//  • kinds classify; an unknown source self-places to 'other'
//  • status derives correctly (live <15m · connector synced · errored connector)
//  • errored connectors surface with 0 items and sort FIRST
//  • the sparkline has windowDays buckets with the right per-day counts
//  • §7 FAIL-SAFE: the spectrum payload carries ZERO content/ciphertext — no
//    decryption path exists, so no content/title/preview/embedding can leak
//  • the /streams/spectrum endpoint is wired and returns the same shape

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
const MIN = 60000, HOUR = 3600000, DAY = 86400000;

async function main() {
  console.log('\n=== verify:streams-spectrum — at-a-glance source spectrum ===\n');
  const dir = mkdtempSync(join(tmpdir(), 'myc-streams-'));
  applyMigrations(new Database(join(dir, 'v.db')));
  const userKey = await importMasterKey(crypto.randomBytes(32).toString('hex'));
  const systemKey = await importMasterKey(crypto.randomBytes(32).toString('hex'));
  const { db, close } = getDb({ dbPath: join(dir, 'v.db'), userKey, systemKey });
  const U = 'owner';
  const q = (sql, params = []) => db._base.d1Query(sql, params);

  await q(`INSERT INTO users (id, display_name, type) VALUES ('owner', 'Owner', 'human')`);

  // messages — content auto-encrypts; we only ever read plaintext source/created_at.
  const msg = (id, source, ms) => q(
    `INSERT INTO messages (id, user_id, role, content, source, created_at) VALUES (?, ?, 'user', ?, ?, ?)`,
    [id, U, `body of ${id}`, source, iso(ms)]);
  await msg('m1', 'telegram_555', NOW - 5 * MIN);      // live (<15m), per-chat suffix
  await msg('m2', 'telegram-group', NOW - 2 * DAY);    // folds into telegram
  await msg('m3', 'discord-thread', NOW - 2 * HOUR);   // folds into discord
  await msg('m4', 'gmail', NOW - 1 * HOUR);            // connector source
  await msg('m5', 'frobnicator', NOW - 3 * HOUR);      // unknown → 'other'

  // documents — source_type 'obsidian' → knowledge.
  await q(`INSERT INTO documents (id, user_id, path, source_type, title, content, created_at, updated_at)
           VALUES (?, ?, ?, 'obsidian', ?, ?, ?, ?)`,
    ['d1', U, 'notes/a.md', 'A note', 'secret body', iso(NOW - 3 * DAY), iso(NOW - 3 * DAY)]);

  // health_daily — device kind (source default apple_health).
  await q(`INSERT INTO health_daily (id, user_id, date, source, created_at, updated_at)
           VALUES (?, ?, '2026-06-17', 'apple_health', ?, ?)`,
    ['owner:2026-06-17', U, iso(NOW - 4 * HOUR), iso(NOW - 4 * HOUR)]);

  // tasks — task kind; title auto-encrypts.
  await q(`INSERT INTO tasks (id, user_id, title, status, created_at) VALUES (?, ?, ?, 'pending', ?)`,
    ['t1', U, 'do the thing', iso(NOW - 1 * DAY)]);

  // connectors — gmail connected (→ synced), linear errored with NO messages (→
  // must still surface, status 'error', sorted first). account_label/last_error
  // left NULL (encrypted cols; not needed for the plaintext spectrum).
  await q(`INSERT INTO connectors (id, user_id, provider, status, last_ok_at) VALUES ('gmail', ?, 'google', 'connected', ?)`,
    [U, iso(NOW - 1 * HOUR)]);
  await q(`INSERT INTO connectors (id, user_id, provider, status, last_error_at) VALUES ('linear', ?, 'linear', 'error', ?)`,
    [U, iso(NOW - 5 * HOUR)]);

  const spec = await db.streams.spectrum(U, { windowDays: 7, nowMs: NOW });
  const by = Object.fromEntries(spec.sources.map((s) => [s.source, s]));

  rec('windowDays + days length', spec.windowDays === 7 && spec.days.length === 7, `days=${spec.days.length}`);

  // Variant collapse: telegram = m1 + m2 (group folded in), kind messaging.
  rec('telegram present, kind messaging', by.telegram && by.telegram.kind === 'messaging');
  rec('telegram folds in telegram-group (total 2)', by.telegram?.total === 2, `total=${by.telegram?.total}`);
  rec('no separate telegram-group entry', !by['telegram-group']);
  rec('discord present (from discord-thread)', by.discord && by.discord.kind === 'messaging');

  // Kinds across tables.
  rec('gmail kind connector', by.gmail?.kind === 'connector');
  rec('obsidian kind knowledge', by.obsidian?.kind === 'knowledge');
  rec('apple_health kind device', by.apple_health?.kind === 'device');
  rec('task kind task', by.task?.kind === 'task');
  rec("unknown 'frobnicator' kind other", by.frobnicator?.kind === 'other');

  // Status derivation.
  rec('telegram status live (<15m)', by.telegram?.status === 'live', `status=${by.telegram?.status}`);
  rec('gmail status synced (connector connected)', by.gmail?.status === 'synced', `status=${by.gmail?.status}`);
  rec('linear surfaces with 0 items, status error', by.linear && by.linear.total === 0 && by.linear.status === 'error');
  rec('discord status idle (2h, no connector)', by.discord?.status === 'idle', `status=${by.discord?.status}`);

  // Errored connector sorts FIRST so it's never missed.
  rec('errored linear sorted first', spec.sources[0]?.source === 'linear', `first=${spec.sources[0]?.source}`);

  // Sparkline: length == windowDays; telegram has a count on today and 2-days-ago.
  const tgSpark = by.telegram?.sparkline || [];
  rec('sparkline length == windowDays', tgSpark.length === 7, `len=${tgSpark.length}`);
  rec('telegram today bucket = 1 (m1)', tgSpark[6] === 1, `today=${tgSpark[6]}`);
  rec('telegram 2-days-ago bucket = 1 (m2)', tgSpark[4] === 1, `d-2=${tgSpark[4]}`);
  rec('telegram today count field = 1', by.telegram?.today === 1, `today=${by.telegram?.today}`);

  // lastActivity is the max created_at for the source.
  rec('telegram lastActivity = m1 time', by.telegram?.lastActivity === iso(NOW - 5 * MIN));

  // §7 FAIL-SAFE: the entire payload must carry NO content/ciphertext. The
  // spectrum reads only plaintext aggregates — assert no row leaks content/title/
  // preview/embedding, and that no string value looks like our base64 ciphertext.
  const json = JSON.stringify(spec);
  const noContentKeys = !/"(content|title|preview|text|summary|embedding|embedding_768|centroid)"/.test(json);
  rec('§7: no content/title/preview/embedding key in payload', noContentKeys);
  const bodies = ['body of m1', 'secret body', 'do the thing', 'A note'];
  rec('§7: no plaintext body leaks into spectrum', bodies.every((b) => !json.includes(b)));
  // crypto-local envelopes serialize with a "ct"/"iv" shape; none must appear.
  rec('§7: no ciphertext envelope (ct/iv) in payload', !/"(ct|iv|wrappedDek)"/.test(json));

  // Endpoint wired: same shape over HTTP.
  const app = express();
  app.use('/api/v1/portal', portalCompatRouter({ db, userId: U }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/portal/streams/spectrum?windowDays=7`);
  const httpJson = await res.json();
  rec('GET /streams/spectrum returns sources[]', res.status === 200 && Array.isArray(httpJson.sources) && httpJson.sources.length === by_count(spec));
  server.close();

  close();
  rmSync(dir, { recursive: true, force: true });

  const pass = ledger.filter(Boolean).length;
  console.log(`\n${pass}/${ledger.length} checks passed`);
  console.log(ledger.every(Boolean) ? 'VERDICT: GO — spectrum: plaintext-only, vector-free, status + sparkline correct' : 'VERDICT: NO-GO');
  process.exit(ledger.every(Boolean) ? 0 : 1);
}

function by_count(spec) { return spec.sources.length; }

main().catch((e) => { console.error('FAIL harness error:', e?.stack || e); process.exit(1); });
