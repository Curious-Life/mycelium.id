// src/portal-activity.js — the unified activity feed: one endpoint that aggregates
// every background/inference job into a content-free list for the UI (header stream
// indicator + mindscape chip). Reads db.activityFeed (over background_jobs), reaps
// dead rows first (fail-closed), and computes a live ETA from elapsed/done × queued.
//
// SECURITY: loopback/authed like the rest of /portal; rows are content-free by
// construction (stage labels are constants, never names/text — §1).

import express from 'express';
import { getEmbedderHealth } from './embed/supervisor.js';
import { isEnrichCategorizePaused } from './enrich/drainer.js';

// Plain, accurate label per job kind — what the operation LITERALLY is (content-free, never
// user text). Deliberately not poetic: the user should be able to tell exactly what's running.
const KIND_LABELS = {
  'describe:name': 'Naming clusters',
  'describe:chronicle': 'Describing clusters',
  mycelium_generate: 'Clustering messages',
  embed: 'Embedding messages',             // computing 768-dim vectors for search/clustering
  categorize: 'Categorizing messages',     // CE L1: per-message domain + register tags via the on-box model
  'inference:chat': 'Generating reply',    // live: the chat model is generating a reply
};

// Where/how each runs — complements the stage (WHAT) + model (WHICH). Only the always-local
// stages claim 'on-device'; chat/describe route by the chosen model/provider, so the model
// name itself carries local-vs-cloud (no process tag → just the model is shown).
const PROCESS_LABELS = {
  embed: 'on-device',
  categorize: 'on-device',
  mycelium_generate: 'on-device · CPU',
};

// Fixed on-box embedding model in V1 (ONNX Nomic v1.5; the embed-service exposes it at /health).
const EMBED_MODEL = 'nomic-v1.5';

// The L1 labeling model the drainer uses: the per-task setting if the user picked one, else the
// shipped default (qwen3.5:4b). Best-effort + content-free; never throws.
async function resolveLabelModel(db, userId) {
  try {
    const s = await db.users.getSettings(userId);
    const m = s?.taskModels?.categorize?.model;
    if (typeof m === 'string' && m.trim()) return m.trim();
  } catch { /* settings unavailable → default */ }
  return 'qwen3.5:4b';
}

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
      model: EMBED_MODEL,                                // what's running
      process: PROCESS_LABELS.embed,                     // what it's doing
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

// Context Engine L1 categorization is CONTINUOUS (the enrich drainer tags the backlog
// on a timer via the on-box model), not a discrete background_jobs row — so, like
// embedding, it's projected at READ time from the message counts. One synthetic row
// while a backlog exists. This is what makes the on-box model's heavy churn VISIBLE in
// the activity indicator instead of being invisible CPU/GPU load (the dormancy bug).
async function categorizeProjection(db, userId) {
  try {
    const { tagged, total, pending } = await db.messages.categoriesBacklogCached(userId);
    if (pending <= 0) return null;                       // caught up → not active
    const paused = (() => { try { return isEnrichCategorizePaused(); } catch { return false; } })();
    const model = await resolveLabelModel(db, userId);
    return {
      id: 'categorize',
      kind: 'categorize',
      // Surface the paused state in the always-on indicator so a user who stopped the
      // churn sees there's still pending work waiting, not just silence.
      stage: paused ? `${KIND_LABELS.categorize} · paused` : KIND_LABELS.categorize,
      model,                                             // the on-box labeling model (qwen3.5:4b)
      process: PROCESS_LABELS.categorize,                // what it's doing
      done: tagged,
      total,
      remaining: pending,
      etaSeconds: null,                                  // continuous; per-second rate not measured in V1
      status: paused ? 'paused' : 'running',
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
    model: row.model || null,                       // what's running (if the job recorded it)
    process: PROCESS_LABELS[row.kind] || null,      // what it's doing
    done,
    total,
    remaining: total > done ? total - done : 0,
    etaSeconds: etaSeconds(row, nowMs),
    status: row.status,
    stalled: !!Number(row.stalled),  // watchdog flag → "taking longer than usual" chip hint (Gap #4)
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
      const categorize = await categorizeProjection(db, userId); // continuous CE L1 tagging (projected)
      const active = [embed, categorize, ...rows].filter(Boolean);
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
      const categorize = await categorizeProjection(db, userId);
      const active = [embed, categorize, ...rows].filter(Boolean);
      const lead = active[0] || null;
      res.json({
        state: active.length ? 'running' : 'idle',
        count: active.length,
        currentStage: lead?.stage || null,
        model: lead?.model ?? null,                 // what model is working
        process: lead?.process ?? null,             // what process it's running
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
