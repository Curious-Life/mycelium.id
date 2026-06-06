// Persona-Claims read tools (PersonaTree adoption). A single read-only tool the
// connecting agent uses to inspect the durable person-level claims the discovery
// lifecycle has formed, and how a claim's confidence has moved over time.
//
// Read-only by design: claims are WRITTEN by the offline discovery pipeline
// (pipeline/discover-claims.mjs), never by a tool call. The agent reads them here
// and they also ride along in getContext. db.claims is injected at factory time
// (the MCP handler contract is `(args) => string`). See
// docs/PERSONA-CLAIMS-DESIGN-2026-06-06.md §3.8.
import { toConfidence } from '../claims/confidence.js';

const GRANULARITIES = ['day', 'week', 'month', 'quarter'];

export function createClaimsToolsDomain(deps) {
  if (!deps) throw new TypeError('createClaimsToolsDomain: deps required');
  const { db, userId } = deps;
  if (!db?.claims) throw new TypeError('createClaimsToolsDomain: db.claims required');
  if (typeof userId !== 'string') throw new TypeError('createClaimsToolsDomain: userId required');

  const tools = [
    {
      name: 'personaClaims',
      description:
        'Read the durable, evidence-grounded claims the system has formed about the user — their values, '
        + 'principles, identity, personality, and hard boundaries (e.g. allergies) — with a confidence per claim. '
        + "mode:'list' (default) returns the current active claims; mode:'series' returns one claim's confidence "
        + 'trajectory over time (day/week/month/quarter), so you can see how a belief about the user strengthened, '
        + 'weakened, or was contradicted. These are interpretations grounded in past interactions, not certainties.',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['list', 'series'], description: "'list' (default) or 'series'." },
          claimId: { type: 'string', description: "Required for mode:'series' — the claim to chart." },
          granularity: { type: 'string', enum: GRANULARITIES, description: "Series granularity (default 'week')." },
          limit: { type: 'number', description: 'Max claims for list (default 20).' },
        },
      },
    },
  ];

  const handlers = {
    personaClaims: async (args = {}) => {
      const mode = args.mode === 'series' ? 'series' : 'list';

      if (mode === 'series') {
        if (!args.claimId) throw new Error("personaClaims: claimId is required for mode:'series'.");
        const gran = GRANULARITIES.includes(args.granularity) ? args.granularity : 'week';
        const claim = await db.claims.getById(userId, args.claimId);
        if (!claim) return `No claim found for id ${args.claimId}.`;
        const series = await db.claims.readSeries(userId, args.claimId, gran);
        if (!series.length) return `**${claim.content}**\nNo ${gran} history yet (a trajectory appears once discovery runs across more ${gran} windows).`;
        const lines = series.map((s) => {
          const c = s.confidence == null ? '—' : s.confidence.toFixed(2);
          return `- ${s.windowEnd.slice(0, 10)}: confidence ${c}${s.deltaKind ? ` (${s.deltaKind})` : ''}${s.evidenceCount != null ? ` · ${s.evidenceCount} evidence` : ''}`;
        }).join('\n');
        return `**${claim.content}** _(${claim.claimType})_ — ${gran} trajectory:\n${lines}`;
      }

      // mode: list
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
      const claims = await db.claims.listActive(userId, { limit });
      if (!claims.length) {
        return 'No claims yet. The system forms claims about you as it discovers patterns across your '
          + 'interaction history over time (requires a local model to be available).';
      }
      // Highest confidence first (confidence is encrypted → sort JS-side after decrypt).
      const ranked = claims
        .map((c) => ({ ...c, conf: c.confidenceLogodds == null ? 0 : toConfidence(c.confidenceLogodds) }))
        .sort((a, b) => b.conf - a.conf);
      const lines = ranked.map((c) => {
        const n = c.support?.messages?.length ?? 0;
        return `- **[${c.claimType}]** ${c.content} — confidence ${c.conf.toFixed(2)}, ${n} supporting · \`${c.id}\``;
      }).join('\n');
      return `# Claims about the user (${ranked.length})\n\n${lines}\n\n_Use mode:'series' with a claim id to see how its confidence changed over time._`;
    },
  };

  return { tools, handlers };
}

export default createClaimsToolsDomain;
