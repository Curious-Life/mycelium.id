// verify:agent-activity — the Agents activity timeline (src/portal-agent-activity.js) over a
// REAL booted vault + REAL loopback HTTP server. Proves the empty/false-disconnected page is
// replaced by a real timeline sourced from harness_runs + scheduled_tasks + channel_write_audit.
//   A1 auth required (no session → 401)
//   A2 timeline unifies chat/channel/scheduler runs with who/where labels
//   A3 scheduled cycles surfaced (schedule, next/last run, ran-or-not)
//   A4 list is content-free (no message text / fact value leaks)
//   A5 inspect returns the run's conversation (owner's decrypted messages) + hash-only writes
//   A6 unknown run id → 404
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { captureMessage } from '../src/ingest/capture.js';
import { portalAgentActivityRouter } from '../src/portal-agent-activity.js';

const DB = 'data/verify-agent-activity.db', KCV = 'data/verify-agent-activity-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex: crypto.randomBytes(32).toString('hex'), systemHex: crypto.randomBytes(32).toString('hex'), embedder: null });
const U = 'local-user';
try { await db.users.create(U, U); } catch {}

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

// ── Seed: a scheduled cycle + three runs (chat/channel/scheduler) + a channel write + a message ──
const SECRET_MSG = 'my therapist appointment is Tuesday — INSPECT-SECRET-XYZ';
const CHAN_CONV = 'channel:telegram:55';
const taskId = await db.harness.createTask(U, { name: 'Morning brief', prompt: 'brief me — TASK-SECRET-ABC', schedule: 'daily:8', nextRun: new Date(Date.now() + 3600_000).toISOString() });
await db.harness.markTaskRun(U, taskId, { nextRun: new Date(Date.now() + 90000_000).toISOString(), lastStatus: 'success' });

const r1 = await db.harness.openRun({ userId: U, trigger: 'chat', conversationId: 'chat:c1', promptHash: 'h1' });
await db.harness.finishRun(r1, { status: 'done', inputTokens: 100, outputTokens: 40 });
await captureMessage(db, { userId: U, role: 'user', content: SECRET_MSG, source: 'telegram', conversationId: CHAN_CONV, createdAt: new Date().toISOString() }, () => {});
const r2 = await db.harness.openRun({ userId: U, trigger: 'channel', conversationId: CHAN_CONV, promptHash: 'h2' });
await db.harness.finishRun(r2, { status: 'done', inputTokens: 60, outputTokens: 20 });
await db.harness.recordWrite({ userId: U, conversationId: CHAN_CONV, trigger: 'channel', tool: 'remember', argHash: 'abc123def4560000' });
const r3 = await db.harness.openRun({ userId: U, trigger: 'scheduler', taskId, conversationId: null, promptHash: 'h3' });
await db.harness.finishRun(r3, { status: 'done', inputTokens: 200, outputTokens: 80 });

// ── Server with an auth stub (x-test-auth: ok ⇒ owner) ──
const app = express();
app.use('/api/v1/portal', portalAgentActivityRouter({ db, userId: U, authenticatePortalRequest: (req) => (req.headers['x-test-auth'] === 'ok' ? U : null) }));
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/api/v1/portal/agent-activity`;
const get = (path = '', authed = true) => fetch(`${base}${path}`, { headers: authed ? { 'x-test-auth': 'ok' } : {} });

// ── A1 auth ──
{
  const r = await get('', false);
  rec('A1 no session → 401', r.status === 401);
}
// ── A2 unified runs + labels ──
let body;
{
  const r = await get('');
  body = await r.json();
  const ev = body.events || [];
  const chat = ev.find((e) => e.trigger === 'chat');
  const chan = ev.find((e) => e.trigger === 'channel');
  const sched = ev.find((e) => e.trigger === 'scheduler');
  rec('A2 timeline unifies all three triggers', !!chat && !!chan && !!sched, `n=${ev.length} triggers=${ev.map((e) => e.trigger).join(',')}`);
  rec('A2 chat run labelled who=You / where=app chat', chat?.who === 'You' && chat?.where === 'app chat');
  rec('A2 channel run labelled by platform (Telegram)', chan?.who === 'Telegram message' && chan?.where === 'telegram');
  rec('A2 scheduler run labelled with the task name', sched?.who === 'Scheduled cycle' && sched?.where === 'Morning brief', `where=${sched?.where}`);
  rec('A2 events carry status + token counts', chat?.status === 'done' && chat?.outputTokens === 40);
}
// ── A3 cycles ──
{
  const cy = body.cycles || [];
  const c = cy.find((x) => x.id === taskId);
  rec('A3 scheduled cycle surfaced (schedule + ran indicator)', !!c && c.schedule === 'daily:8' && c.lastStatus === 'success' && c.runCount >= 1, JSON.stringify({ s: c?.schedule, ls: c?.lastStatus, rc: c?.runCount }));
  rec('A3 cycle shows an upcoming next run', !!c?.nextRun);
}
// ── A4 content-free list ──
{
  const s = JSON.stringify(body);
  rec('A4 timeline list leaks NO message/fact/prompt plaintext', !s.includes('INSPECT-SECRET-XYZ') && !s.includes('TASK-SECRET-ABC'));
}
// ── A5 inspect returns conversation + hash-only writes ──
{
  const r = await get(`/${r2}`);
  const j = await r.json();
  rec('A5 inspect returns the run', j.run?.id === r2 && j.run?.trigger === 'channel');
  rec('A5 inspect returns the conversation (owner decrypted message)', Array.isArray(j.messages) && j.messages.some((m) => m.content === SECRET_MSG), `msgs=${j.messages?.length}`);
  rec('A5 inspect surfaces the vault write (hash-only, no value)', Array.isArray(j.writes) && j.writes.some((w) => w.tool === 'remember' && w.argHash === 'abc123def4560000') && !JSON.stringify(j.writes).includes('value'));
}
// ── A6 unknown id → 404 ──
{
  const r = await get('/does-not-exist');
  rec('A6 unknown run id → 404', r.status === 404);
}

await new Promise((r) => server.close(r));
await close?.();
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — agent activity: unified runs+cycles · who/where labels · content-free list · inspect conversation + hash-only writes · auth-gated' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
