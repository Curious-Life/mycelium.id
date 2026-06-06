/**
 * openai — direct call to OpenAI's Text-to-Speech API. The path managed
 * customers use when they bring their own OPENAI_API_KEY. Avoids routing
 * the customer's API key through our Worker / Cloudflare.
 *
 *   Endpoint: POST https://api.openai.com/v1/audio/speech
 *   Auth:     Authorization: Bearer ${OPENAI_API_KEY}
 *   Body:     { model, input, voice, response_format }
 *   Returns:  raw audio bytes
 *
 * Configurable via env (loaded from D1 secrets via bootstrap-secrets):
 *   OPENAI_API_KEY     required
 *   OPENAI_TTS_MODEL   optional, default 'tts-1-hd'  (matches admin parity)
 *                                                   alternatives:
 *                                                   - 'tts-1' (cheaper, faster)
 *                                                   - 'gpt-4o-mini-tts' (steerable)
 *   OPENAI_TTS_VOICE   optional, default 'onyx'
 */

import { TTSProviderError } from '../errors.js';
import { OPENAI_VOICE_IDS as VALID_VOICES, OPENAI_MODEL_IDS as VALID_MODELS } from '../voices.js';

const OPENAI_TTS_TIMEOUT_MS = 120_000;
const OPENAI_TTS_URL = 'https://api.openai.com/v1/audio/speech';

function getApiKey()  { return process.env.OPENAI_API_KEY || ''; }
function getModel()   { return process.env.OPENAI_TTS_MODEL || 'tts-1-hd'; }
function getDefaultVoice() { return process.env.OPENAI_TTS_VOICE || 'onyx'; }

/**
 * Validate model/voice strings before they reach the API. Both are
 * concatenated into JSON body so injection risk is low, but we validate
 * to fail-fast on typos and to avoid wasted API calls.
 */
function validateModel(model) {
  if (!VALID_MODELS.has(model)) {
    throw new TTSProviderError({
      provider: 'openai',
      code: 'invalid_input',
      body: `Unknown OPENAI_TTS_MODEL: ${model}. Valid: ${[...VALID_MODELS].join(', ')}`,
    });
  }
}

function validateVoice(voice) {
  if (!VALID_VOICES.has(voice)) {
    throw new TTSProviderError({
      provider: 'openai',
      code: 'invalid_input',
      body: `Unknown voice: ${voice}. Valid: ${[...VALID_VOICES].join(', ')}`,
    });
  }
}

export const openAIProvider = {
  name: 'openai',
  maxChars: 4096,

  get defaultVoice() { return getDefaultVoice(); },

  isConfigured() {
    return Boolean(getApiKey());
  },

  /**
   * @param {string} text
   * @param {string} voice
   * @param {import('./_interface.js').TTSCallOpts} [opts]
   * @returns {Promise<import('./_interface.js').TTSCallResult>}
   */
  async synthesize(text, voice, opts = {}) {
    const apiKey = getApiKey();
    if (!apiKey) {
      throw new TTSProviderError({
        provider: 'openai',
        code: 'auth',
        body: 'OPENAI_API_KEY not set',
      });
    }

    const model = getModel();
    const voiceUsed = voice || this.defaultVoice;
    validateModel(model);
    validateVoice(voiceUsed);

    const timeoutMs = opts.timeoutMs ?? OPENAI_TTS_TIMEOUT_MS;
    const signal = opts.signal ?? AbortSignal.timeout(timeoutMs);

    let resp;
    try {
      resp = await fetch(OPENAI_TTS_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          input: text,
          voice: voiceUsed,
          response_format: 'opus',
        }),
        signal,
      });
    } catch (cause) {
      throw new TTSProviderError({
        provider: 'openai',
        code: 'network',
        body: cause.message,
        cause,
      });
    }

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new TTSProviderError({
        provider: 'openai',
        status: resp.status,
        body,
      });
    }

    const audio = Buffer.from(await resp.arrayBuffer());
    return {
      audio,
      format: 'opus',
      voiceUsed,
      bytesIn: text.length,
      bytesOut: audio.length,
    };
  },
};
