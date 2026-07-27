// verify:gateway-consent — the OpenAI-compatible gateway never runs a model the owner did
// not approve, and says so honestly (HTTP), across EVERY local path.
//
// THE FINDING THIS ENFORCES. The gateway (src/gateway/openai-compat.js) spends the operator's
// BYOK keys for an external harness. Its on-box FALLBACK reached router.runLocal three ways —
// (1) no cloud configured, (2) a cloud failure, (3) the §4g sensitive-US hard-block — and each
// coalesced through router.js's `localModel || env.LOCAL_MODEL || DEFAULT_LOCAL_MODEL` to
// llama3.1, a heavy 8B model the owner never approved (increment M / #148:
// settings.taskModels.categorize.model IS the approval). The §4g path is the sharp one: it is
// SILENT (no cloud-fallback notice), so the owner got neither their provider, nor an approved
// model, nor any signal. A fourth path exists under MYCELIUM_INFER_CASCADE: a sensitive request
// drops every US provider (resolveProviderChain) straight onto the cascade's on-box floor
// (resolve.js) — same coalesce, same unapproved llama3.1.
//
// The fix: the gateway sets requireApprovedLocal:true and passes the owner-APPROVED on-box
// model (defaultLabelModel — the one #148 reader). Approved ⇒ the fallback runs THAT model.
// Unapproved (null) ⇒ every local path refuses with a typed InferenceError, which the gateway
// turns into an HONEST 503 no_approved_model — not a silent local run, not the generic 502.
//
// ⚠️ THE ADVERSARIAL PIN. env.LOCAL_MODEL is set to 'llama3.1' below. A "fix" that merely
// passed the resolver's null would be SWALLOWED by the coalesce and still run llama3.1; these
// checks fail against that mistake (mirrors verify-narrate-consent N4).
//
//   GC1  no cloud + no approval ⇒ 503 no_approved_model (the "no cloud" tail), no local run
//   GC2  cloud FAILS + no approval ⇒ 503 (the cloud-failure fallback refuses, ≠ llama3.1)
//   GC3  sensitive + US + no approval ⇒ 503 + a 'denied' egress, NO US egress, NO local run
//        (the §4g silent path — the headline) — and the 503 body leaks no prompt
//   GC4  sensitive + US + APPROVED ⇒ 200 local to the APPROVED model (routing still works)
//   GC5  non-sensitive + cloud ok + APPROVED ⇒ 200 cloud (approval doesn't break normal cloud)
//   GC6  STREAM + sensitive + no approval ⇒ pre-token refusal → 503 JSON envelope (not SSE)
//   GC6b STREAM + no cloud + no approval ⇒ same pre-token 503 (the "no cloud" tail, streamed)
//   GC6c STREAM + cloud FAILS + no approval ⇒ same pre-token 503 (the fallback, streamed)
//   GC7  CASCADE + sensitive + only US provider + no approval ⇒ US dropped → floor refuses → 503
//   GC8  CASCADE + sensitive + APPROVED ⇒ floor runs the approved local model → 200
//
// WHY GC6b/GC6c EXIST (independent review, 2026-07-16). The pre-token refusal is a property of
// ALL THREE streaming local paths, but GC6 pinned only the §4g one — so a regression on the
// other two (e.g. moving `open()` above the first delta, making assertLocalApproved throw AFTER
// the SSE headers) would ship green. That failure is invisible to a non-streaming check and
// user-hostile: a harness gets a silent half-open stream instead of an honest 503. Pin each
// path that can refuse, not one representative of them.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import express from 'express';
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createGatewayHandlers } from '../src/gateway/openai-compat.js';
import { createInferenceRouter } from '../src/inference/router.js';

// Hostile env: a stray LOCAL_MODEL would be picked up by router.js's fail-OPEN coalesce. The
// consent gate must IGNORE it and refuse — pin it so a regression that drops requireApprovedLocal
// surfaces here. Clear every cloud env key so "no cloud configured" (GC1) is genuine.
process.env.LOCAL_MODEL = 'llama3.1';
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'INFERENCE_BASE_URL', 'MYCELIUM_INFER_CASCADE']) delete process.env[k];

const DB = 'data/verify-gateway-consent.db', KCV = 'data/verify-gateway-consent-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex: crypto.randomBytes(32).toString('hex'), systemHex: crypto.randomBytes(32).toString('hex'), embedder: null });
const U = 'local-user';
try { await db.users.create(U, 'Verify'); } catch { /* row may already exist */ }

const CLOUD_TEXT = 'cloud-says-hello';
const LOCAL_TEXT = 'local-says-hello';
const MARK = 'PROMPT_MARKER_CONSENT_88';

let cloudCalls = 0, localCalls = 0, cloudFails = false;
// The model name of every on-box call, in order. Counting local calls only answers "did A
// local run happen?" — it cannot tell the approved model from an unapproved one, so a gateway
// that reads the approval as a mere boolean and then runs llama3.1 would pass. Assert on
// localModels.at(-1) so the gate tests that approval is HONORED, not merely consulted.
const localModels = [];
const mkRes = (obj, status = 200) => { const t = JSON.stringify(obj); return { ok: status >= 200 && status < 300, status, async text() { return t; }, async json() { return obj; } }; };
const mockFetch = async (url, opts) => {
  const u = String(url);
  const body = opts?.body ? JSON.parse(opts.body) : {};
  if (u.includes('/chat/completions')) {
    cloudCalls++;
    if (cloudFails) return mkRes({ error: { message: 'upstream down' } }, 503);
    return mkRes({ choices: [{ message: { content: CLOUD_TEXT }, finish_reason: 'stop' }] });
  }
  if (u.includes('/api/generate') || u.includes('/api/chat')) {
    localCalls++;
    localModels.push(body.model ?? null);
    return mkRes({ response: LOCAL_TEXT, message: { content: LOCAL_TEXT } });
  }
  return mkRes({ error: { type: 'not_found' } }, 404);
};

const gw = createGatewayHandlers({ db, userId: U, fetch: mockFetch });
const stubAuth = (req, res, next) => { if (!/^Bearer\s+/i.test(req.headers.authorization || '')) { res.status(401).json({ error: { message: 'Unauthorized', type: 'auth' } }); return; } next(); };
const app = express();
app.use(express.json());
app.post('/v1/chat/completions', stubAuth, (req, res) => gw.chatCompletions(req, res));
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const post = (b, h = {}) => fetch(baseUrl + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test', ...h }, body: JSON.stringify(b || {}) });
const J = async (res) => ({ status: res.status, text: await res.text() }); // text so we can assert no-prompt-leak
const settle = () => new Promise((r) => setTimeout(r, 25));
const deniedRows = async () => (await db.audit.recent({ eventType: 'inference-egress' })).map((x) => { try { return JSON.parse(x.details); } catch { return {}; } }).filter((d) => d.decision === 'denied');
const is503 = (r) => { try { const b = JSON.parse(r.text); return r.status === 503 && b.error?.type === 'no_approved_model'; } catch { return false; } };
const setApproval = (model) => db.users.updateSettings(U, { taskModels: model ? { categorize: { model } } : {} });

// ── PHASE A: the owner has approved NO on-box model. Every local path must refuse. ──────────

// GC1 — no active provider (no cloud, env cleared) + no approval → the "no cloud" tail refuses.
let cb = cloudCalls, lb = localCalls;
let r = await J(await post({ model: 'mycelium-auto', messages: [{ role: 'user', content: 'hi' }] }));
rec('GC1. no cloud + no approval → 503 no_approved_model (no local run, no llama3.1)',
  is503(r) && localCalls === lb && cloudCalls === cb, `status=${r.status} local+${localCalls - lb}`);

// GC6b — the SAME "no cloud" tail as GC1, but STREAMED. Must still refuse before any token, so
// the client gets a JSON 503 rather than a 200 SSE that dies after zero deltas. Runs here, while
// "no cloud" is still genuine (the provider below ends that state permanently).
cb = cloudCalls; lb = localCalls;
r = await J(await post({ model: 'mycelium-auto', stream: true, messages: [{ role: 'user', content: MARK }] }));
rec('GC6b. stream + no cloud + no approval → pre-token 503 JSON (not a half-open SSE)',
  is503(r) && !r.text.includes('data:') && !r.text.includes(MARK) && localCalls === lb && cloudCalls === cb,
  `status=${r.status} local+${localCalls - lb} sse=${r.text.includes('data:')}`);

// Activate ONE us-standard OpenAI-compatible provider for the remaining cloud/§4g paths.
const pid = await db.providers.create(U, { provider: 'openai', label: 'US-Test', authType: 'api_key', credentials: JSON.stringify({ apiKey: 'GOODKEY' }), model: 'gpt-test', baseUrl: 'https://api.us-test.example/v1' });
await db.providers.setActive(pid, U);

// GC2 — cloud is configured but FAILS; with no approval the fallback refuses (≠ llama3.1).
cloudFails = true; cb = cloudCalls; lb = localCalls;
r = await J(await post({ model: 'mycelium-auto', messages: [{ role: 'user', content: 'hi' }] }));
rec('GC2. cloud fails + no approval → 503 (fallback refuses, never llama3.1)',
  is503(r) && cloudCalls === cb + 1 && localCalls === lb, `status=${r.status} cloud+${cloudCalls - cb} local+${localCalls - lb}`);

// GC6c — the cloud-failure fallback, STREAMED. The cloud attempt happens first (so it is a
// mid-request refusal, not a pre-flight one) and the refusal must STILL land before the SSE
// headers. This is the strictest of the three streaming paths: the most opportunity to have
// opened the stream before discovering there is no model we may run.
cb = cloudCalls; lb = localCalls;
r = await J(await post({ model: 'mycelium-auto', stream: true, messages: [{ role: 'user', content: MARK }] }));
rec('GC6c. stream + cloud fails + no approval → pre-token 503 JSON (not a half-open SSE)',
  is503(r) && !r.text.includes('data:') && !r.text.includes(MARK) && cloudCalls === cb + 1 && localCalls === lb,
  `status=${r.status} cloud+${cloudCalls - cb} local+${localCalls - lb} sse=${r.text.includes('data:')}`);
cloudFails = false;

// GC2b — a cloud failure under consent mode must NOT emit a "cloud failed — used <local>
// instead" notice for a fallback that then refuses (it served nothing). Asserted at the router
// level: the onCloudFallback sink isn't wired through the gateway, and this locks the ordering
// (assertLocalApproved runs BEFORE emitCloudFallback). The refusal is the surfaced error.
let fbNotices = 0;
const failCloud = async () => ({ ok: false, status: 503, async text() { return '{}'; }, async json() { return {}; } });
const cr = createInferenceRouter({ openaiApiKey: 'k', baseUrl: 'https://api.us-test.example/v1', jurisdiction: 'us-standard', localModel: null, requireApprovedLocal: true, onCloudFallback: () => { fbNotices++; }, fetch: failCloud });
let gc2bErr = null;
try { await cr.infer({ prompt: 'x', task: 'complex' }); } catch (e) { gc2bErr = e; }
rec('GC2b. cloud-fail + no approval emits NO false fallback notice (surfaces the refusal)',
  fbNotices === 0 && gc2bErr?.code === 'no-approved-local-model', `notices=${fbNotices} code=${gc2bErr?.code}`);

// GC3 — THE HEADLINE: sensitive + US provider → §4g denies egress → local path → refuse.
// The denied-row assertion is DELTA-scoped (count before → count after), not a `.find()` over
// all history: a `.find()` passes on a row some EARLIER check left behind, so a future check
// inserted above this one could make the §4g assertion vacuously green. Assert that THIS
// request produced the denial.
cb = cloudCalls; lb = localCalls;
const d3Before = (await deniedRows()).filter((d) => d.reason === 'sensitive_us_block').length;
r = await J(await post({ model: 'mycelium-auto', messages: [{ role: 'user', content: MARK }] }, { 'x-mycelium-sensitive': 'true' }));
await settle();
const d3After = (await deniedRows()).filter((d) => d.reason === 'sensitive_us_block').length;
rec('GC3. sensitive+US + no approval → 503 + a NEW denied egress, NO US egress, NO local run',
  is503(r) && cloudCalls === cb && localCalls === lb && d3After === d3Before + 1, `status=${r.status} cloud+${cloudCalls - cb} local+${localCalls - lb} denied+${d3After - d3Before}`);
rec('GC3b. the 503 body leaks no prompt (§1 zero-leak)', !r.text.includes(MARK), r.text.slice(0, 90));

// GC6 — streaming, sensitive, no approval: the refusal happens BEFORE the first token, so it
// surfaces as a normal JSON 503 envelope (headers not yet sent) — never a half-open SSE.
cb = cloudCalls; lb = localCalls;
r = await J(await post({ model: 'mycelium-auto', stream: true, messages: [{ role: 'user', content: 'secret' }] }, { 'x-mycelium-sensitive': 'true' }));
rec('GC6. stream + sensitive + no approval → pre-token 503 JSON (not an SSE frame)',
  is503(r) && !r.text.includes('data:') && localCalls === lb, `status=${r.status} local+${localCalls - lb}`);

// GC7 — CASCADE on: a sensitive request drops the only (US) provider → chain is just the on-box
// floor → the floor refuses (re-carried code) → 503. This is the 4th local path.
process.env.MYCELIUM_INFER_CASCADE = '1';
cb = cloudCalls; lb = localCalls;
r = await J(await post({ model: 'mycelium-auto', messages: [{ role: 'user', content: 'secret' }] }, { 'x-mycelium-sensitive': 'true' }));
rec('GC7. cascade + sensitive + US-only + no approval → floor refuses → 503 (no local run)',
  is503(r) && localCalls === lb && cloudCalls === cb, `status=${r.status} local+${localCalls - lb}`);

// ── PHASE B: the owner approves an on-box model. The SAME paths now RUN it (no regression). ──
await setApproval('qwen-approved:4b');

// GC8 — cascade + sensitive + APPROVED → US dropped → floor runs the APPROVED local model.
cb = cloudCalls; lb = localCalls;
r = await J(await post({ model: 'mycelium-auto', messages: [{ role: 'user', content: 'secret' }] }, { 'x-mycelium-sensitive': 'true' }));
rec('GC8. cascade + sensitive + approved → floor runs approved local (200)',
  r.status === 200 && r.text.includes(LOCAL_TEXT) && localCalls === lb + 1 && localModels.at(-1) === 'qwen-approved:4b', `status=${r.status} local+${localCalls - lb} ran=${localModels.at(-1)}`);
delete process.env.MYCELIUM_INFER_CASCADE;

// GC4 — sensitive + US + APPROVED → §4g routes to local, which now runs the approved model.
cb = cloudCalls; lb = localCalls;
r = await J(await post({ model: 'mycelium-auto', messages: [{ role: 'user', content: 'secret' }] }, { 'x-mycelium-sensitive': 'true' }));
rec('GC4. sensitive+US + approved → 200 local to the approved model (no US egress)',
  r.status === 200 && r.text.includes(LOCAL_TEXT) && cloudCalls === cb && localCalls === lb + 1 && localModels.at(-1) === 'qwen-approved:4b', `status=${r.status} cloud+${cloudCalls - cb} local+${localCalls - lb} ran=${localModels.at(-1)}`);

// GC5 — non-sensitive + cloud ok + APPROVED → the normal cloud path is unchanged by consent.
cb = cloudCalls; lb = localCalls;
r = await J(await post({ model: 'mycelium-auto', messages: [{ role: 'user', content: 'hi' }] }));
rec('GC5. non-sensitive + approved → 200 cloud (approval never diverts the cloud path)',
  r.status === 200 && r.text.includes(CLOUD_TEXT) && cloudCalls === cb + 1 && localCalls === lb, `status=${r.status} cloud+${cloudCalls - cb} local+${localCalls - lb}`);

server.close(); close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — gateway consent: every local path (no-cloud · cloud-fail · §4g · cascade floor) refuses an unapproved model with an honest 503; approval runs the chosen model; env.LOCAL_MODEL ignored' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
