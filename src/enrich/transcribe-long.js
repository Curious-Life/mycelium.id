// src/enrich/transcribe-long.js — robust LONG-audio transcription via the local
// Whisper service's streaming /transcribe-file endpoint.
//
// The short-note path (transcribe-audio.js /transcribe) is WAV-only + one-shot and
// chokes on a 45-min m4a. This path writes the (already-DECRYPTED, in-memory) audio to
// a 0600 temp file, hands the PATH to the service (faster-whisper decodes ANY container
// via PyAV + VAD-segments long audio natively), and consumes the NDJSON stream so each
// segment can be SAVED PROGRESSIVELY (onSegment) — nothing is lost if interrupted.
//
// SECURITY (§1): the decrypted audio exists only as a 0600 temp file for the job's
// duration, deleted in `finally`. Never logs content. Loopback-only (node ↔ :8093).

import { writeFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transcribeServiceUrl, getTranscriberHealth } from '../transcribe/supervisor.js';
import { redactDaemonDetail } from '../hardware/ollama-daemon.js';

const EXT_FOR = { ogg: 'ogg', mp3: 'mp3', wav: 'wav', m4a: 'm4a', webm: 'webm', flac: 'flac' };

/**
 * Transcribe long audio via the streaming service. Returns the full assembled text,
 * or null (no model / failure) so the caller can fall back. NEVER throws.
 *
 * @param {object} o
 * @param {Buffer} o.bytes               decrypted audio bytes (any container)
 * @param {string} [o.format]            'm4a'|'mp3'|'ogg'|'wav'|… (for the temp extension)
 * @param {string} [o.language]          force a language, else auto-detect
 * @param {(seg:{start:number,end:number,text:string}, all:string)=>Promise<void>|void} [o.onSegment]
 *                                        called per segment with the assembled-so-far text (progressive save)
 * @param {(p:{coveredSec:number,durationSec:number,segments:number})=>void} [o.onProgress]
 * @param {typeof fetch} [o.fetch]
 * @param {AbortSignal} [o.signal]
 * @param {number} [o.timeoutMs]         overall cap (default 2h — a background job)
 * @param {(reason:string, detail?:string|null)=>void} [o.onFault]
 *        WHY this returned null. See the LOSSY-NULL note below — the return type is
 *        unchanged (callers still fall back on null), this is the out-channel for the
 *        reason that used to be thrown away.
 * @param {number} [o.startSec=0]  RESUME OFFSET in seconds. The service skips this much audio and
 *        the timestamps reported here are made ABSOLUTE again by adding it back, so a partially
 *        transcribed recording finishes only its MISSING tail instead of re-decoding 30 minutes.
 * @param {(c:{coveredSec:number,durationSec:number,segments:number,complete:boolean,startSec:number})=>void} [o.onCoverage]
 *        Called EXACTLY ONCE before returning, on every path that reached the stream.
 *        `complete === true` is an ASSERTION THAT WAS EARNED — see the DONE SENTINEL note below.
 * @returns {Promise<string|null>}
 */
export async function transcribeLongAudio({
  bytes, format = 'wav', language = null, onSegment, onProgress,
  fetch: fetchImpl = globalThis.fetch, signal,
  getHealth = getTranscriberHealth, // injectable for tests
  onFault,
  startSec = 0,
  onCoverage,
  timeoutMs = Number(process.env.MYCELIUM_WHISPER_LONG_TIMEOUT_MS) || 2 * 60 * 60 * 1000,
} = {}) {
  // ── THE LOSSY NULL (QA6 P1 §2 root cause) ──────────────────────────────────
  // This function had ONE failure value — `null` — for at least seven distinct causes:
  // no bytes, a not-ready model, a 503 deps_missing, a 409 no_model, a 400 "path not
  // allowed" (the TMPDIR-mismatch class), a 500 load-failed, a mid-stream {type:'error'}
  // from faster-whisper, and an abort/timeout. Every one of them arrived at the owner
  // as the same blank "unavailable" with no reason and nothing to press. `fault()` is
  // the out-channel: the return type is unchanged (so every existing fallback still
  // works), but the CAUSE now survives the call. `detail` is a service string (an HTTP
  // status or faster-whisper's own error), never audio and never vault content (§1).
  // §1 REDACT before it leaves this function. `detail` carries a SERVICE-supplied string —
  // faster-whisper's own error (`ev.error`) or a transport exception message (`e?.message`) — and
  // those can embed a temp PATH (…/myc-tx-XXXX/audio.m4a) or, worse, a credential-shaped token. The
  // Ollama side scrubs the identical class via redactDaemonDetail; apply the SAME redactor here so the
  // owner-facing job state can never carry a raw path or secret (the transcription side was leaking it
  // unredacted while the daemon side did not). Then cap length, exactly as before.
  const fault = (reason, detail = null) => { try { onFault?.(reason, detail ? redactDaemonDetail(String(detail)).slice(0, 200) : null); } catch { /* a reporter must never break the job */ } };

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  THE DONE SENTINEL — why EOF was never evidence of completion (D-076, the primary bug)
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // This loop used to end when the response body closed, and treat whatever it had as the whole
  // transcript. That is unsound at the WIRE level, not merely optimistic: the service replies
  // HTTP/1.0 `Connection: close` with NO Content-Length and NO chunked framing
  // (pipeline/transcribe-service.py — `send_response(200)` + `end_headers()` then raw writes), so
  // "the body ended" and "the body was cut off" are the SAME BYTES. undici has nothing to raise on.
  // A python OOM-kill on a 30-minute file, a transcriber-supervisor restart, a broken pipe, or a
  // loopback reset all produced a clean EOF — and a prefix of the recording was stored, marked
  // `done` in the activity feed, and returned as `{ok:true}` by the caller.
  //
  // The service DOES emit `{"type":"done","segments":n}` as its last line. That sentinel is the
  // only positive evidence that faster-whisper's segment generator ran to exhaustion. So:
  // `complete` REQUIRES the sentinel. No sentinel ⇒ 'stream-truncated', text kept, row resumable.
  //
  // ⚠️ AND WHY COMPLETENESS IS *NOT* `coveredSec >= durationSec`: VAD legitimately emits no
  // segment for trailing silence, so a recording that ends quietly covers less than its duration
  // while being perfectly complete. Gating on the ratio would mark such files incomplete FOREVER
  // and make the drain re-transcribe them on every cycle. Coverage is recorded and reported (it is
  // what a resume needs), but the sentinel is what earns `complete`.
  let sawDone = false;
  let durationSec = 0, coveredSec = 0, n = 0;
  let coverageSent = false;
  const offset = Number.isFinite(Number(startSec)) && Number(startSec) > 0 ? Number(startSec) : 0;
  // ⚠️ COVERAGE REPORTS THE **HONOURED** OFFSET, NEVER THE REQUESTED ONE. The caller uses this value
  // to decide whether the returned text CONTINUES the stored transcript or REPLACES it. Reporting
  // the requested offset would make a service that silently ignored `start` look like a resume, and
  // its full re-transcribe would then be stitched onto the existing partial — duplicating minutes of
  // speech. `honoredOffset` is set ONLY from the service's own `meta.offset` echo.
  let honoredOffset = 0;
  const reportCoverage = (complete) => {
    if (coverageSent) return;
    coverageSent = true;
    try { onCoverage?.({ coveredSec, durationSec, segments: n, complete, startSec: honoredOffset }); } catch { /* a reporter must never break the job */ }
  };

  if (!bytes || !bytes.length) { fault('empty-audio'); return null; }
  // Only when a Whisper model is actually ready (else the caller's LLM fallback runs).
  // The STATUS is carried out verbatim — "loading" and "deps_missing" are not the same
  // thing as "you never downloaded a model", which is what every caller used to say.
  try {
    const h = getHealth();
    if (h?.status !== 'ok') { fault('not-ready', h?.status || 'unknown'); return null; }
  } catch { fault('not-ready', 'health-read-failed'); return null; }

  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) { if (signal.aborted) { fault('canceled'); return null; } signal.addEventListener('abort', onAbort, { once: true }); }
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  timer.unref?.();

  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'myc-tx-'));
    const file = join(dir, `audio.${EXT_FOR[format] || 'bin'}`);
    await writeFile(file, bytes, { mode: 0o600 });

    const res = await fetchImpl(`${transcribeServiceUrl()}/transcribe-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `start` is the RESUME OFFSET. Omitted (not sent as 0) when there is nothing to resume, so
      // an older transcribe-service that does not know the field behaves exactly as before.
      body: JSON.stringify({ path: file, language: language || undefined, start: offset || undefined }),
      signal: ctrl.signal,
    });
    // A NON-2xx IS A REASON, NOT A BLANK. The service answers 503 deps_missing, 409
    // no_model, 400 "path not allowed" (the TMPDIR-mismatch class) and 500 load-failed
    // — all of which used to collapse into the same `null`. Read the body's `error`
    // token (a fixed service enum, never content) and carry it out.
    if (!res || !res.ok || !res.body) {
      let code = null;
      try { code = (await res?.json?.())?.error ?? null; } catch { /* no readable body — the status alone is the reason */ }
      fault('service-error', code ? `${res?.status ?? '?'}:${code}` : `http-${res?.status ?? 'no-response'}`);
      reportCoverage(false);
      return null;
    }

    const parts = [];
    let buf = '';
    // ⚠️ RESUME NEGOTIATION, FAIL-SAFE BY DEFAULT. A transcribe-service that predates the `start`
    // field simply ignores it and transcribes the WHOLE file. Blindly adding `offset` to those
    // timestamps — and stitching that full transcript onto the prior partial — would duplicate
    // minutes of speech. So the service ECHOES the offset it honoured in `meta.offset`, and this is
    // the only value trusted for absolute time. `honoredOffset === 0` while `offset > 0` therefore
    // means "you got a full re-transcribe", which the caller detects from coverage.startSec and
    // treats as a REPLACEMENT rather than a continuation. Old service ⇒ correct, just not resumable.
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'meta') {
          durationSec = Number(ev.duration) || 0;
          // ⚠️ THE ECHO IS VALIDATED AGAINST WHAT WE ASKED FOR (§2 defense in depth, §3 fail closed).
          // This value decides BOTH how much audio is considered covered AND whether the caller
          // stitches or replaces — accepting it unchecked from another process means a service that
          // echoes an offset LARGER than requested makes us skip audio and still earn `complete`,
          // leaving a silent hole no drain will ever revisit (adversarial review, MEDIUM-4). An
          // echo we did not ask for means "I don't know what that service did" → fall back to 0,
          // which is the safe branch (treat as a full re-transcribe and REPLACE).
          const echoed = Number(ev.offset);
          honoredOffset = Number.isFinite(echoed) && echoed > 0 && echoed <= offset + 0.01 ? echoed : 0;
        } else if (ev.type === 'segment') {
          const text = String(ev.text || '').trim();
          if (text) parts.push(text);
          // Segment timestamps are RELATIVE to the clipped region the service transcribed; make
          // them absolute with the offset the service confirmed it honoured.
          const absEnd = Number(ev.end);
          if (Number.isFinite(absEnd)) coveredSec = honoredOffset + absEnd;
          n += 1;
          const assembled = parts.join(' ');
          if (onSegment) {
            try {
              await onSegment({
                start: Number.isFinite(Number(ev.start)) ? honoredOffset + Number(ev.start) : null,
                end: Number.isFinite(absEnd) ? honoredOffset + absEnd : null,
                text,
              }, assembled, { coveredSec, durationSec, segments: n, startSec: honoredOffset });
            } catch { /* non-fatal */ }
          }
          if (onProgress) { try { onProgress({ coveredSec, durationSec, segments: n }); } catch { /* */ } }
        } else if (ev.type === 'done') {
          // THE ONLY POSITIVE EVIDENCE OF COMPLETION. See the DONE SENTINEL note at the top.
          sawDone = true;
        } else if (ev.type === 'error') {
          // faster-whisper blew up MID-STREAM (a decode failure on a long container, an
          // OOM, a corrupt tail). Whatever text we already have is real and is kept —
          // but the fault is reported either way, AND coverage is reported INCOMPLETE, so a
          // PARTIAL transcript cannot be presented as a complete one at the call site. (The old
          // comment claimed this already held; it did not — transcribe-attachment.js's `if (full)`
          // branch never consulted the fault. Coverage is what makes the claim true.)
          fault('engine-error', ev.error || null);
          reportCoverage(false);
          return parts.length ? parts.join(' ').trim() : null;
        }
      }
    }
    const full = parts.join(' ').trim();
    if (!sawDone) {
      // EOF WITHOUT THE SENTINEL — the stream was cut, not finished. Keep the text (it is real and
      // it is what a resume builds on) and report the truth.
      fault('stream-truncated', durationSec ? `covered=${Math.round(coveredSec)}s/${Math.round(durationSec)}s` : null);
      reportCoverage(false);
      return full.length ? full : null;
    }
    if (!full.length) fault('no-speech');   // the stream completed and carried no words — a REAL, distinct outcome
    reportCoverage(true);
    return full.length ? full : null;
  } catch (e) {
    // An abort is the timeoutMs cap or the caller's signal; anything else is a transport
    // failure (the service died mid-stream). Distinct reasons — a 2h cap and a crashed
    // service need different words and only one of them is worth retrying immediately.
    const aborted = e?.name === 'AbortError' || ctrl.signal.aborted;
    fault(aborted ? (signal?.aborted ? 'canceled' : 'timeout') : 'transport-error', aborted ? null : e?.message);
    // A cap, a cancel and a dead service are all INCOMPLETE. Segments already handed to onSegment
    // are persisted by the caller, so the row must be marked resumable rather than left looking done.
    reportCoverage(false);
    return null;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    if (dir) { try { await rm(dir, { recursive: true, force: true }); } catch { /* */ } }
  }
}

export default transcribeLongAudio;
