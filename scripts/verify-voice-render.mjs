// scripts/verify-voice-render.mjs — the vault-side voice render primitive (V2u).
//
// Renders a line in the agent's cloned voice by decrypting the frozen sample and
// POSTing it to the loopback MLX service (design §2.3/§2.4). CI cannot produce
// real audio (MLX is Apple-Silicon-only), so this gates the WIRING with a mock
// service: honest 501 without a sample, correct ref_audio/ref_text/instruct body,
// ZERO EGRESS (non-loopback refused before any call), and honest service-down.

import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import crypto from 'node:crypto';
process.env.ENCRYPTION_MASTER_KEY = crypto.randomBytes(32).toString('hex');
delete process.env.MYCELIUM_QWEN_TTS_URL; // start from the loopback default

import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createVoiceSampleStore, MAX_SAMPLE_BYTES } from '../src/tts/voice-sample-store.js';
import { createVoiceRenderer } from '../src/tts/voice-render.js';

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); }
};

const baseDir = await mkdtemp(path.join(tmpdir(), 'voicerender-'));
try {
  const store = createVoiceSampleStore({ baseDir });
  const SAMPLE_TEXT = 'the quick brown fox';
  const wav = Buffer.concat([Buffer.from('RIFFxxxxWAVE'), crypto.randomBytes(1024)]);

  // Mock loopback service: record every call, return a canned WAV.
  const calls = [];
  const mkFetch = (behavior) => async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    if (behavior === 'throw') throw new Error('ECONNREFUSED');
    if (behavior === '501') return { ok: false, status: 501, async arrayBuffer() { return new ArrayBuffer(0); } };
    return { ok: true, status: 200, async arrayBuffer() { return Buffer.from('AUDIO').buffer; } };
  };

  // ── R1: no sample → honest 501, and NO network attempt ─────────────────────
  {
    calls.length = 0;
    const r = await createVoiceRenderer({ baseDir, fetch: mkFetch('ok') }).renderWithSample({ text: 'hi' });
    ok(r.ok === false && r.status === 501 && r.error === 'voice-sample-pending', 'R1 no sample → 501', JSON.stringify(r));
    ok(calls.length === 0, 'R1b no render attempted without a sample');
  }

  await store.saveSample('personal-agent', { wav, sampleText: SAMPLE_TEXT });

  // ── R2: with a sample → POSTs the correct clone body ───────────────────────
  {
    calls.length = 0;
    const r = await createVoiceRenderer({ baseDir, fetch: mkFetch('ok') }).renderWithSample({ text: 'hello there' });
    ok(r.ok === true && Buffer.isBuffer(r.audio) && r.format === 'wav', 'R2 success → audio buffer', JSON.stringify({ ok: r.ok, fmt: r.format }));
    const b = calls[0]?.body || {};
    ok(calls.length === 1 && String(calls[0].url).startsWith('http://127.0.0.1'), 'R2b one call to loopback', calls[0]?.url);
    ok(b.text === 'hello there' && b.ref_text === SAMPLE_TEXT && b.ref_audio_b64 === wav.toString('base64'),
      'R2c body clones the stored sample (ref_audio_b64 + ref_text)');
  }

  // ── R3: instruct threaded when present, omitted when absent ─────────────────
  {
    calls.length = 0;
    await createVoiceRenderer({ baseDir, fetch: mkFetch('ok') }).renderWithSample({ text: 'x', instruct: 'quieter, late at night' });
    ok(calls[0].body.instruct === 'quieter, late at night', 'R3 instruct threaded when present');
    calls.length = 0;
    await createVoiceRenderer({ baseDir, fetch: mkFetch('ok') }).renderWithSample({ text: 'x' });
    ok(!('instruct' in calls[0].body), 'R3b instruct omitted when absent');
  }

  // ── R4: ZERO EGRESS — a non-loopback render URL is refused before any call ──
  {
    calls.length = 0;
    process.env.MYCELIUM_QWEN_TTS_URL = 'http://evil.example.com:8094';
    const r = await createVoiceRenderer({ baseDir, fetch: mkFetch('ok') }).renderWithSample({ text: 'x' });
    ok(r.ok === false && r.status === 500 && r.error === 'non-loopback-render-url', 'R4 non-loopback URL refused', JSON.stringify(r));
    ok(calls.length === 0, 'R4b sample NEVER sent off-box (no call)');
    delete process.env.MYCELIUM_QWEN_TTS_URL;
  }

  // ── R5: service unreachable (fetch throws) → honest 503 ─────────────────────
  {
    const r = await createVoiceRenderer({ baseDir, fetch: mkFetch('throw') }).renderWithSample({ text: 'x' });
    ok(r.ok === false && r.status === 503 && r.error === 'render-service-unreachable', 'R5 service down → 503', JSON.stringify(r));
  }

  // ── R6: upstream 501 surfaced honestly ─────────────────────────────────────
  {
    const r = await createVoiceRenderer({ baseDir, fetch: mkFetch('501') }).renderWithSample({ text: 'x' });
    ok(r.ok === false && r.status === 501, 'R6 upstream 501 surfaced', JSON.stringify(r));
  }

  // ── R7: empty text → 400, no call ──────────────────────────────────────────
  {
    calls.length = 0;
    const r = await createVoiceRenderer({ baseDir, fetch: mkFetch('ok') }).renderWithSample({ text: '   ' });
    ok(r.ok === false && r.status === 400, 'R7 empty text → 400');
    ok(calls.length === 0, 'R7b empty text makes no call');
  }

  // ── R8: SIZE-BOUND CONTRACT — the :8094 render body cap MUST cover base64 of the
  //    biggest WAV the store can hold, or a valid frozen sample 413s at render time
  //    (the "▶ hear" render-upstream-413 bug: MAX_BODY was 4 MB while the store
  //    accepts an 8 MB WAV ⇒ ~10.7 MB base64). Falsifiable: lower MAX_BODY in the
  //    python service back under base64(MAX_SAMPLE_BYTES) and this row goes FAIL.
  {
    const py = await readFile(new URL('../pipeline/qwen3-tts-service.py', import.meta.url), 'utf8');
    const m = py.match(/^MAX_BODY\s*=\s*([\d*\s]+?)\s*(?:#.*)?$/m);
    const maxBody = m ? Function(`return (${m[1]})`)() : 0;
    const b64Max = Math.ceil(MAX_SAMPLE_BYTES / 3) * 4; // base64 inflation of the store cap
    ok(maxBody >= b64Max, 'R8 render body cap covers base64(MAX_SAMPLE_BYTES)', `MAX_BODY=${maxBody} need>=${b64Max}`);
  }
} finally {
  await rm(baseDir, { recursive: true, force: true });
}

console.log(`\n${pass} pass · ${fail} fail`);
if (fail === 0) { console.log('VERDICT: GO'); process.exit(0); }
console.log('VERDICT: NO-GO'); process.exit(1);
