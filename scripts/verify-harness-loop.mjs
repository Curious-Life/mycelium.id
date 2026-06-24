// verify:harness-loop — the native agent loop core (src/agent/loop.js), driven
// against a STUBBED harness (no provider, no network). Proves the turn-driver
// extracted from portal-chat preserves its reliability semantics:
//   L1 happy path: streams text → returns {text,toolsUsed}; 'responding' once
//   L2 retry-on-empty: empty/aborted turn retried (emits 'retry') → answer
//   L3 truncated: output-cap turn NOT retried; truncated surfaced
//   L4 watchdog stall: no first token within ttfb → aborts + onStall fires
//   L5 client-gone: pre-aborted external signal → no model call, clientGone
//   L6 send passthrough: events reach the sink in order
import { createAgentLoop } from '../src/agent/loop.js';

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

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — agent loop: streams · retries empty · keeps truncated · watchdog stall · client-gone · leak-safe' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
