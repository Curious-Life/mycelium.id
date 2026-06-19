/**
 * Inbound media stage — download a message's attachment from Telegram, hand the
 * bytes to the vault (encrypted blob + attachments row), derive turn-visible
 * text (LOCAL vision caption / transcription / file decode, vault-side), and
 * fold the result into the message content.
 *
 * Security invariants (docs/CHANNEL-INBOUND-MEDIA-DESIGN-2026-06-10.md):
 *   - runs ONLY after authorization (inbound.js) — unauthorized chats' media
 *     is never even downloaded;
 *   - bytes live in daemon MEMORY only, then cross loopback to the vault's
 *     fail-closed encrypted blob store; nothing is written to daemon disk;
 *   - no media content in logs (kind/size/duration only);
 *   - every step is FAIL-SOFT: any failure degrades to a placeholder line and
 *     the text turn proceeds — media can never block or crash an inbound.
 *
 * The derived context is appended to msg.content (not metadata) because content
 * is the ONLY field that survives the coalescer and is what the lane hands the
 * agent as userMessage.
 */

const KIND_LABEL = { photo: 'Image', document: 'File', voice: 'Voice note', audio: 'Audio' };

function fmtSize(n) {
  if (typeof n !== 'number' || !(n >= 0)) return null;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  if (n >= 1024) return `${Math.round(n / 1024)}KB`;
  return `${n}B`;
}

function fmtDuration(s) {
  if (typeof s !== 'number' || !(s >= 0)) return null;
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
}

/** The bracketed line the agent (and the vault stream) sees for an attachment. */
export function mediaContextLine(media, contextText, { fetched = true, tooLarge = false } = {}) {
  const label = KIND_LABEL[media.kind] || 'File';
  const name = media.fileName ? `: ${media.fileName}` : '';
  const dur = media.kind === 'voice' || media.kind === 'audio' ? fmtDuration(media.duration) : null;
  const head = `${label}${name}${dur ? ` (${dur})` : ''}`;

  if (tooLarge) return `[${head} — ${fmtSize(media.fileSize) || 'too large'} exceeds the import limit; not stored]`;
  if (!fetched) return `[${head} — could not be fetched]`;
  if (!contextText) {
    return media.kind === 'voice' || media.kind === 'audio'
      ? `[${head} attached — transcription unavailable]`
      : `[${head} attached]`;
  }
  if (media.kind === 'voice' || media.kind === 'audio') return `[${head} — transcript: "${contextText}"]`;
  if (media.kind === 'photo') return `[${head} attached — ${contextText}]`;
  return `[${head} attached — content:\n${contextText}]`;
}

/** Map a media kind (+ mime) to the attachment-context extraction kind. */
function contextKindOf(media) {
  if (media.kind === 'photo') return 'image';
  if (media.kind === 'voice' || media.kind === 'audio') return 'audio';
  return undefined; // document → let the vault classify by mime/extension
}

/**
 * Download + store + contextualize one message's media. Never throws.
 * @param {object} msg   NormalizedInbound with .media set
 * @param {object} deps
 * @param {{getFile:Function}} deps.telegram
 * @param {{uploadAttachment:Function, attachmentContext:Function}} deps.vault
 * @param {number} [deps.maxBytes]
 * @param {string} [deps.logPrefix]
 * @returns {Promise<{attachmentId:string|null, contextLine:string}>}
 */
export async function contextualizeMedia(msg, { telegram, vault, maxBytes = 20 * 1024 * 1024, logPrefix = 'channel-daemon' }) {
  const media = msg.media;

  // Size gate BEFORE download (descriptor size is advisory; getFile re-checks).
  if (typeof media.fileSize === 'number' && media.fileSize > maxBytes) {
    console.log(`[${logPrefix}] media skipped (too large): kind=${media.kind} size=${media.fileSize} chat=${msg.chatId}`);
    return { attachmentId: null, contextLine: mediaContextLine(media, null, { tooLarge: true }) };
  }

  let bytes;
  try {
    bytes = await telegram.getFile({ fileId: media.fileId, maxBytes });
  } catch (e) {
    if (e?.code === 'FILE_TOO_LARGE') {
      return { attachmentId: null, contextLine: mediaContextLine(media, null, { tooLarge: true }) };
    }
    console.error(`[${logPrefix}] media download failed (kind=${media.kind} chat=${msg.chatId}): ${e.message}`);
    return { attachmentId: null, contextLine: mediaContextLine(media, null, { fetched: false }) };
  }

  const fileName = media.fileName
    || `${media.kind}-${msg.messageId}${media.kind === 'photo' ? '.jpg' : media.kind === 'voice' ? '.ogg' : ''}`;
  const stored = await vault.uploadAttachment(bytes, { fileName, fileType: media.mimeType || undefined });
  if (!stored) {
    return { attachmentId: null, contextLine: mediaContextLine(media, null, { fetched: false }) };
  }

  const contextText = await vault.attachmentContext({ attachmentId: stored.attachmentId, kind: contextKindOf(media) });
  console.log(`[${logPrefix}] media stored: kind=${media.kind} bytes=${bytes.length} extracted=${contextText ? contextText.length : 0} chat=${msg.chatId}`);
  return { attachmentId: stored.attachmentId, contextLine: mediaContextLine(media, contextText) };
}

export default contextualizeMedia;
