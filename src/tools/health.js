/**
 * Health-data domain — single tool `getHealthData` that renders
 * Apple Health daily summaries (sleep, HRV, RHR, steps, workouts).
 *
 * Runs two parallel reads: the raw day-by-day range + the aggregated
 * summary (averages, trends, anomalies). Outputs a markdown report
 * with overall summary, trend arrows, flagged anomalies, then a
 * per-day breakdown.
 *
 * Tolerant of missing db.health namespace (returns a friendly
 * "not available" message rather than throwing) — sometimes an
 * agent is configured without the health integration.
 *
 * @typedef {object} HealthDeps
 * @property {() => any} getDb — lazy getter (matches pre-refactor behavior)
 * @property {string} userId
 */

export function createHealthDomain(deps) {
  if (!deps) throw new TypeError('createHealthDomain: deps required');
  const { getDb, userId } = deps;
  if (typeof getDb !== 'function')  throw new TypeError('createHealthDomain: getDb required');
  if (typeof userId !== 'string')   throw new TypeError('createHealthDomain: userId required');

  const tools = [
    {
      name: 'getHealthData',
      description: 'Query Apple Health data (sleep, HRV, resting HR, steps, workouts, mindful minutes). Returns daily summaries with averages, trends, and anomalies. Use to answer questions about physical state, sleep quality, stress patterns, and body-mind correlations.',
      inputSchema: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'Number of days to look back (default 7, max 90)' },
          from: { type: 'string', description: 'Start date (YYYY-MM-DD). Overrides days.' },
          to:   { type: 'string', description: 'End date (YYYY-MM-DD). Defaults to today.' },
        },
      },
    },
  ];

  const handlers = {
    getHealthData: async (args) => {
      const db = getDb();
      if (!db?.health) return 'Health data not available (database not configured).';
      const to   = args.to || new Date().toISOString().split('T')[0];
      const days = Math.min(args.days || 7, 90);
      const from = args.from || new Date(Date.now() - days * 86400000).toISOString().split('T')[0];

      const [range, summary] = await Promise.all([
        db.health.getRange(userId, from, to),
        db.health.getSummary(userId, days),
      ]);

      if (!range.length) return `No health data found between ${from} and ${to}.`;

      let result = `## Health Data: ${from} → ${to} (${range.length} days)\n\n`;

      if (summary.averages) {
        const a = summary.averages;
        const parts = [];
        if (a.sleep_duration_min != null) parts.push(`Sleep ${Math.floor(a.sleep_duration_min / 60)}h${Math.round(a.sleep_duration_min % 60)}m`);
        if (a.hrv_avg != null)            parts.push(`HRV ${Math.round(a.hrv_avg)}ms`);
        if (a.resting_hr != null)         parts.push(`RHR ${Math.round(a.resting_hr)}bpm`);
        if (a.steps != null)              parts.push(`Steps ${Math.round(a.steps).toLocaleString()}`);
        result += `**Averages:** ${parts.join(' | ')}\n`;
      }
      if (summary.trends) {
        const arrows = { improving: '↑', declining: '↓', stable: '→' };
        const tParts = [];
        for (const [k, v] of Object.entries(summary.trends)) {
          if (v !== 'insufficient') tParts.push(`${k}: ${arrows[v] || '→'} ${v}`);
        }
        if (tParts.length) result += `**Trends:** ${tParts.join(' | ')}\n`;
      }
      if (summary.anomalies?.length) {
        result += `**Anomalies:** ${summary.anomalies.map(a => `${a.date} ${a.metric}=${a.value} (baseline ${a.baseline})`).join('; ')}\n`;
      }

      result += `\n### Daily\n`;
      for (const d of range) {
        const parts = [];
        if (d.sleep_duration_min != null) parts.push(`Sleep ${Math.floor(d.sleep_duration_min / 60)}h${Math.round(d.sleep_duration_min % 60)}m`);
        if (d.hrv_avg != null)            parts.push(`HRV ${Math.round(d.hrv_avg)}`);
        if (d.resting_hr != null)         parts.push(`RHR ${Math.round(d.resting_hr)}`);
        if (d.steps != null)              parts.push(`${d.steps} steps`);
        if (d.workout_minutes > 0)        parts.push(`${Math.round(d.workout_minutes)}m workout`);
        result += `**${d.date}:** ${parts.join(' | ')}\n`;
      }

      return result;
    },
  };

  return { tools, handlers };
}
