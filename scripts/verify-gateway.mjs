// verify:gateway — the OpenAI-compatible outbound gateway (S8). Mounts the REAL
// gateway handlers (src/gateway/openai-compat.js) on a throwaway express app over
// a temp vault that has ONE active us-standard provider, behind a requireAuth-
// shaped stub. (The real requireAuth is verified by verify:oauth; the mount in
// server-http.js uses the identical `if(!await requireAuth)return` pattern as the
// already-proven /ingest/* routes.) A mock fetch speaks BOTH the OpenAI-compatible
// cloud endpoint AND the local Ollama endpoint, so routing + egress are testable
// offline.
//
// Asserts: messages[]→prompt mapping; OpenAI ChatCompletion envelope; Bearer-
// guard 401; ONE egress-audit row per call (sha256 hash + length, NEVER the
// prompt); stream:true terminal chunk; X-Mycelium-Sensitive hard-block → local
// (no US egress) + a 'denied' audit row; static-bearer match + fail-closed;
// /v1/models shape; validation envelopes. PASS/FAIL ledger → VERDICT.
import express from 'express';
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createGatewayHandlers, flattenMessages, CANONICAL_MODEL } from '../src/gateway/openai-compat.js';
import { matchStaticBearer, MIN_BEARER_LEN } from '../src/gateway/static-bearer.js';

const DB = 'data/verify-gateway.db', KCV = 'data/verify-gateway-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex: crypto.randomBytes(32).toString('hex'), systemHex: crypto.randomBytes(32).toString('hex'), embedder: null });
const U = 'local-user';

const CLOUD_TEXT = 'cloud-says-hello';
const LOCAL_TEXT = 'local-says-hello';
const MARK = 'PROMPT_MARKER_42';

let cloudCalls = 0, localCalls = 0, lastCloudBody = null;
const mkRes = (obj, status = 200) => { const t = JSON.stringify(obj); return { ok: status >= 200 && status < 300, status, async text() { return t; }, async json() { return obj; } }; };
const enc = new TextEncoder();
const streamRes = (chunks) => ({ ok: true, status: 200, body: new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); } }) });
const mockFetch = async (url, opts) => {
  const u = String(url);
  const body = opts?.body ? JSON.parse(opts.body) : {};
  if (u.includes('/chat/completions')) {
    cloudCalls++; lastCloudBody = body;
    if (body.stream) return streamRes([
      `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: CLOUD_TEXT.slice(0, 5) } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: CLOUD_TEXT.slice(5) } }] })}\n\n`,
      'data: [DONE]\n\n',
    ]);
    return mkRes({ choices: [{ message: { content: CLOUD_TEXT } }] });
  }
  if (u.includes('/api/generate')) {
    localCalls++;
    if (body.stream) return streamRes([
      JSON.stringify({ response: LOCAL_TEXT.slice(0, 5), done: false }) + '\n',
      JSON.stringify({ response: LOCAL_TEXT.slice(5), done: false }) + '\n',
      JSON.stringify({ response: '', done: true }) + '\n',
    ]);
    return mkRes({ response: LOCAL_TEXT });
  }
  return mkRes({ error: { type: 'not_found' } }, 404);
};

// One ACTIVE us-standard OpenAI-compatible provider → cloud is the default route,
// and the §4g sensitive hard-block has a US jurisdiction to block against.
const pid = await db.providers.create(U, { provider: 'openai', label: 'US-Test', authType: 'api_key', credentials: JSON.stringify({ apiKey: 'GOODKEY' }), model: 'gpt-test', baseUrl: 'https://api.us-test.example/v1' });
await db.providers.setActive(pid, U);

const gw = createGatewayHandlers({ db, userId: U, fetch: mockFetch });
const stubAuth = (req, res, next) => { if (!/^Bearer\s+/i.test(req.headers.authorization || '')) { res.status(401).json({ error: { message: 'Unauthorized', type: 'auth' } }); return; } next(); };
const app = express();
app.use(express.json());
app.post('/v1/chat/completions', stubAuth, (req, res) => gw.chatCompletions(req, res));
app.get('/v1/models', stubAuth, (req, res) => gw.listModels(req, res));
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const post = (p, b, h = {}) => fetch(baseUrl + p, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test', ...h }, body: JSON.stringify(b || {}) });
const get = (p, h = {}) => fetch(baseUrl + p, { headers: { authorization: 'Bearer test', ...h } });
const J = async (res) => ({ status: res.status, body: await res.json() });
const settle = () => new Promise((r) => setTimeout(r, 25)); // let fire-and-forget audit writes land

// G1 — flattenMessages mapping.
const fp = flattenMessages([{ role: 'system', content: 'BE BRIEF' }, { role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }, { role: 'user', content: 'bye' }]);
rec('G1. flatten: system→preamble + role tags + Assistant cue', fp.startsWith('BE BRIEF') && fp.includes('User: hello') && fp.includes('Assistant: hi') && fp.includes('User: bye') && fp.trimEnd().endsWith('Assistant:'), JSON.stringify(fp));

// G2/G3 — normal cloud completion + the prompt reaches the adapter.
let r = await J(await post('/v1/chat/completions', { model: 'mycelium-auto', messages: [{ role: 'user', content: MARK }] }));
rec('G2. OpenAI ChatCompletion envelope', r.status === 200 && r.body.object === 'chat.completion' && r.body.choices?.[0]?.message?.role === 'assistant' && r.body.choices[0].message.content === CLOUD_TEXT && r.body.choices[0].finish_reason === 'stop' && typeof r.body.usage?.total_tokens === 'number', JSON.stringify(r.body).slice(0, 140));
rec('G3. messages[]→prompt reached the cloud adapter', cloudCalls === 1 && JSON.stringify(lastCloudBody).includes(MARK), `cloudCalls=${cloudCalls}`);

// G4 — Bearer guard (no Authorization → 401, fail-closed).
r = await J(await fetch(baseUrl + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }) }));
rec('G4. no Bearer → 401 (fail-closed guard)', r.status === 401, JSON.stringify(r.body));

// G5 — one egress-audit row, hash-only, never the prompt.
await settle();
let rows = await db.audit.recent({ eventType: 'inference-egress' });
const det0 = rows[0] ? JSON.parse(rows[0].details) : {};
rec('G5. egress audit: allowed, sha256 hash + length only, NO prompt',
  rows.length === 1 && det0.decision === 'allowed' && /^[0-9a-f]{64}$/.test(det0.content_hash || '') && det0.content_length > 0 && !JSON.stringify(rows[0]).includes(MARK),
  JSON.stringify(det0));

// G6 — stream:true → terminal SSE chunk(s) + [DONE]; deltas concat to the text.
const sse = await (await post('/v1/chat/completions', { model: 'mycelium-auto', stream: true, messages: [{ role: 'user', content: 'streamy' }] })).text();
const deltas = sse.split('\n').filter((l) => l.startsWith('data: ') && !l.includes('[DONE]')).map((l) => { try { return JSON.parse(l.slice(6)).choices?.[0]?.delta?.content || ''; } catch { return ''; } }).join('');
rec('G6. stream:true → SSE chunks + [DONE], delta === text', sse.includes('data: [DONE]') && sse.includes('chat.completion.chunk') && deltas === CLOUD_TEXT, `head=${sse.slice(0, 48).replace(/\n/g, '⏎')}`);

// G7 — X-Mycelium-Sensitive: true → §4g hard-block → local (no US egress) + denied audit.
const cloudBefore = cloudCalls, localBefore = localCalls;
r = await J(await post('/v1/chat/completions', { model: 'mycelium-auto', messages: [{ role: 'user', content: 'secret' }] }, { 'x-mycelium-sensitive': 'true' }));
await settle();
rows = await db.audit.recent({ eventType: 'inference-egress' });
// created_at has 1s resolution (DESC ties are unordered), so find the denied row
// explicitly rather than assuming it is the most recent.
const denied = rows.map((x) => { try { return JSON.parse(x.details); } catch { return {}; } }).find((d) => d.decision === 'denied');
rec('G7. sensitive → local (no US egress) + denied audit',
  r.status === 200 && r.body.choices?.[0]?.message?.content === LOCAL_TEXT && cloudCalls === cloudBefore && localCalls === localBefore + 1 && denied?.reason === 'sensitive_us_block',
  `cloud+${cloudCalls - cloudBefore} local+${localCalls - localBefore} denied=${denied ? denied.reason : 'none'}`);

// G8 — static bearer: configured+correct→true; wrong→false; short→fail-closed; unset→false.
const TOK = 'a'.repeat(MIN_BEARER_LEN);
rec('G8a. matchStaticBearer correct → true', matchStaticBearer(`Bearer ${TOK}`, { MYCELIUM_MCP_BEARER: TOK }) === true);
rec('G8b. wrong token → false', matchStaticBearer('Bearer wrong-token-xxxxxxxxxxxxxxxxxxxxxx', { MYCELIUM_MCP_BEARER: TOK }) === false);
rec('G8c. short configured token → fail-closed (false)', matchStaticBearer('Bearer short', { MYCELIUM_MCP_BEARER: 'short' }) === false);
rec('G8d. unset env → false', matchStaticBearer(`Bearer ${TOK}`, {}) === false);

// G9 — /v1/models shape.
r = await J(await get('/v1/models'));
rec('G9. /v1/models lists mycelium-auto + configured provider', r.body.object === 'list' && r.body.data.some((m) => m.id === CANONICAL_MODEL) && r.body.data.some((m) => m.id === 'gpt-test'), JSON.stringify(r.body.data?.map((m) => m.id)));

// G10 — validation envelopes (safe, no leak).
r = await J(await post('/v1/chat/completions', { messages: [] }));
rec('G10a. empty messages → 400 invalid_request_error', r.status === 400 && r.body.error?.type === 'invalid_request_error', JSON.stringify(r.body));
r = await J(await post('/v1/chat/completions', { messages: 'nope' }));
rec('G10b. messages not an array → 400', r.status === 400, JSON.stringify(r.body));

server.close(); close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — /v1 gateway: messages→prompt · OpenAI envelope · Bearer-guard · hash-only egress audit · sensitive hard-block · real token streaming · static bearer' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
