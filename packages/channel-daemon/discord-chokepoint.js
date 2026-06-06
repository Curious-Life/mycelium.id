/**
 * Discord egress chokepoint — a thin adapter over the platform-agnostic core
 * (egress/send-handler.js). All gates (authority, dedup, rate-limit, audit,
 * voice, provenance) are SHARED with Telegram; only the field names + send call
 * differ. This is the payoff of the send-handler refactor.
 *
 * Discord specifics: target = channelId, content = content, kind = 'discord'.
 * (Thread support → 'discord-thread' is a later refinement.)
 */
import { createSendHandler } from './egress/send-handler.js';

export function createDiscordChokepoint(deps) {
  const { sendToDiscord, ...rest } = deps || {};
  if (typeof sendToDiscord !== 'function') throw new TypeError('discord-chokepoint: sendToDiscord required');
  return createSendHandler({
    ...rest,
    adapter: {
      platform: 'discord',
      contentField: 'content',
      targetField: 'channelId',
      sourceModule: 'channel-daemon.discord',
      inferKind: () => 'discord',
      send: ({ target, content, replyToMessageId }) => sendToDiscord({ channelId: target, content, replyToMessageId }),
    },
  });
}
