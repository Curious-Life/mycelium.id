// Curate domain — cross-cutting verbs over the context bank, addressed by a
// {type,id} ref so the model holds one handle, not per-type variants.
//
//   forget(type,id) — soft-redact a message/document: destroy content + both
//                     embedding fingerprints, delete the clustering point, evict
//                     the in-RAM search index, tombstone for audit. No hard
//                     delete, no undo. Audited (hash + length only, never text).
//   mark(type,id,…) — user-asserted salience: pinned (surfaced first) and/or
//                     sensitive (kept out of proactive recall / never published).
//
// Local vault only — every call routes through the encrypting db namespaces.

export function createCurateDomain({ db, userId, searchHelpers }) {
  const REF = {
    type: { type: 'string', enum: ['message', 'document'], description: 'What kind of item.' },
    id: { type: 'string', description: 'The message id, or the document path.' },
  };

  const tools = [
    {
      name: 'forget',
      description:
        'Permanently forget a memory: soft-redact a message or document so its '
        + 'content and search fingerprints are destroyed and it disappears from all '
        + 'recall, leaving only an auditable tombstone. Use when the user asks to '
        + 'delete, remove, redact, or forget something. There is no undo.',
      inputSchema: { type: 'object', properties: { ...REF }, required: ['type', 'id'] },
    },
    {
      name: 'mark',
      description:
        'Mark an existing memory as pinned (surfaced first in context) and/or '
        + 'sensitive (kept out of proactive recall and never published). Use when '
        + 'the user says something matters, or is private/sensitive. Pass pinned '
        + 'and/or sensitive as booleans to set or clear them.',
      inputSchema: {
        type: 'object',
        properties: {
          ...REF,
          pinned: { type: 'boolean', description: 'Pin (true) or unpin (false).' },
          sensitive: { type: 'boolean', description: 'Mark sensitive (true) or clear (false).' },
        },
        required: ['type', 'id'],
      },
    },
  ];

  // Audit a forget — hash + length + ref only, NEVER the plaintext (CLAUDE.md
  // §1/§8). Best-effort: a failed audit must never block the forget itself.
  async function auditForget(type, id, res) {
    try {
      await db.audit?.log?.({
        action: 'forget',
        userId,
        resourceType: type,
        resourceId: id,
        details: { content_hash: res.contentHash, length: res.length, mode: 'redact' },
      });
    } catch { /* best-effort */ }
  }

  const handlers = {
    forget: async (args = {}) => {
      const { type, id } = args;
      if (!type || !id) throw new Error('forget: type and id are required');

      if (type === 'message') {
        const res = await db.messages.redact(id, userId);
        if (!res.found) return `Nothing to forget: no message with id ${id}.`;
        if (res.alreadyForgotten) return `Already forgotten: message ${id}.`;
        // Evict from the process-cached in-RAM index (no auto-refresh on delete).
        try { await searchHelpers?.backend?.delete?.({ ids: [id] }); } catch { /* best-effort */ }
        await auditForget('message', id, res);
        return `Forgotten: message ${id}. Content and embeddings destroyed, removed from search and clustering, tombstoned for audit. This cannot be undone.`;
      }

      if (type === 'document') {
        const res = await db.documents.redact(userId, id);
        if (!res.found) return `Nothing to forget: no document at path ${id}.`;
        if (res.alreadyForgotten) return `Already forgotten: document ${id}.`;
        // Documents aren't in the in-RAM index; the nulled embedding removes them
        // from the document scan-matcher, so no explicit index eviction is needed.
        await auditForget('document', id, res);
        return `Forgotten: document ${id}. Content and embedding destroyed, removed from clustering, tombstoned for audit. This cannot be undone.`;
      }

      throw new Error(`forget: unknown type "${type}" (expected message or document)`);
    },

    mark: async (args = {}) => {
      const { type, id, pinned, sensitive } = args;
      if (!type || !id) throw new Error('mark: type and id are required');
      if (pinned === undefined && sensitive === undefined) {
        throw new Error('mark: provide pinned and/or sensitive');
      }
      const flags = {};
      if (pinned !== undefined) flags.pinned = pinned;
      if (sensitive !== undefined) flags.sensitive = sensitive;

      let res;
      if (type === 'message') res = await db.messages.setSalience(id, userId, flags);
      else if (type === 'document') res = await db.documents.setSalience(userId, id, flags);
      else throw new Error(`mark: unknown type "${type}" (expected message or document)`);

      if (!res.found) return `No live ${type} found for ${id} (it may not exist, or be forgotten).`;
      const parts = [];
      if (pinned !== undefined) parts.push(pinned ? 'pinned' : 'unpinned');
      if (sensitive !== undefined) parts.push(sensitive ? 'marked sensitive' : 'cleared sensitive');
      return `${type} ${id}: ${parts.join(', ')}.`;
    },
  };

  return { tools, handlers };
}
