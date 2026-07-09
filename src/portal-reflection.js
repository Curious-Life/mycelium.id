// src/portal-reflection.js — the Reflection-Cycles settings backend (Settings → Intelligence).
//
// The self-hosted control surface for the autonomous wake cycles: turn them on/off,
// see their schedules/status/next-fire, edit a cycle's timing/instructions, and set the
// timezone they fire in. Opt-in by design (CLAUDE.md §10 cost governance): the master
// toggle is the single consent point — enabling seeds the six cycles; disabling PAUSES
// them (rows kept, so a user's per-cycle edits survive an off→on).
//
// SECURITY: owner-only (mounted behind the portal owner gate like every other portal
// router), localhost. Responses carry ONLY structural cycle fields (name/schedule/status/
// next-run) — the list responses NEVER emit the cycle prompt body (§1). (The single-cycle
// GET returns the prompt on purpose, for the owner's own edit form.) No egress: nothing
// here sends to a channel.

import express from 'express';
import { seedReflectionCycles as realSeed } from './agent/seed-cycles.js';
import { CYCLE_CREATED_BY } from './agent/cycle-prompts.js';
import { humanSchedule, humanNextRun, computeNextRun } from './agent/scheduler-time.js';
import { buildCyclePatch } from './tools/cycles.js';
import { resolveTaskCapability } from './inference/capability.js';
import { REFLECTION_INFERENCE_TASK } from './agent/cycle-prompts.js';

/** Is this a real IANA zone Intl accepts? (fail-closed: reject anything Intl throws on). */
function isValidTz(tz) {
  if (typeof tz !== 'string' || !tz.trim() || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

export function portalReflectionRouter({ db, userId, authenticatePortalRequest, seed = realSeed, now = () => new Date() } = {}) {
  if (typeof authenticatePortalRequest !== 'function') throw new Error('portalReflectionRouter: authenticatePortalRequest required');
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));
  // Owner gate (defense in depth): enabling autonomous cycles is a sensitive control,
  // so every route resolves the owner independently of the global /api gate.
  const gate = (req, res) => { const u = authenticatePortalRequest(req); if (!u) { res.status(401).json({ error: 'unauthorized' }); return false; } return true; };

  const listCycleTasks = async () => {
    const tasks = await db.harness.listTasks(userId).catch(() => []);
    return (tasks || []).filter((t) => t && t.created_by === CYCLE_CREATED_BY && t.status !== 'completed');
  };
  const shape = (t) => ({
    id: t.id,
    name: t.name,
    schedule: t.schedule,
    humanSchedule: humanSchedule(t.schedule),
    status: t.status,
    essential: !!t.essential,
    outputTarget: t.output_target || 'none',
    nextRun: t.status === 'active' ? (t.next_run || null) : null,
    nextRunHuman: t.status === 'active' ? humanNextRun(t.next_run, t.tz) : '',
    lastRun: t.last_run || null,
    lastStatus: t.last_status || null,
    tz: t.tz || null,
  });

  // Model health for the dashboard banner (C3): cycles are worthless on a model that can't
  // call tools, and invisible with no model at all. Surface it so the user can fix it.
  const readModelHealth = async () => {
    try {
      const cap = await resolveTaskCapability(db, userId, REFLECTION_INFERENCE_TASK);
      return { configured: !!cap.configured, toolsCapable: !!cap.toolsCapable, model: cap.model || null };
    } catch { return { configured: false, toolsCapable: false, model: null }; }
  };

  // Unread check-ins: how many messages in the owner's Reflections thread arrived since the
  // user last looked. Drives the "N new" badge so a delivered morning note is DISCOVERABLE
  // without opening Settings — the check-ins were previously invisible outside this page.
  const readUnread = async (seenAt) => {
    try {
      const rows = (await db.messages.selectByConversation(userId, 'chat:reflections', { limit: 50 })) || [];
      if (!seenAt) return rows.length;
      return rows.filter((r) => String(r.created_at || '') > seenAt).length;
    } catch { return 0; }
  };

  const readState = async () => {
    const s = await db.users.getSettings(userId).catch(() => ({}));
    const timezone = await db.users.getTimezone(userId).catch(() => null);
    const cycles = (await listCycleTasks()).map(shape);
    const modelHealth = await readModelHealth();
    const unread = await readUnread(s?.reflection?.seenAt || null);
    return { enabled: !!s?.reflection?.enabled, timezone: timezone || 'UTC', cycles, modelHealth, unread };
  };

  // Re-arm every ACTIVE cycle's next_run under a (new) timezone, so an existing UTC-seeded
  // cycle starts firing at the user's local wall-clock time.
  const rearmCycles = async (tz) => {
    for (const t of await listCycleTasks()) {
      if (t.status !== 'active') { await db.harness.updateTask(userId, t.id, { tz }).catch(() => {}); continue; }
      let next = null;
      try { next = computeNextRun(t.schedule, { after: now(), tz }); } catch { next = null; }
      await db.harness.updateTask(userId, t.id, next ? { tz, next_run: next } : { tz }).catch(() => {});
    }
  };

  // Auto-adopt the computer's timezone the FIRST time we see it (the SPA sends it on
  // every request as X-Timezone — portal-app/src/lib/api.ts). Only when the vault has
  // none set yet, so cycles fire in local time with zero user action; an explicit choice
  // (a later PUT {timezone}) is never overridden. Best-effort — never blocks the request.
  const maybeAdoptTz = async (req) => {
    try {
      const hdr = req.headers['x-timezone'];
      const tz = typeof hdr === 'string' ? hdr.trim() : '';
      if (!tz || !isValidTz(tz)) return;
      const cur = await db.users.getTimezone(userId).catch(() => null);
      if (cur) return;                       // already set (explicitly or previously adopted)
      await db.users.updateTimezone(userId, tz);
      await rearmCycles(tz);                 // re-arm any already-seeded (UTC) cycles into local time
    } catch { /* non-fatal */ }
  };

  // ── GET — current enable state + timezone + the cycle list ─────────────────
  router.get('/settings/reflection', async (req, res) => {
    if (!gate(req, res)) return;
    try { await maybeAdoptTz(req); res.json(await readState()); }
    catch (e) { res.status(500).json({ error: String(e?.message || e).slice(0, 200) }); }
  });

  // ── PUT — master toggle and/or timezone ────────────────────────────────────
  router.put('/settings/reflection', async (req, res) => {
    if (!gate(req, res)) return;
    try {
      const body = req.body || {};
      await maybeAdoptTz(req);   // adopt the device tz if none set, so an enable seeds local

      // Timezone first: persist + re-arm, so a subsequent enable seeds in the right tz.
      if (typeof body.timezone === 'string' && body.timezone.trim()) {
        const tz = body.timezone.trim();
        if (!isValidTz(tz)) return res.status(400).json({ error: 'invalid timezone' });
        await db.users.updateTimezone(userId, tz);
        await rearmCycles(tz);
      }

      if (typeof body.enabled === 'boolean') {
        // FAIL CLOSED on a settings-read error: updateSettings replaces the whole blob,
        // so proceeding with `{}` after a genuine throw (corrupt/undecryptable settings)
        // would WIPE every other setting (TTS, per-task models, …). A fresh vault legit-
        // imately returns {}; only a real throw is fatal here.
        let s;
        try { s = (await db.users.getSettings(userId)) || {}; }
        catch { return res.status(500).json({ error: 'could not read settings' }); }
        s.reflection = { ...(s.reflection || {}), enabled: body.enabled };
        await db.users.updateSettings(userId, s);
        if (body.enabled) {
          // Seed idempotently in the user's timezone; the always-running scheduler
          // picks the new tasks up on its next tick (no restart). A prior disable
          // left the rows paused → resume (status:active) + re-arm each next_run so a
          // disable→enable round-trip preserves the user's per-cycle edits.
          const tz = await db.users.getTimezone(userId).catch(() => null);
          await seed(db, userId, { tz, logger: () => {} });
          for (const t of await listCycleTasks()) {
            let next = null;
            try { next = computeNextRun(t.schedule, { after: now(), tz: tz || t.tz || null }); } catch { next = null; }
            const patch = { status: 'active' };
            if (next) patch.next_run = next;
            if (tz) patch.tz = tz;
            await db.harness.updateTask(userId, t.id, patch).catch(() => {});
          }
        } else {
          for (const t of await listCycleTasks()) {
            if (t.status !== 'paused') await db.harness.setTaskStatus(userId, t.id, 'paused').catch(() => {});
          }
        }
      }

      res.json({ ok: true, ...(await readState()) });
    } catch (e) { res.status(500).json({ error: String(e?.message || e).slice(0, 200) }); }
  });

  // ── GET recent check-ins — the visible output of the 'chat' cycles ─────────
  // Morning/evening/weekly deliver into the owner-only `chat:reflections` thread;
  // the dashboard shows the latest so the user sees "your agent left you a note"
  // right where they manage the cycles (also readable via GET /chat/history).
  router.get('/settings/reflection/messages', async (req, res) => {
    if (!gate(req, res)) return;
    try {
      const rows = (await db.messages.selectByConversation(userId, 'chat:reflections', { limit: 20 }).catch(() => [])) || [];
      const messages = rows.map((r) => ({
        id: r.id, role: r.role === 'assistant' ? 'assistant' : 'user',
        content: r.content || '', at: r.created_at || null, model: r.model || null,
      })).reverse();
      res.json({ messages });
    } catch (e) { res.status(500).json({ error: String(e?.message || e).slice(0, 200) }); }
  });

  // ── GET one cycle (incl. its instructions) — for the edit form ─────────────
  router.get('/settings/reflection/cycles/:id', async (req, res) => {
    if (!gate(req, res)) return;
    try {
      const t = (await listCycleTasks()).find((c) => c.id === String(req.params.id || ''));
      if (!t) return res.status(404).json({ error: 'unknown cycle' });
      res.json({ cycle: { ...shape(t), prompt: t.prompt || '' } });
    } catch (e) { res.status(500).json({ error: String(e?.message || e).slice(0, 200) }); }
  });

  // ── POST mark the Reflections thread as seen — clears the unread badge ──────
  router.post('/settings/reflection/seen', async (req, res) => {
    if (!gate(req, res)) return;
    try {
      let s;
      try { s = (await db.users.getSettings(userId)) || {}; }
      catch { return res.status(500).json({ error: 'could not read settings' }); }
      s.reflection = { ...(s.reflection || {}), seenAt: new Date().toISOString() };
      await db.users.updateSettings(userId, s);
      res.json({ ok: true, unread: 0 });
    } catch (e) { res.status(500).json({ error: String(e?.message || e).slice(0, 200) }); }
  });

  // ── GET recent cycle RUNS — health/observability (content-free) ────────────
  // harness_runs is content-free operational state (status + error CODE + token counts);
  // this lets the user see "your evening check-in has failed 3×" or "skipped-quiet today"
  // without a cycle failing silently. Filtered to reflection-cycle tasks only.
  router.get('/settings/reflection/runs', async (req, res) => {
    if (!gate(req, res)) return;
    try {
      const cycleTasks = await listCycleTasks();
      const byId = new Map(cycleTasks.map((t) => [t.id, t.name]));
      const runs = (await db.harness.recentRuns(userId, 60).catch(() => [])) || [];
      const items = runs
        .filter((r) => byId.has(r.task_id))
        .slice(0, 30)
        .map((r) => ({
          cycle: byId.get(r.task_id) || null,
          status: r.status || null,
          error: r.error || null,
          at: r.finished_at || r.started_at || null,
        }));
      res.json({ runs: items });
    } catch (e) { res.status(500).json({ error: String(e?.message || e).slice(0, 200) }); }
  });

  // ── PATCH one cycle — instructions / schedule / on-off ─────────────────────
  router.patch('/settings/reflection/cycles/:id', async (req, res) => {
    if (!gate(req, res)) return;
    try {
      const id = String(req.params.id || '');
      const task = (await listCycleTasks()).find((t) => t.id === id);
      if (!task) return res.status(404).json({ error: 'unknown cycle' });

      const built = buildCyclePatch(req.body || {}, task, now);
      if (built.error) return res.status(400).json({ error: built.error });
      if (!Object.keys(built.patch).length) return res.status(400).json({ error: 'nothing to update' });

      await db.harness.updateTask(userId, task.id, built.patch);
      const updated = (await listCycleTasks()).find((t) => t.id === id);
      res.json({ ok: true, cycle: updated ? shape(updated) : null });
    } catch (e) { res.status(500).json({ error: String(e?.message || e).slice(0, 200) }); }
  });

  return router;
}

export default portalReflectionRouter;
