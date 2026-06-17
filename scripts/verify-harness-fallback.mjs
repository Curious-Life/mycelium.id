// verify:harness-fallback — provider error classification (src/agent/provider-errors.js)
// + pre-content provider-fallback + jittered backoff in loop.run (src/agent/loop.js). Spec §7a.
//   F1 classifyProviderError taxonomy (auth/not_found/bad_request fatal; 429/5xx/network retryable; abort)
//   F2 single provider (no chain) → retryable error retries then succeeds (behavior unchanged)
//   F3 chain: retryable on P0 → fall back to P1, succeed; fellBack + 'fallback' event
//   F4 chain: provider-specific FATAL (401) on P0 → still advances to P1 (bad key on one element)
//   F5 aborted (our cancel) → NO fallback, stop
//   F6 all providers fail → bounded tries (≤ maxRetries + chain.length), lastErr surfaced
//   F7 post-content error → NO fallback (can't swap mid-stream; keeps the streamed text)
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

// ── F4 provider-specific fatal advances ──
{
  const { loop, calls } = makeLoop((p) => p.tag === 'P0' ? { throw: err(401) } : { text: 'P1ok' });
  const r = await loop.run({ provider: { tag: 'P0' }, providerChain: [{ tag: 'P0' }, { tag: 'P1' }], system: '', userMessage: 'x', maxRetries: 2 });
  rec('F4 a fatal 401 on P0 still advances to P1 (bad key on one element)', r.text === 'P1ok' && r.fellBack === true && calls.join(',') === 'P0,P1');
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
console.log(`VERDICT: ${allPass ? 'GO — fallback: taxonomy · single-provider unchanged · pre-content chain advance (retryable + provider-fatal) · abort-no-fallback · bounded · no mid-stream swap' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
