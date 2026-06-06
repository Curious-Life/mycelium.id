/**
 * Discord message → normalized inbound (same shape as the Telegram normalizer,
 * so the inbound pipeline + turnCtx are uniform). Reads fields defensively off a
 * discord.js Message OR a plain test object, so it's unit-testable without
 * discord.js.
 *
 * The send target on Discord is the CHANNEL id (DMs included), so chatId =
 * channelId. Bot-authored messages are flagged so the handler can drop them
 * (avoid loops).
 */
export function normalizeDiscordMessage(m) {
  if (!m || m.channelId == null) return null;
  const author = m.author || {};
  return {
    messageId: String(m.id),
    chatId: String(m.channelId),
    chatType: m.guildId ? 'guild' : 'dm',
    source: 'discord',
    channelKind: 'discord',
    content: typeof m.content === 'string' ? m.content : '',
    voiceMode: false, // inbound discord voice notes: not transcribed (Phase later)
    fromId: author.id != null ? String(author.id) : null,
    username: author.username || null,
    fromName: author.globalName || author.username || null,
    chatTitle: m.guild?.name || null,
    replyToMessageId: m.reference?.messageId != null ? String(m.reference.messageId) : (m.referenced_message?.id != null ? String(m.referenced_message.id) : null),
    dateEpoch: m.createdTimestamp ? Math.floor(m.createdTimestamp / 1000) : null,
    isBot: !!author.bot,
    guildId: m.guildId != null ? String(m.guildId) : null,
  };
}
