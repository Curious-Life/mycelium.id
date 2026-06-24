/**
 * Cognition domain (Phase 5 consolidation) — the 3 cohesive readers that the
 * lean surface exposes in place of the 11 cluster/Fisher/metric/topology tools:
 *
 *   cognitiveState({level?})    — the "now": movement (phase/velocity/direction)
 *                                 + rhythm (energy per timescale, flow, spread)
 *                                 + active alerts. Folds getCurrentPhase +
 *                                 getHarmonicState + getActiveMilestones.
 *   cognitiveHistory({…})       — over time: trajectory + top movers, plus an
 *                                 optional named-metric series. Folds
 *                                 getTrajectoryHistory + getMetricSeries +
 *                                 getTopMovers.
 *   mindscape({view, …})        — the topology graph, by view. Folds
 *                                 mindscapeStructure + listTerritories +
 *                                 territoryDetail + exploreTerritory + timeView.
 *
 * Implementation: this domain REUSES the existing fisher-tools / metrics /
 * topology-tools handler logic VERBATIM (same db.fisher/metrics/topology methods,
 * same formatters) — so the consolidation preserves capability by construction
 * (Phase 5 is a pure tool-surface reshape, zero change to storage or compute,
 * spec §3.8). Those three factories are now internal implementations; only their
 * `handlers` are reused, their `tools` arrays are no longer registered. All 3
 * tools here are Tier-2 (topology-gated) — see TIER2_TOOLS in src/mcp.js.
 *
 * @typedef {object} CognitionDeps
 * @property {object} db
 * @property {string} userId
 * @property {object} topologyHelpers — for the topology views (resolveTerritoryId + fetchers)
 */

import { createFisherToolsDomain } from './fisher-tools.js';
import { createMetricsDomain } from './metrics.js';
import { createTopologyToolsDomain } from './topology-tools.js';

export function createCognitionDomain({ db, userId, topologyHelpers }) {
  const fisher = createFisherToolsDomain({ db, userId });
  const metrics = createMetricsDomain({ db, userId });
  const topo = createTopologyToolsDomain({ db, userId, topologyHelpers });

  const tools = [
    {
      name: 'cognitiveState',
      description:
        'Your cognitive state right now, in one call: MOVEMENT (phase — stable / cycling / '
        + 'exploring / transforming — plus velocity and exploration ratio), RHYTHM (activity energy '
        + 'per timescale, how the thinking is flowing, how spread-out it is), and any active ALERTS '
        + '(phase shifts, sustained cycling, velocity outliers). Call at the start of a conversation '
        + 'to orient. Needs your mindscape to be computed (import + cluster first).',
      inputSchema: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['realm', 'theme', 'territory', 'all'], description: 'Hierarchy level for movement (default realm; "all" = realm+theme+territory).' },
          granularity: { type: 'string', enum: ['alpha', 'theta', 'delta'], description: 'Rhythm window grain (default alpha = daily).' },
          detail: { type: 'string', enum: ['flow', 'shape'], description: 'Narrow the rhythm bundle: "flow" or "shape" (omit for the full bundle).' },
        },
      },
    },
    {
      name: 'cognitiveHistory',
      description:
        'Your cognition over time: the trajectory (phase, velocity, displacement, exploration ratio '
        + 'per window, oldest first) and which territories drove the most recent movement. Pass a '
        + '`metric` to also chart one named metric over time. Use for "how have I been lately". '
        + '`period` is the easy time scope (month / quarter / half_year / year / all); or pass from/to.',
      inputSchema: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['realm', 'theme', 'territory'], description: 'Hierarchy level (default realm).' },
          period: { type: 'string', enum: ['month', 'quarter', 'half_year', 'year', 'all'], description: 'Time scope preset for the trajectory (default quarter = last 90 days).' },
          windowType: { type: 'string', enum: ['daily', 'weekly_rolling', 'weekly_step', 'monthly'], description: 'Trajectory window type (default weekly_step).' },
          metric: { type: 'string', description: 'Optional: a named metric (a cognitive_metrics_harmonic column) to chart over time too.' },
          granularity: { type: 'string', enum: ['alpha', 'theta', 'delta'], description: 'Window grain for the metric series (default alpha).' },
          from: { type: 'string', description: 'ISO lower bound (overrides period).' },
          to: { type: 'string', description: 'ISO upper bound (overrides period).' },
          limit: { type: 'number', description: 'Max rows.' },
          windowEnd: { type: 'string', description: 'Top movers: a specific window end ISO (default latest).' },
        },
      },
    },
    {
      name: 'mindscape',
      description:
        'Explore your cognitive topology — the mindscape graph — by view:\n'
        + '- "structure" (default): vitality distribution, top territories, topology health, orphans, bridges.\n'
        + '- "territories": a filterable/sortable list of territories.\n'
        + '- "territory": deep view of ONE territory (identity, story, vitality, timeline, samples) — pass `territory`.\n'
        + '- "explore": a territory\'s co-firing neighbors + unexplored gaps — pass `territory`.\n'
        + '- "time": activity timeline (one territory if `territory` given, else the whole mindscape).\n'
        + 'Territory names are fuzzy-matched; or pass a numeric id. Use searchMindscape to find a name.',
      inputSchema: {
        type: 'object',
        properties: {
          view: { type: 'string', enum: ['structure', 'territories', 'territory', 'explore', 'time'], description: 'Which view (default structure).' },
          territory: { description: 'Territory name (fuzzy) or numeric id — for territory / explore / time views.' },
          scale: { type: 'string', enum: ['immediate', 'session', 'daily', 'weekly'], description: 'Temporal scale (explore / structure).' },
          range: { type: 'string', enum: ['7d', '30d', '90d', 'all'], description: 'Time range for the time view (default 90d).' },
          phase: { type: 'string', enum: ['sparse', 'active', 'anchor'], description: 'Filter by vitality phase (territories view).' },
          realm: { type: 'number', description: 'Filter by realm id (territories view).' },
          minMessages: { type: 'number', description: 'Minimum message count (territories view).' },
          sortBy: { type: 'string', enum: ['vitality', 'messages', 'name'], description: 'Sort order (territories view; default vitality).' },
          limit: { type: 'number', description: 'Max results (territories view; default 20).' },
          includeCoFiring: { type: 'boolean', description: 'Show co-firing partners (explore; default true).' },
          includeGaps: { type: 'boolean', description: 'Show unexplored connections (explore; default true).' },
          depth: { type: 'number', description: 'Cluster walk depth (explore; default 1).' },
          orphans: { type: 'boolean', description: 'Include orphan territories (structure; default true).' },
          bridges: { type: 'boolean', description: 'Include bridge territories (structure; default true).' },
        },
      },
    },
  ];

  const handlers = {
    // The "now": movement + rhythm + alerts, reusing the verified handlers.
    cognitiveState: async (args = {}) => {
      const [movement, rhythm, alerts] = await Promise.all([
        fisher.handlers.getCurrentPhase(args),
        metrics.handlers.getHarmonicState(args),
        fisher.handlers.getActiveMilestones({ limit: args.limit || 5 }),
      ]);
      return [movement, rhythm, alerts].join('\n\n---\n\n');
    },

    // Over-time: trajectory + top movers (+ optional named-metric series).
    cognitiveHistory: async (args = {}) => {
      const parts = [await fisher.handlers.getTrajectoryHistory(args)];
      if (args.metric) parts.push(await metrics.handlers.getMetricSeries(args));
      parts.push(await fisher.handlers.getTopMovers(args));
      return parts.join('\n\n---\n\n');
    },

    // Topology, by view — dispatch to the reused topology handlers.
    mindscape: async (args = {}) => {
      const view = args.view || 'structure';
      switch (view) {
        case 'structure':   return topo.handlers.mindscapeStructure(args);
        case 'territories': return topo.handlers.listTerritories(args);
        case 'territory':
          if (!args.territory) return 'Pass `territory` (a name or id) to use view:"territory".';
          return topo.handlers.territoryDetail(args);
        case 'explore':
          if (!args.territory) return 'Pass `territory` (a name or id) to use view:"explore".';
          return topo.handlers.exploreTerritory(args);
        case 'time':        return topo.handlers.timeView(args);
        default:
          return `Unknown view "${view}". Use one of: structure, territories, territory, explore, time.`;
      }
    },
  };

  return { tools, handlers };
}
