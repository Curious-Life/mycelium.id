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
//
// REFS (D-040 ↻1): the {type,id} handle is now the SHORT ref every read surface renders —
// `[msg:3f9a1c2b8d4e]`, `[fact:…]`, `[ent:…]`, `[doc:<path>]` (src/core/item-ref.js). All
// three ref-taking verbs resolve through resolveItemRef, so a listing that shows a short
// ref can never create a dead end in one of them. An unresolvable ref is a LOUD failure,
// never the old success-shaped "Nothing to forget: …".

import { renderRef, resolveItemRef, parseRef, isSafeIdShape } from '../core/item-ref.js';

const ITEM_TYPES = ['message', 'document', 'fact'];
const ENTITY_TYPES = ['person', 'project', 'place', 'org'];
// Everything addressable by a {type,id} ref (forget + mark). `link` targets ITEM_TYPES only.
const REF_TYPES = ['message', 'document', 'fact', 'entity'];

export function createCurateDomain({ db, userId, searchHelpers }) {
  const REF = {
    type: { type: 'string', enum: ['message', 'document', 'fact', 'entity'], description: 'What kind of item.' },
    id: {
      type: 'string',
      description: 'The ref shown next to the item when you read it — e.g. [msg:3f9a1c2b8d4e], '
        + '[fact:f47ac10b-58c], [ent:…], or [doc:<path>]. Paste it as shown (brackets optional). '
        + 'Never invent one: if you do not have a ref, read the item first (searchMindscape / getDailyMessages). '
        + 'Refs are internal handles — use them in tool calls, never show them to the user.',
    },
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

  // A forget that destroyed NOTHING is an event too (CLAUDE.md §8): before this, a miss
  // returned a calm sentence and left no trace anywhere, so "the agent said it forgot it
  // and the data is still there" was invisible after the fact. The attempted id is
  // recorded only when it is ID-SHAPED — a hallucinated id can be arbitrary text, and
  // arbitrary text may be user content (§1), so anything else is logged as 'invalid'.
  async function auditForgetMiss(type, rawId, reason) {
    try {
      // UNWRAP FIRST. The schema tells the model to paste the ref "as shown", i.e. the
      // bracketed `[msg:…]` token — which is NOT id-shaped, so testing the raw argument
      // audited 'invalid' for the single most common miss and left the trail blank exactly
      // where it was needed (independent review, 2026-07-26).
      const inner = parseRef(rawId).id;
      await db.audit?.log?.({
        action: 'forget-miss',
        userId,
        resourceType: type,
        resourceId: isSafeIdShape(inner) ? inner.slice(0, 64) : 'invalid',
        details: { reason, mode: 'redact' },
      });
    } catch { /* best-effort */ }
  }

  // The LOUD failure (D-040 ↻1 / QA6 "never report success from a non-throw"). Deliberately
  // NOT a throw: both catch sites collapse a throw to a constant "tool execution failed"
  // (src/mcp.js:293, src/agent/harness.js:624), so a throw carries LESS information than
  // this does — and widening those redactions would weaken §1 for every other tool. The
  // string is unmistakably a failure, tells the model what to do instead, and forbids the
  // "I forgot it" report. It carries NO user content: only the type and a fixed reason.
  const MISS_TEXT = {
    missing: 'no id was given',
    'type-mismatch': 'the ref you passed is for a different kind of item than the type you named',
    'not-found': 'no {type} in this vault matches that ref',
    ambiguous: 'that short ref matches more than one {type}',
  };
  function forgetFailed(type, reason, candidates) {
    const why = (MISS_TEXT[reason] || MISS_TEXT['not-found']).replace('{type}', type);
    // NEVER A DEAD END (QA6): "pass the full id" is useless advice when no read surface
    // renders a full id — so an ambiguity hands back the actual candidates. They are opaque
    // random ids belonging to this user, carrying no content (§1).
    const fix = reason === 'ambiguous'
      ? `Identify which one the user meant (re-read them), then pass its FULL id: ${(candidates || []).join(', ')}.`
      : `Re-read the item (searchMindscape, getDailyMessages, or listDocuments) and pass the exact ref shown beside it, e.g. ${renderRef(type, type === 'document' ? 'folder/name.md' : 'a1b2c3d4e5f6')}.`;
    return `FORGET FAILED — nothing was forgotten: ${why}. `
      + `Do NOT tell the user this is forgotten; the data is still there. ${fix}`;
  }

  // Resolve a {type,id} ref for any of the three ref-taking verbs. Returns the real row id
  // or null after auditing + reporting the miss (forget only — mark/link are non-destructive
  // and just report).
  async function resolveOrNull(verb, type, rawId) {
    const r = await resolveItemRef(db, userId, type, rawId);
    if (r.ok) return { id: r.id };
    if (verb === 'forget') await auditForgetMiss(type, rawId, r.reason);
    return { fail: verb === 'forget' ? forgetFailed(type, r.reason, r.candidates) : null, reason: r.reason };
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
      // Resolve the ref: the read surfaces now show SHORT refs, so `link` has to accept
      // one too or a listing would hand the model an id that only `forget` understands.
      // DELIBERATELY NON-STRICT: an unresolvable id still links, because `link` has always
      // accepted an arbitrary refId and callers legitimately link ids this process cannot
      // see. Tightening that into a refusal is a separate change with its own caller audit —
      // not something to smuggle into a destructive-capability PR.
      //
      // But the fallback is parseRef(id).id, NOT the raw argument: the read surfaces now
      // train the model to pass `[msg:…]`, so falling back to the raw string would persist
      // that literal token as entity_links.ref_id — a permanently dangling edge that
      // listEntities then re-renders as `[msg:[msg:…]`. (This is NOT "the pre-existing
      // contract" as an earlier draft of this comment claimed: before the refs existed the
      // model had no bracket syntax to pass. Independent review, 2026-07-26.)
      const ref = await resolveOrNull('link', type, id);
      // parseRef, not the raw string: the surfaces train the model to pass `[msg:…]`, and
      // persisting that literal token as entity_links.ref_id would be a permanently dangling
      // edge (independent review, 2026-07-26).
      const refId = ref.id || parseRef(id).id;
      const { id: entityId } = await db.entities.upsert({ userId, type: entityType, name });
      const { created } = await db.entities.link({ userId, entityId, refType: type, refId });
      return `Linked ${entityType} "${name}" ${created ? 'to' : '(already linked to)'} ${type} ${refId}.`;
    },

    forget: async (args = {}) => {
      const { type } = args;
      if (!type || !args.id) throw new Error('forget: type and id are required');
      if (!REF_TYPES.includes(type)) {
        throw new Error(`forget: unknown type "${type}" (expected message, document, fact, or entity)`);
      }
      // Resolve the agent-supplied ref BEFORE touching anything. A miss is LOUD + audited
      // and returns here — it can never fall through into a "Nothing to forget" sentence
      // the model reads as done.
      const ref = await resolveOrNull('forget', type, args.id);
      if (ref.fail) return ref.fail;
      const id = ref.id;

      if (type === 'message') {
        // redact() now owns the FULL cascade (src/core/delete-cascade.js), including
        // search-sidecar eviction — fail-closed, so a throw here means "not forgotten"
        // and the user is told so rather than being told it worked.
        const res = await db.messages.redact(id, userId, { searchHelpers });
        if (!res.found) { await auditForgetMiss('message', id, 'not-found'); return forgetFailed('message', 'not-found'); }
        if (res.alreadyForgotten) return `Already forgotten: message ${id}.`;
        await auditForget('message', id, res);
        return `Forgotten: message ${id}. Content and embeddings destroyed, removed from search and clustering, tombstoned for audit. This cannot be undone.`;
      }

      if (type === 'document') {
        const res = await db.documents.redact(userId, id, { searchHelpers });
        if (!res.found) { await auditForgetMiss('document', id, 'not-found'); return forgetFailed('document', 'not-found'); }
        if (res.alreadyForgotten) return `Already forgotten: document ${id}.`;
        // The old comment here ("Documents aren't in the in-RAM index … no explicit
        // index eviction is needed") was FALSE: d1-loader indexes documents under the
        // `document:<id>` key (src/search/d1-loader.js:41), so a forgotten document
        // stayed BM25- and vector-searchable by its own text. redact() now evicts it.
        await auditForget('document', id, res);
        return `Forgotten: document ${id}. Content and embedding destroyed, removed from search and clustering, tombstoned for audit. This cannot be undone.`;
      }

      if (type === 'fact') {
        const res = await db.facts.redact(id, userId);
        if (!res.found) { await auditForgetMiss('fact', id, 'not-found'); return forgetFailed('fact', 'not-found'); }
        if (res.alreadyForgotten) return `Already forgotten: fact ${id}.`;
        await auditForget('fact', id, res);
        return `Forgotten: fact ${id}. Value destroyed, tombstoned for audit. This cannot be undone.`;
      }

      if (type === 'entity') {
        const res = await db.entities.redact(id, userId);
        if (!res.found) { await auditForgetMiss('entity', id, 'not-found'); return forgetFailed('entity', 'not-found'); }
        if (res.alreadyForgotten) return `Already forgotten: entity ${id}.`;
        // Entity links carry no plaintext and are dropped by redact.
        await auditForget('entity', id, res);
        return `Forgotten: entity ${id}. Name and details destroyed, links removed, tombstoned for audit. This cannot be undone.`;
      }

      // (no trailing throw: REF_TYPES is validated at the top of this handler, so every
      // reachable `type` is handled above. A dead throw here would read as a live guard.)
    },

    mark: async (args = {}) => {
      const { type, pinned, sensitive } = args;
      if (!type || !args.id) throw new Error('mark: type and id are required');
      if (!REF_TYPES.includes(type)) throw new Error(`mark: unknown type "${type}" (expected message, document, fact, or entity)`);
      if (pinned === undefined && sensitive === undefined) {
        throw new Error('mark: provide pinned and/or sensitive');
      }
      // Same reason as `link`: the listings render short refs, so `mark` must resolve them.
      // Non-strict for the same reason — an unresolvable id falls through to setSalience,
      // which already reports "No live <type> found for <id>" (not success-shaped).
      const ref = await resolveOrNull('mark', type, args.id);
      const id = ref.id || parseRef(args.id).id;   // never the raw bracketed token
      const flags = {};
      if (pinned !== undefined) flags.pinned = pinned;
      if (sensitive !== undefined) flags.sensitive = sensitive;

      let res;
      if (type === 'message') res = await db.messages.setSalience(id, userId, flags);
      else if (type === 'document') res = await db.documents.setSalience(userId, id, flags);
      else if (type === 'fact') res = await db.facts.setSalience(id, userId, flags);
      else res = await db.entities.setSalience(id, userId, flags);   // REF_TYPES-validated above

      if (!res.found) return `No live ${type} found for ${id} (it may not exist, or be forgotten).`;
      const parts = [];
      if (pinned !== undefined) parts.push(pinned ? 'pinned' : 'unpinned');
      if (sensitive !== undefined) parts.push(sensitive ? 'marked sensitive' : 'cleared sensitive');
      return `${type} ${id}: ${parts.join(', ')}.`;
    },
  };

  return { tools, handlers };
}
