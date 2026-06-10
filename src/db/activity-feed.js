// src/db/activity-feed.js — content-free cross-process job registry over the
// background_jobs table. The DB is the IPC channel: any child that getDb()s the
// vault writes its status row here, and the server reads them for the unified
// activity feed (the header stream indicator + the mindscape chip). Named
// "activityFeed" because db.activity is already the desktop screen-time namespace.
//
// SECURITY (§1 zero-plaintext-leakage): rows carry ONLY kind/status/step/total/
// stage_label — a CONSTANT like "Describing areas", NEVER a realm/territory name,
// message content, or model output. background_jobs is infrastructure state (like
// audit_log) → d1QueryAdmin, not the encrypting user query. Reaper is fail-closed:
// a crashed child's row flips to 'abandoned' so the UI never shows a zombie.

const STALE_MS = 45_000; // heartbeat older than this ⇒ the job is presumed dead

export function createActivityFeedNamespace({ d1QueryAdmin, randomUUID }) {
  if (typeof d1QueryAdmin !== 'function') throw new TypeError('createActivityFeedNamespace: d1QueryAdmin required');
  const q = d1QueryAdmin;
  const uuid = randomUUID || (() => `job-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return {
    STALE_MS,

    /** Open (or reopen) a running job row. Returns the row id. */
    async begin({ userId, kind, id, totalSteps = 0, stageLabel = null, pid = null }) {
      const rowId = id || uuid();
      await q(
        `INSERT INTO background_jobs (id, user_id, kind, status, step, total_steps, stage_label, started_at, last_heartbeat, pid)
         VALUES (?, ?, ?, 'running', 0, ?, ?, datetime('now'), datetime('now'), ?)
         ON CONFLICT(id) DO UPDATE SET status='running', step=0, total_steps=excluded.total_steps,
           stage_label=excluded.stage_label, started_at=datetime('now'), finished_at=NULL, error=NULL,
           last_heartbeat=datetime('now'), pid=excluded.pid`,
        [rowId, userId, kind, Number(totalSteps) || 0, stageLabel, pid],
      ).catch(() => {});
      return rowId;
    },

    /** Update progress (done/total/stage) + refresh the heartbeat. Cheap; call often. */
    async heartbeat(id, { step, totalSteps, stageLabel } = {}) {
      await q(
        `UPDATE background_jobs SET
           step = COALESCE(?, step), total_steps = COALESCE(?, total_steps),
           stage_label = COALESCE(?, stage_label), last_heartbeat = datetime('now')
         WHERE id = ? AND status = 'running'`,
        [step ?? null, totalSteps ?? null, stageLabel ?? null, id],
      ).catch(() => {});
    },

    /** Terminal transition: 'done' | 'error'. */
    async finish(id, { status = 'done', error = null } = {}) {
      await q(
        `UPDATE background_jobs SET status = ?, error = ?, finished_at = datetime('now'), last_heartbeat = datetime('now')
         WHERE id = ?`,
        [status, error, id],
      ).catch(() => {});
    },

    /** Live jobs (running + fresh heartbeat). */
    async active(userId) {
      // d1QueryAdmin returns { results: [...] } (same as audit_log) — unwrap it.
      const r = await q(
        `SELECT id, kind, status, step, total_steps, stage_label, started_at, last_heartbeat, pid
         FROM background_jobs
         WHERE user_id = ? AND status = 'running'
           AND (strftime('%s','now') - strftime('%s', last_heartbeat)) * 1000 < ?
         ORDER BY started_at DESC`,
        [userId, STALE_MS],
      ).catch(() => null);
      return (Array.isArray(r) ? r : r?.results) || [];
    },

    /** Recently finished jobs (for the feed's history). */
    async recent(userId, limit = 10) {
      const r = await q(
        `SELECT id, kind, status, step, total_steps, stage_label, started_at, finished_at, error
         FROM background_jobs
         WHERE user_id = ? AND status != 'running'
         ORDER BY COALESCE(finished_at, started_at) DESC LIMIT ?`,
        [userId, Number(limit) || 10],
      ).catch(() => null);
      return (Array.isArray(r) ? r : r?.results) || [];
    },

    /** Fail-closed: flip stale 'running' rows (dead children) to 'abandoned'. */
    async reap(userId) {
      await q(
        `UPDATE background_jobs SET status='abandoned', finished_at=datetime('now')
         WHERE user_id = ? AND status='running'
           AND (strftime('%s','now') - strftime('%s', last_heartbeat)) * 1000 >= ?`,
        [userId, STALE_MS],
      ).catch(() => {});
    },

    /** Keep the table bounded — drop old terminal rows beyond `keep`. */
    async prune(userId, keep = 50) {
      await q(
        `DELETE FROM background_jobs WHERE user_id = ? AND status != 'running' AND id NOT IN (
           SELECT id FROM background_jobs WHERE user_id = ? AND status != 'running'
           ORDER BY COALESCE(finished_at, started_at) DESC LIMIT ?)`,
        [userId, userId, Number(keep) || 50],
      ).catch(() => {});
    },
  };
}

export default createActivityFeedNamespace;
