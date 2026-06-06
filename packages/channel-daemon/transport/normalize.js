/**
 * Telegram update → normalized inbound message.
 *
 * Distilled from the canonical telegram-bot.js inbound path: we keep the fields
 * the vault + the reply target need, and drop everything Grammy-specific. Phase
 * 1 handles text and captions; voice transcription is a later concern (a
 * voice-only message normalizes to content === '' and is skipped by the inbound
 * handler, which logs the skip rather than polluting the vault with a placeholder).
 *
 * @typedef {object} NormalizedInbound
 * @property {string}  messageId     Telegram message_id (string)
 * @property {string}  chatId        chat.id (string) — the send-route target
 * @property {string}  chatType      'private' | 'group' | 'supergroup' | 'channel'
 * @property {string}  source        'telegram' | 'telegram-group'
 * @property {string}  channelKind   'telegram' (DM) | 'telegram-group'
 * @property {string}  content       text or caption ('' when neither)
 * @property {boolean} voiceMode     inbound carried a voice note
 * @property {string|null} fromId    sender user id (string)
 * @property {string|null} username
 * @property {string|null} fromName
 * @property {string|null} chatTitle group/supergroup title
 * @property {string|null} replyToMessageId
 * @property {number|null} dateEpoch Telegram `date` (unix seconds)
 */

/** @returns {NormalizedInbound|null} null when the update carries no message. */
export function normalizeUpdate(update) {
  const m = update?.message;
  if (!m || !m.chat) return null;

  const chatType = m.chat.type || 'private';
  const isGroup = chatType === 'group' || chatType === 'supergroup';
  const content = typeof m.text === 'string' ? m.text
    : typeof m.caption === 'string' ? m.caption
    : '';

  return {
    messageId: String(m.message_id),
    chatId: String(m.chat.id),
    chatType,
    source: isGroup ? 'telegram-group' : 'telegram',
    channelKind: isGroup ? 'telegram-group' : 'telegram',
    content,
    voiceMode: !!m.voice,
    fromId: m.from?.id != null ? String(m.from.id) : null,
    username: m.from?.username || null,
    fromName: [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ') || null,
    chatTitle: m.chat.title || null,
    replyToMessageId: m.reply_to_message?.message_id != null ? String(m.reply_to_message.message_id) : null,
    dateEpoch: typeof m.date === 'number' ? m.date : null,
  };
}

/** The largest update_id in a batch (for computing the next getUpdates offset). */
export function maxUpdateId(updates) {
  let max = -1;
  for (const u of updates) {
    if (typeof u?.update_id === 'number' && u.update_id > max) max = u.update_id;
  }
  return max;
}
