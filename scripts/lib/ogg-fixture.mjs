// scripts/lib/ogg-fixture.mjs — REAL Opus-in-Ogg fixtures for the gates, built in-process.
//
// No network, no ffmpeg, no checked-in binary: opusscript encodes actual audio and the muxer
// below writes real Ogg pages with correct CRC32s and granule positions, so anything that reads
// the container (prism's demuxer, `oggOpusProbe`) is being fed the real thing rather than a
// hand-waved approximation of one.
//
// Two builders, because two gates need different things:
//   buildOggFixture      — encodes every second of audio. Exact, and what you want for
//                          losslessness/geometry checks. Cost grows with duration.
//   buildLongOggFixture  — encodes ONE second and repeats those packets across the timeline with
//                          the granule advancing correctly. A 16-minute file costs ~70 ms and
//                          ~6 MB instead of ~6 s and ~92 MB of intermediate PCM, which is what
//                          makes it affordable for a gate to prove that a recording PAST THE OLD
//                          15-MINUTE CAP is served whole. Every packet is independently
//                          decodable, so the decoded result is genuine audio of that length.
import OpusScript from 'opusscript';

export const RATE = 48000;
export const FRAME = 960;         // 20 ms at 48k
export const DEFAULT_PRESKIP = 312;

/** CRC32 (Ogg's polynomial, no reflection) — a page with a wrong CRC is silently dropped. */
function crcTable() {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let r = i << 24; for (let j = 0; j < 8; j++) r = ((r & 0x80000000) ? (r << 1) ^ 0x04c11db7 : r << 1) >>> 0; t[i] = r; }
  return t;
}

/**
 * Mux Opus packets into an Ogg stream.
 * @param {Buffer[]} packets
 * @param {object} [opts]
 * @param {number} [opts.channels=1]
 * @param {number} [opts.preSkip=312]        declared in OpusHead
 * @param {number} [opts.packetsPerPage=1]
 * @param {number} [opts.serial=1]
 * @param {boolean} [opts.granuleFromZero=true] granule starts at 0 (not at preSkip)
 * @param {boolean} [opts.trailingNoGranuleEosPage=false] append a final page that carries the
 *        end-of-stream flag but NO granule (-1, "no packet finishes here"). Legal Ogg, and the
 *        shape that proves EOS detection is not nested inside the granule test.
 * @param {number} [opts.endTrimSamples=0] subtract this from the FINAL granule, i.e. declare that
 *        the last frames are encoder padding and not part of the recording.
 *
 *        ⚠️ WITHOUT THIS, EVERY FIXTURE IS EASIER THAN REALITY. The default builder makes
 *        `sum(frames) === finalGranule` exactly, which real encoders never do: libopus pads the
 *        last frame and declares the trim in the granule, so the decoder emits a little MORE than
 *        the timeline claims. Two branches of the serve path exist only for that slack — the
 *        "never deliver more than the promise" trim and the silence pad — and neither was reachable
 *        by any gate. Worse, the slack is what let a lost packet be absorbed without the promised
 *        length coming up short, which is how a hole in a recording could be served as a clean 200
 *        (adversarial review, C1). A fixture more forgiving than the product is a gate with no
 *        teeth on the difference.
 * @returns {{ogg: Buffer, packets: number, finalGranule: bigint}}
 */
export function muxOggOpus(packets, {
  channels = 1, preSkip = DEFAULT_PRESKIP, packetsPerPage = 1, serial = 1, granuleFromZero = true,
  endTrimSamples = 0, trailingNoGranuleEosPage = false,
} = {}) {
  const CRC = crcTable();
  const crc32 = (buf) => { let c = 0; for (const b of buf) c = ((c << 8) >>> 0) ^ CRC[((c >>> 24) ^ b) & 0xff]; return c >>> 0; };
  let seq = 0;
  const page = (bufs, { bos = false, eos = false, granule = 0n } = {}) => {
    const segs = [];
    for (const p of bufs) { let n = p.length; while (n >= 255) { segs.push(255); n -= 255; } segs.push(n); }
    const body = Buffer.concat(bufs);
    const h = Buffer.alloc(27 + segs.length);
    h.write('OggS', 0); h.writeUInt8(0, 4); h.writeUInt8((bos ? 2 : 0) | (eos ? 4 : 0), 5);
    h.writeBigUInt64LE(granule, 6); h.writeUInt32LE(serial, 14); h.writeUInt32LE(seq++, 18);
    h.writeUInt32LE(0, 22); h.writeUInt8(segs.length, 26); Buffer.from(segs).copy(h, 27);
    const full = Buffer.concat([h, body]);
    full.writeUInt32LE(crc32(full), 22);
    return full;
  };
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0); head.writeUInt8(1, 8); head.writeUInt8(channels, 9);
  head.writeUInt16LE(preSkip, 10); head.writeUInt32LE(RATE, 12);
  const tags = Buffer.concat([Buffer.from('OpusTags'), Buffer.from([7, 0, 0, 0]), Buffer.from('fixture'), Buffer.from([0, 0, 0, 0])]);
  const pages = [page([head], { bos: true }), page([tags])];
  let granule = granuleFromZero ? 0n : BigInt(preSkip);
  for (let i = 0; i < packets.length; i += packetsPerPage) {
    const group = packets.slice(i, i + packetsPerPage);
    granule += BigInt(FRAME * group.length);
    const last = i + packetsPerPage >= packets.length;
    if (last && endTrimSamples > 0) granule -= BigInt(Math.min(endTrimSamples, FRAME * group.length));
    pages.push(page(group, { granule, eos: last && !trailingNoGranuleEosPage }));
  }
  // The EOS flag rides on a page that finishes no packet — granule -1. A reader that only looks at
  // pages with a real granule never sees the end of the stream.
  if (trailingNoGranuleEosPage) {
    pages.push(page([Buffer.from([0x00])], { granule: 0xffffffffffffffffn, eos: true }));
  }
  return { ogg: Buffer.concat(pages), packets: packets.length, finalGranule: granule };
}

/** Encode `seconds` of a 440Hz sine as Opus packets. */
export function encodeSine(seconds, { channels = 1 } = {}) {
  const enc = new OpusScript(RATE, channels, OpusScript.Application.VOIP);
  const samples = Math.round(RATE * seconds);
  const pcm = Buffer.alloc(samples * 2 * channels);
  for (let i = 0; i < samples; i++) {
    const v = Math.round(12000 * Math.sin(2 * Math.PI * 440 * (i / RATE)));
    for (let c = 0; c < channels; c++) pcm.writeInt16LE(v, (i * channels + c) * 2);
  }
  const step = FRAME * 2 * channels;
  const packets = [];
  for (let off = 0; off + step <= pcm.length; off += step) packets.push(Buffer.from(enc.encode(pcm.subarray(off, off + step), FRAME)));
  try { enc.delete?.(); } catch { /* */ }
  return packets;
}

/** Exact fixture: every second genuinely encoded. */
export function buildOggFixture(seconds = 2, opts = {}) {
  return muxOggOpus(encodeSine(seconds, opts), opts);
}

/**
 * Cheap LONG fixture: one encoded second, repeated, with a correct timeline.
 * The only way a gate can afford to assert something about a 16-minute recording.
 */
export function buildLongOggFixture(seconds, opts = {}) {
  const one = encodeSine(1, opts);
  const packets = [];
  for (let s = 0; s < Math.round(seconds); s++) packets.push(...one);
  return { ...muxOggOpus(packets, { packetsPerPage: 50, ...opts }), seconds: Math.round(seconds) };
}
