// Upload core (transport-agnostic). Composes the encrypted blob store + the
// attachments db namespace: file bytes → encrypted blob on disk → attachments
// row. Optionally links the upload to a message (attachment_id) so it appears
// in the conversation stream.
//
// Bytes are encrypted at rest by the blob store (mind-files envelope). The
// attachments ROW is encrypted at the db layer for file_name/description/
// transcript/metadata (ENCRYPTED_FIELDS.attachments); file_type/file_size stay
// plaintext (accepted metadata leak, for listing). local_path is a random-uuid
// storage key — no content, safe in plaintext.
//
// Text extraction (transcript/description via Whisper/vision/PDF) is the
// enrichment unit's job and is Tier-2-gated (needs local models): we store the
// blob now with transcript=null, and enrichment fills it later.
import { extname } from 'node:path';
import { putBlob } from './blob-store.js';
import { captureMessage } from './capture.js';

/**
 * Store an uploaded file. Returns { attachmentId, localPath, size, messageId? }.
 * @param {object} db                wired db namespace (needs attachments [+ messages if linking])
 * @param {object} args
 * @param {string} args.userId
 * @param {Buffer} args.bytes        the raw file bytes
 * @param {string} [args.fileName]
 * @param {string} [args.fileType]   MIME or short type label
 * @param {boolean} [args.asMessage] also create a linked message in the stream
 * @param {(id:string)=>void} [enqueueEnrichment]
 */
export async function uploadAttachment(db, args, enqueueEnrichment) {
  if (!db?.attachments) throw new TypeError('uploadAttachment: db.attachments required');
  const userId = args?.userId;
  if (typeof userId !== 'string' || !userId) throw new Error('uploadAttachment: userId is required');
  if (!Buffer.isBuffer(args.bytes) || args.bytes.length === 0) {
    throw new Error('uploadAttachment: non-empty file bytes are required');
  }

  const ext = args.fileName ? extname(args.fileName) : '';
  const { path: localPath, size } = await putBlob(args.bytes, { userId, ext });

  const row = await db.attachments.insert({
    user_id: userId,
    file_name: args.fileName || null,
    file_type: args.fileType || null,
    file_size: size,
    local_path: localPath,
  });
  const attachmentId = row?.id;

  let messageId;
  if (args.asMessage) {
    const { id } = await captureMessage(db, {
      userId,
      content: args.fileName ? `[uploaded ${args.fileName}]` : '[uploaded file]',
      source: 'upload',
      attachmentId,
    }, enqueueEnrichment);
    messageId = id;
  }

  return { attachmentId, localPath, size, messageId };
}
