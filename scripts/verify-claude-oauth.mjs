// verify:claude-oauth — the Claude-subscription (OAuth) provider path. Proves the
// subscription is recognized end-to-end and produces the CORRECT Claude-Code wire
// (Bearer + identity headers + "You are Claude Code" preamble) WITHOUT regressing
// the API-key path. No live token; mocked fetch + injected credential reader.
//   CO1-3  anthropic-wire: apiKey byte-identical · subscription headers · system shapes
//   CO4-6  describeProvider: subscription non-null · apiKey intact · {} → null (no silent fallback)
//   CO7-8  resolveInferenceConfig: subscription row → claudeOAuthToken · apiKey row → anthropicApiKey
//   CO9-12 importFromClaudeCli: valid · missing user:inference scope · not found · no token
//   CO13-15 end-to-end streamTurn(subscription): request carries Bearer + beta + ua + x-app, NO x-api-key, system preamble-block-first
//   CO16    apiKey streamTurn still sends x-api-key + plain string system (no regression)
//   CO17    isTokenExpired skew
import { anthropicAuthHeaders, anthropicSystem, CLAUDE_CODE_PREAMBLE, CLAUDE_CODE_BETA, CLAUDE_CODE_UA } from '../src/inference/anthropic-wire.js';
import { describeProvider, createAgentHarness } from '../src/agent/harness.js';
import { resolveInferenceConfig, resolveProviderChain } from '../src/inference/resolve.js';
import { createInferenceRouter } from '../src/inference/router.js';
import { importFromClaudeCli, isTokenExpired, ClaudeImportError } from '../src/inference/claude-oauth.js';

const enc = new TextEncoder();
const streamRes = (chunks) => ({ ok: true, status: 200, body: new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(enc.encode(x)); c.close(); } }) });
const sse = (objs) => objs.map((o) => (o === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(o)}\n\n`));
const aText = sse([
  { type: 'message_start', message: { usage: { input_tokens: 5 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
  '[DONE]',
]);

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const fakeDb = (row) => ({ providers: { getActive: async () => row } });

// ── CO1-3 anthropic-wire unit ──
{
  const ak = anthropicAuthHeaders({ mode: 'apiKey', apiKey: 'sk-test' });
  rec('CO1 apiKey headers byte-identical', ak['x-api-key'] === 'sk-test' && ak['anthropic-version'] === '2023-06-01' && !ak.Authorization, JSON.stringify(ak));
  const sub = anthropicAuthHeaders({ mode: 'subscription', token: 'sk-ant-oat-X' });
  rec('CO2 subscription headers: Bearer + beta + ua + x-app, no x-api-key',
    sub.Authorization === 'Bearer sk-ant-oat-X' && sub['anthropic-beta'] === CLAUDE_CODE_BETA && sub['user-agent'] === CLAUDE_CODE_UA && sub['x-app'] === 'cli' && !sub['x-api-key'], JSON.stringify(sub));
  rec('CO3 system: apiKey passthrough vs subscription preamble-block-first',
    anthropicSystem({ mode: 'apiKey' }, 'SYS') === 'SYS'
    && Array.isArray(anthropicSystem({ mode: 'subscription' }, 'SYS'))
    && anthropicSystem({ mode: 'subscription' }, 'SYS')[0].text === CLAUDE_CODE_PREAMBLE
    && anthropicSystem({ mode: 'subscription' }, 'SYS')[1].text === 'SYS');
}

// ── CO4-6 describeProvider ──
{
  const sub = describeProvider({ claudeOAuthToken: 'sk-ant-oat-X', label: 'My Max sub' });
  rec('CO4 subscription cfg → non-null, kind anthropic (no silent skip)', !!sub && sub.kind === 'anthropic' && sub.local === false, JSON.stringify(sub));
  const key = describeProvider({ anthropicApiKey: 'K' });
  rec('CO5 apiKey cfg still describes as Claude', !!key && key.kind === 'anthropic' && key.label === 'Claude');
  rec('CO6 empty cfg → null (chat refuses, no fallback)', describeProvider({}) === null);
}

// ── CO7-8 resolveInferenceConfig mapping ──
{
  const subRow = { provider: 'anthropic', auth_type: 'oauth', credentials: JSON.stringify({ claudeOAuthToken: 'sk-ant-oat-TEST', refreshToken: 'rt', expiresAt: null, scopes: ['user:inference'] }), model_preference: null, base_url: null, label: 'My Max sub' };
  const cfg = await resolveInferenceConfig(fakeDb(subRow), 'u');
  rec('CO7 subscription row → {claudeOAuthToken}, US jurisdiction, no apiKey', cfg.claudeOAuthToken === 'sk-ant-oat-TEST' && !cfg.anthropicApiKey && /^us/.test(cfg.jurisdiction || ''), JSON.stringify({ t: cfg.claudeOAuthToken, j: cfg.jurisdiction }));
  const keyRow = { provider: 'anthropic', auth_type: 'api_key', credentials: JSON.stringify({ apiKey: 'sk-ant-KEY' }), base_url: null };
  const cfg2 = await resolveInferenceConfig(fakeDb(keyRow), 'u');
  rec('CO8 api_key row → {anthropicApiKey} (unchanged)', cfg2.anthropicApiKey === 'sk-ant-KEY' && !cfg2.claudeOAuthToken);
}

// ── CO9-13 importFromClaudeCli (file + macOS Keychain fallback) ──
// keychainImpl is always injected here so the suite is deterministic and never touches
// the real macOS Keychain (which on a dev Mac WOULD hold a live token → flaky CO11).
{
  const good = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat-IMPORT', refreshToken: 'r', expiresAt: 1234567890, scopes: ['user:inference', 'user:profile'] } });
  const noKc = async () => null;
  const r = await importFromClaudeCli({ readImpl: async () => good, keychainImpl: noKc });
  rec('CO9 valid file login imports token + scopes + refresh', r.claudeOAuthToken === 'sk-ant-oat-IMPORT' && r.refreshToken === 'r' && r.scopes.includes('user:inference'));
  const rk = await importFromClaudeCli({ readImpl: async () => { throw new Error('ENOENT'); }, keychainImpl: async () => good });
  rec('CO9b file absent → macOS Keychain fallback imports', rk.claudeOAuthToken === 'sk-ant-oat-IMPORT' && rk.scopes.includes('user:inference'));
  const catchCode = async (fn) => { try { await fn(); return null; } catch (e) { return e instanceof ClaudeImportError ? e.code : 'wrong-error'; } };
  rec('CO10 missing user:inference scope → rejected (setup-token guard)', await catchCode(() => importFromClaudeCli({ readImpl: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'sk', scopes: ['user:profile'] } }), keychainImpl: noKc })) === 'missing_scope');
  rec('CO11 no file AND no keychain → not_found', await catchCode(() => importFromClaudeCli({ readImpl: async () => { throw new Error('ENOENT'); }, keychainImpl: noKc })) === 'not_found');
  rec('CO12 no access token → no_token', await catchCode(() => importFromClaudeCli({ readImpl: async () => JSON.stringify({ claudeAiOauth: { scopes: ['user:inference'] } }), keychainImpl: noKc })) === 'no_token');
}

// ── CO13-15 end-to-end: subscription request wire ──
{
  const subRow = { provider: 'anthropic', auth_type: 'oauth', credentials: JSON.stringify({ claudeOAuthToken: 'sk-ant-oat-E2E', scopes: ['user:inference'] }), base_url: null, label: 'sub' };
  const cfg = await resolveInferenceConfig(fakeDb(subRow), 'u');
  let cap = null;
  const fetch = async (url, opts) => { cap = { url, headers: opts.headers, body: opts.body }; return streamRes(aText); };
  const h = createAgentHarness({ fetch });
  const events = [];
  const r = await h.streamTurn({ provider: cfg, system: 'SYS', userMessage: 'hi', tools: [], call: async () => '', send: (e) => events.push(e) });
  const text = events.filter((e) => e.type === 'text_delta').map((e) => e.content).join('');
  rec('CO13 subscription turn streams text (no skip)', text === 'Hi.' && !r.skipped, JSON.stringify({ text, skipped: r.skipped }));
  rec('CO14 outgoing headers: Bearer + beta + ua + x-app, NO x-api-key',
    cap.headers.Authorization === 'Bearer sk-ant-oat-E2E' && cap.headers['anthropic-beta'] === CLAUDE_CODE_BETA && cap.headers['user-agent'] === CLAUDE_CODE_UA && cap.headers['x-app'] === 'cli' && !cap.headers['x-api-key'], JSON.stringify(cap.headers));
  const body = JSON.parse(cap.body);
  rec('CO15 system is preamble-block-first', Array.isArray(body.system) && body.system[0].text === CLAUDE_CODE_PREAMBLE && body.system[1].text === 'SYS');
}

// ── CO16 apiKey path unregressed ──
{
  let cap = null;
  const fetch = async (url, opts) => { cap = { headers: opts.headers, body: opts.body }; return streamRes(aText); };
  const h = createAgentHarness({ fetch });
  await h.streamTurn({ provider: { anthropicApiKey: 'sk-ant-KEY', jurisdiction: 'us-standard' }, system: 'SYS', userMessage: 'hi', tools: [], call: async () => '', send: () => {} });
  rec('CO16 apiKey turn → x-api-key + plain string system (no regression)', cap.headers['x-api-key'] === 'sk-ant-KEY' && !cap.headers.Authorization && JSON.parse(cap.body).system === 'SYS', JSON.stringify(cap.headers));
}

// ── CO17 expiry skew ──
{
  const now = 1_000_000_000_000;
  rec('CO17 isTokenExpired: skew + unknown-expiry handling', isTokenExpired(now - 1, now) === true && isTokenExpired(now + 60_000, now) === true && isTokenExpired(now + 10 * 60_000, now) === false && isTokenExpired(null, now) === false);
}

// ── CO18-21 router path: §4g + subscription cloud wire ──
{
  const jsonRes = (status, obj) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj) });
  const makeFetch = (routes) => { const calls = []; const fn = async (url, opts = {}) => { calls.push({ url: String(url), opts }); for (const r of routes) if (String(url).includes(r.match)) return r.respond(url, opts); throw new Error(`unexpected ${url}`); }; fn.calls = calls; return fn; };
  const anthropicOk = { match: 'api.anthropic.com', respond: async () => jsonRes(200, { content: [{ type: 'text', text: 'CLOUD' }], usage: { input_tokens: 1, output_tokens: 1 } }) };
  const ollamaOk = { match: '11434', respond: async () => jsonRes(200, { response: 'LOCAL', done: true, done_reason: 'stop' }) };
  const router = (extra) => createInferenceRouter({ jurisdiction: 'us-standard', env: {}, ...extra });

  {
    const f = makeFetch([anthropicOk, ollamaOk]);
    const out = await router({ claudeOAuthToken: 'sk-ant-oat-R', fetch: f }).infer({ prompt: 'hi', task: 'complex' });
    const areq = f.calls.find((c) => c.url.includes('api.anthropic.com'));
    const hdr = areq?.opts?.headers || {}; const body = areq ? JSON.parse(areq.opts.body) : {};
    rec('CO18 subscription router: complex→cloud, Bearer + preamble, no x-api-key', out === 'CLOUD' && hdr.Authorization === 'Bearer sk-ant-oat-R' && !hdr['x-api-key'] && Array.isArray(body.system) && body.system[0].text === CLAUDE_CODE_PREAMBLE, JSON.stringify({ out, auth: hdr.Authorization }));
  }
  {
    const f = makeFetch([anthropicOk, ollamaOk]);
    const out = await router({ claudeOAuthToken: 'sk-ant-oat-R', sensitiveUsExempt: true, fetch: f }).infer({ prompt: 'hi', task: 'complex', sensitive: true });
    rec('CO19 sensitive + opted-in subscription → cloud (exempt honored)', out === 'CLOUD');
  }
  {
    const f = makeFetch([anthropicOk, ollamaOk]);
    const out = await router({ claudeOAuthToken: 'sk-ant-oat-R', sensitiveUsExempt: false, fetch: f }).infer({ prompt: 'hi', task: 'complex', sensitive: true });
    rec('CO20 sensitive + subscription NOT opted-in → §4g blocks to local', out === 'LOCAL');
  }
  {
    const f = makeFetch([anthropicOk, ollamaOk]);
    const out = await router({ anthropicApiKey: 'sk-ant-KEY', fetch: f }).infer({ prompt: 'hi', task: 'complex', sensitive: true });
    rec('CO21 §4g floor holds: sensitive + US API key → local (never auto-exempt)', out === 'LOCAL');
  }
}

// ── CO22-23 resolve.js sets exempt ONLY for an opted-in subscription ──
{
  const subRow = { id: 1, provider: 'anthropic', auth_type: 'oauth', credentials: JSON.stringify({ claudeOAuthToken: 'sk-ant-oat-S', scopes: ['user:inference'] }), base_url: null };
  const dbWith = (allow) => ({ providers: { getActive: async () => subRow, list: async () => [subRow], get: async () => subRow }, users: { getSettings: async () => ({ allowSubscriptionSensitive: allow }) } });
  const onCfg = await resolveInferenceConfig(dbWith(true), 'u');
  const offCfg = await resolveInferenceConfig(dbWith(false), 'u');
  rec('CO22 resolveInferenceConfig: exempt set ONLY when opted in', onCfg.sensitiveUsExempt === true && !offCfg.sensitiveUsExempt);
  const chainOn = (await resolveProviderChain(dbWith(true), 'u', { sensitive: true })).find((c) => c.providerName === 'claude_subscription');
  const chainOff = (await resolveProviderChain(dbWith(false), 'u', { sensitive: true })).find((c) => c.providerName === 'claude_subscription');
  rec('CO23 resolveProviderChain(sensitive): subscription kept+exempt when opted in, dropped otherwise', !!chainOn && chainOn.sensitiveUsExempt === true && !chainOff);
}

const pass = ledger.every(Boolean);
console.log('\n================================================================');
console.log(`VERDICT: ${pass ? 'GO' : 'NO-GO'} — Claude-subscription OAuth provider: recognized · correct Claude-Code wire · import scope-guard · apiKey path unregressed  EXIT=${pass ? 0 : 1}`);
console.log('================================================================');
process.exit(pass ? 0 : 1);
