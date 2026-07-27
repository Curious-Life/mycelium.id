// src/tools/cycles.js — MCP tools that let the agent change how it runs the reflection cycles
// when the user asks ("do the evening check-in more playfully", "stop the morning message",
// "reflect on my creative work specifically"). Context Engine L2, "own it".
//
// A cycle's instructions live in its scheduled_tasks.prompt (encrypted, patchable, and what the
// scheduler runs next fire) — updateCycle patches it via db.harness.updateTask. The persona
// lives in the editable skills/persona/soul.md doc — updatePersona writes it. Both surfaces are
// also user-editable directly (the persona in the Library; cycles via these tools / a portal
// view). saveDocument is injectable for tests.
import { parseSchedule, computeNextRun } from '../agent/scheduler-time.js';
import { CYCLES, CYCLE_CREATED_BY } from '../agent/cycle-prompts.js';
import { PERSONA_PATH } from '../skills/store.js';
import { saveDocument as realSaveDocument } from '../core/document-store.js';

const MAX_PROMPT = 12000;
const MAX_PERSONA = 20000;

/**
 * Build a validated scheduled_tasks patch from a cycle-edit request. Shared by the
 * updateCycle MCP tool and the portal PATCH route so validation never diverges.
 * @param {{prompt?:string, schedule?:string, enabled?:boolean}} args
 * @param {object} task  the target scheduled_tasks row (needs .tz, .schedule)
 * @param {() => Date} now
 * @returns {{patch:object}|{error:string}}
 */
export function buildCyclePatch(args = {}, task, now = () => new Date()) {
  const patch = {};
  if (typeof args.prompt === 'string' && args.prompt.trim()) {
    if (args.prompt.length > MAX_PROMPT) return { error: `instructions too long (${args.prompt.length} > ${MAX_PROMPT}).` };
    patch.prompt = args.prompt.trim();
  }
  if (typeof args.schedule === 'string' && args.schedule.trim()) {
    const parsed = parseSchedule(args.schedule.trim());
    if (!parsed) return { error: `unrecognised schedule "${args.schedule}". Use daily:HH | weekly:DOW:HH | every:Nh | interval:Nm.` };
    let nextRun = null;
    try { nextRun = computeNextRun(parsed, { after: now(), tz: task.tz || null }); } catch { nextRun = null; }
    if (!nextRun) return { error: 'that schedule has no future run.' };
    patch.schedule = args.schedule.trim();
    patch.next_run = nextRun;
  }
  if (args.enabled === false) patch.status = 'paused';
  if (args.enabled === true) {
    patch.status = 'active';
    // re-arm next_run on re-enable so a paused cycle resumes cleanly. Only assign when
    // a real next run exists — never null it (dueTasks needs next_run IS NOT NULL, so a
    // null here would leave the cycle active-but-dead); keep the existing next_run instead.
    const parsed = parseSchedule(patch.schedule || task.schedule);
    if (parsed) { try { const nr = computeNextRun(parsed, { after: now(), tz: task.tz || null }); if (nr) patch.next_run = nr; } catch { /* keep existing */ } }
  }
  return { patch };
}

export function createCyclesDomain({ db, userId, saveDocument = realSaveDocument, now = () => new Date() } = {}) {
  if (!db?.harness) throw new TypeError('createCyclesDomain: db.harness required');

  const cycleDef = (key) => {
    const k = String(key || '').trim().toLowerCase();
    return CYCLES.find((c) => c.id.toLowerCase() === k || c.name.toLowerCase() === k) || null;
  };
  const findTask = async (def) => {
    const tasks = await db.harness.listTasks(userId);
    return (tasks || []).find((t) => t.created_by === CYCLE_CREATED_BY && t.name === def.name) || null;
  };

  const tools = [
    {
      name: 'listCycles',
      description: 'List the reflection cycles (morning, midday, evening, triage, integration, weekly) with their schedule and on/off state. Use before updateCycle so you reference a real cycle.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'getCyclePrompt',
      description: "Read a reflection cycle's current instructions, so you can adjust them precisely (e.g. before making it shorter or changing its focus).",
      inputSchema: {
        type: 'object',
        properties: { cycle: { type: 'string', description: 'cycle id or name (e.g. "evening")' } },
        required: ['cycle'],
      },
    },
    {
      name: 'updateCycle',
      description: "Change how a reflection cycle runs, when your person asks. Edit its instructions (prompt), change its schedule (daily:HH | weekly:DOW:HH), and/or turn it on or off (enabled). Only pass the fields you're changing. Takes effect at the next run.",
      inputSchema: {
        type: 'object',
        properties: {
          cycle: { type: 'string', description: 'cycle id or name (e.g. "evening")' },
          prompt: { type: 'string', description: "new full instructions for this cycle (replaces the current body)" },
          schedule: { type: 'string', description: 'new schedule DSL, e.g. "daily:21" or "weekly:0:10"' },
          enabled: { type: 'boolean', description: 'true to run it, false to pause it' },
        },
        required: ['cycle'],
      },
    },
    {
      name: 'updatePersona',
      description: "Update the relationship persona — the voice and stance you bring to every cycle and check-in — when your person asks you to show up differently. Replaces skills/persona/soul.md (which your person can also edit directly).",
      inputSchema: {
        type: 'object',
        properties: { content: { type: 'string', description: 'the full new persona text' } },
        required: ['content'],
      },
    },
  ];

  const handlers = {
    listCycles: async () => {
      let tasks;
      try { tasks = await db.harness.listTasks(userId); } catch { return 'Error: could not list cycles.'; }
      const cyc = (tasks || []).filter((t) => t.created_by === CYCLE_CREATED_BY);
      if (!cyc.length) return 'No reflection cycles are set up yet.';
      const lines = cyc.map((t) => `• ${t.name} — ${t.schedule} [${t.status}]`);
      return `## Reflection cycles (${cyc.length})\n${lines.join('\n')}\n\nUse updateCycle to change a cycle's instructions, schedule, or on/off state.`;
    },

    getCyclePrompt: async (args = {}) => {
      const def = cycleDef(args.cycle);
      if (!def) return `Error: unknown cycle "${args.cycle}". Use listCycles to see them.`;
      const task = await findTask(def);
      return (task?.prompt) || def.body; // task.prompt decrypts on read; fall back to the seed body
    },

    updateCycle: async (args = {}) => {
      const def = cycleDef(args.cycle);
      if (!def) return `Error: unknown cycle "${args.cycle}". Use listCycles to see them.`;
      const task = await findTask(def);
      if (!task) return `Error: cycle "${def.name}" is not set up. Enabling reflection seeds the cycles.`;

      const built = buildCyclePatch(args, task, now);
      if (built.error) return `Error: ${built.error}`;
      const patch = built.patch;
      if (!Object.keys(patch).length) return 'Nothing to update — pass prompt, schedule, and/or enabled.';

      // authorTrust:'model' (the default, spelled out): this is a MODEL-driven edit, so patching
      // the cycle's instructions CLEARS its write provenance (db/harness.js). Without that, a
      // trusted cycle is repurposable — rewrite the integration cycle's prompt and it still fires
      // with editMindFile/writeMindFileWhole. The owner's own portal edit keeps the trust.
      try { await db.harness.updateTask(userId, task.id, patch, { authorTrust: 'model' }); }
      catch { return 'Error: could not save the change.'; }
      const changed = Object.keys(patch).filter((k) => k !== 'next_run');
      const note = patch.status === 'paused' ? ' It will not run until you re-enable it.' : '';
      // Say the capability loss out loud. A silently-dropped tool that only fails at fire time,
      // with nobody present, is the D-076 failure mode this codebase keeps paying for.
      // Recoverable, and the wording says so truthfully: the portal PATCH route re-arms the trust
      // (portal-reflection.js), because an authenticated owner saving their own cycle is the
      // human-in-the-loop this boundary is built around.
      const demoted = patch.prompt ? ' Note: because the instructions changed here, this cycle can no longer write to your vault — open Settings → Reflection and save it to restore that.' : '';
      return `Updated ${def.name} (${changed.join(', ')}). Takes effect at the next run.${note}${demoted}`;
    },

    updatePersona: async (args = {}) => {
      const content = String(args.content || '').trim();
      if (!content) return 'Error: content is required.';
      if (content.length > MAX_PERSONA) return `Error: persona too long (${content.length} > ${MAX_PERSONA}).`;
      try {
        await saveDocument({ db }, {
          userId, source: 'agent-mcp', sourceType: 'skill', scope: 'personal',
          createdBy: 'agent', path: PERSONA_PATH, title: 'Reflection persona (editable)', content,
        });
      } catch { return 'Error: could not save the persona.'; }
      return 'Updated the reflection persona. Your cycles will use it from now on.';
    },
  };

  return { tools, handlers };
}

export default createCyclesDomain;
