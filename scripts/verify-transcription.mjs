#!/usr/bin/env node
// verify-transcription.mjs — gate for the long-audio transcription orchestrator.
//
// C1 (the streaming /transcribe-file service endpoint) is live-verified separately
// (rejects vault paths, streams a real 45-min m4a). This gate covers the Node-side
// orchestrator C2 (transcribe-long.js): NDJSON stream parsing, progressive assembly,
// onSegment/onProgress callbacks, the health gate, empty-input + failure fallbacks,
// and — critically (§1) — that the decrypted temp file is always shredded.
//
// Pure unit test: fetch + getHealth are injected, no real service, no vault.

import { transcribeLongAudio } from '../src/enrich/transcribe-long.js';
import { TRANSCRIBE_FAULT_MESSAGE, portalAttachmentsRouter } from '../src/portal-attachments.js';
import { transcribeAttachment } from '../src/enrich/transcribe-attachment.js';
import { portalTranscriptionRouter } from '../src/portal-transcription.js';
import { transcribeNotReadyReason } from '../src/system/service-state.js';
import { startTranscribeSupervisor, getTranscriberHealth, _resetTranscribeSupervisor } from '../src/transcribe/supervisor.js';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import express from 'express';
import assert from 'node:assert/strict';

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`  [✓] ${name}`); };
const bad = (name, e) => { fail++; console.log(`  [✗] ${name}\n      ${e?.message || e}`); };
async function t(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e); } }

const healthOk = () => ({ status: 'ok', model: 'large-v3-turbo' });
const healthDown = () => ({ status: 'starting' });

// Build a fetch stub whose response body streams the given NDJSON lines in `chunks`
// (each chunk = a byte slice, possibly splitting a line across reads — the parser
// must reassemble). Records the request body so we can assert what was sent.
function streamingFetch(chunks, { okFlag = true } = {}) {
  const calls = [];
  const enc = new TextEncoder();
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    let i = 0;
    const body = {
      getReader() {
        return {
          async read() {
            if (i >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: enc.encode(chunks[i++]) };
          },
        };
      },
    };
    return { ok: okFlag, body: okFlag ? body : null };
  };
  impl.calls = calls;
  return impl;
}

async function tmpTxDirs() {
  const entries = await readdir(tmpdir());
  return entries.filter((n) => n.startsWith('myc-tx-'));
}

console.log('\ntranscribe-long orchestrator (C2)');

await t('assembles multi-segment NDJSON into full text', async () => {
  const fetchImpl = streamingFetch([
    JSON.stringify({ type: 'meta', duration: 30 }) + '\n',
    JSON.stringify({ type: 'segment', start: 0, end: 10, text: 'Hello ' }) + '\n',
    JSON.stringify({ type: 'segment', start: 10, end: 20, text: ' world' }) + '\n',
    JSON.stringify({ type: 'segment', start: 20, end: 30, text: 'again' }) + '\n',
    JSON.stringify({ type: 'done' }) + '\n',
  ]);
  const full = await transcribeLongAudio({ bytes: Buffer.from('x'), format: 'm4a', fetch: fetchImpl, getHealth: healthOk });
  assert.equal(full, 'Hello world again'); // per-segment .trim() then join(' ')
});

await t('reassembles a line split across two reads', async () => {
  const line = JSON.stringify({ type: 'segment', start: 0, end: 5, text: 'split-line' }) + '\n';
  const cut = Math.floor(line.length / 2);
  const fetchImpl = streamingFetch([
    JSON.stringify({ type: 'meta', duration: 5 }) + '\n' + line.slice(0, cut),
    line.slice(cut) + JSON.stringify({ type: 'done' }) + '\n',
  ]);
  const full = await transcribeLongAudio({ bytes: Buffer.from('x'), fetch: fetchImpl, getHealth: healthOk });
  assert.equal(full, 'split-line');
});

await t('onSegment gets progressive assembled-so-far text', async () => {
  const fetchImpl = streamingFetch([
    JSON.stringify({ type: 'segment', start: 0, end: 1, text: 'a' }) + '\n',
    JSON.stringify({ type: 'segment', start: 1, end: 2, text: 'b' }) + '\n',
    JSON.stringify({ type: 'segment', start: 2, end: 3, text: 'c' }) + '\n',
  ]);
  const seen = [];
  await transcribeLongAudio({
    bytes: Buffer.from('x'), fetch: fetchImpl, getHealth: healthOk,
    onSegment: (_seg, assembled) => { seen.push(assembled); },
  });
  assert.deepEqual(seen, ['a', 'a b', 'a b c']); // monotonically growing
});

await t('onProgress reports coveredSec/durationSec/segments', async () => {
  const fetchImpl = streamingFetch([
    JSON.stringify({ type: 'meta', duration: 100 }) + '\n',
    JSON.stringify({ type: 'segment', start: 0, end: 40, text: 'a' }) + '\n',
    JSON.stringify({ type: 'segment', start: 40, end: 90, text: 'b' }) + '\n',
  ]);
  const prog = [];
  await transcribeLongAudio({
    bytes: Buffer.from('x'), fetch: fetchImpl, getHealth: healthOk,
    onProgress: (p) => prog.push(p),
  });
  assert.equal(prog.length, 2);
  assert.deepEqual(prog[prog.length - 1], { coveredSec: 90, durationSec: 100, segments: 2 });
});

await t('sends language only when provided; path is under tmpdir', async () => {
  const fetchImpl = streamingFetch([JSON.stringify({ type: 'segment', start: 0, end: 1, text: 'x' }) + '\n']);
  await transcribeLongAudio({ bytes: Buffer.from('x'), format: 'm4a', language: 'lv', fetch: fetchImpl, getHealth: healthOk });
  assert.equal(fetchImpl.calls[0].body.language, 'lv');
  assert.ok(fetchImpl.calls[0].body.path.startsWith(tmpdir()), 'temp path must be under the OS tmpdir');
  assert.ok(fetchImpl.calls[0].body.path.endsWith('.m4a'), 'extension follows the format');
});

await t('omits language when not provided (auto-detect)', async () => {
  const fetchImpl = streamingFetch([JSON.stringify({ type: 'segment', start: 0, end: 1, text: 'x' }) + '\n']);
  await transcribeLongAudio({ bytes: Buffer.from('x'), fetch: fetchImpl, getHealth: healthOk });
  assert.equal(fetchImpl.calls[0].body.language, undefined);
});

await t('partial stream + error event → returns text gathered so far', async () => {
  const fetchImpl = streamingFetch([
    JSON.stringify({ type: 'segment', start: 0, end: 1, text: 'kept' }) + '\n',
    JSON.stringify({ type: 'error', message: 'decode blew up' }) + '\n',
    JSON.stringify({ type: 'segment', start: 1, end: 2, text: 'lost' }) + '\n',
  ]);
  const full = await transcribeLongAudio({ bytes: Buffer.from('x'), fetch: fetchImpl, getHealth: healthOk });
  assert.equal(full, 'kept'); // error short-circuits; nothing after it
});

await t('error before any segment → null (caller falls back)', async () => {
  const fetchImpl = streamingFetch([JSON.stringify({ type: 'error', message: 'no audio' }) + '\n']);
  const full = await transcribeLongAudio({ bytes: Buffer.from('x'), fetch: fetchImpl, getHealth: healthOk });
  assert.equal(full, null);
});

await t('health not ok → null WITHOUT calling the service or writing a temp file', async () => {
  const before = (await tmpTxDirs()).length;
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, body: null }; };
  const full = await transcribeLongAudio({ bytes: Buffer.from('x'), fetch: fetchImpl, getHealth: healthDown });
  assert.equal(full, null);
  assert.equal(called, false, 'must not hit the service when no model');
  assert.equal((await tmpTxDirs()).length, before, 'must not create a temp dir when gated out');
});

await t('empty bytes → null (no work)', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, body: null }; };
  assert.equal(await transcribeLongAudio({ bytes: Buffer.alloc(0), fetch: fetchImpl, getHealth: healthOk }), null);
  assert.equal(called, false);
});

await t('non-ok HTTP response → null', async () => {
  const fetchImpl = streamingFetch([], { okFlag: false });
  assert.equal(await transcribeLongAudio({ bytes: Buffer.from('x'), fetch: fetchImpl, getHealth: healthOk }), null);
});

await t('SECURITY: temp dir is shredded after success (no decrypted audio left)', async () => {
  const fetchImpl = streamingFetch([JSON.stringify({ type: 'segment', start: 0, end: 1, text: 'x' }) + '\n']);
  await transcribeLongAudio({ bytes: Buffer.from('secret-audio'), fetch: fetchImpl, getHealth: healthOk });
  assert.equal((await tmpTxDirs()).length, 0, 'no myc-tx- temp dir may survive');
});

await t('SECURITY: temp dir is shredded even when the stream throws mid-read', async () => {
  const enc = new TextEncoder();
  const fetchImpl = async () => ({
    ok: true,
    body: { getReader() { return { async read() { throw new Error('socket died'); } }; } },
  });
  await transcribeLongAudio({ bytes: Buffer.from('secret'), fetch: fetchImpl, getHealth: healthOk });
  assert.equal((await tmpTxDirs()).length, 0, 'temp dir must be cleaned even on a throw');
});

await t('already-aborted signal → null, no work', async () => {
  const ac = new AbortController(); ac.abort();
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, body: null }; };
  const full = await transcribeLongAudio({ bytes: Buffer.from('x'), fetch: fetchImpl, getHealth: healthOk, signal: ac.signal });
  assert.equal(full, null);
  assert.equal(called, false);
});

// ── QA6 P1 §2: the LOSSY NULL — a null return now carries its CAUSE out ──────────
// Before this, transcribeLongAudio returned `null` for ≥7 distinct causes and the owner
// saw one blank "unavailable". `onFault(reason, detail)` is the out-channel. Each test
// drives ONE cause and asserts the reason token — so a failed 30-min file can be told
// apart from a silent recording. The return type is unchanged (still string|null).
console.log('\nQA6 §2 — fault reasons survive the null');

const faultOf = async (opts) => {
  let reason = null, detail = null;
  const ret = await transcribeLongAudio({ ...opts, onFault: (r, d) => { reason = r; detail = d; } });
  return { ret, reason, detail };
};

await t('empty bytes → onFault "empty-audio"', async () => {
  const { ret, reason } = await faultOf({ bytes: Buffer.alloc(0), fetch: streamingFetch([]), getHealth: healthOk });
  assert.equal(ret, null); assert.equal(reason, 'empty-audio');
});

await t('health not ok → onFault "not-ready" with the STATUS as detail (not "no model")', async () => {
  const { ret, reason, detail } = await faultOf({ bytes: Buffer.from('x'), fetch: async () => { throw new Error('must not call'); }, getHealth: () => ({ status: 'loading' }) });
  assert.equal(ret, null); assert.equal(reason, 'not-ready'); assert.equal(detail, 'loading');
});

await t('non-ok HTTP (503 deps_missing) → onFault "service-error" carrying the code', async () => {
  const impl = async () => ({ ok: false, status: 503, json: async () => ({ error: 'deps_missing' }) });
  const { ret, reason, detail } = await faultOf({ bytes: Buffer.from('x'), fetch: impl, getHealth: healthOk });
  assert.equal(ret, null); assert.equal(reason, 'service-error'); assert.ok(String(detail).includes('deps_missing'), `detail=${detail}`);
});

await t('mid-stream error event → onFault "engine-error" (partial text still kept)', async () => {
  const impl = streamingFetch([
    JSON.stringify({ type: 'segment', start: 0, end: 1, text: 'kept' }) + '\n',
    JSON.stringify({ type: 'error', error: 'decode blew up' }) + '\n',
  ]);
  const { ret, reason, detail } = await faultOf({ bytes: Buffer.from('x'), fetch: impl, getHealth: healthOk });
  assert.equal(ret, 'kept'); assert.equal(reason, 'engine-error'); assert.equal(detail, 'decode blew up');
});

await t('stream completes with no words → onFault "no-speech" (distinct from a fault)', async () => {
  const impl = streamingFetch([JSON.stringify({ type: 'meta', duration: 5 }) + '\n', JSON.stringify({ type: 'done', segments: 0 }) + '\n']);
  const { ret, reason } = await faultOf({ bytes: Buffer.from('x'), fetch: impl, getHealth: healthOk });
  assert.equal(ret, null); assert.equal(reason, 'no-speech');
});

await t('transport throw mid-read → onFault "transport-error"', async () => {
  const impl = async () => ({ ok: true, body: { getReader() { return { async read() { throw new Error('socket died'); } }; } } });
  const { ret, reason } = await faultOf({ bytes: Buffer.from('x'), fetch: impl, getHealth: healthOk });
  assert.equal(ret, null); assert.equal(reason, 'transport-error');
});

await t('timeout abort → onFault "timeout" (a long file hitting the cap is NOT "unavailable")', async () => {
  // The reader rejects with an AbortError when the fetch signal fires — exactly what a real
  // fetch body does when the internal AbortController trips on the 1ms timeoutMs. No EXTERNAL
  // signal was passed, so the abort is the timeout → reason 'timeout', not 'canceled'.
  // An AbortError out of the reader with no EXTERNAL signal passed is, by construction, the
  // orchestrator's own timeoutMs cap firing. Rejecting immediately (rather than waiting on a
  // real unref'd timer) keeps the test deterministic and hang-free.
  const impl = async () => ({ ok: true, body: { getReader() { return { read: () => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) }; } } });
  const { ret, reason } = await faultOf({ bytes: Buffer.from('x'), fetch: impl, getHealth: healthOk });
  assert.equal(ret, null); assert.equal(reason, 'timeout');
});

await t('external signal aborted → onFault "canceled" (distinct from a timeout)', async () => {
  const ac = new AbortController(); ac.abort();
  const { ret, reason } = await faultOf({ bytes: Buffer.from('x'), fetch: streamingFetch([]), getHealth: healthOk, signal: ac.signal });
  assert.equal(ret, null); assert.equal(reason, 'canceled');
});

// ── QA6 P1 §2: the fault→copy table — every reason has words; "download a model"
//    belongs to EXACTLY ONE reason (the lie removed: a failed job read as "no model") ──
console.log('\nQA6 §2 — the fault→message table');

// Every reason transcribe-attachment.js can return has a mapped, non-blank message.
const REASONS = [
  'no-model', 'not-ready-yet', 'not-ready', 'engine-down', 'service-error', 'engine-error',
  'timeout', 'transport-error', 'canceled', 'no-speech', 'no-text', 'empty-audio', 'no-blob',
  'not-audio', 'not-found', 'lookup', 'failed',
];
await t('every fault reason maps to a non-blank owner message', async () => {
  for (const r of REASONS) assert.ok(TRANSCRIBE_FAULT_MESSAGE[r] && TRANSCRIBE_FAULT_MESSAGE[r].length > 8, `reason "${r}" has no message`);
});

await t('§2 anti-lie: ONLY "no-model" tells the owner to download a model', async () => {
  const downloadish = Object.entries(TRANSCRIBE_FAULT_MESSAGE)
    .filter(([, m]) => /download a transcription model/i.test(m))
    .map(([k]) => k);
  assert.deepEqual(downloadish, ['no-model'], `only no-model may say "download a model" — got ${JSON.stringify(downloadish)}`);
});

await t('a timeout reason does NOT read as "unavailable" or "no model"', async () => {
  const m = TRANSCRIBE_FAULT_MESSAGE.timeout;
  assert.ok(/time limit|longer|split/i.test(m), `timeout copy must name the cap — got "${m}"`);
  assert.ok(!/download a transcription model/i.test(m), 'a timeout must not tell the owner to download a model');
});

// ── QA6 P1 §2 (gate-hole close): the REAL health→reason derivation, exercised at its OWN sites ──
// The prior gate only checked TRANSCRIBE_FAULT_MESSAGE was a total table vs a hard-coded reason
// list — so reverting the derivation to always-'no-model' (the exact bug this PR kills) stayed 25/25
// green. These drive the ACTUAL derivation across service-health states at BOTH sites that render it:
// the shared helper, the in-process job (transcribeAttachment), and the route's 409 branch. A mutation
// that collapses any of them back to a single reason now REDs.
console.log('\nQA6 §2 — health→reason derivation (the property, not the table)');

// Property of the ONE shared helper both sites call. Only a genuine owner CHOICE says "no model".
const REASON_CASES = [
  ['loading', 'not-ready-yet'], ['starting', 'not-ready-yet'], ['downloading', 'not-ready-yet'],
  ['installing_deps', 'not-ready-yet'], ['no_model', 'no-model'], ['down', 'engine-down'],
  ['error', 'engine-down'], ['deps_missing', 'not-ready'], ['unavailable', 'not-ready'],
  ['unknown', 'not-ready'], [null, 'not-ready'],
];
await t('transcribeNotReadyReason maps every status to the right token — ONLY no_model ⇒ "no-model"', async () => {
  for (const [status, want] of REASON_CASES) {
    assert.equal(transcribeNotReadyReason(status), want, `status "${status}" ⇒ expected "${want}", got "${transcribeNotReadyReason(status)}"`);
  }
  // The load-bearing anti-lie: NO non-choice status may derive 'no-model'.
  for (const [status, want] of REASON_CASES) {
    if (status !== 'no_model') assert.notEqual(want, 'no-model');
    if (status !== 'no_model') assert.notEqual(transcribeNotReadyReason(status), 'no-model', `status "${status}" must never derive "no-model"`);
  }
});

// The in-process job (transcribeAttachment) — its OWN output reason, with health INJECTED, over a
// valid audio row. This exercises the real call site: reverting transcribe-attachment.js's reason
// line back to always-'no-model' makes every non-no_model case FAIL here.
const audioDb = {
  attachments: { getById: async (id, uid) => ({ id, user_id: uid, file_type: 'audio/m4a', local_path: `/blob/${id}` }) },
};
await t('transcribeAttachment derives the reason from LIVE health (loading≠no-model≠engine-down)', async () => {
  const reasonFor = async (status) => (await transcribeAttachment(audioDb, 'u1', 'a1', { getHealth: () => ({ status }) })).reason;
  assert.equal(await reasonFor('loading'), 'not-ready-yet', 'a loading model is retryable-by-waiting, never "no-model"');
  assert.equal(await reasonFor('downloading'), 'not-ready-yet');
  assert.equal(await reasonFor('no_model'), 'no-model', 'only a genuinely-absent model is "no-model"');
  assert.equal(await reasonFor('down'), 'engine-down', 'a crashed engine is a fault, not "download a model"');
  assert.equal(await reasonFor('deps_missing'), 'not-ready');
  // …and the anti-lie as a set: the ONLY status that yields "no-model" is no_model.
  for (const s of ['loading', 'starting', 'downloading', 'installing_deps', 'down', 'error', 'deps_missing', 'unavailable']) {
    assert.notEqual(await reasonFor(s), 'no-model', `status "${s}" must not tell the owner to download a model`);
  }
});

await t('transcribeAttachment retryability tracks the state (loading + faults retry; a choice does not)', async () => {
  const r = async (status) => await transcribeAttachment(audioDb, 'u1', 'a1', { getHealth: () => ({ status }) });
  assert.equal((await r('loading')).retryable, true, 'a loading model IS retryable-by-waiting');
  assert.equal((await r('down')).retryable, true, 'a fault is retryable');
  assert.equal((await r('deps_missing')).retryable, true, 'a re-attemptable install is retryable');
  assert.equal((await r('no_model')).retryable, false, 'an owner CHOICE is not a Retry — it is a decision');
});

// The route's 409 branch (portal-attachments.js) — mounted, driven, health INJECTED. Same derivation,
// same anti-lie, at the pre-flight surface the client actually hits.
async function mountAttachments({ getHealth }) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/portal', portalAttachmentsRouter({ db: audioDb, userId: 'u1', getHealth }));
  const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  return { base: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => s.close(r)) };
}
await t('POST /attachments/:id/transcribe 409 branch derives the SAME reason from live health', async () => {
  const call = async (status) => {
    const app = await mountAttachments({ getHealth: () => ({ status, message: null, detail: null }) });
    try {
      const res = await fetch(`${app.base}/api/v1/portal/attachments/a1/transcribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      return { status: res.status, body: await res.json() };
    } finally { await app.close(); }
  };
  const loading = await call('loading');
  assert.equal(loading.status, 409); assert.equal(loading.body.error, 'not-ready-yet'); assert.equal(loading.body.retryable, true);
  const noModel = await call('no_model');
  assert.equal(noModel.body.error, 'no-model');
  assert.match(noModel.body.message, /download a transcription model/i, 'the no_model 409 keeps the actionable "download a model" copy');
  const down = await call('down');
  assert.equal(down.body.error, 'engine-down'); assert.equal(down.body.retryable, true);
  assert.ok(!/download a transcription model/i.test(down.body.message), 'a crashed engine must NOT tell the owner to download a model');
});

// ⚠️ ROUTE-ONLY DIVERGENCE (QA6 re-review, gate-hole close). The three probes above pin only
// loading/no_model/down — so a route that special-cases some OTHER status (e.g. `status==='error'
// ⇒ 'no-model'`) diverges from the shared derivation and escapes: the anti-lie above tests the
// helper directly, not the route's own 409 reason. Drive the FULL REASON_CASES set through the
// live 409 branch and assert the route reason EQUALS transcribeNotReadyReason(status) for every
// status. A route-only reason override now REDs here.
await t('POST .../transcribe 409 derives the SAME reason as the shared helper for EVERY status', async () => {
  const call = async (status) => {
    const app = await mountAttachments({ getHealth: () => ({ status, message: null, detail: null }) });
    try {
      const res = await fetch(`${app.base}/api/v1/portal/attachments/a1/transcribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      return { status: res.status, body: await res.json() };
    } finally { await app.close(); }
  };
  for (const [status, want] of REASON_CASES) {
    const r = await call(status);
    assert.equal(r.status, 409, `status "${status}" must pre-flight 409 (not ready)`);
    assert.equal(r.body.error, want, `route 409 reason for "${status}" must equal the shared derivation "${want}" — got "${r.body.error}"`);
    if (status !== 'no_model') assert.ok(!/download a transcription model/i.test(r.body.message || ''), `status "${status}" must not render the "download a model" copy`);
  }
});

// ── QA6 P1 §3 (gate-hole close): the retry route → nudge() wiring, honest-fail, 401-gated ──
// Mirror of HR12/HR13/HR14 for POST /transcription/retry. Removing nudge() from the route (gutting it
// to a no-op) previously left the suite green; this asserts the route PRESSES the ONE resume path
// exactly once, reflects the RE-READ health (never a fake ✓), and is session-gated.
console.log('\nQA6 §3 — POST /transcription/retry presses nudge() (honest + gated)');

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
// A fake spawn that never resolves the service (so no real python), resolves the `-c` deps probe.
function mkFakeSpawn() {
  const fn = (_bin, args) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 4242;
    child.kill = () => {};
    if (Array.isArray(args) && (args[0] === '-c' || args.includes('-m'))) setImmediate(() => child.emit('close', 0));
    return child; // the --serve child stays alive, never exits
  };
  return fn;
}
async function mountTranscriptionRetry({ authed }) {
  const db = { users: { getSettings: async () => ({ transcribeModel: 'small' }) } };
  const app = express();
  app.use(express.json());
  app.use('/api/v1/portal', portalTranscriptionRouter({
    db, userId: 'u1',
    authenticatePortalRequest: () => (authed ? { userId: 'u1' } : null),
  }));
  const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  return { base: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => s.close(r)) };
}

await t('retry route calls nudge() EXACTLY once and answers with the re-read health (never a fake ✓)', async () => {
  _resetTranscribeSupervisor();
  const sup = startTranscribeSupervisor({ home: process.cwd(), pythonBin: 'python3', port: 18093, model: 'small', fetch: async () => { throw new Error('ECONNREFUSED'); }, spawn: mkFakeSpawn(), log: () => {} });
  let nudges = 0;
  sup.nudge = () => { nudges += 1; }; // spy — the route reaches this exact instance via ensureTranscribeSupervisor
  await settle(120);
  const app = await mountTranscriptionRetry({ authed: true });
  try {
    const res = await fetch(`${app.base}/api/v1/portal/transcription/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(nudges, 1, `the route must press nudge() exactly once — got ${nudges} (a no-op route reds here)`);
    assert.equal(body.ok, false, 'an unreachable engine is NOT ready — ok reflects the re-read WORLD, never "request accepted"');
    assert.notEqual(body.state, 'ready', `state is the honest re-read, not a claim — got ${body.state}`);
  } finally { await app.close(); _resetTranscribeSupervisor(); }
});

await t('retry route is 401-gated: unauthenticated → 401 and nudge() is NEVER pressed', async () => {
  _resetTranscribeSupervisor();
  const sup = startTranscribeSupervisor({ home: process.cwd(), pythonBin: 'python3', port: 18093, model: 'small', fetch: async () => { throw new Error('ECONNREFUSED'); }, spawn: mkFakeSpawn(), log: () => {} });
  let nudges = 0;
  sup.nudge = () => { nudges += 1; };
  await settle(120);
  const app = await mountTranscriptionRetry({ authed: false });
  try {
    const res = await fetch(`${app.base}/api/v1/portal/transcription/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 401);
    assert.equal(nudges, 0, 'an unauthenticated retry must not touch the supervisor');
  } finally { await app.close(); _resetTranscribeSupervisor(); }
});

console.log(`\n${fail === 0 ? 'VERDICT: GO' : 'VERDICT: NO-GO'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
