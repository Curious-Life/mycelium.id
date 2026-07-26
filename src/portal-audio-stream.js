// src/portal-audio-stream.js — the browser-playable half of a voice note.
//
// WKWebView (the Tauri shell) cannot decode Opus, so `/attachments/:id/file?format=wav` hands it
// PCM instead. That transcode used to be one call to `oggOpusToWav(bytes)`, whose `maxSeconds`
// defaults to 900 — so a recording longer than FIFTEEN MINUTES was served as a fifteen-minute WAV
// and simply stopped. No error, no marker, no shorter duration in the scrubber than the file
// really had: the owner heard their thirty-minute recording end at 15:00 and had no way to learn
// that the rest existed. This is the playback-layer sibling of D-076 (transcription), and it is
// the same defect: WORK THAT WAS CUT SHORT REPORTED AS WORK THAT FINISHED.
//
// ── WHY THE CAP COULD NOT SIMPLY BE RAISED ───────────────────────────────────────────────────
// `oggOpusToWav` materialises the entire decode in ONE Buffer. Mono 48k s16le is 5.76 MB per
// minute, so a 30-minute note is ~172 MB and an hour is ~345 MB — held whole, per concurrent
// request, on a machine that is also running a local model. Raising 900 to 14400 would trade a
// silent truncation for an OOM, which is a worse failure of the same promise.
//
// ── THE SHAPE ────────────────────────────────────────────────────────────────────────────────
// Nothing is materialised. `oggOpusProbe` reads the EXACT decoded length out of the Ogg page
// headers without decoding a packet (RFC 7845 granule arithmetic), which supplies the
// `Content-Length` / `Content-Range` total that HTTP demands up front; then `oggOpusToWavChunks`
// streams the PCM in windows and each window is sliced against the requested byte range and
// written straight to the socket under backpressure. Peak memory is FLAT IN RECORDING LENGTH —
// measured 37/20/20/14/12 MB over baseline at 2/8/16/32/64 minutes, against a body that grows to
// 184 MB+. (Flat, but larger than the ~2.9 MB a window alone would suggest: prism's demuxer pushes
// every packet into its readable buffer regardless of `pause()`. The scaling is what matters — the
// buffered path it replaces cost +270 MB at 16 minutes and grew linearly.) Range requests are answered exactly, which is what WKWebView needs to
// play at all, and a seek costs a re-decode from the start — measured at ~800x realtime, so
// ~2.2 s for a 30-minute note (opusscript, this machine, 2026-07-26).
//
// ── AND IF IT STILL COMES UP SHORT ───────────────────────────────────────────────────────────
// The promise made in the header is enforced against what the decoder actually produced. A
// shortfall under `SILENCE_PAD_SAMPLES` (encoder pre-skip/frame-rounding slack, ~100 ms) is
// padded with silence so the response stays well-formed. Anything larger is a REAL cut, and the
// socket is destroyed rather than completed: the client gets a failed transfer and fires `error`
// — which the Media page renders as "couldn't be decoded" — instead of a complete-looking file
// that quietly stops early. Never again a short body dressed as a whole recording.
import { once } from 'node:events';
import {
  oggOpusProbe, oggOpusToWavChunks, wavHeader,
  WAV_HEADER_BYTES, OPUS_DECODE_RATE,
} from './enrich/ogg-opus.js';

// Telegram voice notes are mono, and the decoder is driven at that geometry (unchanged from the
// buffered path). Granule counts samples per channel, so the byte math is channel-independent.
const PLAYBACK_CHANNELS = 1;
// Per-window audio held in memory while streaming. Smaller than the transcription window (120 s):
// nothing downstream batches on it, so this only sets the backpressure granularity — 30 s ≈ 2.9 MB.
const PLAYBACK_WINDOW_SEC = 30;
// Overall ceiling, matching the decoder's own DoS bound. A recording longer than this IS served
// truncated, and it is the one cut here that no client can detect: `X-Audio-Truncated` is set
// before the first byte, but an `<audio>` element gives JavaScript no access to response headers,
// so the header is a server-side/diagnostic record and not a user-facing signal. Honest statement
// of the residual: past this ceiling the truncation is still discoverable only by ear. It is set
// at four HOURS — an hour of voice note is already 345 MB of PCM — so no recording this product
// produces approaches it; if that ever stops being true, the ceiling needs a real UI signal, not
// a bigger number.
const PLAYBACK_MAX_SECONDS = 14400; // 4h
// Slack between the granule-derived promise and what the decoder emits: encoders pad the front of
// the stream by `preSkip` samples and round the tail up to a whole frame, so the two can disagree
// by tens of milliseconds in either direction. Below this, pad with silence; above it, the
// recording genuinely lost audio and the response must fail loudly.
const SILENCE_PAD_SAMPLES = OPUS_DECODE_RATE / 10; // 100 ms

/**
 * Parse an HTTP Range header against a known total.
 *
 * Shared by the streamed WAV path and the buffered raw-bytes path so the two can never drift on
 * what `bytes=-N` or an out-of-range start means.
 *
 * @param {string|undefined} header raw `Range:` value
 * @param {number} total            resource size in bytes
 * @returns {{start:number, end:number}|null|'unsatisfiable'} null = no (or unparseable) range,
 *          which means "send the whole thing"; 'unsatisfiable' = a 416 is owed.
 */
export function parseByteRange(header, total) {
  const m = header && /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return null;
  let start = m[1] === '' ? NaN : parseInt(m[1], 10);
  let end = m[2] === '' ? NaN : parseInt(m[2], 10);
  if (Number.isNaN(start)) { // suffix range: bytes=-N → last N bytes
    const n = Number.isNaN(end) ? total : end;
    start = Math.max(0, total - n); end = total - 1;
  }
  if (Number.isNaN(end) || end >= total) end = total - 1;
  if (Number.isFinite(start) && start >= 0 && start <= end && start < total) return { start, end };
  return 'unsatisfiable';
}

/**
 * Serve an Ogg/Opus attachment as a streamed WAV, honouring Range.
 *
 * @param {object} args
 * @param {import('express').Request} args.req
 * @param {import('express').Response} args.res
 * @param {Buffer} args.ogg            decrypted source bytes
 * @param {string|null} [args.fileName] for Content-Disposition (sanitised by the caller's rules)
 * @param {(msg:string)=>void} [args.log] fault sink — receives NO audio and NO vault content (§1)
 * @returns {Promise<boolean>} true when the response was handled (headers sent); false when this
 *          is not a decodable Opus stream and the caller should fall back to the raw bytes.
 */
export async function streamOggAsWav({ req, res, ogg, fileName = null, log = console.error }) {
  const probe = oggOpusProbe(ogg);
  if (!probe || !(probe.granuleSamples > 0)) return false; // not Opus / no timeline → caller falls back
  // ⚠️ A CHAINED CONTAINER IS SERVED AS THE ORIGINAL OGG, NOT AS A WAV OF ITS FIRST LINK. The
  // demuxer decodes only the first logical bitstream, so transcoding would hand back a fraction of
  // the recording under a clean 200 — the very defect this module exists to end. The raw bytes are
  // the honest answer: every non-WebKit browser decodes a chained Ogg in full, and WebKit gets an
  // audible failure rather than a silent 40%. No voice-note encoder produces one.
  if (probe.chained) return false;
  try {
    return await serveStreamedWav({ req, res, ogg, fileName, log, probe });
  } catch (err) {
    // A fault in the response machinery itself — the decode's own faults are handled inside.
    // Before the first byte this is recoverable; after it, the body would be short and must never
    // be completed as though it were whole.
    if (res.headersSent) { res.destroy(); return true; }
    log(`[portal-audio] wav stream setup failed: ${err?.message}`);
    return abandonWavResponse(res);
  }
}

/**
 * Hand the request back exactly as we found it: every header the WAV branch set is removed and the
 * status reset, so the caller's raw-bytes fallback is never left serving Ogg under an `audio/wav`
 * Content-Type or a stale Content-Range. Only valid while `headersSent` is false.
 * @returns {false} always — the caller's signal to serve the original bytes.
 */
function abandonWavResponse(res) {
  for (const h of ['Content-Type', 'Content-Disposition', 'Content-Length', 'Content-Range',
    'X-Audio-Duration-Sec', 'X-Audio-Truncated', 'X-Audio-Source-Incomplete']) res.removeHeader(h);
  res.status(200);
  return false;
}

async function serveStreamedWav({ req, res, ogg, fileName, log, probe }) {
  const channels = PLAYBACK_CHANNELS;
  // We serve exactly `granuleSamples` — the recording's own declared timeline, pre-skip included.
  // On a container with no end-trim that is byte-identical to what `oggOpusToWav` produces uncapped
  // (verify:ogg-opus G16). On a REAL one it is deliberately a few milliseconds shorter: libopus pads
  // the final frame and declares the trim in the granule, and `oggOpusToWav` returns that padding
  // while we drop it (G20 pins the relationship — the decoder emits at least the granule and at most
  // one frame more). Do not "restore" the identity by serving the decoder's raw output: the promise
  // in Content-Length is derived from the granule, and the two must agree.
  const maxSamples = PLAYBACK_MAX_SECONDS * OPUS_DECODE_RATE;
  const overCeiling = probe.granuleSamples > maxSamples;
  const samples = overCeiling ? maxSamples : probe.granuleSamples;
  const dataBytes = samples * channels * 2;
  const total = WAV_HEADER_BYTES + dataBytes;

  res.setHeader('Content-Type', 'audio/wav');
  if (fileName) {
    res.setHeader('Content-Disposition', `inline; filename="${String(fileName).replace(/[^\w. -]/g, '_')}.wav"`);
  }
  // The true recording length, stated up front and independent of what we manage to decode, so a
  // client can tell a full serve from a cut one without listening to it.
  res.setHeader('X-Audio-Duration-Sec', String(Math.round((probe.granuleSamples / OPUS_DECODE_RATE) * 100) / 100));
  // ⚠️ ANNOUNCED BEFORE THE BODY. The only cut we serve on purpose is one the header declares.
  if (overCeiling) res.setHeader('X-Audio-Truncated', 'max-seconds');
  if (!probe.complete) res.setHeader('X-Audio-Source-Incomplete', '1'); // the stored blob itself is cut short

  const range = parseByteRange(req.headers.range, total);
  if (range === 'unsatisfiable') {
    res.status(416).setHeader('Content-Range', `bytes */${total}`);
    res.end();
    return true;
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : total - 1;
  if (range) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
  }
  res.setHeader('Content-Length', end - start + 1);

  // The client going away (a seek, a closed tab, WKWebView cancelling a range) must stop the
  // decode, not leave it running against the CPU the local model also wants.
  const headOnly = req.method === 'HEAD';
  const abort = new AbortController();
  const onClose = () => abort.abort();
  res.on('close', onClose);

  const want = end - start + 1;
  let cursor = 0;   // absolute offset, in the virtual `header ++ pcm` stream, of the next byte produced
  let written = 0;  // bytes actually put on the socket

  /**
   * Offer the next slice of the virtual stream; only its intersection with [start,end] is written.
   * @returns {Promise<boolean>} true while more bytes are still owed to the client.
   */
  const push = async (buf) => {
    const at = cursor;
    cursor += buf.length;
    const from = Math.max(start, at);
    const to = Math.min(end, cursor - 1);
    if (to >= from) {
      const slice = buf.subarray(from - at, to - at + 1);
      written += slice.length;
      if (!res.write(slice) && !abort.signal.aborted) {
        // Backpressure. The abort signal is what keeps this from hanging forever on a socket the
        // client already dropped — 'drain' would never arrive.
        try { await once(res, 'drain', { signal: abort.signal }); } catch { /* aborted */ }
      }
    }
    return written < want && !abort.signal.aborted;
  };

  let more = true;
  let pcmDelivered = 0;
  let windows = 0;
  let cutReason = null;
  try {
    for await (const win of oggOpusToWavChunks(ogg, {
      channels,
      windowSeconds: PLAYBACK_WINDOW_SEC,
      overlapSeconds: 0,           // ⚠️ playback is a byte stream: overlap would duplicate audio
      maxSeconds: PLAYBACK_MAX_SECONDS,
      signal: abort.signal,
    })) {
      // ⚠️ THE WAV HEADER IS WRITTEN WITH THE FIRST WINDOW, NOT BEFORE IT — that is what keeps
      // the old fail-soft alive. Node does not put headers on the wire until the first write, so
      // as long as nothing has been written we can still abandon this branch and let the caller
      // serve the original Ogg bytes (which a non-WebKit browser plays natively). Writing the
      // header up front would commit us to a WAV response before knowing a single packet decodes.
      // ⚠️ A HEAD IS ANSWERED AFTER THE FIRST WINDOW DECODES, NOT FROM THE PROBE ALONE. Answering
      // from the probe made HEAD and GET disagree on exactly the fail-soft path: a container that
      // probes cleanly but decodes to nothing returned `audio/wav` + a 96044-byte length to HEAD
      // and `audio/ogg` + 1548 bytes to GET. Both Svelte players set `preload="metadata"`, and
      // WebKit range-probes before the real fetch, so that divergence lands in the one client this
      // route exists for (adversarial review, C4). One window (~40 ms) buys agreement.
      if (headOnly) { res.off('close', onClose); res.end(); return true; }
      if (windows === 0) more = await push(wavHeader({ sampleRate: OPUS_DECODE_RATE, channels, dataBytes }));
      windows += 1;
      if (!more) break;
      // ⚠️ CHECKED PER WINDOW, NOT AT THE END, AND THIS IS LOAD-BEARING. A rejected packet is
      // audio that is simply gone, and the surviving packets CLOSE RANKS around the hole — the
      // timeline compresses, so the body still reaches its promised length and sounds seamless.
      // The generator does raise `packet-loss`, but only after its LAST window, and this loop
      // legitimately stops early the moment the requested byte range is full: `break` runs the
      // generator's `finally` and skips the throw. So a mid-recording hole was delivered as a
      // complete 200 with no fault anywhere — D-076's compressed timeline, reproduced inside the
      // fix for its playback sibling (adversarial review of this change, C1). The running count on
      // the window is checked against the audio ALREADY TAKEN, which is the honest scope: loss
      // beyond the bytes we serve does not corrupt the bytes we serve.
      if (win.lostPackets > 0) { cutReason = 'packet-loss'; break; }
      let pcm = win.wav.subarray(WAV_HEADER_BYTES);
      // Trim the tail the granule says is not part of the recording (encoders round the last
      // frame up); never deliver more than the promise.
      if (pcmDelivered + pcm.length > dataBytes) pcm = pcm.subarray(0, dataBytes - pcmDelivered);
      pcmDelivered += pcm.length;
      more = await push(pcm);
      if (!more || pcmDelivered >= dataBytes) break;
    }
  } catch (err) {
    // AudioDecodeTruncatedError (budget/stall/packet-loss/abort) or any decoder fault. Whatever
    // it was, the recording is not fully here — that is the one thing the response must not hide.
    cutReason = err?.reason || 'decode-error';
  }

  res.off('close', onClose);
  if (abort.signal.aborted) { res.destroy(); return true; } // client left; nothing owed to anyone

  // Nothing decoded at all: the probe read a plausible Ogg timeline but no packet survived the
  // decoder. Nothing has reached the socket, so hand the request back UNTOUCHED and let the raw
  // bytes be served — the pre-existing fail-soft, preserved.
  if (windows === 0) return abandonWavResponse(res);

  const missing = dataBytes - pcmDelivered;
  // `more` false means the client's requested range was filled from clean audio — a seek that
  // lands before a fault is not the seek's problem. Otherwise we still owe bytes, and a recorded
  // `cutReason` is disqualifying on its own even if the arithmetic happens to balance.
  if (more && (missing > 0 || cutReason)) {
    const padBytes = missing;
    if (!cutReason && padBytes <= SILENCE_PAD_SAMPLES * channels * 2) {
      // Encoder pre-skip / frame-rounding slack. Silence here is not a truncation being hidden:
      // it is under a tenth of a second at the very end, and the alternative — failing the whole
      // response — would cost the owner a recording that is entirely present.
      const SILENCE = Buffer.alloc(Math.min(padBytes, 65536));
      for (let left = padBytes; left > 0 && more;) {
        const n = Math.min(left, SILENCE.length);
        more = await push(n === SILENCE.length ? SILENCE : SILENCE.subarray(0, n));
        left -= n;
      }
    } else {
      // ⚠️ THE D-076 MOMENT, AND THE REASON THIS FUNCTION EXISTS. We promised `total` bytes and
      // the decoder could not produce them. Ending the response here would deliver a body that
      // LOOKS complete and stops early — precisely the silent truncation being fixed. Destroying
      // the socket makes the client fail the transfer and fire `error`, which the Media page
      // turns into visible copy. A cut recording must be indistinguishable-from-whole for nobody.
      log(`[portal-audio] wav stream cut short: reason=${cutReason || 'short-decode'} missingBytes=${missing} of ${dataBytes}`);
      res.destroy();
      return true;
    }
  }
  res.end();
  return true;
}

export default streamOggAsWav;
