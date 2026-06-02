// Curate domain — the lean verbs the user uses to shape their context bank,
// addressed by a {type,id} ref so the model holds one handle, not per-type
// variants.
//
//   remember(kind,…)  — write a durable, typed memory. Phase 2: kind:'fact'
//                       (category/key -> value), upserted on (category,key).
//                       Phase 3 will add kind:'entity'.
//   forget(type,id)   — soft-redact a message/document/fact: destroy content +
//                       any embedding fingerprints, delete the clustering point,
//                       evict the in-RAM search index, tombstone for audit. No
//                       hard delete, no undo. Audited (hash + length, never text).
//   mark(type,id,…)   — user-asserted salience: pinned (surfaced first) and/or
//                       sensitive (kept out of proactive recall / never published).
//
// Local vault only — every call routes through the encrypting db namespaces.

export function createCurateDomain({ db, userId, searchHelpers }) {
  const REF = {
    type: { type: 'string', enum: ['message', 'document', 'fact'], description: 'What kind of item.' },
    id: { type: 'string', description: 'The message id, the document path, or the fact id.' },
  };

  const tools = [
    {
      name: 'remember',
      description:
        'Remember a durable fact about the user so you always know it. A fact is a '
        + 'category (e.g. identity, preferences, relationships, work, health), a key '
        + '(e.g. name, partner, favorite_coffee), and a value. Re-remembering the same '
        + 'category+key updates the value. Use this for stable truths worth carrying '
        + 'across every conversation — not passing chatter (that is captured automatically). '
        + 'Pass sensitive:true to keep it out of proactive recall, pinned:true to surface it first.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['fact'], description: "What to remember (default 'fact')." },
          category: { type: 'string', description: 'The fact category, e.g. identity, preferences, relationships, work.' },
          key: { type: 'string', description: 'The fact key within the category, e.g. name, partner, favorite_coffee.' },
          value: { type: 'string', description: 'The fact value.' },
          confidence: { type: 'string', enum: ['stated', 'inferred', 'uncertain'], description: "How sure you are (default 'stated')." },
          sensitive: { type: 'boolean', description: 'Keep this fact out of proactive recall and never publish it.' },
          pinned: { type: 'boolean', description: 'Surface this fact first in context.' },
        },
        required: ['category', 'key', 'value'],
      },
    },
    {
      name: 'forget',
      description:
        'Permanently forget a memory: soft-redact a message, document, or fact so its '
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
    remember: async (args = {}) => {
      const kind = args.kind || 'fact';
      if (kind !== 'fact') {
        // Fail-closed: entities arrive in Phase 3.
        throw new Error(`remember: unknown kind "${kind}" (only 'fact' is supported)`);
      }
      const category = (args.category || '').trim();
      const key = (args.key || '').trim();
      const value = (args.value || '').trim();
      if (!category || !key || !value) {
        throw new Error('remember: category, key, and value are required and must be non-empty');
      }

      const { id, status } = await db.facts.upsert({
        userId,
        category,
        key,
        value,
        confidence: args.confidence || 'stated',
        source: 'user',
      });

      // Salience is applied as a follow-up so it is honored for both new and
      // existing facts (the upsert deliberately does not touch pinned/sensitive).
      const flags = {};
      if (args.pinned !== undefined) flags.pinned = args.pinned;
      if (args.sensitive !== undefined) flags.sensitive = args.sensitive;
      if (Object.keys(flags).length) {
        try { await db.facts.setSalience(id, userId, flags); } catch { /* best-effort */ }
      }

      const verb = status === 'created' ? 'Remembered' : status === 'restored' ? 'Restored' : 'Updated';
      const tags = [];
      if (args.pinned) tags.push('pinned');
      if (args.sensitive) tags.push('sensitive');
      const suffix = tags.length ? ` (${tags.join(', ')})` : '';
      return `${verb}: ${category}/${key}${suffix}.`;
    },

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

      if (type === 'fact') {
        const res = await db.facts.redact(id, userId);
        if (!res.found) return `Nothing to forget: no fact with id ${id}.`;
        if (res.alreadyForgotten) return `Already forgotten: fact ${id}.`;
        // Facts aren't indexed or clustered — redact (null value + tombstone) is
        // the whole operation.
        await auditForget('fact', id, res);
        return `Forgotten: fact ${id}. Value destroyed, tombstoned for audit. This cannot be undone.`;
      }

      throw new Error(`forget: unknown type "${type}" (expected message, document, or fact)`);
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
      else if (type === 'fact') res = await db.facts.setSalience(id, userId, flags);
      else throw new Error(`mark: unknown type "${type}" (expected message, document, or fact)`);

      if (!res.found) return `No live ${type} found for ${id} (it may not exist, or be forgotten).`;
      const parts = [];
      if (pinned !== undefined) parts.push(pinned ? 'pinned' : 'unpinned');
      if (sensitive !== undefined) parts.push(sensitive ? 'marked sensitive' : 'cleared sensitive');
      return `${type} ${id}: ${parts.join(', ')}.`;
    },
  };

  return { tools, handlers };
}
