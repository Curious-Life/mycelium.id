// verify:tts-voice — the local voice model (Qwen3-TTS, replacing Kokoro) end to
// end WITHOUT a real MLX download or a real render:
//   V1  the catalog offers the two benchmarked variants, each with a size
//   V2  NO DRIFT — the "Recommended for voice" badge == the model default,
//       single-sourced from role-models.js across BOTH surfaces (the model
//       catalog AND the Intelligence screen). The LOCAL-TTS-EVAL §6.2 pin.
//   V3  CONSENT — nothing downloads until the user picks (a provisioner spy sees
//       ZERO invocations from reading the catalog / polling state; exactly one
//       from startDownload).
//   V3b DISK PREFLIGHT — a too-tight disk REFUSES the download with an actionable
//       reason in state.error and ZERO provisioner calls (a 2.9GB snapshot on a
//       box the design describes at ~1.5GB free; Qwen staging filled a disk to 0
//       twice — stage-hf-models.sh).
//   V4  FAIL-SOFT — a failing provision surfaces in state.error and NEVER throws
//       the caller (kokoro-model.js precedent, preserved).
//   V5  RENDER SEAM — the confined daemon POSTs to the VAULT's loopback render
//       endpoint (it has no key/sample). With no frozen sample the vault answers
//       501 "voice-sample-pending" and the daemon provider FAILS SOFT (throws a
//       typed TTSProviderError), never a fabricated 'ok' WAV. V5b: the daemon
//       sends ONLY {text} — no ref_audio/key crosses the confinement boundary.
//   V6  CHANNEL PATH — when the vault returns WAV, the qwen provider still drives
//       pure-JS OGG/Opus → a Telegram-ready chunk (no regression). V6d/e/f drive
//       the REAL src/internal-router.js voice-render endpoint end to end (WAV
//       round-trip, agentId PINNED to 'personal-agent', 501 fail-soft).
//   V7  TOP-LINE HONESTY (server) — model ready + opted-in but NO voice sample ⇒
//       GET /settings/tts returns enabled:false + qwen.samplePending:true. The top
//       line must mean "a voice message will be delivered", not "a model landed".
//   V8  TOP-LINE HONESTY (rendered) — VoiceSection MOUNTED (jsdom, real compiler)
//       over that exact payload renders the pending copy, NEVER "TTS active".
//   V9  SWITCH-AWAY — PUT provider:'openai' clears QWEN_TTS_ENABLED so the :8094
//       MLX service stops (supervisor shouldRun reads that flag).
//   V10 INSTALL BACKOFF — a persistently-failing needs-runtime auto-install
//       attempts ≤2 across ~66 supervisor ticks (no per-tick pip storm).
//
// Each check is falsifiable: drift the badge (V2), make an unchosen read download
// (V3), remove the preflight (V3b), swallow a failure (V4), fabricate a render
// (V5), report active without a sample (V7/V8), keep the stranded flag (V9),
// remove the backoff (V10), revert dirBytes to a top-level-only scan (V11) —
// and the matching row goes FAIL. Falsifications are
// run out-of-band with a cp-snapshot restore (NEVER `git checkout --`).
import http from 'node:http';
import os from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const waitUntil = async (fn, ms = 3000, step = 25) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, step)); } return false; };

// Isolate on-disk model state to an empty temp dir so getModelState() reports
// 'absent' (no real snapshot) and never touches the user's data dir.
process.env.QWEN_TTS_MODEL_ROOT = mkdtempSync(join(os.tmpdir(), 'qwen-tts-verify-'));

// ── V1 catalog + V2 no-drift (pure — no I/O) ─────────────────────────────────
const model = await import('../src/tts/qwen3-tts-model.js');
const roles = await import('../src/inference/role-models.js');
const catalog = model.qwenVoiceCatalog();

rec('V1. the catalog offers the two benchmarked variants, each with a size',
  Array.isArray(catalog) && catalog.length === 2 && catalog.every((v) => v.id && v.label && Number(v.sizeMB) > 0),
  `variants=${catalog.map((v) => `${v.id}@${v.sizeMB}MB`).join(', ')}`);

const recommendedEntry = catalog.find((v) => v.recommended);
const voiceRow = roles.INTELLIGENCE_FUNCTIONS.find((f) => f.key === 'voice');
const noDrift =
  model.DEFAULT_VOICE_MODEL === roles.voiceRecommendedModel() &&              // catalog default == role getter
  roles.ROLE_RECOMMENDATIONS.voice.model === model.DEFAULT_VOICE_MODEL &&     // role source == default
  recommendedEntry?.id === model.DEFAULT_VOICE_MODEL &&                        // the badged variant == default
  voiceRow?.recommend === model.DEFAULT_VOICE_MODEL;                           // Intelligence screen badge == default
rec('V2. NO DRIFT — badge == default, single-sourced across catalog + Intelligence screen',
  noDrift, `default=${model.DEFAULT_VOICE_MODEL} badged=${recommendedEntry?.id} screen=${voiceRow?.recommend}`);
rec('V2b. the recommended variant is the 1.7B winner of the live listening test',
  model.DEFAULT_VOICE_MODEL === 'Qwen3-TTS-12Hz-1.7B-Base-8bit', model.DEFAULT_VOICE_MODEL);

// ── V3 consent — a fresh module instance with a provisioner SPY ──────────────
{
  const m = await import('../src/tts/qwen3-tts-model.js?consent');
  let calls = 0;
  m.__setFreeBytes(() => Number.MAX_SAFE_INTEGER);   // hermetic: don't depend on this box's real disk
  m.__setProvisioner(async ({ onProgress }) => { calls++; onProgress?.(5); onProgress?.(100); });
  // Reading the catalog and polling state must NOT provision.
  m.qwenVoiceCatalog(); m.getModelState(); m.getModelState(); m.qwenVoiceCatalog();
  const zeroBeforePick = calls === 0;
  // Only an explicit pick (startDownload) provisions — exactly once.
  await m.startDownload({ variant: m.DEFAULT_VOICE_MODEL });
  const oneAfterPick = await waitUntil(() => calls === 1);
  rec('V3. CONSENT — zero provisions from reading the catalog/state; exactly one from the pick',
    zeroBeforePick && oneAfterPick, `callsBeforePick=${zeroBeforePick ? 0 : '>0'} callsAfterPick=${calls}`);
}

// ── V3b disk preflight — a tight disk refuses with a reason, zero provisions ──
{
  const m = await import('../src/tts/qwen3-tts-model.js?disk');
  let calls = 0;
  m.__setProvisioner(async () => { calls++; });
  m.__setFreeBytes(() => 2e9);   // 2GB free < 2.9GB variant + 1GB margin
  let threw = false;
  try { await m.startDownload({ variant: m.DEFAULT_VOICE_MODEL }); } catch { threw = true; }
  const settled = await waitUntil(() => m.getModelState().phase === 'error');
  const st = m.getModelState();
  rec('V3b. DISK PREFLIGHT — 2GB free vs a 2.9GB variant: refused with an actionable reason, ZERO provisions',
    !threw && settled && st.phase === 'error' && /not enough disk/.test(st.error || '') && /GB/.test(st.error || '') && calls === 0,
    `threw=${threw} phase=${st.phase} calls=${calls} error=${JSON.stringify(st.error)}`);
}

// ── V4 fail-soft — a rejecting provisioner surfaces state.error, never throws ─
{
  const m = await import('../src/tts/qwen3-tts-model.js?failsoft');
  m.__setFreeBytes(() => Number.MAX_SAFE_INTEGER);   // hermetic: reach the provisioner, not the preflight
  m.__setProvisioner(async () => { throw new Error('boom-download-failed'); });
  let threw = false;
  try { await m.startDownload({ variant: m.DEFAULT_VOICE_MODEL }); } catch { threw = true; }
  const settled = await waitUntil(() => m.getModelState().phase === 'error');
  const st = m.getModelState();
  rec('V4. FAIL-SOFT — a failing provision → state.error (phase=error), and startDownload did NOT throw',
    !threw && settled && st.phase === 'error' && typeof st.error === 'string' && st.error.includes('boom-download-failed'),
    `threw=${threw} phase=${st.phase} error=${JSON.stringify(st.error)}`);
}

// ── V5/V6 daemon provider — drive the renamed 'qwen' provider over loopback ──
function sineWav({ freq = 220, seconds = 1.2, rate = 24000 }) {
  const n = Math.floor(rate * seconds), data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * i / rate) * 0.6 * 32767), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
// Stub the VAULT's loopback render endpoint (src/internal-router.js) — the wire
// the CONFINED daemon now POSTs to (R3-TTSVOICE). The daemon never reaches :8094
// directly (it has no key/sample). mode: 'pending' → 501 voice-sample-pending
// (the SEAM); 'wav' → real WAV bytes; records the body so we can assert the daemon
// sends ONLY {text,instruct} and NEVER a ref_audio / key.
function stubVaultRender(mode, seen) {
  return http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/v1/internal/voice-render') {
      let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
        try { seen && (seen.body = JSON.parse(body || '{}')); } catch { /* */ }
        if (mode === 'pending') {
          const j = JSON.stringify({ ok: false, error: 'voice-sample-pending' });
          res.writeHead(501, { 'Content-Type': 'application/json', 'Content-Length': j.length }); res.end(j);
        } else {
          const wav = sineWav({});
          res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length }); res.end(wav);
        }
      });
    } else { res.writeHead(404); res.end(); }
  });
}

// V5 — the render SEAM: no frozen sample ⇒ the vault answers 501 ⇒ the provider
// throws a typed error (fail-soft), it NEVER returns a fabricated WAV.
{
  const seen = {};
  const srv = stubVaultRender('pending', seen);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  process.env.MYCELIUM_API_URL = `http://127.0.0.1:${port}`;
  const { qwenProvider } = await import('../packages/channel-daemon/tts/providers/qwen.js');
  let result = null, err = null;
  try { result = await qwenProvider.synthesize('hello there', ''); } catch (e) { err = e; }
  rec('V5. RENDER SEAM — the vault\'s 501 "voice-sample-pending" throws a typed error, never a fabricated WAV',
    result === null && err && err.name === 'TTSProviderError' && (err.code === 'voice-sample-pending' || err.status === 501),
    `result=${result ? 'WAV(!)' : 'null'} err=${err ? `${err.name}/${err.code || err.status}` : 'none'}`);
  // CONFINEMENT: the daemon sends ONLY the line — never a ref_audio / sample / key.
  rec('V5b. CONFINEMENT — daemon POSTs only {text}; no ref_audio_b64 / key crosses the boundary',
    seen.body && seen.body.text === 'hello there' && !('ref_audio_b64' in seen.body) && !('ref_text' in seen.body),
    `body=${JSON.stringify(seen.body)}`);
  srv.close();
}

// V6 — the CHANNEL path: when the vault returns WAV, the provider still drives
// pure-JS OGG/Opus → a Telegram-ready chunk (mirrors the removed K2/K3).
{
  const srv = stubVaultRender('wav');
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  process.env.QWEN_TTS_ENABLED = '1';
  process.env.MYCELIUM_API_URL = `http://127.0.0.1:${port}`;
  process.env.TTS_PROVIDER = 'qwen';
  const tts = await import('../packages/channel-daemon/tts/index.js?voice');
  const { readFile } = await import('node:fs/promises');
  rec('V6a. the qwen provider resolves + isEnabled() with the per-box opt-in',
    tts.isEnabled() && tts.getConfig().providerName === 'qwen', JSON.stringify(tts.getConfig()));
  const chunks = [];
  for await (const c of tts.synthesizeForTelegram('This is a local voice test for the mycelium vault.', { agentId: 'test-bot' })) chunks.push(c);
  const okChunks = chunks.filter((c) => c.ok);
  let head = '';
  if (okChunks.length) { try { head = (await readFile(okChunks[0].path)).subarray(0, 4).toString('latin1'); } catch { /* */ } }
  rec('V6b. synthesizeForTelegram → real OGG/Opus chunk (pure-JS encode, no ffmpeg)',
    okChunks.length >= 1 && head === 'OggS', `chunks=${chunks.length} ok=${okChunks.length} head="${head}"`);
  for (const ch of chunks) await ch.cleanup?.();
  // Fail-closed: with the opt-in off, qwen is not configured → no provider.
  delete process.env.QWEN_TTS_ENABLED; delete process.env.MYCELIUM_API_URL;
  const cfg = await import('../packages/channel-daemon/tts/config.js?voice');
  rec('V6c. with the opt-in off, qwen is not configured → resolveProvider null (fail-closed)',
    cfg.resolveProvider() === null);
  srv.close();
}

// V6d — END-TO-END WIRE: drive the REAL qwen provider against the REAL vault
// internal-router endpoint (a stub RENDERER injected so no key/sample is needed).
// Proves: (a) daemon → /api/v1/internal/voice-render → renderer → WAV round-trips;
// (b) the endpoint PINS agentId='personal-agent' regardless of the daemon; (c) a
// renderer 501 surfaces as the honest fail-soft throw; (d) instruct is threaded.
{
  const express = (await import('express')).default;
  const { internalRouter } = await import('../src/internal-router.js');
  const rendererCalls = [];
  const stubRenderer = {
    async renderWithSample(a) {
      rendererCalls.push(a);
      if (a.text === '__pending__') return { ok: false, status: 501, error: 'voice-sample-pending' };
      return { ok: true, audio: sineWav({}), format: 'wav' };
    },
  };
  // Minimal db — internalRouter builds a pairing store at construction (needs
  // secrets.get/set); the voice-render route itself touches none of it.
  const db = { secrets: { get: async () => null, set: async () => {} } };
  const app = express();
  app.use(internalRouter({ db, userId: 'verify-user', voiceRenderer: stubRenderer }));
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const port = srv.address().port;
  process.env.QWEN_TTS_ENABLED = '1';
  process.env.MYCELIUM_API_URL = `http://127.0.0.1:${port}`;
  const { qwenProvider } = await import('../packages/channel-daemon/tts/providers/qwen.js?e2e');

  rendererCalls.length = 0;
  let ok = null, okErr = null;
  try { ok = await qwenProvider.synthesize('speak this line', '', { instruct: 'warmly' }); } catch (e) { okErr = e; }
  rec('V6d. E2E — daemon provider → real vault endpoint → renderer → WAV (format wav)',
    !okErr && ok && Buffer.isBuffer(ok.audio) && ok.audio.length > 0 && ok.format === 'wav',
    `err=${okErr?.message || 'none'} bytes=${ok?.audio?.length}`);
  rec('V6e. AGENT PIN — the endpoint calls the renderer with agentId="personal-agent" + instruct (daemon can\'t pick the id)',
    rendererCalls[0]?.agentId === 'personal-agent' && rendererCalls[0]?.text === 'speak this line' && rendererCalls[0]?.instruct === 'warmly',
    `call=${JSON.stringify(rendererCalls[0])}`);

  let pend = null, pendErr = null;
  try { pend = await qwenProvider.synthesize('__pending__', ''); } catch (e) { pendErr = e; }
  rec('V6f. E2E fail-soft — a renderer 501 surfaces as a typed throw through the endpoint',
    pend === null && pendErr?.name === 'TTSProviderError' && (pendErr.code === 'voice-sample-pending' || pendErr.status === 501),
    `err=${pendErr ? `${pendErr.name}/${pendErr.code || pendErr.status}` : 'none'}`);

  delete process.env.QWEN_TTS_ENABLED; delete process.env.MYCELIUM_API_URL;
  srv.close();
}

// ── V7/V9 — the SERVER top line + switch-away, over the real portal-settings router ──
// A fresh model root with a fake snapshot + an injected import-probe pins the PLAIN
// module instance (the one portal-settings imports) at phase 'ready' deterministically.
const plain = await import('../src/tts/qwen3-tts-model.js');
{
  process.env.QWEN_TTS_MODEL_ROOT = mkdtempSync(join(os.tmpdir(), 'qwen-tts-ready-'));
  const dir = plain.qwenPaths({}, plain.DEFAULT_VOICE_MODEL).dir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), '{}');
  writeFileSync(join(dir, 'model.safetensors'), 'stub-weights');
  plain.__setPkgProbe(async () => true);
  const ready = await waitUntil(() => plain.getModelState().phase === 'ready');

  const { portalSettingsRouter } = await import('../src/portal-settings.js');
  const secrets = new Map([['TTS_PROVIDER', 'qwen'], ['QWEN_TTS_ENABLED', '1']]);
  const db = { secrets: {
    get: async (_u, k) => secrets.get(k) ?? null,
    has: async (_u, k) => secrets.has(k),
    set: async (_u, { key, value }) => { secrets.set(key, value); },
    delete: async (_u, k) => { secrets.delete(k); },
    list: async () => [],
  } };
  const express = (await import('express')).default;
  const app = express();
  app.use('/portal', portalSettingsRouter({ db, userId: 'verify-user' }));
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  const j = await (await fetch(`${base}/portal/settings/tts`)).json();
  rec('V7. TOP-LINE HONESTY (server) — ready + opted-in + NO sample ⇒ enabled:false + samplePending:true',
    ready && j.enabled === false && j.qwen?.samplePending === true && j.qwen?.model?.phase === 'ready',
    `ready=${ready} enabled=${j.enabled} samplePending=${j.qwen?.samplePending} phase=${j.qwen?.model?.phase}`);
  // V7b — CHANNEL DEFERRAL (voice-panel audit): channel qwen voice can't be
  // delivered (the confined daemon has no sample), so the top-line must never
  // claim it. The response carries channelDeferred so the UI can say so honestly.
  rec('V7b. CHANNEL DEFERRAL — qwen.channelDeferred:true (channel voice not deliverable yet)',
    j.qwen?.channelDeferred === true, `channelDeferred=${j.qwen?.channelDeferred}`);

  const put = await fetch(`${base}/portal/settings/tts`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'openai' }),
  });
  rec('V9. SWITCH-AWAY — PUT provider:openai clears QWEN_TTS_ENABLED (the MLX service stops)',
    put.ok && !secrets.has('QWEN_TTS_ENABLED') && secrets.get('TTS_PROVIDER') === 'openai',
    `putOk=${put.ok} stillEnabled=${secrets.has('QWEN_TTS_ENABLED')}`);
  srv.close();
}

// ── V8 — the RENDERED top line: mount VoiceSection (real compiler, jsdom) ─────
{
  const run = spawnSync(process.execPath, ['--conditions', 'browser', 'test/mount-voice-section.mjs'],
    { cwd: new URL('../portal-app', import.meta.url).pathname, encoding: 'utf8', timeout: 60000 });
  let out = null;
  for (const line of (run.stdout || '').trim().split('\n').reverse()) { try { out = JSON.parse(line); break; } catch { /* not the JSON line */ } }
  const pendingCopy = /Channel messages stay text-only until then/.test(out?.text || '');
  const claimsActive = /TTS active/.test(out?.text || '');
  const control = /Won the live listening test/.test(out?.text || '');   // proves the mount rendered content at all
  rec('V8. TOP-LINE HONESTY (rendered) — the MOUNTED section shows the pending copy, never "TTS active"',
    out?.mounted === true && control && pendingCopy && !claimsActive,
    `mounted=${out?.mounted} control=${control} pending=${pendingCopy} claimsActive=${claimsActive}${out?.error ? ` err=${out.error}` : ''}`);
}

// ── V10 — install backoff: a failing auto-install must not storm ──────────────
{
  plain.__setPkgProbe(async () => false);                     // files present, runtime not importable ⇒ needs-runtime
  plain.__setFreeBytes(() => Number.MAX_SAFE_INTEGER);
  let installCalls = 0;
  plain.__setProvisioner(async () => { installCalls++; throw new Error('pip-keeps-failing'); });
  const needsRuntime = await waitUntil(() => plain.getModelState().phase === 'needs-runtime');
  const sup = await import('../src/tts/qwen3-tts-supervisor.js');
  const inst = sup.startQwenTtsSupervisor({ home: process.cwd(), shouldRun: () => true, tickMs: 15 });
  await new Promise((r) => setTimeout(r, 1000));              // ~66 ticks
  inst.stop();
  rec('V10. INSTALL BACKOFF — a persistently-failing runtime install attempts ≤2 across ~66 ticks (no pip storm)',
    needsRuntime && installCalls >= 1 && installCalls <= 2, `needsRuntime=${needsRuntime} attempts=${installCalls}`);
  plain.__setProvisioner(null); plain.__setPkgProbe(null); plain.__setFreeBytes(null);
}

// ── V11 — download progress sees STAGED bytes (the 5%-stall fix) ─────────────
// huggingface_hub stages the in-flight shard under <dir>/.cache/huggingface/
// download/ and only moves it to the top level when COMPLETE. The progress
// ratio must count those staged bytes: a top-level-only scan reads ~0 for the
// whole multi-GB download and pins the bar at its 5% floor (operator-reported).
{
  const dir = mkdtempSync(join(os.tmpdir(), 'qwen-tts-progress-'));
  writeFileSync(join(dir, 'config.json'), 'x'.repeat(1_000));                 // completed metadata
  const staging = join(dir, '.cache', 'huggingface', 'download');
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, 'model.safetensors.incomplete'), 'y'.repeat(50_000)); // in-flight shard
  // The REAL repo also stages per-subdir files one level DEEPER (observed live:
  // download/speech_tokenizer/model.safetensors.* — depth 4). Pin that too, so a
  // future "tighten the depth cap" edit can't silently re-lose nested bytes
  // (review of #225, MED-1: a depth<3 mutant passed the flat-only fixture).
  mkdirSync(join(staging, 'speech_tokenizer'));
  writeFileSync(join(staging, 'speech_tokenizer', 'model.safetensors.incomplete'), 'z'.repeat(20_000));
  const seen = plain.__dirBytes(dir);
  // CONTROL: the buggy top-level-only scan reads only the top-level entries
  // (~1k, exact value fs-dependent) — the exact 71_000 assertion is what
  // distinguishes the fix (both staged files counted, each exactly once) from
  // the regression, a shallow depth cap, or a count-directory-sizes variant.
  rec('V11. PROGRESS SEES STAGING — dirBytes counts nested .cache/huggingface/download in-flight bytes',
    seen === 71_000, `bytesSeen=${seen} (top-level-only ~1k; depth-capped-at-3 would be 51_000)`);
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(72));
console.log(`VERDICT: ${allPass ? 'GO — Qwen3-TTS catalog + no-drift badge + consent + disk preflight + fail-soft + honest render seam + honest top line + switch-away + install backoff + staged-bytes progress' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(72));
process.exit(allPass ? 0 : 1);
