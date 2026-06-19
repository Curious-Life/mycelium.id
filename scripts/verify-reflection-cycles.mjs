// scripts/verify-reflection-cycles.mjs — Context Engine L2 (Phase 1a) gate.
//
// Fully isolated (no vault, no boot): exercises the reflection-engine wiring as pure units —
//   1. cycle integrity (six cycles, shape, unique names, schedules parse)
//   2. tool-rename guard: NO canonical-only tool name survives any body, AND every tool a body
//      references / a cycle enables exists in the live src/tools/*.js registry
//   3. routing: cycleTurnOpts injects the persona + 'reflection' task for a cycle task only
//   4. NO_REPLY sentinel delivers nothing
//   5. seedReflectionCycles is idempotent (2× = 6 rows, not 12) and stamps the cycle body/marker
//   6. the 'reflection' inference task is registered
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');

const {
  CYCLES, REFLECTION_PERSONA, CYCLE_CREATED_BY, REFLECTION_INFERENCE_TASK,
  CYCLE_REFERENCED_TOOLS, FORBIDDEN_LEGACY_TOOLS, cycleTurnOpts, isNoReply,
} = await import('../src/agent/cycle-prompts.js');
const { seedReflectionCycles } = await import('../src/agent/seed-cycles.js');
const { parseSchedule } = await import('../src/agent/scheduler-time.js');
const { INFERENCE_TASKS } = await import('../src/inference/resolve.js');

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); }
};

// ── 1. cycle integrity ──────────────────────────────────────────────────────
ok(Array.isArray(CYCLES) && CYCLES.length === 6, '6 cycles defined', `(${CYCLES.length})`);
const names = new Set(CYCLES.map((c) => c.name));
ok(names.size === CYCLES.length, 'cycle names unique');
for (const c of CYCLES) {
  ok(!!c.id && !!c.name && !!c.body && !!c.schedule, `cycle ${c.id}: shape complete`);
  ok(Array.isArray(c.enabledTools), `cycle ${c.id}: enabledTools is an array`);
  ok(c.outputTarget === 'chat' || c.outputTarget === 'none', `cycle ${c.id}: valid outputTarget`, c.outputTarget);
  ok(!!parseSchedule(c.schedule), `cycle ${c.id}: schedule parses`, c.schedule);
}
ok(['morning', 'evening'].every((id) => CYCLES.find((c) => c.id === id)?.essential === true), 'morning + evening are essential');
ok(typeof REFLECTION_PERSONA === 'string' && /Never conclude/i.test(REFLECTION_PERSONA), 'persona carries the never-conclude discipline');
ok(/FORBIDDEN LANGUAGE/.test(REFLECTION_PERSONA), 'persona carries FORBIDDEN LANGUAGE');

// ── 2. tool-rename guard ────────────────────────────────────────────────────
// the live tool registry = every name: '...' across src/tools/*.js
const toolNames = new Set();
for (const f of readdirSync(join(ROOT, 'src/tools')).filter((f) => f.endsWith('.js'))) {
  const src = readFileSync(join(ROOT, 'src/tools', f), 'utf8');
  for (const m of src.matchAll(/name:\s*'([a-zA-Z_][\w]*)'/g)) toolNames.add(m[1]);
}
ok(toolNames.size > 20, 'tool registry loaded from src/tools', `(${toolNames.size} tools)`);

const allBodies = CYCLES.map((c) => c.body).join('\n') + '\n' + REFLECTION_PERSONA;
for (const legacy of FORBIDDEN_LEGACY_TOOLS) {
  ok(!allBodies.includes(legacy), `no body references legacy tool "${legacy}"`);
}
for (const t of CYCLE_REFERENCED_TOOLS) {
  ok(toolNames.has(t), `referenced tool exists in registry: ${t}`);
}
for (const c of CYCLES) {
  for (const t of c.enabledTools) ok(toolNames.has(t), `cycle ${c.id} enables a real tool: ${t}`);
}

// ── 3. routing ──────────────────────────────────────────────────────────────
const cycleOpts = cycleTurnOpts({ created_by: CYCLE_CREATED_BY });
ok(cycleOpts.isCycle === true, 'cycle task → isCycle');
ok(cycleOpts.systemExtra === REFLECTION_PERSONA, 'cycle task → persona as systemExtra');
ok(cycleOpts.inferenceTask === REFLECTION_INFERENCE_TASK, 'cycle task → reflection inference task');
const userOpts = cycleTurnOpts({ created_by: 'user' });
ok(userOpts.isCycle === false && userOpts.systemExtra === null && userOpts.inferenceTask === 'harness', 'non-cycle task → defaults (no persona, harness task)');

// ── 4. NO_REPLY sentinel ────────────────────────────────────────────────────
ok(isNoReply('NO_REPLY') && isNoReply('  no_reply  ') && isNoReply('NO_REPLY — already delivered'), 'NO_REPLY recognised');
ok(!isNoReply('Good morning — I noticed you shipped the index fix.'), 'a real message is deliverable');

// ── 5. seed idempotency (in-memory db) ──────────────────────────────────────
function fakeDb() {
  const tasks = [];
  let n = 0;
  return {
    _tasks: tasks,
    harness: {
      async createTask(userId, t) {
        const id = `t${++n}`;
        tasks.push({ id, user_id: userId, name: t.name, prompt: t.prompt, schedule: t.schedule,
          next_run: t.nextRun, output_target: t.outputTarget, enabled_tools: t.enabledTools,
          essential: !!t.essential, max_turns: t.maxTurns, created_by: t.createdBy });
        return id;
      },
      async listTasks() { return tasks.slice(); },
    },
  };
}
const db = fakeDb();
const r1 = await seedReflectionCycles(db, 'u1');
ok(r1.created.length === 6, 'first seed creates 6 cycles', `(${r1.created.length})`);
ok(db._tasks.every((t) => t.created_by === CYCLE_CREATED_BY), 'seeded tasks carry the cycle marker');
ok(db._tasks.every((t) => t.next_run), 'seeded tasks have a computed next_run');
const morning = db._tasks.find((t) => t.name === 'Morning check-in');
ok(morning && morning.prompt === CYCLES.find((c) => c.id === 'morning').body, 'seeded prompt == cycle body');
ok(morning && Array.isArray(morning.enabled_tools) && morning.enabled_tools.includes('updateInternalModel'), 'seeded enabled_tools preserved');
const r2 = await seedReflectionCycles(db, 'u1');
ok(r2.created.length === 0 && r2.alreadyPresent === 6, 'second seed is idempotent (0 new, 6 present)');
ok(db._tasks.length === 6, 'still exactly 6 cycle tasks after re-seed', `(${db._tasks.length})`);

// ── 6. inference task registered ────────────────────────────────────────────
ok(INFERENCE_TASKS.includes('reflection'), "'reflection' registered as a routable inference task");

console.log(`\n${pass} pass · ${fail} fail`);
if (fail === 0) { console.log('VERDICT: GO'); process.exit(0); }
console.log('VERDICT: NO-GO'); process.exit(1);
