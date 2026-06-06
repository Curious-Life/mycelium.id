#!/usr/bin/env node
// smoke:telegram-live — HOST smoke (needs real secrets; NOT a CI gate).
// Proves the Telegram leg end-to-end against api.telegram.org:
//   getMe → sendMessage(owner) → [optional] sendVoice(owner) via the TTS pipeline.
//
// Run on the operator's machine:
//   TELEGRAM_BOT_TOKEN=… OWNER_TELEGRAM_ID=… node scripts/smoke-telegram-live.mjs
//   add --voice (needs ffmpeg + OPENAI_API_KEY or ELEVENLABS_API_KEY) to test voice.
import { createTelegramApi } from '../packages/channel-daemon/telegram-api.js';
import { createVoicePipeline } from '../packages/channel-daemon/voice-pipeline.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
const owner = process.env.OWNER_TELEGRAM_ID;
const wantVoice = process.argv.includes('--voice');

if (!token || !owner) {
  console.error('NO-GO: set TELEGRAM_BOT_TOKEN (from @BotFather) and OWNER_TELEGRAM_ID (your chat id).');
  process.exit(1);
}

const tg = createTelegramApi({ botToken: token });
const stamp = new Date().toISOString();
let ok = true;

try {
  const me = await tg.getMe();
  console.log(`[smoke] getMe → @${me.username} (id ${me.id})`);

  const r = await tg.sendMessage({ chatId: owner, text: `Mycelium channel-daemon smoke ✓ — ${stamp}` });
  console.log(`[smoke] sendMessage → delivered ${r.sent}/${r.total} (http ${r.httpStatus})`);

  if (wantVoice) {
    const vp = createVoicePipeline({ sendVoice: (a) => tg.sendVoice(a) });
    if (!vp.isEnabled()) {
      console.error('[smoke] --voice requested but no TTS provider configured (OPENAI_API_KEY / ELEVENLABS_API_KEY). Skipping voice.');
      ok = false;
    } else {
      const v = await vp.deliver({ chatId: owner, text: 'This is a Mycelium voice smoke test. If you can hear this, text-to-speech works.' });
      console.log(`[smoke] sendVoice → ${v.voiceSent}/${v.voiceTotal} voice notes`);
      if (v.voiceSent < 1) { console.error('[smoke] voice delivered 0 chunks — check ffmpeg on PATH + provider key.'); ok = false; }
    }
  }
} catch (e) {
  console.error(`[smoke] FAILED: ${e.message}`);
  ok = false;
}

console.log(`VERDICT: ${ok ? 'GO' : 'NO-GO'}`);
process.exit(ok ? 0 : 1);
