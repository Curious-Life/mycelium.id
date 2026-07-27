// verify:api-deadline — every request has a deadline, and the deadline is TIME-TO-RESPONSE,
// never total time.
//
// THE DEFECT (QA9, operator 2026-07-27): "refresh analysis and measurement health … got stuck in
// loading". `fetch` has no default timeout, and every rail surface clears its `loading` flag only
// in a `finally` — so a request that never settled rendered "Loading…" forever, with no error, no
// retry, and no way to tell a slow vault from a dead one (MeasurementHealthSection.svelte:24-39,
// MeasureControl.svelte:22-28, NarrateControl.svelte:52-53). An un-timed spinner asserts "still
// working" on no evidence: the inference-as-evidence class, one surface over.
//
// ⚠️ THE DANGEROUS HALF, AND WHY D2/D3 EXIST. A naive total-request timeout would have been a
// REGRESSION far worse than the bug. Five call sites stream a response body through api():
// ChatFloat:905, ChatView:136, IntelligenceStep:189, AISettings:539, IntelligenceFlow:553 — the
// last three being `/portal/hardware/pull`, an Ollama MODEL DOWNLOAD that runs for many minutes.
// fetch's AbortSignal kills an in-flight body stream, so a 30s total deadline would abort every
// model download at 30 seconds and every long chat generation mid-sentence.
//
// The deadline is therefore on TIME TO RESPONSE HEADERS. Once fetch() resolves, the server has
// demonstrably answered — the request settled, and a slow BODY is not a hung request. This is not
// a tuning choice; it is the difference between "never settled" (the defect) and "settling slowly"
// (normal). D3 is the check that keeps it that way.
//
//   D1  a server that never responds → ApiTimeoutError, not an eternal pending promise
//   D2  a caller's own abort keeps its AbortError (teardown paths must not be reclassified)
//   D3  a slow BODY after fast headers completes in full — streaming is never truncated
//   D4  an upload (FormData) is exempt by default — importing a vault must not hit a deadline
//
// MUTATION-TESTED: removed the deadline entirely (plain fetch) → D1 REDs with "STILL PENDING after
//   5000ms — there is no deadline". ⚠️ The FIRST version of D1 merely awaited api(), so this
//   mutation HUNG THE GATE instead of failing it — in CI, a job that times out rather than a red
//   check. D1 is now raced against a harness cap: a gate must fail on the regression it targets.
// MUTATION-TESTED: moved d.release() to AFTER the body is consumed, making it a TOTAL-time
//   deadline → D3 REDs, the streamed body truncates. This is the model-download regression, caught.
// MUTATION-TESTED: dropped the didTimeOut() guard so every abort became ApiTimeoutError → D2 REDs.
// MUTATION-TESTED: removed the FormData exemption → D4 REDs.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import { createServer } from 'node:http';
import { once } from 'node:events';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

// A DOM shim: api.ts reads document.cookie and (on 401 only) window.location.
globalThis.document = { cookie: '' };
globalThis.window = { location: { href: '' } };

const srv = createServer((req, res) => {
  if (req.url === '/never') return;                       // headers never sent — the defect
  if (req.url === '/slow-body') {                         // headers now, body trickled
    res.writeHead(200, { 'Content-Type': 'application/json' });
    let i = 0;
    const t = setInterval(() => {
      if (i++ < 6) return res.write(i === 1 ? '{"chunks":[1' : `,${i}`);
      clearInterval(t); res.end(']}');
    }, 250);                                              // ~1.75s total, well past the deadline
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
});
srv.listen(0, '127.0.0.1');
await once(srv, 'listening');
const base = `http://127.0.0.1:${srv.address().port}`;

// api.ts resolves relative paths; give it an absolute origin via a fetch wrapper.
const realFetch = globalThis.fetch;
globalThis.fetch = (u, o) => realFetch(String(u).startsWith('http') ? u : base + u, o);

// Load the REAL api.ts. Node strips the TypeScript natively (--experimental-strip-types, set on
// the npm script); the only thing it cannot resolve is the extensionless './vps-identity' import,
// so we write a temp copy with that one line replaced. Everything under test — deadline(), api()
// — is the shipped source, unmodified.
const { readFileSync, writeFileSync, mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const _src = readFileSync('portal-app/src/lib/api.ts', 'utf8')
  .replace(/^import \{ isSecureChannelConfigured \}.*$/m, 'const isSecureChannelConfigured = () => false;');
const _dir = mkdtempSync(join(tmpdir(), 'apid-'));
const _f = join(_dir, 'api.ts');
writeFileSync(_f, _src);
const { api, isTimeout, NO_TIMEOUT, DEFAULT_TIMEOUT_MS } = await import(_f);

// ── D1: a server that never responds must not hang forever ───────────────────
// ⚠️ RACED AGAINST A HARNESS CAP, and that is not belt-and-braces. The first version simply
// awaited api() — so when the deadline was mutated away (the shipped bug), the GATE hung instead
// of failing, and in CI that is a job that times out rather than a red check anyone can read.
// A gate must FAIL on the regression it targets, never hang on it.
const HARNESS_CAP_MS = 5000;
const capped = (p) => Promise.race([
  p.then((v) => ({ v }), (e) => ({ e })),
  new Promise((r) => setTimeout(() => r({ hung: true }), HARNESS_CAP_MS)),
]);
{
  const t0 = Date.now();
  const out = await capped(api('/never', { timeoutMs: 700 }));
  const err = out.hung ? null : out.e;
  const ms = Date.now() - t0;
  if (out.hung) {
    rec('D1. a request that never settles raises ApiTimeoutError (not an eternal pending promise)',
      false, `STILL PENDING after ${HARNESS_CAP_MS}ms — there is no deadline`);
  } else
  rec('D1. a request that never settles raises ApiTimeoutError (not an eternal pending promise)',
    err != null && isTimeout(err) && ms < HARNESS_CAP_MS,
    `${err?.name ?? 'no error'} after ${ms}ms`);
}

// ── D2: a caller abort keeps its own AbortError ──────────────────────────────
// Existing teardown paths test `e.name === 'AbortError'`; reclassifying those as a timeout would
// make a component unmount look like a vault problem.
{
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  let err = null;
  try { await api('/never', { timeoutMs: 5000, signal: ac.signal }); } catch (e) { err = e; }
  rec('D2. a CALLER abort keeps its AbortError — not reclassified as a timeout',
    err != null && !isTimeout(err) && (err.name === 'AbortError' || err.name === 'DOMException'),
    `${err?.name ?? 'no error'}`);
}

// ── D3: THE REGRESSION GUARD. Slow body after fast headers must complete IN FULL ──
// This is the model-download / chat-streaming case. If the deadline ever becomes total-time,
// this truncates and REDs.
{
  const t0 = Date.now();
  let body = null, err = null;
  try {
    const res = await api('/slow-body', { timeoutMs: 700 });   // body takes ~1.75s, deadline 0.7s
    body = await res.json();
  } catch (e) { err = e; }
  const ms = Date.now() - t0;
  rec('D3. a SLOW BODY after fast headers streams to completion (model downloads / chat are not cut off)',
    err == null && Array.isArray(body?.chunks) && body.chunks.length === 6 && ms > 700,
    err ? `threw ${err.name} — the deadline is total-time, which truncates streams`
        : `${body?.chunks?.length ?? 0}/6 chunks in ${ms}ms (deadline was 700ms)`);
}

// ── D4: uploads are exempt by default ────────────────────────────────────────
{
  const fd = new FormData();
  fd.append('f', new Blob(['x']), 'x.bin');
  const t0 = Date.now();
  let err = null;
  // No explicit timeoutMs: a FormData body must default to NO deadline. 1.2s > any sane default
  // would be, if one were applied.
  const p = api('/never', { method: 'POST', body: fd }).catch((e) => { err = e; });
  await new Promise((r) => setTimeout(r, 1200));
  rec('D4. an upload (FormData) has NO default deadline — importing a vault must never hit one',
    err == null,
    err ? `threw ${err.name} after ${Date.now() - t0}ms — uploads would break` : 'still in flight at 1200ms, as intended');
  void p;
}

// ── D5: the default exists and is finite ─────────────────────────────────────
rec('D5. a finite default deadline exists (no request is un-timed by accident)',
  Number.isFinite(DEFAULT_TIMEOUT_MS) && DEFAULT_TIMEOUT_MS > 0 && NO_TIMEOUT === 0,
  `DEFAULT_TIMEOUT_MS=${DEFAULT_TIMEOUT_MS} NO_TIMEOUT=${NO_TIMEOUT}`);

srv.close();
const allPass = ledger.every(Boolean);
console.log('');
console.log(allPass
  ? 'VERDICT: GO — every request carries a finite deadline on TIME-TO-RESPONSE; a caller abort keeps\n'
    + '        its own identity; a slow body streams to completion; uploads are exempt.\n'
    + '        NOT PROVEN: that any particular screen renders the timeout state — that is each\n'
    + '        surface\'s own gate.'
  : 'VERDICT: NO-GO — see FAIL rows');
process.exit(allPass ? 0 : 1);
