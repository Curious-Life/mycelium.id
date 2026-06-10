// src/enrich/ogg-opus.js — pure-JS OGG/Opus → WAV transcode (no ffmpeg).
//
// Telegram voice notes are ALWAYS Opus in an Ogg container, and llama.cpp's
// audio loader rejects Ogg outright ("Failed to load image or audio file",
// live-verified 2026-06-10) while accepting WAV. Canonical solved this with an
// ffmpeg shell-out; V1 must not depend on a system binary, so: prism-media's
// OggDemuxer (battle-tested in the discord.js ecosystem) splits the container
// into raw Opus packets and opusscript (compiled-to-JS libopus, no native
// build) decodes them to PCM, which we wrap in a WAV header.
//
// Telegram voice = mono 48kHz; we decode at that geometry (the Opus decoder
// outputs 48k regardless of the encode rate). Fail-soft: any demux/decode
// error → null, the caller keeps its placeholder path.
import { Readable } from "node:stream";

/** Little-endian 44-byte PCM WAV header for s16le samples. */
function wavHeader({ sampleRate, channels, dataBytes }) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + dataBytes, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(channels, 22); h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(dataBytes, 40);
  return h;
}

/**
 * Decode an OGG/Opus buffer to a mono/stereo 48k s16le WAV buffer, or null.
 * @param {Buffer} ogg
 * @param {object} [opts]
 * @param {number} [opts.channels=1]   Telegram voice notes are mono
 * @param {number} [opts.maxSeconds=900]  hard output cap (~83MB stereo) — DoS guard
 * @returns {Promise<Buffer|null>}
 */
export async function oggOpusToWav(ogg, { channels = 1, maxSeconds = 900 } = {}) {
  if (!Buffer.isBuffer(ogg) || ogg.length < 4 || ogg.subarray(0, 4).toString("latin1") !== "OggS") return null;
  try {
    const prism = await import("prism-media");
    const OpusScript = (await import("opusscript")).default;
    const SAMPLE_RATE = 48000;
    const decoder = new OpusScript(SAMPLE_RATE, channels, OpusScript.Application.VOIP);
    const maxBytes = maxSeconds * SAMPLE_RATE * channels * 2;

    const demuxer = new prism.opus.OggDemuxer();
    const pcm = [];
    let total = 0;

    const done = new Promise((resolve, reject) => {
      demuxer.on("data", (packet) => {
        try {
          const out = decoder.decode(packet);
          if (out && total < maxBytes) { const b = Buffer.from(out.buffer, out.byteOffset, out.byteLength); pcm.push(b); total += b.length; }
        } catch { /* skip an undecodable packet; keep the rest */ }
      });
      demuxer.on("end", resolve);
      demuxer.on("error", reject);
    });
    Readable.from(ogg).pipe(demuxer);
    await done;
    try { decoder.delete?.(); } catch { /* */ }

    if (!total) return null;
    const data = Buffer.concat(pcm, Math.min(total, maxBytes));
    return Buffer.concat([wavHeader({ sampleRate: SAMPLE_RATE, channels, dataBytes: data.length }), data]);
  } catch {
    return null; // not opus / corrupt container → caller falls back
  }
}

export default oggOpusToWav;
