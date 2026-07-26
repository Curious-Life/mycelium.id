// src/enrich/transcribe-audio.js — best-effort, fail-soft LOCAL audio transcription.
//
// Turns a voice note / audio file into text so it can be embedded by the TEXT
// pipeline and read by the channel agent — entirely on-box (no Whisper, no
// cloud). SPIKE-VERIFIED 2026-06-10: Ollama's NATIVE /api/chat silently ignores
// audio fields; the working shape is the OpenAI-compatible endpoint
// /v1/chat/completions with an `input_audio` content part. gemma4:12b
// (capabilities: [...,'audio',...]) transcribed real speech this way.
//
// Same discipline as describe-image.js: NEVER hang, NEVER throw — no
// audio-capable model / Ollama down / decode failure → null, the caller falls
// back to a placeholder. Bytes go to 127.0.0.1 only and are never logged.

import { DEFAULT_OLLAMA_URL } from "../inference/local.js";
import { clampStored } from "./text-limits.js";
import { pickModelWithCapability } from "./model-caps.js";
import { getTranscriberHealth, transcribeServiceUrl } from "../transcribe/supervisor.js";
import { transcribeLongAudio } from "./transcribe-long.js";

const TRANSCRIBE_PROMPT =
  "Transcribe this audio exactly, word for word. Output ONLY the transcription " +
  "text — no preamble, no quotes, no commentary. If the audio is empty or " +
  "unintelligible, output nothing.";

/** Map a mime type / filename to the OpenAI input_audio `format` field. */
export function audioFormatFor(mimeType, fileName = "") {
  const m = String(mimeType || "").toLowerCase();
  const n = String(fileName || "").toLowerCase();
  if (m.includes("ogg") || m.includes("opus") || n.endsWith(".ogg") || n.endsWith(".opus")) return "ogg";
  if (m.includes("mpeg") || m.includes("mp3") || n.endsWith(".mp3")) return "mp3";
  if (m.includes("wav") || n.endsWith(".wav")) return "wav";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac") || n.endsWith(".m4a")) return "m4a";
  if (m.includes("webm") || n.endsWith(".webm")) return "webm";
  if (m.includes("flac") || n.endsWith(".flac")) return "flac";
  return "wav"; // benign default — the decoder rejects what it can't read and we fail soft
}

/**
 * Transcribe audio bytes via a local audio-capable model. Returns the
 * transcription string, or null when no model is available / decode failed.
 *
 * @param {object} opts
 * @param {Buffer} [opts.bytes]      raw audio bytes
 * @param {string} [opts.base64]     alternative to bytes (no data: prefix)
 * @param {string} [opts.mimeType]
 * @param {string} [opts.fileName]
 * @param {string} [opts.model]      force a model (else capabilities probe)
 * @param {string} [opts.prefer]     prefer this model when it qualifies (active provider)
 * @param {string} [opts.baseUrl]
 * @param {typeof fetch} [opts.fetch]
 * @param {number} [opts.timeoutMs]  whole-call budget (cold model + decode + generate)
 * @returns {Promise<string|null>}
 */
export async function transcribeAudio({
  bytes,
  base64,
  mimeType,
  fileName,
  model,
  prefer,
  baseUrl = process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL,   // follows an ollama-daemon alt-port self-heal (loopback)
  fetch: fetchImpl = globalThis.fetch,
  // 300s: a ~7s voice note on a 12B model took >180s live (2026-06-10) — the
  // same cold-model lesson as the channel turn's CHANNEL_OLLAMA_TIMEOUT_MS.
  timeoutMs = Number(process.env.MYCELIUM_TRANSCRIBE_TIMEOUT_MS) || 300000,
  // ── LIVE-TURN SEAMS (QA9) — both default to "off", so every existing caller is unchanged ──
  // `signal` BOUNDS THE WHOLE DECODE, and it exists because of a governor invariant, not for
  // tidiness. When the live channel route holds an INTERACTIVE ticket it occupies the ONE model
  // slot (RESIDENT_MAX = 1), so its hold time must be BOUNDED or every background lane wedges
  // behind it — and the ticket's lease must be sized above that bound or it reclaims mid-decode
  // and double-admits (the D-001 shape). Without a signal reaching `transcribeLongAudio`, the
  // real cap is that function's own 2 h default, ×2 for withRetry — far past any sane lease.
  // `onProgress` is the ticket HEARTBEAT source: real per-segment progress, never a timer
  // (design §5 — "heartbeats must come from real progress"), so a live decode re-arms its own
  // lease exactly as long as it is genuinely advancing.
  signal,
  onProgress,
  // ── D-076 HONESTY SEAMS ───────────────────────────────────────────────────────────────────
  // `onFault` was DROPPED here: transcribe-long.js grew a fault out-channel so a failed 30-minute
  // job could be told apart from a silent recording, and this function — the ONE entry point the
  // live channel turn uses — simply did not pass it. Every reason died at this line and the route
  // reported nothing at all. It is threaded now, for both engines.
  onFault,
  // Coverage: `complete:false` means the audio was NOT fully transcribed. Reported for the Whisper
  // path (from the `done` sentinel) AND for the OGG-window path (from decode truncation / failed
  // windows), so no caller can mistake a prefix for the whole recording.
  onCoverage,
  // Progressive save + resume offset — same contract as transcribe-long.js.
  onSegment,
  startSec = 0,
  // Injectable transcriber-health read (tests); defaults to the live supervisor. Same seam
  // transcribeAttachment / transcribeLongAudio / portalAttachmentsRouter already expose. Without it
  // a gate cannot drive the TWO-ENGINE path (a healthy Whisper stream that yields no words, falling
  // through to the OGG/LLM engines) — which is exactly where the cross-engine coverage bug lived.
  getHealth = getTranscriberHealth,
} = {}) {
  let buf = Buffer.isBuffer(bytes) ? bytes : (base64 ? Buffer.from(base64, "base64") : null);
  if (!buf || typeof fetchImpl !== "function") return null;

  const format = audioFormatFor(mimeType, fileName);
  const readHealth = () => { try { return getHealth() || { status: 'unknown' }; } catch { return { status: 'unknown' }; } };
  const fault = (reason, detail = null) => { try { onFault?.(reason, detail); } catch { /* a reporter must never break a decode */ } };
  // ⚠️ LAST WRITE WINS — NOT A ONE-SHOT LATCH. This function can run TWO engines in one call: the
  // Whisper stream first, and if it yields no usable text, the OGG-window path. A first-write-wins
  // latch meant the engine that produced the RETURNED TEXT could not report its own coverage.
  // Concretely (adversarial review, CRITICAL-1): a stream that completes with zero words reports
  // `complete:true` and returns null (the honest `no-speech` outcome), execution falls through to
  // the OGG path, that path transcribes 9 of 10 windows and reports `complete:false` with a gap —
  // and the latch DISCARDED it. The caller wrote `complete:true` over a transcript with a hole in
  // it: D-076's exact shape, surviving inside the fix. Coverage must describe the text actually
  // returned, so the LAST engine to run is the one that owns the record.
  const reportCoverage = (c) => {
    try { onCoverage?.(c); } catch { /* a reporter must never break a decode */ }
  };

  // PRIMARY when a Whisper model is ready: the streaming /transcribe-file path
  // (src/enrich/transcribe-long.js) decodes ANY container (m4a/mp3/ogg/…) and
  // VAD-segments LONG audio natively — so a 45-min recording transcribes in full,
  // not just short WAV voice notes. This is the ONE shared chokepoint, so portal
  // uploads AND channel voice both get robust long-audio transcription. Falls
  // through to the OGG-window + LLM path below when no model / it fails.
  if (readHealth().status === "ok") {
    // onFault/onCoverage/onSegment/startSec all forwarded: this path is where a 30-minute recording
    // is actually transcribed, so it is exactly where the honesty signals must not be dropped.
    const full = await transcribeLongAudio({
      bytes: buf, format, fetch: fetchImpl, signal, onProgress,
      onFault, onSegment, startSec, getHealth,
      onCoverage: (c) => reportCoverage({ ...c, engine: 'whisper-stream' }),
    });
    if (full) return clampStored(full);
  }

  // Transcribe ONE audio buffer: the dedicated Whisper service first (WAV only,
  // ~100x faster than the LLM path — the transcription design), else a
  // local audio-capable model. Returns RAW text; the 200k DoS clamp is applied
  // ONCE at the top-level return, after rejoining windows (store full, clamp at
  // the end). The LLM-model capability probe is memoized across windows.
  let _llmModel;
  const llmModel = async () => {
    if (_llmModel !== undefined) return _llmModel;
    _llmModel = model || process.env.MYCELIUM_AUDIO_MODEL
      || (await pickModelWithCapability("audio", { prefer, baseUrl, fetch: fetchImpl })) || null;
    return _llmModel;
  };
  const transcribeOne = async (b, fmt, { windowSec = 0 } = {}) => {
    // ⚠️ THE ABORT GUARD MOVED ABOVE THE WHISPER BRANCH, AND THAT ORDER IS THE POINT (D-076).
    // It used to sit BELOW, so once the live turn's 4-minute budget blew, every remaining window
    // still POSTed its ~12-58MB body to the transcriber and waited out the per-window timeout —
    // the caller's bound was advisory for exactly the branch that does the most work. The guard is
    // now the FIRST thing either engine sees.
    if (signal?.aborted) return null;
    if (fmt === "wav" && readHealth().status === "ok") {
      // The abort signal reaches whisper too. It was omitted, so a blown live budget could not
      // stop an in-flight window — and the timeout is now sized to the WINDOW, because a fixed
      // 120s budget against a 600s window guaranteed a timeout on real audio.
      const t = await transcribeViaWhisper({ buf: b, fetch: fetchImpl, signal, windowSec });
      if (t) return t;   // whisper hiccup → fall through to the LLM path (never lose audio)
      if (signal?.aborted) return null;
    }
    const chosen = await llmModel();
    if (!chosen) return null; // no audio-capable model → graceful fallback
    const base = String(baseUrl || "").replace(/\/+$/, "");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Chain the caller's overall budget onto this window's own timeout: whichever fires first wins.
    const onOuterAbort = () => { try { controller.abort(); } catch { /* already aborted */ } };
    if (signal) { if (signal.aborted) onOuterAbort(); else signal.addEventListener('abort', onOuterAbort, { once: true }); }
    try {
      const res = await fetchImpl(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: chosen,
          stream: false,
          // Always 127.0.0.1 Ollama here (capability-picked local model), which
          // accepts `think` on /v1/chat/completions. Thinking adds minutes of
          // hidden reasoning before a verbatim transcription — disable it.
          think: false,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: TRANSCRIBE_PROMPT },
              { type: "input_audio", input_audio: { data: b.toString("base64"), format: fmt } },
            ],
          }],
        }),
        signal: controller.signal,
      });
      if (!res || !res.ok) return null;
      const data = await res.json().catch(() => null);
      const t = String(data?.choices?.[0]?.message?.content || "").trim();
      return t.length ? t : null;
    } catch {
      return null; // timeout / decode error / model error → caller falls back
    } finally {
      clearTimeout(timer);
      try { signal?.removeEventListener?.('abort', onOuterAbort); } catch { /* noop */ }
      // Each completed window IS real progress — the heartbeat source for a live decode's lease.
      try { onProgress?.({ window: true }); } catch { /* a heartbeat must never break a decode */ }
    }
  };

  // OGG (Telegram voice) — llama.cpp's audio loader rejects Ogg outright
  // (live-verified 2026-06-10), so transcode to WAV in-process. Decode into WAV
  // WINDOWS and transcribe each, rejoining in full: a long voice note is no
  // longer cut at the old 900s decode / 8000-char output bounds, and peak memory
  // stays bounded to one window. A short note yields exactly ONE window → the
  // common path is unchanged. If decode yields nothing usable, fall through and
  // try the ORIGINAL ogg bytes via the LLM path (a future decoder may accept them).
  // ⚠️ THE OGG-WINDOW ENGINE DOES NOT RESUME. It always decodes from 0 and reports `startSec: 0`,
  // which the caller correctly reads as "REPLACE, do not append". No production caller passes
  // `startSec` on this path today (only the Whisper stream resumes), but a future one would get a
  // silent full re-decode, so the limitation is stated rather than left to be discovered
  // (adversarial review round 2, LOW-7).
  if (format === "ogg") {
    const { oggOpusToWavChunks, AudioDecodeTruncatedError } = await import("./ogg-opus.js");
    const { stitchTranscript } = await import("./transcript-coverage.js");
    let joined = "";
    let coveredSec = 0, decodedSec = 0, windows = 0, done = 0;
    // ⚠️ PER-WINDOW ACCOUNTING — a skipped window used to vanish (D-076). The old loop was
    // `if (t) parts.push(t)` followed by `join(" ")`, so ONE failed window in the middle of a
    // 30-minute note produced a transcript that read CONTINUOUSLY across a 10-minute hole. There
    // was no marker, no fault, no count. A hole is now a recorded GAP, which forces coverage
    // incomplete and makes the row resumable — the text is never doctored with placeholder
    // characters (that would pollute the owner's content), the STATE carries the truth.
    const gaps = [];
    let truncated = null;
    try {
      for await (const w of oggOpusToWavChunks(buf, { signal })) {
        windows += 1;
        decodedSec = Math.max(decodedSec, w.endSec);
        const windowSec = Math.max(0, w.endSec - w.startSec);
        const t = await transcribeOne(w.wav, "wav", { windowSec });
        if (t) {
          // Windows OVERLAP by design (ogg-opus.js), so the seam is de-duplicated rather than
          // blind-joined: an overlap makes every word whole in at least one window, and this
          // removes the resulting duplicate.
          joined = joined ? stitchTranscript(joined, t) : t.trim();
          coveredSec = w.endSec;
          done += 1;
        } else {
          gaps.push([w.startSec, w.endSec]);
          // ⚠️ BREAKING OUT OF A for-await SKIPS THE GENERATOR'S TRUNCATION THROW — its `finally`
          // runs but the `throw` after the yield loop does not. That is safe HERE only because this
          // break is guarded by `signal.aborted` AND preceded by the `gaps.push` above, each of
          // which independently forces `complete:false` below. A future `break` without that
          // pairing would silently inherit the hole (adversarial review round 2, LOW-5).
          if (signal?.aborted) break;
        }
        try { onSegment?.({ start: w.startSec, end: w.endSec, text: t || '' }, joined, { coveredSec, durationSec: decodedSec, segments: done, startSec: 0 }); } catch { /* non-fatal */ }
        // ⚠️ THE TICKET HEARTBEAT, AND IT WAS NEVER FIRING ON THIS PATH (second adversarial review,
        // MEDIUM-4). `onProgress` was only invoked in the LLM branch's `finally` inside
        // transcribeOne — so when whisper handled the window (the branch that actually runs in
        // production) it returned before that, and this loop never called it either. A completed
        // window IS real progress (design §5: heartbeats come from progress, never a timer), and it
        // is what re-arms an INTERACTIVE lease during a long decode. Measured at 0 calls across 13
        // windows before this line existed.
        try { onProgress?.({ coveredSec, durationSec: decodedSec, segments: done, window: true }); } catch { /* a heartbeat must never break a decode */ }
      }
    } catch (e) {
      if (e instanceof AudioDecodeTruncatedError) {
        // The decoder ran out of budget / hit its ceiling / stalled. It used to return NORMALLY
        // here and the prefix was stored as the whole recording.
        truncated = e.reason;
        decodedSec = Math.max(decodedSec, Number(e.secondsDecoded) || 0);
      } else { throw e; }
    }
    if (truncated) fault('audio-truncated', truncated);
    else if (gaps.length) fault('window-failed', `${gaps.length}/${windows}`);
    else if (signal?.aborted) fault('canceled');
    // ⚠️ ONLY REPORT IF THIS ENGINE ACTUALLY RAN. `windows === 0` means the opus decoder produced
    // nothing and execution FALLS THROUGH to the single-shot path below, which owns its own record.
    // Reporting unconditionally here published a verdict about a decode that never happened
    // (second adversarial review, HIGH-2): with the old first-write-wins latch it permanently
    // marked a perfectly good single-shot transcription incomplete, on exactly the configuration
    // the drain cannot recover (an audio-capable Ollama and no Whisper service).
    if (windows > 0) reportCoverage({
      coveredSec,
      // ⚠️ 0 MEANS "NOT MEASURED", AND THAT IS THE HONEST VALUE ON A TRUNCATED DECODE. `decodedSec`
      // is the length of what we DECODED, not of the recording — so on a 30-minute file cut at five
      // minutes it equals `coveredSec`, and the portal rendered a truncated row as 100 % covered
      // (adversarial review round 2, LOW-6). We do not know the true duration here; say so.
      durationSec: truncated ? 0 : decodedSec,
      segments: done, startSec: 0, engine: 'ogg-window',
      // Complete ONLY when the decoder ran to the end AND every window produced text AND nothing
      // was cancelled. Anything else leaves the attachment resumable.
      complete: !truncated && !gaps.length && !signal?.aborted && windows > 0,
      gaps,
    });
    if (joined.length) return clampStored(joined);
    if (windows > 0) return null;   // decode worked, transcription did not — do NOT retry raw ogg
  }

  const text = await transcribeOne(buf, format);
  // ⚠️ THE SINGLE-SHOT PATH CAN NEVER CLAIM COMPLETENESS — it has no evidence of any kind.
  // The whole file goes into ONE /v1/chat/completions call and whatever the model returns is the
  // answer: no segment stream, no `done` sentinel, no duration, no coverage. An audio-capable LLM
  // handed a 30-minute m4a routinely returns a truncated or summarized transcription, and this
  // branch cannot tell that from a faithful one. An earlier draft reported
  // `complete: Boolean(text)` — "we got some text" as a positive assertion of completeness — which
  // is precisely the inference D-076 is about, and it would have SUPPRESSED the drain that could
  // later redo the file properly once Whisper is available (adversarial review, HIGH-3).
  // Fail closed (§3): report INCOMPLETE with an honest reason. A row that stays resumable is
  // recoverable; a row falsely marked complete is not.
  reportCoverage({
    coveredSec: 0, durationSec: 0, segments: text ? 1 : 0, startSec: 0,
    engine: 'single-shot', complete: false, fault: 'unverified-engine', gaps: [],
  });
  if (!text) fault('no-text');
  return text ? clampStored(text) : null;
}

/**
 * POST the WAV to the local Whisper service. Same NEVER-throw contract:
 * any failure → null → the caller's LLM fallback runs.
 * @param {{buf: Buffer, fetch: typeof fetch, timeoutMs?: number}} a
 */
async function transcribeViaWhisper({ buf, fetch: fetchImpl, signal, windowSec = 0, timeoutMs = Number(process.env.MYCELIUM_WHISPER_TIMEOUT_MS) || 120000 }) {
  // ⚠️ SIZE THE BUDGET TO THE AUDIO, NOT TO A CONSTANT (D-076). A flat 120 s cap was applied to
  // 600 s windows: on real CPU-int8 whisper that is a guaranteed timeout, so the window "failed",
  // was silently skipped by the caller's old `if (t)` join, and 10 minutes of speech disappeared.
  // 4× realtime is a generous floor for CPU int8; the constant remains the minimum.
  const budgetMs = Math.max(timeoutMs, Math.round((Number(windowSec) || 0) * 4000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  // Chain the caller's overall budget: a blown live-turn bound must actually stop an in-flight POST.
  const onOuterAbort = () => { try { controller.abort(); } catch { /* already aborted */ } };
  if (signal) { if (signal.aborted) onOuterAbort(); else signal.addEventListener('abort', onOuterAbort, { once: true }); }
  try {
    const res = await fetchImpl(`${transcribeServiceUrl()}/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: buf,
      signal: controller.signal,
    });
    if (!res || !res.ok) return null;
    const data = await res.json().catch(() => null);
    const text = String(data?.text || "").trim();
    return text.length ? text : null; // RAW — caller clamps once after rejoining windows
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    try { signal?.removeEventListener?.('abort', onOuterAbort); } catch { /* noop */ }
  }
}

export default transcribeAudio;
