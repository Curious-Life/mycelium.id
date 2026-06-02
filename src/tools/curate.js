// Curate domain — the lean verbs the user uses to shape their context bank,
// addressed by a {type,id} ref so the model holds one handle, not per-type
// variants.
//
//   remember(kind,…)  — write a durable, typed memory.
//                       kind:'fact'   → category/key -> value (upsert on key).
//                       kind:'entity' → person/project/place/org (name + summary).
//   link(entity,…)    — relate an entity to a message/document/fact
//                       (find-or-creates the entity by name+type).
//   forget(type,id)   — soft-redact a message/document/fact/entity: destroy
//                       content + any fingerprints, evict from search + clustering,
//                       tombstone for audit. No hard delete, no undo. Audited
//                       (hash + length, never text).
//   mark(type,id,…)   — user-asserted salience: pinned (surfaced first) and/or
//                       sensitive (kept out of proactive recall / never published).
//
// Local vault only — every call routes through the encrypting db namespaces.

const ITEM_TYPES = ['message', 'document', 'fact'];
const ENTITY_TYPES = ['person', 'project', 'place', 'org'];

export function createCurateDomain({ db, userId, searchHelpers }) {
  const REF = {
    type: { type: 'string', enum: ['message', 'document', 'fact', 'entity'], description: 'What kind of item.' },
    id: { type: 'string', description: 'The message id, document path, fact id, or entity id.' },
  };

  const tools = [
    {
      name: 'remember',
      description:
        'Remember a durable memory so you always know it. Two kinds:\n'
        + '- kind:"fact" (default) — a category (identity, preferences, relationships, work, health), '
        + 'a key (name, partner, favorite_coffee), and a value. Re-remembering the same category+key updates it.\n'
        + '- kind:"entity" — a person, project, place, or org: pass entityType + name (+ optional summary/aliases). '
        + 'Use the `link` tool to connect an entity to messages/documents/facts.\n'
        + 'Use for stable truths worth carrying across every conversation — not passing chatter (captured automatically). '
        + 'pass sensitive:true to keep it out of proactive recall, pinned:true to surface it first.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['fact', 'entity'], description: "What to remember (default 'fact')." },
          // fact fields
          category: { type: 'string', description: 'fact: the category, e.g. identity, preferences, relationships, work.' },
          key: { type: 'string', description: 'fact: the key within the category, e.g. name, partner, favorite_coffee.' },
          value: { type: 'string', description: 'fact: the value.' },
          confidence: { type: 'string', enum: ['stated', 'inferred', 'uncertain'], description: "fact: how sure you are (default 'stated')." },
          // entity fields
          entityType: { type: 'string', enum: ENTITY_TYPES, description: "entity: the kind of entity (default 'person')." },
          name: { type: 'string', description: 'entity: the entity name.' },
          summary: { type: 'string', description: 'entity: a short description of who/what this is.' },
          aliases: { type: 'array', items: { type: 'string' }, description: 'entity: other names this entity goes by.' },
          // shared salience
          sensitive: { type: 'boolean', description: 'Keep this out of proactive recall and never publish it.' },
          pinned: { type: 'boolean', description: 'Surface this first in context.' },
        },
      },
    },
    {
      name: 'link',
      description:
        'Link an entity (person/project/place/org) to a message, document, or fact — building the '
        + "entity's dossier. Finds or creates the entity by name+type, then connects it to the item. "
        + 'Use when a memory is about a known person/project/etc.',
      inputSchema: {
        type: 'object',
        properties: {
          entity: { type: 'string', description: 'The entity name to link.' },
          entityType: { type: 'string', enum: ENTITY_TYPES, description: "The entity kind (default 'person')." },
          type: { type: 'string', enum: ITEM_TYPES, description: 'The item kind to link to.' },
          id: { type: 'string', description: 'The item id: message id, document path, or fact id.' },
        },
        required: ['entity', 'type', 'id'],
      },
    },
    {
      name: 'forget',
      description:
        'Permanently forget a memory: soft-redact a message, document, fact, or entity so its '
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

  // Apply optional salience after a write so it is honored for new AND existing
  // rows (the upserts deliberately do not touch pinned/sensitive).
  async function applySalience(setSalience, id, args) {
    const flags = {};
    if (args.pinned !== undefined) flags.pinned = args.pinned;
    if (args.sensitive !== undefined) flags.sensitive = args.sensitive;
    if (Object.keys(flags).length) { try { await setSalience(id, userId, flags); } catch { /* best-effort */ } }
  }
  const salienceTags = (args) => {
    const t = [];
    if (args.pinned) t.push('pinned');
    if (args.sensitive) t.push('sensitive');
    return t.length ? ` (${t.join(', ')})` : '';
  };
  const verbFor = (status) => (status === 'created' ? 'Remembered' : status === 'restored' ? 'Restored' : 'Updated');

  const handlers = {
    remember: async (args = {}) => {
      const kind = args.kind || 'fact';

      if (kind === 'fact') {
        const category = (args.category || '').trim();
        const key = (args.key || '').trim();
        const value = (args.value || '').trim();
        if (!category || !key || !value) {
          throw new Error('remember(fact): category, key, and value are required and must be non-empty');
        }
        const { id, status } = await db.facts.upsert({
          userId, category, key, value, confidence: args.confidence || 'stated', source: 'user',
        });
        await applySalience(db.facts.setSalience, id, args);
        return `${verbFor(status)}: ${category}/${key}${salienceTags(args)}.`;
      }

      if (kind === 'entity') {
        const entityType = ENTITY_TYPES.includes(args.entityType) ? args.entityType : 'person';
        const name = (args.name || '').trim();
        if (!name) throw new Error('remember(entity): name is required and must be non-empty');
        const aliases = Array.isArray(args.aliases) && args.aliases.length
          ? JSON.stringify(args.aliases.map((a) => String(a)))
          : null;
        const { id, status } = await db.entities.upsert({
          userId, type: entityType, name, summary: args.summary || null, aliases, source: 'user',
        });
        await applySalience(db.entities.setSalience, id, args);
        return `${verbFor(status)}: ${entityType} "${name}"${salienceTags(args)}.`;
      }

      throw new Error(`remember: unknown kind "${kind}" (expected fact or entity)`);
    },

    link: async (args = {}) => {
      const name = (args.entity || '').trim();
      const entityType = ENTITY_TYPES.includes(args.entityType) ? args.entityType : 'person';
      const { type, id } = args;
      if (!name) throw new Error('link: entity (name) is required');
      if (!type || !id) throw new Error('link: type and id (the item to link) are required');
      if (!ITEM_TYPES.includes(type)) throw new Error(`link: unknown item type "${type}" (expected message, document, or fact)`);
      const { id: entityId } = await db.entities.upsert({ userId, type: entityType, name });
      const { created } = await db.entities.link({ userId, entityId, refType: type, refId: id });
      return `Linked ${entityType} "${name}" ${created ? 'to' : '(already linked to)'} ${type} ${id}.`;
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
        await auditForget('fact', id, res);
        return `Forgotten: fact ${id}. Value destroyed, tombstoned for audit. This cannot be undone.`;
      }

      if (type === 'entity') {
        const res = await db.entities.redact(id, userId);
        if (!res.found) return `Nothing to forget: no entity with id ${id}.`;
        if (res.alreadyForgotten) return `Already forgotten: entity ${id}.`;
        // Entity links carry no plaintext and are dropped by redact.
        await auditForget('entity', id, res);
        return `Forgotten: entity ${id}. Name and details destroyed, links removed, tombstoned for audit. This cannot be undone.`;
      }

      throw new Error(`forget: unknown type "${type}" (expected message, document, fact, or entity)`);
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
      else if (type === 'entity') res = await db.entities.setSalience(id, userId, flags);
      else throw new Error(`mark: unknown type "${type}" (expected message, document, fact, or entity)`);

      if (!res.found) return `No live ${type} found for ${id} (it may not exist, or be forgotten).`;
      const parts = [];
      if (pinned !== undefined) parts.push(pinned ? 'pinned' : 'unpinned');
      if (sensitive !== undefined) parts.push(sensitive ? 'marked sensitive' : 'cleared sensitive');
      return `${type} ${id}: ${parts.join(', ')}.`;
    },
  };

  return { tools, handlers };
}
