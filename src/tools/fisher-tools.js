/**
 * Fisher trajectory MCP tools — four tools that surface cognitive
 * movement metrics to agents.
 *
 *   getCurrentPhase     — "Where am I right now?" — orientation signal.
 *   getTrajectoryHistory — "What was my last month/quarter like?"
 *   getActiveMilestones — "What just changed?" — phase-shift / cycling alerts.
 *   getTopMovers        — "Which territories drove this week's movement?"
 *
 * The handlers query through db.fisher.* (see packages/core/db-d1/fisher.js)
 * — they NEVER inline rawQuery, so scope filtering and tenant isolation
 * pass through the canonical DB layer.
 *
 * Spec: docs/architecture/FISHER-TRAJECTORY.md
 * Plan: docs/architecture/FISHER-IMPLEMENTATION.md (§6)
 *
 * @typedef {object} FisherToolsDeps
 * @property {object} db       — needs db.fisher.* (and db.topology for territory names)
 * @property {string} userId
 */

export function createFisherToolsDomain(deps) {
  if (!deps) throw new TypeError('createFisherToolsDomain: deps required');
  const { db, userId } = deps;
  if (!db?.fisher) throw new TypeError('createFisherToolsDomain: db.fisher required');
  if (typeof userId !== 'string') throw new TypeError('createFisherToolsDomain: userId required');

  const tools = [
    {
      name: 'getCurrentPhase',
      description:
        'Your cognitive MOVEMENT right now (vs getHarmonicState, which is cognitive RHYTHM). Returns the current phase — stable / cycling / exploring / transforming — plus how much of the motion is outward exploration vs revisiting, how far the thinking has travelled, and whether it is speeding up or slowing down.\n\nUse at the start of a conversation to orient — the phase is decision-steering: "cycling" → prefer integration moves; "transforming" → support the trajectory; "stable" → hold ground; "exploring" → follow divergence.\n\nPass level="all" to get realm, theme, and territory in one call — useful when phases differ across scales (e.g., realm cycling but theme exploring suggests local growth inside a stable larger arc).',
      inputSchema: {
        type: 'object',
        properties: {
          level: {
            type: 'string',
            enum: ['realm', 'theme', 'territory', 'all'],
            description: 'Hierarchy level. "all" returns all three in one response. (default: realm — most stable across reclustering)',
          },
        },
      },
    },
    {
      name: 'getTrajectoryHistory',
      description:
        'Cognitive trajectory over a time period. Returns weekly_step rows (or whichever windowType is requested) with phase, velocity, displacement, exploration_ratio, and top contributors per window, ordered chronologically (oldest first).\n\n`period` is the easy way: "month" | "quarter" | "half_year" | "year" | "all". Defaults to "quarter" (last 90 days) — the right scope for most "how have I been lately" questions. Use "all" to see everything (multi-year history available; the user has data going back to 2018).\n\nFor specific custom ranges, pass `from` and/or `to` instead — they take precedence over `period` when given.',
      inputSchema: {
        type: 'object',
        properties: {
          level: {
            type: 'string',
            enum: ['realm', 'theme', 'territory'],
            description: 'Hierarchy level (default: realm)',
          },
          windowType: {
            type: 'string',
            enum: ['daily', 'weekly_rolling', 'weekly_step', 'monthly'],
            description: 'Window type (default: weekly_step — non-overlapping, statistically honest)',
          },
          period: {
            type: 'string',
            enum: ['month', 'quarter', 'half_year', 'year', 'all'],
            description: 'Time scope preset. Default: "quarter" (last 90 days). "all" returns full history.',
          },
          from: { type: 'string', description: 'Custom range: ISO timestamp lower bound (inclusive). Overrides period when set.' },
          to:   { type: 'string', description: 'Custom range: ISO timestamp upper bound (inclusive). Overrides period when set.' },
          limit: { type: 'number', description: 'Max rows (default 500, max 1000). Mostly redundant with period; kept for safety on full-history calls.' },
        },
      },
    },
    {
      name: 'getActiveMilestones',
      description:
        'Active (undismissed) milestone alerts: phase shifts, sustained cycling, velocity outliers. These are pre-rendered "what just changed" signals — read them to know whether to surface a transition or pattern unprompted.',
      inputSchema: {
        type: 'object',
        properties: {
          includeDismissed: { type: 'boolean', description: 'Include dismissed milestones (audit trail; default false)' },
          limit: { type: 'number', description: 'Max rows (default 20)' },
        },
      },
    },
    {
      name: 'getTopMovers',
      description:
        'Which territories (or realms) drove the most recent week\'s cognitive movement. Returns top contributors with direction (+/-) and percentage of the squared-chord step distance attributable to each. Hydrates territory IDs to names where possible.\n\nUse to answer "what shifted this week?" — names + directions, not just abstract numbers.',
      inputSchema: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['realm', 'theme', 'territory'], description: 'Hierarchy level (default realm)' },
          windowEnd: { type: 'string', description: 'Specific window end ISO (default: latest)' },
        },
      },
    },
  ];

  // ── Formatters (markdown) ──────────────────────────────────────────────

  function formatPhase(phaseRow) {
    if (!phaseRow) {
      return 'No trajectory data yet — the Fisher pipeline has not produced a weekly_step row for this level. Run the clustering pipeline or wait for the daily cron.';
    }
    const lines = [];
    // Phase 1: prefer phase_recent (rolling 90-day window) over the
    // legacy cumulative `phase` column, which is degenerate for users
    // with non-trivial history (R = D/L → 0). Coalesce keeps backward
    // compat for windows still on the legacy compute (pre-PR-1.4 fleet
    // recompute) where phase_recent is NULL.
    const phase = phaseRow.phase_recent || phaseRow.phase || 'unknown';
    lines.push(`**Phase**: ${phase}`);
    lines.push(`Window: ${(phaseRow.window_start || '').slice(0, 10)} → ${(phaseRow.window_end || '').slice(0, 10)}`);
    const r = phaseRow.R_recent != null ? phaseRow.R_recent : phaseRow.exploration_ratio;
    if (r != null) {
      const label = phaseRow.R_recent != null ? 'R_recent (rolling 90d)' : 'Exploration ratio (D/L)';
      lines.push(`${label}: ${Number(r).toFixed(2)}`);
    }
    if (phaseRow.fisher_velocity != null) {
      lines.push(`Velocity: ${Number(phaseRow.fisher_velocity).toFixed(3)}`);
    }
    if (phaseRow.fisher_velocity_z != null) {
      lines.push(`Velocity z-score: ${Number(phaseRow.fisher_velocity_z).toFixed(2)}σ`);
    }
    if (phaseRow.fisher_trajectory_length != null) {
      lines.push(`Trajectory length L: ${Number(phaseRow.fisher_trajectory_length).toFixed(2)}`);
    }
    if (phaseRow.fisher_displacement != null) {
      lines.push(`Displacement D: ${Number(phaseRow.fisher_displacement).toFixed(2)}`);
    }
    if (phaseRow.low_confidence) {
      lines.push(`_low_confidence: this window has insufficient data; treat as advisory_`);
    }
    return lines.join('\n');
  }

  function formatTrajectoryRow(r) {
    const date = (r.window_end || '').slice(0, 10);
    // Phase 1: prefer phase_recent / R_recent over legacy columns (see formatPhase).
    const phaseStr = (r.phase_recent || r.phase || '?').padEnd(13);
    const v = r.fisher_velocity != null ? Number(r.fisher_velocity).toFixed(3) : '   —';
    const z = r.fisher_velocity_z != null ? `${Number(r.fisher_velocity_z).toFixed(1)}σ` : ' —';
    const r_value = r.R_recent != null ? r.R_recent : r.exploration_ratio;
    const r_ratio = r_value != null ? Number(r_value).toFixed(2) : '  —';
    const flag = r.low_confidence ? ' [low-conf]' : '';
    return `${date}  ${phaseStr}  v=${v}  z=${z}  R=${r_ratio}${flag}`;
  }

  function formatMilestone(m) {
    const date = (m.detected_at || '').slice(0, 10);
    const lines = [`**${m.rule_type}** (${date}) — ${m.headline || '(no headline)'}`];
    if (m.rule_type === 'phase_shift' && m.phase_from && m.phase_to) {
      lines.push(`  ${m.phase_from} → ${m.phase_to}`);
    }
    if (m.rule_type === 'velocity_outlier' && m.velocity_z != null) {
      lines.push(`  z = ${Number(m.velocity_z).toFixed(2)}σ`);
    }
    return lines.join('\n');
  }

  function formatMover(m) {
    const dir = m.direction === '+' ? '↑' : m.direction === '-' ? '↓' : '·';
    const pct = m.pct != null ? `${(m.pct * 100).toFixed(0)}%` : '—';
    const name = m.name || m.id || '(unknown)';
    return `${dir} ${name} (${pct})`;
  }

  // ── Handlers ──────────────────────────────────────────────────────────

  const handlers = {
    getCurrentPhase: async (args = {}) => {
      const level = args.level || 'realm';
      const milestones = await db.fisher.getActiveMilestones(userId, { limit: 1 });

      // Multi-level mode: render all three side-by-side.
      if (level === 'all') {
        const all = await db.fisher.getCurrentPhase(userId, { level: 'all' });
        const sections = ['# Cognitive Movement (all levels)', ''];
        if (!all) {
          sections.push('No trajectory data yet at any level.');
        } else {
          for (const lvl of ['realm', 'theme', 'territory']) {
            sections.push(`## ${lvl[0].toUpperCase()}${lvl.slice(1)}`);
            sections.push(formatPhase(all[lvl]));
            sections.push('');
          }
        }
        if (milestones.length > 0) {
          sections.push('## Active milestone (realm-level)');
          sections.push(formatMilestone(milestones[0]));
        }
        return sections.join('\n').trimEnd();
      }

      // Single-level mode (the default).
      const phaseRow = await db.fisher.getCurrentPhase(userId, { level });
      const sections = [`# Cognitive Movement (level: ${level})`, ''];
      sections.push(formatPhase(phaseRow));
      if (milestones.length > 0) {
        sections.push('');
        sections.push('## Active milestone');
        sections.push(formatMilestone(milestones[0]));
      }
      return sections.join('\n');
    },

    getTrajectoryHistory: async (args = {}) => {
      const level = args.level || 'realm';
      const windowType = args.windowType || 'weekly_step';
      const limit = args.limit || 500;

      // Time scope: explicit from/to wins; otherwise apply `period` preset.
      // Default period is 'quarter' (last 90 days) — the right scope for
      // "how have I been lately" without flooding the response.
      const PERIOD_DAYS = {
        month: 30, quarter: 90, half_year: 180, year: 365, all: null,
      };
      let from = args.from;
      let to = args.to;
      if (!from && !to) {
        const period = args.period || 'quarter';
        if (!(period in PERIOD_DAYS)) {
          return `# Trajectory error\n\nInvalid period "${period}". Use one of: ${Object.keys(PERIOD_DAYS).join(', ')}, or pass from/to.`;
        }
        const days = PERIOD_DAYS[period];
        if (days != null) {
          const fromDate = new Date(Date.now() - days * 86400 * 1000);
          from = fromDate.toISOString();
        }
        // period === 'all' → leave from/to undefined → full history.
      }

      const rows = await db.fisher.getTrajectory(userId, {
        level, windowType, from, to, limit,
      });

      if (rows.length === 0) {
        return `# Trajectory (${level} / ${windowType})\n\nNo data in the requested range.`;
      }

      const lines = [`# Trajectory (${level} / ${windowType}) — ${rows.length} windows`, ''];
      lines.push('```');
      lines.push('date         phase           velocity   z       R');
      for (const r of rows) lines.push(formatTrajectoryRow(r));
      lines.push('```');
      return lines.join('\n');
    },

    getActiveMilestones: async (args = {}) => {
      const ms = await db.fisher.getActiveMilestones(userId, {
        includeDismissed: !!args.includeDismissed,
        limit: args.limit || 20,
      });
      if (ms.length === 0) {
        return '# Milestones\n\nNo active milestones.';
      }
      const lines = [`# Milestones — ${ms.length} active`, ''];
      for (const m of ms) {
        lines.push(formatMilestone(m));
        lines.push('');
      }
      return lines.join('\n').trim();
    },

    getTopMovers: async (args = {}) => {
      const level = args.level || 'realm';
      const movers = await db.fisher.getTopMovers(userId, {
        level, windowEnd: args.windowEnd,
      });

      if (movers.length === 0) {
        return `# Top movers\n\nNo top contributors recorded for the latest ${level} window.`;
      }

      // Hydrate territory names where possible. Territory IDs in
      // top_contributors are stringified ints; territory_profiles.territory_id
      // is INT. db.rawQuery (read-only) is OK here since we only fetch names.
      const ids = movers.map((m) => parseInt(m.id, 10)).filter(Number.isFinite);
      let nameMap = new Map();
      if (level === 'territory' && ids.length && db.rawQuery) {
        try {
          const placeholders = ids.map(() => '?').join(',');
          const rows = await db.rawQuery(
            `SELECT territory_id, name FROM territory_profiles
             WHERE user_id = ? AND territory_id IN (${placeholders})`,
            [userId, ...ids],
          );
          for (const r of (rows.results || rows || [])) {
            nameMap.set(String(r.territory_id), r.name);
          }
        } catch {
          // Best-effort name resolution; fall through to IDs only.
        }
      }

      const hydrated = movers.map((m) => ({
        ...m,
        name: nameMap.get(String(m.id)) || m.id,
      }));

      const lines = [`# Top movers (${level})`, ''];
      for (const m of hydrated) lines.push(formatMover(m));
      return lines.join('\n');
    },
  };

  return { tools, handlers };
}
