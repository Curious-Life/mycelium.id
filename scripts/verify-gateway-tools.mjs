// verify:gateway-tools — tools pass-through (Slice C2): a request carrying `tools`
// is transparently proxied to an OpenAI-compatible provider so tool_calls
// round-trip, instead of being flattened away.
//   T1 tools request → proxied raw → tool_calls returned; tools forwarded upstream
//   T2 egress audited (reason tools_passthrough, sha256 hash + length, NO content)
//   T3 sensitive + US provider → 400 sensitive_blocked (no egress)
//   T4 sensitive + EU provider → proxied (not blocked)
//   T5 stream + tools → provider SSE piped through (tool_call deltas + [DONE])
//   T6 no-tools request → normal completion (regression; not proxied)
// Mounts the REAL gateway over a temp vault behind a requireAuth-shaped stub.
import express from 'express';
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createGatewayHandlers } from '../src/gateway/openai-compat.js';

const DB = 'data/verify-gw-tools.db', KCV = 'data/verify-gw-tools-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex: crypto.randomBytes(32).toString('hex'), systemHex: crypto.randomBytes(32).toString('hex'), embedder: null });
const U = 'local-user';

// Two OpenAI-compatible providers (same 'custom' type so setActive switches cleanly).
const usId = await db.providers.create(U, { provider: 'custom', label: 'US', authType: 'api_key', credentials: JSON.stringify({ apiKey: 'USKEY' }), baseUrl: 'https://api.us-test.example/v1' });
const euId = await db.providers.create(U, { provider: 'custom', label: 'EU', authType: 'api_key', credentials: JSON.stringify({ apiKey: 'EUKEY' }), baseUrl: 'https://api.regolo.ai/v1' });

const MARK = 'WEATHER_PROMPT_MARKER';
const toolResp = { choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } }] }, finish_reason: 'tool_calls' }] };
let lastUrl = null, lastBody = null;
const enc = new TextEncoder();
const mkRes = (obj) => { const t = JSON.stringify(obj); return { ok: true, status: 200, async text() { return t; }, async json() { return obj; } }; };
const streamRes = (chunks) => ({ ok: true, status: 200, body: new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(enc.encode(x)); c.close(); } }) });
const mockFetch = async (url, opts) => {
  const u = String(url); const body = opts?.body ? JSON.parse(opts.body) : {};
  lastUrl = u; lastBody = body;
  if (u.includes('/chat/completions')) {
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    if (body.stream && hasTools) return streamRes([
      `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"SF"}' } }] } }] })}\n\n`,
      'data: [DONE]\n\n',
    ]);
    return mkRes(hasTools ? toolResp : { choices: [{ message: { content: 'NORMAL' } }] });
  }
  if (u.includes('/api/generate')) return mkRes({ response: 'LOCAL' });
  return mkRes({ error: { type: 'not_found' } }, 404);
};

const gw = createGatewayHandlers({ db, userId: U, fetch: mockFetch });
const stubAuth = (req, res, next) => { if (!/^Bearer\s+/i.test(req.headers.authorization || '')) { res.status(401).json({ error: { message: 'Unauthorized', type: 'auth' } }); return; } next(); };
const app = express();
app.use(express.json());
app.post('/v1/chat/completions', stubAuth, (req, res) => gw.chatCompletions(req, res));
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };
const post = (b, h = {}) => fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test', ...h }, body: JSON.stringify(b) });
const settle = () => new Promise((r) => setTimeout(r, 25));
const TOOLS = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }];

await db.providers.setActive(usId, U);

// T1 — proxied tool call
{
  const r = await (await post({ model: 'mycelium-auto', messages: [{ role: 'user', content: MARK }], tools: TOOLS })).json();
  rec('T1. tools request → proxied, tool_calls returned, tools forwarded',
    r.choices?.[0]?.message?.tool_calls?.[0]?.function?.name === 'get_weather' && lastUrl.includes('us-test') && Array.isArray(lastBody.tools),
    `name=${r.choices?.[0]?.message?.tool_calls?.[0]?.function?.name} url=${lastUrl}`);
}

// T2 — egress audited, hash-only
{
  await settle();
  const rows = await db.audit.recent({ eventType: 'inference-egress' });
  const tp = rows.map((x) => { try { return JSON.parse(x.details); } catch { return {}; } }).find((d) => d.reason === 'tools_passthrough');
  rec('T2. egress audited (tools_passthrough, hash-only, no content)',
    tp && tp.decision === 'allowed' && /^[0-9a-f]{64}$/.test(tp.content_hash || '') && tp.content_length > 0 && !JSON.stringify(rows).includes(MARK),
    JSON.stringify(tp));
}

// T3 — sensitive + US → 400
{
  const res = await post({ model: 'mycelium-auto', messages: [{ role: 'user', content: 'secret' }], tools: TOOLS }, { 'x-mycelium-sensitive': 'true' });
  const b = await res.json();
  rec('T3. sensitive + US provider → 400 sensitive_blocked', res.status === 400 && b.error?.type === 'sensitive_blocked', `status=${res.status} type=${b.error?.type}`);
}

// T4 — sensitive + EU → proxied (not blocked)
{
  await db.providers.setActive(euId, U);
  const res = await post({ model: 'mycelium-auto', messages: [{ role: 'user', content: 'q' }], tools: TOOLS }, { 'x-mycelium-sensitive': 'true' });
  const b = await res.json();
  rec('T4. sensitive + EU provider → proxied (not blocked)', res.status === 200 && b.choices?.[0]?.message?.tool_calls && lastUrl.includes('regolo'), `status=${res.status} url=${lastUrl}`);
}

// T5 — stream + tools → SSE piped through
{
  const sse = await (await post({ model: 'mycelium-auto', stream: true, messages: [{ role: 'user', content: 'w' }], tools: TOOLS })).text();
  rec('T5. stream + tools → provider SSE piped (tool_calls + [DONE])', sse.includes('get_weather') && sse.includes('tool_calls') && sse.includes('data: [DONE]'), `head=${sse.slice(0, 60).replace(/\n/g, '⏎')}`);
}

// T6 — no tools → normal completion (regression)
{
  const r = await (await post({ model: 'mycelium-auto', messages: [{ role: 'user', content: 'hi' }] })).json();
  rec('T6. no-tools request → normal chat.completion (not proxied)', r.object === 'chat.completion' && r.choices?.[0]?.message?.content === 'NORMAL', JSON.stringify(r).slice(0, 90));
}

server.close(); close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — tools pass-through: proxied tool_calls · audited · sensitive-US refused · EU ok · streamed · no-tools unchanged' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
