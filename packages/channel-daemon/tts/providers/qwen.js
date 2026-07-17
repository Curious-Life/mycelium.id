/**
 * qwen — LOCAL, on-box Text-to-Speech (Qwen3-TTS via the loopback
 * qwen3-tts-service.py, MLX runtime). The zero-egress counterpart to the local
 * Whisper transcription: no API key, no cloud, audio never leaves 127.0.0.1.
 * Replaces the removed `kokoro` provider — Qwen3-TTS won the live listening test
 * (design §0/§2).
 *
 *   Endpoint: POST http://127.0.0.1:${QWEN_TTS_PORT}/tts
 *   Body:     { text, voice, ref_audio_b64?, ref_text?, instruct? }
 *   Returns:  24kHz mono s16le WAV bytes  → format 'wav'
 *             (the Node side encodes Telegram-spec OGG/Opus in pure JS —
 *              no ffmpeg, per V1's principle)
 *
 * ⚠️ RENDER SEAM (design §2.2): identity lives in a FROZEN reference sample
 *    authored on the character page (design §5, not built yet). Until the daemon
 *    is handed ref_audio_b64 + ref_text, the service answers 501
 *    "voice-sample-pending" and synthesize() throws a TTSProviderError — FAIL-SOFT,
 *    exactly like Kokoro when its model was absent. OpenAI/ElevenLabs stay fully
 *    functional for channel voice in the meantime.
 *
 * Config (env, from the secrets table via bootstrap):
 *   QWEN_TTS_ENABLED   '1' to allow this provider (the per-box opt-in)
 *   QWEN_TTS_PORT      optional, default 8094
 *   QWEN_TTS_URL       optional, overrides the loopback base url
 *   QWEN_TTS_VARIANT   optional — the selected model VARIANT id (Qwen has no
 *                      preset voices; the actual voice is a frozen per-agent
 *                      sample — design §2.5/§5 — threaded via opts when built)
 */

import { TTSProviderError } from '../errors.js';

const QWEN_TTS_TIMEOUT_MS = 180_000;   // MLX is slower than realtime (RTF ~1.25, design §2.1)

function baseUrl() {
  return process.env.QWEN_TTS_URL || `http://127.0.0.1:${process.env.QWEN_TTS_PORT || 8094}`;
}
function getDefaultVoice() { return process.env.QWEN_TTS_VARIANT || ''; }

export const qwenProvider = {
  name: 'qwen',
  // Qwen handles long text but quality + latency are best in sentence-ish chunks;
  // the chunking layer splits above this.
  maxChars: 1000,

  get defaultVoice() { return getDefaultVoice(); },

  // Opt-in per box. The service may still be warming up / model absent / render
  // pending — all handled fail-soft in synthesize(); isConfigured stays cheap.
  isConfigured() {
    return process.env.QWEN_TTS_ENABLED === '1' || Boolean(process.env.QWEN_TTS_URL);
  },

  /**
   * @param {string} text
   * @param {string} voice
   * @param {import('./_interface.js').TTSCallOpts} [opts]
   * @returns {Promise<import('./_interface.js').TTSCallResult>}
   */
  async synthesize(text, voice, opts = {}) {
    const voiceUsed = voice || this.defaultVoice;
    const timeoutMs = opts.timeoutMs ?? QWEN_TTS_TIMEOUT_MS;
    const signal = opts.signal ?? AbortSignal.timeout(timeoutMs);

    // The reference sample (design §5) is threaded through opts when the character
    // page supplies it; absent it the service returns 501 and we fail soft.
    const body = { text, voice: voiceUsed };
    if (opts.refAudioB64 && opts.refText) { body.ref_audio_b64 = opts.refAudioB64; body.ref_text = opts.refText; }
    if (opts.instruct) body.instruct = opts.instruct;

    let resp;
    try {
      resp = await fetch(`${baseUrl()}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (cause) {
      throw new TTSProviderError({ provider: 'qwen', code: 'network', body: `local voice service unreachable: ${cause.message}`, cause });
    }
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      // 501 = the render seam (no frozen sample yet). Surface it clearly; the
      // caller drops the voice reply and delivers text, never a fabricated audio.
      const code = resp.status === 501 ? 'voice-sample-pending' : undefined;
      throw new TTSProviderError({ provider: 'qwen', status: resp.status, code, body: errBody.slice(0, 200) });
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
