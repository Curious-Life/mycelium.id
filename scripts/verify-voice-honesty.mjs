// scripts/verify-voice-honesty.mjs — the voice honesty coupling (voice-panel audit).
//
// The settings top-line must NEVER report voice "active" when a render would 501.
// hasVoiceSample() is that signal, and it must use the SAME predicate the render
// uses — a successful DECRYPT — not mere file existence. A corrupt / re-keyed /
// sub-envelope .mvs passes a size check but 501s at render; gating on
// decryptability is what keeps the top-line honest (Finding 1). Also proves the
// payload-agentId binding rejects a swapped/case-collided sample (crypto audit).

import crypto from 'node:crypto';
process.env.ENCRYPTION_MASTER_KEY = crypto.randomBytes(32).toString('hex');

import { mkdtemp, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createVoiceSampleStore, hasSampleSync } from '../src/tts/voice-sample-store.js';
import { hasVoiceSample } from '../src/tts/qwen3-tts-model.js';

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); }
};

const baseDir = await mkdtemp(path.join(tmpdir(), 'voicehonesty-'));
process.env.MYCELIUM_DATA_DIR = baseDir; // hasVoiceSample() reads dataDir/voice-samples
const store = createVoiceSampleStore({ baseDir: path.join(baseDir, 'voice-samples') });
try {
  const opts = { baseDir: path.join(baseDir, 'voice-samples') };

  // ── H1: no sample → hasVoiceSample false ───────────────────────────────────
  ok((await hasVoiceSample('personal-agent', opts)) === false, 'H1 no sample → hasVoiceSample false');

  // ── H2: a valid encrypted sample → hasVoiceSample true ─────────────────────
  await store.saveSample('personal-agent', { wav: Buffer.from('RIFF____WAVE-valid'), sampleText: 'hello world' });
  ok((await hasVoiceSample('personal-agent', opts)) === true, 'H2 valid sample → hasVoiceSample true');

  // ── H3: ⭐ Finding 1 — a CORRUPT .mvs (passes size>4 but fails decrypt) reads
  //    TRUE for the cheap existence check but FALSE for hasVoiceSample. The
  //    honesty signal must match the render, not the file.
  const corruptFile = store.fileFor('corrupt-agent');
  await writeFile(corruptFile, Buffer.concat([Buffer.from('MVS1', 'latin1'), crypto.randomBytes(20)]));
  ok(hasSampleSync('corrupt-agent', opts) === true, 'H3 corrupt .mvs passes the cheap size check');
  ok((await hasVoiceSample('corrupt-agent', opts)) === false, 'H3b ⭐ corrupt .mvs → hasVoiceSample FALSE (decrypt-validated)');

  // ── H4: payload-agentId binding — a swapped/case-collided file is rejected ──
  //    Copy the valid personal-agent sample onto another agent's filename; the
  //    embedded agentId no longer matches, so getSample refuses it (no bleed).
  await copyFile(store.fileFor('personal-agent'), store.fileFor('other-agent'));
  ok((await store.getSample('other-agent')) === null, 'H4 swapped sample rejected (payload agentId mismatch)');
  ok((await hasVoiceSample('other-agent', opts)) === false, 'H4b swapped → hasVoiceSample false');
} finally {
  await rm(baseDir, { recursive: true, force: true });
}

console.log(`\n${pass} pass · ${fail} fail`);
if (fail === 0) { console.log('VERDICT: GO'); process.exit(0); }
console.log('VERDICT: NO-GO'); process.exit(1);
