// src/tools/reflections.js — the reflection-record tools (Context Engine "day cards").
//
// recordReflection: each cycle ends by logging its reflective read as a dated, structured record
// (summary + red-thread themes + day-type), separate from model.md (the evolving scratchpad).
// listReflections: look back over days/weeks — the data behind day-categorization + red-threads.
const KNOWN_CYCLES = new Set(['morning', 'reflection', 'evening', 'triage', 'integration', 'weekly']);

export function createReflectionsDomain({ db, userId } = {}) {
  if (!db?.reflections) throw new TypeError('createReflectionsDomain: db.reflections required');

  const tools = [
    {
      name: 'recordReflection',
      description: 'Record your reflective read of this cycle as a dated "day card" — a structured digest you and your person can look back on to categorize days and trace red threads over time. Call it once at the end of a reflection cycle. This is SEPARATE from model.md (your evolving private scratchpad) — it is the retrospective record.',
      inputSchema: {
        type: 'object',
        properties: {
          cycle:    { type: 'string', description: 'which cycle this is (morning | reflection | evening | triage | integration | weekly)' },
          summary:  { type: 'string', description: '1-2 sentence digest of what this reflection found' },
          themes:   { type: 'array', items: { type: 'string' }, description: 'the red threads you noticed, as short labels (e.g. ["publishing block", "practice streak"])' },
          day_type: { type: 'string', description: "the kind of day in your read (e.g. 'build-heavy launch day', 'low-energy recovery')" },
          day:      { type: 'string', description: 'the date this is about (YYYY-MM-DD); defaults to today' },
          body:     { type: 'string', description: 'optional fuller copy of your reflection' },
        },
        required: ['summary'],
      },
    },
    {
      name: 'listReflections',
      description: 'List your recent reflection records (day cards) for looking back over days or weeks. Optionally pass a date range (start + end, YYYY-MM-DD) to trace a stretch of time.',
      inputSchema: {
        type: 'object',
        properties: {
          start: { type: 'string', description: 'range start date YYYY-MM-DD (with end)' },
          end:   { type: 'string', description: 'range end date YYYY-MM-DD (with start)' },
          limit: { type: 'number', description: 'max records (default 30)' },
        },
      },
    },
  ];

  const handlers = {
    recordReflection: async (args = {}) => {
      const summary = String(args.summary || '').trim();
      if (!summary) return 'Error: summary is required.';
      const themes = Array.isArray(args.themes)
        ? args.themes.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().slice(0, 80)).slice(0, 8)
        : [];
      const cycle = KNOWN_CYCLES.has(args.cycle) ? args.cycle : 'adhoc';
      try {
        const id = await db.reflections.record(userId, {
          cycle,
          day: typeof args.day === 'string' ? args.day : undefined,
          summary: summary.slice(0, 2000),
          themes,
          dayType: (typeof args.day_type === 'string' && args.day_type.trim()) ? args.day_type.trim().slice(0, 160) : null,
          body: (typeof args.body === 'string' && args.body.trim()) ? args.body.trim().slice(0, 8000) : null,
        });
        return `Recorded ${cycle} reflection (id ${id}).`;
      } catch { return 'Error: could not record the reflection.'; }
    },

    listReflections: async (args = {}) => {
      try {
        const recs = (typeof args.start === 'string' && typeof args.end === 'string')
          ? await db.reflections.listRange(userId, { start: args.start, end: args.end, limit: Number(args.limit) || 365 })
          : await db.reflections.recent(userId, { limit: Number(args.limit) || 30 });
        if (!recs.length) return 'No reflection records yet.';
        return recs
          .map((r) => `• [${r.day}] ${r.cycle}: ${r.summary}${r.themes.length ? `  (threads: ${r.themes.join(', ')})` : ''}${r.dayType ? `  — ${r.dayType}` : ''}`)
          .join('\n');
      } catch { return 'Error: could not list reflections.'; }
    },
  };

  return { tools, handlers };
}

export default createReflectionsDomain;
