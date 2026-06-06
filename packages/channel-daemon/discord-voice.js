/**
 * Discord voice pipeline — bridges the harvested TTS module's Discord shape
 * (synthesizeForDiscord → ONE concatenated buffer + waveform + durationSecs) to
 * the Discord REST voice-message upload. Mirrors the canonical /discord/send-voice.
 *
 * Fail-soft: runs AFTER the text is delivered, so any synthesis/upload failure is
 * logged and the text reply stands. Same `deliver({target,text,replyToMessageId})`
 * shape the send-handler core calls, so it drops into the chokepoint's voice slot.
 */
import * as tts from './tts/index.js';

/**
 * @param {object} deps
 * @param {(a:{channelId:any,audio:Buffer,waveform:string,durationSecs:number,replyToMessageId?:any})=>Promise<any>} deps.sendVoice
 * @param {string} [deps.agentId]
 * @param {string} [deps.logPrefix]
 */
export function createDiscordVoicePipeline({ sendVoice, agentId, logPrefix = 'channel-daemon' }) {
  if (typeof sendVoice !== 'function') throw new TypeError('createDiscordVoicePipeline: sendVoice required');
  return {
    isEnabled: () => tts.isEnabled(),
    async deliver({ target, text, replyToMessageId }) {
      if (!tts.isEnabled()) return { enabled: false, voiceSent: 0, voiceTotal: 0 };
      try {
        const { buffer, waveform, durationSecs } = await tts.synthesizeForDiscord(text, { agentId });
        await sendVoice({ channelId: target, audio: buffer, waveform, durationSecs, replyToMessageId });
        return { enabled: true, voiceSent: 1, voiceTotal: 1 };
      } catch (e) {
        console.warn(`[${logPrefix}] discord voice synthesis failed (text delivered): ${e.message}`);
        return { enabled: true, voiceSent: 0, voiceTotal: 1 };
      }
    },
  };
}
