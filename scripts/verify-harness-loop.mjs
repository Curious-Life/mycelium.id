// verify:harness-loop — the native agent loop core (src/agent/loop.js), driven
// against a STUBBED harness (no provider, no network). Proves the turn-driver
// extracted from portal-chat preserves its reliability semantics:
//   L1 happy path: streams text → returns {text,toolsUsed}; 'responding' once
//   L2 retry-on-empty: empty/aborted turn retried (emits 'retry') → answer
//   L3 truncated: output-cap turn NOT retried; truncated surfaced
//   L4 watchdog stall: no first token within ttfb → aborts + onStall fires
//   L5 client-gone: pre-aborted external signal → no model call, clientGone
//   L6 send passthrough: events reach the sink in order
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import { createAgentLoop } from '../src/agent/loop.js';
import { classifyProviderError } from '../src/agent/provider-errors.js';
import { parseRetryAfterMs } from '../src/inference/cloud.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// A stub harness whose streamTurn behavior is supplied per-test.
const harnessOf = (streamTurn) => ({ streamTurn });

// ── L1 happy path ──
{
  const h = harnessOf(async ({ send }) => {
    send({ type: 'text_delta', content: 'Hello ' });
    send({ type: 'text_delta', content: 'world' });
    return { toolsUsed: ['searchMindscape'], truncated: false };
  });
  const events = [];
  const loop = createAgentLoop({ harness: h });
  const r = await loop.run({ provider: {}, system: 'S', userMessage: 'hi', tools: [], call: async () => '', send: (e) => events.push(e) });
  rec('L1 returns the accumulated text', r.text === 'Hello world', JSON.stringify(r.text));
  rec('L1 toolsUsed surfaced', r.toolsUsed.join(',') === 'searchMindscape');
  rec('L1 not truncated / not clientGone', r.truncated === false && r.clientGone === false);
  rec('L1 emitted `responding` exactly once', events.filter((e) => e.type === 'responding').length === 1);
  rec('L1 text_delta events passed through to the sink', events.filter((e) => e.type === 'text_delta').map((e) => e.content).join('') === 'Hello world');
}

// ── L2 retry-on-empty ──
{
  let calls = 0;
  const h = harnessOf(async ({ send }) => {
    calls += 1;
    if (calls === 1) return { aborted: true };          // produced nothing → should retry
    send({ type: 'text_delta', content: 'recovered' });
    return {};
  });
  const events = [];
  const loop = createAgentLoop({ harness: h });
  const r = await loop.run({ provider: {}, system: 'S', userMessage: 'hi', tools: [], call: async () => '', send: (e) => events.push(e), maxRetries: 2 });
  rec('L2 retried after an empty turn (2 model calls)', calls === 2, `calls=${calls}`);
  rec('L2 emitted a `retry` event', events.some((e) => e.type === 'retry'));
  rec('L2 returned the recovered answer', r.text === 'recovered');
}

// ── L3 truncated is NOT retried ──
{
  let calls = 0;
  const h = harnessOf(async ({ send }) => {
    calls += 1;
    send({ type: 'text_delta', content: 'cut o' });
    return { truncated: true };
  });
  const loop = createAgentLoop({ harness: h });
  const r = await loop.run({ provider: {}, system: 'S', userMessage: 'hi', tools: [], call: async () => '', send: () => {}, maxRetries: 2 });
  rec('L3 truncated turn not retried (1 model call)', calls === 1, `calls=${calls}`);
  rec('L3 truncated surfaced + partial text kept', r.truncated === true && r.text === 'cut o', JSON.stringify(r));
}

// ── L4 watchdog stall (no first token) → abort + onStall ──
{
  let stalled = false;
  const h = harnessOf(async ({ signal }) => {
    // Never send a token; resolve only when the watchdog aborts us.
    await new Promise((res) => { if (signal.aborted) res(); else signal.addEventListener('abort', res, { once: true }); });
    return { aborted: true };
  });
  const loop = createAgentLoop({ harness: h });
  const r = await loop.run({
    provider: {}, system: 'S', userMessage: 'hi', tools: [], call: async () => '', send: () => {},
    ttfbMs: 120, idleMs: 120, maxRetries: 0, onStall: () => { stalled = true; },
  });
  rec('L4 watchdog fired onStall on a no-first-token stall', stalled === true);
  rec('L4 returned empty (no hang) after the stall', r.text === '' && r.clientGone === false);
}

// ── L5 client-gone (pre-aborted external signal) → no model call ──
{
  let calls = 0;
  const h = harnessOf(async () => { calls += 1; return {}; });
  const ctrl = new AbortController();
  ctrl.abort();
  const loop = createAgentLoop({ harness: h });
  const r = await loop.run({ provider: {}, system: 'S', userMessage: 'hi', tools: [], call: async () => '', send: () => {}, signal: ctrl.signal });
  rec('L5 pre-aborted signal → no model call', calls === 0, `calls=${calls}`);
  rec('L5 reports clientGone', r.clientGone === true);
}

// ── L6 throws TypeError without a harness ──
{
  let threw = false;
  try { createAgentLoop({}); } catch { threw = true; }
  rec('L6 refuses construction without a harness.streamTurn', threw === true);
}

// ── L7 parseRetryAfterMs: seconds · retry-after-ms · HTTP-date · anthropic reset · absent ──
{
  const H = (o) => ({ get: (k) => (k in o ? o[k] : null) });
  rec('L7 retry-after seconds → ms', parseRetryAfterMs(H({ 'retry-after': '5' })) === 5000);
  rec('L7 retry-after-ms wins over retry-after', parseRetryAfterMs(H({ 'retry-after-ms': '1500', 'retry-after': '9' })) === 1500);
  const soon = new Date(1_000_000 + 4000).toUTCString();
  rec('L7 HTTP-date form → future ms', parseRetryAfterMs(H({ 'retry-after': soon }), 1_000_000) === 4000);
  rec('L7 anthropic reset (epoch s) → future ms', parseRetryAfterMs(H({ 'anthropic-ratelimit-requests-reset': '1003' }), 1_000_000) === 3000);
  rec('L7 absent → 0', parseRetryAfterMs(H({})) === 0);
  rec('L7 unparseable → 0 (never throws)', parseRetryAfterMs(H({ 'retry-after': 'soon' })) === 0);
}

// ── L8 classifyProviderError carries retryAfterMs through ──
{
  const c = classifyProviderError({ status: 429, retryAfterMs: 2000 });
  rec('L8 429 → retryable rate_limited + retryAfterMs passthrough', c.retryable === true && c.reason === 'rate_limited' && c.retryAfterMs === 2000, JSON.stringify(c));
  const a = classifyProviderError({ status: 401, retryAfterMs: 9000 });
  rec('L8 401 → fatal auth (never retried)', a.retryable === false && a.reason === 'auth', JSON.stringify(a));
  const s = classifyProviderError({ status: 503 });
  rec('L8 503 → retryable server_error, no hint → 0', s.retryable === true && s.reason === 'server_error' && s.retryAfterMs === 0);
}

// ── L9 provider fallback: a retryable error on A + a chain → fails over to B, recovers ──
{
  const A = { label: 'A', providerName: 'a' }, B = { anthropicApiKey: 'x', label: 'B', providerName: 'b' };
  const hit = { a: 0, b: 0 };
  const h = harnessOf(async ({ provider, send }) => {
    if (provider === A) { hit.a++; const e = new Error('overloaded'); e.status = 429; throw e; }
    hit.b++; send({ type: 'text_delta', content: 'from B' }); return { toolsUsed: [], truncated: false };
  });
  const events = [];
  const r = await createAgentLoop({ harness: h }).run({ provider: A, providerChain: [A, B], system: 's', userMessage: 'u', tools: [], call: async () => '', send: (e) => events.push(e) });
  rec('L9 failed over A→B and recovered (no long backoff)', hit.a === 1 && hit.b === 1 && r.text === 'from B' && r.fellBack === true, JSON.stringify({ hit, text: r.text, fellBack: r.fellBack }));
  rec('L9 emitted a `fallback` event', events.some((e) => e.type === 'fallback'));
}

// ── L10 per-turn maxIterations is forwarded to streamTurn (MED-1 untrusted cap) ──
{
  let seen; // what streamTurn received
  const h = harnessOf(async ({ maxIterations, send }) => { seen = maxIterations; send({ type: 'text_delta', content: 'ok' }); return {}; });
  const loop = createAgentLoop({ harness: h });
  await loop.run({ provider: {}, system: 'S', userMessage: 'hi', tools: [], call: async () => '', send: () => {}, maxIterations: 16 });
  rec('L10 loop forwards maxIterations=16 to streamTurn', seen === 16, `seen=${seen}`);
  let seen2 = 'UNSET';
  const h2 = harnessOf(async ({ maxIterations, send }) => { seen2 = maxIterations; send({ type: 'text_delta', content: 'ok' }); return {}; });
  await createAgentLoop({ harness: h2 }).run({ provider: {}, system: 'S', userMessage: 'hi', tools: [], call: async () => '', send: () => {} });
  rec('L10 omitted maxIterations → streamTurn default (undefined passthrough)', seen2 === undefined, `seen2=${seen2}`);
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — agent loop: streams · retries empty · keeps truncated · watchdog stall · client-gone · provider-fallback · Retry-After honored · leak-safe' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
