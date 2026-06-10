// src/portal-activity.js — the unified activity feed: one endpoint that aggregates
// every background/inference job into a content-free list for the UI (header stream
// indicator + mindscape chip). Reads db.activityFeed (over background_jobs), reaps
// dead rows first (fail-closed), and computes a live ETA from elapsed/done × queued.
//
// SECURITY: loopback/authed like the rest of /portal; rows are content-free by
// construction (stage labels are constants, never names/text — §1).

import express from 'express';

// Friendly constant labels per job kind (NEVER includes user content).
const KIND_LABELS = {
  'describe:name': 'Naming your areas',
  'describe:chronicle': 'Describing your areas',
  mycelium_generate: 'Mapping your mind',
  enrich: 'Reading your world',
};

function parseSqliteTs(ts) {
  if (!ts) return NaN;
  // SQLite datetime('now') → 'YYYY-MM-DD HH:MM:SS' (UTC, no zone). Make it ISO-UTC.
  return Date.parse(String(ts).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? '' : 'Z'));
}

function etaSeconds(row, nowMs) {
  const done = Number(row.step) || 0;
  const total = Number(row.total_steps) || 0;
  if (done <= 0 || total <= done) return null;          // no estimate before the 1st item / when complete
  const started = parseSqliteTs(row.started_at);
  const elapsed = nowMs - started;
  if (!(elapsed > 0)) return null;
  const perItem = elapsed / done;                        // overall average (robust across restarts)
  return Math.max(0, Math.round((perItem * (total - done)) / 1000));
}

function shape(row, nowMs) {
  const done = Number(row.step) || 0;
  const total = Number(row.total_steps) || 0;
  return {
    id: row.id,
    kind: row.kind,
    stage: row.stage_label || KIND_LABELS[row.kind] || row.kind,
    done,
    total,
    remaining: total > done ? total - done : 0,
    etaSeconds: etaSeconds(row, nowMs),
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at || null,
  };
}

export function portalActivityRouter({ db, userId, authenticatePortalRequest }) {
  if (!db) throw new Error('portalActivityRouter: db required');
  if (typeof authenticatePortalRequest !== 'function') throw new Error('portalActivityRouter: authenticatePortalRequest required');
  const router = express.Router();
  const auth = (req, res) => { const u = authenticatePortalRequest(req); if (!u) { res.status(401).json({ error: 'Unauthorized' }); return null; } return u; };

  // GET /activity — the rich feed: active jobs (with ETA) + recent history.
  router.get('/activity', async (req, res) => {
    if (!auth(req, res)) return;
    const now = Date.now();
    try {
      await db.activityFeed.reap(userId);               // flip dead 'running' rows → abandoned
      const active = (await db.activityFeed.active(userId)).map((r) => shape(r, now));
      const recent = (await db.activityFeed.recent(userId, 8)).map((r) => shape(r, now));
      res.json({ active, recent });
    } catch {
      res.json({ active: [], recent: [] });
    }
  });

  // GET /pipeline/status — the compact header summary (one line).
  router.get('/pipeline/status', async (req, res) => {
    if (!auth(req, res)) return;
    const now = Date.now();
    try {
      await db.activityFeed.reap(userId);
      const active = (await db.activityFeed.active(userId)).map((r) => shape(r, now));
      const lead = active[0] || null;
      res.json({
        state: active.length ? 'running' : 'idle',
        count: active.length,
        currentStage: lead?.stage || null,
        progress: lead ? { completed: lead.done, total: lead.total } : null,
        etaSeconds: lead?.etaSeconds ?? null,
      });
    } catch {
      res.json({ state: 'idle', count: 0, currentStage: null, progress: null, etaSeconds: null });
    }
  });

  return router;
}

export default portalActivityRouter;
