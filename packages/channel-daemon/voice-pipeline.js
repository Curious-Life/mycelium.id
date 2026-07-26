/**
 * Voice pipeline — bridges the harvested TTS module (tts/) to the Telegram
 * sendVoice upload. Runs AFTER the text is delivered, so it is strictly
 * fail-soft: any synthesis/upload failure leaves the (already-sent) text reply
 * standing. This mirrors the canonical telegram-bot voice path exactly
 * (per-chunk synth → sendVoice → cleanup), minus Grammy.
 *
 * HONESTY (QA6-VOICE): fail-soft must never mean SILENT. `deliver()` returns a
 * structured verdict — { enabled, voiceSent, voiceTotal, ok, code } — and the
 * chokepoint turns a zero-send verdict into an explicit "voice unavailable"
 * notice to the user (send-handler.js). A code is a short machine token
 * ('voice-sample-pending', 'render-service-unavailable', 'upload-failed', …);
 * it NEVER carries provider text, transcript text, or audio bytes (§1).
 */
import * as tts from './tts/index.js';

/** Map a TTS error/chunk code onto the short, user-safe reason token. */
function reasonFor(code) {
  switch (code) {
    case 'voice-sample-pending': return 'voice-sample-pending';
    case 'render-service-unavailable': return 'render-service-unavailable';
    // The SPECIFIC vault reasons (D-003 ↻2). These used to all arrive as an
    // undefined code and collapse into 'render-failed', which is why three QA
    // cycles could not tell the actual residual failure apart from any other.
    case 'voice-runtime-missing': return 'voice-runtime-missing';
    case 'voice-model-unavailable': return 'voice-model-unavailable';
    case 'voice-synth-failed': return 'voice-synth-failed';
    case 'voice-sample-unreadable': return 'voice-sample-unreadable';
    case 'auth': return 'voice-provider-auth';
    case 'rate_limited': return 'voice-provider-rate-limited';
    case 'network': return 'render-service-unreachable';
    case 'server': return 'render-failed';
    case 'invalid_audio': return 'render-produced-no-audio';
    case 'tts_disabled': return 'voice-disabled';
    default: return 'render-failed';
  }
}

/**
 * @param {object} deps
 * @param {(a:{target:any,filePath:string,replyToMessageId?:any,messageThreadId?:any})=>Promise<any>} deps.sendVoice
 * @param {string} [deps.agentId]
 * @param {string} [deps.logPrefix]
 * @param {()=>boolean} [deps.isEnabled]  override the TTS-enabled probe (tests)
 */
export function createVoicePipeline({ sendVoice, agentId, logPrefix = 'channel-daemon', isEnabled }) {
  if (typeof sendVoice !== 'function') throw new TypeError('createVoicePipeline: sendVoice required');
  const enabled = typeof isEnabled === 'function' ? isEnabled : () => tts.isEnabled();

  return {
    isEnabled: () => enabled(),

    /** Synthesize + upload voice notes for `text`. Never throws. */
    async deliver({ target, text, replyToMessageId, messageThreadId }) {
      if (!enabled()) return { enabled: false, ok: false, voiceSent: 0, voiceTotal: 0, code: 'voice-disabled' };
      let voiceSent = 0;
      let voiceTotal = 0;
      let code = null;
      try {
        for await (const chunk of tts.synthesizeForTelegram(text, { agentId })) {
          voiceTotal = chunk.total;
          if (!chunk.ok) {
            // Log the CODE only — never the provider body (it can echo the line).
            console.warn(`[${logPrefix}] TTS chunk ${chunk.index + 1}/${chunk.total} failed (${chunk.code})`);
            code = code || reasonFor(chunk.code);
            continue;
          }
          try {
            // reply-to only on the first voice note (matches the text path); the
            // forum topic (message_thread_id) rides every note so voice lands in-topic.
            await sendVoice({ target, filePath: chunk.path, replyToMessageId: chunk.index === 0 ? replyToMessageId : undefined, messageThreadId });
            voiceSent++;
          } catch (e) {
            console.error(`[${logPrefix}] voice upload failed (chunk ${chunk.index + 1}/${chunk.total}): ${e.code || e.httpStatus || 'error'}`);
            code = code || (e?.code === 'voice-too-large' ? 'voice-too-large' : 'upload-failed');
          } finally {
            await chunk.cleanup();
          }
        }
      } catch (e) {
        // TTSError (all chunks failed) / TTSDisabledError — text already delivered.
        // Codes only (§1): a provider message can quote the synthesized line.
        console.warn(`[${logPrefix}] voice synthesis failed (text was delivered): ${e?.code || e?.name || 'error'}`);
        code = code || reasonFor(e?.errors?.[0]?.code || e?.code);
      }
      // A synthesis that produced NOTHING (empty/short text → generator returns
      // with total 0) is not a failure the user needs to hear about.
      const nothingToSay = voiceTotal === 0 && !code;
      return {
        enabled: true,
        ok: voiceSent > 0 || nothingToSay,
        voiceSent,
        voiceTotal,
        code: voiceSent > 0 ? null : (nothingToSay ? null : (code || 'render-failed')),
      };
    },
  };
}

/**
 * Voice-reply POLICY — the answer to "should THIS reply be spoken?".
 *
 * The break this closes (QA6-VOICE): before it, the ONLY producer of `voice`
 * was the model choosing to pass `voice: true` to the `reply` tool. Nothing
 * told it voice was switched on, so `send-handler`'s `if (voice && …)` was
 * never true and `sendVoice` was never called — the owner turned voice ON in
 * Settings and no voice note ever arrived. The toggle is now consulted at
 * REPLY TIME, in the chokepoint, on every reply.
 *
 * The toggle IS the Voice setting (Settings → Voice picks a provider; the
 * qwen/openai/elevenlabs `isConfigured()` chain is what `tts.isEnabled()`
 * reads). `CHANNEL_VOICE_REPLIES` refines it WITHOUT unconfiguring TTS:
 *   'always' (default) — every channel reply is also spoken
 *   'auto'             — spoken only when the inbound message was a voice note
 *   'off'              — never spoken (an explicit reply(voice:true) still wins)
 */
export function resolveVoiceReplyMode(env = process.env) {
  const raw = String(env.CHANNEL_VOICE_REPLIES || '').trim().toLowerCase();
  return (raw === 'off' || raw === 'auto' || raw === 'always') ? raw : 'always';
}

/**
 * @param {object} deps
 * @param {()=>boolean} deps.isEnabled          TTS-enabled probe (the Settings toggle)
 * @param {()=>object|null} [deps.getActiveTurn] active inbound turn (for 'auto')
 * @returns {()=>boolean}
 */
export function createVoiceReplyPolicy({ isEnabled, getActiveTurn = () => null } = {}) {
  return function voiceReplyDefault() {
    // Fail-closed: TTS off ⇒ no voice. This is the toggle.
    try { if (typeof isEnabled !== 'function' || !isEnabled()) return false; } catch { return false; }
    const mode = resolveVoiceReplyMode();
    if (mode === 'off') return false;
    if (mode === 'auto') { try { return !!getActiveTurn()?.voiceMode; } catch { return false; } }
    return true;
  };
}
