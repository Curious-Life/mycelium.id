// src/db/activity-feed.js — content-free cross-process job registry over the
// background_jobs table. The DB is the IPC channel: any child that getDb()s the
// vault writes its status row here, and the server reads them for the unified
// activity feed (the header stream indicator + the mindscape chip). Named
// "activityFeed" because db.activity is already the desktop screen-time namespace.
//
// SECURITY (§1 zero-plaintext-leakage): rows carry ONLY kind/status/step/total/
// stage_label — a CONSTANT like "Describing areas", NEVER a realm/territory name,
// message content, or model output. THIS IS THE CONTRACT every publisher owes the
// table. Reaper is fail-closed: a crashed child's row flips to 'abandoned' so the
// UI never shows a zombie.
//
// The contract's two columns fail DIFFERENTLY — do not flatten them:
//   • `stage_label` (and `model`) are emitted LIVE to the UI — portal-activity.js's
//     shape() maps stage_label → `stage` on GET /portal/activity. Content here is on
//     the user's screen immediately: a REAL leak, no second line of defense.
//   • `error` is SELECTed by recent() but dropped by that same shape() today. So the
//     contract is what lets the projection widen without re-auditing every publisher
//     — for THIS column it is defense in depth (CLAUDE.md §2), not a live path.
// Either way the rule is the same (publish constants); only the blast radius differs.
//
// background_jobs is infrastructure state (like audit_log), so it routes through
// d1QueryAdmin — a ROUTING choice, NOT a security property. Do NOT cite that helper
// as a reason rows must be content-free: adapter/d1.js:97,99 defines d1Query and
// d1QueryAdmin as the SAME lambda ("Single-user: Admin == Query"), ENCRYPTED_FIELDS
// (crypto/crypto-local.js:209) field-encrypts exactly ONE table — `secrets` (:441),
// which does not include this one — and post SQLCipher-collapse (2026-06-19) at-rest
// protection is whole-file regardless of the writer. The "non-encrypting path ⇒
// lands in plaintext" premise was verified false on 2026-07-16 (PRs #154/#155); five
// files had restated it, three by citing this header. Don't reintroduce it here.

const STALE_MS = 45_000; // heartbeat older than this ⇒ the job is presumed dead

export function createActivityFeedNamespace({ d1QueryAdmin, randomUUID }) {
  if (typeof d1QueryAdmin !== 'function') throw new TypeError('createActivityFeedNamespace: d1QueryAdmin required');
  const q = d1QueryAdmin;
  const uuid = randomUUID || (() => `job-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return {
    STALE_MS,

    /** Open (or reopen) a running job row. Returns the row id.
     *  `model` (optional) records WHICH model is running — a model NAME only, never
     *  user text/output (§1). The feed's shape() projects it as the "WHICH" column. */
    async begin({ userId, kind, id, totalSteps = 0, stageLabel = null, pid = null, model = null }) {
      const rowId = id || uuid();
      const modelStr = (typeof model === 'string' && model.trim()) ? model.trim().slice(0, 120) : null;
      await q(
        `INSERT INTO background_jobs (id, user_id, kind, status, step, total_steps, stage_label, started_at, last_heartbeat, pid, stalled, model)
         VALUES (?, ?, ?, 'running', 0, ?, ?, datetime('now'), datetime('now'), ?, 0, ?)
         ON CONFLICT(id) DO UPDATE SET status='running', step=0, total_steps=excluded.total_steps,
           stage_label=excluded.stage_label, started_at=datetime('now'), finished_at=NULL, error=NULL,
           last_heartbeat=datetime('now'), pid=excluded.pid, stalled=0, model=excluded.model`,
        [rowId, userId, kind, Number(totalSteps) || 0, stageLabel, pid, modelStr],
      ).catch(() => {});
      return rowId;
    },

    /** Update progress (done/total/stage) + refresh the heartbeat. Cheap; call often.
     *  `stalled` (0/1) is carried by the watchdog's keep-alive tick (jobs.js) so a
     *  slow-but-alive job both stays fresh (no false reap) and shows the chip hint. */
    async heartbeat(id, { step, totalSteps, stageLabel, stalled } = {}) {
      await q(
        `UPDATE background_jobs SET
           step = COALESCE(?, step), total_steps = COALESCE(?, total_steps),
           stage_label = COALESCE(?, stage_label), stalled = COALESCE(?, stalled),
           last_heartbeat = datetime('now')
         WHERE id = ? AND status = 'running'`,
        [step ?? null, totalSteps ?? null, stageLabel ?? null, stalled == null ? null : (stalled ? 1 : 0), id],
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
        `SELECT id, kind, status, step, total_steps, stage_label, started_at, last_heartbeat, pid, stalled, model
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
        `SELECT id, kind, status, step, total_steps, stage_label, started_at, finished_at, error, model
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
