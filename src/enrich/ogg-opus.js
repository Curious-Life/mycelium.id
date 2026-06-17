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
 * @param {number} [opts.timeoutMs=60000]  wall-clock backstop — a crafted Ogg
 *        packed with millions of tiny Opus packets must not pin a core forever.
 * @returns {Promise<Buffer|null>}
 */
export async function oggOpusToWav(ogg, { channels = 1, maxSeconds = 900, timeoutMs = 60000 } = {}) {
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
    let capped = false; // once the output cap (or timeout) is hit, STOP decoding

    const done = new Promise((resolve, reject) => {
      demuxer.on("data", (packet) => {
        if (capped) return; // skip the expensive decode for remaining packets
        try {
          const out = decoder.decode(packet);
          if (out) {
            const b = Buffer.from(out.buffer, out.byteOffset, out.byteLength);
            pcm.push(b); total += b.length;
            if (total >= maxBytes) capped = true; // bound total decode work, not just the push
          }
        } catch { /* skip an undecodable packet; keep the rest */ }
      });
      demuxer.on("end", resolve);
      demuxer.on("error", reject);
    });
    // Wall-clock backstop: a tiny-packet flood is bounded by maxBytes (each
    // decoded frame yields proportional PCM), but the timeout guarantees the
    // call returns even if the container parse itself is pathological.
    const timeout = new Promise((resolve) => { setTimeout(() => { capped = true; resolve(); }, timeoutMs).unref?.(); });
    Readable.from(ogg).pipe(demuxer);
    await Promise.race([done, timeout]);
    try { decoder.delete?.(); } catch { /* */ }

    if (!total) return null;
    const data = Buffer.concat(pcm, Math.min(total, maxBytes));
    return Buffer.concat([wavHeader({ sampleRate: SAMPLE_RATE, channels, dataBytes: data.length }), data]);
  } catch {
    return null; // not opus / corrupt container → caller falls back
  }
}

export default oggOpusToWav;

/**
 * LOSSLESS long-audio variant: decode an OGG/Opus buffer and YIELD it as a
 * sequence of WAV windows (each <= windowSeconds), so a long voice note can be
 * transcribed in pieces and rejoined WITHOUT ever holding the whole decoded PCM
 * in memory. Peak memory is bounded to ~one window (pause/resume backpressure),
 * which is why the overall `maxSeconds` ceiling can be hours instead of the
 * single-shot 900s memory bound — nothing is lost on a long recording.
 *
 * A short voice note yields exactly ONE window whose bytes are identical to
 * oggOpusToWav's output, so the common path is unchanged.
 *
 * @param {Buffer} ogg
 * @param {object} [opts]
 * @param {number} [opts.channels=1]
 * @param {number} [opts.windowSeconds=600]   per-window audio length (~55MB mono PCM)
 * @param {number} [opts.maxSeconds=14400]    overall DoS ceiling (4h) — bounds total work
 * @param {number} [opts.timeoutMs=300000]    wall-clock backstop for the whole decode
 * @returns {AsyncGenerator<Buffer>}          successive WAV buffers
 */
export async function* oggOpusToWavChunks(ogg, { channels = 1, windowSeconds = 600, maxSeconds = 14400, timeoutMs = 300000 } = {}) {
  if (!Buffer.isBuffer(ogg) || ogg.length < 4 || ogg.subarray(0, 4).toString("latin1") !== "OggS") return;
  let prism, OpusScript;
  try { prism = await import("prism-media"); OpusScript = (await import("opusscript")).default; }
  catch { return; }
  const SAMPLE_RATE = 48000;
  const decoder = new OpusScript(SAMPLE_RATE, channels, OpusScript.Application.VOIP);
  const bytesPerSec = SAMPLE_RATE * channels * 2;
  const windowBytes = Math.max(bytesPerSec, Math.round(windowSeconds) * bytesPerSec);
  const maxBytes = Math.round(maxSeconds) * bytesPerSec;

  const demuxer = new prism.opus.OggDemuxer();
  const ready = [];          // completed WAV windows awaiting the consumer
  let win = [];              // current window's PCM chunks
  let winLen = 0;
  let totalLen = 0;
  let capped = false;
  let ended = false;
  let wake = null;           // resolver: a window is ready OR the stream ended
  const signal = () => { if (wake) { const r = wake; wake = null; r(); } };

  const flushWindow = () => {
    if (!winLen) return;
    const pcm = Buffer.concat(win, winLen);
    ready.push(Buffer.concat([wavHeader({ sampleRate: SAMPLE_RATE, channels, dataBytes: pcm.length }), pcm]));
    win = []; winLen = 0;
    signal();
  };

  demuxer.on("data", (packet) => {
    if (capped) return;
    try {
      const out = decoder.decode(packet);
      if (out) {
        const b = Buffer.from(out.buffer, out.byteOffset, out.byteLength);
        win.push(b); winLen += b.length; totalLen += b.length;
        if (winLen >= windowBytes) { flushWindow(); demuxer.pause(); }   // backpressure: wait for the consumer
        if (totalLen >= maxBytes) { capped = true; }                      // overall ceiling reached
      }
    } catch { /* skip an undecodable packet; keep the rest */ }
  });
  demuxer.on("end", () => { ended = true; signal(); });
  demuxer.on("error", () => { ended = true; signal(); });
  const timer = setTimeout(() => { capped = true; ended = true; signal(); }, timeoutMs);
  timer.unref?.();
  Readable.from(ogg).pipe(demuxer);

  try {
    for (;;) {
      if (ready.length) { yield ready.shift(); if (!ended && !capped) demuxer.resume(); continue; }
      if (ended) break;
      await new Promise((r) => { wake = r; });
    }
    flushWindow();                       // emit the trailing partial window
    while (ready.length) yield ready.shift();
  } finally {
    clearTimeout(timer);
    try { decoder.delete?.(); } catch { /* */ }
    try { demuxer.destroy?.(); } catch { /* */ }
  }
}
