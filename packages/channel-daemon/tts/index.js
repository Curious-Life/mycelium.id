/**
 * @mycelium/core/tts — pluggable TTS provider layer.
 *
 * Two public entrypoints, one per chat-platform output shape:
 *
 *   synthesizeForTelegram(text, opts)   async generator yielding per-chunk
 *                                       audio files (Telegram sends one
 *                                       voice message per chunk)
 *
 *   synthesizeForDiscord(text, opts)    returns single concat'd buffer +
 *                                       waveform + duration (Discord
 *                                       voice messages are one file)
 *
 * Both wrap: stripMarkdownForTTS → splitTextForTTS (provider-aware
 * maxChars) → provider.synthesize per chunk → ffmpeg post-processing.
 *
 * Failures propagate as TTSError with structured {sent, total,
 * partialSuccess, errors[]} — the same discipline we now apply to
 * Telegram sendReply (Apr 24 2026 lesson). Callers that want a
 * text-only fallback should catch and decide.
 *
 * Usage:
 *   import * as tts from '@mycelium/core/tts/index.js';
 *
 *   if (!tts.isEnabled()) return;  // text-only mode
 *
 *   for await (const chunk of tts.synthesizeForTelegram(text, { agentId })) {
 *     if (!chunk.ok) continue;     // already logged
 *     await ctx.replyWithVoice(new InputFile(chunk.path));
 *     await chunk.cleanup();
 *   }
 *
 *   const { buffer, waveform, durationSecs } =
 *     await tts.synthesizeForDiscord(text, { agentId });
 */

import { rm, mkdtemp, writeFile, stat } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

import { stripMarkdownForTTS } from './shared/markdown.js';
import { splitTextForTTS } from './shared/chunking.js';
import { remuxToTelegramSpec, concatOggBuffers } from './shared/remux.js';
import { wavToOggOpus } from './shared/wav-to-ogg-opus.js';
import { generateWaveform } from './shared/waveform.js';

/**
 * Encode a WAV buffer (from the local kokoro provider) to a Telegram-spec
 * OGG/Opus file using the PURE-JS encoder — no ffmpeg (V1 principle). Returns
 * the same { path, dir, size } shape as remuxToTelegramSpec, or null so the
 * caller can fall back to the ffmpeg path.
 */
async function encodeWavToOgg(wav) {
  const ogg = wavToOggOpus(wav);
  if (!ogg) return null;
  const dir = await mkdtemp(join(tmpdir(), 'tts-'));
  const path = join(dir, 'out.ogg');
  await writeFile(path, ogg);
  const { size } = await stat(path);
  return { path, dir, size };
}

import { resolveProvider, resolveVoice, isEnabled, getConfig } from './config.js';
import { TTSError, TTSDisabledError, TTSProviderError } from './errors.js';

export { isEnabled, getConfig };
export { TTSError, TTSDisabledError, TTSProviderError };
export {
  OPENAI_VOICES, OPENAI_MODELS, ELEVENLABS_MODELS,
  OPENAI_VOICE_IDS, OPENAI_MODEL_IDS, ELEVENLABS_MODEL_IDS,
} from './voices.js';

// Default upper bound on speakable text (matches today's Telegram bot
// behavior: long messages get truncated rather than rejected). Discord's
// previous limit was 6000 — use platform-specific defaults below.
export const TELEGRAM_DEFAULT_MAX_TEXT_CHARS = 50_000;
export const DISCORD_DEFAULT_MAX_TEXT_CHARS  = 6_000;

// Minimum bytes per chunk after remux. Below this we treat the chunk as
// failed (provider returned an error wrapped in tiny audio). Matches
// today's Telegram bot 1000-byte threshold.
const MIN_CHUNK_BYTES = 1000;

/**
 * Async generator that yields one record per text chunk. The bot consumes
 * each yield in order, sends the audio, and calls cleanup() to remove the
 * temp dir.
 *
 * Yields:
 *   { ok: true,  index, total, path, dir, size, voiceUsed, cleanup }
 *   { ok: false, index, total, error, code }
 *
 * After all chunks finish, if zero succeeded the generator throws
 * TTSError so the caller can fall back to text-only.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.agentId]
 * @param {string} [opts.voice]                        explicit voice override
 * @param {number} [opts.maxTextChars=TELEGRAM_DEFAULT_MAX_TEXT_CHARS]
 * @param {(text: string) => string} [opts.preprocess=stripMarkdownForTTS]
 */
export async function* synthesizeForTelegram(text, opts = {}) {
  const {
    agentId,
    voice,
    maxTextChars = TELEGRAM_DEFAULT_MAX_TEXT_CHARS,
    preprocess = stripMarkdownForTTS,
  } = opts;

  const provider = resolveProvider();
  if (!provider) throw new TTSDisabledError('no provider configured');

  const cleanText = preprocess(text || '');
  if (!cleanText || cleanText.length < 20) return;

  const ttsText = cleanText.substring(0, maxTextChars);
  const chunks = splitTextForTTS(ttsText, provider.maxChars);
  const total = chunks.length;
  const errors = [];
  let sent = 0;
  const voiceToUse = voice || resolveVoice(provider, agentId);

  for (let i = 0; i < total; i++) {
    let result = null;
    let remuxed = null;
    try {
      result = await provider.synthesize(chunks[i], voiceToUse, { agentId });
      if (!result?.audio || result.audio.length === 0) {
        throw new TTSProviderError({
          provider: provider.name,
          code: 'invalid_audio',
          body: `Provider returned empty audio for chunk ${i + 1}/${total}`,
        });
      }

      // Local provider returns WAV → encode OGG/Opus in PURE JS (no ffmpeg).
      // Cloud opus/mp3, or a pure-JS encode miss, fall back to the ffmpeg remux
      // (itself fail-soft to raw audio when ffmpeg is absent).
      if (result.format === 'wav') remuxed = await encodeWavToOgg(result.audio);
      if (!remuxed) {
        remuxed = await remuxToTelegramSpec(result.audio, {
          inputExt: result.format === 'mp3' ? '.mp3' : result.format === 'wav' ? '.wav' : '.ogg',
        });
      }

      if (remuxed.size < MIN_CHUNK_BYTES) {
        await rm(remuxed.dir, { recursive: true, force: true }).catch(() => {});
        throw new TTSProviderError({
          provider: provider.name,
          code: 'invalid_audio',
          body: `Remuxed chunk ${i + 1}/${total} too small (${remuxed.size}B)`,
        });
      }

      sent++;
      yield {
        ok: true,
        index: i,
        total,
        path: remuxed.path,
        dir: remuxed.dir,
        size: remuxed.size,
        voiceUsed: result.voiceUsed,
        cleanup: () => rm(remuxed.dir, { recursive: true, force: true }).catch(() => {}),
      };
    } catch (err) {
      const code = err instanceof TTSProviderError ? err.code : 'unknown';
      errors.push({ chunk: i + 1, total, error: err.message, code });
      yield { ok: false, index: i, total, error: err.message, code };
      if (remuxed?.dir) await rm(remuxed.dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  if (sent === 0 && total > 0) {
    throw new TTSError({ provider: provider.name, sent: 0, total, errors });
  }
}

/**
 * Synthesize a single concat'd audio buffer + waveform for Discord voice
 * messages. If any chunk fails, the function still returns a result for
 * the chunks that succeeded — but throws TTSError if zero chunks succeed.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.agentId]
 * @param {string} [opts.voice]
 * @param {number} [opts.maxTextChars=DISCORD_DEFAULT_MAX_TEXT_CHARS]
 * @param {number} [opts.bytesPerSecond=5600]    duration estimate; default
 *                                               matches OpenAI tts-1-hd
 *                                               Opus rate.
 * @param {(text: string) => string} [opts.preprocess=stripMarkdownForTTS]
 *
 * @returns {Promise<{
 *   buffer: Buffer,
 *   waveform: string,
 *   durationSecs: number,
 *   voiceUsed: string,
 *   provider: string,
 *   sent: number,
 *   total: number,
 *   partialSuccess: boolean,
 *   errors: Array<{chunk: number, total: number, error: string, code: string}>
 * }>}
 */
export async function synthesizeForDiscord(text, opts = {}) {
  const {
    agentId,
    voice,
    maxTextChars = DISCORD_DEFAULT_MAX_TEXT_CHARS,
    bytesPerSecond = 5600,
    preprocess = stripMarkdownForTTS,
  } = opts;

  const provider = resolveProvider();
  if (!provider) throw new TTSDisabledError('no provider configured');

  const cleanText = preprocess(text || '');
  if (!cleanText) {
    throw new TTSError({
      provider: provider.name,
      sent: 0,
      total: 0,
      errors: [{ error: 'No speakable text after markdown stripping' }],
      code: 'empty_input',
    });
  }

  const ttsText = cleanText.substring(0, maxTextChars);
  const chunks = splitTextForTTS(ttsText, provider.maxChars);
  const total = chunks.length;
  const audioChunks = [];
  const errors = [];
  let voiceUsed = voice || resolveVoice(provider, agentId);

  for (let i = 0; i < total; i++) {
    try {
      const result = await provider.synthesize(chunks[i], voiceUsed, { agentId });
      if (!result?.audio || result.audio.length === 0) {
        throw new TTSProviderError({
          provider: provider.name,
          code: 'invalid_audio',
          body: `Provider returned empty audio for chunk ${i + 1}/${total}`,
        });
      }
      voiceUsed = result.voiceUsed;
      audioChunks.push(result.audio);
    } catch (err) {
      const code = err instanceof TTSProviderError ? err.code : 'unknown';
      errors.push({ chunk: i + 1, total, error: err.message, code });
    }
  }

  const sent = audioChunks.length;
  if (sent === 0) {
    throw new TTSError({ provider: provider.name, sent: 0, total, errors });
  }

  const buffer = audioChunks.length === 1
    ? audioChunks[0]
    : await concatOggBuffers(audioChunks);

  const durationSecs = Math.max(0.1, buffer.length / bytesPerSecond);
  const waveform = generateWaveform(buffer, 256);

  return {
    buffer,
    waveform,
    durationSecs,
    voiceUsed,
    provider: provider.name,
    sent,
    total,
    partialSuccess: sent < total,
    errors,
  };
}
