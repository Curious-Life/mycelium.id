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
        },
        required: ['content'],
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
      }, enqueueEnrichment);
      return deduped
        ? `Already captured (id ${id}); no duplicate created.`
        : `Captured message ${id}.`;
    },
  };

  return { tools, handlers };
}
