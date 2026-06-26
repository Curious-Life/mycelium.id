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
import { captureMessage } from '../src/ingest/capture.js';

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
let lastSystem = '';   // the system preamble of the most recent Anthropic call (C10)
const mockFetch = async (url, opts) => {
  const u = String(url);
  fetchCount++;
  if (u.includes('api.anthropic.com')) {
    try { lastSystem = JSON.parse(opts?.body || '{}').system || ''; } catch { /* non-JSON body */ }
    if (mode === 'err') return errRes(400);
    if (mode === 'stall') return stallRes(sse([   // partial text, then stall (no stop, no [DONE])
      { type: 'message_start', message: { usage: { input_tokens: 9 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial answer' } },
    ]), opts?.signal);
    if (mode === 'stallempty') return stallRes([], opts?.signal);   // 200 but no tokens, then stall
    if (mode === 'trunc') return streamRes(sse([   // partial text then the output cap (stop_reason max_tokens)
      { type: 'message_start', message: { usage: { input_tokens: 9 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial cut-off answer' } },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 4096 } },
      '[DONE]',
    ]));
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
  // Active model is surfaced to the UI BEFORE any token (operator directive: show the model).
  const mi = types.indexOf('model'); const ti = types.indexOf('text_delta'); const mev = evs.find((e) => e.type === 'model');
  rec('C2 emits a `model` event (label+model) before text', mi >= 0 && mi < ti && mev?.label === 'Claude' && typeof mev?.model === 'string' && mev.model.length > 0, JSON.stringify(mev));
  rec('C2 `model` event carries NO secret (only label/model/jurisdiction)', mev && !JSON.stringify(mev).includes('KEY') && !('apiKey' in mev) && !('credentials' in mev));
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
  rec('C5 emits a graceful error event (after retries, no output)', !!err && /didn’t respond|didn’t recognise|rejected the request|rate-limited|server error|Chat failed/.test(err.message || ''), JSON.stringify(err));
  rec('C5 never leaks provider error detail', !JSON.stringify(evs).includes('invalid_request_error'));
}

// ── C6 stall AFTER partial output → keep the partial answer, no error ──
{
  process.env.MYCELIUM_CHAT_IDLE_MS = '1200';
  process.env.MYCELIUM_CHAT_TTFB_MS = '1200';
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
  process.env.MYCELIUM_CHAT_TTFB_MS = '1000';
  mode = 'stallempty';
  fetchCount = 0;
  const r = await fetch(`${base}/chat/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'empty stall' }) });
  const evs = await readSSE(r);
  mode = 'ok';
  delete process.env.MYCELIUM_CHAT_IDLE_MS;
  delete process.env.MYCELIUM_CHAT_TTFB_MS;
  rec('C7 retried the turn (>1 model connection attempt)', fetchCount > 1, `fetchCount=${fetchCount}`);
  rec('C7 ends in a graceful error after retries', evs.some((e) => e.type === 'error') && evs.some((e) => e.type === 'done'));
}

// ── C8 NO provider connected → explicit no_model refusal (NO silent Ollama) ──
{
  mode = 'ok';
  await db.providers.remove(pid, U);   // remove the only provider → none active
  const r = await fetch(`${base}/chat/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'hello with no model' }) });
  const evs = await readSSE(r);
  const types = evs.map((e) => e.type);
  const nm = evs.find((e) => e.type === 'no_model');
  rec('C8 no provider → `no_model` event (not a silent stream)', !!nm && typeof nm.message === 'string' && nm.message.length > 0, JSON.stringify(types));
  rec('C8 no_model → NO text_delta (did not silently fall back to Ollama)', !types.includes('text_delta'));
  rec('C8 no_model → ends with done', types[types.length - 1] === 'done');
}

// ── C9 truncation at the model's output cap → visible 'truncated' state, NOT a
//    silent success. (Re-add the provider so chat resolves a model.) ──
{
  mode = 'ok';
  const pid2 = await db.providers.create(U, { provider: 'anthropic', label: 'A', authType: 'api_key', credentials: JSON.stringify({ apiKey: 'KEY' }) });
  await db.providers.setActive(pid2, U);
  mode = 'trunc';
  const r = await fetch(`${base}/chat/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'write me a very long thing' }) });
  const evs = await readSSE(r);
  mode = 'ok';
  const tr = evs.find((e) => e.type === 'truncated');
  const done = evs.find((e) => e.type === 'done');
  const text = evs.filter((e) => e.type === 'text_delta').map((e) => e.content).join('');
  rec('C9 emits a `truncated` event with an actionable message', !!tr && typeof tr.message === 'string' && /cut off|incomplete|limit/i.test(tr.message), JSON.stringify(tr));
  rec('C9 `done` carries truncated:true (not a clean success)', !!done && done.truncated === true, JSON.stringify(done));
  rec('C9 keeps the partial text (no error event)', text === 'partial cut-off answer' && !evs.some((e) => e.type === 'error'), JSON.stringify(text));
}

// ── C10 conversation threading (Phase 5): prior turns in the SAME conversation are
//    hydrated into the system the model sees (multi-turn memory); history is scoped
//    to the thread — no bleed across conversations. ──
{
  mode = 'ok';
  const conv = `verify-conv-${crypto.randomUUID()}`;
  // Turn 1: state a fact under this conversation.
  await readSSE(await fetch(`${base}/chat/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Remember: my favourite colour is teal.', conversationId: conv }) }));
  // Persistence is fire-and-forget — poll the conversation for its two turns. The server
  // namespaces chat threads under `chat:` (red-team RT3), so query the prefixed id.
  let crows = [];
  for (let i = 0; i < 80; i++) { crows = (await db.messages.selectByConversation(U, `chat:${conv}`, { limit: 50 })) || []; if (crows.length >= 2) break; await new Promise((r2) => setTimeout(r2, 50)); }
  rec('C10 turn-1 user+assistant persisted under the conversationId', crows.length >= 2, `rows=${crows.length}`);
  // Turn 2 (same conversation): the system the model receives must carry the prior turn.
  lastSystem = '';
  await readSSE(await fetch(`${base}/chat/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'What is my favourite colour?', conversationId: conv }) }));
  rec('C10 prior turn hydrated into the system preamble (multi-turn memory)', /teal/i.test(lastSystem) && /Conversation so far|Earlier conversation/i.test(lastSystem), JSON.stringify(lastSystem.slice(-300)));
  // Scoped: this thread returns its turns; a different conversation is empty (no bleed).
  const hThis = await (await fetch(`${base}/chat/history?conversationId=${conv}`)).json();
  rec('C10 /chat/history scoped to the conversation', Array.isArray(hThis.messages) && hThis.messages.length >= 2 && hThis.messages.some((m) => /teal/i.test(m.content)));
  const hOther = await (await fetch(`${base}/chat/history?conversationId=does-not-exist`)).json();
  rec('C10 a different conversation has NO history bleed', Array.isArray(hOther.messages) && hOther.messages.length === 0);
}

// ── C11 RT3 isolation: a chat read can NEVER address a CHANNEL conversation ──
{
  // Seed a channel-style message under a bare chatId conversation (as the daemon persists).
  await captureMessage(db, { userId: U, role: 'user', content: 'SECRET third-party channel message', source: 'telegram', conversationId: '987654321' }, () => {});
  // A chat client asking for that id gets NOTHING — the server namespaces it to chat:987654321.
  const h = await (await fetch(`${base}/chat/history?conversationId=987654321`)).json();
  rec('C11 chat cannot read a channel conversation (RT3 namespace isolation)', Array.isArray(h.messages) && h.messages.length === 0 && !JSON.stringify(h.messages).includes('SECRET'), JSON.stringify(h.messages?.length));
}

// ── C12 orphaned-history recovery (the conversationId send-path fix) ──────────
{
  // An orphan: a chat turn saved with NULL conversation_id (the pre-fix WS path).
  await captureMessage(db, { userId: U, role: 'user', content: 'ORPHANED earlier chat turn', source: 'portal-chat' }, () => {});
  const fresh = `recover-thread-${Date.now()}`;
  // An empty thread reports a recoverable count (a COUNT, never the rows — no bleed).
  const h0 = await (await fetch(`${base}/chat/history?conversationId=${fresh}`)).json();
  rec('C12 empty thread reports recoverable orphan count (no bleed)',
    Array.isArray(h0.messages) && h0.messages.length === 0 && h0.recoverable >= 1 && !JSON.stringify(h0.messages).includes('ORPHANED'),
    `recoverable=${h0.recoverable}`);
  // Explicit recovery adopts the orphans INTO this thread.
  const rec1 = await (await fetch(`${base}/chat/history/recover`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: fresh }) })).json();
  rec('C12 recover adopts orphans into the thread + returns them',
    rec1.recovered >= 1 && Array.isArray(rec1.messages) && rec1.messages.some((m) => m.content === 'ORPHANED earlier chat turn'),
    `recovered=${rec1.recovered}`);
  // The thread now hydrates the recovered turns directly (they're threaded).
  const h1 = await (await fetch(`${base}/chat/history?conversationId=${fresh}`)).json();
  rec('C12 recovered turns now load as threaded history (recoverable drained to 0)',
    h1.messages.some((m) => m.content === 'ORPHANED earlier chat turn') && h1.recoverable === 0,
    `messages=${h1.messages.length} recoverable=${h1.recoverable}`);
  // Idempotent: a SECOND fresh thread finds nothing left to recover.
  const h2 = await (await fetch(`${base}/chat/history?conversationId=recover-thread-2-${Date.now()}`)).json();
  rec('C12 orphan pool drained once (idempotent — second thread has nothing to recover)', h2.recoverable === 0, `recoverable=${h2.recoverable}`);
}

server.close(); await close?.();
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — portal chat: auth fail-closed · streams · persists · policy-gated · truncation surfaced · leak-safe' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
