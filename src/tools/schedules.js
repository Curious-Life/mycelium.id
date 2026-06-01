/**
 * Schedules domain — tools for the agent to manage its own wake cycles.
 *
 *   - schedule_task:      create a new cycle (the agent commits to do X at time Y)
 *   - list_my_schedules:  inspect the agent's current cycles (built-in + custom)
 *
 * The mutation tools (update_schedule, pause_schedule, resume_schedule,
 * cancel_schedule) were retired in the 2026-05-08 MCP refactor (zero MCP
 * calls in 7d for personal-agent). Operators manage cycles via the
 * portal Cycles tab — that surface remains. The scheduler module's
 * underlying APIs (updateCycle / pauseCycle / etc.) are still exported
 * for the portal route + any future restoration.
 *
 * Scoping: every agent process loads its own scheduler with its own
 * wake-cycles.json. These tools operate on that in-process state via
 * direct function calls — no HTTP, no auth dance, no round-trip. Each
 * agent only ever sees and mutates its own schedules.
 *
 * `when` argument on schedule_task:
 *   Accepts either the existing DSL directly (daily:8, every:4h,
 *   weekly:1:9, interval:30m) or a small set of natural-language
 *   phrases parsed to that DSL (see parseWhen below). If parsing
 *   fails, the tool rejects with a usage hint — the agent can then
 *   supply the DSL form explicitly.
 *
 * @typedef {object} SchedulesDeps
 * @property {object} scheduler  — exports from @mycelium/core/scheduler.js
 *   (createCycle, listCycles required; mutation APIs not consumed here)
 * @property {() => string} [randomUUID] — test seam for id generation
 */

import { randomUUID as nodeRandomUUID } from 'node:crypto';

/**
 * Convert a natural-language `when` phrase to the scheduler DSL.
 * Returns null if no pattern matches — caller should reject with a hint.
 *
 * Patterns (case-insensitive):
 *   - "daily at HH[:MM][am|pm]" / "every day at …" / "at … every day"
 *   - "every N hour[s]" / "every Nh"
 *   - "every N minute[s]" / "every Nm"         (min 30m enforced downstream)
 *   - "<weekday>[s] at HH[:MM][am|pm]" / "every <weekday> at …"
 *
 * DSL strings (`daily:8`, `every:4h`, …) are passed through as-is.
 */
export function parseWhen(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  if (!s) return null;

  // Pass-through: existing DSL
  if (/^(daily|weekly|every|interval):/.test(s)) return s;

  // "every N hour[s]" / "every Nh"
  const everyHours = s.match(/^every\s+(\d+)\s*h(our)?s?$/);
  if (everyHours) return `every:${everyHours[1]}h`;

  // "every N minute[s]" / "every Nm"
  const everyMin = s.match(/^every\s+(\d+)\s*m(in(ute)?s?)?$/);
  if (everyMin) return `interval:${everyMin[1]}m`;

  // Hour extractor: "9", "9am", "09:00", "9:30pm"
  const hourPattern = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/;

  // Weekdays
  const DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const WEEKDAY_RX = /(sun|mon|tue|wed|thu|fri|sat)(?:day)?s?/;

  // "<weekday>[s] at HH[:MM][am|pm]" / "every <weekday> at HH[:MM]"
  const weeklyMatch = s.match(new RegExp(`^(?:every\\s+)?${WEEKDAY_RX.source}\\s+(?:at\\s+)?${hourPattern.source}$`));
  if (weeklyMatch) {
    const dow = DOW[weeklyMatch[1]];
    let hour = parseInt(weeklyMatch[2], 10);
    const ampm = weeklyMatch[4];
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    if (Number.isFinite(dow) && hour >= 0 && hour < 24) return `weekly:${dow}:${hour}`;
  }

  // "daily at HH[:MM][am|pm]" / "every day at …" / "at … every day"
  const dailyMatch = s.match(new RegExp(`^(?:daily|every\\s+day)\\s+(?:at\\s+)?${hourPattern.source}$`))
    || s.match(new RegExp(`^at\\s+${hourPattern.source}\\s+(?:daily|every\\s+day)$`));
  if (dailyMatch) {
    let hour = parseInt(dailyMatch[1], 10);
    const ampm = dailyMatch[3];
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    if (hour >= 0 && hour < 24) return `daily:${hour}`;
  }

  return null;
}

function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'cycle';
}

export function createSchedulesDomain(deps) {
  if (!deps) throw new TypeError('createSchedulesDomain: deps required');
  const { scheduler, randomUUID = nodeRandomUUID } = deps;
  if (!scheduler) throw new TypeError('createSchedulesDomain: scheduler required');
  for (const fn of ['createCycle', 'listCycles']) {
    if (typeof scheduler[fn] !== 'function') throw new TypeError(`createSchedulesDomain: scheduler.${fn} required`);
  }

  function shortId() {
    // Short enough to stay human-readable in logs / portal rows.
    return randomUUID().split('-')[0];
  }

  const tools = [
    {
      name: 'schedule_task',
      description: 'Schedule a recurring task you will do on your own. Use this when the user asks you to do something regularly, or when you decide a practice would serve them. ALWAYS include a `purpose` explaining why — the user sees it in their Cycles tab and it lets them judge whether to keep the schedule. `when` accepts natural phrases like "daily at 9am", "every Monday at 7pm", "every 4 hours", "every 30 minutes", or the raw DSL (daily:9, weekly:1:19, every:4h, interval:30m). The `prompt` is what you tell yourself to do when it fires — write it in the imperative. Only set a non-default `delivery` (telegram/discord) when the user explicitly wants the result delivered there.',
      inputSchema: {
        type: 'object',
        properties: {
          name:     { type: 'string', description: 'Human-readable name, e.g. "Weekly reflection"' },
          when:     { type: 'string', description: 'Schedule phrase or DSL — see description for formats' },
          prompt:   { type: 'string', description: 'The instruction you fire for yourself (imperative)' },
          purpose:  { type: 'string', description: 'Why this schedule exists — user-facing rationale' },
          delivery: { type: 'string', enum: ['lifecycle', 'portal', 'telegram', 'discord', 'silent'], description: 'Default "lifecycle" — preserves current wake-cycle behavior. Non-default channels post the fired result elsewhere.' },
          delivery_target: { type: 'string', description: 'chat_id or channel_id when delivery is telegram/discord' },
          id:       { type: 'string', description: 'Optional explicit id (else generated from name)' },
        },
        required: ['name', 'when', 'prompt'],
      },
    },
    {
      name: 'list_my_schedules',
      description: 'Show your current cycles — built-in daily/weekly rhythms plus any custom schedules you\'ve committed to. Good starting point when the user asks "what are you planning?" or before you add something to avoid duplicates.',
      inputSchema: {
        type: 'object',
        properties: {
          include_paused: { type: 'boolean', description: 'Include paused/cancelled rows (default false)' },
        },
      },
    },
  ];

  const handlers = {
    schedule_task: async (args) => {
      const when = parseWhen(args.when);
      if (!when) {
        throw new Error(`Could not parse "${args.when}". Use DSL directly (e.g. daily:9, weekly:1:9, every:4h, interval:30m) or a phrase like "every Monday at 9am".`);
      }
      const id = args.id && /^[a-zA-Z0-9_-]{1,64}$/.test(args.id)
        ? args.id
        : `${slugify(args.name)}-${shortId()}`;

      const row = await scheduler.createCycle({
        id,
        description: args.name,
        schedule: when,
        prompt: args.prompt,
        purpose: args.purpose,
        delivery_channel: args.delivery || 'lifecycle',
        ...(args.delivery_target ? { delivery_target: args.delivery_target } : {}),
        created_by: 'agent',
      });
      return `Scheduled "${row.description}" (id: \`${row.id}\`, schedule: \`${row.schedule}\`${row.delivery_channel !== 'lifecycle' ? `, delivery: ${row.delivery_channel}` : ''})${row.purpose ? `\n  Purpose: ${row.purpose}` : ''}`;
    },

    list_my_schedules: async (args = {}) => {
      const all = scheduler.listCycles();
      const rows = args.include_paused
        ? all
        : all.filter((c) => c.status !== 'paused' && c.status !== 'cancelled' && c.enabled !== false);
      if (!rows.length) return 'No active schedules. Call schedule_task to add one.';

      const builtIn = rows.filter((c) => c.created_by === 'seed' || !c.created_by);
      const custom = rows.filter((c) => c.created_by && c.created_by !== 'seed');

      const lines = [];
      if (builtIn.length) {
        lines.push('**Built-in rhythms**');
        for (const c of builtIn) {
          lines.push(`- \`${c.id}\` — ${c.description} (${c.schedule})${c.status === 'paused' ? ' — PAUSED' : ''}`);
        }
      }
      if (custom.length) {
        lines.push(builtIn.length ? '\n**Custom schedules**' : '**Custom schedules**');
        for (const c of custom) {
          const tags = [c.schedule];
          if (c.delivery_channel && c.delivery_channel !== 'lifecycle') tags.push(`→ ${c.delivery_channel}`);
          if (c.status && c.status !== 'active') tags.push(c.status.toUpperCase());
          lines.push(`- \`${c.id}\` — ${c.description} (${tags.join(', ')})${c.purpose ? `\n    Purpose: ${c.purpose}` : ''}`);
        }
      }
      return lines.join('\n');
    },

  };

  return { tools, handlers };
}
