/**
 * Voice pipeline — bridges the harvested TTS module (tts/) to the Telegram
 * sendVoice upload. Runs AFTER the text is delivered, so it is strictly
 * fail-soft: any synthesis/upload failure is logged and the (already-sent) text
 * reply stands. This mirrors the canonical telegram-bot voice path exactly
 * (per-chunk synth → sendVoice → cleanup), minus Grammy.
 */
import * as tts from './tts/index.js';

/**
 * @param {object} deps
 * @param {(a:{chatId:any,filePath:string,replyToMessageId?:any})=>Promise<any>} deps.sendVoice
 * @param {string} [deps.agentId]
 * @param {string} [deps.logPrefix]
 */
export function createVoicePipeline({ sendVoice, agentId, logPrefix = 'channel-daemon' }) {
  if (typeof sendVoice !== 'function') throw new TypeError('createVoicePipeline: sendVoice required');

  return {
    isEnabled: () => tts.isEnabled(),

    /** Synthesize + upload voice notes for `text`. Never throws. */
    async deliver({ chatId, text, replyToMessageId }) {
      if (!tts.isEnabled()) return { enabled: false, voiceSent: 0, voiceTotal: 0 };
      let voiceSent = 0;
      let voiceTotal = 0;
      try {
        for await (const chunk of tts.synthesizeForTelegram(text, { agentId })) {
          voiceTotal = chunk.total;
          if (!chunk.ok) {
            console.warn(`[${logPrefix}] TTS chunk ${chunk.index + 1}/${chunk.total} failed (${chunk.code})`);
            continue;
          }
          try {
            // reply-to only on the first voice note (matches the text path)
            await sendVoice({ chatId, filePath: chunk.path, replyToMessageId: chunk.index === 0 ? replyToMessageId : undefined });
            voiceSent++;
          } catch (e) {
            console.error(`[${logPrefix}] voice upload failed (chunk ${chunk.index + 1}/${chunk.total}): ${e.message}`);
          } finally {
            await chunk.cleanup();
          }
        }
      } catch (e) {
        // TTSError (all chunks failed) / TTSDisabledError — text already delivered.
        console.warn(`[${logPrefix}] voice synthesis failed (text was delivered): ${e.message}`);
      }
      return { enabled: true, voiceSent, voiceTotal };
    },
  };
}
