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
export function wavHeader({ sampleRate, channels, dataBytes }) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + dataBytes, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(channels, 22); h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(dataBytes, 40);
  return h;
}

/** Bytes of WAV header that precede the PCM payload. */
export const WAV_HEADER_BYTES = 44;

/** Opus always decodes at 48kHz regardless of the rate it was encoded at (RFC 7845 §4). */
export const OPUS_DECODE_RATE = 48000;

/**
 * Read an Ogg/Opus stream's EXACT decoded length WITHOUT decoding a single packet.
 *
 * ⚠️ THIS IS WHAT MAKES STREAMED PLAYBACK POSSIBLE. An HTTP Range response has to state the
 * total size in `Content-Range: bytes a-b/TOTAL` **before** the first byte of the body — and
 * `oggOpusToWav` could only supply that by decoding the whole recording into one Buffer first
 * (~172 MB for 30 minutes), which is exactly why the route carried a 15-minute cap instead.
 * An Ogg page header already carries the answer: per RFC 7845 §4 the granule position counts
 * 48 kHz samples elapsed INCLUDING the pre-skip, so the last page's granule minus OpusHead's
 * pre-skip is the playable sample count, exact to the sample. Reading it is a linear walk of
 * the page headers — no decoder, no PCM, no allocation beyond the header fields.
 *
 * Only the FIRST logical bitstream is measured, because prism's demuxer decodes only that one. A
 * chained stream (several concatenated Opus streams — no voice-note encoder produces one) is
 * therefore reported with `chained: true` and `complete: false`: its later links are audio that
 * would be dropped without a trace, and a caller that served the first link alone would be
 * shipping a fraction of the recording under a clean 200.
 *
 * ⚠️ TWO SAMPLE COUNTS, AND THEY ARE NOT INTERCHANGEABLE. `granuleSamples` is what the DECODER
 * emits — pre-skip included — and is therefore the only one that may be used to size a WAV body or
 * a Content-Length. `samples`/`durationSec` are the RFC-playable figures with the encoder's
 * pre-skip warm-up removed (a few ms shorter); they describe the recording, not the bytes. Sizing
 * a response off `samples` would promise fewer bytes than the decoder produces.
 *
 * @param {Buffer} ogg
 * @returns {{channels:number, preSkip:number, granuleSamples:number, samples:number,
 *           durationSec:number, pages:number, chained:boolean, complete:boolean}|null} null when
 *          the buffer is not an Opus-in-Ogg stream (caller falls back), never a throw.
 */
export function oggOpusProbe(ogg) {
  if (!Buffer.isBuffer(ogg) || ogg.length < 28 || ogg.subarray(0, 4).toString("latin1") !== "OggS") return null;
  const NO_GRANULE = 0xffffffffffffffffn; // -1: no packet finishes on this page
  let off = 0, serial = null, channels = 0, preSkip = 0, pages = 0, sawEos = false, chained = false;
  let lastGranule = -1n;
  while (off + 27 <= ogg.length) {
    if (ogg.subarray(off, off + 4).toString("latin1") !== "OggS") break; // garbage after the last page
    const segCount = ogg.readUInt8(off + 26);
    const tableEnd = off + 27 + segCount;
    if (tableEnd > ogg.length) break;
    let payload = 0;
    for (let i = off + 27; i < tableEnd; i++) payload += ogg.readUInt8(i);
    const pageEnd = tableEnd + payload;
    // A page cut off by a truncated file is NOT counted — the last COMPLETE page's granule is
    // exactly the length we can actually decode, which is the honest promise to make.
    if (pageEnd > ogg.length) break;
    const pageSerial = ogg.readUInt32LE(off + 14);
    const granule = ogg.readBigUInt64LE(off + 6);
    if (serial === null) {
      const body = ogg.subarray(tableEnd, pageEnd);
      if (body.length < 19 || body.subarray(0, 8).toString("latin1") !== "OpusHead") return null; // Vorbis/other → not ours
      channels = body.readUInt8(9) || 1;
      preSkip = body.readUInt16LE(10);
      serial = pageSerial;
    } else if (pageSerial !== serial) {
      // ⚠️ A SECOND LOGICAL BITSTREAM. prism's demuxer decodes only the first one, so everything
      // past this point is audio we can neither measure nor serve. Saying so is the difference
      // between "here is the recording" and "here is 40% of the recording" (adversarial review, C2).
      chained = true;
    } else {
      // ⚠️ EOS IS CHECKED INDEPENDENTLY OF THE GRANULE. A page that finishes no packet carries
      // granule -1, and the end-of-stream flag can ride on exactly such a page — nesting this
      // inside the granule test made those streams permanently report `complete: false`.
      if (granule !== NO_GRANULE) lastGranule = granule;
      if (ogg.readUInt8(off + 5) & 0x04) sawEos = true;
    }
    pages += 1;
    off = pageEnd;
  }
  if (serial === null || lastGranule < 0n) return null;
  const granuleSamples = Number(lastGranule);
  const samples = Math.max(0, granuleSamples - preSkip); // playable, pre-skip excluded (RFC 7845 §4.1)
  return {
    channels, preSkip, granuleSamples, samples,
    durationSec: samples / OPUS_DECODE_RATE,
    pages,
    chained,
    // Everything this stream contains is measured AND decodable: an EOS page was seen, no page was
    // cut off the end, and there is no second bitstream carrying audio we would silently drop.
    complete: sawEos && off === ogg.length && !chained,
  };
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
 * A decode that was CUT SHORT. Raised by `oggOpusToWavChunks` after it has yielded everything it
 * managed to decode.
 *
 * ⚠️ THIS CLASS IS THE FIX FOR D-076 MECHANISM 2, AND THE `throw` IS THE POINT. The generator used
 * to hit its wall-clock cap, set `capped = true; ended = true`, and RETURN NORMALLY — so the
 * consumer rejoined a prefix of a 30-minute recording and stored it as the whole thing. There was
 * no fault, no log, no marker: every remaining Opus packet was discarded in silence. A cap is a
 * FAILURE TO COMPLETE THE WORK and must be indistinguishable-from-success for exactly nobody.
 */
export class AudioDecodeTruncatedError extends Error {
  constructor(reason, { secondsDecoded = 0, windows = 0, lostPackets = 0 } = {}) {
    super(`ogg decode truncated: ${reason}`);
    this.name = "AudioDecodeTruncatedError";
    this.reason = reason;            // 'decode-budget' | 'max-seconds' | 'stalled' | 'aborted' | 'packet-loss'
    this.secondsDecoded = secondsDecoded;
    this.windows = windows;
    this.lostPackets = lostPackets;
  }
}

/**
 * LOSSLESS long-audio variant: decode an OGG/Opus buffer and YIELD it as a
 * sequence of OVERLAPPING WAV windows, so a long voice note can be transcribed in pieces and
 * rejoined WITHOUT ever holding the whole decoded PCM in memory. Peak memory is bounded to
 * ~one window (pause/resume backpressure), which is why the overall `maxSeconds` ceiling can be
 * hours instead of the single-shot 900s memory bound — nothing is lost on a long recording.
 *
 * ── WHY WINDOWS OVERLAP (D-076) ─────────────────────────────────────────────────────────────
 * The previous version split at an exact byte offset, which lands MID-WORD roughly always: the
 * left window ends on a half-spoken word the model drops and the right window opens on its tail,
 * so a word is LOST at every seam and a 30-minute note loses one at each of them. Successive
 * windows now share `overlapSeconds` of audio, so every word is transcribed WHOLE by at least one
 * window; the resulting duplicate text is removed by `stitchTranscript` (transcript-coverage.js),
 * which is a solvable text problem where a clipped word is not recoverable at all.
 *
 * ── WHY THE BUDGET IS DECODE-TIME, NOT WALL-CLOCK (D-076 mechanism 2) ────────────────────────
 * This generator BACKPRESSURES: `demuxer.pause()` at a window boundary and `resume()` only when
 * the consumer takes the window. The consumer is a TRANSCRIPTION — minutes per window. A
 * wall-clock timer therefore charged transcription minutes against the DECODE budget, and on a
 * 30-minute file it fired mid-stream every time. The clock now runs ONLY while the demuxer is
 * flowing, so the budget measures the thing it is named after. A separate, generous `stallMs`
 * guard covers the genuinely pathological case (a container that neither yields data nor ends).
 *
 * A short voice note yields exactly ONE window whose bytes are identical to
 * oggOpusToWav's output, so the common path is unchanged.
 *
 * @param {Buffer} ogg
 * @param {object} [opts]
 * @param {number} [opts.channels=1]
 * @param {number} [opts.windowSeconds=120]   per-window audio length (~11.5MB mono PCM). 120s, not
 *        600s: the per-window transcribe budget is ~120s (transcribe-audio.js) and a 600s window
 *        also put a 57.6MB body against the service's 64MB MAX_BODY — 11% headroom, and none at all
 *        in stereo. Smaller windows are strictly more robust and each one is independently retriable.
 * @param {number} [opts.overlapSeconds=3}    audio shared with the PREVIOUS window (seam safety)
 * @param {number} [opts.maxSeconds=14400}    overall DoS ceiling (4h) — bounds total work
 * @param {number} [opts.decodeBudgetMs=300000}  budget for DECODE WORK ONLY (consumer time excluded)
 * @param {number} [opts.stallMs=120000}      no data AND no end for this long → stalled container
 * @yields {{wav: Buffer, index: number, startSec: number, endSec: number, overlapSec: number,
 *           lostPackets: number}} `lostPackets` is a RUNNING total — a consumer that stops early
 *           (a byte range filled) must check it, because the truncation throw below never reaches it.
 * @throws {AudioDecodeTruncatedError} when the decode was cut short — AFTER yielding what it had
 */
export async function* oggOpusToWavChunks(ogg, {
  channels = 1,
  windowSeconds = 120,
  overlapSeconds = 3,
  maxSeconds = 14400,
  decodeBudgetMs = Number(process.env.MYCELIUM_OGG_DECODE_BUDGET_MS) || 300000,
  stallMs = Number(process.env.MYCELIUM_OGG_STALL_MS) || 120000,
  // The CALLER's overall budget (a live turn holding the single model slot). The generator used to
  // take no signal at all, so a blown 240 s live bound could not stop an in-flight decode — the
  // one place where an unbounded loop costs the whole box its resident lane.
  signal: abortSignal,
  // Back-compat: the old option name meant "wall clock for the whole decode". Honour it as the
  // DECODE budget rather than ignoring it, so an existing caller/gate that passes it still bounds work.
  timeoutMs,
} = {}) {
  if (!Buffer.isBuffer(ogg) || ogg.length < 4 || ogg.subarray(0, 4).toString("latin1") !== "OggS") return;
  let prism, OpusScript;
  try { prism = await import("prism-media"); OpusScript = (await import("opusscript")).default; }
  catch { return; }
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) decodeBudgetMs = timeoutMs;
  const SAMPLE_RATE = 48000;
  const decoder = new OpusScript(SAMPLE_RATE, channels, OpusScript.Application.VOIP);
  const bytesPerSec = SAMPLE_RATE * channels * 2;
  const frameBytes = channels * 2;
  const windowBytes = Math.max(bytesPerSec, Math.round(windowSeconds * bytesPerSec / frameBytes) * frameBytes);
  // Overlap is capped at half a window: a larger one would make progress non-monotonic (each
  // window would re-emit more than it advances) and could loop forever on a long file.
  const overlapBytes = Math.min(
    Math.floor(windowBytes / 2 / frameBytes) * frameBytes,   // frame-aligned, else the overlap is byte-shifted noise
    Math.max(0, Math.round(Math.max(0, overlapSeconds) * bytesPerSec / frameBytes) * frameBytes),
  );
  const maxBytes = Math.round(maxSeconds) * bytesPerSec;

  const demuxer = new prism.opus.OggDemuxer();
  const ready = [];          // completed windows awaiting the consumer
  let win = [];              // current window's PCM chunks (may open with the previous overlap)
  let winLen = 0;
  let carry = null;          // trailing `overlapBytes` of the last flushed window
  let emittedBytes = 0;      // NEW (non-overlap) audio emitted so far — the timeline cursor
  let totalLen = 0;          // total decoded PCM (overlap counted once)
  let index = 0;
  let capped = null;         // truncation reason, once set
  let lostPackets = 0;       // packets the decoder rejected — audio that is simply gone
  let ended = false;
  let wake = null;           // resolver: a window is ready OR the stream ended
  // DECODE-ONLY CLOCK: `flowStart` is non-null exactly while the demuxer is flowing.
  let decodeMs = 0;
  let flowStart = Date.now();
  const decodeElapsed = () => decodeMs + (flowStart == null ? 0 : Date.now() - flowStart);
  const pauseClock = () => { if (flowStart != null) { decodeMs += Date.now() - flowStart; flowStart = null; } };
  const resumeClock = () => { if (flowStart == null) flowStart = Date.now(); };
  const signal = () => { if (wake) { const r = wake; wake = null; r(); } };

  const flushWindow = () => {
    if (!winLen) return;
    const pcm = Buffer.concat(win, winLen);
    // The window's absolute position on the recording's timeline. `startSec` accounts for the
    // overlap it opens with, so a consumer can map text back onto real time.
    const overlapLen = carry ? Math.min(carry.length, pcm.length) : 0;
    const newLen = pcm.length - overlapLen;
    const startSec = Math.max(0, (emittedBytes - overlapLen) / bytesPerSec);
    emittedBytes += newLen;
    ready.push({
      wav: Buffer.concat([wavHeader({ sampleRate: SAMPLE_RATE, channels, dataBytes: pcm.length }), pcm]),
      index: index++,
      startSec: Math.round(startSec * 100) / 100,
      endSec: Math.round((emittedBytes / bytesPerSec) * 100) / 100,
      overlapSec: Math.round((overlapLen / bytesPerSec) * 100) / 100,
      // ⚠️ THE LOSS COUNT TRAVELS WITH THE WINDOW, NOT ONLY WITH THE FINAL THROW.
      // `AudioDecodeTruncatedError` is raised after the LAST window is yielded — which a consumer
      // that stops early never sees, because `break` runs the generator's `finally` and skips the
      // throw entirely. A streaming consumer legitimately stops early (its byte range is full), and
      // it was therefore able to deliver a timeline with a hole closed up inside it and report
      // success — D-076's compressed-timeline defect, reachable through the D-077 fix for it.
      // Running total, so a consumer can check the audio it has ALREADY taken.
      lostPackets,
    });
    // Retain the tail as the NEXT window's head (seam safety), then reset.
    // COPY, not a view: `subarray` keeps the whole ~11.5 MB window Buffer alive until the next
    // flush, so peak memory was ~2 windows rather than the ~1 the backpressure design documents
    // (second adversarial review, LOW-7). The tail is ~288 KB — copying it is strictly cheaper.
    carry = overlapBytes > 0 ? Buffer.from(pcm.subarray(Math.max(0, pcm.length - overlapBytes))) : null;
    win = []; winLen = 0;
    signal();
  };

  let lastData = Date.now();
  demuxer.on("data", (packet) => {
    if (capped) return;
    // ⚠️ THE BUDGET IS CHECKED BEFORE THE DECODE, NOT AFTER IT, AND OUTSIDE `if (out)`.
    // Both ceilings used to live inside `if (out)`, and an undecodable packet is swallowed by the
    // catch below — so a container whose packets ALL fail to decode was bounded by nothing at all.
    // Measured (second adversarial review, MEDIUM-5): 2,000,000 undecodable packets in a 4.2 MB ogg
    // burned 13.6 s of solid CPU against a 50 ms budget and then returned NORMALLY, with no
    // truncation error — while holding the single RESIDENT model slot. prism's OggDemuxer drains
    // the whole buffer synchronously, so the stall timer cannot fire either (it never gets the
    // macrotask). The check has to be here, on every packet, before any work.
    if (decodeElapsed() >= decodeBudgetMs) { capped = "decode-budget"; ended = true; signal(); return; }
    if (abortSignal?.aborted) { capped = "aborted"; ended = true; signal(); return; }
    lastData = Date.now();
    try {
      const out = decoder.decode(packet);
      if (out) {
        if (!winLen && carry && carry.length) { win.push(carry); winLen += carry.length; }  // open with the overlap
        const b = Buffer.from(out.buffer, out.byteOffset, out.byteLength);
        win.push(b); winLen += b.length; totalLen += b.length;
        if (winLen >= windowBytes) { flushWindow(); pauseClock(); demuxer.pause(); }   // backpressure
        // ⚠️ BOTH ceilings are TRUNCATION, and both must surface as a fault (never a normal return).
        if (totalLen >= maxBytes) { capped = "max-seconds"; ended = true; signal(); }
        else if (decodeElapsed() >= decodeBudgetMs) { capped = "decode-budget"; ended = true; signal(); }
      }
    } catch {
      // ⚠️ A SKIPPED PACKET IS LOST AUDIO, AND IT USED TO VANISH WITHOUT A TRACE.
      // Swallowing the throw keeps the rest of the stream — which is right — but it also COMPRESSES
      // the timeline: the surviving packets close ranks, every window still transcribes, and
      // `coveredSec` equals `durationSec` because both are derived from the bytes that survived.
      // The row was therefore stamped `complete:true` over a transcript with silence cut out of the
      // middle, and the new drain predicate then excludes it PERMANENTLY (adversarial review round 2,
      // HIGH-1: 6 s file with a garbled middle third → 4.02 s decoded, complete:true, no gaps).
      // Counting them is what makes the loss expressible; the count becomes a truncation below.
      lostPackets += 1;
    }
  });
  demuxer.on("end", () => { ended = true; pauseClock(); signal(); });
  demuxer.on("error", () => { ended = true; pauseClock(); signal(); });
  // The STALL guard is the only real wall-clock timer left, and it is not a work budget: it fires
  // solely when the demuxer is flowing yet producing nothing and never ending. While the consumer
  // holds the generator the demuxer is PAUSED, so `lastData` staleness is not consulted then.
  const stallTimer = setInterval(() => {
    if (capped || ended || flowStart == null) return;
    if (Date.now() - lastData >= stallMs) { capped = "stalled"; ended = true; signal(); }
  }, Math.max(1000, Math.min(stallMs, 5000)));
  stallTimer.unref?.();
  Readable.from(ogg).pipe(demuxer);

  try {
    for (;;) {
      if (ready.length) {
        yield ready.shift();
        if (!ended && !capped) { resumeClock(); demuxer.resume(); }
        continue;
      }
      if (ended) break;
      // ⚠️ DO NOT pause the clock here. Reaching this point means no window is ready and the
      // stream has not ended — i.e. the demuxer is FLOWING and decoding right now. That time is
      // decode work and must be charged. The clock is paused only where the demuxer itself is
      // paused (the flush branch above) or has ended.
      await new Promise((r) => { wake = r; });
    }
    flushWindow();                       // emit the trailing partial window
    while (ready.length) yield ready.shift();
    // Everything decodable has been handed over. NOW tell the truth about whether that was all of it.
    // A healthy Opus stream decodes every packet, so ANY loss means the recording is not intact —
    // fail closed and let the caller mark the row resumable rather than assert a compressed
    // timeline is the whole thing.
    if (!capped && lostPackets > 0) capped = "packet-loss";
    if (capped) {
      throw new AudioDecodeTruncatedError(capped, {
        secondsDecoded: Math.round((emittedBytes / bytesPerSec) * 100) / 100,
        windows: index,
        lostPackets,
      });
    }
  } finally {
    clearInterval(stallTimer);
    try { decoder.delete?.(); } catch { /* */ }
    try { demuxer.destroy?.(); } catch { /* */ }
  }
}
