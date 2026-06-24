// src/tools/schedule-tasks.js — the gated autonomy scheduling tools (Phase 5, Step 5).
// Spec §5.6/§11. Lets an autonomous (or owner-driven) turn create, list, and cancel
// scheduled wake-cycles that the scheduler (src/agent/scheduler.js) later fires.
//
// GATING: these tool NAMES are deliberately absent from the chat DOMAINS catalog
// (src/agent/tool-domains.js §9-13), so interactive chat can NEVER self-schedule. They
// are granted only to autonomous turns via autonomyTools(...) when a task opts in. The
// handlers are still registered (mcp.js) so the surface exists; the GRANT is the control.
//
// SECURITY (§1): the task `prompt` is encrypted at rest by the harness DAL. Tool results
// never echo a stored prompt back verbatim in the listing (only name/schedule/status), so
// a compromised reader turn can't exfiltrate other tasks' instructions through the list.
// Handlers soft-fail with an error string — never throw (mirrors tools/tasks.js).

import { parseSchedule, computeNextRun } from '../agent/scheduler-time.js';

const MAX_PROMPT = 8000;
const MAX_ENABLED = 16;

export function createScheduleTasksDomain(deps) {
  if (!deps) throw new TypeError('createScheduleTasksDomain: deps required');
  const { db, userId } = deps;
  if (!db || !db.harness) throw new TypeError('createScheduleTasksDomain: db with db.harness required');
  if (typeof userId !== 'string') throw new TypeError('createScheduleTasksDomain: userId required');

  const tools = [
    {
      name: 'schedule_task',
      description: 'Schedule an autonomous task to run later on a recurring or one-off cadence. The prompt is what the assistant will be asked to do at fire time, with no person present.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt:        { type: 'string', description: 'What to do when the task fires (a self-contained instruction).' },
          schedule:      { type: 'string', description: 'Cadence DSL: daily:HH | weekly:DOW:HH | monthly:DOM:HH | every:Nh | interval:Nm | once | cron:<5 fields>.' },
          name:          { type: 'string', description: 'Optional short label for the task.' },
          tz:            { type: 'string', description: 'Optional IANA timezone (e.g. Europe/Lisbon); defaults to UTC.' },
          scheduled_at:  { type: 'string', description: 'For schedule "once": the ISO datetime to fire at.' },
          output_target: { type: 'string', description: "Where the result goes: 'chat' (default), 'none', or 'conversation:<id>'." },
          enabled_tools: { type: 'array', items: { type: 'string' }, description: 'Tool names the task may use (e.g. searchMindscape, schedule_task, reply). Read-only tools are always available.' },
        },
        required: ['prompt', 'schedule'],
      },
    },
    {
      name: 'list_my_schedules',
      description: 'List your scheduled tasks (name, cadence, next run, status). Does not reveal task prompts.',
      inputSchema: { type: 'object', properties: { status: { type: 'string', description: 'Filter by status (e.g. active, paused, completed, cancelled).' } } },
    },
    {
      name: 'cancel_task',
      description: 'Cancel a scheduled task by id so it never fires again.',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The scheduled task id.' } }, required: ['id'] },
    },
  ];

  const handlers = {
    schedule_task: async (args = {}) => {
      const prompt = String(args.prompt || '').trim();
      if (!prompt) return 'Error: prompt is required.';
      if (prompt.length > MAX_PROMPT) return `Error: prompt too long (${prompt.length} > ${MAX_PROMPT}).`;
      const schedule = String(args.schedule || '').trim();
      const parsed = parseSchedule(schedule);
      if (!parsed) return `Error: unrecognised schedule "${schedule}". Use daily:HH | weekly:DOW:HH | monthly:DOM:HH | every:Nh | interval:Nm | once | cron:<5 fields>.`;
      if (parsed.type === 'once' && !args.scheduled_at) return 'Error: schedule "once" needs scheduled_at (an ISO datetime).';

      const tz = (typeof args.tz === 'string' && args.tz.trim()) ? args.tz.trim() : null;
      const scheduledAt = (typeof args.scheduled_at === 'string' && args.scheduled_at.trim()) ? args.scheduled_at.trim() : null;
      let nextRun;
      try { nextRun = computeNextRun(parsed, { after: new Date(), tz, scheduledAt }); }
      catch { return 'Error: could not compute the next run time for that schedule.'; }
      if (!nextRun) return 'Error: that schedule has no future run (a "once" time in the past?).';

      let enabledTools = null;
      if (args.enabled_tools != null) {
        if (!Array.isArray(args.enabled_tools)) return 'Error: enabled_tools must be an array of tool names.';
        enabledTools = args.enabled_tools.filter((t) => typeof t === 'string').slice(0, MAX_ENABLED);
      }
      const outputTarget = (typeof args.output_target === 'string' && args.output_target.trim()) ? args.output_target.trim() : 'chat';
      const name = (typeof args.name === 'string' && args.name.trim()) ? args.name.trim().slice(0, 120) : null;

      try {
        const id = await db.harness.createTask(userId, {
          name, prompt, schedule, tz, scheduledAt, nextRun, outputTarget, enabledTools,
          status: 'active', triggerType: 'schedule', createdBy: 'agent',
        });
        return `Scheduled "${name || schedule}" (id ${id}) — next run ${nextRun}.`;
      } catch { return 'Error: could not save the scheduled task.'; }
    },

    list_my_schedules: async (args = {}) => {
      const status = (typeof args.status === 'string' && args.status.trim()) ? args.status.trim() : undefined;
      let rows;
      try { rows = await db.harness.listTasks(userId, status ? { status } : {}); }
      catch { return 'Error: could not list scheduled tasks.'; }
      if (!rows.length) return status ? `No ${status} scheduled tasks.` : 'No scheduled tasks.';
      // Never expose the (encrypted) prompt — only structural fields.
      const lines = rows.map((t) => {
        const next = t.next_run ? ` · next ${t.next_run}` : '';
        const last = t.last_status ? ` · last ${t.last_status}` : '';
        return `• [${t.status}] ${t.name || t.schedule} — ${t.schedule}${next}${last}  (id ${t.id})`;
      });
      return `## ${rows.length} scheduled task(s)\n\n${lines.join('\n')}`;
    },

    cancel_task: async (args = {}) => {
      const id = String(args.id || '').trim();
      if (!id) return 'Error: id is required.';
      try {
        const t = await db.harness.getTask(userId, id);
        if (!t) return `Error: no scheduled task with id ${id}.`;
        await db.harness.setTaskStatus(userId, id, 'cancelled');
        return `Cancelled scheduled task ${id}.`;
      } catch { return 'Error: could not cancel that task.'; }
    },
  };

  return { tools, handlers };
}

export default createScheduleTasksDomain;
