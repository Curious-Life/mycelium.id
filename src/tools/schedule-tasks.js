// src/tools/schedule-tasks.js — the gated autonomy scheduling tools (Phase 5, Step 5).
// Spec §5.6/§11. Lets an autonomous (or owner-driven) turn create, list, and cancel
// scheduled wake-cycles that the scheduler (src/agent/scheduler.js) later fires.
//
// GATING: these tool NAMES are deliberately absent from the chat DOMAINS catalog
// (src/agent/tool-domains.js §9-13), so interactive chat can NEVER self-schedule. They
// are granted only to autonomous turns via autonomyTools(...) when a task opts in. The
// handlers are still registered (mcp.js) so the surface exists; the GRANT is the control.
//
// ALLOWLIST: `enabled_tools` arrives from the MODEL and becomes a tool GRANT when the task later
// fires with no human present. It is validated at WRITE time against autonomy-tools.js's
// GRANTABLE_TOOLS so a name that can never be granted TO A SCHEDULED TURN is REFUSED rather than
// accepted-then-silently-dropped, and so a tier added later is not inherited by this path.
// It does NOT stop a planted task from naming tools that ARE grantable — see
// the schedule-enabled-tools design §5 for what remains open.
//
// SCOPE OF THE CHECK — TIER MEMBERSHIP ONLY, deliberately not registry presence. `reply` is
// grantable by tier but is only REGISTERED when AGENT_URL is set (mcp.js), so naming it on a
// vault with no agent URL is still accepted here and still dropped at fire time. That is on
// purpose and must not be "fixed" by checking the registry: registry presence is TIME-VARYING
// (a task scheduled today may fire tomorrow, after the operator sets AGENT_URL), so rejecting on
// it would refuse a task that will be perfectly valid when it fires. Tier membership is the only
// property that is stable between write time and fire time.
//
// SECURITY (§1): the task `prompt` is encrypted at rest by the harness DAL. Tool results
// never echo a stored prompt back verbatim in the listing (only name/schedule/status), so
// a compromised reader turn can't exfiltrate other tasks' instructions through the list.
// Handlers soft-fail with an error string — never throw (mirrors tools/tasks.js).

import { parseSchedule, computeNextRun } from '../agent/scheduler-time.js';
import { partitionEnabledTools } from '../agent/autonomy-tools.js';

const MAX_PROMPT = 8000;
const MAX_ENABLED = 16;

// A rejected tool name is MODEL-supplied text being reflected back into a tool result — i.e. back
// into the agent's OWN context. Bound it like any untrusted echo (§1): strip line/paragraph
// separators AND the control/format classes (\p{C} alone leaves U+2028/U+2029, which still break
// a line), clip each name, cap the list. Worst case is deterministic and asserted by the gate:
// MAX_ECHO_NAMES × MAX_ECHO_LEN plus the fixed wrapper.
const MAX_ECHO_NAMES = 5;
const MAX_ECHO_LEN = 40;
const echoNames = (names) => names
  .slice(0, MAX_ECHO_NAMES)
  .map((n) => n.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, '').slice(0, MAX_ECHO_LEN))
  .join(', ') + (names.length > MAX_ECHO_NAMES ? `, +${names.length - MAX_ECHO_NAMES} more` : '');

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
          enabled_tools: { type: 'array', items: { type: 'string' }, description: 'Tool names the task may use (e.g. remember, updateDocument, reply). Read-only tools are always available and need not be listed. A name that can never be granted to a scheduled task is rejected and NOTHING is scheduled — including schedule_task itself (a task may not re-arm itself) and the cycle-only tools (recordReflection, proposeClaim, …).' },
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

      // ALLOWLIST (§2, defense in depth). The stored names become a TOOL GRANT at fire time with
      // no human present (scheduler.js:130 → run-turn.js:239), so an ungrantable name is never
      // persisted. Reject the whole call rather than dropping the bad names: a silently-dropped
      // name is a capability the task believes it has and only discovers it lacks at fire time,
      // which is exactly the silent-divergence failure D-076 is made of. Names that can never be
      // granted to a SCHEDULED turn (a future owner-trusted-only destructive tier) are outside
      // GRANTABLE_TOOLS by construction — accepting one would be a lie to the caller.
      let enabledTools = null;
      if (args.enabled_tools != null) {
        if (!Array.isArray(args.enabled_tools)) return 'Error: enabled_tools must be an array of tool names.';
        if (args.enabled_tools.length > MAX_ENABLED) return `Error: enabled_tools has too many entries (${args.enabled_tools.length} > ${MAX_ENABLED}).`;
        const { enabled, rejected } = partitionEnabledTools(args.enabled_tools);
        if (rejected.length) return `Error: enabled_tools names ${rejected.length} tool(s) that can never be granted to a scheduled task: ${echoNames(rejected)}. Nothing was scheduled.`;
        enabledTools = enabled;
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
