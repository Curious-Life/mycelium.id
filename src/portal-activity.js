// src/portal-activity.js — the unified activity feed: one endpoint that aggregates
// every background/inference job into a content-free list for the UI (header stream
// indicator + mindscape chip). Reads db.activityFeed (over background_jobs), reaps
// dead rows first (fail-closed), and computes a live ETA from elapsed/done × queued.
//
// SECURITY: loopback/authed like the rest of /portal; rows are content-free by
// construction (stage labels are constants, never names/text — §1).

import express from 'express';
import { getEmbedderHealth } from './embed/supervisor.js';
import { isEnrichCategorizePaused, getEnrichDrainerStatus, defaultLabelModel } from './enrich/drainer.js';

// Plain, accurate label per job kind — what the operation LITERALLY is (content-free, never
// user text). Deliberately not poetic: the user should be able to tell exactly what's running.
const KIND_LABELS = {
  'describe:name': 'Naming clusters',
  'describe:chronicle': 'Describing clusters',
  mycelium_generate: 'Clustering messages',
  embed: 'Embedding messages',             // computing 768-dim vectors for search/clustering
  categorize: 'Categorizing messages',     // CE L1: per-message domain + register tags via the on-box model
  import: 'Importing your data',           // an import in flight — the longest thing a new user waits on
  'model-pull': 'Downloading a local model', // a consented model download (GBs) — was log-only and invisible
  'inference:chat': 'Generating reply',    // live: the chat model is generating a reply
  'inference:channel': 'Replying on a channel', // live: a model is answering an inbound Telegram/Discord message
};

// Where/how each runs — complements the stage (WHAT) + model (WHICH). Only the always-local
// stages claim 'on-device'; chat/describe route by the chosen model/provider, so the model
// name itself carries local-vs-cloud (no process tag → just the model is shown).
const PROCESS_LABELS = {
  embed: 'on-device',
  categorize: 'on-device',
  mycelium_generate: 'on-device · CPU',
  'model-pull': 'downloading',   // the one job here that is NOT compute — it is network + disk
};

// Fixed on-box embedding model in V1 (ONNX Nomic v1.5; the embed-service exposes it at /health).
const EMBED_MODEL = 'nomic-v1.5';

// The L1 labeling model the drainer uses — resolved by THE drainer's own resolver.
//
// ⚠️ This file had its OWN COPY of this function, with the implicit `return 'qwen3.5:4b'`
// fallback, and increment M's caller audit MISSED IT: the audit grepped the NAME
// (`defaultLabelModel`), and this copy was called `resolveLabelModel`. That is the exact
// failure the pre-deletion-caller-audit skill warns about — grep the CONCEPT ("who resolves
// a label model?"), not the identifier.
//
// Left un-migrated it re-created, in THIS file, the precise bug the comment 15 lines below
// says was fixed for embed: an unapproved vault (no model, nothing running, qwen not even on
// disk) rendered "Categorizing messages · qwen3.5:4b · on-device · running" FOREVER — "a
// stuck vault and a healthy one looked identical from here" (independent review, 2026-07-16).
// ⇒ imported from the drainer at the top of this file. null now means "not approved", and
// categorizeProjection below must render that state, not paper over it.

// Embedding/enrichment are CONTINUOUS (a drainer embeds the backlog on a timer),
// not discrete jobs — so they're projected at READ time from the message counts
// rather than written as background_jobs rows. One synthetic row while a backlog
// exists. (Embedding == enrichment in V1: both = messages with embedding_768.)
async function embedProjection(db, userId) {
  try {
    // Single source of truth. `pending` is COUNTED with the drainer's own predicate
    // (nlp_processed 0/NULL + content-bearing), so it counts work that will actually be
    // picked up and REACHES 0. It used to be the projection `total - embedded`, which
    // pinned this row at 'running' FOREVER on any vault holding a permanently
    // un-embeddable row — a stuck vault and a healthy one looked identical from here.
    // @see docs/DATA-READINESS-DESIGN-2026-07-15.md §3.3; PIPELINE-INTEGRITY §P1.2.
    const { embedded, total, pending } = await db.messages.embedBacklogCached(userId); // polled @2.5s → cached (see embedBacklogCached)
    if (pending <= 0) return null;                       // nothing left to pick up → not active
    let health = 'unknown';
    try { health = getEmbedderHealth()?.status ?? 'unknown'; } catch { /* supervisor down */ }

    // LIVENESS, not just backlog. `pending > 0` alone says NOTHING about whether anything is
    // actually running: this row rendered "Embedding messages · running" for a MONTH while the
    // drainer was skipping every cycle (a single-request embed service blocked /health, and the
    // skip was silent). A progress bar that can't tell "working" from "dead" hides the very
    // outage it exists to surface — so ask the drainer, and say STALLED when it isn't working.
    const st = (() => { try { return getEnrichDrainerStatus(); } catch { return null; } })();
    const STALE_MS = 90_000;                             // ~6 missed 15s cycles
    const noDrainer = !st;                               // nothing is draining this backlog at all
    // A cycle IN FLIGHT is alive by definition — never call it stalled. `lastCycleAt` is
    // stamped at cycle START, and a healthy cycle legitimately runs for MINUTES (the L1
    // categorize pass drives an on-box LLM), so a bare staleness test cries wolf on a
    // perfectly working drainer (observed live: "Embedder needs attention" while categorize
    // was happily draining 54 → 15). Boot is the same story: lastCycleAt=0 until the first
    // cycle completes, which is startup, not a fault.
    // ⚠️ `lastCycleAt` means "a cycle RAN", not "embedding ran" — the health gate skips
    // embedding but no longer the cycle (drainer.js), so this stamps even with :8091 dead.
    // It is therefore only a STARTUP signal (0 = truly nothing has run yet); it is NOT
    // evidence the embedder is alive. `health`/`skips`/`stalled` carry that.
    const booting = !st?.lastCycleAt && !st?.lastProgressAt; // no cycle has run yet → startup, not a fault
    // Use the FRESHEST evidence of life: a cycle can legitimately run for minutes (the
    // 200-pass loop + the on-box LLM), during which lastCycleAt goes stale while the
    // drainer is productively embedding thousands of rows. lastProgressAt is exactly that
    // evidence -- it was exposed and read by nothing.
    const alive = Math.max(Number(st?.lastCycleAt) || 0, Number(st?.lastProgressAt) || 0);
    const stale = alive > 0 && (Date.now() - alive) > STALE_MS;
    const stalled = Boolean(st?.stalled) || (!st?.running && !booting && stale);
    const starting = Boolean(st?.starting);              // model still downloading/loading
    const bad = !starting && (health === 'error' || noDrainer || stalled);
    return {
      id: 'embed',
      kind: 'embed',
      stage: bad ? 'Embedder needs attention' : (starting ? 'Embedder starting' : KIND_LABELS.embed),
      model: EMBED_MODEL,                                // what's running
      process: PROCESS_LABELS.embed,                     // what it's doing
      done: embedded,
      total,
      remaining: pending,
      etaSeconds: null,                                  // continuous; per-second rate not measured in V1
      status: bad ? 'stalled' : 'running',               // never claim "running" when it isn't — but a loading model is not an outage
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
// EXPORTED for scripts/verify-model-consent.mjs (M8). It is the function that rendered
// "Categorizing messages · qwen3.5:4b · running" on a vault where nothing ran, so the gate
// must call IT — an earlier M8 asserted on the resolver instead and proved nothing about
// this projection. Not part of the route contract; do not call it from app code.
export async function categorizeProjection(db, userId) {
  try {
    const { tagged, total, pending } = await db.messages.categoriesBacklogCached(userId);
    if (pending <= 0) return null;                       // caught up → not active
    const paused = (() => { try { return isEnrichCategorizePaused(); } catch { return false; } })();
    // null ⇒ the owner has not approved an on-box labeling model (§3.10c). NOTHING is
    // running: no model, no daemon woken, and the model may not even be on disk. Saying
    // "running" here would be the same lie the embed row told for a month.
    const model = await defaultLabelModel(db, userId);
    const noModel = !model;
    return {
      id: 'categorize',
      kind: 'categorize',
      // Surface the blocked states in the always-on indicator so a user who stopped the
      // churn — or never started it — sees pending work waiting, not just silence.
      // "no local model" is a legitimate STEADY STATE, not a transient (§3.5): it stays
      // until the owner approves one, and it must read as a choice, not a fault.
      stage: noModel ? `${KIND_LABELS.categorize} · no local model`
        : paused ? `${KIND_LABELS.categorize} · paused`
          : KIND_LABELS.categorize,
      model: model || null,                              // the APPROVED on-box labeling model, or none
      process: noModel ? null : PROCESS_LABELS.categorize, // nothing is on-device if nothing runs
      done: tagged,
      total,
      remaining: pending,
      etaSeconds: null,                                  // continuous; per-second rate not measured in V1
      // `paused` covers both: the work is waiting on a decision, not in flight. It is NOT
      // 'stalled' — nothing is broken; the user simply hasn't approved a model.
      status: (paused || noModel) ? 'paused' : 'running',
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

// History-facing label for the inference kinds: the LIVE stage ("Thinking…" /
// "Replying…") reads oddly in the finished list ("Thinking… · Done 8m ago"), so a
// terminal inference row shows a clear noun of what it WAS instead. Only the inference
// kinds are remapped — describe/embed jobs keep their descriptive stage_label in history.
const INFERENCE_HISTORY_LABEL = {
  'inference:chat': 'Chat reply',
  'inference:channel': 'Channel reply',
};

function shape(row, nowMs) {
  const done = Number(row.step) || 0;
  const total = Number(row.total_steps) || 0;
  const terminal = row.status !== 'running';
  const stage = (terminal && INFERENCE_HISTORY_LABEL[row.kind])
    ? INFERENCE_HISTORY_LABEL[row.kind]
    : (row.stage_label || KIND_LABELS[row.kind] || row.kind);
  return {
    id: row.id,
    kind: row.kind,
    stage,
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
