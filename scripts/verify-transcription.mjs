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
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

console.log(`\n${fail === 0 ? 'VERDICT: GO' : 'VERDICT: NO-GO'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
