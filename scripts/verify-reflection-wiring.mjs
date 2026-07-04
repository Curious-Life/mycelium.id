// scripts/verify-reflection-wiring.mjs — Wake-cycle WIRING gate (design 2026-07-03).
//
// Covers the last-mile wiring that turns the (already-ported) reflection engine from
// dormant+invisible into a working, controllable feature:
//   A. getContext emits a YOUR REFLECTION CYCLES section when cycles exist (+ hides otherwise)
//   B. the portal reflection router: enable → seed 6 · disable → pause all · re-enable → resume
//   C. per-cycle PATCH (schedule/instructions/on-off) via the shared buildCyclePatch
//   D. timezone persists + re-arms cycles (local-time scheduling, not UTC)
//   E. 'chat' cycle output routes to the visible chat:reflections thread
// Isolated: an in-memory db + a live express mount (no vault, no real boot).

import express from 'express';
import http from 'node:http';
import { createContextDomain } from '../src/tools/context.js';
import { portalReflectionRouter } from '../src/portal-reflection.js';
import { CYCLE_CREATED_BY } from '../src/agent/cycle-prompts.js';

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); }
};

// ── in-memory db ────────────────────────────────────────────────────────────
function makeDb() {
  const tasks = [];
  const msgs = [];
  let n = 0;
  let settings = {};
  let timezone = null;
  const findCycle = (id) => tasks.find((t) => t.id === id);
  return {
    _tasks: tasks, _msgs: msgs,
    users: {
      async getSettings() { return JSON.parse(JSON.stringify(settings)); },
      async updateSettings(_u, s) { settings = JSON.parse(JSON.stringify(s)); },
      async getTimezone() { return timezone; },
      async updateTimezone(_u, tz) { timezone = tz; },
    },
    harness: {
      async createTask(userId, t) {
        const id = `t${++n}`;
        tasks.push({ id, user_id: userId, name: t.name, prompt: t.prompt, schedule: t.schedule,
          tz: t.tz ?? null, next_run: t.nextRun, output_target: t.outputTarget,
          enabled_tools: t.enabledTools, essential: !!t.essential, status: t.status || 'active',
          created_by: t.createdBy, last_run: null, last_status: null });
        return id;
      },
      async listTasks() { return tasks.map((t) => ({ ...t })); },
      async updateTask(_u, id, fields) { const t = findCycle(id); if (t) Object.assign(t, fields); },
      async setTaskStatus(_u, id, status) { const t = findCycle(id); if (t) t.status = status; },
    },
    messages: {
      async selectByConversation(_u, conversationId, { limit = 30 } = {}) {
        return msgs.filter((m) => m.conversation_id === conversationId).slice(-limit);
      },
    },
  };
}

// ── live mount ──────────────────────────────────────────────────────────────
const db = makeDb();
const app = express();
app.use('/api/v1/portal', portalReflectionRouter({ db, userId: 'u1', authenticatePortalRequest: () => ({ id: 'u1' }) }));
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}/api/v1/portal`;
const j = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

try {
  // A. getContext — hidden when no cycles
  {
    const dom = createContextDomain({ getDb: () => db, readMindFile: async () => null, userId: 'u1' });
    const out = await dom.handlers.getContext({ include: ['cycles'] });
    ok(!/YOUR REFLECTION CYCLES/.test(out), 'getContext hides the cycles section when none exist');
  }

  // A1b. auto-adopt: a GET carrying X-Timezone sets tz when none is stored yet
  {
    const res = await fetch(base + '/settings/reflection', { headers: { 'x-timezone': 'Europe/Berlin' } });
    const b = await res.json();
    ok(b.timezone === 'Europe/Berlin', 'GET auto-adopts the computer timezone (X-Timezone) when none set');
    // and does NOT override a later explicit choice
    await j('PUT', '/settings/reflection', { timezone: 'America/New_York' });
    const res2 = await fetch(base + '/settings/reflection', { headers: { 'x-timezone': 'Europe/Berlin' } });
    ok((await res2.json()).timezone === 'America/New_York', 'auto-adopt never overrides an explicit timezone');
  }

  // B. enable → seed 6 in the user's tz
  let r = await j('PUT', '/settings/reflection', { timezone: 'America/New_York', enabled: true });
  ok(r.status === 200 && r.body.enabled === true, 'PUT enable returns enabled:true');
  ok(r.body.cycles.length === 6, 'enable seeds 6 cycles', `(${r.body.cycles.length})`);
  ok(db._tasks.every((t) => t.created_by === CYCLE_CREATED_BY), 'seeded tasks carry the cycle marker');
  ok(db._tasks.every((t) => t.tz === 'America/New_York'), 'cycles seeded in the user timezone (not UTC)');
  ok(db._tasks.every((t) => t.next_run), 'cycles have a computed next_run');
  ok(r.body.timezone === 'America/New_York', 'GET/PUT report the persisted timezone');

  // A2. getContext — now shows the section
  {
    const dom = createContextDomain({ getDb: () => db, readMindFile: async () => null, userId: 'u1' });
    const out = await dom.handlers.getContext({ include: ['cycles'] });
    ok(/YOUR REFLECTION CYCLES \(6\)/.test(out), 'getContext shows the cycles section once seeded');
    ok(/every day at 8am/.test(out), 'section renders a human schedule');
    ok(/updateCycle/.test(out), 'section tells the agent how to change cycles');
  }

  // C. PATCH — pause one cycle
  const morning = r.body.cycles.find((c) => c.name === 'Morning check-in');
  r = await j('PATCH', `/settings/reflection/cycles/${morning.id}`, { enabled: false });
  ok(r.status === 200 && r.body.cycle.status === 'paused', 'PATCH can pause a single cycle');
  // PATCH — reschedule
  r = await j('PATCH', `/settings/reflection/cycles/${morning.id}`, { schedule: 'daily:9', enabled: true });
  ok(r.status === 200 && r.body.cycle.schedule === 'daily:9' && r.body.cycle.status === 'active', 'PATCH reschedules + re-enables');
  // PATCH — reject a bad schedule
  r = await j('PATCH', `/settings/reflection/cycles/${morning.id}`, { schedule: 'garbage' });
  ok(r.status === 400, 'PATCH rejects an invalid schedule (400)');
  // PATCH — unknown cycle
  r = await j('PATCH', '/settings/reflection/cycles/nope', { enabled: false });
  ok(r.status === 404, 'PATCH on an unknown cycle → 404');

  // D. timezone re-arm — change tz, cycles re-arm under it
  const beforeNext = db._tasks.find((t) => t.name === 'Weekly review').next_run;
  r = await j('PUT', '/settings/reflection', { timezone: 'Asia/Tokyo' });
  ok(r.status === 200 && r.body.timezone === 'Asia/Tokyo', 'timezone change persists');
  ok(db._tasks.every((t) => t.tz === 'Asia/Tokyo'), 'all cycles re-armed to the new timezone');
  const afterNext = db._tasks.find((t) => t.name === 'Weekly review').next_run;
  ok(beforeNext !== afterNext, 'active cycle next_run recomputed under the new timezone');
  // invalid tz rejected
  r = await j('PUT', '/settings/reflection', { timezone: 'Not/AZone!!' });
  ok(r.status === 400, 'invalid timezone rejected (400)');

  // B2. disable → all paused (rows kept)
  r = await j('PUT', '/settings/reflection', { enabled: false });
  ok(r.status === 200 && r.body.enabled === false, 'PUT disable returns enabled:false');
  ok(db._tasks.length === 6 && db._tasks.every((t) => t.status === 'paused'), 'disable pauses all cycles, keeps the rows');
  // re-enable → resumed
  r = await j('PUT', '/settings/reflection', { enabled: true });
  ok(r.body.cycles.every((c) => c.status === 'active'), 're-enable resumes all cycles');
  ok(db._tasks.length === 6, 're-enable does not duplicate cycles (idempotent seed)', `(${db._tasks.length})`);

  // A3. getContext reflects paused state truthfully
  {
    await j('PATCH', `/settings/reflection/cycles/${morning.id}`, { enabled: false });
    const dom = createContextDomain({ getDb: () => db, readMindFile: async () => null, userId: 'u1' });
    const out = await dom.handlers.getContext({ include: ['cycles'] });
    ok(/· paused/.test(out), 'getContext labels a paused cycle as paused');
    await j('PATCH', `/settings/reflection/cycles/${morning.id}`, { enabled: true });
  }

  // E. delivery target — schedulerDeliver maps 'chat' → chat:reflections (asserted structurally
  //    against the server-rest source so the constant can't silently drift).
  {
    const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/server-rest.js', import.meta.url), 'utf8'));
    ok(/target === 'chat'\s*\n?\s*\?\s*'chat:reflections'/.test(src) || src.includes("'chat:reflections'"), "'chat' cycle output routes to chat:reflections");
  }
  // messages endpoint reads that thread
  db._msgs.push({ id: 'm1', conversation_id: 'chat:reflections', role: 'assistant', content: 'Good morning — noticed you shipped X.', created_at: '2026-07-03T12:00:00Z', model: 'claude-opus-4-8' });
  r = await j('GET', '/settings/reflection/messages');
  ok(r.status === 200 && r.body.messages.length === 1 && r.body.messages[0].content.includes('Good morning'), 'reflection messages endpoint surfaces check-ins from chat:reflections');

  // M1 regression: a genuine getSettings THROW must fail closed (500), NOT proceed with {}
  // and clobber every other setting via the whole-blob updateSettings replace.
  {
    let wrote = null;
    const db2 = makeDb();
    db2.users.getSettings = async () => { throw new Error('corrupt settings blob'); };
    db2.users.updateSettings = async (_u, s) => { wrote = s; };
    const app2 = express();
    app2.use('/api/v1/portal', portalReflectionRouter({ db: db2, userId: 'u1', authenticatePortalRequest: () => ({ id: 'u1' }) }));
    const srv2 = await new Promise((res) => { const s = app2.listen(0, () => res(s)); });
    const b2 = `http://127.0.0.1:${srv2.address().port}/api/v1/portal`;
    const res = await fetch(b2 + '/settings/reflection', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
    ok(res.status === 500, 'enable fails closed (500) when settings read throws');
    ok(wrote === null, 'a settings-read throw never writes (no clobber of other settings)');
    srv2.close();
  }

} finally {
  server.close();
}

console.log(`\n${pass} pass · ${fail} fail`);
console.log(fail === 0
  ? 'VERDICT: GO — reflection-cycle wiring: agent-aware · enable/disable · per-cycle edit · local-time · visible delivery'
  : 'VERDICT: NO-GO');
process.exit(fail === 0 ? 0 : 1);
