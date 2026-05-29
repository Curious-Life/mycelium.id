/**
 * Spaces domain — three tools (create_space, seed_space, list_spaces).
 *
 *   - create_space: mint a new space with essence + voice, optionally
 *     seeded from territories.
 *   - seed_space: contribute more territories into an existing space
 *     (requires 'contributor' role).
 *   - list_spaces: all spaces the user has access to, plus member
 *     and knowledge counts.
 *
 * The following tools were retired in the 2026-05-08 MCP refactor (zero
 * MCP calls in 7d for personal-agent):
 *   - get_space_growth — operators can inspect via the portal
 *   - space_scan, add_space_knowledge, edit_space_knowledge — Wave C1
 *     curation flow; no agent-side curation in production yet
 *
 * The scanner module @mycelium/core/spaces/scanners is still exported
 * for any future restoration; it's just no longer wired through MCP.
 *
 * create_space uses randomUUID for the space ID (injected as dep
 * for test determinism if a test wants to stub it).
 *
 * @typedef {object} SpacesDeps
 * @property {object} db — needs spaces, spaceKnowledge, rawQuery
 * @property {string} userId
 * @property {{ randomUUID: () => string }} crypto
 */

export function createSpacesDomain(deps) {
  if (!deps) throw new TypeError('createSpacesDomain: deps required');
  const { db, userId, crypto } = deps;
  if (!db) throw new TypeError('createSpacesDomain: db required');
  if (typeof userId !== 'string') throw new TypeError('createSpacesDomain: userId required');
  if (typeof crypto?.randomUUID !== 'function') throw new TypeError('createSpacesDomain: crypto.randomUUID required');

  const tools = [
    {
      name: 'create_space',
      description: 'Create a new Space — an autonomous knowledge entity with its own identity and evolving understanding. A space is seeded with knowledge from the user\'s territories and grows through conversations. Use this when the user wants to create a shareable knowledge mind, teach a topic, or set up a collaborative thinking space.',
      inputSchema: {
        type: 'object',
        properties: {
          name:          { type: 'string', description: 'The space\'s name (e.g., Rhiza, Systems Lab)' },
          essence:       { type: 'string', description: 'What the space explores, in 1-2 sentences' },
          voice:         { type: 'string', enum: ['conversational', 'socratic', 'poetic', 'precise'], description: 'How the space communicates' },
          territory_ids: { type: 'array', items: { type: 'string' }, description: 'Territory IDs to seed the space with (optional — can seed later)' },
        },
        required: ['name', 'essence', 'voice'],
      },
    },
    {
      name: 'seed_space',
      description: 'Add knowledge from the user\'s territories to an existing space. The territory descriptions are synthesized into the space\'s knowledge base.',
      inputSchema: {
        type: 'object',
        properties: {
          space_id:      { type: 'string', description: 'The space ID to seed' },
          territory_ids: { type: 'array', items: { type: 'string' }, description: 'Territory IDs to contribute' },
        },
        required: ['space_id', 'territory_ids'],
      },
    },
    {
      name: 'list_spaces',
      description: 'List all spaces the user has access to, with stats (knowledge count, members, role).',
      inputSchema: { type: 'object', properties: {} },
    },
  ];

  async function seedFromTerritories(spaceId, territoryIds) {
    let seeded = 0;
    for (const tid of territoryIds) {
      const result = await db.rawQuery(
        `SELECT id, name, essence, story_birth, story_arc, story_peak_moments, story_current_chapter
         FROM territory_profiles WHERE id = ? AND user_id = ?`,
        [tid, userId],
      );
      // rawQuery can return either an array or a { results: [] } shape
      // depending on which D1 client path answers; normalise.
      const rows = Array.isArray(result) ? result : (result?.results || []);
      const t = rows[0];
      if (t) {
        const summary = [t.essence, t.story_birth, t.story_arc, t.story_peak_moments, t.story_current_chapter]
          .filter(Boolean)
          .join('\n\n');
        if (!summary) continue;
        await db.spaceKnowledge.add(
          spaceId, summary, userId, t.id, 'territory_seed', 'all',
          t.name ? [t.name] : null,
          `territory:${t.id}`,
        );
        seeded++;
      }
    }
    return seeded;
  }

  const handlers = {
    create_space: async (args) => {
      const spaceId = crypto.randomUUID();
      await db.spaces.create(spaceId, args.name, args.essence, args.voice, userId, null);
      const seeded = args.territory_ids?.length ? await seedFromTerritories(spaceId, args.territory_ids) : 0;
      return `Space "${args.name}" created (id: ${spaceId}). ${seeded ? `Seeded with ${seeded} territories.` : 'No territories seeded yet — use seed_space to add knowledge.'} The space is now alive and ready for conversations in the Spaces section of the portal.`;
    },

    seed_space: async (args) => {
      await db.spaces.requireRole(args.space_id, userId, 'contributor');
      const seeded = await seedFromTerritories(args.space_id, args.territory_ids);
      return `Seeded ${seeded} territories into the space.`;
    },

    list_spaces: async () => {
      const spaces = await db.spaces.listForUser(userId);
      if (!spaces.length) return 'You have no spaces yet. Would you like to create one?';
      return spaces.map(s => {
        const settings = s.settings || {};
        return `• **${s.name}** (${s.role}) — ${settings.essence || 'no description'}\n  ${s.knowledge_count} knowledge entries, ${s.member_count} members`;
      }).join('\n\n');
    },
  };

  return { tools, handlers };
}
