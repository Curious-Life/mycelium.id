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
 * Persist an inbound message. Returns { id, deduped }.
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

  // insertIgnore → idempotent on the id PK; a webhook resend is a no-op.
  const before = await db.messages.getExistingIds(userId, [id]);
  const deduped = before.has(id);
  if (!deduped) {
    await db.messages.insertIgnore([row]);
    // Best-effort audit (cross-boundary traceability, §8). Never blocks the write.
    try { await db.audit?.log?.({ action: 'message_captured', userId, resourceType: 'message', resourceId: id, details: { source: row.source } }); } catch { /* non-fatal */ }
    // Fire-and-forget enrichment hand-off (row already durably queued at nlp_processed=0).
    if (typeof enqueueEnrichment === 'function') {
      try { enqueueEnrichment(id); } catch { /* non-fatal */ }
    }
  }
  return { id, deduped };
}
