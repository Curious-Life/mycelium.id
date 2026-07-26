// scripts/verify-reflection-cycles.mjs — Context Engine L2 (Phase 1a) gate.
//
// Mostly pure units; §10 boots a real vault because grantability cannot be faked —
//   1. cycle integrity (six cycles, shape, unique names, schedules parse)
//   2. tool-rename guard: NO canonical-only tool name survives any body, AND every tool a body
//      references / a cycle enables exists in the live src/tools/*.js registry.
//      NOTE: §2 is a source SCRAPE — presence in a file, nothing more. §10 is the teeth.
//  10. GRANTABILITY (D-076): every cycle's enabledTools name survives a REAL autonomyTools()
//      call over the REAL registry from a REAL boot. Registry presence ≠ the turn can call it.
//
// MUTATION-TESTED: removed 'recordReflection' from CYCLE_AUTONOMOUS_TOOLS (the literal D-076
//   bug) → 10b REDs on all six cycles + 10c REDs (7 FAILs). Decisive detail: §2's "cycle X
//   enables a real tool: recordReflection" stayed PASS on all six under that same mutation —
//   §2 is exactly the check that let D-076 ship, and §10 is what catches it.
// MUTATION-TESTED: made seed-cycles.js:51 write `c.enabledTools.filter(n => n !== 'recordReflection')`
//   — i.e. the stored ROW diverges from the CYCLES source → 10c RED. This is the one that
//   justifies reading enabled_tools back out of the DB: an earlier draft of this section read
//   CYCLES directly and stayed GREEN under this exact mutation while every installed vault
//   would have been broken. Found by an adversarial review of this change, not by me.
// MUTATION-TESTED: deleted `isCycle,` from the scheduler's runAgentTurn call (the delivery path
//   an earlier draft did not observe at all) → 10f RED. Also run separately at the other end of
//   the same wire — run-turn passing `{ humanTriggered }` instead of `{ humanTriggered, isCycle }`
//   → 10f RED.
// MUTATION-TESTED: the FALSE-GREEN bypass an independent review demonstrated against an earlier
//   free-floating version of 10f — reformat `const { isCycle, inferenceTask } = cycleTurnOpts()`
//   as a multi-line destructure AND delete `isCycle,` from the runAgentTurn call. The old regex
//   matched the destructure and stayed GREEN while all six cycles silently lost all five tools.
//   Re-run against the anchored regex → 10f RED. A gate whose check can be satisfied by an
//   unrelated line is not a gate.
// MUTATION-TESTED: dropped the `&& isCycle === true` condition from the cycle branch of
//   autonomyTools() → 10e RED, naming all five leaked tools. This is the NEW privilege boundary:
//   without it a model-planted scheduled task would inherit the cycles' grant.
// MUTATION-TESTED: loosened autonomyTools() to `else if (enabled.has(t.name))` (fail-OPEN — grant
//   anything named) → 10e RED. This is what proves 10b is not vacuous: without it, 10b would
//   pass trivially under a grant that hands over everything.
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

// ── 7. editable skills: persona doc + cycle-editing tools ────────────────────
const { resolvePersona, seedPersonaDoc, PERSONA_PATH } = await import('../src/skills/store.js');
const { createCyclesDomain } = await import('../src/tools/cycles.js');
const { isGrantableTool, DOMAINS } = await import('../src/agent/tool-domains.js');

// persona resolution: edited doc wins, missing doc falls back to the constant (never throws)
const personaFromDoc = await resolvePersona({ documents: { get: async () => ({ content: 'MY EDITED PERSONA' }) } }, 'u');
ok(personaFromDoc === 'MY EDITED PERSONA', 'resolvePersona returns the edited doc');
const personaFallback = await resolvePersona({ documents: { get: async () => null } }, 'u');
ok(personaFallback === REFLECTION_PERSONA, 'resolvePersona falls back to the constant when no doc');
const personaOnError = await resolvePersona({ documents: { get: async () => { throw new Error('boom'); } } }, 'u');
ok(personaOnError === REFLECTION_PERSONA, 'resolvePersona falls back on a read error (cycle never breaks)');

// seedPersonaDoc idempotent (inject a stub saveDocument)
{
  const saved = [];
  const save = async (_d, input) => { saved.push(input); };
  const r1 = await seedPersonaDoc({ documents: { get: async () => null } }, 'u', { saveDocument: save });
  ok(r1.created === true && saved.length === 1 && saved[0].path === PERSONA_PATH, 'seedPersonaDoc writes the persona when absent');
  const r2 = await seedPersonaDoc({ documents: { get: async () => ({ content: 'x' }) } }, 'u', { saveDocument: save });
  ok(r2.created === false && saved.length === 1, 'seedPersonaDoc is idempotent (skips when present)');
}

// cycle-editing tools over a fake db
function fakeCyclesDb() {
  const store = CYCLES.map((c, i) => ({ id: `t${i}`, name: c.name, schedule: c.schedule, status: 'active', prompt: c.body, tz: null, created_by: CYCLE_CREATED_BY }));
  store.push({ id: 'u9', name: 'A user task', schedule: 'daily:6', status: 'active', prompt: 'x', created_by: 'user' });
  const patches = [];
  return { _store: store, _patches: patches, harness: {
    async listTasks() { return store.map((t) => ({ ...t })); },
    async updateTask(_u, id, fields) { patches.push({ id, fields }); Object.assign(store.find((t) => t.id === id), fields); },
  } };
}
{
  const db = fakeCyclesDb();
  const savedPersona = [];
  const { tools, handlers } = createCyclesDomain({ db, userId: 'u', saveDocument: async (_d, input) => { savedPersona.push(input); }, now: () => new Date('2026-06-20T00:00:00Z') });
  ok(tools.map((t) => t.name).sort().join(',') === 'getCyclePrompt,listCycles,updateCycle,updatePersona', 'cycles domain exposes the 4 tools');

  const list = await handlers.listCycles();
  ok(/Morning check-in/.test(list) && !/A user task/.test(list), 'listCycles shows only the 6 reflection cycles');

  const r = await handlers.updateCycle({ cycle: 'evening', prompt: 'be warmer and shorter' });
  ok(/Updated Evening check-in/.test(r) && db._patches.some((p) => p.fields.prompt === 'be warmer and shorter'), 'updateCycle edits the cycle prompt');
  ok(/^Error/.test(await handlers.updateCycle({ cycle: 'nope', prompt: 'x' })), 'updateCycle rejects an unknown cycle');

  await handlers.updateCycle({ cycle: 'morning', schedule: 'daily:9' });
  const schedPatch = db._patches.find((p) => p.fields.schedule === 'daily:9');
  ok(schedPatch && schedPatch.fields.next_run, 'updateCycle reschedules + recomputes next_run');

  await handlers.updateCycle({ cycle: 'triage', enabled: false });
  ok(db._patches.some((p) => p.fields.status === 'paused'), 'updateCycle can pause a cycle');

  const gp = await handlers.getCyclePrompt({ cycle: 'weekly' });
  ok(typeof gp === 'string' && /Weekly Review/.test(gp), 'getCyclePrompt returns the current body');

  const up = await handlers.updatePersona({ content: 'A kinder voice.' });
  ok(/Updated the reflection persona/.test(up) && savedPersona.some((s) => s.path === PERSONA_PATH && s.content === 'A kinder voice.'), 'updatePersona writes skills/persona/soul.md');
  ok(/^Error/.test(await handlers.updatePersona({ content: '' })), 'updatePersona rejects empty content');
}

// chat-grantability: the cycle tools are in the catalog (so the agent can use them in chat)
ok(DOMAINS.some((d) => d.key === 'cycles'), "tool-domains has a 'cycles' domain");
ok(['listCycles', 'updateCycle', 'updatePersona', 'getCyclePrompt'].every((t) => isGrantableTool(t)), 'all 4 cycle tools are chat-grantable');

// ── 8. Core distillation (1c-C): the integration cycle writes self.md ────────
const integration = CYCLES.find((c) => c.id === 'integration');
ok(/Phase 3\.6/.test(integration.body) && /self\.md/.test(integration.body), 'integration cycle has Phase 3.6 (distill self.md)');
ok(['Identity', 'Current focus', 'Stable preferences', 'Boundaries', 'Operating notes'].every((s) => integration.body.includes(s)), 'Phase 3.6 names the five Core sections');
ok(/REWRITE, don't append/i.test(integration.body) && /NEVER drop a safety/i.test(integration.body), 'Phase 3.6 carries the rewrite + safety-boundary discipline');
ok(integration.enabledTools.includes('removeFromMind') && integration.enabledTools.includes('writeMindFileWhole'), 'integration can write + prune the Core');

// ── 9. removeFromMind tool (1c-C) ────────────────────────────────────────────
const { createInternalDomain } = await import('../src/tools/internal.js');
function memMind(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    _store: store,
    readMindFile: async (f) => (store.has(f) ? store.get(f) : null),
    writeMindFile: async (f, c) => { store.set(f, c); },
  };
}
{
  const m = memMind({ 'self.md': '# Self\n\n## A\n- keep\n\n## B\n- prune me\n\n## C\n- keep' });
  const dom = createInternalDomain({ readMindFile: m.readMindFile, writeMindFile: m.writeMindFile });
  ok(dom.handlers.removeFromMind, 'removeFromMind handler registered');
  const r = JSON.parse(await dom.handlers.removeFromMind({ filename: 'self.md', block: '## B\n- prune me' }));
  ok(r.ok === true, 'removeFromMind removes a unique block');
  ok(!m._store.get('self.md').includes('prune me'), 'block is gone');
  ok(!/\n{3,}/.test(m._store.get('self.md')), 'blank-line gap tidied');
  const dup = JSON.parse(await dom.handlers.removeFromMind({ filename: 'self.md', block: '- keep' }));
  ok(dup.ok === false && dup.error === 'block-not-unique', 'non-unique block is rejected (count enforced)');
  const nf = JSON.parse(await dom.handlers.removeFromMind({ filename: 'self.md', block: 'nonexistent' }));
  ok(nf.ok === false && nf.error === 'block-not-found', 'absent block is rejected');
}
ok(isGrantableTool('removeFromMind'), 'removeFromMind is chat-grantable (mindfiles domain)');

// ── 10. GRANTABILITY over the REAL registry (D-076) ─────────────────────────
// §2 above scrapes `name: '...'` out of src/tools/*.js. That proves a name EXISTS IN A FILE —
// it does NOT prove an autonomous turn can call it. D-076 shipped through exactly that gap: all
// five of the cycles' tools were registry-present and in NO tier of autonomy-tools.js, so
// autonomyTools() dropped them fail-closed, the cycles could not record a reflection on
// v0.1.13, and this gate stayed green (the M-001 family — green for the wrong reason).
//
// So: boot a REAL vault, take the REAL registry boot hands the server, and call the REAL
// autonomyTools(). A name only counts as enabled if it survives that.
{
  const Database = (await import('better-sqlite3')).default;
  const { rmSync, mkdirSync } = await import('node:fs');
  const crypto = (await import('node:crypto')).default;
  const { boot } = await import('../src/index.js');
  const { applyMigrations } = await import('../src/db/migrate.js');
  const { autonomyTools } = await import('../src/agent/autonomy-tools.js');
  const { cycleTurnOpts: realCycleTurnOpts } = await import('../src/agent/cycle-prompts.js');

  const DB = 'data/verify-reflection-cycles.db', KCV = 'data/verify-reflection-cycles-kcv.json';
  const scrub = () => { for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} } };
  scrub();
  mkdirSync('data', { recursive: true });
  applyMigrations(new Database(DB));
  const { db, tools, close } = await boot({
    dbPath: DB, kcvPath: KCV,
    userHex: crypto.randomBytes(32).toString('hex'), systemHex: crypto.randomBytes(32).toString('hex'),
    embedder: null,
  });
  try {
    const registry = new Set(tools.map((t) => t.name));
    ok(tools.length > 20, '10a REAL registry from boot (not a source scrape)', `(${tools.length} tools)`);

    // Seed for real, then read the tasks BACK OUT OF THE DATABASE. Deliberately not CYCLES:
    // seeding is insert-only and nothing patches enabled_tools (seed-cycles.js:36, and no
    // caller passes it to updateTask), so a REAL installed vault's grant is decided by the
    // frozen ROW, not by today's source. A gate that reads CYCLES would stay green while a
    // divergence between the two silently broke every existing install.
    const U = 'local-user';
    await seedReflectionCycles(db, U, { tz: 'UTC' });
    const rows = (await db.harness.listTasks(U)).filter((t) => t.created_by === CYCLE_CREATED_BY);
    ok(rows.length === CYCLES.length, '10a seeded cycle rows read back from the DB', `(${rows.length})`);

    // The grant a fired cycle will actually hold: stored enabled_tools + the isCycle flag
    // derived by the REAL cycleTurnOpts from the row's immutable created_by.
    const grantFor = (row) => {
      const { isCycle } = realCycleTurnOpts(row);
      return new Set(autonomyTools(tools, row.enabled_tools || [], { isCycle }).map((t) => t.name));
    };

    // 10b — the teeth. Every name the STORED row declares must survive a real grant call.
    for (const row of rows) {
      const granted = grantFor(row);
      for (const t of row.enabled_tools || []) {
        ok(granted.has(t), `10b '${row.name}': '${t}' is GRANTABLE`, registry.has(t) ? '' : '(not even registry-present)');
      }
    }

    // 10c/10d — named anchors for the exact names D-076 was about, so a future edit that drops
    // one from its tier fails on a line that says why, not just on a generic loop.
    ok(rows.length === 6 && rows.every((r) => grantFor(r).has('recordReflection')),
      '10c D-076: recordReflection is grantable on ALL six seeded cycles');
    const ig = grantFor(rows.find((r) => r.name === CYCLES.find((c) => c.id === 'integration').name));
    ok(['snapshotMindFile', 'removeFromMind', 'listReflections', 'proposeClaim'].every((t) => ig.has(t)),
      "10d D-076: the integration cycle's four extra tools are grantable");

    // 10e — fail-closed controls, so 10b can never pass vacuously.
    // (i) The NEW privilege boundary: a model-created task (schedule_task stamps created_by
    //     'agent' — tools/schedule-tasks.js:84) naming the SAME tools gets NONE of them. This is
    //     the check that keeps the cycle tier from being a back door for a planted task.
    const cycleNames = ['recordReflection', 'listReflections', 'snapshotMindFile', 'removeFromMind', 'proposeClaim'];
    const plantedId = await db.harness.createTask(U, {
      name: 'planted', prompt: 'x', schedule: 'interval:30m', nextRun: new Date(Date.now() + 6e4).toISOString(),
      outputTarget: 'none', enabledTools: cycleNames, status: 'active', triggerType: 'schedule', createdBy: 'agent',
    });
    const planted = await db.harness.getTask(U, plantedId);
    const plantedGrant = grantFor(planted);
    ok(realCycleTurnOpts(planted).isCycle === false, '10e control: a model-created task is NOT a cycle');
    ok(cycleNames.every((n) => !plantedGrant.has(n)),
      '10e control: a non-cycle task naming the cycle tools is granted NONE of them',
      [...plantedGrant].filter((n) => cycleNames.includes(n)).join(',') || 'none leaked');
    // (ii) A tool in NO tier is never granted even when named, cycle or not.
    ok(registry.has('publishDocument'), '10e control: publishDocument is registry-present');
    ok(!autonomyTools(tools, ['publishDocument'], { isCycle: true }).some((t) => t.name === 'publishDocument'),
      '10e control: a tool in no tier is NOT granted even when named (fail-closed)');

    // 10f — SOURCE-LEVEL check, and labelled as one because that is what it is. The grant now
    // depends on the scheduler forwarding BOTH enabledTools and isCycle; drop either and every
    // cycle silently loses its tools again — the exact D-076 failure mode. Driving the real
    // scheduler→run-turn path needs a live model (createScheduler builds its own harness/loop
    // internally and does not accept an injected one), so this asserts the wiring textually.
    // Weaker than behaviour, and honest about it — NOT presented as proof the turn works.
    const schedSrc = readFileSync(join(ROOT, 'src/agent/scheduler.js'), 'utf8');
    const turnSrc = readFileSync(join(ROOT, 'src/agent/run-turn.js'), 'utf8');
    // ANCHORED TO THE CALL, not merely present in the file. A free-floating /^\s*isCycle,$/m
    // was demonstrated (review, 2026-07-26) to stay GREEN when `isCycle` was deleted from the
    // options bag while an ordinary multi-line destructure elsewhere in the file still matched
    // — a false green on exactly the regression this check exists to catch. Tolerant about
    // SIBLING KEYS in the bag (D-063's `humanTriggered` legitimately joined it), strict about
    // where the key appears.
    ok(/enabledTools:\s*task\.enabled_tools/.test(schedSrc) && /runAgentTurn\([\s\S]{0,800}?^\s*isCycle,\s*$/m.test(schedSrc),
      '10f [source] scheduler forwards BOTH enabled_tools and isCycle to the turn');
    ok(/autonomyTools\(tools,\s*enabledTools,\s*\{[^}]*\bisCycle\b[^}]*\}\)/.test(turnSrc),
      '10f [source] run-turn passes isCycle into the grant');
  } finally {
    try { await close?.(); } catch { /* best-effort */ }
    scrub();
  }
}

console.log(`\n${pass} pass · ${fail} fail`);
if (fail === 0) { console.log('VERDICT: GO'); process.exit(0); }
console.log('VERDICT: NO-GO'); process.exit(1);
