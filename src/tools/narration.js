// src/tools/narration.js — the narration MCP domain (Phase 2).
//
// ONE registration, every channel: collectTools (src/mcp.js) flattens this into the
// shared handlers map that backs MCP (mcp.js dispatch), REST (POST /api/v1/<tool>),
// the native harness (autonomy-tools filters the same registry), and external
// harnesses via the gateway. Two tools, split read/write so they compose cleanly:
//
//   getEntityContext (READ, read-safe → SAFE_AUTONOMOUS_TOOLS) — returns the Context
//     Capsule for a realm/territory/theme: identity, temporal coverage (prior span vs.
//     new), activity timeline, connected-BY-NAME, and the measured shape (vitality /
//     phase / movement / coherence). Mycelium owns context assembly; the caller owns
//     the prose. Any model/harness can pull this and narrate however it wants.
//   describeEntity (WRITE, gated → AUTONOMY_TOOLS, kept OUT of chat DOMAINS) — set a
//     realm/territory name + essence (+ optional territory chronicle), stamping the
//     covered period from the capsule. UPDATE-only (fail-closed: never creates an
//     entity). Validates input; never overwrites with junk; never logs content (§1).
import {
  loadMembers, getSeenIds,
} from '../../pipeline/lib/narrate-sample.js';
import { buildContextCapsule, renderCapsule, describedPeriodFor } from '../../pipeline/lib/narrate-context.js';

const KINDS = new Set(['territory', 'realm', 'theme']);
const COL = { territory: 'territory_id', realm: 'realm_id', theme: 'theme_id' };

export function createNarrationDomain({ db, userId }) {
  const query = (sql, p = []) => db.rawQuery(sql, p).then((r) => (Array.isArray(r) ? r : r.results || []));

  async function loadStored(kind, id) {
    const table = kind === 'realm' ? 'realms' : 'territory_profiles';
    const idCol = COL[kind] || 'territory_id';
    const [row] = await query(
      `SELECT name, essence, described_period_start, described_period_end FROM ${table} WHERE user_id = ? AND ${idCol} = ?`,
      [userId, id]).catch(() => []);
    return row || null;
  }

  const tools = [
    {
      name: 'getEntityContext',
      description: 'Get the rich Context Capsule for a mindscape entity (realm/territory/theme): current name+essence, the time-span the prior description covered vs. new content + % described, an activity-by-month timeline, what it connects to BY NAME (parent realm, nearest by meaning, co-activation, lineage), and its measured shape (vitality/phase/movement/coherence). Use this to understand an area before describing or reasoning about it.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['territory', 'realm', 'theme'], description: 'Entity kind.' },
          id: { type: ['integer', 'string'], description: 'Entity id (territory_id / realm_id / theme_id).' },
        },
        required: ['kind', 'id'],
      },
    },
    {
      name: 'describeEntity',
      description: 'Write a name and essence (and optionally a chronicle) for a mindscape realm or territory, folding new content into the existing understanding. Call getEntityContext first to see the prior description, covered period, and connections. Only call this when the description should actually change — if nothing new is worth adding, do not call it and leave the existing description as it is. UPDATE-only: it refines an existing entity, never creates one.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['territory', 'realm'], description: 'territory or realm.' },
          id: { type: ['integer', 'string'], description: 'territory_id / realm_id.' },
          name: { type: 'string', description: '2-4 word title.' },
          essence: { type: 'string', description: 'One vivid sentence capturing what this area is.' },
          chronicle: {
            type: 'object',
            description: 'Optional fuller story (territory only): { archetype_type, story_birth, story_arc, story_current_chapter, signature_patterns?, open_questions? }.',
          },
        },
        required: ['kind', 'id', 'name', 'essence'],
      },
    },
  ];

  const handlers = {
    getEntityContext: async (args = {}) => {
      const kind = String(args.kind || '');
      if (!KINDS.has(kind)) return `Unknown kind "${args.kind}" (territory|realm|theme).`;
      const id = args.id;
      const members = await loadMembers(query, userId, COL[kind], id).catch(() => []);
      const seenIds = kind === 'territory' ? await getSeenIds(query, userId, id).catch(() => new Set()) : null;
      const stored = await loadStored(kind, id);
      if (!stored && !members.length) return `No ${kind} ${id} found.`;
      const capsule = await buildContextCapsule({ query, db, userId, kind, id, members, seenIds, stored });
      return { rendered: renderCapsule(capsule), capsule };
    },

    describeEntity: async (args = {}) => {
      const kind = String(args.kind || '');
      if (kind !== 'territory' && kind !== 'realm') return 'describeEntity: kind must be territory or realm.';
      const id = args.id;
      const name = typeof args.name === 'string' ? args.name.trim() : '';
      const essence = typeof args.essence === 'string' ? args.essence.trim() : '';
      // Validate (fail-soft: reject junk, never wipe a good description).
      const words = name.split(/\s+/).filter(Boolean);
      if (words.length < 1 || words.length > 6 || !essence) {
        return `describeEntity rejected: need a 1-6 word name and a non-empty essence (name="${name}", essence ${essence.length} chars).`;
      }
      const stored = await loadStored(kind, id);
      if (!stored) return `describeEntity: ${kind} ${id} does not exist (UPDATE-only; cannot create).`;
      // Covered period from live members → the next narration knows what this was based on.
      const members = await loadMembers(query, userId, COL[kind], id).catch(() => []);
      const seenIds = kind === 'territory' ? await getSeenIds(query, userId, id).catch(() => new Set()) : null;
      const dp = describedPeriodFor(kind, members, seenIds);
      const changed = await db.mindscape.setNameEssence(
        userId, kind, id,
        { name: name.slice(0, 80), essence: essence.slice(0, 500) },
        { start: dp?.start ?? null, end: dp?.end ?? null },
      );
      // Optional fuller chronicle (territory only) via the existing story writer.
      if (kind === 'territory' && args.chronicle && typeof args.chronicle === 'object') {
        const c = args.chronicle;
        const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);
        const arr = (v) => (Array.isArray(v) ? v.slice(0, 8).map(String) : []);
        await db.territoryDocs.upsertDescription(userId, id, {
          name: name.slice(0, 80), essence: essence.slice(0, 500),
          archetype_type: str(c.archetype_type, 60),
          story_birth: str(c.story_birth, 600), story_arc: str(c.story_arc, 1000),
          story_current_chapter: str(c.story_current_chapter, 600),
          signature_patterns: arr(c.signature_patterns),
          uncertainty_open_questions: arr(c.open_questions || c.uncertainty_open_questions),
          point_count: members.length,
        }, 'chronicle-v1', null, 'describeEntity').catch(() => {});
      }
      return changed ? `Described ${kind} ${id}: "${name}".` : `describeEntity: ${kind} ${id} not updated.`;
    },
  };

  return { tools, handlers };
}

export default createNarrationDomain;
