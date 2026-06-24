/**
 * Telegram egress chokepoint — now a thin adapter over the platform-agnostic
 * core (egress/send-handler.js). Preserves the original createTelegramChokepoint
 * API (sendToTelegram + the shared gate deps) so callers/tests are unchanged.
 *
 * Telegram specifics: target = chatId, content = text, kind by '-' prefix
 * (group vs DM). Discord registers its own adapter the same way.
 */
import { createSendHandler } from './egress/send-handler.js';

/** chatId starting with '-' is a group/supergroup; everything else is a DM. */
function inferKind(chatId) {
  return String(chatId).startsWith('-') ? 'telegram-group' : 'telegram';
}

export function createTelegramChokepoint(deps) {
  const { sendToTelegram, ...rest } = deps || {};
  if (typeof sendToTelegram !== 'function') throw new TypeError('chokepoint: sendToTelegram required');
  return createSendHandler({
    ...rest,
    adapter: {
      platform: 'telegram',
      contentField: 'text',
      targetField: 'chatId',
      sourceModule: 'channel-daemon.telegram',
      inferKind,
      send: ({ target, content, replyToMessageId }) => sendToTelegram({ chatId: target, text: content, replyToMessageId }),
    },
  });
}
