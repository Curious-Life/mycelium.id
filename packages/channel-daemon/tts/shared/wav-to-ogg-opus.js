// src/audio/wav-to-ogg-opus.js — pure-JS WAV → OGG/Opus encode (NO ffmpeg).
//
// The outbound mirror of src/enrich/ogg-opus.js. V1's principle ("must not
// depend on a system binary", ogg-opus.js:6) forbids the canonical ffmpeg
// shell-out, so we encode the same way we decode: opusscript (libopus compiled
// to JS) produces Opus packets, and we frame them into an Ogg container by hand
// (RFC 3533 pages + RFC 7845 OpusHead/OpusTags). Output is the exact Telegram
// voice-note spec: Opus in Ogg, mono, 48 kHz, 20 ms frames.
//
// Fail-soft: any parse/encode error → null, so the caller keeps text-only.
import OpusScript from 'opusscript';

const RATE = 48000;        // Opus always outputs 48k; we encode at 48k mono
const FRAME = 960;         // 20 ms @ 48k
const CHANNELS = 1;
const SERIAL = 0x6d796365; // 'myce' — fixed bitstream serial (single logical stream)

// ── WAV parse: 44-byte PCM s16le header (what Kokoro/transcribe emit) ─────────
function parseWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return null;
  // walk chunks to find fmt + data (don't assume canonical 44-byte layout)
  let off = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('latin1', off, off + 4);
    const sz = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { audioFormat: buf.readUInt16LE(off + 8), channels: buf.readUInt16LE(off + 10), sampleRate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    else if (id === 'data') { dataOff = off + 8; dataLen = sz; }
    off += 8 + sz + (sz & 1);
  }
  if (!fmt || dataOff < 0 || fmt.audioFormat !== 1 || fmt.bits !== 16) return null;
  const end = Math.min(dataOff + dataLen, buf.length);
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, pcm: new Int16Array(buf.buffer, buf.byteOffset + dataOff, (end - dataOff) >> 1) };
}

// ── downmix to mono + linear resample to 48k ─────────────────────────────────
function toMono48k({ sampleRate, channels, pcm }) {
  // downmix
  let mono;
  if (channels === 1) mono = pcm;
  else { mono = new Int16Array((pcm.length / channels) | 0); for (let i = 0; i < mono.length; i++) { let s = 0; for (let c = 0; c < channels; c++) s += pcm[i * channels + c]; mono[i] = (s / channels) | 0; } }
  if (sampleRate === RATE) return mono;
  // linear resample to 48k
  const ratio = RATE / sampleRate, outLen = Math.floor(mono.length * ratio), out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) { const src = i / ratio, i0 = src | 0, frac = src - i0, a = mono[i0] || 0, b = mono[i0 + 1] ?? a; out[i] = (a + (b - a) * frac) | 0; }
  return out;
}

// ── Ogg page CRC: poly 0x04C11DB7, NOT reflected, init 0, no final xor ───────
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let r = i << 24; for (let j = 0; j < 8; j++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1); t[i] = r >>> 0; } return t; })();
function oggCrc(buf) { let crc = 0; for (let i = 0; i < buf.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ buf[i]) & 0xff]) >>> 0; return crc >>> 0; }

// build ONE ogg page from a set of complete packets (we keep ≤ a few packets/page)
function oggPage({ headerType, granule, pageSeq, packets }) {
  const segs = [];
  for (const p of packets) { let n = p.length; while (n >= 255) { segs.push(255); n -= 255; } segs.push(n); }
  if (segs.length > 255) throw new Error('too many segments for one page');
  const header = Buffer.alloc(27 + segs.length);
  header.write('OggS', 0, 'latin1');
  header.writeUInt8(0, 4);                 // version
  header.writeUInt8(headerType, 5);        // 0x02 BOS, 0x04 EOS, 0x00 normal
  // granule (64-bit LE); -1 (all ones) for header pages that carry no audio
  if (granule < 0) { header.writeInt32LE(-1, 6); header.writeInt32LE(-1, 10); }
  else { header.writeUInt32LE(granule >>> 0, 6); header.writeUInt32LE(Math.floor(granule / 0x100000000) >>> 0, 10); }
  header.writeUInt32LE(SERIAL >>> 0, 14);  // bitstream serial
  header.writeUInt32LE(pageSeq >>> 0, 18); // page sequence
  header.writeUInt32LE(0, 22);             // CRC placeholder
  header.writeUInt8(segs.length, 26);
  for (let i = 0; i < segs.length; i++) header.writeUInt8(segs[i], 27 + i);
  const body = Buffer.concat(packets);
  const page = Buffer.concat([header, body]);
  page.writeUInt32LE(oggCrc(page), 22);    // CRC over the whole page (field zeroed)
  return page;
}

/**
 * Encode a WAV buffer to a Telegram-spec OGG/Opus buffer (mono 48k, VOIP),
 * or null on any failure.
 * @param {Buffer} wav
 * @returns {Buffer|null}
 */
export function wavToOggOpus(wav) {
  let enc;
  try {
    const parsed = parseWav(wav);
    if (!parsed) return null;
    const pcm = toMono48k(parsed);
    if (!pcm.length) return null;

    enc = new OpusScript(RATE, CHANNELS, OpusScript.Application.VOIP);
    const lookahead = (() => { try { return enc.encoderCTL ? 0 : 0; } catch { return 0; } })(); // opusscript lacks a lookahead getter; pre-skip 0 (tiny start artifact, plays fine)
    const preSkip = lookahead;

    // OpusHead (RFC 7845 §5.1)
    const head = Buffer.alloc(19);
    head.write('OpusHead', 0, 'latin1');
    head.writeUInt8(1, 8);                 // version
    head.writeUInt8(CHANNELS, 9);          // channel count
    head.writeUInt16LE(preSkip, 10);       // pre-skip
    head.writeUInt32LE(RATE, 12);          // input sample rate (informational)
    head.writeInt16LE(0, 16);              // output gain
    head.writeUInt8(0, 18);                // channel mapping family 0
    // OpusTags (RFC 7845 §5.2)
    const vendor = Buffer.from('mycelium-local-tts', 'utf8');
    const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
    tags.write('OpusTags', 0, 'latin1');
    tags.writeUInt32LE(vendor.length, 8);
    vendor.copy(tags, 12);
    tags.writeUInt32LE(0, 12 + vendor.length); // 0 user comments

    const pages = [];
    let seq = 0;
    pages.push(oggPage({ headerType: 0x02, granule: -1, pageSeq: seq++, packets: [head] })); // BOS
    pages.push(oggPage({ headerType: 0x00, granule: -1, pageSeq: seq++, packets: [tags] })); // tags (granule -1)

    // audio: 20ms frames; one opus packet per ogg page (simple + robust)
    const frameBuf = Buffer.alloc(FRAME * 2);
    let granule = 0;
    const total = pcm.length;
    for (let i = 0; i < total; i += FRAME) {
      // last frame: zero-pad to a full 20ms frame (opus needs a fixed frame size)
      const n = Math.min(FRAME, total - i);
      for (let j = 0; j < FRAME; j++) frameBuf.writeInt16LE(j < n ? pcm[i + j] : 0, j * 2);
      const pkt = enc.encode(frameBuf, FRAME);
      granule += FRAME;
      const eos = i + FRAME >= total;
      pages.push(oggPage({ headerType: eos ? 0x04 : 0x00, granule, pageSeq: seq++, packets: [pkt] }));
    }
    enc.delete?.();
    return Buffer.concat(pages);
  } catch {
    try { enc?.delete?.(); } catch { /* */ }
    return null;
  }
}

export default wavToOggOpus;
