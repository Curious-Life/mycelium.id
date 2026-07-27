// verify:harness-fallback — provider error classification (src/agent/provider-errors.js)
// + pre-content provider-fallback + jittered backoff in loop.run (src/agent/loop.js). Spec §7a.
//   F1 classifyProviderError taxonomy (auth/not_found/bad_request fatal; 429/5xx/network retryable; abort)
//   F2 single provider (no chain) → retryable error retries then succeeds (behavior unchanged)
//   F3 chain: retryable on P0 → fall back to P1, succeed; fellBack + 'fallback' event
//   F4 chain: AUTH (401) on P0 → does NOT advance — fails loudly (no silent brain swap)
//   F4b 403 is auth too — same rule
//   F4c an expired SUBSCRIPTION never silently answers from the local fallback
//   F5 aborted (our cancel) → NO fallback, stop
//   F6 all providers fail → bounded tries (≤ maxRetries + chain.length), lastErr surfaced
//   F7 post-content error → NO fallback (can't swap mid-stream; keeps the streamed text)
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
process.env.MYCELIUM_BACKOFF_BASE_MS = '1';   // shrink backoff so retries don't slow the gate
process.env.MYCELIUM_BACKOFF_CAP_MS = '2';
const { createAgentLoop } = await import('../src/agent/loop.js');
const { classifyProviderError } = await import('../src/agent/provider-errors.js');

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };
const err = (status, name) => { const e = new Error('provider'); if (status) e.status = status; if (name) e.name = name; return e; };

// A scripted fake harness: behavior(provider, callIndex) → {text?, throw?, result?}.
function makeLoop(behavior) {
  const calls = [];
  const harness = { streamTurn: async ({ provider, send }) => {
    calls.push(provider?.tag);
    const b = behavior(provider, calls.length - 1) || {};
    if (b.text) send({ type: 'text_delta', content: b.text });
    if (b.throw) throw b.throw;
    return b.result || { toolsUsed: [] };
  } };
  return { loop: createAgentLoop({ harness }), calls };
}
const events = (sink) => { const ev = []; return { sink: (e) => { ev.push(e); sink?.(e); }, ev }; };

// ── F1 classification ──
{
  const c = classifyProviderError;
  const ok = c(err(401)).reason === 'auth' && !c(err(401)).retryable
    && c(err(404)).reason === 'not_found' && c(err(400)).reason === 'bad_request'
    && c(err(429)).retryable && c(err(429)).reason === 'rate_limited'
    && c(err(503)).retryable && c(err(503)).reason === 'server_error'
    && !c(err(null, 'AbortError')).retryable && c(err(null, 'AbortError')).reason === 'aborted'
    && c(err(null)).retryable && c(err(null)).reason === 'network';
  rec('F1 error taxonomy (fatal vs retryable vs aborted vs network)', ok);
}

// ── F2 single provider, retryable retry ──
{
  const { loop, calls } = makeLoop((p, i) => i === 0 ? { throw: err(500) } : { text: 'ok2' });
  const r = await loop.run({ provider: { tag: 'P0' }, system: '', userMessage: 'x', maxRetries: 2 });
  rec('F2 single provider: 5xx then success (retry, unchanged)', r.text === 'ok2' && r.fellBack === false && calls.length === 2 && calls.every((t) => t === 'P0'), `calls=${calls}`);
}

// ── F3 fallback on retryable ──
{
  const { loop, calls } = makeLoop((p) => p.tag === 'P0' ? { throw: err(429) } : { text: 'fromP1' });
  const { sink, ev } = events();
  const r = await loop.run({ provider: { tag: 'P0' }, providerChain: [{ tag: 'P0' }, { tag: 'P1' }], system: '', userMessage: 'x', send: sink, maxRetries: 2 });
  rec('F3 retryable on P0 → fell back to P1, succeeded', r.text === 'fromP1' && r.fellBack === true && calls.join(',') === 'P0,P1', `calls=${calls}`);
  rec('F3 emitted a fallback event with the reason', ev.some((e) => e.type === 'fallback' && e.reason === 'rate_limited'));
}

// ── F4 ⭐ AUTH NEVER ADVANCES — DELIBERATELY INVERTED 2026-07-15 ──
//
// This check previously asserted the OPPOSITE:
//   'F4 a fatal 401 on P0 still advances to P1 (bad key on one element)'
// i.e. it locked in the silent downgrade as correct. That behavior is the defect the
// repo documents at claude-config-dir.js:101-105 — "every native channel/harness turn
// sent an EXPIRED Bearer → 401 → the provider-fallback chain silently downgraded the
// turn to local/EU qwen while the activity feed still recorded claude-opus-4-8."
//
// A 401 means the credential for the provider the USER CHOSE was rejected. Advancing
// answers with a different model, from a different provider, possibly in a different
// jurisdiction, under the label the user picked — with their vault's contents as the
// prompt. For a product carrying people's most intimate data that is never an
// acceptable "graceful degradation"; it must be loud so they can reconnect.
//
// The old case this defended (a bad BYOK key on ONE chain element) is deliberately
// given up: if your chosen provider's key is wrong you must be told, not silently
// served another brain. Operator decision, 2026-07-15.
//
// Transient faults still cascade — that is F3 (429) and F2 (5xx), both unchanged.
{
  const { loop, calls } = makeLoop((p) => p.tag === 'P0' ? { throw: err(401) } : { text: 'P1ok' });
  const { sink, ev } = events();
  const r = await loop.run({ provider: { tag: 'P0' }, providerChain: [{ tag: 'P0' }, { tag: 'P1' }], system: '', userMessage: 'x', send: sink, maxRetries: 2 });
  rec('F4 ⭐ a 401 on P0 does NOT advance to P1 — fails loudly (no silent brain swap)',
    r.text !== 'P1ok' && r.fellBack === false && calls.join(',') === 'P0'
    && !ev.some((e) => e.type === 'fallback'),
    `text=${JSON.stringify(r.text)} fellBack=${r.fellBack} calls=${calls} fallbackEvents=${ev.filter((e) => e.type === 'fallback').length}`);
}

// ── F4b 403 is auth too — same rule ──
{
  const { loop, calls } = makeLoop((p) => p.tag === 'P0' ? { throw: err(403) } : { text: 'P1ok' });
  const r = await loop.run({ provider: { tag: 'P0' }, providerChain: [{ tag: 'P0' }, { tag: 'P1' }], system: '', userMessage: 'x', maxRetries: 2 });
  rec('F4b a 403 on P0 also does NOT advance (auth, not transient)',
    r.fellBack === false && calls.join(',') === 'P0', `calls=${calls}`);
}

// ── F4c ⭐ the regression guard: an expired SUBSCRIPTION never becomes local qwen ──
// The exact production shape — chain = [claude subscription, local fallback].
{
  const { loop, calls } = makeLoop((p) => p.tag === 'claude_subscription' ? { throw: err(401) } : { text: 'qwen-answer' });
  const r = await loop.run({
    provider: { tag: 'claude_subscription' },
    providerChain: [{ tag: 'claude_subscription' }, { tag: 'local' }],
    system: '', userMessage: 'x', maxRetries: 2,
  });
  rec('F4c ⭐ expired subscription 401 NEVER silently answers from the local fallback',
    r.text !== 'qwen-answer' && r.fellBack === false && calls.join(',') === 'claude_subscription',
    `text=${JSON.stringify(r.text)} calls=${calls}`);
}

// ── F5 aborted → no fallback ──
{
  const { loop, calls } = makeLoop(() => ({ throw: err(null, 'AbortError') }));
  const r = await loop.run({ provider: { tag: 'P0' }, providerChain: [{ tag: 'P0' }, { tag: 'P1' }], system: '', userMessage: 'x', maxRetries: 2 });
  rec('F5 aborted → no fallback, stops on P0', r.fellBack === false && calls.join(',') === 'P0', `calls=${calls}`);
}

// ── F6 all fail → bounded ──
{
  const { loop, calls } = makeLoop(() => ({ throw: err(500) }));
  const r = await loop.run({ provider: { tag: 'P0' }, providerChain: [{ tag: 'P0' }, { tag: 'P1' }], system: '', userMessage: 'x', maxRetries: 2 });
  rec('F6 all retryable fail → bounded tries (≤ maxRetries+chain) + lastErr', !r.text && r.lastErr && calls.length <= 2 + 2 && calls.length >= 3, `tries=${calls.length}`);
}

// ── F7 post-content error → no fallback ──
{
  const { loop, calls } = makeLoop((p) => p.tag === 'P0' ? { text: 'partial', throw: err(500) } : { text: 'SHOULD-NOT-REACH' });
  const r = await loop.run({ provider: { tag: 'P0' }, providerChain: [{ tag: 'P0' }, { tag: 'P1' }], system: '', userMessage: 'x', maxRetries: 2 });
  rec('F7 text already streamed → NO fallback (keeps partial, P1 untouched)', r.text === 'partial' && r.fellBack === false && calls.join(',') === 'P0', `calls=${calls}`);
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — fallback: taxonomy · single-provider unchanged · pre-content chain advance (TRANSIENT ONLY — auth never advances) · abort-no-fallback · bounded · no mid-stream swap' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
