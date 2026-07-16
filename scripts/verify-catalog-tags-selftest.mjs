// verify:catalog-tags-selftest — HERMETIC (stubbed registry, no network).
//
// verify:catalog-tags is a network gate: on CI it exercises exactly one path,
// the happy one, and its two interesting verdicts (a genuinely-absent tag; a
// registry that is merely down) only ever fire when nobody planned for them.
// That is how it shipped the 2026-07-16 misdiagnosis — a 502 read as "the tag
// does not resolve (fix src/hardware/catalog.js)". So the classification and
// retry logic is proven HERE, against a stub that can be a 404, a 502, or a
// 502-then-200 flake on demand, and the network gate just feeds real fetches
// into these same functions.
//
// What must hold:
//   S1  classifyStatus: only 404 is absent; 5xx/429/403/0 are transient
//   S2  a transient status is RETRIED, and a flake that heals is a PASS
//   S3  a real 404 is NOT retried and goes RED (exit 1) — the check still bites
//   S4  a registry that stays 502 is DEGRADED (exit 2), never GO and never a
//       catalog accusation
//   S5  absent beats degraded: a real 404 alongside a 502 still says NO-GO
//   S6  a timeout / network error is degraded, not absent
//   S7  manifestUrl: bare → library/<m>, namespaced → <ns>/<m>, default :latest
//   S8  the per-probe timeout is WIRED, not just handled if it happens
//   S9  an empty catalog is NO-GO, not "GO — all 0 tags resolve"
//   S10 an hf.co/ name is unsupported (unverified), never a catalog accusation
//
// S8/S9/S10 come from an independent adversarial review of the first draft: a
// mutation that DELETED `signal: AbortSignal.timeout(...)` left the self-test
// fully green (9/9), which is this repo's oldest gate failure mode — a stubbed
// check that proves handling while proving nothing about the wiring.

import assert from 'node:assert';
import { classifyStatus, isUnsupportedName, manifestUrl, probeTag, run } from './verify-catalog-tags.mjs';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

// ── stub registry ────────────────────────────────────────────────────────────
// `plan` maps a model name → array of responses, one per attempt. A response is
// a number (HTTP status) or an Error to throw (network failure). The last entry
// repeats. Records every call so we can assert on retry COUNT, not just verdict.
const calls = [];
const stub = (plan) => async (url) => {
  const name = decodeURIComponent(url).replace(/^.*\/v2\/(?:library\/)?/, '').replace('/manifests/', ':');
  calls.push(name);
  const seq = plan[name];
  assert(seq, `stub has no plan for ${name} (url=${url})`);
  const n = calls.filter((c) => c === name).length;
  const r = seq[Math.min(n - 1, seq.length - 1)];
  if (r instanceof Error) throw r;
  return { status: r };
};
const noSleep = async () => {};
const quiet = () => {};
const reset = () => { calls.length = 0; };
const catalogOf = (...names) => names.map((name) => ({ name }));

// ── S1 — classification ──────────────────────────────────────────────────────
{
  const absentOnly = classifyStatus(404) === 'absent'
    && ![500, 502, 503, 504, 429, 403, 0, 418].some((s) => classifyStatus(s) === 'absent');
  const exists = classifyStatus(200) === 'exists' && classifyStatus(401) === 'exists';
  const transient = [500, 502, 503, 504, 429, 403, 0].every((s) => classifyStatus(s) === 'transient');
  rec('S1. classifyStatus — 404 absent · 200/401 exists · 5xx/429/403/0 transient',
    absentOnly && exists && transient,
    `502 → ${classifyStatus(502)} (the 2026-07-16 status that falsely read as absent)`);
}

// ── S2 — a transient status is retried; a flake that heals passes ────────────
{
  reset();
  const r = await probeTag('openthinker:7b', {
    fetchImpl: stub({ 'openthinker:7b': [502, 502, 200] }), sleep: noSleep,
  });
  const ok = r.verdict === 'exists' && r.tries === 3 && calls.length === 3;
  rec('S2. 502,502,200 → retried 3× and PASSES (the exact #170 flake)', ok,
    `verdict=${r.verdict} tries=${r.tries} seen=${r.seen.join(',')}`);
}

// ── S3 — a real 404 is not retried, and goes RED ─────────────────────────────
{
  reset();
  const r = await probeTag('gemma3:nonexistent-tag', {
    fetchImpl: stub({ 'gemma3:nonexistent-tag': [404] }), sleep: noSleep,
  });
  const noRetry = r.verdict === 'absent' && r.tries === 1 && calls.length === 1;
  rec('S3a. 404 → absent on the FIRST probe, no pointless retries', noRetry,
    `verdict=${r.verdict} tries=${r.tries}`);

  reset();
  const lines = [];
  const code = await run({
    catalog: catalogOf('gemma3:12b', 'gemma3:nonexistent-tag'),
    fetchImpl: stub({ 'gemma3:12b': [200], 'gemma3:nonexistent-tag': [404] }),
    sleep: noSleep, log: (l) => lines.push(l),
  });
  const out = lines.join('\n');
  const red = code === 1 && /NO-GO/.test(out) && /do NOT exist upstream/.test(out)
    && /gemma3:nonexistent-tag/.test(out) && /FAIL {2}tag exists: gemma3:nonexistent-tag/.test(out);
  rec('S3b. a removed tag still fails the gate RED (exit 1, names catalog.js)', red,
    `exit=${code} :: ${lines.at(-2)}`);
}

// ── S4 — a registry that stays down is DEGRADED, not GO, not a catalog bug ───
{
  reset();
  const lines = [];
  const code = await run({
    catalog: catalogOf('gemma3:12b', 'openthinker:7b'),
    fetchImpl: stub({ 'gemma3:12b': [200], 'openthinker:7b': [502] }),
    sleep: noSleep, log: (l) => lines.push(l),
  });
  const out = lines.join('\n');
  const ok = code === 2 && /DEGRADED \(SKIPPED, not GO\)/.test(out)
    && /catalog\.js is NOT implicated/.test(out) && /look at the network\/registry/.test(out)
    && /UNVERIFIED/.test(out)
    && !/NO-GO/.test(out) && !/^VERDICT: GO/m.test(out)
    && /SKIP {2}tag exists: openthinker:7b/.test(out)
    && /502/.test(out);                       // the verdict names WHY
  rec('S4a. persistent 502 → exit 2 DEGRADED, names the network, exonerates catalog.js', ok,
    `exit=${code} :: ${lines.at(-2)}`);

  const retried = calls.filter((c) => c === 'openthinker:7b').length === 3;
  rec('S4b. degraded only after every attempt is spent', retried,
    `openthinker probes=${calls.filter((c) => c === 'openthinker:7b').length}`);

  // The whole registry down must not be a GO either.
  reset();
  const c2 = await run({
    catalog: catalogOf('gemma3:12b', 'openthinker:7b'),
    fetchImpl: stub({ 'gemma3:12b': [503], 'openthinker:7b': [503] }),
    sleep: noSleep, log: quiet,
  });
  rec('S4c. registry wholly unreachable → exit 2, never a vacuous green', c2 === 2, `exit=${c2}`);
}

// ── S5 — absent beats degraded ───────────────────────────────────────────────
{
  reset();
  const lines = [];
  const code = await run({
    catalog: catalogOf('gemma3:nonexistent-tag', 'openthinker:7b'),
    fetchImpl: stub({ 'gemma3:nonexistent-tag': [404], 'openthinker:7b': [502] }),
    sleep: noSleep, log: (l) => lines.push(l),
  });
  const ok = code === 1 && /NO-GO/.test(lines.join('\n'));
  rec('S5. a real 404 during an outage still says NO-GO (degraded never masks absent)', ok,
    `exit=${code} :: ${lines.at(-2)}`);
}

// ── S6 — timeouts / network errors are degraded, not absent ──────────────────
{
  reset();
  const timeout = Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
  const t = await probeTag('gemma3:12b', { fetchImpl: stub({ 'gemma3:12b': [timeout] }), sleep: noSleep });
  const okT = t.verdict === 'degraded' && t.seen.every((s) => s === 'timeout') && t.tries === 3;

  reset();
  const dns = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
  const d = await probeTag('gemma3:12b', { fetchImpl: stub({ 'gemma3:12b': [dns] }), sleep: noSleep });
  const okD = d.verdict === 'degraded' && d.seen.every((s) => s === 'neterr:ENOTFOUND');

  rec('S6. timeout · DNS failure → degraded (never "the tag does not resolve")', okT && okD,
    `timeout=${t.verdict}(${t.seen[0]}) dns=${d.verdict}(${d.seen[0]})`);
}

// ── S7 — URL shape ───────────────────────────────────────────────────────────
{
  const ok = manifestUrl('gemma3:12b') === 'https://registry.ollama.ai/v2/library/gemma3/manifests/12b'
    && manifestUrl('vanilj/foo:q4') === 'https://registry.ollama.ai/v2/vanilj/foo/manifests/q4'
    && manifestUrl('gemma3') === 'https://registry.ollama.ai/v2/library/gemma3/manifests/latest';
  rec('S7. manifestUrl — library/ prefix · namespace passthrough · :latest default', ok,
    manifestUrl('gemma3:12b'));
}

// ── S8 — the timeout is WIRED, not merely handled ────────────────────────────
// S6 proves "a TimeoutError becomes degraded" — but it stubs the error in, so it
// stays green even if the abort signal is never passed to fetch and a real probe
// hangs forever. This stub instead HANGS until the caller's own signal fires: it
// throws TypeError if `init.signal` is missing, so deleting the wiring goes RED.
{
  reset();
  const hangUntilAborted = async (url, init) => {
    calls.push(url);
    return new Promise((_, reject) => {
      // `init.signal.…` throws TypeError if the wiring is deleted → seen becomes
      // `neterr:*` not `timeout`, and this check goes RED. The keepalive stands in
      // for a real in-flight socket: AbortSignal.timeout's timer is unref'd, so
      // without it Node would exit before the abort ever fires.
      const keepalive = setTimeout(() => reject(new Error('stub keepalive expired: the gate never aborted')), 5_000);
      init.signal.addEventListener('abort', () => {
        clearTimeout(keepalive);
        reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
      });
    });
  };
  let r, threw = null;
  try {
    r = await probeTag('gemma3:12b', { fetchImpl: hangUntilAborted, sleep: noSleep, timeoutMs: 25 });
  } catch (e) { threw = e; }
  const ok = !threw && r?.verdict === 'degraded' && r.seen.every((s) => s === 'timeout') && r.tries === 3;
  rec('S8. a hanging registry is aborted by the gate\'s OWN signal (timeout is wired)', ok,
    threw ? `probeTag threw ${threw.name}: ${threw.message} — signal not passed to fetch?`
      : `verdict=${r.verdict} tries=${r.tries} seen=${r.seen.join(',')}`);
}

// ── S9 — an empty catalog is vacuous, not green ──────────────────────────────
{
  const lines = [];
  const code = await run({ catalog: [], fetchImpl: stub({}), sleep: noSleep, log: (l) => lines.push(l) });
  const ok = code === 1 && /NO-GO/.test(lines.join('\n')) && /EMPTY/.test(lines.join('\n'));
  rec('S9. empty catalog → NO-GO (never "GO — all 0 catalog tags resolve")', ok,
    `exit=${code} :: ${lines.at(-2)}`);
}

// ── S10 — hf.co/ names are unsupported, never accused ────────────────────────
// `ollama pull hf.co/<user>/<repo>:<quant>` is legitimate but resolves against
// Hugging Face; registry.ollama.ai 404s it. Absent that guard, a correct entry
// would be reported as "does NOT exist upstream — fix catalog.js".
{
  const flags = isUnsupportedName('hf.co/bartowski/foo:Q4_K_M') && isUnsupportedName('HF.CO/x/y:z')
    && !isUnsupportedName('gemma3:12b') && !isUnsupportedName('vanilj/foo:q4');
  rec('S10a. isUnsupportedName flags hf.co/ only', flags, '');

  reset();
  const lines = [];
  // The stub 404s it, exactly as the live registry does — the guard must win.
  const code = await run({
    catalog: catalogOf('gemma3:12b', 'hf.co/bartowski/foo:Q4_K_M'),
    fetchImpl: stub({ 'gemma3:12b': [200] }),   // no plan for hf.co → must never be probed
    sleep: noSleep, log: (l) => lines.push(l),
  });
  const out = lines.join('\n');
  const ok = code === 2 && !/NO-GO/.test(out) && /NOT implicated/.test(out)
    && !calls.some((c) => c.includes('hf.co'));
  rec('S10b. an hf.co/ entry → unverified (exit 2), never a 404 accusation', ok,
    `exit=${code} probedHf=${calls.some((c) => c.includes('hf.co'))} :: ${lines.at(-2)}`);
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — catalog-tags probe: 404 bites · 5xx/timeout retries then DEGRADES · no vacuous green' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
