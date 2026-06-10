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
 * @property {MediaDescriptor|null} media  downloadable attachment, when present
 *
 * @typedef {object} MediaDescriptor
 * @property {'photo'|'document'|'voice'|'audio'} kind
 * @property {string} fileId        Telegram file_id (getFile input)
 * @property {string|null} fileUniqueId  stable per-file id (dedup/GC)
 * @property {string|null} fileName
 * @property {string|null} mimeType
 * @property {number|null} fileSize bytes (size-gate BEFORE download)
 * @property {number|null} duration seconds (voice/audio)
 */

/**
 * Extract the downloadable attachment from a raw Telegram message, if any.
 * Photos arrive as a PhotoSize[] (ascending) — take the LARGEST under the cap;
 * the cap itself is enforced by the media stage (descriptor carries fileSize).
 * Stickers / video / video notes / location stay unhandled (no descriptor).
 */
function mediaOf(m) {
  if (Array.isArray(m.photo) && m.photo.length) {
    const best = m.photo[m.photo.length - 1];
    if (best?.file_id) {
      return {
        kind: 'photo', fileId: best.file_id, fileUniqueId: best.file_unique_id || null,
        fileName: null, mimeType: 'image/jpeg',
        fileSize: typeof best.file_size === 'number' ? best.file_size : null, duration: null,
      };
    }
  }
  if (m.voice?.file_id) {
    return {
      kind: 'voice', fileId: m.voice.file_id, fileUniqueId: m.voice.file_unique_id || null,
      fileName: null, mimeType: m.voice.mime_type || 'audio/ogg',
      fileSize: typeof m.voice.file_size === 'number' ? m.voice.file_size : null,
      duration: typeof m.voice.duration === 'number' ? m.voice.duration : null,
    };
  }
  if (m.audio?.file_id) {
    return {
      kind: 'audio', fileId: m.audio.file_id, fileUniqueId: m.audio.file_unique_id || null,
      fileName: m.audio.file_name || null, mimeType: m.audio.mime_type || null,
      fileSize: typeof m.audio.file_size === 'number' ? m.audio.file_size : null,
      duration: typeof m.audio.duration === 'number' ? m.audio.duration : null,
    };
  }
  if (m.document?.file_id) {
    return {
      kind: 'document', fileId: m.document.file_id, fileUniqueId: m.document.file_unique_id || null,
      fileName: m.document.file_name || null, mimeType: m.document.mime_type || null,
      fileSize: typeof m.document.file_size === 'number' ? m.document.file_size : null, duration: null,
    };
  }
  return null;
}

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
    media: mediaOf(m),
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
