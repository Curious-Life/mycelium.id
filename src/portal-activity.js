// src/portal-activity.js — the unified activity feed: one endpoint that aggregates
// every background/inference job into a content-free list for the UI (header stream
// indicator + mindscape chip). Reads db.activityFeed (over background_jobs), reaps
// dead rows first (fail-closed), and computes a live ETA from elapsed/done × queued.
//
// SECURITY: loopback/authed like the rest of /portal; rows are content-free by
// construction (stage labels are constants, never names/text — §1).

import express from 'express';
import { getEmbedderHealth } from './embed/supervisor.js';

// Friendly constant labels per job kind (NEVER includes user content).
const KIND_LABELS = {
  'describe:name': 'Naming your areas',
  'describe:chronicle': 'Describing your areas',
  mycelium_generate: 'Mapping your mind',
  embed: 'Weaving your world',          // #20: warmer than "Reading your world"
  'inference:chat': 'Thinking…',        // live: the chat model is generating a reply
};

// Embedding/enrichment are CONTINUOUS (a drainer embeds the backlog on a timer),
// not discrete jobs — so they're projected at READ time from the message counts
// rather than written as background_jobs rows. One synthetic row while a backlog
// exists. (Embedding == enrichment in V1: both = messages with embedding_768.)
async function embedProjection(db, userId) {
  try {
    // Single source of truth — counts only embeddable (content-bearing) messages,
    // so `pending` reaches 0 (content-NULL rows can never embed). PIPELINE-INTEGRITY §P1.2.
    const { embedded, total, pending } = await db.messages.embedBacklogCached(userId); // polled @2.5s → cached (see embedBacklogCached)
    if (pending <= 0) return null;                       // nothing to do → not active
    let health = 'unknown';
    try { health = getEmbedderHealth()?.status ?? 'unknown'; } catch { /* supervisor down */ }
    return {
      id: 'embed',
      kind: 'embed',
      stage: health === 'error' ? 'Embedder needs attention' : KIND_LABELS.embed,
      done: embedded,
      total,
      remaining: pending,
      etaSeconds: null,                                  // continuous; per-second rate not measured in V1
      status: 'running',
      startedAt: null,
      finishedAt: null,
    };
  } catch {
    return null;
  }
}

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
      const rows = (await db.activityFeed.active(userId)).map((r) => shape(r, now));
      const embed = await embedProjection(db, userId);  // continuous embedding/enrichment (projected)
      const active = embed ? [embed, ...rows] : rows;
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
      const rows = (await db.activityFeed.active(userId)).map((r) => shape(r, now));
      const embed = await embedProjection(db, userId);
      const active = embed ? [embed, ...rows] : rows;
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
