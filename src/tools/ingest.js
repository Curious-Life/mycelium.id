// Ingest tool domain — the connected-agent convenience path into the single
// captureMessage() choke-point. (Uploads are NOT a tool: file bytes can't flow
// through an MCP tool handler — they go through the /ingest/upload HTTP route.)
import { captureMessage } from '../ingest/capture.js';

/**
 * @typedef {object} IngestDeps
 * @property {object} db      wired db namespace (needs messages + audit)
 * @property {string} userId
 * @property {(id: string) => void} [enqueueEnrichment]
 */
export function createIngestDomain(deps) {
  if (!deps) throw new TypeError('createIngestDomain: deps required');
  const { db, userId, enqueueEnrichment } = deps;
  if (!db) throw new TypeError('createIngestDomain: db required');
  if (typeof userId !== 'string') throw new TypeError('createIngestDomain: userId required');

  const tools = [
    {
      name: 'captureMessage',
      description:
        'Save a message into the vault\'s message stream. Use to log a note, an '
        + 'observation, or a message from another channel so it becomes part of '
        + 'searchable memory (it gets embedded + tagged by enrichment). Idempotent: '
        + 'pass the same id to avoid duplicates on retry.',
      inputSchema: {
        type: 'object',
        properties: {
          content:        { type: 'string', description: 'The message text.' },
          role:           { type: 'string', enum: ['user', 'assistant'], description: 'Who said it (default "user").' },
          source:         { type: 'string', description: 'Where it came from, e.g. "note", "telegram", "email" (default "mcp").' },
          conversationId: { type: 'string', description: 'Optional thread/conversation id.' },
          id:             { type: 'string', description: 'Optional caller-supplied id for idempotency (a resend with the same id is a no-op).' },
          metadata:       { type: 'object', description: 'Platform extras (sender, chatTitle, replyTo, …) — stored encrypted.' },
          createdAt:      { type: ['string', 'number'], description: 'Original message time (ISO 8601 or unix epoch) when relaying.' },
          attachmentId:   { type: 'string', description: 'Link to an attachments row (uploaded file) this message describes.' },
        },
        required: ['content'],
      },
    },
    {
      name: 'importMessages',
      description:
        'Bulk-import many messages at once (e.g. a channel history backfill from a '
        + 'connector or an export). Each item is saved through the same path as '
        + 'captureMessage and is idempotent on its id — re-running an import skips '
        + 'already-saved messages. Returns counts of created vs skipped.',
      inputSchema: {
        type: 'object',
        properties: {
          messages: {
            type: 'array',
            description: 'Array of messages to import.',
            items: {
              type: 'object',
              properties: {
                content:        { type: 'string', description: 'The message text.' },
                id:             { type: 'string', description: 'Stable id for dedup (e.g. "telegram-<msgId>-<chatId>"). Strongly recommended for re-runnable imports.' },
                role:           { type: 'string', enum: ['user', 'assistant'] },
                source:         { type: 'string', description: 'Channel/source, e.g. "telegram".' },
                conversationId: { type: 'string' },
                timestamp:      { type: 'string', description: 'Optional ISO 8601 original time (stored in metadata).' },
                metadata:       { type: 'object', description: 'Platform extras (sender, chatTitle, replyTo, mediaType, …).' },
              },
              required: ['content'],
            },
          },
        },
        required: ['messages'],
      },
    },
  ];

  const handlers = {
    captureMessage: async (args = {}) => {
      const content = (args.content || '').trim();
      if (!content) return 'Error: content is required';
      const { id, deduped } = await captureMessage(db, {
        userId,
        content,
        role: args.role,
        source: args.source || 'mcp',
        conversationId: args.conversationId,
        id: args.id,
        // Relay extras — capture.js validates/normalizes each (metadata is an
        // ENCRYPTED_FIELDS.messages column; createdAt accepts ISO or epoch).
        // Without this passthrough every channel message loses its sender/
        // chatTitle/replyTo context (live bug found 2026-06-10: metadata NULL).
        metadata: args.metadata,
        createdAt: args.createdAt,
        attachmentId: typeof args.attachmentId === 'string' ? args.attachmentId : undefined,
      }, enqueueEnrichment);
      return deduped
        ? `Already captured (id ${id}); no duplicate created.`
        : `Captured message ${id}.`;
    },

    importMessages: async (args = {}) => {
      const items = Array.isArray(args.messages) ? args.messages : [];
      if (items.length === 0) return 'Error: messages array is required (and non-empty)';

      let created = 0, skipped = 0, skippedEmpty = 0, failed = 0;
      // Loop the verified captureMessage choke-point — each row self-dedups on
      // its id. (Not a bulk INSERT: rows have heterogeneous optional columns, and
      // this reuses the single audited write path.) Originating timestamp is
      // preserved BOTH in metadata.original_timestamp (provenance) AND as the
      // created_at column (real occurrence time → correct timeline ordering) via
      // captureMessage's createdAt — accepts an explicit createdAt or falls back
      // to timestamp. Without this, bulk-imported history collapses to insert-time.
      for (const m of items) {
        const content = typeof m?.content === 'string' ? m.content.trim() : '';
        if (!content && !m?.attachmentId) { skippedEmpty += 1; continue; }
        const metadata = { ...(m.metadata || {}) };
        if (m.timestamp) metadata.original_timestamp = m.timestamp;
        try {
          const { deduped } = await captureMessage(db, {
            userId,
            content,
            role: m.role,
            source: m.source || 'import',
            conversationId: m.conversationId,
            id: m.id,
            createdAt: m.createdAt ?? m.timestamp,
            metadata: Object.keys(metadata).length ? metadata : undefined,
          }, enqueueEnrichment);
          if (deduped) skipped += 1; else created += 1;
        } catch { failed += 1; /* FAIL-LOUD: a capture error is a dropped message, not a dup */ }
      }
      // Honest accounting: headline = rows actually landed; failures and
      // empties are named separately (never folded into "imported").
      const notes = [];
      if (skippedEmpty) notes.push(`${skippedEmpty} skipped (empty)`);
      if (failed) notes.push(`${failed} FAILED`);
      const suffix = notes.length ? `, ${notes.join(', ')}` : '';
      return `Processed ${items.length} messages: ${created} new, ${skipped} duplicates${suffix}.`;
    },
  };

  return { tools, handlers };
}
