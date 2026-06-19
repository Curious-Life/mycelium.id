// src/agent/seed-cycles.js — idempotently seed the six reflection cycles (Context Engine L2, Phase 1a).
//
// A reflection cycle = a scheduled_tasks row whose prompt is the cycle body and whose
// created_by marks it as engine-owned (createTask assigns its own uuid, so we identify
// cycles by created_by, not id). Seeding is idempotent: a cycle already present (matched by
// created_by + name) is skipped — safe to run on every boot, and it never clobbers a user's
// edits to a cycle's prompt/schedule. Gated by the caller behind settings.reflection.enabled.

import { parseSchedule, computeNextRun } from './scheduler-time.js';
import { CYCLES, CYCLE_CREATED_BY } from './cycle-prompts.js';
import { seedPersonaDoc } from '../skills/store.js';

/**
 * @param {object} db      keyed db (needs db.harness.createTask + db.harness.listTasks)
 * @param {string} userId
 * @param {object} [opts]  { logger, now }  now: () => Date (testable)
 * @returns {Promise<{created: Array<{id,name}>, alreadyPresent: number}>}
 */
export async function seedReflectionCycles(db, userId, { logger = () => {}, now = () => new Date() } = {}) {
  if (!db?.harness?.createTask) throw new TypeError('seedReflectionCycles: db.harness.createTask required');
  if (typeof userId !== 'string' || !userId) throw new TypeError('seedReflectionCycles: userId required');

  // Seed the editable persona doc alongside the cycle tasks (idempotent; never clobbers edits).
  try { await seedPersonaDoc(db, userId, { logger }); } catch { /* non-fatal — scheduler falls back to the constant */ }

  let existing = [];
  try { existing = await db.harness.listTasks(userId); } catch { existing = []; }
  const seeded = new Set(
    (existing || []).filter((t) => t && t.created_by === CYCLE_CREATED_BY).map((t) => t.name),
  );

  const created = [];
  for (const c of CYCLES) {
    if (seeded.has(c.name)) continue;
    let nextRun = null;
    try {
      const parsed = parseSchedule(c.schedule);
      if (parsed) nextRun = computeNextRun(parsed, { after: now(), tz: null });
    } catch { nextRun = null; }
    if (!nextRun) { logger(`seed-cycles: skip ${c.id} — no next run for "${c.schedule}"`); continue; }
    try {
      const id = await db.harness.createTask(userId, {
        name: c.name,
        prompt: c.body,
        schedule: c.schedule,
        nextRun,
        outputTarget: c.outputTarget,
        enabledTools: c.enabledTools,
        essential: c.essential,
        maxTurns: 50,
        status: 'active',
        triggerType: 'schedule',
        createdBy: CYCLE_CREATED_BY,
      });
      created.push({ id, name: c.name });
    } catch (e) { logger(`seed-cycles: failed ${c.id} — ${e?.code || e?.name || 'error'}`); }
  }
  logger(`seed-cycles: ${created.length} created, ${seeded.size} already present`);
  return { created, alreadyPresent: seeded.size };
}

export default seedReflectionCycles;
