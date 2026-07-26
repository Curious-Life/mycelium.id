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
import { readCoverage, stitchTranscript, stitchAll, writeCoverage } from '../src/enrich/transcript-coverage.js';
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

// ⚠️ EVERY "SUCCESS" FIXTURE BELOW NOW CARRIES `{type:'done'}` — AND THAT EDIT IS PART OF THE FIX.
// These fixtures used to end at EOF with NO sentinel and assert a successful full transcript, which
// made this gate an ASSERTION THAT EOF MEANS SUCCESS (D-076, M-001 class: a gate green for the wrong
// reason, codifying the defect as correct behaviour). The service always emits the sentinel
// (pipeline/transcribe-service.py), so a fixture without one was never modelling reality — it was
// modelling a TRUNCATED stream and calling it a pass. The `stream-truncated` section below asserts
// the opposite property, and it is why these edits cannot be quietly reverted.
await t('onSegment gets progressive assembled-so-far text', async () => {
  const fetchImpl = streamingFetch([
    JSON.stringify({ type: 'segment', start: 0, end: 1, text: 'a' }) + '\n',
    JSON.stringify({ type: 'segment', start: 1, end: 2, text: 'b' }) + '\n',
    JSON.stringify({ type: 'segment', start: 2, end: 3, text: 'c' }) + '\n',
    JSON.stringify({ type: 'done', segments: 3 }) + '\n',
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
    JSON.stringify({ type: 'done', segments: 2 }) + '\n',
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
  const fetchImpl = streamingFetch([JSON.stringify({ type: 'segment', start: 0, end: 1, text: 'x' }) + '\n' + JSON.stringify({ type: 'done', segments: 1 }) + '\n']);
  await transcribeLongAudio({ bytes: Buffer.from('x'), format: 'm4a', language: 'lv', fetch: fetchImpl, getHealth: healthOk });
  assert.equal(fetchImpl.calls[0].body.language, 'lv');
  assert.ok(fetchImpl.calls[0].body.path.startsWith(tmpdir()), 'temp path must be under the OS tmpdir');
  assert.ok(fetchImpl.calls[0].body.path.endsWith('.m4a'), 'extension follows the format');
});

await t('omits language when not provided (auto-detect)', async () => {
  const fetchImpl = streamingFetch([JSON.stringify({ type: 'segment', start: 0, end: 1, text: 'x' }) + '\n' + JSON.stringify({ type: 'done', segments: 1 }) + '\n']);
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
  const fetchImpl = streamingFetch([JSON.stringify({ type: 'segment', start: 0, end: 1, text: 'x' }) + '\n' + JSON.stringify({ type: 'done', segments: 1 }) + '\n']);
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

// ══════════════════════════════════════════════════════════════════════════════════════════════
//  D-076 — LONG AUDIO WAS SILENTLY TRUNCATED. Coverage honesty, resume, and seam stitching.
// ══════════════════════════════════════════════════════════════════════════════════════════════
// MUTATION-TESTED: each check below was watched failing against the pre-fix behaviour it targets.
// The mutations are recorded per-check so a future reader can re-run them; every one was executed.
console.log('\nD-076 — a partial transcript can never read as complete');

const collect = async (opts) => {
  let fault = null, faultDetail = null, coverage = null;
  const ret = await transcribeLongAudio({
    ...opts,
    onFault: (r, d) => { fault = r; faultDetail = d; },
    onCoverage: (c) => { coverage = c; },
  });
  return { ret, fault, faultDetail, coverage };
};

// D1. THE HEADLINE. The service answers HTTP/1.0 `Connection: close` with no Content-Length and no
// chunked framing, so a cut body and a complete body are the SAME BYTES on the wire. Only the
// `done` sentinel distinguishes them.
// MUTATION-TESTED: deleting the `if (!sawDone)` block in transcribe-long.js (i.e. restoring
// EOF-as-success) → this check REDs on `fault === 'stream-truncated'` and on `complete === false`.
await t('D1. EOF with NO done sentinel → fault "stream-truncated" + coverage INCOMPLETE (text kept)', async () => {
  const impl = streamingFetch([
    JSON.stringify({ type: 'meta', duration: 1800 }) + '\n',
    JSON.stringify({ type: 'segment', start: 0, end: 300, text: 'first five minutes' }) + '\n',
  ]);
  const { ret, fault, coverage } = await collect({ bytes: Buffer.from('x'), fetch: impl, getHealth: healthOk });
  assert.equal(ret, 'first five minutes', 'the text it DID get is real and must be kept for the resume');
  assert.equal(fault, 'stream-truncated', `a cut stream must fault — got ${fault}`);
  assert.ok(coverage, 'coverage must be reported on every path that reached the stream');
  assert.equal(coverage.complete, false, 'EOF is NOT evidence of completion');
  assert.equal(coverage.coveredSec, 300);
  assert.equal(coverage.durationSec, 1800);
});

// D2. The positive case must still pass — a gate that only asserts failure would be satisfied by
// marking EVERYTHING incomplete, which would make the drain re-transcribe the library forever.
// MUTATION-TESTED: making `complete` unconditionally false → this check REDs on complete === true.
await t('D2. done sentinel → coverage COMPLETE and no fault', async () => {
  const impl = streamingFetch([
    JSON.stringify({ type: 'meta', duration: 30 }) + '\n',
    JSON.stringify({ type: 'segment', start: 0, end: 30, text: 'all of it' }) + '\n',
    JSON.stringify({ type: 'done', segments: 1 }) + '\n',
  ]);
  const { ret, fault, coverage } = await collect({ bytes: Buffer.from('x'), fetch: impl, getHealth: healthOk });
  assert.equal(ret, 'all of it');
  assert.equal(fault, null, `a complete stream must not fault — got ${fault}`);
  assert.equal(coverage.complete, true);
});

// D3. Trailing silence is NOT truncation. VAD emits no segment for a silent tail, so coverage
// legitimately falls short of duration on a complete file. Gating completeness on the RATIO would
// mark such files incomplete forever and re-decode them on every drain cycle.
// MUTATION-TESTED: replacing the sentinel check with `coveredSec >= durationSec * 0.95` → this
// check REDs (60s of a 100s file with a done sentinel is reported incomplete).
await t('D3. done + coverage far short of duration (trailing silence) is COMPLETE, not truncated', async () => {
  const impl = streamingFetch([
    JSON.stringify({ type: 'meta', duration: 100 }) + '\n',
    JSON.stringify({ type: 'segment', start: 0, end: 60, text: 'speech then silence' }) + '\n',
    JSON.stringify({ type: 'done', segments: 1 }) + '\n',
  ]);
  const { fault, coverage } = await collect({ bytes: Buffer.from('x'), fetch: impl, getHealth: healthOk });
  assert.equal(coverage.complete, true, 'a quiet tail must not make a finished file look truncated');
  assert.equal(fault, null);
});

// D4. A mid-stream engine error already faulted BEFORE this fix — the bug was that the CALL SITE
// discarded the fault whenever text came back. Coverage is what makes the claim enforceable.
// MUTATION-TESTED: removing `reportCoverage(false)` from the `ev.type === 'error'` branch → this
// check REDs on `coverage` being null (and D6 then REDs on ok:true).
await t('D4. mid-stream engine error → fault kept AND coverage INCOMPLETE', async () => {
  const impl = streamingFetch([
    JSON.stringify({ type: 'meta', duration: 600 }) + '\n',
    JSON.stringify({ type: 'segment', start: 0, end: 120, text: 'two minutes' }) + '\n',
    JSON.stringify({ type: 'error', error: 'CUDA OOM' }) + '\n',
  ]);
  const { ret, fault, coverage } = await collect({ bytes: Buffer.from('x'), fetch: impl, getHealth: healthOk });
  assert.equal(ret, 'two minutes');
  assert.equal(fault, 'engine-error');
  assert.equal(coverage.complete, false);
  assert.equal(coverage.coveredSec, 120);
});

// D5. RESUME. The offset must reach the service, and the returned relative timestamps must come
// back absolute — but ONLY when the service confirms it honoured the offset.
// MUTATION-TESTED: dropping `start` from the request body → REDs on the body assertion. Using
// `offset` from the request instead of the echoed meta → REDs on the old-service check below.
await t('D5. resume sends `start` and rebases timestamps onto the ECHOED offset', async () => {
  const impl = streamingFetch([
    JSON.stringify({ type: 'meta', duration: 1800, offset: 300 }) + '\n',
    JSON.stringify({ type: 'segment', start: 0, end: 200, text: 'the tail' }) + '\n',
    JSON.stringify({ type: 'done', segments: 1, offset: 300 }) + '\n',
  ]);
  const { ret, coverage } = await collect({ bytes: Buffer.from('x'), fetch: impl, getHealth: healthOk, startSec: 300 });
  assert.equal(impl.calls[0].body.start, 300, 'the resume offset must reach the service');
  assert.equal(ret, 'the tail');
  assert.equal(coverage.startSec, 300, 'coverage carries the offset the service HONOURED');
  assert.equal(coverage.coveredSec, 500, 'segment end 200 at offset 300 is absolute second 500');
  assert.equal(coverage.complete, true);
});

await t('D5b. an OLD service that ignores `start` (no meta.offset) reports startSec 0 → caller REPLACES', async () => {
  const impl = streamingFetch([
    JSON.stringify({ type: 'meta', duration: 1800 }) + '\n',           // no `offset` — pre-D-076 service
    JSON.stringify({ type: 'segment', start: 0, end: 1800, text: 'the whole thing again' }) + '\n',
    JSON.stringify({ type: 'done', segments: 1 }) + '\n',
  ]);
  const { coverage } = await collect({ bytes: Buffer.from('x'), fetch: impl, getHealth: healthOk, startSec: 300 });
  assert.equal(coverage.startSec, 0, 'an un-echoed offset must NOT be trusted — that would duplicate 5 minutes of speech');
  assert.equal(coverage.coveredSec, 1800, 'timestamps stay as sent when the offset was not honoured');
});

// ── The CALL SITE: transcribeAttachment must never return ok on an incomplete run ─────────────
console.log('\nD-076 — transcribeAttachment: ok:true must be EARNED');

function mkAttachmentDb({ transcript = null, metadata = null } = {}) {
  const row = { id: 'a1', user_id: 'u1', file_type: 'audio/ogg', file_name: 'v.ogg', local_path: 'u1/blob', transcript, metadata };
  const writes = [];
  return {
    row, writes,
    attachments: {
      getById: async () => ({ ...row }),
      update: async (_id, fields) => {
        writes.push(fields);
        if ('transcript' in fields) row.transcript = fields.transcript;
        if ('metadata' in fields) row.metadata = fields.metadata;
      },
    },
    activityFeed: { begin: async () => 'f1', finish: async () => {} },
  };
}

// The blob read and the transport are injected: this is a UNIT gate with no vault and no master
// key, and the property under test is the COVERAGE STATE MACHINE, not decryption. The compute
// governor runs for real (a BULK ticket is granted in-process), so the D-001 admission path is
// exercised rather than stubbed.
const fakeBlob = async () => Buffer.from('OggS-not-real-audio');
const runJob = (db, opts) => transcribeAttachment(db, 'u1', 'a1', { getHealth: healthOk, getBlob: fakeBlob, ...opts });

// D6. THE PRIMARY DEFECT AT ITS CALL SITE.
// MUTATION-TESTED: restoring `if (full) { save; feed done; return {ok:true} }` in
// transcribe-attachment.js (i.e. keying success off text instead of coverage) → this check REDs on
// `ok === false`, and D7 REDs because no incomplete marker is written.
await t('D6. a truncated stream returns ok:FALSE (never done) and keeps the partial text', async () => {
  const db = mkAttachmentDb();
  const impl = streamingFetch([
    JSON.stringify({ type: 'meta', duration: 1800 }) + '\n',
    JSON.stringify({ type: 'segment', start: 0, end: 240, text: 'four minutes of a thirty minute file' }) + '\n',
  ]);
  const r = await runJob(db, { fetchImpl: impl });
  assert.equal(r.ok, false, 'a partial transcription must NOT report success');
  assert.equal(r.partial, true, 'the caller must be told it is a partial, so the drain can resume it');
  assert.equal(r.reason, 'stream-truncated');
  assert.ok(String(db.row.transcript || '').includes('four minutes'), 'the text it did get must be persisted');
});

// D7. The marker and the text must land in ONE update — a crash between two updates would strand a
// partial with no marker, which is precisely what made D-076 permanent.
// MUTATION-TESTED: splitting persist() into two db.attachments.update calls (transcript, then
// metadata) → this check REDs on the "same update" assertion.
// ⚠️ THE FIXTURE CARRIES 25 SEGMENTS ON PURPOSE. transcribe-attachment.js only writes a
// PROGRESSIVE save every ~10 segments, so a 1-segment fixture exercises the FINAL persist and
// nothing else — which is how the first draft of this check passed while the progressive save wrote
// `transcript` with no marker (caught by mutation M8: renaming the progressive save's `metadata`
// field left the gate green). The progressive save is the write that made D-076 permanent, so it is
// the write that must be covered.
await t('D7. EVERY write carrying transcript text carries coverage in the SAME update (incl. the progressive save)', async () => {
  const db = mkAttachmentDb();
  const lines = [JSON.stringify({ type: 'meta', duration: 1800 }) + '\n'];
  for (let i = 0; i < 25; i++) lines.push(JSON.stringify({ type: 'segment', start: i * 10, end: (i + 1) * 10, text: `seg${i}` }) + '\n');
  const impl = streamingFetch(lines);   // …and NO done sentinel: the stream was cut
  await runJob(db, { fetchImpl: impl });
  const withText = db.writes.filter((w) => 'transcript' in w);
  assert.ok(withText.length >= 3, `the progressive save must have fired (25 segments / 10) — got ${withText.length} text writes`);
  for (const [i, w] of withText.entries()) {
    assert.ok('metadata' in w, `write #${i} carries transcript text with NO coverage — a crash here strands a partial as permanently ineligible`);
    const c = readCoverage(w.metadata);
    assert.ok(c && c.incomplete === true, `write #${i} must carry the incomplete marker (got ${JSON.stringify(c)})`);
  }
  const cov = readCoverage(db.row.metadata);
  assert.equal(cov.incomplete, true, 'the drain marker must be set');
  assert.equal(cov.complete, false);
});

// D8. The complete case still writes a COMPLETE marker — otherwise the drain would pick every
// finished file up again forever.
// MUTATION-TESTED: hard-coding `complete: false` in the persist() call → this check REDs.
await t('D8. a complete stream returns ok:true and clears the incomplete marker', async () => {
  const db = mkAttachmentDb();
  const impl = streamingFetch([
    JSON.stringify({ type: 'meta', duration: 30 }) + '\n',
    JSON.stringify({ type: 'segment', start: 0, end: 30, text: 'complete transcript' }) + '\n',
    JSON.stringify({ type: 'done', segments: 1 }) + '\n',
  ]);
  const r = await runJob(db, { fetchImpl: impl });
  assert.equal(r.ok, true);
  const cov = readCoverage(db.row.metadata);
  assert.equal(cov.complete, true);
  assert.equal(cov.incomplete, false, 'a complete row must carry NO drain marker');
});

// D9. RESUME END-TO-END: a second pass over a row left partial by the first must start at the
// recorded coverage (minus the lookback) and STITCH, not restart and not duplicate.
// MUTATION-TESTED: making resumeStartSec() always return 0 → REDs on the `start` assertion.
// Removing the stitch (plain concatenation) → REDs on the duplicate-word assertion.
await t('D9. a second pass resumes from recorded coverage and stitches the seam', async () => {
  const db = mkAttachmentDb();
  const cut = streamingFetch([
    JSON.stringify({ type: 'meta', duration: 600 }) + '\n',
    JSON.stringify({ type: 'segment', start: 0, end: 300, text: 'the first half ends with these words' }) + '\n',
  ]);
  const first = await runJob(db, { fetchImpl: cut });
  assert.equal(first.ok, false);
  const covered = readCoverage(db.row.metadata).coveredSec;
  assert.equal(covered, 300);

  // The resume re-transcribes the lookback, so the tail legitimately REPEATS the last words.
  const rest = streamingFetch([
    JSON.stringify({ type: 'meta', duration: 600, offset: 298.5 }) + '\n',
    JSON.stringify({ type: 'segment', start: 0, end: 301.5, text: 'with these words and then the second half' }) + '\n',
    JSON.stringify({ type: 'done', segments: 1, offset: 298.5 }) + '\n',
  ]);
  const second = await runJob(db, { fetchImpl: rest });
  assert.equal(rest.calls[0].body.start, 298.5, 'the resume must start at coveredSec − lookback, not 0');
  assert.equal(second.ok, true, 'the resumed pass completed the file');
  const text = db.row.transcript;
  assert.equal(text, 'the first half ends with these words and then the second half',
    `seam must de-duplicate exactly once — got "${text}"`);
  assert.equal((text.match(/with these words/g) || []).length, 1, 'the overlap must not appear twice');
  assert.equal(readCoverage(db.row.metadata).complete, true);
});

// ── The DRAIN PREDICATE, against REAL SQL ────────────────────────────────────────────────────
console.log('\nD-076 — the drain predicate selects partials and skips finished rows');

// D10. MUTATION-TESTED: restoring `AND (transcript IS NULL OR transcript = '')` in
// db/attachments.js → REDs on the "partial is eligible" assertion. Dropping `json_valid` → REDs on
// the malformed-metadata row (the whole query throws "malformed JSON" and returns nothing).
await t('D10. listPendingTranscription: partial IS eligible, complete is NOT, malformed metadata cannot break the query', async () => {
  const Database = (await import('better-sqlite3')).default;
  const sdb = new Database(':memory:');
  sdb.exec(`CREATE TABLE attachments (id TEXT PRIMARY KEY, user_id TEXT, local_path TEXT, file_type TEXT,
            transcript TEXT, description TEXT, metadata TEXT, created_at TEXT)`);
  const ins = sdb.prepare('INSERT INTO attachments VALUES (?,?,?,?,?,?,?,?)');
  const mk = (id, transcript, metadata, ft = 'audio/ogg') => ins.run(id, 'u1', `u1/${id}`, ft, transcript, null, metadata, `2026-01-0${id.slice(-1)}`);
  mk('a1', null, null);                                                             // never transcribed
  mk('a2', 'a full transcript', null);                                              // LEGACY complete (no marker)
  mk('a3', 'only part of it', JSON.stringify({ transcription: { incomplete: 1, coveredSec: 240 } }));  // PARTIAL
  mk('a4', 'a full transcript', JSON.stringify({ transcription: { complete: true, coveredSec: 30 } })); // complete
  mk('a5', 'a full transcript', 'this is not json at all');                          // malformed metadata
  // A partial written by the LIVE TURN, whose row has a NULL file_type (the channel daemon decides
  // `kind` itself and does not always store an audio mime). The audio predicate alone can never
  // select it, so the coverage marker has to (adversarial review, MEDIUM-8).
  mk('a6', 'partial from a live turn', JSON.stringify({ transcription: { incomplete: 1, coveredSec: 240 } }), null);
  // A genuinely SILENT recording: empty transcript, but a coverage record that EARNED `complete`.
  // The first clause (`transcript = ''`) still matches it, so without the complete-guard the drain
  // fully re-decodes a silent file on every boot forever (adversarial review, MEDIUM-9).
  mk('a7', '', JSON.stringify({ transcription: { complete: true, durationSec: 300 } }));
  const { createAttachmentsNamespace } = await import('../src/db/attachments.js');
  const ns = createAttachmentsNamespace({
    d1Query: async (sql, params) => ({ results: sdb.prepare(sql).all(...params) }),
    firstRow: (r) => r.results?.[0] ?? null,
  });
  const ids = await ns.listPendingTranscription('u1', { limit: 50 });
  assert.ok(ids.includes('a1'), 'an untranscribed row is pending');
  assert.ok(ids.includes('a3'), 'a PARTIAL row must be pending — this is the exclusion that made D-076 permanent');
  assert.ok(!ids.includes('a2'), 'a legacy complete row must NOT be re-transcribed (no marker ⇒ not pending)');
  assert.ok(!ids.includes('a4'), 'an explicitly-complete row must NOT be pending');
  assert.ok(!ids.includes('a5'), 'malformed metadata ⇒ not pending, and must not throw');
  assert.ok(ids.includes('a6'), 'a partial with a NULL file_type must still be reachable — the marker proves it is audio');
  assert.ok(!ids.includes('a7'), 'a silent file that EARNED complete must not be re-decoded on every boot');
  assert.equal(ids.length, 3, `exactly a1 + a3 + a6 — got ${JSON.stringify(ids)}`);
});

// D10b. SQL THREE-VALUED LOGIC. The complete-guard is written with `IS 1`, not `= 1`, because
// json_extract returns NULL when the key is absent — and `NOT (… = 1)` is then NULL, which is not
// TRUE, so EVERY partial (whose record has no `complete` key) gets dropped. Written with `=`, the
// guard added for MEDIUM-9 silently re-created D-076. This pins the exact operator.
// MUTATION-TESTED: changing `IS 1` back to `= 1` in db/attachments.js → D10 REDs on "a PARTIAL row
// must be pending", which is how this was caught in the first place.
await t('D10b. the complete-guard uses the NULL-safe comparison (a record without the key is still pending)', async () => {
  const Database = (await import('better-sqlite3')).default;
  const sdb = new Database(':memory:');
  // The three shapes the guard must distinguish, reduced to the operator under test.
  sdb.exec(`CREATE TABLE t (id TEXT, metadata TEXT)`);
  const ins = sdb.prepare('INSERT INTO t VALUES (?,?)');
  ins.run('has-complete', JSON.stringify({ transcription: { complete: true } }));
  ins.run('no-key', JSON.stringify({ transcription: { incomplete: 1 } }));
  ins.run('null-meta', null);
  const q = (op) => sdb.prepare(
    `SELECT id FROM t WHERE NOT (metadata IS NOT NULL AND json_valid(metadata)
       AND json_extract(metadata, '$.transcription.complete') ${op} 1)`).all().map((r) => r.id);
  assert.deepEqual(q('IS'), ['no-key', 'null-meta'], 'IS keeps rows whose record has no complete key');
  assert.deepEqual(q('='), ['null-meta'], 'sanity: `=` DROPS the partial — the trap this guards against');
});

// ── SEAM STITCHING ───────────────────────────────────────────────────────────────────────────
console.log('\nD-076 — seam de-dup: no duplicated and no clipped words at a chunk boundary');

// D11. MUTATION-TESTED: replacing stitchTranscript's body with `[a, b].join(' ')` → REDs on the
// duplicate cases. Lowering MIN_SEAM_WORDS to 1 → REDs on the coincidental-single-word case.
await t('D11. stitchTranscript removes the overlap, keeps everything else, and refuses 1-word coincidences', async () => {
  // the ordinary case: a real multi-word overlap is removed exactly once
  assert.equal(stitchTranscript('one two three four', 'three four five six'), 'one two three four five six');
  // punctuation + case must not defeat the match
  assert.equal(stitchTranscript('we went to the Store.', 'to the store and then home'), 'we went to the Store. and then home');
  // the LONGEST overlap wins over a shorter coincidental tail match
  assert.equal(stitchTranscript('a b c d e f', 'c d e f g'), 'a b c d e f g');
  // ONE shared word is a coincidence, not a seam — deleting it would delete real speech
  assert.equal(stitchTranscript('I walked to the', 'the market was closed'), 'I walked to the the market was closed');
  // no overlap at all → plain join, nothing lost
  assert.equal(stitchTranscript('alpha beta', 'gamma delta'), 'alpha beta gamma delta');
  // empty sides
  assert.equal(stitchTranscript('', 'only this'), 'only this');
  assert.equal(stitchTranscript('only this', ''), 'only this');
  // n-way
  assert.equal(stitchAll(['a b c', 'b c d', 'c d e']), 'a b c d e');
});

// D11b. THE SEAM MUST NEVER DELETE REAL SPEECH. A draft dropped A's last word whenever it was a
// strict prefix of B's first word, meaning to repair a mid-word clip — but nothing distinguishes a
// CLIPPED fragment from a COMPLETE short word, and the failure mode is deletion, the one direction
// this module documents as unrecoverable. All three inputs below LOST a real word.
// MUTATION-TESTED: restoring the prefix fallback in transcript-coverage.js
// (`if (tail.length >= 3 && head.startsWith(tail)) return [...A.slice(0,-1), ...B]`) → this check
// REDs on every case.
await t('D11b. a sub-word prefix at the seam never deletes a real word (duplication is recoverable, deletion is not)', async () => {
  assert.equal(stitchTranscript('and the', 'there was silence in the room'), 'and the there was silence in the room');
  assert.equal(stitchTranscript('I saw the cat', 'catastrophe struck the village'), 'I saw the cat catastrophe struck the village');
  assert.equal(stitchTranscript('we can', 'cancel the meeting'), 'we can cancel the meeting');
});

// D11c. Scripts written WITHOUT word spacing (Han/Kana/Thai/…) have no whitespace tokens, so the
// word-level scan can never reach MIN_SEAM_WORDS and every seam would duplicate its whole overlap.
// MUTATION-TESTED: deleting the UNSPACED_SCRIPT branch in transcript-coverage.js → this check REDs
// (the overlap appears twice).
await t('D11c. seam de-dup works for scripts without word spacing (CJK)', async () => {
  assert.equal(stitchTranscript('今日はいい天気ですね', 'いい天気ですね明日は雨です'), '今日はいい天気ですね明日は雨です');
  // ⚠️ AND THE BRANCH MUST BE SCOPED TO THE SEAM. Testing the WHOLE fragments meant one CJK
  // character anywhere in a long English transcript switched every seam to character matching —
  // deleting single repeated words that the MIN_SEAM_WORDS policy explicitly calls coincidences
  // (adversarial review round 2, MEDIUM-5). The CJK here is far outside the seam window.
  const farCjk = 'I visited 東京 last spring' + ' and then wrote a great deal of ordinary English prose about it'.repeat(3) + ' and I like to code';
  assert.equal(stitchTranscript(farCjk, 'code review is due'), `${farCjk} code review is due`,
    'a distant CJK character must not turn an English seam into a character match');
  // …and a LATIN pair is still governed by the word rule, not by character matching — a character
  // scan on spaced text would resurrect the sub-word deletion hazard D11b just closed.
  assert.equal(stitchTranscript('we can', 'cancel the meeting'), 'we can cancel the meeting');
});

// D12. Coverage serialization must be lossless for unrelated metadata keys — transcription owns ONE
// key and must never clobber an upload's own metadata.
// MUTATION-TESTED: replacing writeCoverage's merge with a fresh `{}` → REDs on the preserved key.
await t('D12. writeCoverage preserves other metadata keys and never loses malformed prior metadata', async () => {
  const wc = writeCoverage, rc = readCoverage;
  const out = wc(JSON.stringify({ source: 'telegram', width: 0 }), { complete: false, coveredSec: 12.345, durationSec: 30, segments: 2 });
  const o = JSON.parse(out);
  assert.equal(o.source, 'telegram', 'an unrelated metadata key must survive');
  assert.equal(o.width, 0);
  assert.equal(rc(out).coveredSec, 12.35);
  assert.equal(rc(out).incomplete, true);
  const kept = JSON.parse(wc('}{ not json', { complete: true }));
  assert.equal(kept._unparsed_metadata, '}{ not json', 'malformed prior metadata is PRESERVED, never destroyed');
  assert.equal(rc(kept).complete, true);
  // §1: a fault DETAIL string must never be persisted — only the sanitized reason token
  const f = JSON.parse(wc(null, { complete: false, fault: 'engine-error /tmp/myc-tx-abc/audio.m4a' }));
  assert.ok(!/tmp|\//.test(f.transcription.fault), `coverage must not persist a path — got "${f.transcription.fault}"`);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
//  D-076 ROUND 2 — the defects the adversarial review found INSIDE the fix
// ══════════════════════════════════════════════════════════════════════════════════════════════
// Every check below pins a hole that existed in the first draft of this PR. They are separated so
// a reader can see that the fix itself had to be falsified before it was trusted.
console.log('\nD-076 round 2 — holes found inside the fix');

const { transcribeAudio } = await import('../src/enrich/transcribe-audio.js');

// D13. CROSS-ENGINE COVERAGE (review CRITICAL-1). transcribeAudio can run TWO engines in one call.
// A one-shot coverage latch let the FIRST engine's verdict win even when the SECOND produced the
// returned text — so a Whisper stream that finished with zero words (`complete:true`, returns null)
// masked the OGG path's honest `complete:false`, and the caller wrote "done" over a transcript with
// a hole in it. Coverage must describe the text actually returned.
// MUTATION-TESTED: restoring the `coverageSent` latch in transcribe-audio.js → this check REDs
// (`complete` comes back true and the gap is lost).
await t('D13. coverage describes the engine that produced the RETURNED text, not the first to report', async () => {
  const reports = [];
  // The TWO-ENGINE path, driven for real: Whisper is HEALTHY and its stream completes with the
  // `done` sentinel but ZERO words — the honest `no-speech` outcome, which reports complete:TRUE and
  // returns null. Execution falls through, and the engine that actually produces the returned text
  // must be the one whose verdict is recorded.
  const impl = async (url, init) => {
    if (String(url).includes('/transcribe-file')) return streamingFetch([
      JSON.stringify({ type: 'meta', duration: 130 }) + '\n',
      JSON.stringify({ type: 'done', segments: 0 }) + '\n',
    ])(url, init);
    if (String(url).includes('/v1/chat/completions')) {
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'the fallback engine got it' } }] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const out = await transcribeAudio({
    bytes: Buffer.from('not-ogg-at-all'), mimeType: 'audio/mp4', fileName: 'v.m4a',
    model: 'fake-audio-model', fetch: impl, getHealth: healthOk,
    onCoverage: (c) => reports.push(c),
  });
  assert.equal(out, 'the fallback engine got it', 'the SECOND engine produced the text');
  assert.ok(reports.length >= 2, `both engines must report — got ${reports.length}`);
  const last = reports[reports.length - 1];
  assert.equal(last.engine, 'single-shot', 'the LAST report belongs to the engine that returned the text');
  assert.equal(last.complete, false, `a latch would leave the first engine's complete:true standing — got ${JSON.stringify(last)}`);
});

// D19. An engine that DID NOT RUN must not publish a verdict. The OGG block reported
// unconditionally, including when the decoder produced zero windows and execution fell through to
// the single-shot path — a record about a decode that never happened.
// MUTATION-TESTED: changing `if (windows > 0) reportCoverage({...})` to `if (true)` in
// transcribe-audio.js → this check REDs (an 'ogg-window' record appears for a decode with 0 windows).
await t('D19. the OGG engine publishes no coverage record when it decoded nothing', async () => {
  const reports = [];
  const llm = async (url) => (String(url).includes('/v1/chat/completions')
    ? { ok: true, json: async () => ({ choices: [{ message: { content: 'the LLM read it fine' } }] }) }
    : { ok: false, status: 404, json: async () => ({}) });
  // Declared as ogg, but not decodable as opus → the OGG branch yields no windows.
  const out = await transcribeAudio({
    bytes: Buffer.from('OggSnot-really-opus-at-all'), mimeType: 'audio/ogg', fileName: 'v.ogg',
    model: 'fake-audio-model', fetch: llm, getHealth: healthDown,
    onCoverage: (c) => reports.push(c),
  });
  assert.equal(out, 'the LLM read it fine');
  assert.ok(!reports.some((r) => r.engine === 'ogg-window'), `no ogg-window record may exist — got ${JSON.stringify(reports)}`);
});

// D14. THE SINGLE-SHOT PATH CANNOT CLAIM COMPLETENESS (review HIGH-3). One /v1/chat/completions
// call over a whole file yields no segments, no sentinel, no duration — "we got some text" is not
// evidence, and asserting it SUPPRESSED the drain that could later redo the file properly.
// MUTATION-TESTED: setting `complete: Boolean(text)` back in transcribe-audio.js → this check REDs.
await t('D14. the single-shot LLM path always reports INCOMPLETE (it has no evidence of completion)', async () => {
  const reports = [];
  const llm = async (url) => {
    if (String(url).includes('/v1/chat/completions')) {
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'some text the model returned' } }] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const out = await transcribeAudio({
    bytes: Buffer.from('audio-bytes'), mimeType: 'audio/mp4', fileName: 'v.m4a',
    model: 'fake-audio-model', fetch: llm, onCoverage: (c) => reports.push(c),
  });
  assert.equal(out, 'some text the model returned', 'the text is still returned — this is about the CLAIM, not the text');
  const last = reports[reports.length - 1];
  assert.equal(last.engine, 'single-shot');
  assert.equal(last.complete, false, 'an unverifiable engine must never assert completeness');
});

// D15. COVERAGE IS MONOTONIC (review HIGH-2). Every failure path reports coveredSec 0, and `??`
// does not fall through on 0 — so one 503 overwrote a good coveredSec with 0, the next pass then
// restarted from 0, and its progressive save TRUNCATED a 25-minute stored transcript back to two.
// MUTATION-TESTED: replacing `maxCovered(...)` with `... ?? priorCoveredSec` in
// transcribe-attachment.js → this check REDs on both the coverage and the transcript assertion.
await t('D15. a failed pass never walks coverage backwards and never shrinks the stored transcript', async () => {
  const db = mkAttachmentDb();
  // Pass 1: a long partial.
  const lines = [JSON.stringify({ type: 'meta', duration: 1800 }) + '\n'];
  for (let i = 0; i < 25; i++) lines.push(JSON.stringify({ type: 'segment', start: i * 60, end: (i + 1) * 60, text: `part${i}` }) + '\n');
  await runJob(db, { fetchImpl: streamingFetch(lines) });
  const after1 = readCoverage(db.row.metadata);
  const text1 = db.row.transcript;
  assert.equal(after1.coveredSec, 1500, 'pass 1 covered 25 minutes');
  assert.ok(text1.length > 100, 'pass 1 stored a substantial transcript');

  // Pass 2: the service 503s before a single segment. It knows NOTHING — it must change nothing.
  const dead = async () => ({ ok: false, status: 503, json: async () => ({ error: 'deps_missing' }) });
  await runJob(db, { fetchImpl: dead });
  const after2 = readCoverage(db.row.metadata);
  assert.equal(after2.coveredSec, 1500, `a pass that learned nothing must not reset coverage — got ${after2.coveredSec}`);
  assert.equal(db.row.transcript, text1, 'a failed pass must not touch the stored transcript');

  // Pass 3: a SHORT partial from the start (as if the resume was not honoured). The progressive
  // save must refuse to overwrite the longer stored text with its first few segments.
  const shortLines = [JSON.stringify({ type: 'meta', duration: 1800 }) + '\n'];
  for (let i = 0; i < 12; i++) shortLines.push(JSON.stringify({ type: 'segment', start: i, end: i + 1, text: `s${i}` }) + '\n');
  await runJob(db, { fetchImpl: streamingFetch(shortLines) });
  assert.ok(db.row.transcript.length >= text1.length,
    `a short pass must never shrink a longer stored transcript (was ${text1.length}, now ${db.row.transcript.length})`);
});

// D18. WORK ALREADY RECORDED IS NEVER DOWNGRADED — the concurrency guard.
// `attachments.transcript` has FOUR unserialized writers (import, drain, portal button, live turn),
// and the governor cannot serialize the live turn against the drain because they hold different
// ticket classes by design. Each merges into a row snapshot taken before a decode lasting minutes,
// so the LOSER of the race wrote last and won: a completed 30-minute transcript was replaced by a
// 4-minute partial and re-queued for another full decode. Both adversarial reviews found this
// independently; it is enforced by a last-moment re-read plus `coverageDominates`.
// MUTATION-TESTED: making `coverageDominates` always return false → this check REDs on both the
// preserved transcript and the preserved coverage.
await t('D18. a shorter/incomplete pass cannot overwrite a transcript another writer already completed', async () => {
  const db = mkAttachmentDb();
  // Another writer has already finished this attachment.
  db.row.transcript = 'THE COMPLETE THIRTY MINUTE TRANSCRIPT';
  db.row.metadata = writeCoverage(null, { complete: true, coveredSec: 1800, durationSec: 1800, segments: 200 });

  // A slow pass that started earlier now finishes with only four minutes and tries to write.
  const late = [JSON.stringify({ type: 'meta', duration: 1800 }) + '\n'];
  for (let i = 0; i < 25; i++) late.push(JSON.stringify({ type: 'segment', start: i * 10, end: (i + 1) * 10, text: `seg${i}` }) + '\n');
  const r = await runJob(db, { fetchImpl: streamingFetch(late) });

  assert.equal(db.row.transcript, 'THE COMPLETE THIRTY MINUTE TRANSCRIPT', 'a finished transcript must survive a losing racer');
  const cov = readCoverage(db.row.metadata);
  assert.equal(cov.complete, true, 'complete must not revert to incomplete — that re-queues a finished file');
  assert.equal(cov.coveredSec, 1800, 'coverage must not walk backwards');
  assert.equal(r.ok, false, 'the losing pass still reports honestly to ITS caller');
});

// D18b. The rule itself, at its three boundaries. This is the one comparison every writer consults,
// including the live channel route (internal-router.js) which cannot easily be driven end-to-end here.
// MUTATION-TESTED: inverting any single clause in coverageDominates → this check REDs.
await t('D18b. coverageDominates: complete beats incomplete, more coverage beats less, equal work may proceed', async () => {
  const { coverageDominates } = await import('../src/enrich/transcript-coverage.js');
  const done = { complete: true, incomplete: false, coveredSec: 1800 };
  const partial = { complete: false, incomplete: true, coveredSec: 1000 };
  assert.equal(coverageDominates(done, { complete: false, coveredSec: 240 }), true, 'a finished row rejects a partial');
  assert.equal(coverageDominates(done, { complete: true, coveredSec: 1800 }), false, 'a complete pass may rewrite a complete row (Re-transcribe)');
  assert.equal(coverageDominates(partial, { complete: false, coveredSec: 240 }), true, 'more coverage rejects less');
  assert.equal(coverageDominates(partial, { complete: false, coveredSec: 1400 }), false, 'a pass that advanced may write');
  assert.equal(coverageDominates(partial, { complete: true, coveredSec: 1800 }), false, 'a COMPLETE pass always may write');
  // The clause that ONLY the completeness rule can catch: a short recording that is genuinely
  // finished, against a partial claiming more seconds. Coverage comparison alone would let it
  // through and revert a finished row to incomplete.
  const shortDone = { complete: true, incomplete: false, coveredSec: 60 };
  assert.equal(coverageDominates(shortDone, { complete: false, coveredSec: 500 }), true,
    'a FINISHED short recording outranks a partial claiming more seconds');
  assert.equal(coverageDominates(null, { complete: false, coveredSec: 0 }), false, 'no stored record ⇒ nothing to protect');
});

// D16. THE RESUME ECHO IS VALIDATED (review MEDIUM-4). `meta.offset` decides both how much audio
// counts as covered and whether the caller stitches or replaces. An echo LARGER than requested made
// us skip audio and still earn `complete` — a silent hole no drain would revisit.
// MUTATION-TESTED: dropping the `echoed <= offset + 0.01` bound in transcribe-long.js → this check
// REDs (startSec comes back 1700 and coveredSec jumps to 1800).
await t('D16. an offset echo larger than requested is REJECTED (falls back to replace-not-append)', async () => {
  const impl = streamingFetch([
    JSON.stringify({ type: 'meta', duration: 1800, offset: 1700 }) + '\n',   // we asked for 300
    JSON.stringify({ type: 'segment', start: 0, end: 100, text: 'the very last words' }) + '\n',
    JSON.stringify({ type: 'done', segments: 1, offset: 1700 }) + '\n',
  ]);
  const { coverage } = await collect({ bytes: Buffer.from('x'), fetch: impl, getHealth: healthOk, startSec: 300 });
  assert.equal(coverage.startSec, 0, 'an offset we did not ask for must not be trusted');
  assert.equal(coverage.coveredSec, 100, 'timestamps stay as sent when the echo is rejected');
});

// D17. §1 — the fault sanitizer is an ALLOW-LIST (review LOW-10). A deny-list only removes a leak
// that happens to be preceded by whitespace; a bare path collapsed INTO the token instead.
// MUTATION-TESTED: replacing the allow-list regex with the old strip-and-take-first-token → this
// check REDs on the bare-path case.
await t('D17. a non-enum fault value becomes "unknown" rather than a scrubbed leak', async () => {
  const one = (f) => JSON.parse(writeCoverage(null, { complete: false, fault: f })).transcription.fault;
  assert.equal(one('engine-error'), 'engine-error', 'a real enum token survives untouched');
  assert.equal(one('/tmp/myc-tx-9/audio.ogg'), 'unknown', 'a bare path must be DISCARDED, not compacted into a token');
  assert.equal(one('Bearer sk-abc123DEF'), 'unknown', 'a credential-shaped value must not keep its first word');
});

console.log(`\n${fail === 0 ? 'VERDICT: GO' : 'VERDICT: NO-GO'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
