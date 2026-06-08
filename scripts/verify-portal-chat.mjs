// verify:portal-chat — the in-app chat route (src/portal-chat.js) end-to-end over
// a REAL booted vault, with a STUBBED provider stream (no live key).
//   C1 GET /agents → single agent (auth); 401 fail-closed when unauthorized
//   C2 POST /chat/stream → streams text, persists user+assistant as 'portal-chat'
//   C3 GET /chat/history → returns the turns; NEVER leaks entities/tags/metadata
//   C4 PUT/GET /ai-access → policy round-trips; toolsForDomains filters fail-closed
//   C5 stream error (provider 400) → 'error' SSE event, no crash, no plaintext leak
import express from 'express';
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { portalChatRouter } from '../src/portal-chat.js';
import { toolsForDomains } from '../src/agent/tool-domains.js';

const DB = 'data/verify-portal-chat.db', KCV = 'data/verify-portal-chat-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const { db, tools, handlers, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex: crypto.randomBytes(32).toString('hex'), systemHex: crypto.randomBytes(32).toString('hex'), embedder: null });
const U = 'local-user';

// Active Anthropic provider → resolveInferenceConfig returns anthropicApiKey →
// harness uses the Anthropic adapter → we stub api.anthropic.com.
const pid = await db.providers.create(U, { provider: 'anthropic', label: 'A', authType: 'api_key', credentials: JSON.stringify({ apiKey: 'KEY' }) });
await db.providers.setActive(pid, U);

const enc = new TextEncoder();
const sse = (objs) => objs.map((o) => (o === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(o)}\n\n`));
const streamRes = (chunks) => ({ ok: true, status: 200, body: new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(enc.encode(x)); c.close(); } }) });
const errRes = (status) => ({ ok: false, status, async text() { return '{"error":{"type":"invalid_request_error"}}'; } });
const ANSWER = 'Hello, I can help with that.';
const okStream = streamRes(sse([
  { type: 'message_start', message: { usage: { input_tokens: 9 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ANSWER } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
  '[DONE]',
]));

// A stream that emits `chunks` then STALLS (never closes); honoring the abort
// signal the way real fetch does (the body reader rejects when aborted).
const stallRes = (chunks, signal) => ({ ok: true, status: 200, body: new ReadableStream({
  start(c) {
    for (const x of chunks) c.enqueue(enc.encode(x));
    if (signal) signal.addEventListener('abort', () => { try { c.error(new DOMException('aborted', 'AbortError')); } catch {} }, { once: true });
  },
}) });

let mode = 'ok';
let fetchCount = 0;
const mockFetch = async (url, opts) => {
  const u = String(url);
  fetchCount++;
  if (u.includes('api.anthropic.com')) {
    if (mode === 'err') return errRes(400);
    if (mode === 'stall') return stallRes(sse([   // partial text, then stall (no stop, no [DONE])
      { type: 'message_start', message: { usage: { input_tokens: 9 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial answer' } },
    ]), opts?.signal);
    if (mode === 'stallempty') return stallRes([], opts?.signal);   // 200 but no tokens, then stall
    return streamRes(sse([
      { type: 'message_start', message: { usage: { input_tokens: 9 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ANSWER } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
      '[DONE]',
    ]));
  }
  return errRes(404);
};

let authorized = true;
const app = express();
app.use('/api/v1/portal', portalChatRouter({ db, userId: U, tools, handlers, enqueueEnrichment: () => {}, authenticatePortalRequest: () => (authorized ? { id: U } : null), fetch: mockFetch }));
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}/api/v1/portal`;

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };
const readSSE = async (res) => { const t = await res.text(); return t.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).filter((d) => d !== '[DONE]').map((d) => { try { return JSON.parse(d); } catch { return null; } }).filter(Boolean); };

// ── C1 agents + auth ──
{
  const r = await fetch(`${base}/agents`); const j = await r.json();
  rec('C1 /agents → single personal-agent online', r.status === 200 && j.agents?.length === 1 && j.agents[0].id === 'personal-agent' && j.agents[0].status === 'online');
  authorized = false; const r2 = await fetch(`${base}/agents`); authorized = true;
  rec('C1 unauthorized → 401 (fail-closed)', r2.status === 401);
}

// ── C2 stream happy path + persistence ──
{
  const r = await fetch(`${base}/chat/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'what can you do?' }) });
  const evs = await readSSE(r);
  const types = evs.map((e) => e.type);
  const text = evs.filter((e) => e.type === 'text_delta').map((e) => e.content).join('');
  rec('C2 SSE: stream_start … text_delta … done', types[0] === 'stream_start' && types.includes('text_delta') && types[types.length - 1] === 'done');
  rec('C2 streamed the model answer', text === ANSWER, JSON.stringify(text));
  // Persistence is fire-and-forget — poll selectRecent for the two portal-chat rows.
  let rows = [];
  for (let i = 0; i < 60; i++) { rows = ((await db.messages.selectRecent(U, { limit: 50 })) || []).filter((x) => x.source === 'portal-chat'); if (rows.length >= 2) break; await new Promise((r2) => setTimeout(r2, 50)); }
  rec('C2 persisted user + assistant as portal-chat', rows.length >= 2 && rows.some((x) => x.role === 'assistant' && x.content === ANSWER) && rows.some((x) => x.role === 'user' && x.content === 'what can you do?'), `rows=${rows.length}`);
}

// ── C3 history shape (no sensitive-field leak) ──
{
  const r = await fetch(`${base}/chat/history?limit=50`); const j = await r.json();
  const contents = (j.messages || []).map((m) => m.content);
  rec('C3 history returns both turns', Array.isArray(j.messages) && j.messages.length >= 2 && contents.includes(ANSWER) && contents.includes('what can you do?'));
  const keys = new Set(j.messages.flatMap((m) => Object.keys(m)));
  rec('C3 history omits entities/tags/metadata/embedding (§1/§7)', !['entities', 'tags', 'metadata', 'embedding_768', 'scope', 'agent_id'].some((k) => keys.has(k)), [...keys].join(','));
}

// ── C4 access policy round-trip + filter ──
{
  const put = await fetch(`${base}/ai-access`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domains: ['context', 'search'], scopes: ['personal'], includeSensitiveOnCloud: false }) });
  const pj = await put.json();
  rec('C4 PUT /ai-access saves a restricted policy', put.status === 200 && pj.policy.domains.join(',') === 'context,search');
  const get = await fetch(`${base}/ai-access`); const gj = await get.json();
  rec('C4 GET /ai-access returns policy + domain catalog', gj.policy.domains.join(',') === 'context,search' && Array.isArray(gj.domains) && gj.domains.length >= 10);
  // Filter is fail-closed: only granted domains' tools survive; unmapped never exposed.
  const { tools: granted, unmapped } = toolsForDomains(tools, ['context']);
  rec('C4 toolsForDomains exposes only granted domain tools', granted.every((t) => t.name === 'getContext') && granted.length >= 1, granted.map((t) => t.name).join(','));
  rec('C4 ungranted/unmapped tools are never exposed', !granted.some((t) => t.name === 'forget') && Array.isArray(unmapped));
  // restore broad policy for any later runs
  await fetch(`${base}/ai-access`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domains: undefined }) });
}

// ── C5 provider error every attempt → graceful error event, no crash, no leak ──
{
  mode = 'err';
  const r = await fetch(`${base}/chat/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'trigger error' }) });
  const evs = await readSSE(r);
  mode = 'ok';
  const err = evs.find((e) => e.type === 'error');
  rec('C5 emits a graceful error event (after retries, no output)', !!err && /didn’t respond|Chat failed/.test(err.message || ''), JSON.stringify(err));
  rec('C5 never leaks provider error detail', !JSON.stringify(evs).includes('invalid_request_error'));
}

// ── C6 stall AFTER partial output → keep the partial answer, no error ──
{
  process.env.MYCELIUM_CHAT_IDLE_MS = '1200';
  mode = 'stall';
  const r = await fetch(`${base}/chat/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'stall after text' }) });
  const evs = await readSSE(r);
  mode = 'ok';
  const text = evs.filter((e) => e.type === 'text_delta').map((e) => e.content).join('');
  rec('C6 keeps partial text on a mid-stream stall', text === 'partial answer', JSON.stringify(text));
  rec('C6 finalizes (done) with NO error over a partial answer', evs.some((e) => e.type === 'done') && !evs.some((e) => e.type === 'error'));
}

// ── C7 stall with NO output → auto-retry the turn, then a graceful error ──
{
  process.env.MYCELIUM_CHAT_IDLE_MS = '1000';
  mode = 'stallempty';
  fetchCount = 0;
  const r = await fetch(`${base}/chat/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'empty stall' }) });
  const evs = await readSSE(r);
  mode = 'ok';
  delete process.env.MYCELIUM_CHAT_IDLE_MS;
  rec('C7 retried the turn (>1 model connection attempt)', fetchCount > 1, `fetchCount=${fetchCount}`);
  rec('C7 ends in a graceful error after retries', evs.some((e) => e.type === 'error') && evs.some((e) => e.type === 'done'));
}

server.close(); await close?.();
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — portal chat: auth fail-closed · streams · persists · policy-gated · leak-safe' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
