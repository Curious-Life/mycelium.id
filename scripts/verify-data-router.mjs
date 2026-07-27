// verify:data-router — Settings→Data HTTP surface (src/portal-data.js).
//
//   R1 GET /data/summary returns per-family + per-type counts
//   R2 FAIL-CLOSED: POST /data/delete with a WRONG confirm token → 400, nothing deleted
//   R3 POST /data/delete with confirm===key runs the job; progress reaches done; rows gone
//   R4 unknown mode → 400
//   R5 re-POST is safe (single-flight/idempotent — never 500s)
//
// Boots a temp vault, mounts the real router on an ephemeral port, drives it over HTTP.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import Database from 'better-sqlite3';
import express from 'express';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { portalDataRouter } from '../src/portal-data.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

const DB = 'data/verify-data-router.db', KCV = 'data/verify-data-router-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const { db, close } = await boot({
  dbPath: DB, kcvPath: KCV,
  userHex: crypto.randomBytes(32).toString('hex'),
  systemHex: crypto.randomBytes(32).toString('hex'),
  embedder: null,
});
const U = 'local-user';
// Seed a deletable import (hermes): 3 messages + 1 document.
for (let i = 0; i < 3; i++) {
  await db.rawQuery(`INSERT INTO messages (id, user_id, source, message_type, content, created_at) VALUES (?,?,?,?,?,?)`,
    [`hm-${i}`, U, 'import-hermes', 'chat', 'x', '2026-01-01T00:00:00.000Z']);
}
await db.rawQuery(`INSERT INTO documents (id, user_id, source_type, path, title, content, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
  ['hd-0', U, 'import_hermes', 'import/hermes/x', 't', 'c', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']);
// Two NATIVE chat messages (Phase 2 delete-by-type 'chat' must reach these).
for (let i = 0; i < 2; i++) {
  await db.rawQuery(`INSERT INTO messages (id, user_id, source, message_type, content, created_at) VALUES (?,?,?,?,?,?)`,
    [`nc-${i}`, U, 'portal-chat', 'chat', 'x', '2026-01-02T00:00:00.000Z']);
}

const app = express();
app.use('/api/v1/portal', portalDataRouter({ db, userId: U, searchHelpers: { noteDelete: async () => {} } }));
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/api/v1/portal`;
const J = async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) });
const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(J);
const get = (p) => fetch(base + p).then(J);
const cnt = async (sql, p = []) => Number((await db.rawQuery(sql, p)).results?.[0]?.c ?? 0);

// R1 summary
const sum = await get('/data/summary');
const herm = (sum.body.sources || []).find((s) => s.source === 'import-hermes');
rec('R1 summary lists import-hermes family with counts', sum.status === 200 && herm?.messages === 3 && herm?.documents === 1,
  `sources=${JSON.stringify(sum.body.sources)}`);

// R2 fail-closed on wrong confirm
const bad = await post('/data/delete', { mode: 'source', key: 'import-hermes', confirm: 'nope' });
const stillThere = await cnt(`SELECT COUNT(*) c FROM messages WHERE user_id=? AND source='import-hermes'`, [U]);
rec('R2 FAIL-CLOSED: wrong confirm → 400, nothing deleted', bad.status === 400 && stillThere === 3, `status=${bad.status} remaining=${stillThere}`);

// R4 unknown mode → 400
const badMode = await post('/data/delete', { mode: 'everything', key: 'x', confirm: 'x' });
rec('R4 unknown mode → 400', badMode.status === 400);

// R6 delete-by-type validation: an UNKNOWN type is rejected (valid types accepted below).
const badType = await post('/data/delete', { mode: 'type', key: 'bogus', confirm: 'bogus' });
rec('R6 unknown type → 400', badType.status === 400);

// R3 real delete
const del = await post('/data/delete', { mode: 'source', key: 'import-hermes', confirm: 'import-hermes' });
// R5 immediate re-POST must not 500 (single-flight returns progress or a fresh idle)
const rePost = await post('/data/delete', { mode: 'source', key: 'import-hermes', confirm: 'import-hermes' });
rec('R5 re-POST is safe (no 500)', del.status === 200 && rePost.status === 200, `del=${del.status} re=${rePost.status}`);

// Poll to completion.
let prog = del.body, tries = 0;
while (prog.status === 'running' && tries++ < 50) { await new Promise((r) => setTimeout(r, 50)); prog = (await get('/data/delete/progress')).body; }
const gone = await cnt(`SELECT COUNT(*) c FROM messages WHERE user_id=? AND source='import-hermes'`, [U]);
const docsGone = await cnt(`SELECT COUNT(*) c FROM documents WHERE user_id=? AND source_type='import_hermes'`, [U]);
rec('R3 delete job completes; hermes messages+doc gone', ['done', 'cancelled'].includes(prog.status) && gone === 0 && docsGone === 0,
  `status=${prog.status} msgs=${gone} docs=${docsGone}`);

// R7 Phase 2: delete-by-type 'chat' is now ACCEPTED and reaches NATIVE chat.
const chatBefore = await cnt(`SELECT COUNT(*) c FROM messages WHERE user_id=? AND message_type='chat'`, [U]);
const tdel = await post('/data/delete', { mode: 'type', key: 'chat', confirm: 'chat' });
let tprog = tdel.body, t2 = 0;
while (tprog.status === 'running' && t2++ < 50) { await new Promise((r) => setTimeout(r, 50)); tprog = (await get('/data/delete/progress')).body; }
const chatAfter = await cnt(`SELECT COUNT(*) c FROM messages WHERE user_id=? AND message_type='chat'`, [U]);
rec('R7 delete-by-type chat accepted + removes native chat', tdel.status === 200 && chatBefore === 2 && tprog.status === 'done' && chatAfter === 0,
  `status=${tdel.status} before=${chatBefore} after=${chatAfter} job=${tprog.status}`);

server.close(); close?.();
const passed = ledger.filter(Boolean).length;
console.log(`\n${passed}/${ledger.length} checks passed`);
if (passed !== ledger.length) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO');
