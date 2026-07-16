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
 * @returns {Promise<string|null>}
 */
export async function transcribeLongAudio({
  bytes, format = 'wav', language = null, onSegment, onProgress,
  fetch: fetchImpl = globalThis.fetch, signal,
  getHealth = getTranscriberHealth, // injectable for tests
  timeoutMs = Number(process.env.MYCELIUM_WHISPER_LONG_TIMEOUT_MS) || 2 * 60 * 60 * 1000,
} = {}) {
  if (!bytes || !bytes.length) return null;
  // Only when a Whisper model is actually ready (else the caller's LLM fallback runs).
  try { if (getHealth()?.status !== 'ok') return null; } catch { return null; }

  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) { if (signal.aborted) return null; signal.addEventListener('abort', onAbort, { once: true }); }
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
    if (!res || !res.ok || !res.body) return null;

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
        } else if (ev.type === 'error') { return parts.length ? parts.join(' ').trim() : null; }
        // 'done' → loop ends when the stream closes
      }
    }
    const full = parts.join(' ').trim();
    return full.length ? full : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    if (dir) { try { await rm(dir, { recursive: true, force: true }); } catch { /* */ } }
  }
}

export default transcribeLongAudio;
