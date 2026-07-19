// scripts/verify-voice-sample-store.mjs — the per-agent voice sample store (V1u).
//
// The frozen reference sample is the voice's identity (design §2.2/§2.3) and is
// biometric-ish (CLAUDE.md §7). This gate proves: a real encrypt round-trip, NO
// plaintext WAV/transcript on disk, per-agent isolation, honest hasVoiceSample,
// and fail-closed bounds (oversize / empty / invalid agent).

import crypto from 'node:crypto';
process.env.ENCRYPTION_MASTER_KEY = crypto.randomBytes(32).toString('hex');

import { mkdtemp, readFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createVoiceSampleStore, hasSampleSync, MAX_SAMPLE_BYTES } from '../src/tts/voice-sample-store.js';

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); }
};

const baseDir = await mkdtemp(path.join(tmpdir(), 'voicesample-'));
try {
  const store = createVoiceSampleStore({ baseDir });
  const SECRET_TEXT = 'SECRET-TRANSCRIPT-marker-9f3a';
  const WAV_MARKER = Buffer.from('WAVDATA-marker-7c21-then-random-audio-bytes');
  const wav = Buffer.concat([WAV_MARKER, crypto.randomBytes(2048)]);

  // ── S1: absent agent → null / false ────────────────────────────────────────
  ok((await store.getSample('personal-agent')) === null, 'S1 absent → getSample null');
  ok(hasSampleSync('personal-agent', { baseDir }) === false, 'S1b absent → hasSampleSync false');

  // ── S2: save → round-trips wav + transcript exactly ────────────────────────
  await store.saveSample('personal-agent', { wav, sampleText: SECRET_TEXT });
  const got = await store.getSample('personal-agent');
  ok(got && got.sampleText === SECRET_TEXT && Buffer.compare(got.wav, wav) === 0,
    'S2 round-trip wav+transcript exact');
  ok(hasSampleSync('personal-agent', { baseDir }) === true, 'S2b hasSampleSync true after save');

  // ── S3: ENCRYPTED at rest — no plaintext transcript or wav marker on disk ───
  const raw = await readFile(store.fileFor('personal-agent'));
  ok(raw.subarray(0, 4).toString('latin1') === 'MVS1', 'S3 magic MVS1 present');
  const rawStr = raw.toString('latin1');
  ok(!rawStr.includes(SECRET_TEXT), 'S3b transcript NOT plaintext on disk');
  ok(!rawStr.includes('WAVDATA-marker'), 'S3c wav bytes NOT plaintext on disk');
  ok(raw.indexOf(WAV_MARKER) === -1, 'S3d wav marker buffer absent from ciphertext');

  // ── S4: per-agent ISOLATION — a second agent has its own (absent) sample ────
  ok((await store.getSample('other-agent')) === null, 'S4 sibling agent → null');
  ok(hasSampleSync('other-agent', { baseDir }) === false, 'S4b sibling hasSampleSync false');

  // ── S5: a foreign file at a sibling's path does NOT decrypt as that sibling's
  //    sample if scopes differ; at minimum it never yields THIS agent's plaintext
  //    under the wrong name. (Filename is the primary boundary; scope the second.)
  //    Here we prove a swapped file never silently returns another agent's data
  //    unless it also decrypts under the sibling's scope — and even then it is the
  //    same single-user vault. The load-bearing check: no cross-file bleed.
  await copyFile(store.fileFor('personal-agent'), store.fileFor('other-agent'));
  const swapped = await store.getSample('other-agent');
  // Same-tenant agents SHARE a scope key (inferScope collapses to ≤3 tenants), so
  // the ciphertext alone would decrypt. The payload-agentId binding is what stops
  // the bleed: the embedded agentId ('personal-agent') ≠ 'other-agent' ⇒ refused.
  ok(swapped === null, 'S5 swapped sample REJECTED (payload agentId binding — no cross-agent bleed)');
  await store.deleteSample('other-agent');

  // ── S5b: FAIL-CLOSED on an ABSENT agentId binding ──────────────────────────
  //    saveSample ALWAYS stamps agentId, so a payload LACKING it is anomalous (a
  //    hand-planted or pre-binding file) and must be refused, not trusted. Rebuild
  //    a valid-crypto MVS1 file whose payload omits agentId, using the store's own
  //    encrypt + scope, and prove getSample returns null.
  {
    const { encrypt: enc, getMasterKey: gmk, inferScope: infer } = await import('../src/crypto/crypto-local.js');
    const mk = await gmk();
    const scope = infer({ path: 'mind/voice-sample', agent_id: 'bind-test' });
    const noBind = JSON.stringify({ v: 1, sampleText: SECRET_TEXT, wavB64: wav.toString('base64'), at: '2026-01-01T00:00:00.000Z' });
    const env = await enc(noBind, scope, mk);
    const { writeFile: wf } = await import('node:fs/promises');
    await wf(store.fileFor('bind-test'), Buffer.concat([Buffer.from('MVS1', 'latin1'), Buffer.from(env, 'utf8')]));
    ok((await store.getSample('bind-test')) === null, 'S5b absent agentId binding REFUSED (fail-closed)');
    await store.deleteSample('bind-test');
  }

  // ── S6: a file without the magic is refused (not guessed) ──────────────────
  const { writeFile } = await import('node:fs/promises');
  await writeFile(store.fileFor('junk-agent'), Buffer.from('not an MVS file at all'));
  ok((await store.getSample('junk-agent')) === null, 'S6 non-magic file → null');
  await store.deleteSample('junk-agent');

  // ── S7: oversize wav refused (fail-closed bound) ───────────────────────────
  let threw = null;
  try { await store.saveSample('personal-agent', { wav: Buffer.alloc(MAX_SAMPLE_BYTES + 1), sampleText: 'x' }); }
  catch (e) { threw = e; }
  ok(threw && /too large/.test(threw.message), 'S7 oversize wav refused');

  // ── S8: empty wav / missing transcript refused ─────────────────────────────
  let t2 = null; try { await store.saveSample('personal-agent', { wav: Buffer.alloc(0), sampleText: 'x' }); } catch (e) { t2 = e; }
  ok(t2 && /wav Buffer required/.test(t2.message), 'S8 empty wav refused');
  let t3 = null; try { await store.saveSample('personal-agent', { wav, sampleText: '  ' }); } catch (e) { t3 = e; }
  ok(t3 && /sampleText required/.test(t3.message), 'S8b blank transcript refused');

  // ── S9: traversal / invalid agentId refused (no escape) ────────────────────
  ok(store.fileFor('../evil') === null, 'S9 traversal agentId → no path');
  ok(hasSampleSync('../evil', { baseDir }) === false, 'S9b traversal agentId → false');
  let t4 = null; try { await store.saveSample('../evil', { wav, sampleText: 'x' }); } catch (e) { t4 = e; }
  ok(t4 && /invalid agentId/.test(t4.message), 'S9c traversal agentId save refused');

  // ── S10: delete removes the sample ─────────────────────────────────────────
  await store.deleteSample('personal-agent');
  ok((await store.getSample('personal-agent')) === null && hasSampleSync('personal-agent', { baseDir }) === false,
    'S10 delete removes sample');
} finally {
  await rm(baseDir, { recursive: true, force: true });
}

console.log(`\n${pass} pass · ${fail} fail`);
if (fail === 0) { console.log('VERDICT: GO'); process.exit(0); }
console.log('VERDICT: NO-GO'); process.exit(1);
