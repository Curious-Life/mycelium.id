/**
 * elevenlabs — direct call to ElevenLabs Text-to-Speech.
 *
 *   Endpoint: POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=opus_48000_64
 *   Auth:     xi-api-key: ${ELEVENLABS_API_KEY}
 *   Body:     { text, model_id, voice_settings }
 *   Returns:  audio bytes (OGG/Opus when output_format=opus_*)
 *
 * Why ElevenLabs is its own provider rather than a Worker passthrough:
 *   - Voice cloning + voice library — meaningful for per-agent identity.
 *   - Quality is qualitatively different from OpenAI tts-1-hd.
 *   - Customers bring their own key (cost stays with them).
 *
 * Configurable via env (loaded from D1 secrets via bootstrap-secrets):
 *   ELEVENLABS_API_KEY           required
 *   ELEVENLABS_VOICE_ID          required (no sensible default — voices
 *                                          are user-specific)
 *   ELEVENLABS_MODEL_ID          optional, default 'eleven_turbo_v2_5'
 *                                          (low-latency multilingual;
 *                                          alternatives: eleven_multilingual_v2,
 *                                          eleven_flash_v2_5)
 *   ELEVENLABS_OUTPUT_FORMAT     optional, default 'opus_48000_64'
 *                                          (matches our remux pipeline;
 *                                          mp3_44100_128 also works
 *                                          since ffmpeg auto-detects)
 *
 * Per-agent voice override (consumed by config layer, not here):
 *   ELEVENLABS_VOICE_<AGENT_ID>  e.g. ELEVENLABS_VOICE_PUH=21m00Tcm4Tlv...
 */

import { TTSProviderError } from '../errors.js';

const ELEVENLABS_TTS_TIMEOUT_MS = 120_000;
const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io/v1/text-to-speech';

// Allowlist for voice/model IDs. They go into URL paths and JSON bodies;
// disallow anything that could break out of either context.
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

const VALID_OUTPUT_FORMATS = new Set([
  'mp3_22050_32',  'mp3_44100_32',  'mp3_44100_64',  'mp3_44100_96',
  'mp3_44100_128', 'mp3_44100_192',
  'pcm_16000',     'pcm_22050',     'pcm_24000',     'pcm_44100',
  'opus_48000_32', 'opus_48000_64', 'opus_48000_96', 'opus_48000_128',
  'ulaw_8000',
]);

function getApiKey() { return process.env.ELEVENLABS_API_KEY || ''; }
function getDefaultVoiceId() { return process.env.ELEVENLABS_VOICE_ID || ''; }
function getModelId() { return process.env.ELEVENLABS_MODEL_ID || 'eleven_turbo_v2_5'; }
function getOutputFormat() { return process.env.ELEVENLABS_OUTPUT_FORMAT || 'opus_48000_64'; }

function validateId(label, id) {
  if (!id || !ID_PATTERN.test(id)) {
    throw new TTSProviderError({
      provider: 'elevenlabs',
      code: 'invalid_input',
      body: `Invalid ${label}: ${JSON.stringify(id)} (must match /^[A-Za-z0-9_-]+$/)`,
    });
  }
}

function validateOutputFormat(fmt) {
  if (!VALID_OUTPUT_FORMATS.has(fmt)) {
    throw new TTSProviderError({
      provider: 'elevenlabs',
      code: 'invalid_input',
      body: `Unknown ELEVENLABS_OUTPUT_FORMAT: ${fmt}`,
    });
  }
}

function inferFormat(outputFormat) {
  if (outputFormat.startsWith('opus_')) return 'opus';
  if (outputFormat.startsWith('mp3_')) return 'mp3';
  if (outputFormat.startsWith('pcm_')) return 'wav';   // raw PCM; ffmpeg can wrap
  if (outputFormat.startsWith('ulaw_')) return 'wav';
  return 'opus';
}

export const elevenLabsProvider = {
  name: 'elevenlabs',

  // ElevenLabs accepts up to 5000 chars per request on most plans. We
  // chunk slightly under to leave headroom.
  maxChars: 4500,

  get defaultVoice() { return getDefaultVoiceId(); },

  isConfigured() {
    return Boolean(getApiKey() && getDefaultVoiceId());
  },

  /**
   * @param {string} text
   * @param {string} voice            voice_id (no name lookup — caller
   *                                  passes the ID directly)
   * @param {import('./_interface.js').TTSCallOpts} [opts]
   * @returns {Promise<import('./_interface.js').TTSCallResult>}
   */
  async synthesize(text, voice, opts = {}) {
    const apiKey = getApiKey();
    if (!apiKey) {
      throw new TTSProviderError({
        provider: 'elevenlabs',
        code: 'auth',
        body: 'ELEVENLABS_API_KEY not set',
      });
    }

    const voiceId = voice || this.defaultVoice;
    const modelId = getModelId();
    const outputFormat = getOutputFormat();
    validateId('voice_id', voiceId);
    validateId('model_id', modelId);
    validateOutputFormat(outputFormat);

    const url = `${ELEVENLABS_BASE_URL}/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(outputFormat)}`;
    const timeoutMs = opts.timeoutMs ?? ELEVENLABS_TTS_TIMEOUT_MS;
    const signal = opts.signal ?? AbortSignal.timeout(timeoutMs);

    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/*',
        },
        body: JSON.stringify({
          text,
          model_id: modelId,
        }),
        signal,
      });
    } catch (cause) {
      throw new TTSProviderError({
        provider: 'elevenlabs',
        code: 'network',
        body: cause.message,
        cause,
      });
    }

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new TTSProviderError({
        provider: 'elevenlabs',
        status: resp.status,
        body,
      });
    }

    const audio = Buffer.from(await resp.arrayBuffer());
    return {
      audio,
      format: inferFormat(outputFormat),
      voiceUsed: voiceId,
      bytesIn: text.length,
      bytesOut: audio.length,
    };
  },
};
