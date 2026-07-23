// Settings → Data: bulk-delete surface (delete-by-source / delete-by-type).
//
// Same async-background-job shape as the local-files import (src/portal-import.js,
// #83): a bulk delete of tens of thousands of rows + blobs is minutes of work, so
// POST starts a detached job and returns immediately; the UI polls …/progress and
// can POST …/cancel. Single-flight (one delete at a time — single-user V1, and a
// hard rule that we never run two vault writers concurrently).
//
// Destructive → TYPE-TO-CONFIRM: the POST must carry `confirm` exactly equal to
// the target `key` (fail-closed; a missing/wrong token is a 400). Loopback + the
// vault-init/auth gate in server-rest.js are the outer fence; this is the inner,
// intent-proving one. Deletes refuse to start while a mindscape/narration run is
// active (a concurrent delete could half-narrate a territory).
//
// The heavy lifting + the cascade (rows → derived clustering_points → attachments
// → reference-counted blobs → search-sidecar eviction → mindscape mark-stale) all
// live in src/core/bulk-delete.js. This file is only the HTTP + job envelope.

import express from 'express';
import { bulkDelete, dataSummary } from './core/bulk-delete.js';
import { beginDelete } from './core/delete-lane.js';

// The data TYPES a Phase-2 delete-by-type may target (mirrors the engine's
// TYPE_MODES). Kept here too so the router rejects a bad key before spawning a job.
const DELETABLE_TYPES = new Set(['documents', 'media', 'chat']);

export function portalDataRouter({ db, userId, searchHelpers }) {
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));

  // GET /data/summary — per-source + per-type counts for the Data pane cards.
  router.get('/data/summary', async (_req, res) => {
    try { return res.json({ ok: true, ...(await dataSummary(db, userId)) }); }
    catch (e) { return res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 200) }); }
  });

  let deleteJob = null; // { status:'running'|'done'|'cancelled'|'error', mode, key, …, cancel:bool }
  const publicJob = (j) => ({
    status: j.status, startedAt: j.startedAt, finishedAt: j.finishedAt, mode: j.mode, key: j.key,
    total: j.total, processed: j.processed, deleted: j.deleted, attachments: j.attachments, blobs: j.blobs,
    indexed: j.indexed, mindscapeStale: j.mindscapeStale, cancelled: j.cancelled,
    ...(j.error ? { error: j.error } : {}),
  });

  // Refuse to delete while a mindscape/narration run is live (edge case in the
  // design). Best-effort: if the table is unreadable we do NOT block (the check
  // is an extra guard, not a security boundary).
  async function narrationRunning() {
    try {
      const r = await db.rawQuery(`SELECT COUNT(*) AS c FROM narration_runs WHERE user_id = ? AND status = 'running'`, [userId]);
      return Number(r?.results?.[0]?.c ?? 0) > 0;
    } catch { return false; }
  }

  // POST /data/delete { mode:'source'|'type', key, confirm } — start the job.
  router.post('/data/delete', async (req, res) => {
    try {
      if (deleteJob?.status === 'running') return res.json({ ok: true, ...publicJob(deleteJob) });
      const mode = req.body?.mode;
      const key = req.body?.key;
      const confirm = req.body?.confirm;
      // Two delete modes:
      //  • source — undo an import (Phase 1). Only families in SOURCE_FAMILIES.
      //  • type   — bulk a data TYPE (Phase 2): 'documents' (all docs), 'media'
      //    (all image/voice/video/file messages + attachments), 'chat' (all chat
      //    history). Type-delete reaches NATIVE data by design (the operator's
      //    "delete all my chat history / documents") — the type-to-confirm + the
      //    UI's two-step warning are the guard. Unknown keys are rejected here AND
      //    re-validated in the engine (defense in depth).
      if (mode !== 'source' && mode !== 'type') return res.status(400).json({ ok: false, error: 'mode must be "source" or "type"' });
      if (typeof key !== 'string' || !key) return res.status(400).json({ ok: false, error: 'key required' });
      if (mode === 'type' && !DELETABLE_TYPES.has(key)) return res.status(400).json({ ok: false, error: 'unknown type (documents | media | chat)' });
      // Type-to-confirm: the echoed token must exactly match the target key.
      if (confirm !== key) return res.status(400).json({ ok: false, error: 'confirm token does not match — deletion refused' });
      if (await narrationRunning()) return res.status(409).json({ ok: false, error: 'a mindscape Generate is running — wait for it to finish before deleting' });

      const job = deleteJob = {
        status: 'running', startedAt: Date.now(), finishedAt: null, mode, key,
        total: 0, processed: 0, deleted: 0, attachments: 0, blobs: 0, indexed: 0,
        mindscapeStale: false, cancelled: false, error: null, cancel: false,
      };
      // Claim the delete lane BEFORE the job goes async, so a Generate that starts
      // one tick later already sees it (jobs.js:startClusteringJob refuses while
      // held). Released in the finally below — never conditionally.
      const releaseLane = beginDelete();
      (async () => {
        try {
          const s = await bulkDelete(db, {
            userId, mode, key, searchHelpers,
            shouldCancel: () => job.cancel,
            onProgress: (p) => { job.total = p.total; job.processed = p.processed; job.deleted = p.deleted; },
          });
          job.deleted = s.messages + s.documents;
          job.attachments = s.attachments; job.blobs = s.blobs; job.indexed = s.indexed;
          job.mindscapeStale = s.mindscapeStale;
          job.status = (job.cancel || s.cancelled) ? 'cancelled' : 'done';
        } catch (e) {
          job.status = 'error'; job.error = String(e?.message || e).slice(0, 200);
        } finally { job.finishedAt = Date.now(); releaseLane(); }
      })();
      return res.json({ ok: true, ...publicJob(job) });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 200) });
    }
  });

  // GET /data/delete/progress — poll the running/last delete.
  router.get('/data/delete/progress', (_req, res) => {
    res.json({ ok: true, ...(deleteJob ? publicJob(deleteJob) : { status: 'idle' }) });
  });

  // POST /data/delete/cancel — cooperative stop (already-deleted rows stay).
  router.post('/data/delete/cancel', (_req, res) => {
    if (deleteJob?.status === 'running') deleteJob.cancel = true;
    res.json({ ok: true, ...(deleteJob ? publicJob(deleteJob) : { status: 'idle' }) });
  });

  return router;
}
