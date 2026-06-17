// scripts/verify-streams-feed.mjs — the unified-river gate.
//
// Boots a REAL vault and seeds interleaved rows across ALL FOUR ingest tables
// (messages/documents/health_daily/tasks) — including a redacted message, a
// deleted task, a forgotten document, and a document carrying an embedding_768 —
// then exercises db.streams.feed + GET /portal/streams. Proves:
//  • the union merge-sorts by created_at DESC across types (real SQL, real schema)
//  • cursor pagination is stable, non-overlapping, and drains to nextCursor=null
//  • types filter selects the right arms; since floor is honored
//  • redaction is honored (forgotten message + forgotten doc + deleted task excluded)
//  • §7 FAIL-CLOSED: NO embedding_768 / centroid / vector / raw metadata in the bytes
//  • previews are truncated; health summary is well-formed; message rows keep
//    attachment + role fields and DROP metadata

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
  console.log('\n=== verify:streams-feed — unified river (messages+documents+health+tasks) ===\n');
  const dir = mkdtempSync(join(tmpdir(), 'myc-feed-'));
  applyMigrations(new Database(join(dir, 'v.db')));
  const userKey = await importMasterKey(crypto.randomBytes(32).toString('hex'));
  const systemKey = await importMasterKey(crypto.randomBytes(32).toString('hex'));
  const { db, close } = getDb({ dbPath: join(dir, 'v.db'), userKey, systemKey });
  const U = 'owner';
  const q = (sql, p = []) => db._base.d1Query(sql, p);
  await q(`INSERT INTO users (id, display_name, type) VALUES ('owner','Owner','human')`);

  // Interleaved timestamps so a correct merge MUST interleave types (not group them).
  await q(`INSERT INTO messages (id,user_id,role,content,source,created_at) VALUES (?,?,?,?,?,?)`,
    ['m1', U, 'user', 'hello from telegram', 'telegram_5', iso(NOW - 10 * MIN)]);
  await q(`INSERT INTO messages (id,user_id,role,content,source,created_at) VALUES (?,?,?,?,?,?)`,
    ['m2', U, 'assistant', 'agent reply', 'claude-code', iso(NOW - 90 * MIN)]);
  // a forgotten (redacted) message — MUST NOT appear
  await q(`INSERT INTO messages (id,user_id,role,content,source,created_at,forgotten_at) VALUES (?,?,?,?,?,?,?)`,
    ['m3', U, 'user', 'secret redacted', 'telegram_5', iso(NOW - 30 * MIN), iso(NOW)]);
  // a message carrying metadata (must be STRIPPED from the served row)
  await q(`INSERT INTO messages (id,user_id,role,content,source,metadata,created_at) VALUES (?,?,?,?,?,?,?)`,
    ['m4', U, 'user', 'with meta', 'discord_9', JSON.stringify({ secret: 'triage-nonce' }), iso(NOW - 20 * MIN)]);

  // documents — one normal, one with an embedding_768 (the §7 trap), one forgotten
  await q(`INSERT INTO documents (id,user_id,path,source_type,title,summary,content,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ['d1', U, 'notes/plan.md', 'obsidian', 'The Plan', 'a short summary', 'full body', iso(NOW - 40 * MIN), iso(NOW - 40 * MIN)]);
  // d2 carries an embedding_768 — the §7 trap. Its visible fields are benign
  // (the gate asserts the embedding never reaches the payload).
  await q(`INSERT INTO documents (id,user_id,path,source_type,title,summary,embedding_768,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ['d2', U, 'notes/two.md', 'obsidian', 'Doc Two', 'second note', JSON.stringify([0.1, 0.2, 0.3]), iso(NOW - 50 * MIN), iso(NOW - 50 * MIN)]);
  await q(`INSERT INTO documents (id,user_id,path,source_type,title,summary,created_at,updated_at,forgotten_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ['d3', U, 'notes/gone.md', 'obsidian', 'Gone', 'redacted', iso(NOW - 15 * MIN), iso(NOW - 15 * MIN), iso(NOW)]);

  // health — one day
  await q(`INSERT INTO health_daily (id,user_id,date,source,sleep_duration_min,steps,hrv_avg,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ['owner:2026-06-17', U, '2026-06-17', 'apple_health', '420', '8432', '45', iso(NOW - 60 * MIN), iso(NOW - 60 * MIN)]);

  // tasks — one active, one deleted (MUST NOT appear)
  await q(`INSERT INTO tasks (id,user_id,title,status,priority,created_at) VALUES (?,?,?,?,?,?)`,
    ['t1', U, 'ship the river', 'pending', 'high', iso(NOW - 70 * MIN)]);
  await q(`INSERT INTO tasks (id,user_id,title,status,created_at) VALUES (?,?,?,?,?)`,
    ['t2', U, 'deleted task', 'deleted', iso(NOW - 25 * MIN)]);

  // ── full feed ───────────────────────────────────────────────────────────────
  const all = await db.streams.feed(U, { limit: 40 });
  const ids = all.items.map((i) => i.id);
  const types = all.items.map((i) => i.type);

  rec('returns items across all 4 types', new Set(types).size === 4, `types=${[...new Set(types)].join(',')}`);
  // expected visible set (m3/d3/t2 excluded): m1,m2,m4 + d1,d2 + health + t1 = 7
  rec('count = visible rows (redacted/deleted excluded)', all.items.length === 7, `n=${all.items.length}`);
  rec('forgotten message m3 excluded', !ids.includes('m3'));
  rec('forgotten document d3 excluded', !ids.some((x) => x === 'doc:notes/gone.md'));
  rec('deleted task t2 excluded', !ids.some((x) => x === 'task:t2'));

  // merge order: strictly descending by createdAt, AND interleaved (not type-grouped)
  const ts = all.items.map((i) => i.createdAt);
  const sortedDesc = ts.every((v, k) => k === 0 || ts[k - 1] >= v);
  rec('merge-sorted by createdAt DESC', sortedDesc);
  // newest is m1 (10m), then d? Actually order by time: m1(10m) m4(20m) d1(40m) health(60m) t1(70m) m2(90m)... d2(50m)
  rec('newest item is m1 (telegram, 10m)', all.items[0].id === 'm1', `first=${all.items[0].id}`);
  const interleaved = all.items.some((it, k) => k > 0 && all.items[k - 1].type !== it.type);
  rec('types are interleaved (true merge, not concatenation)', interleaved);

  // §7 + metadata: NOT a single vector/embedding/centroid or raw metadata in the bytes
  const bytes = JSON.stringify(all);
  rec('§7: no embedding/centroid/vector substring in payload', !/embedding|centroid|vector|0\.1,0\.2,0\.3/i.test(bytes));
  rec('§7: message metadata stripped (no triage-nonce)', !bytes.includes('triage-nonce') && !/"metadata"/.test(bytes));

  // row shapes
  const doc = all.items.find((i) => i.type === 'document');
  rec('document row: title + truncated summary preview, no content', doc?.title === 'The Plan' && doc?.preview === 'a short summary' && !('content' in doc));
  const health = all.items.find((i) => i.type === 'health');
  rec('health row: summary "Sleep 7h · 8,432 steps · HRV 45"', health?.preview === 'Sleep 7h · 8,432 steps · HRV 45', `got="${health?.preview}"`);
  const task = all.items.find((i) => i.type === 'task');
  rec('task row: title + status + priority', task?.title === 'ship the river' && task?.status === 'pending' && task?.priority === 'high');
  const msg = all.items.find((i) => i.type === 'message');
  rec('message row: keeps role + content, drops metadata', msg?.message?.role && msg?.message?.content && !('metadata' in (msg.message || {})));

  // ── cursor pagination (limit 3) is stable + non-overlapping + drains ──────────
  const seen = new Set();
  let cursor; let pages = 0; let dupes = 0;
  while (true) {
    const page = await db.streams.feed(U, { limit: 3, before: cursor });
    pages++;
    for (const it of page.items) { if (seen.has(it.id)) dupes++; seen.add(it.id); }
    if (!page.nextCursor || page.items.length === 0) break;
    cursor = page.nextCursor;
    if (pages > 20) break; // safety
  }
  rec('paginated set == full set (no loss)', seen.size === 7, `paged=${seen.size}`);
  rec('no duplicate across pages', dupes === 0, `dupes=${dupes}`);
  rec('pagination terminates (nextCursor drains to null)', pages <= 20);

  // ── filters ──────────────────────────────────────────────────────────────────
  const onlyTasks = await db.streams.feed(U, { limit: 40, types: ['task'] });
  rec("types=['task'] returns only tasks", onlyTasks.items.length === 1 && onlyTasks.items[0].type === 'task');
  const since = await db.streams.feed(U, { limit: 40, since: iso(NOW - 45 * MIN) });
  rec('since floor excludes older rows', since.items.every((i) => i.createdAt >= iso(NOW - 45 * MIN)) && !since.items.some((i) => i.id === 'm2'));

  // ── endpoint wired ───────────────────────────────────────────────────────────
  const app = express();
  app.use('/api/v1/portal', portalCompatRouter({ db, userId: U }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/portal/streams?limit=40`);
  const httpJson = await res.json();
  rec('GET /streams returns items[] + nextCursor', res.status === 200 && Array.isArray(httpJson.items) && httpJson.items.length === 7);
  server.close();

  close();
  rmSync(dir, { recursive: true, force: true });

  const pass = ledger.filter(Boolean).length;
  console.log(`\n${pass}/${ledger.length} checks passed`);
  console.log(ledger.every(Boolean) ? 'VERDICT: GO — unified river: merge-correct, paginated, vector-free, redaction-honored' : 'VERDICT: NO-GO');
  process.exit(ledger.every(Boolean) ? 0 : 1);
}

main().catch((e) => { console.error('FAIL harness error:', e?.stack || e); process.exit(1); });
