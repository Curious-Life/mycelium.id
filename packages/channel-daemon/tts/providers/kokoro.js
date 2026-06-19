/**
 * kokoro — LOCAL, on-box Text-to-Speech (Kokoro-82M via the loopback
 * kokoro-service.py). The zero-egress counterpart to the local Whisper
 * transcription: no API key, no cloud, audio never leaves 127.0.0.1.
 *
 *   Endpoint: POST http://127.0.0.1:${KOKORO_TTS_PORT}/tts
 *   Body:     { text, voice, speed }
 *   Returns:  24kHz mono s16le WAV bytes  → format 'wav'
 *             (the Node side encodes Telegram-spec OGG/Opus in pure JS via
 *              src/audio/wav-to-ogg-opus.js — no ffmpeg, per V1's principle)
 *
 * Config (env, from the secrets table via bootstrap):
 *   KOKORO_TTS_ENABLED   '1' to allow this provider (the per-box opt-in)
 *   KOKORO_TTS_PORT      optional, default 8094
 *   KOKORO_TTS_URL       optional, overrides the loopback base url
 *   KOKORO_TTS_VOICE     optional, default 'af_heart'
 */

import { TTSProviderError } from '../errors.js';

const KOKORO_TTS_TIMEOUT_MS = 120_000;

function baseUrl() {
  return process.env.KOKORO_TTS_URL || `http://127.0.0.1:${process.env.KOKORO_TTS_PORT || 8094}`;
}
function getDefaultVoice() { return process.env.KOKORO_TTS_VOICE || 'af_heart'; }

export const kokoroProvider = {
  name: 'kokoro',
  // Kokoro handles long text but quality + latency are best in sentence-ish
  // chunks; the chunking layer splits above this.
  maxChars: 1000,

  get defaultVoice() { return getDefaultVoice(); },

  // Opt-in per box. The service may still be warming up / model absent — that's
  // handled fail-soft in synthesize(); isConfigured stays cheap (no network).
  isConfigured() {
    return process.env.KOKORO_TTS_ENABLED === '1' || Boolean(process.env.KOKORO_TTS_URL);
  },

  /**
   * @param {string} text
   * @param {string} voice
   * @param {import('./_interface.js').TTSCallOpts} [opts]
   * @returns {Promise<import('./_interface.js').TTSCallResult>}
   */
  async synthesize(text, voice, opts = {}) {
    const voiceUsed = voice || this.defaultVoice;
    const timeoutMs = opts.timeoutMs ?? KOKORO_TTS_TIMEOUT_MS;
    const signal = opts.signal ?? AbortSignal.timeout(timeoutMs);

    let resp;
    try {
      resp = await fetch(`${baseUrl()}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: voiceUsed, speed: Number(process.env.KOKORO_TTS_SPEED) || 1.0 }),
        signal,
      });
    } catch (cause) {
      throw new TTSProviderError({ provider: 'kokoro', code: 'network', body: `local TTS service unreachable: ${cause.message}`, cause });
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new TTSProviderError({ provider: 'kokoro', status: resp.status, body: body.slice(0, 200) });
    }
    const audio = Buffer.from(await resp.arrayBuffer());
    return {
      audio,
      format: 'wav',          // → Node encodes OGG/Opus pure-JS (no ffmpeg)
      voiceUsed,
      bytesIn: text.length,
      bytesOut: audio.length,
    };
  },
};
