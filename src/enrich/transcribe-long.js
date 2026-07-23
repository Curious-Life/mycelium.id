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
 * @returns {Promise<string|null>}
 */
export async function transcribeLongAudio({
  bytes, format = 'wav', language = null, onSegment, onProgress,
  fetch: fetchImpl = globalThis.fetch, signal,
  getHealth = getTranscriberHealth, // injectable for tests
  onFault,
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
      body: JSON.stringify({ path: file, language: language || undefined }),
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
      return null;
    }

    const parts = [];
    let durationSec = 0, coveredSec = 0, n = 0, buf = '';
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
        if (ev.type === 'meta') { durationSec = Number(ev.duration) || 0; }
        else if (ev.type === 'segment') {
          const text = String(ev.text || '').trim();
          if (text) parts.push(text);
          coveredSec = Number(ev.end) || coveredSec; n += 1;
          const assembled = parts.join(' ');
          if (onSegment) { try { await onSegment({ start: ev.start, end: ev.end, text }, assembled); } catch { /* non-fatal */ } }
          if (onProgress) { try { onProgress({ coveredSec, durationSec, segments: n }); } catch { /* */ } }
        } else if (ev.type === 'error') {
          // faster-whisper blew up MID-STREAM (a decode failure on a long container, an
          // OOM, a corrupt tail). Whatever text we already have is real and is kept —
          // but the fault is reported either way, so a PARTIAL transcript is not silently
          // presented as a complete one.
          fault('engine-error', ev.error || null);
          return parts.length ? parts.join(' ').trim() : null;
        }
        // 'done' → loop ends when the stream closes
      }
    }
    const full = parts.join(' ').trim();
    if (!full.length) fault('no-speech');   // the stream completed and carried no words — a REAL, distinct outcome
    return full.length ? full : null;
  } catch (e) {
    // An abort is the timeoutMs cap or the caller's signal; anything else is a transport
    // failure (the service died mid-stream). Distinct reasons — a 2h cap and a crashed
    // service need different words and only one of them is worth retrying immediately.
    const aborted = e?.name === 'AbortError' || ctrl.signal.aborted;
    fault(aborted ? (signal?.aborted ? 'canceled' : 'timeout') : 'transport-error', aborted ? null : e?.message);
    return null;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    if (dir) { try { await rm(dir, { recursive: true, force: true }); } catch { /* */ } }
  }
}

export default transcribeLongAudio;
