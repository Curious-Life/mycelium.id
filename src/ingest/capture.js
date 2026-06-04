// captureMessage — the single choke-point for "any message that comes in is saved".
//
// Every ingestion path (the captureMessage MCP tool, the /ingest/message HTTP
// route, future bot webhooks) calls THIS. The reference scatters message
// inserts across /chat, import, restore; V1 funnels them through one function
// so the operator invariant ("any message that comes in should be saved") has
// exactly one enforcement point.
//
// Encryption is transparent: `content`/`metadata` are in ENCRYPTED_FIELDS.messages
// (crypto-local.js), so the adapter's d1Query auto-encrypts them on write. This
// function never touches crypto directly. Fail-closed: with no key the adapter's
// autoEncryptParams throws REFUSE before any row is written — we let that surface.
//
// Idempotency: a caller may pass `id` (e.g. a source message id / webhook key);
// insertIgnore makes a resend a no-op. Without `id`, the schema generates one.
import crypto from 'node:crypto';

/**
 * Normalize a caller-supplied "when this message actually occurred" value into
 * the schema's `created_at` ISO format (`%Y-%m-%dT%H:%M:%fZ`). Accepts an ISO
 * string, a Date, or a Unix epoch (seconds — e.g. ChatGPT `create_time` — or
 * milliseconds; disambiguated by magnitude). Returns null for absent/invalid
 * input so the caller falls back to the DB default (insert-time = "now").
 * @param {string|number|Date|null|undefined} v
 * @returns {string|null}
 */
export function normalizeCreatedAt(v) {
  if (v == null) return null;
  let d;
  if (v instanceof Date) {
    d = v;
  } else if (typeof v === 'number') {
    d = new Date(v < 1e12 ? v * 1000 : v); // epoch seconds vs ms
  } else if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) { const n = Number(s); d = new Date(n < 1e12 ? n * 1000 : n); }
    else d = new Date(s); // ISO-8601 (Claude `created_at`)
  } else {
    return null;
  }
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString(); // e.g. 2025-08-29T07:24:00.000Z — matches the schema format
}

/**
 * Persist an inbound message. Returns { id, deduped, updated }: `updated` is
 * true when an existing message's content changed and was re-enriched in place.
 * @param {object} db                 wired db namespace (needs messages + audit)
 * @param {object} msg
 * @param {string} msg.userId         required
 * @param {string} [msg.content]      message text (required unless attachmentId given)
 * @param {string} [msg.role='user']  'user' | 'assistant'
 * @param {string} [msg.source]       provenance tag (e.g. 'mcp', 'telegram', 'api')
 * @param {string} [msg.messageType='chat']
 * @param {string} [msg.conversationId]
 * @param {string} [msg.attachmentId] link to an attachments row
 * @param {object|string} [msg.metadata]
 * @param {string} [msg.id]           caller-supplied id for idempotency
 * @param {() => void} [enqueueEnrichment]  optional fire-and-forget hook(id)
 */
export async function captureMessage(db, msg, enqueueEnrichment) {
  if (!db?.messages) throw new TypeError('captureMessage: db.messages required');
  const userId = msg?.userId;
  if (typeof userId !== 'string' || !userId) throw new Error('captureMessage: userId is required');

  const content = typeof msg.content === 'string' ? msg.content : '';
  if (!content && !msg.attachmentId) {
    throw new Error('captureMessage: content is required (or an attachmentId)');
  }

  const id = msg.id || crypto.randomUUID();
  const row = {
    id,
    user_id: userId,
    role: msg.role === 'assistant' ? 'assistant' : 'user',
    content,
    message_type: msg.messageType || 'chat',
    source: msg.source || 'api',
    scope: 'personal',
    nlp_processed: 0, // queue for enrichment (idx_messages_nlp_pending)
  };
  if (msg.conversationId) row.conversation_id = msg.conversationId;
  if (msg.attachmentId) row.attachment_id = msg.attachmentId;
  if (msg.metadata != null) {
    row.metadata = typeof msg.metadata === 'string' ? msg.metadata : JSON.stringify(msg.metadata);
  }
  // Preserve the ORIGINAL occurrence time (e.g. the create date in a Claude /
  // ChatGPT export) instead of letting the DB default-stamp it as insert-time.
  // created_at is plaintext (used for ordering/timeline/co-fire decay), so this
  // is a direct column write. Invalid/absent → DB default ("now") still applies.
  const createdAtIso = normalizeCreatedAt(msg.createdAt);
  if (createdAtIso) row.created_at = createdAtIso;

  // Content-aware dedup (migrations/0007). content_hash = plaintext SHA-256 of
  // the body (null for attachment-only messages). Three outcomes:
  //   • new id            → insert
  //   • seen, same hash   → no-op (deduped): webhook resend / unchanged re-sync
  //   • seen, hash differ → UPDATE in place + re-enrich, so the edit re-flows to
  //                         the mindscape. Forgotten (redacted) rows are immutable.
  const contentHash = content ? crypto.createHash('sha256').update(content, 'utf8').digest('hex') : null;
  if (contentHash) row.content_hash = contentHash;

  const meta = await db.messages.getContentMeta(userId, id);

  // New → insert. INSERT OR IGNORE still guards a concurrent double-insert.
  if (!meta.exists) {
    await db.messages.insertIgnore([row]);
    // Best-effort audit (cross-boundary traceability, §8). Never blocks the write.
    try { await db.audit?.log?.({ action: 'message_captured', userId, resourceType: 'message', resourceId: id, details: { source: row.source } }); } catch { /* non-fatal */ }
    // Fire-and-forget enrichment hand-off (row already durably queued at nlp_processed=0).
    if (typeof enqueueEnrichment === 'function') { try { enqueueEnrichment(id); } catch { /* non-fatal */ } }
    return { id, deduped: false, updated: false };
  }

  // Redacted rows are immutable — never resurrect a forgotten message.
  if (meta.forgotten) return { id, deduped: true, updated: false };

  // No body to compare (attachment-only) → existence-only dedup (prior behavior).
  if (!contentHash) return { id, deduped: true, updated: false };

  // Compare to the stored hash; for legacy (pre-0007) NULL-hash rows derive it
  // from the decrypted content so an unchanged legacy row only backfills its hash.
  const oldHash = meta.contentHash
    ?? (meta.content ? crypto.createHash('sha256').update(meta.content, 'utf8').digest('hex') : null);

  if (oldHash === contentHash) {
    if (meta.contentHash == null) { try { await db.messages.backfillContentHash(userId, id, contentHash); } catch { /* non-fatal */ } }
    return { id, deduped: true, updated: false };
  }

  // Content changed upstream → update in place + re-enrich (re-embed + re-cluster).
  // Pass metadata only when this capture carried it (undefined → preserve prior).
  const { changed } = await db.messages.updateContent(userId, id, { content, contentHash, metadata: row.metadata });
  if (!changed) return { id, deduped: true, updated: false };
  try { await db.audit?.log?.({ action: 'message_updated', userId, resourceType: 'message', resourceId: id, details: { source: row.source } }); } catch { /* non-fatal */ }
  if (typeof enqueueEnrichment === 'function') { try { enqueueEnrichment(id); } catch { /* non-fatal */ } }
  return { id, deduped: false, updated: true };
}
