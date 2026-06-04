/**
 * [Phase 5] INTERNAL — folded into the cognition domain (src/tools/cognition.js).
 * createCognitionDomain reuses these 5 .handlers under the single mindscape({view})
 * tool; this factory's .tools array is no longer registered. Not a standalone MCP
 * domain anymore.
 *
 * Topology domain — 5 MCP tools that read from the mindscape graph:
 *
 *   - exploreTerritory: co-firing partners + gaps + optional cluster walk.
 *   - mindscapeStructure: vitality distribution + top territories + audit +
 *     orphans + bridges.
 *   - listTerritories: filterable/sortable table.
 *   - territoryDetail: essence, story, vitality breakdown, activity timeline,
 *     sample messages.
 *   - timeView: per-territory or global monthly activity bars.
 *
 * The following tools were retired in the 2026-05-08 MCP refactor (zero
 * MCP calls in 7d for personal-agent):
 *   - pathBetween (BFS shortest path between two territories)
 *   - territoryLineage (ancestor/descendant lineage through re-clustering)
 *   - vitalityExplainer (vitality score decomposition)
 *
 * The underlying topology APIs (db.topology.getCoFiring,
 * db.topology.getDescendants, db.topology.getAncestors) are still
 * exported for portal use and any future restoration; only the MCP
 * surface contracted.
 *
 * The domain reuses topologyHelpers (resolveTerritoryId + fetchers) and the
 * pure formatters imported from ../topology.js. Raw SQL lives here because
 * these handlers do bespoke projections that don't justify adding db-d1
 * namespace methods.
 *
 * @typedef {object} TopologyToolsDeps
 * @property {object} db — needs rawQuery + topology.{getCoFiring,getDescendants,getAncestors}
 * @property {string} userId
 * @property {object} topologyHelpers — from createTopologyHelpers: resolveTerritoryId, fetchCoFiring, fetchGaps, fetchCluster, fetchOrphans, fetchBridges
 */

import {
  formatCoFiring, formatGaps, formatCluster, formatOrphans, formatBridges,
} from '../topology.js';

export function createTopologyToolsDomain(deps) {
  if (!deps) throw new TypeError('createTopologyToolsDomain: deps required');
  const { db, userId, topologyHelpers } = deps;
  if (!db) throw new TypeError('createTopologyToolsDomain: db required');
  if (typeof userId !== 'string') throw new TypeError('createTopologyToolsDomain: userId required');
  if (!topologyHelpers?.resolveTerritoryId) throw new TypeError('createTopologyToolsDomain: topologyHelpers required');

  const {
    resolveTerritoryId,
    fetchCoFiring, fetchGaps, fetchCluster, fetchOrphans, fetchBridges,
  } = topologyHelpers;

  const tools = [
    {
      name: 'exploreTerritory',
      description: 'Explore a territory\'s neighborhood in the co-firing graph. Accepts a territory name (string) or ID (number) — names are auto-resolved.\n\nReturns the territory\'s co-firing partners (what gets discussed alongside it), gaps (high semantic similarity but low co-firing — unexplored connections), and optionally a deeper cluster walk.\n\nThis replaces getCoFiring, getGaps, and getCluster with a single, richer call.',
      inputSchema: {
        type: 'object',
        properties: {
          territory: { description: 'Territory name (e.g., "inner development") or numeric ID. Names are fuzzy-matched.' },
          includeCoFiring: { type: 'boolean', description: 'Show co-firing partners (default true)' },
          includeGaps:     { type: 'boolean', description: 'Show unexplored connections (default true)' },
          depth:           { type: 'number',  description: 'Cluster walk depth. 1 = immediate neighbors only (default). 2+ = deeper graph walk.' },
          scale:           { type: 'string', enum: ['immediate', 'session', 'daily', 'weekly'], description: 'Temporal scale for co-firing (default: session)' },
        },
        required: ['territory'],
      },
    },
    {
      name: 'mindscapeStructure',
      description: 'Get a structural overview of the mindscape: phase distribution (sparse/active/anchor counts with territory names), topology health (M2 entropy, Gini), orphan territories, and bridge territories.',
      inputSchema: {
        type: 'object',
        properties: {
          orphans: { type: 'boolean', description: 'Include orphan territories (default true)' },
          bridges: { type: 'boolean', description: 'Include bridge territories (default true)' },
          scale:   { type: 'string', enum: ['immediate', 'session', 'daily', 'weekly'], description: 'Temporal scale (default: weekly)' },
        },
      },
    },
    {
      name: 'listTerritories',
      description: 'List and filter territories by vitality phase, realm, message count, or activity. Returns name, ID, vitality score, phase, message count, realm, and last active date.',
      inputSchema: {
        type: 'object',
        properties: {
          phase:       { type: 'string', enum: ['sparse', 'active', 'anchor'], description: 'Filter by vitality phase' },
          realm:       { type: 'number', description: 'Filter by realm ID' },
          minMessages: { type: 'number', description: 'Minimum message count' },
          sortBy:      { type: 'string', enum: ['vitality', 'messages', 'name'], description: 'Sort order (default: vitality desc)' },
          limit:       { type: 'number', description: 'Max results (default 20)' },
        },
      },
    },
    {
      name: 'territoryDetail',
      description: 'Deep view of a single territory — identity, story, vitality breakdown, activity timeline, and sample messages. Use this to understand what a territory IS, not just what it connects to.',
      inputSchema: {
        type: 'object',
        properties: {
          territory: { description: 'Territory name (fuzzy-matched) or numeric ID' },
        },
        required: ['territory'],
      },
    },
    {
      name: 'timeView',
      description: 'Temporal lens on a territory or the whole mindscape. Shows activity timeline, peak periods, dormancy, and trend direction.',
      inputSchema: {
        type: 'object',
        properties: {
          territory: { description: 'Territory name or ID (omit for whole mindscape overview)' },
          range:     { type: 'string', enum: ['7d', '30d', '90d', 'all'], description: 'Time range (default: 90d)' },
        },
      },
    },
  ];

  const handlers = {
    exploreTerritory: async (args) => {
      const { id: territoryId, name: resolvedName } = await resolveTerritoryId(args.territory);
      if (territoryId === null) {
        return `Could not find territory: "${args.territory}". Try searchMindscape to find the right name.`;
      }

      const scale = args.scale || 'session';
      const includeCoFiring = args.includeCoFiring !== false;  // default true
      const includeGaps     = args.includeGaps !== false;       // default true
      const depth = args.depth || 1;

      const fetches = {};
      if (includeCoFiring) fetches.coFiring = fetchCoFiring(territoryId, { scale, limit: 10 }).catch(() => []);
      if (includeGaps)     fetches.gaps     = fetchGaps(territoryId, { scale }).catch(() => []);
      if (depth > 1)       fetches.cluster  = fetchCluster(territoryId, { depth, scale }).catch(() => []);
      fetches.vitality = db.rawQuery(
        `SELECT current_vitality, current_phase, coherence, energy FROM territory_profiles WHERE user_id = ? AND territory_id = ?`,
        [userId, territoryId],
      ).catch(() => []);

      const keys = Object.keys(fetches);
      const results = await Promise.all(Object.values(fetches));
      const data = {};
      keys.forEach((k, i) => { data[k] = results[i]; });

      const sections = [];
      const label = resolvedName || `Territory ${territoryId}`;
      const freqArr = Array.isArray(data.vitality) ? data.vitality : (data.vitality?.results || []);
      const freq = freqArr[0];
      const freqLabel = freq?.current_phase ? ` [${freq.current_phase} · ${(freq.current_vitality || 0).toFixed(2)}]` : '';
      sections.push(`# ${label} (ID: ${territoryId})${freqLabel}`);

      if (data.coFiring) {
        const formatted = formatCoFiring(data.coFiring);
        sections.push(formatted ? `## Co-firing Partners\n${formatted}` : '## Co-firing Partners\nNone found at this scale.');
      }
      if (data.gaps) {
        const formatted = formatGaps(data.gaps);
        sections.push(formatted ? `## Gaps (unexplored connections)\n${formatted}` : '## Gaps\nNo significant gaps found.');
      }
      if (data.cluster) {
        const formatted = formatCluster(data.cluster);
        sections.push(formatted ? `## Cluster (depth ${depth})\n${formatted}` : '## Cluster\nNo connected cluster found.');
      }

      return sections.join('\n\n');
    },

    mindscapeStructure: async (args) => {
      const showOrphans = args.orphans !== false;  // default true
      const showBridges = args.bridges !== false;  // default true
      const scale = args.scale || 'weekly';

      const fetches = {};
      if (showOrphans) fetches.orphans = fetchOrphans({ scale });
      if (showBridges) fetches.bridges = fetchBridges({ scale });
      // current_vitality is ENCRYPTED (SEC-3) — can't AVG/ORDER BY in SQL. Fetch
      // the rows (message_count>0 / IS NOT NULL stay valid on plaintext/NULL) and
      // derive the phase map + top-15 in JS over decrypted values (below).
      fetches.vitalityRows = db.rawQuery(
        `SELECT territory_id, name, current_vitality, current_phase, message_count, realm_id
         FROM territory_profiles
         WHERE user_id = ? AND message_count > 0 AND current_vitality IS NOT NULL AND dissolved_at IS NULL`,
        [userId],
      ).catch(() => []);
      fetches.audit = db.rawQuery(
        `SELECT m2_entropy, m2_trend, catchall_count, orphan_count, degree_gini
         FROM topology_audit_snapshots WHERE user_id = ? ORDER BY run_at DESC LIMIT 1`,
        [userId],
      ).catch(() => []);

      const keys = Object.keys(fetches);
      const results = await Promise.all(Object.values(fetches));
      const data = {};
      keys.forEach((k, i) => { data[k] = results[i]; });

      // Derive vitality distribution + top territories in JS (current_vitality decrypted).
      {
        const vrows = (Array.isArray(data.vitalityRows) ? data.vitalityRows : (data.vitalityRows?.results || []))
          .map((r) => ({ ...r, current_vitality: Number(r.current_vitality) }))
          .filter((r) => Number.isFinite(r.current_vitality));
        const byPhase = new Map();
        for (const r of vrows) {
          const g = byPhase.get(r.current_phase) || { current_phase: r.current_phase, count: 0, sum: 0 };
          g.count += 1; g.sum += r.current_vitality; byPhase.set(r.current_phase, g);
        }
        data.vitalityMap = [...byPhase.values()]
          .map((g) => ({ current_phase: g.current_phase, count: g.count, avg_freq: Math.round((g.sum / g.count) * 1000) / 1000 }))
          .sort((a, b) => b.avg_freq - a.avg_freq);
        data.topTerritories = vrows
          .map((r) => ({ ...r, current_vitality: Math.round(r.current_vitality * 1000) / 1000 }))
          .sort((a, b) => b.current_vitality - a.current_vitality)
          .slice(0, 15);
      }

      const sections = ['# Mindscape Structure'];

      const freqMap = Array.isArray(data.vitalityMap) ? data.vitalityMap : (data.vitalityMap?.results || []);
      if (freqMap.length) {
        const freqLines = freqMap.map(r => `- **${r.current_phase}**: ${r.count} territories (avg ${r.avg_freq})`);
        sections.push(`## Vitality Distribution\n${freqLines.join('\n')}`);
      }

      const topArr = Array.isArray(data.topTerritories) ? data.topTerritories : (data.topTerritories?.results || []);
      if (topArr.length) {
        const anchors = topArr.filter(t => t.current_phase === 'anchor');
        const actives = topArr.filter(t => t.current_phase === 'active').slice(0, 5);
        const lines = [];
        if (anchors.length) {
          lines.push('**Anchor** (bridging — high vitality, persistent core):');
          for (const t of anchors) lines.push(`  - ${t.name} (T${t.territory_id}) · ${t.current_vitality} · ${t.message_count} msgs`);
        }
        if (actives.length) {
          lines.push('**Active** (growing — mid-range, regularly engaged):');
          for (const t of actives) lines.push(`  - ${t.name} (T${t.territory_id}) · ${t.current_vitality} · ${t.message_count} msgs`);
        }
        sections.push(`## Top Territories\n${lines.join('\n')}`);
      }

      const auditArr = Array.isArray(data.audit) ? data.audit : (data.audit?.results || []);
      const audit = auditArr[0];
      if (audit) {
        // T1: topology_audit_snapshots metric columns are ENCRYPTED at rest; the
        // adapter auto-decrypts them to STRINGS, so Number()-coerce the numerics
        // for display (m2_trend stays a categorical string). Mirrors SEC-3's
        // current_vitality handling above.
        const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
        const m2 = num(audit.m2_entropy), gini = num(audit.degree_gini);
        const cat = num(audit.catchall_count), orph = num(audit.orphan_count);
        sections.push(`## Topology Health\nM2 entropy: ${m2 != null ? m2.toFixed(3) : '?'} (${audit.m2_trend}) · Gini: ${gini != null ? gini.toFixed(3) : '?'} · ${cat ?? '?'} catch-all · ${orph ?? '?'} orphan`);
      }

      if (data.orphans !== undefined) {
        const formatted = formatOrphans(data.orphans);
        sections.push(formatted
          ? `## Orphan Territories\n*High content, low connectivity — may indicate holding patterns, avoidance, or unintegrated experiences.*\n\n${formatted}`
          : '## Orphan Territories\nNone found.');
      }
      if (data.bridges !== undefined) {
        const formatted = formatBridges(data.bridges);
        sections.push(formatted
          ? `## Bridge Territories\n*Connect different realms — structural integration points.*\n\n${formatted}`
          : '## Bridge Territories\nNone found.');
      }

      return sections.join('\n\n');
    },

    listTerritories: async (args) => {
      const phaseFilter = args.phase        ? `AND current_phase = ?` : '';
      const realmFilter = args.realm != null ? `AND realm_id = ?`     : '';
      const msgFilter   = args.minMessages   ? `AND message_count >= ?` : '';
      const sortCol = args.sortBy === 'messages' ? 'message_count' : args.sortBy === 'name' ? 'name' : 'current_vitality';
      const sortDir = args.sortBy === 'name' ? 'ASC' : 'DESC';
      const limit = args.limit || 20;

      const params = [userId];
      if (args.phase)         params.push(args.phase);
      if (args.realm != null) params.push(args.realm);
      if (args.minMessages)   params.push(args.minMessages);
      params.push(limit);

      const rows = await db.rawQuery(
        `SELECT territory_id, name, current_vitality, current_phase, message_count, realm_id, coherence, energy,
                first_active, last_active
         FROM territory_profiles
         WHERE user_id = ? AND message_count > 0 AND COALESCE(is_catchall, 0) = 0
           AND dissolved_at IS NULL
           ${phaseFilter} ${realmFilter} ${msgFilter}
         ORDER BY ${sortCol} ${sortDir}
         LIMIT ?`,
        params,
      ).catch(() => []);

      const list = (Array.isArray(rows) ? rows : (rows?.results || []));
      if (!list.length) return 'No territories match those filters.';

      const lines = list.map(t => {
        const freq = t.current_vitality != null ? t.current_vitality.toFixed(2) : '?';
        const phase = t.current_phase || '?';
        const active = t.last_active ? ` · last ${new Date(t.last_active).toLocaleDateString()}` : '';
        return `**${t.name}** (T${t.territory_id}) · ${phase} ${freq} · ${t.message_count} msgs · realm ${t.realm_id}${active}`;
      });

      return `# Territories (${list.length} results)\n\n${lines.join('\n')}`;
    },

    territoryDetail: async (args) => {
      const { id: tid, name: tName } = await resolveTerritoryId(args.territory);
      if (tid === null) return `Could not find territory: "${args.territory}".`;

      const [profile, freq, themeRows, samplePts] = await Promise.all([
        db.rawQuery(
          `SELECT territory_id, name, essence, archetype_type, archetype_character,
                  story_birth, story_arc, story_current_chapter, story_peak_moments,
                  message_count, coherence, energy, realm_id, first_active, last_active,
                  activity_timeline, current_vitality, current_phase, explored_percent,
                  agent_expertise, agent_curious_about
           FROM territory_profiles WHERE user_id = ? AND territory_id = ?`,
          [userId, tid],
        ).catch(() => []),
        db.rawQuery(
          `SELECT entropy_diversification, connection_growth_rate, reach, cofire_partner_diversity, computed_at
           FROM territory_vitality WHERE user_id = ? AND territory_id = ?
           ORDER BY computed_at DESC LIMIT 1`,
          [userId, tid],
        ).catch(() => []),
        db.rawQuery(
          `SELECT st.name, st.essence FROM semantic_themes st
           JOIN clustering_points cp ON cp.theme_id = st.semantic_theme_id AND cp.user_id = st.user_id
           WHERE cp.user_id = ? AND cp.territory_id = ?
           LIMIT 1`,
          [userId, tid],
        ).catch(() => []),
        db.rawQuery(
          `SELECT m.content, m.role, m.created_at, m.source FROM messages m
           JOIN clustering_points cp ON cp.source_id = m.id AND cp.source_type = 'message'
           WHERE cp.user_id = ? AND cp.territory_id = ? AND m.forgotten_at IS NULL
           ORDER BY m.created_at DESC LIMIT 3`,
          [userId, tid],
        ).catch(() => []),
      ]);

      const p = (Array.isArray(profile) ? profile : profile?.results || [])[0];
      if (!p) return `Territory ${tid} not found.`;

      const f = (Array.isArray(freq) ? freq : freq?.results || [])[0];
      const theme   = (Array.isArray(themeRows) ? themeRows : themeRows?.results || [])[0];
      const samples =  Array.isArray(samplePts) ? samplePts : samplePts?.results || [];

      const sections = [];
      const stateLabel = p.current_phase ? ` [${p.current_phase} · ${(p.current_vitality || 0).toFixed(2)}]` : '';
      sections.push(`# ${p.name} (T${p.territory_id})${stateLabel}`);

      sections.push(`## Identity\nRealm: ${p.realm_id} · Messages: ${p.message_count} · Explored: ${p.explored_percent || 0}%\nFirst: ${p.first_active || '?'} · Last: ${p.last_active || '?'}\nVitality: ${(p.coherence || 0).toFixed(3)} · Energy: ${(p.energy || 0).toFixed(4)}${p.archetype_type ? `\nArchetype: ${p.archetype_type}${p.archetype_character ? ' — ' + p.archetype_character : ''}` : ''}${theme ? `\nTheme: ${theme.name}` : ''}`);

      if (p.essence) sections.push(`## Essence\n${p.essence}`);

      if (p.story_birth || p.story_arc || p.story_current_chapter) {
        const story = [];
        if (p.story_birth)           story.push(`**Birth**: ${p.story_birth}`);
        if (p.story_arc)             story.push(`**Arc**: ${p.story_arc}`);
        if (p.story_current_chapter) story.push(`**Current chapter**: ${p.story_current_chapter}`);
        if (p.story_peak_moments) {
          const peaks = typeof p.story_peak_moments === 'string' ? JSON.parse(p.story_peak_moments) : p.story_peak_moments;
          if (peaks?.length) story.push(`**Peak moments**: ${peaks.join('; ')}`);
        }
        sections.push(`## Story\n${story.join('\n')}`);
      }

      if (f) {
        // T1: territory_vitality metric columns are ENCRYPTED at rest → the
        // adapter decrypts them to STRINGS. Coerce for display (round to 3dp).
        const fnum = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : v; };
        sections.push(`## Vitality Breakdown\nScore: ${(p.current_vitality || 0).toFixed(3)} (${p.current_phase})\n  entropy_diversification: ${fnum(f.entropy_diversification)}\n  connection_growth_rate: ${fnum(f.connection_growth_rate)}\n  reach: ${fnum(f.reach)}\n  cofire_partner_diversity: ${fnum(f.cofire_partner_diversity)}`);
      }

      if (p.activity_timeline) {
        const timeline = typeof p.activity_timeline === 'string' ? JSON.parse(p.activity_timeline) : p.activity_timeline;
        if (timeline?.length) {
          const recent = timeline.slice(-6);
          const maxCount = Math.max(...recent.map(t => t.count || 0), 1);
          const bars = recent.map(t => {
            const bar = '█'.repeat(Math.round(((t.count || 0) / maxCount) * 12));
            return `  ${t.month}: ${bar} ${t.count}`;
          });
          sections.push(`## Activity (last ${recent.length} months)\n${bars.join('\n')}`);
        }
      }

      if (samples.length) {
        const msgs = samples.map(m => {
          const date = (m.created_at || '').slice(0, 10);
          const content = (m.content || '').slice(0, 200);
          return `[${date}] ${m.role}: ${content}${m.content?.length > 200 ? '...' : ''}`;
        });
        sections.push(`## Recent Messages\n${msgs.join('\n\n')}`);
      }

      return sections.join('\n\n');
    },

    timeView: async (args) => {
      const range = args.range || '90d';
      const daysBack = range === '7d' ? 7 : range === '30d' ? 30 : range === '90d' ? 90 : 3650;

      if (args.territory) {
        const { id: tid } = await resolveTerritoryId(args.territory);
        if (tid === null) return `Could not find territory: "${args.territory}"`;

        const profile = await db.rawQuery(
          `SELECT name, message_count, first_active, last_active, activity_timeline, current_phase, current_vitality
           FROM territory_profiles WHERE user_id = ? AND territory_id = ?`,
          [userId, tid],
        ).catch(() => []);

        const p = (Array.isArray(profile) ? profile : profile?.results || [])[0];
        if (!p) return `Territory ${tid} not found.`;

        const sections = [`# Timeline: ${p.name} (T${tid})`];
        sections.push(`Range: last ${range}\nTotal messages: ${p.message_count}\nFirst: ${p.first_active || '?'} · Last: ${p.last_active || '?'}\nState: ${p.current_phase} (${(p.current_vitality || 0).toFixed(2)})`);

        if (p.activity_timeline) {
          const timeline = typeof p.activity_timeline === 'string' ? JSON.parse(p.activity_timeline) : p.activity_timeline;
          if (timeline?.length) {
            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - daysBack);
            const filtered = range === 'all' ? timeline : timeline.filter(t => new Date(t.month + '-01') >= cutoff);
            const maxCount = Math.max(...filtered.map(t => t.count || 0), 1);

            const bars = filtered.map(t => {
              const bar = '█'.repeat(Math.round(((t.count || 0) / maxCount) * 16));
              return `  ${t.month}: ${bar} ${t.count}`;
            });
            const peak = filtered.reduce((best, t) => (t.count || 0) > (best.count || 0) ? t : best, { count: 0 });
            sections.push(`## Monthly Activity\n${bars.join('\n')}\n\nPeak: ${peak.month} (${peak.count} messages)`);
          }
        }

        return sections.join('\n\n');
      }

      // Whole-mindscape overview — derives recency from activity_timeline
      // because the last_active column isn't always populated.
      const overview = await db.rawQuery(
        `SELECT territory_id, name, message_count, activity_timeline, current_phase, current_vitality
         FROM territory_profiles
         WHERE user_id = ? AND message_count > 0 AND COALESCE(is_catchall, 0) = 0
           AND dissolved_at IS NULL
         ORDER BY message_count DESC LIMIT 200`,
        [userId],
      ).catch(() => []);

      const rows = Array.isArray(overview) ? overview : overview?.results || [];
      if (!rows.length) return `# Mindscape Timeline (${range})\n\nNo territories with activity.`;

      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - daysBack);
      const cutoffMonth = cutoff.toISOString().slice(0, 7);

      const enriched = rows.map(r => {
        let timeline = [];
        try {
          timeline = typeof r.activity_timeline === 'string' ? JSON.parse(r.activity_timeline) : (r.activity_timeline || []);
        } catch { timeline = []; }
        const inRange = range === 'all' ? timeline : timeline.filter(t => t.month && t.month >= cutoffMonth);
        const rangeCount = inRange.reduce((s, t) => s + (t.count || 0), 0);
        const lastMonth = timeline.length ? timeline[timeline.length - 1].month : null;
        return { ...r, lastMonth, rangeCount, timeline };
      });

      const active = enriched.filter(r => r.rangeCount > 0).sort((a, b) => b.rangeCount - a.rangeCount);
      const totalActive = active.reduce((s, r) => s + r.rangeCount, 0);

      const monthlyTotals = new Map();
      for (const r of active) {
        for (const t of r.timeline) {
          if (range !== 'all' && (!t.month || t.month < cutoffMonth)) continue;
          monthlyTotals.set(t.month, (monthlyTotals.get(t.month) || 0) + (t.count || 0));
        }
      }
      const monthEntries = Array.from(monthlyTotals.entries()).sort(([a], [b]) => a.localeCompare(b));

      const sections = [`# Mindscape Timeline (${range})`];
      sections.push(
        `Active territories: ${active.length} / ${rows.length}\n` +
        `Total messages in range: ${totalActive}\n` +
        `Peak territory: ${active[0]?.name || 'n/a'} (${active[0]?.rangeCount || 0} msgs)`,
      );

      if (monthEntries.length) {
        const maxCount = Math.max(...monthEntries.map(([, c]) => c), 1);
        const bars = monthEntries.map(([month, count]) => {
          const bar = '█'.repeat(Math.round((count / maxCount) * 16));
          return `  ${month}: ${bar} ${count}`;
        });
        const peak = monthEntries.reduce((best, cur) => cur[1] > best[1] ? cur : best);
        sections.push(`## Monthly Activity (all territories)\n${bars.join('\n')}\n\nPeak month: ${peak[0]} (${peak[1]} messages)`);
      }

      if (active.length) {
        const lines = active.slice(0, 10).map(r =>
          `- **${r.name}** (T${r.territory_id}) · ${r.rangeCount} msgs in range · ${r.current_phase || '?'} (${(r.current_vitality || 0).toFixed(2)}) · last ${r.lastMonth || '?'}`,
        );
        sections.push(`## Most Active Territories\n${lines.join('\n')}`);
      }

      return sections.join('\n\n');
    },

  };

  return { tools, handlers };
}
