/**
 * qwen — LOCAL, on-box Text-to-Speech (Qwen3-TTS, MLX runtime). The zero-egress
 * counterpart to local Whisper transcription: no API key, no cloud, audio never
 * leaves 127.0.0.1. Replaces the removed `kokoro` provider — Qwen3-TTS won the
 * live listening test (design §0/§2).
 *
 * ── CONFINEMENT (why the daemon does NOT hit :8094 directly) ─────────────────
 * The cloned voice's identity is a FROZEN reference sample that is ENCRYPTED at
 * rest with the vault master key (src/tts/voice-sample-store.js). This channel
 * daemon runs CONFINED, WITHOUT that key, so it cannot decrypt the sample and
 * therefore cannot supply the `ref_audio` the MLX service needs — a direct
 * :8094 call would always answer 501 "voice-sample-pending" (R3-TTSVOICE root
 * cause). Instead the daemon POSTs the line to the vault's OWNER-authenticated
 * loopback render endpoint; the VAULT (which HAS the key) decrypts the sample
 * in-memory, renders on the MLX service it owns, and returns ONLY the finished
 * WAV. The master key and the decrypted sample NEVER cross to this process.
 *
 *   Endpoint: POST ${vault}/api/v1/internal/voice-render   (src/internal-router.js)
 *   Body:     { text, instruct? }        (agentId is PINNED to 'personal-agent'
 *                                          vault-side; the daemon can't pick it)
 *   Returns:  24kHz mono s16le WAV bytes  → format 'wav'
 *             (the Node side encodes Telegram-spec OGG/Opus in pure JS — no
 *              ffmpeg, per V1's principle)
 *   Honest states surfaced from the vault (fail-soft, text still delivered):
 *     501 → 'voice-sample-pending'          (no frozen sample authored yet)
 *     503 → 'render-service-unavailable'    (MLX down / not Apple Silicon /
 *                                            model not downloaded)
 *
 * Config (env, from the secrets table via bootstrap):
 *   QWEN_TTS_ENABLED           '1' to allow this provider (the per-box opt-in)
 *   QWEN_TTS_VARIANT           optional — the selected model VARIANT id (Qwen has
 *                              no preset voices; the voice IS the frozen sample)
 *   MYCELIUM_API_URL           vault REST base (no trailing /api/v1); defaults to
 *                              http://127.0.0.1:8787 — same seam vault-client uses
 *   MYCELIUM_VOICE_RENDER_URL  optional — full override of the render-endpoint URL
 */

import { TTSProviderError } from '../errors.js';

const QWEN_TTS_TIMEOUT_MS = 180_000;   // MLX is slower than realtime (RTF ~1.25, design §2.1)

// The vault's loopback render endpoint the confined daemon POSTs to. Mirrors the
// vault-base resolution the vault-client uses (config.js), so a single
// MYCELIUM_API_URL / MYCELIUM_REST_* setting configures both. An explicit
// MYCELIUM_VOICE_RENDER_URL wins (test seam + unusual deployments).
function renderUrl() {
  if (process.env.MYCELIUM_VOICE_RENDER_URL) return process.env.MYCELIUM_VOICE_RENDER_URL;
  const base = process.env.MYCELIUM_API_URL
    || `http://${process.env.MYCELIUM_REST_HOST || '127.0.0.1'}:${process.env.MYCELIUM_REST_PORT || 8787}`;
  return `${base.replace(/\/+$/, '')}/api/v1/internal/voice-render`;
}
function getDefaultVoice() { return process.env.QWEN_TTS_VARIANT || ''; }

export const qwenProvider = {
  name: 'qwen',
  // Qwen handles long text but quality + latency are best in sentence-ish chunks;
  // the chunking layer splits above this.
  maxChars: 1000,

  get defaultVoice() { return getDefaultVoice(); },

  // Opt-in per box. The vault may still report the sample pending / service down —
  // all handled fail-soft in synthesize(); isConfigured stays cheap.
  isConfigured() {
    return process.env.QWEN_TTS_ENABLED === '1';
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

    // The confined daemon holds NO key/sample — it sends ONLY the line (+ optional
    // owner modulation) and lets the vault clone the frozen sample behind loopback.
    const body = { text };
    if (opts.instruct) body.instruct = opts.instruct;

    let resp;
    try {
      resp = await fetch(renderUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (cause) {
      throw new TTSProviderError({ provider: 'qwen', code: 'network', body: `vault voice-render unreachable: ${cause.message}`, cause });
    }
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      // Surface the vault's honest states so the caller drops the voice reply and
      // delivers text, never a fabricated audio. 501 = no frozen sample yet;
      // 503 = MLX service down / not Apple Silicon / model not downloaded.
      const code = resp.status === 501 ? 'voice-sample-pending'
        : resp.status === 503 ? 'render-service-unavailable'
        : undefined;
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
