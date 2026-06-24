// src/streams/assemble-messages.js — the ONE message read-assembly used by BOTH
// GET /portal/messages and the unified Streams river (db.streams.feed). Factored
// out so the two can't drift: the river's message rows are byte-identical to the
// legacy timeline's.
//
// Security (CLAUDE.md §1): `metadata` is STRIPPED from every projected row — it
// holds triage decisions / dedupe nonces / delivery state that must never leak
// past the read path. Attachment fields are decrypted at the adapter like any
// read. Fail-soft: an attachment lookup error degrades to text-only, never an
// empty feed. The selectTimeline projection is already vector-free (no
// embedding_768) — src/db/messages.js.

import { mediaTypeOf } from '../portal-attachments.js';

/**
 * Join attachments + strip metadata for a batch of selectTimeline rows.
 * @param {Array<object>} rows  rows from db.messages.selectTimeline
 * @param {{ db: object, userId: string }} ctx
 * @returns {Promise<Array<object>>} timeline messages (metadata-free, attachment-joined)
 */
export async function assembleTimelineMessages(rows, { db, userId }) {
  let attMap = new Map();
  try {
    const ids = [...new Set(rows.map((m) => m.attachment_id).filter(Boolean))];
    if (ids.length && db.attachments?.getByIds) {
      const atts = await db.attachments.getByIds(ids, userId);
      attMap = new Map((atts || []).map((a) => [a.id, {
        type: mediaTypeOf(a.file_type),
        url: `/api/v1/portal/attachments/${a.id}/file`,
        filename: a.file_name || null,
        fileSize: a.file_size ?? null,
        description: a.description || null,
        transcript: a.transcript || null,
      }]));
    }
  } catch { /* text-only fallback */ }
  return rows.map(({ metadata, ...m }) => ({
    ...m,
    ...(m.attachment_id && attMap.has(m.attachment_id) ? { attachment: attMap.get(m.attachment_id) } : {}),
  }));
}
