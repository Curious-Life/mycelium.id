// verify:ogg-opus — pure-JS OGG/Opus → WAV transcode (no network, no ffmpeg).
// Builds a REAL Opus-in-Ogg fixture (opusscript encode + minimal in-test ogg
// muxer with correct page CRCs) and proves:
//   G1 decode → WAV with exact PCM geometry (48k mono s16le, 44-byte header)
//   G2 decoded audio is non-silent (the sine actually survived the round-trip)
//   G3 OGG/Vorbis (not Opus) → null (fail-soft, no throw)
//   G4 junk / truncated bytes → null
//   G5 transcribeAudio transcodes ogg → sends format:"wav" to the model
import OpusScript from 'opusscript';
import { oggOpusToWav, oggOpusToWavChunks } from '../src/enrich/ogg-opus.js';
import { transcribeAudio } from '../src/enrich/transcribe-audio.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

// ── fixture: 2s 440Hz sine → opus packets → ogg pages (real CRC) ─────────────
const RATE = 48000, CH = 1, FRAME = 960;
function buildFixture() {
  const enc = new OpusScript(RATE, CH, OpusScript.Application.VOIP);
  const samples = RATE * 2;
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(12000 * Math.sin(2 * Math.PI * 440 * (i / RATE))), i * 2);
  const packets = [];
  for (let off = 0; off + FRAME * 2 <= pcm.length; off += FRAME * 2) packets.push(Buffer.from(enc.encode(pcm.subarray(off, off + FRAME * 2), FRAME)));
  try { enc.delete?.(); } catch { /* */ }

  const CRC = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let r = i << 24; for (let j = 0; j < 8; j++) r = ((r & 0x80000000) ? (r << 1) ^ 0x04c11db7 : r << 1) >>> 0; CRC[i] = r; }
  const crc32 = (buf) => { let c = 0; for (const b of buf) c = ((c << 8) >>> 0) ^ CRC[((c >>> 24) ^ b) & 0xff]; return c >>> 0; };
  let seq = 0;
  const page = (packetBufs, { bos = false, eos = false, granule = 0n } = {}) => {
    const segs = [];
    for (const p of packetBufs) { let n = p.length; while (n >= 255) { segs.push(255); n -= 255; } segs.push(n); }
    const body = Buffer.concat(packetBufs);
    const h = Buffer.alloc(27 + segs.length);
    h.write('OggS', 0); h.writeUInt8(0, 4); h.writeUInt8((bos ? 2 : 0) | (eos ? 4 : 0), 5);
    h.writeBigUInt64LE(granule, 6); h.writeUInt32LE(1, 14); h.writeUInt32LE(seq++, 18);
    h.writeUInt32LE(0, 22); h.writeUInt8(segs.length, 26); Buffer.from(segs).copy(h, 27);
    const full = Buffer.concat([h, body]);
    full.writeUInt32LE(crc32(full), 22);
    return full;
  };
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0); head.writeUInt8(1, 8); head.writeUInt8(CH, 9);
  head.writeUInt16LE(312, 10); head.writeUInt32LE(RATE, 12);
  const tags = Buffer.concat([Buffer.from('OpusTags'), Buffer.from([7, 0, 0, 0]), Buffer.from('fixture'), Buffer.from([0, 0, 0, 0])]);
  const pages = [page([head], { bos: true }), page([tags])];
  let granule = 0n;
  packets.forEach((p, i) => { granule += BigInt(FRAME); pages.push(page([p], { granule, eos: i === packets.length - 1 })); });
  return { ogg: Buffer.concat(pages), packets: packets.length };
}

const { ogg, packets } = buildFixture();

// G1 + G2
{
  const wav = await oggOpusToWav(ogg);
  const expected = 44 + packets * FRAME * CH * 2;
  let peak = 0;
  if (wav) for (let i = 44; i < wav.length; i += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));
  rec('G1. opus fixture → WAV with exact geometry', !!wav && wav.length === expected && wav.subarray(0, 4).toString() === 'RIFF', `len=${wav?.length} expected=${expected}`);
  rec('G2. decoded PCM is non-silent (sine survived)', peak > 8000, `peak=${peak}`);
}

// G3 — a Vorbis-in-Ogg stream must fail soft (prism demuxer rejects non-Opus)
{
  const vorbis = Buffer.from(ogg); // clone, then corrupt the OpusHead magic into a Vorbis-ish one
  vorbis.write('vorbHead', 28); // first page payload starts at 28 (27 header + 1 lacing)
  rec('G3. non-Opus ogg → null (fail-soft)', (await oggOpusToWav(vorbis)) === null);
}

// G4 — junk and truncation
{
  rec('G4. junk / truncated → null', (await oggOpusToWav(Buffer.from('not audio'))) === null
    && (await oggOpusToWav(ogg.subarray(0, 40))) === null);
}

// G5 — transcribeAudio sends WAV (not ogg) to the model after transcode
{
  let sentFormat = null, sentDataLen = 0;
  const fakeFetch = async (url, init) => {
    if (String(url).includes('/v1/chat/completions')) {
      const body = JSON.parse(init.body);
      const part = body.messages[0].content.find((c) => c.type === 'input_audio');
      sentFormat = part.input_audio.format; sentDataLen = part.input_audio.data.length;
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'transcribed!' } }] }) };
    }
    return { ok: false, json: async () => ({}) };
  };
  const out = await transcribeAudio({ bytes: ogg, mimeType: 'audio/ogg', model: 'fake-audio-model', fetch: fakeFetch, timeoutMs: 5000 });
  rec('G5. transcribeAudio transcodes ogg → format:"wav" reaches the model', out === 'transcribed!' && sentFormat === 'wav' && sentDataLen > 100000, `format=${sentFormat} dataLen=${sentDataLen}`);
}

// G6 — the output cap STOPS decoding (DoS guard): a tiny maxSeconds bounds the
// WAV data to ~the cap, proving we don't decode every packet to completion.
{
  const t0 = Date.now();
  const capped = await oggOpusToWav(ogg, { maxSeconds: 0.01, timeoutMs: 5000 }); // cap ≈ 960 PCM bytes
  const ms = Date.now() - t0;
  const dataBytes = capped ? capped.length - 44 : 0;
  // bound = cap (960) + at most one extra decoded frame (FRAME samples) before capping
  const bound = 0.01 * RATE * CH * 2 + FRAME * CH * 2;
  rec('G6. output cap bounds decode work (no full-stream decode under a small cap)',
    !!capped && dataBytes <= bound && ms < 4000, `dataBytes=${dataBytes} bound=${bound} ms=${ms}`);
}

// G7 — timeoutMs is an accepted, non-breaking option for the normal path.
{
  const wav = await oggOpusToWav(ogg, { timeoutMs: 5000 });
  rec('G7. timeoutMs option does not break a normal decode', !!wav && wav.subarray(0, 4).toString() === 'RIFF');
}

// G8 — LOSSLESS chunking: windowed decode must reconstruct the SAME PCM as the
// single-shot decode, byte-for-byte, across MANY windows (nothing dropped at a
// boundary). A tiny windowSeconds forces multiple windows from the 2s fixture.
{
  const single = await oggOpusToWav(ogg);
  const singlePcm = single.subarray(44);
  const parts = [];
  for await (const wavWin of oggOpusToWavChunks(ogg, { windowSeconds: 0.1, maxSeconds: 14400, timeoutMs: 5000 })) {
    parts.push(wavWin.subarray(44));               // strip each WAV header → raw PCM
  }
  const joined = Buffer.concat(parts);
  rec('G8. windowed decode is lossless (>1 window, PCM identical to single-shot)',
    parts.length > 1 && joined.length === singlePcm.length && joined.equals(singlePcm),
    `windows=${parts.length} joinedBytes=${joined.length} singleBytes=${singlePcm.length}`);
}

const passed = ledger.filter(Boolean).length;
console.log(`\n${passed}/${ledger.length} checks passed`);
console.log(`VERDICT: ${passed === ledger.length ? 'GO' : 'NO-GO'}`);
process.exit(passed === ledger.length ? 0 : 1);
