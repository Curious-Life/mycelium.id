// src/portal-agent-activity.js — the Agents ACTIVITY timeline.
//
// The Agents page's "Activity" was a live tool-execution SSE stream that read "disconnected /
// no activity" whenever nothing was streaming — even though the vault records every agent turn.
// This is the real, historical timeline, built from the three activity spines:
//   • harness_runs        — every agent TURN (chat / channel / scheduler): who/where/when + status
//   • scheduled_tasks     — wake-cycles: schedule, next/last run, whether it ran or failed
//   • channel_write_audit — what an autonomous turn wrote to the vault (hash-only, surfaced on inspect)
//
// GET /agent-activity         → { events[], cycles[], nextCursor }  (paginated by time cursor)
// GET /agent-activity/:id     → { run, messages[], writes[] }       (inspect what happened)
//
// SECURITY: authed like the rest of /portal (owner session). The list is content-free
// (triggers, status, token counts, channel platform — never message text). The inspect
// endpoint returns the OWNER's own decrypted conversation (their data, their portal); writes
// are hash-only (§1). A run id that isn't the owner's → 404.

import express from 'express';

/** Channel platform from a 'channel:<platform>:<id>' conversation id (telegram/discord/whatsapp). */
function channelPlatform(convId) {
  const m = typeof convId === 'string' ? convId.match(/^channel:([a-z]+):/i) : null;
  return m ? m[1].toLowerCase() : null;
}

/** Human-facing who/where for a run, by trigger (never message content). */
function labelFor(run, taskName) {
  if (run.trigger === 'scheduler') return { who: 'Scheduled cycle', where: taskName || 'cycle', source: 'scheduler' };
  if (run.trigger === 'channel') {
    const p = channelPlatform(run.conversation_id);
    return { who: p ? `${p[0].toUpperCase()}${p.slice(1)} message` : 'Channel message', where: p || 'channel', source: 'channel' };
  }
  if (run.trigger === 'chat') return { who: 'You', where: 'app chat', source: 'chat' };
  return { who: run.trigger || 'agent', where: run.trigger || 'agent', source: run.trigger || 'agent' };
}

export function portalAgentActivityRouter({ db, userId, authenticatePortalRequest }) {
  if (!db) throw new Error('portalAgentActivityRouter: db required');
  if (typeof authenticatePortalRequest !== 'function') throw new Error('portalAgentActivityRouter: authenticatePortalRequest required');
  const router = express.Router();
  const auth = (req, res) => { const u = authenticatePortalRequest(req); if (!u) { res.status(401).json({ error: 'Unauthorized' }); return null; } return u; };

  // ── Timeline list: runs (history) + scheduled cycles ──
  router.get('/agent-activity', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 60, 1), 200);
      const before = typeof req.query.before === 'string' && req.query.before ? req.query.before : null;

      // Scheduled cycles + a task_id → name map (one read serves both).
      let tasks = [];
      try { tasks = (await db.harness?.listTasks?.(userId)) || []; } catch { /* none */ }
      const taskName = {};
      for (const t of tasks) taskName[t.id] = t.name;
      const cycles = tasks.map((t) => ({
        id: t.id, name: t.name, schedule: t.schedule, status: t.status,
        nextRun: t.next_run, lastRun: t.last_run, lastStatus: t.last_status,
        runCount: t.run_count, outputTarget: t.output_target, createdBy: t.created_by,
      }));

      // Run history → timeline events (content-free).
      let runs = [];
      try { runs = (await db.harness?.listRuns?.(userId, { limit, before })) || []; } catch { /* none */ }
      const events = runs.map((r) => {
        const ts = r.finished_at || r.started_at;
        const lbl = labelFor(r, taskName[r.task_id]);
        return {
          kind: 'run', id: r.id, ts,
          trigger: r.trigger, status: r.status, source: lbl.source, who: lbl.who, where: lbl.where,
          inputTokens: r.input_tokens, outputTokens: r.output_tokens, error: r.error,
          startedAt: r.started_at, finishedAt: r.finished_at,
          conversationId: r.conversation_id, taskId: r.task_id, taskName: taskName[r.task_id] || null,
        };
      });
      const nextCursor = events.length === limit ? (events[events.length - 1]?.ts || null) : null;
      res.json({ events, cycles, nextCursor });
    } catch (e) {
      res.status(500).json({ error: 'Could not load activity', code: e?.code || e?.name || 'error' });
    }
  });

  // ── Inspect one run: what happened (the conversation + any vault writes) ──
  router.get('/agent-activity/:id', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const run = await db.harness?.getRun?.(userId, req.params.id);
      if (!run) { res.status(404).json({ error: 'Not found' }); return; }
      let taskName = null;
      if (run.task_id) { try { taskName = (await db.harness?.getTask?.(userId, run.task_id))?.name || null; } catch { /* gone */ } }
      // The conversation that ran (owner's own decrypted messages).
      let messages = [];
      if (run.conversation_id) {
        try {
          const rows = await db.messages?.selectByConversation?.(userId, run.conversation_id, { limit: 50 });
          messages = (rows || []).reverse().map((m) => ({ role: m.role, content: m.content, source: m.source, createdAt: m.created_at }));
        } catch { /* none */ }
      }
      // Vault writes from this conversation (hash-only — what the assistant wrote, never the value).
      let writes = [];
      if (run.conversation_id) {
        try {
          const all = (await db.harness?.listWrites?.(userId, 200)) || [];
          writes = all.filter((w) => w.conversation_id === run.conversation_id)
            .map((w) => ({ tool: w.tool, trigger: w.trigger, argHash: w.arg_hash, createdAt: w.created_at }));
        } catch { /* none */ }
      }
      const lbl = labelFor(run, taskName);
      res.json({
        run: {
          id: run.id, trigger: run.trigger, status: run.status, source: lbl.source, who: lbl.who, where: lbl.where,
          inputTokens: run.input_tokens, outputTokens: run.output_tokens, error: run.error,
          startedAt: run.started_at, finishedAt: run.finished_at,
          conversationId: run.conversation_id, taskId: run.task_id, taskName,
        },
        messages, writes,
      });
    } catch (e) {
      res.status(500).json({ error: 'Could not inspect run', code: e?.code || e?.name || 'error' });
    }
  });

  return router;
}

export default portalAgentActivityRouter;
