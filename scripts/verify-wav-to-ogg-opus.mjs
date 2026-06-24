// verify:wav-to-ogg-opus — the pure-JS outbound encoder is correct, proven by
// ROUND-TRIPPING through the existing inbound decoder (src/enrich/ogg-opus.js):
// synth a known sine → wavToOggOpus → oggOpusToWav recovers a comparable signal.
// This validates the hand-written Ogg muxer (pages/CRC/granulepos) empirically.
import { wavToOggOpus } from '../packages/channel-daemon/tts/shared/wav-to-ogg-opus.js';
import { oggOpusToWav } from '../src/enrich/ogg-opus.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

function sineWav({ freq = 440, seconds = 1, rate = 48000, amp = 0.6 }) {
  const n = Math.floor(rate * seconds);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * i / rate) * amp * 32767), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
function pcmOf(wav) { return new Int16Array(wav.buffer, wav.byteOffset + 44, (wav.length - 44) >> 1); }
function rms(pcm) { let s = 0; for (let i = 0; i < pcm.length; i++) s += pcm[i] * pcm[i]; return Math.sqrt(s / pcm.length); }
function zeroCrossings(pcm) { let z = 0; for (let i = 1; i < pcm.length; i++) if ((pcm[i - 1] < 0) !== (pcm[i] < 0)) z++; return z; }

// ── E1) encode 48k sine → valid Ogg Opus ─────────────────────────────────────
const ogg = wavToOggOpus(sineWav({ freq: 440, seconds: 1, rate: 48000 }));
rec('E1. wavToOggOpus returns a buffer starting with the Ogg magic "OggS"', Buffer.isBuffer(ogg) && ogg.subarray(0, 4).toString('latin1') === 'OggS', ogg ? `${ogg.length}B` : 'null');
rec('E2. it is meaningfully compressed vs the raw 48k PCM (~96KB)', ogg && ogg.length > 200 && ogg.length < 90_000, ogg ? `${ogg.length}B` : 'null');

// ── E3) round-trip: decode with the INBOUND decoder, recover the signal ──────
const back = ogg ? await oggOpusToWav(ogg) : null;
rec('E3. inbound oggOpusToWav decodes our stream (non-null) — muxer is valid', Buffer.isBuffer(back), back ? `${back.length}B` : 'null');
if (back) {
  const p = pcmOf(back);
  rec('E4. decoded audio is non-silent (signal survived encode)', rms(p) > 1000, `rms=${Math.round(rms(p))}`);
  rec('E5. decoded length ≈ 1s @ 48k (within 15%)', Math.abs(p.length - 48000) < 48000 * 0.15, `${p.length} samples`);
  // a 440Hz tone crosses zero ~880×/s; codec smears it but it must stay tonal, not noise (~48000×/s)
  const zc = zeroCrossings(p), perSec = zc / (p.length / 48000);
  rec('E6. tone preserved — zero-crossing rate near 2×440Hz (not noise)', perSec > 500 && perSec < 2500, `${Math.round(perSec)}/s (expect ~880)`);
}

// ── E7) 24kHz input is resampled + encoded (Kokoro emits 24k) ─────────────────
const ogg24 = wavToOggOpus(sineWav({ freq: 300, seconds: 0.5, rate: 24000 }));
const back24 = ogg24 ? await oggOpusToWav(ogg24) : null;
rec('E7. 24kHz WAV (Kokoro rate) resamples + round-trips to non-silent 48k audio', back24 && rms(pcmOf(back24)) > 800, ogg24 ? `${ogg24.length}B → ${back24 ? rms(pcmOf(back24)).toFixed(0) : 'null'} rms` : 'null');

// ── E8) garbage in → null (fail-soft, never throws) ──────────────────────────
let threw = false; let g; try { g = wavToOggOpus(Buffer.from('not a wav at all')); } catch { threw = true; }
rec('E8. non-WAV input → null, never throws (fail-soft)', !threw && g === null);

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(70));
console.log(`VERDICT: ${allPass ? 'GO — pure-JS WAV→OGG/Opus encoder round-trips through the inbound decoder; Telegram-spec output, no ffmpeg' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(70));
process.exit(allPass ? 0 : 1);
