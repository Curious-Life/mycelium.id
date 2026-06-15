// verify:memory-bridge — the universal memory layer (capture + context).
//
// Two parts, mirroring the design's two non-MCP doors:
//   Part A (real HTTP server): POST /context (pull) + POST /ingest/message (push,
//     idempotent) + the Claude Code on-stop.mjs adapter end-to-end over the wire.
//   Part B (gateway handlers, mock fetch — like verify:gateway): the opt-in
//     X-Mycelium-Capture flow — inject getContext as a system preamble, capture
//     ONLY the last user turn + the assistant reply, default-off, fire-and-forget.
//
// Asserts the load-bearing invariants from UNIVERSAL-MEMORY-LAYER-DESIGN: id-keyed
// dedup (resend = no-op), capture-last-turn-only (never the whole history), context
// injected as system (not miscaptured as user), no-header → zero capture, and a
// throwing capture sink never breaks inference.
import express from 'express';
import Database from 'better-sqlite3';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createGatewayHandlers } from '../src/gateway/openai-compat.js';
import { createHttpApp } from '../src/server-http.js';

const hex = () => crypto.randomBytes(32).toString('hex');
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const BEARER = 'verify-memory-bridge-' + 'x'.repeat(24);
process.env.MYCELIUM_MCP_BEARER = BEARER;

// ─────────────────────────── Part A — real HTTP server ───────────────────────
const A_DB = 'data/verify-membridge-a.db', A_KCV = 'data/verify-membridge-a-kcv.json';
for (const f of [A_DB, A_KCV, `${A_DB}-shm`, `${A_DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(A_DB));
const { app } = await createHttpApp({ bootOpts: { dbPath: A_DB, kcvPath: A_KCV, userHex: hex(), systemHex: hex(), embedder: null } });
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const post = (p, b, h = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${BEARER}`, ...h }, body: JSON.stringify(b || {}) });
const J = async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) });

// B1 — /context: fail-closed without bearer; returns vault text; honors maxChars.
let r = await fetch(base + '/context', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
rec('B1a. /context without bearer → 401 (fail-closed)', r.status === 401, `status=${r.status}`);
r = await J(await post('/context', {}));
rec('B1b. /context returns vault context text', r.status === 200 && r.body.ok === true && typeof r.body.text === 'string' && r.body.text.length > 0, `len=${r.body.text?.length}`);
r = await J(await post('/context', { maxChars: 40 }));
rec('B1c. /context honors maxChars cap', r.status === 200 && r.body.text.length <= 40, `len=${r.body.text?.length}`);

// B2 — /ingest/message: capture, then id-keyed dedup (resend = no-op), then update.
// The route returns the captureMessage HANDLER string ("Captured message <id>." for
// a new/updated row, "Already captured …" for a dedup no-op).
const isNew = (s) => typeof s === 'string' && /^Captured message/.test(s);
const isDedup = (s) => typeof s === 'string' && /Already captured/.test(s);
r = await J(await post('/ingest/message', { content: 'bridge hello', role: 'user', id: 'mb-1', conversationId: 'c-A' }));
rec('B2a. capture new → "Captured message"', r.status === 200 && r.body.ok === true && isNew(r.body.result), JSON.stringify(r.body.result));
r = await J(await post('/ingest/message', { content: 'bridge hello', role: 'user', id: 'mb-1', conversationId: 'c-A' }));
rec('B2b. resend same id+content → dedup no-op (no dup row)', isDedup(r.body.result), JSON.stringify(r.body.result));
r = await J(await post('/ingest/message', { content: 'bridge hello EDITED', role: 'user', id: 'mb-1' }));
rec('B2c. same id, changed content → re-captured (not a silent dedup)', isNew(r.body.result), JSON.stringify(r.body.result));

// B6 — Claude Code on-stop adapter, end-to-end against the live server.
const T_PATH = 'data/verify-membridge-transcript.jsonl';
const tx = [
  { type: 'user', uuid: 'u-human', message: { role: 'user', content: 'hello from the human' } },
  { type: 'assistant', uuid: 'a-toolonly', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } },
  { type: 'user', uuid: 'u-toolresult', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
  { type: 'assistant', uuid: 'a-final', message: { role: 'assistant', content: [{ type: 'text', text: 'final assistant reply' }] } },
];
writeFileSync(T_PATH, tx.map((e) => JSON.stringify(e)).join('\n') + '\n');
await new Promise((resolve) => {
  const child = spawn('node', ['tools/memory-bridge/claude-code/on-stop.mjs'], {
    env: { ...process.env, MYCELIUM_BASE_URL: base, MYCELIUM_MCP_BEARER: BEARER },
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  child.stdin.end(JSON.stringify({ session_id: 'cc-sess-1', transcript_path: T_PATH }));
  child.on('exit', resolve);
});
await settle();
// Re-POST the SAME ids+content: if on-stop already captured them, these dedup.
const human = await J(await post('/ingest/message', { content: 'hello from the human', role: 'user', id: 'u-human' }));
const final = await J(await post('/ingest/message', { content: 'final assistant reply', role: 'assistant', id: 'a-final' }));
const skipped = await J(await post('/ingest/message', { content: 'ok', role: 'user', id: 'u-toolresult' }));
rec('B6a. on-stop captured the human user turn (re-post dedups by uuid)', isDedup(human.body.result), JSON.stringify(human.body.result));
rec('B6b. on-stop captured the final assistant text (re-post dedups by uuid)', isDedup(final.body.result), JSON.stringify(final.body.result));
rec('B6c. on-stop SKIPPED the tool_result user entry (re-post is fresh)', isNew(skipped.body.result), JSON.stringify(skipped.body.result));

server.close();
for (const f of [A_DB, A_KCV, `${A_DB}-shm`, `${A_DB}-wal`, T_PATH]) { try { rmSync(f); } catch {} }

// ─────────────────── Part B — gateway capture+inject (mock fetch) ─────────────
const B_DB = 'data/verify-membridge-b.db', B_KCV = 'data/verify-membridge-b-kcv.json';
for (const f of [B_DB, B_KCV, `${B_DB}-shm`, `${B_DB}-wal`]) { try { rmSync(f); } catch {} }
applyMigrations(new Database(B_DB));
const { db, close } = await boot({ dbPath: B_DB, kcvPath: B_KCV, userHex: hex(), systemHex: hex(), embedder: null });
const U = 'local-user';
const pid = await db.providers.create(U, { provider: 'openai', label: 'US-Test', authType: 'api_key', credentials: JSON.stringify({ apiKey: 'GOODKEY' }), model: 'gpt-test', baseUrl: 'https://api.us-test.example/v1' });
await db.providers.setActive(pid, U);

const CLOUD_TEXT = 'cloud-reply-xyz';
const MARK = 'USER_MARK_42';
const CTX = 'CTX_MARKER_vault_context';
let lastCloudBody = null;
const mkRes = (obj) => ({ ok: true, status: 200, async text() { return JSON.stringify(obj); }, async json() { return obj; } });
const enc = new TextEncoder();
const streamRes = (chunks) => ({ ok: true, status: 200, body: new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); } }) });
const mockFetch = async (url, opts) => {
  const body = opts?.body ? JSON.parse(opts.body) : {};
  if (String(url).includes('/chat/completions')) {
    lastCloudBody = body;
    if (body.stream) return streamRes([
      `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: CLOUD_TEXT } }] })}\n\n`,
      'data: [DONE]\n\n',
    ]);
    return mkRes({ choices: [{ message: { content: CLOUD_TEXT } }] });
  }
  return mkRes({ choices: [{ message: { content: 'local' } }] });
};

const fakeReq = (messages, headers = {}) => ({ body: { model: 'mycelium-auto', messages }, headers });
const fakeRes = () => {
  const r = { statusCode: 200, headers: {}, body: null, ended: false, chunks: [], headersSent: false };
  r.status = (s) => { r.statusCode = s; return r; };
  r.set = (k, v) => { if (k && typeof k === 'object') Object.assign(r.headers, k); else r.headers[k] = v; return r; };
  r.json = (o) => { r.body = o; r.ended = true; return r; };
  r.send = (t) => { r.body = t; r.ended = true; return r; };
  r.write = (c) => { r.chunks.push(String(c)); return true; };
  r.end = () => { r.ended = true; return r; };
  return r;
};

const captures = [];
const recordingCapture = async (a) => { captures.push(a); return `Captured ${a.id}`; };
const stubContext = async () => CTX;
const gw = createGatewayHandlers({ db, userId: U, fetch: mockFetch, getContext: stubContext, captureMessage: recordingCapture });

// B3 — opt-in non-stream: inject context + capture last-user + assistant.
captures.length = 0; lastCloudBody = null;
let res = fakeRes();
await gw.chatCompletions(fakeReq([{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: MARK }], { 'x-mycelium-capture': 'conv-1' }), res);
await settle();
const userCaps = captures.filter((c) => c.role === 'user');
const asstCaps = captures.filter((c) => c.role === 'assistant');
rec('B3a. injects getContext as system preamble (reached provider prompt)', JSON.stringify(lastCloudBody).includes(CTX), `cloudBody has CTX=${JSON.stringify(lastCloudBody).includes(CTX)}`);
rec('B3b. captures EXACTLY the last user turn (not the whole history)', userCaps.length === 1 && userCaps[0].content === MARK && !userCaps[0].content.includes('earlier'), `userCaps=${userCaps.length} content=${userCaps[0]?.content}`);
rec('B3c. user capture is NOT polluted by injected context', userCaps[0] && !userCaps[0].content.includes(CTX), `content=${userCaps[0]?.content}`);
rec('B3d. captures the assistant reply', asstCaps.length === 1 && asstCaps[0].content === CLOUD_TEXT, `asst=${asstCaps[0]?.content}`);
rec('B3e. deterministic id is conversation-scoped + stable', userCaps[0]?.id?.startsWith('cap-') && userCaps[0].conversationId === 'conv-1', `id=${userCaps[0]?.id}`);

// B3-stream — streaming path accumulates deltas → assistant captured.
captures.length = 0;
res = fakeRes();
await gw.chatCompletions({ body: { model: 'mycelium-auto', stream: true, messages: [{ role: 'user', content: 'streamy' }] }, headers: { 'x-mycelium-capture': 'conv-2' } }, res);
await settle();
rec('B3f. streaming: assistant reply captured from accumulated deltas', captures.some((c) => c.role === 'assistant' && c.content === CLOUD_TEXT), `caps=${captures.map((c) => c.role).join(',')}`);

// B4 — NO header → zero capture (default proxy unchanged).
captures.length = 0;
res = fakeRes();
await gw.chatCompletions(fakeReq([{ role: 'user', content: 'no capture please' }]), res);
await settle();
rec('B4. no X-Mycelium-Capture header → zero captures (default proxy)', captures.length === 0 && res.body?.object === 'chat.completion', `caps=${captures.length} obj=${res.body?.object}`);

// B5 — a throwing capture sink must NEVER break inference.
const gwThrow = createGatewayHandlers({ db, userId: U, fetch: mockFetch, getContext: stubContext, captureMessage: async () => { throw new Error('sink down'); } });
res = fakeRes();
await gwThrow.chatCompletions(fakeReq([{ role: 'user', content: 'still works?' }], { 'x-mycelium-capture': 'conv-3' }), res);
await settle();
rec('B5. capture sink throws → inference still returns 200 (fire-and-forget)', res.statusCode === 200 && res.body?.choices?.[0]?.message?.content === CLOUD_TEXT, `status=${res.statusCode}`);

close();
for (const f of [B_DB, B_KCV, `${B_DB}-shm`, `${B_DB}-wal`]) { try { rmSync(f); } catch {} }

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(72));
console.log(`VERDICT: ${allPass ? 'GO — memory bridge: /context pull · /ingest dedup · CC on-stop both-sides · gateway inject+capture-last-turn · default-off · fire-and-forget' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(72));
process.exit(allPass ? 0 : 1);
