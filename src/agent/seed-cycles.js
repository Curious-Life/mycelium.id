// src/agent/seed-cycles.js — idempotently seed the six reflection cycles (Context Engine L2, Phase 1a).
//
// A reflection cycle = a scheduled_tasks row whose prompt is the cycle body and whose
// created_by marks it as engine-owned (createTask assigns its own uuid, so we identify
// cycles by created_by, not id). Seeding is idempotent: a cycle already present (matched by
// created_by + name) is skipped — safe to run on every boot, and it never clobbers a user's
// edits to a cycle's prompt/schedule. Gated by the caller behind settings.reflection.enabled.

import { parseSchedule, computeNextRun } from './scheduler-time.js';
import { CYCLES, CYCLE_CREATED_BY } from './cycle-prompts.js';
import { ENGINE_PROVENANCE } from './autonomy-tools.js';
import { seedPersonaDoc } from '../skills/store.js';

/**
 * @param {object} db      keyed db (needs db.harness.createTask + db.harness.listTasks)
 * @param {string} userId
 * @param {object} [opts]  { logger, now, tz }
 *   now: () => Date (testable); tz: IANA zone the cycles fire in (so "morning at 8"
 *   means the user's local 8am, not 08:00 UTC). Absent ⇒ UTC (back-compat).
 * @returns {Promise<{created: Array<{id,name}>, alreadyPresent: number}>}
 */
export async function seedReflectionCycles(db, userId, { logger = () => {}, now = () => new Date(), tz = null } = {}) {
  if (!db?.harness?.createTask) throw new TypeError('seedReflectionCycles: db.harness.createTask required');
  if (typeof userId !== 'string' || !userId) throw new TypeError('seedReflectionCycles: userId required');

  // Seed the editable persona doc alongside the cycle tasks (idempotent; never clobbers edits).
  try { await seedPersonaDoc(db, userId, { logger }); } catch { /* non-fatal — scheduler falls back to the constant */ }

  let existing = [];
  try { existing = await db.harness.listTasks(userId); } catch { existing = []; }
  const cycleRows = (existing || []).filter((t) => t && t.created_by === CYCLE_CREATED_BY);
  const seeded = new Set(cycleRows.map((t) => t.name));

  // HEAL legacy cycle rows (upgrade path for migrations/0058). Rows seeded before the
  // tool_provenance column existed carry NULL and would go INERT — the cycles are the one
  // legitimate holder of the vault-WRITE tier, so losing it silently is the D-076 failure mode.
  //
  // The predicate is the PROMPT, not created_by: this design binds capability to the
  // INSTRUCTIONS. A row whose prompt still equals the in-repo CYCLES body is provably running
  // code-authored instructions and may hold the write tier; a row whose prompt was edited (by a
  // model via updateCycle, or by the owner) is left untrusted and the owner can restore it
  // deliberately by saving that cycle in Settings → Reflection (portal-reflection.js).
  //
  // This is why the backfill is NOT in the .sql: a SQL `WHERE tool_provenance IS NULL` guard is a
  // RE-PROMOTION condition for a row demoted on purpose, and migrate.js re-execs migration
  // statements on a self-heal. Only code can compare against CYCLES. Never demotes — a row
  // already stamped is left alone, so an owner's edited cycle keeps its trust.
  for (const t of cycleRows) {
    if (t.tool_provenance != null) continue;
    const def = CYCLES.find((c) => c.name === t.name);
    if (!def || t.prompt !== def.body) {
      if (def) logger(`seed-cycles: cycle "${t.name}" has edited instructions — left untrusted (no vault-write until re-saved in Settings → Reflection)`);
      continue;
    }
    try { await db.harness.setCycleProvenance(userId, t.id, ENGINE_PROVENANCE); logger(`seed-cycles: healed provenance for "${t.name}"`); }
    catch { logger(`seed-cycles: could not heal provenance for "${t.name}"`); }
  }

  const created = [];
  for (const c of CYCLES) {
    if (seeded.has(c.name)) continue;
    let nextRun = null;
    try {
      const parsed = parseSchedule(c.schedule);
      if (parsed) nextRun = computeNextRun(parsed, { after: now(), tz });
    } catch { nextRun = null; }
    if (!nextRun) { logger(`seed-cycles: skip ${c.id} — no next run for "${c.schedule}"`); continue; }
    try {
      const id = await db.harness.createTask(userId, {
        name: c.name,
        prompt: c.body,
        schedule: c.schedule,
        tz,
        nextRun,
        outputTarget: c.outputTarget,
        enabledTools: c.enabledTools,
        essential: c.essential,
        maxTurns: 50,
        status: 'active',
        triggerType: 'schedule',
        createdBy: CYCLE_CREATED_BY,
        // The ONE write-trusted provenance. Legitimate because `enabledTools` above is the
        // in-repo CYCLES constant, not model output — so this row may hold the vault-WRITE tier
        // at fire time. Every model-reachable writer omits this and gets NULL (untrusted).
        // See the task-trust-provenance design.
        toolProvenance: ENGINE_PROVENANCE,
      });
      created.push({ id, name: c.name });
    } catch (e) { logger(`seed-cycles: failed ${c.id} — ${e?.code || e?.name || 'error'}`); }
  }
  logger(`seed-cycles: ${created.length} created, ${seeded.size} already present`);
  return { created, alreadyPresent: seeded.size };
}

export default seedReflectionCycles;
