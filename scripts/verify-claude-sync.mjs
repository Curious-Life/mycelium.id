// verify:claude-sync — the Claude Code transcript sync + backfill (messages-only,
// full metadata, real timestamps, high-water mark) + the importMessages createdAt
// fix. Parser is unit-tested; on-stop + backfill are exercised end-to-end against
// a real (consent-opted-in) HTTP server.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { createHttpApp } from '../src/server-http.js';
import { applyMigrations } from '../src/db/migrate.js';
import { parseTranscript } from '../tools/memory-bridge/claude-code/transcript.mjs';

const hex = () => crypto.randomBytes(32).toString('hex');
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const settle = () => new Promise((r) => setTimeout(r, 30));
const BEARER = 'verify-claude-sync-' + 'q'.repeat(24);
process.env.MYCELIUM_MCP_BEARER = BEARER;

// ── Part A — parseTranscript (pure) ──────────────────────────────────────────
const SAMPLE = [
  { type: 'user', uuid: 'u1', sessionId: 's', timestamp: '2025-01-01T00:00:01.000Z', cwd: '/repo', gitBranch: 'main', version: '1.0', userType: 'external', message: { role: 'user', content: 'first human msg' } },
  { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: 's', timestamp: '2025-01-01T00:00:02.000Z', cwd: '/repo', gitBranch: 'main', message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'first reply' }] } },
  { type: 'assistant', uuid: 'a2', sessionId: 's', timestamp: '2025-01-01T00:00:03.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } }, // skip: no text
  { type: 'user', uuid: 'u2', sessionId: 's', timestamp: '2025-01-01T00:00:04.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } }, // skip: tool_result
  { type: 'assistant', uuid: 'a3', sessionId: 's', timestamp: '2025-01-01T00:00:05.000Z', message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'second reply after tool' }] } },
  { type: 'user', isSidechain: true, uuid: 'su1', sessionId: 's', timestamp: '2025-01-01T00:00:06.000Z', message: { role: 'user', content: 'subagent prompt' } },
  { type: 'ai-title', uuid: 'x1', message: { role: 'assistant', content: 'a title' } }, // skip: meta type
];
const dir = mkdtemp('cs-');
const TXP = join(dir, 't.jsonl');
writeFileSync(TXP, SAMPLE.map((e) => JSON.stringify(e)).join('\n') + '\n');
const { items } = parseTranscript(TXP);
const ids = items.map((i) => i.id);
rec('A1. captures every conversation msg, skips tool/meta entries', JSON.stringify(ids) === JSON.stringify(['u1', 'a1', 'a3', 'su1']), ids.join(','));
const a1 = items.find((i) => i.id === 'a1');
rec('A2. preserves metadata (cwd/gitBranch/model/parentUuid)', a1.metadata.cwd === '/repo' && a1.metadata.gitBranch === 'main' && a1.metadata.model === 'claude-opus-4-8' && a1.metadata.parentUuid === 'u1', JSON.stringify(a1.metadata));
rec('A3. preserves real timestamp as createdAt + session as conversationId', a1.createdAt === '2025-01-01T00:00:02.000Z' && a1.conversationId === 's');
rec('A4. sidechain → source claude-code/subagent + isSidechain', items.find((i) => i.id === 'su1').source === 'claude-code/subagent' && items.find((i) => i.id === 'su1').metadata.isSidechain === true);
const { items: tail } = parseTranscript(TXP, { sinceLine: 5 }); // skip first 5 lines
rec('A5. high-water mark (sinceLine) only returns new entries', tail.map((i) => i.id).join(',') === 'su1', tail.map((i) => i.id).join(','));

// ── server (consent opted-in) for Parts B–D ──────────────────────────────────
const DB = join('data', 'verify-claude-sync.db'), KCV = join('data', 'verify-claude-sync-kcv.json');
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const UH = hex(), SH = hex();
const pre = await boot({ dbPath: DB, kcvPath: KCV, userHex: UH, systemHex: SH, embedder: null });
try { await pre.db.users.create('local-user', 'local-user'); } catch {}
await pre.db.users.updateSettings('local-user', { agentCapture: { enabled: true } });
// B — importMessages createdAt → created_at column (not insert-time)
await pre.handlers.importMessages({ messages: [{ id: 'ts-1', role: 'user', content: 'timestamped', source: 'claude-code', timestamp: '2025-01-02T03:04:05.000Z' }] });
await pre.close();
const raw = new Database(DB, { readonly: true });
const createdAt = raw.prepare('SELECT created_at FROM messages WHERE id = ?').get('ts-1')?.created_at || '';
raw.close();
rec('B1. importMessages preserves timestamp as created_at column', /^2025-01-02T03:04:05/.test(createdAt), createdAt);

const { app } = await createHttpApp({ bootOpts: { dbPath: DB, kcvPath: KCV, userHex: UH, systemHex: SH, embedder: null } });
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const repost = async (id, content) => {
  const r = await fetch(`${base}/ingest/message`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${BEARER}` }, body: JSON.stringify({ content, role: 'user', source: 'claude-code', id }) });
  return (await r.json()).result || '';
};
const runNode = (file, env) => new Promise((resolve) => {
  const cp = spawn('node', [file], { env: { ...process.env, MYCELIUM_BASE_URL: base, MYCELIUM_MCP_BEARER: BEARER, ...env } });
  let out = '', err = ''; cp.stdout.on('data', (d) => (out += d)); cp.stderr.on('data', (d) => (err += d));
  cp.stdin && cp.stdin.end(env.__stdin || '');
  cp.on('close', (status) => resolve({ status, out, err }));
});

// C — on-stop syncs EVERY conversation message (skips tool/meta), via the transcript
const HOME = mkdtemp('cs-home-');
await runNode('tools/memory-bridge/claude-code/on-stop.mjs', { HOME, __stdin: JSON.stringify({ session_id: 'sync-sess', transcript_path: TXP }) });
await settle();
const dedup = (s) => /Already captured/.test(s);
const fresh = (s) => /^Captured message/.test(s);
rec('C1. on-stop captured u1+a1+a3+su1 (every conversation msg)', dedup(await repost('u1', 'first human msg')) && dedup(await repost('a1', 'first reply')) && dedup(await repost('a3', 'second reply after tool')) && dedup(await repost('su1', 'subagent prompt')));
rec('C2. on-stop SKIPPED tool_use (a2) + tool_result (u2)', fresh(await repost('a2', 'x')) && fresh(await repost('u2', 'y')));
const hwm = readFileSync(join(HOME, '.mycelium-bridge', 'cc-sync-sess.hwm'), 'utf8').trim();
rec('C3. high-water-mark file advanced', Number(hwm) >= 7, `hwm=${hwm}`);

// D — backfill scans a projects dir and imports
const PROJ = mkdtemp('cs-proj-');
mkdirSync(join(PROJ, 'someproj'), { recursive: true });
writeFileSync(join(PROJ, 'someproj', 'h.jsonl'), [JSON.stringify({ type: 'user', uuid: 'bf1', sessionId: 'bf', timestamp: '2025-03-03T00:00:00.000Z', message: { role: 'user', content: 'backfilled message' } })].join('\n') + '\n');
const bf = await runNode('scripts/backfill-claude-code.mjs', { CLAUDE_PROJECTS_DIR: PROJ });
await settle();
rec('D1. backfill imported the transcript', /1 new/.test(bf.out) && dedup(await repost('bf1', 'backfilled message')), (bf.out || bf.err).trim().split('\n').pop());

server.close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
for (const d of [dir, HOME, PROJ]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(70));
console.log(`VERDICT: ${allPass ? 'GO — transcript sync: every msg + metadata + real timestamps + HWM · importMessages created_at · backfill' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(70));
process.exit(allPass ? 0 : 1);

function mkdtemp(prefix) { const p = join(tmpdir(), prefix + crypto.randomBytes(4).toString('hex')); mkdirSync(p, { recursive: true }); return p; }
