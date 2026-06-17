// Throwaway: boot the worktree REST server with a seeded multi-source vault so the
// Streams source-spectrum can be screenshot in a real browser. NOT a gate.
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb } from '../src/db/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { importMasterKey } from '../src/crypto/crypto-local.js';
import { startRestServer } from '../src/server-rest.js';

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60000, HOUR = 3600000, DAY = 86400000;

const dir = mkdtempSync(join(tmpdir(), 'myc-streams-prev-'));
const dbPath = join(dir, 'v.db');
const kcvPath = join(dir, 'kcv.json');
applyMigrations(new Database(dbPath));
const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const userKey = await importMasterKey(userHex);
const systemKey = await importMasterKey(systemHex);
const { db, close } = getDb({ dbPath, userKey, systemKey });
const U = 'local-user';
const q = (sql, p = []) => db._base.d1Query(sql, p);

await q(`INSERT INTO users (id, display_name, type) VALUES (?, 'Owner', 'human')`, [U]);
const msg = (id, source, ms, role = 'user') => q(
  `INSERT INTO messages (id, user_id, role, content, source, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  [id, U, role, `body ${id}`, source, iso(ms)]);
// a spread of sources + volumes across the last week
for (let i = 0; i < 40; i++) await msg(`tg${i}`, 'telegram_555', NOW - (i % 7) * DAY - i * MIN);
for (let i = 0; i < 12; i++) await msg(`dc${i}`, 'discord_42', NOW - (i % 5) * DAY - i * HOUR);
for (let i = 0; i < 6; i++) await msg(`gm${i}`, 'gmail', NOW - (i % 4) * DAY - i * HOUR);
for (let i = 0; i < 52; i++) await msg(`cc${i}`, 'claude-code', NOW - (i % 7) * DAY - i * MIN, 'assistant');
await msg('tgnow', 'telegram_555', NOW - 2 * MIN);
await q(`INSERT INTO documents (id, user_id, path, source_type, title, content, created_at, updated_at) VALUES (?,?,?,'obsidian',?,?,?,?)`,
  ['d1', U, 'notes/a.md', 'A', 'x', iso(NOW - 3 * DAY), iso(NOW - 3 * DAY)]);
await q(`INSERT INTO health_daily (id, user_id, date, source, created_at, updated_at) VALUES (?,?,?,'apple_health',?,?)`,
  ['local-user:2026-06-17', U, '2026-06-17', iso(NOW - 4 * HOUR), iso(NOW - 4 * HOUR)]);
await q(`INSERT INTO tasks (id, user_id, title, status, created_at) VALUES (?,?,?,'pending',?)`, ['t1', U, 'do', iso(NOW - DAY)]);
await q(`INSERT INTO connectors (id, user_id, provider, status, last_ok_at) VALUES ('gmail', ?, 'google', 'connected', ?)`, [U, iso(NOW - HOUR)]);
await q(`INSERT INTO connectors (id, user_id, provider, status, last_error_at) VALUES ('linear', ?, 'linear', 'error', ?)`, [U, iso(NOW - 5 * HOUR)]);
close();

const server = await startRestServer({
  dbPath, kcvPath, userHex, systemHex,
  port: 8799, host: '127.0.0.1', portalMode: 'canonical',
});
console.log('STREAMS PREVIEW READY', server.url);
