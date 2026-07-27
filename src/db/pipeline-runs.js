// src/db/pipeline-runs.js — the durable RUN record for the clustering/measure pipeline.
//
// WHY (the pipeline-sprint design Part 1): per-STAGE health was already
// persisted (pipeline_state, written by 17 of 21 stages through pipeline/lib/stage-result.js),
// but the RUN lived only in a plain Map in src/jobs.js — evicted at 50 entries, gone on exit.
// A crash left no record a run had started; after a restart "which run failed, where, why" was
// unanswerable; and nothing could resume, because nothing recorded what had completed.
//
// CONTENT-FREE (§1). Stage names, counts, timestamps, and a bounded error CLASS only — never a
// realm/territory name, message content, or model output. Routed through d1QueryAdmin, the same
// lane as pipeline_state / background_jobs / audit_log.
//
// FAIL-SOFT (deliberate, and the opposite of most rules in this repo). Every write here
// `.catch(() => {})`. This is BOOKKEEPING ABOUT work, not the work: a failed INSERT must never
// prevent a user's map from being built. The one thing that must not fail soft is the boot
// reconciliation's HONESTY — see reconcileOnBoot.

const iso = () => new Date().toISOString();
const rows = (r) => (Array.isArray(r) ? r : r?.results) || [];

/** Bound a reason/class string. Callers already pass classified constants; this is the floor. */
const bounded = (s) => (s == null ? null : String(s).slice(0, 300));

export function createPipelineRunsNamespace({ d1QueryAdmin }) {
  if (typeof d1QueryAdmin !== 'function') throw new TypeError('createPipelineRunsNamespace: d1QueryAdmin required');
  const q = d1QueryAdmin;

  return {
    /** Open a run. Called BEFORE any stage work, so a crash one second later is still diagnosable. */
    async open(runId, { userId, kind, trigger = null, stagesTotal = null } = {}) {
      const t = iso();
      await q(
        `INSERT INTO pipeline_runs (run_id, user_id, kind, status, trigger, started_at, heartbeat_at, stages_total)
         VALUES (?, ?, ?, 'running', ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           status = 'running', started_at = excluded.started_at, heartbeat_at = excluded.heartbeat_at,
           finished_at = NULL, error_class = NULL, stages_ok = 0, stages_failed = 0`,
        [runId, userId, kind, trigger, t, t, stagesTotal],
      ).catch(() => {});
    },

    /** Liveness ping. A run with no heartbeat cannot be distinguished from a dead one. */
    async heartbeat(runId) {
      await q(`UPDATE pipeline_runs SET heartbeat_at = ? WHERE run_id = ?`, [iso(), runId]).catch(() => {});
    },

    /**
     * A stage began. Closes the PREVIOUS running stage of this run as 'ok'.
     *
     * ⚠️ THE `set -e` COUPLING, STATED SO IT CANNOT ROT. Inferring "the previous stage
     * succeeded" from "the next banner appeared" is sound ONLY because run-clustering.sh runs
     * under `set -euo pipefail`: the next command cannot execute unless the previous one exited
     * 0. When the P2 driver removes `set -e` from the stage sequence, THIS INFERENCE BREAKS and
     * the driver must report each stage's outcome explicitly instead. Until then it is a fact
     * about the shell, not a guess about the stage.
     */
    async stageStarted(runId, stageName, ord) {
      const t = iso();
      await q(
        `UPDATE pipeline_run_stages
            SET status = 'ok', finished_at = ?,
                duration_ms = CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER)
          WHERE run_id = ? AND status = 'running'`,
        [t, t, runId],
      ).catch(() => {});
      await q(
        `INSERT INTO pipeline_run_stages (run_id, stage_name, ord, status, started_at)
         VALUES (?, ?, ?, 'running', ?)
         ON CONFLICT(run_id, stage_name) DO UPDATE SET
           status = 'running', started_at = excluded.started_at, finished_at = NULL,
           duration_ms = NULL, reason = NULL, ord = excluded.ord`,
        [runId, stageName, Number(ord) || 0, t],
      ).catch(() => {});
      await q(
        `UPDATE pipeline_runs SET heartbeat_at = ?, stages_ok = (
           SELECT COUNT(*) FROM pipeline_run_stages WHERE run_id = ? AND status = 'ok')
         WHERE run_id = ?`,
        [t, runId, runId],
      ).catch(() => {});
    },

    /**
     * Close the run. The ONE terminal write — src/jobs.js calls this from publishTerminal, which
     * is already the single chokepoint every exit path funnels through (normal close, spawn
     * error, cancel, kill-switch, disk-low). Routing through it means a new exit path cannot
     * forget to close the run, which is exactly how the activity feed grew its reaper.
     *
     * A run still holding a 'running' stage at close is a run that DIED INSIDE that stage — mark
     * it, so the failure has a stage name even when the child never said which.
     */
    async close(runId, { status, errorClass = null } = {}) {
      const t = iso();
      // ⚠️ The LAST stage of a run is always still 'running' at this point — nothing starts
      // after it, so stageStarted() never gets to close it. The first version of this only
      // handled the failure case and left every successful run's final stage 'running' forever,
      // with stages_ok short by one. Caught by R3.
      //   ok      ⇒ the run succeeded, so the stage it was in succeeded
      //   aborted ⇒ the process died inside it   → 'interrupted'
      //   failed  ⇒ the stage itself died        → 'failed'
      // Either way the dying stage keeps its NAME, which is what makes the failure locatable.
      await q(
        `UPDATE pipeline_run_stages
            SET status = ?, finished_at = ?, reason = ?,
                duration_ms = CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER)
          WHERE run_id = ? AND status = 'running'`,
        [status === 'ok' ? 'ok' : status === 'aborted' ? 'interrupted' : 'failed',
         t, status === 'ok' ? null : bounded(errorClass), t, runId],
      ).catch(() => {});
      await q(
        `UPDATE pipeline_runs
            SET status = ?, finished_at = ?, heartbeat_at = ?, error_class = ?,
                stages_ok = (SELECT COUNT(*) FROM pipeline_run_stages WHERE run_id = ? AND status = 'ok'),
                stages_failed = (SELECT COUNT(*) FROM pipeline_run_stages WHERE run_id = ? AND status IN ('failed','interrupted'))
          WHERE run_id = ?`,
        [status, t, t, bounded(errorClass), runId, runId, runId],
      ).catch(() => {});
    },

    /**
     * Boot reconciliation. A 'running' row at process start CANNOT be live: the only thing that
     * heartbeats it is the parent process, and the parent is what just started. So it died —
     * either the app crashed or was quit mid-run.
     *
     * ⚠️ THIS IS THE HONESTY GUARANTEE OF THE WHOLE TABLE, and it is why the reconciliation is
     * unconditional rather than heartbeat-thresholded. A row left 'running' forever would assert
     * "still working" about a process that no longer exists — the inference-as-evidence class
     * this sprint exists to remove, written into the database. After a crash the honest state is
     * 'aborted': never 'running', and never 'ok'.
     *
     * Mirrors db/harness.js reconcileOnBoot (:167-174), called from the same boot block.
     */
    async reconcileOnBoot() {
      const t = iso();
      await q(
        `UPDATE pipeline_run_stages SET status = 'interrupted', finished_at = ?, reason = 'server-restart'
          WHERE status = 'running' AND run_id IN (SELECT run_id FROM pipeline_runs WHERE status = 'running')`,
        [t],
      ).catch(() => {});
      const r = await q(
        `UPDATE pipeline_runs SET status = 'aborted', finished_at = ?, error_class = 'server-restart'
          WHERE status = 'running'`,
        [t],
      ).catch(() => null);
      return r?.meta?.changes ?? 0;
    },

    /** Recent runs, newest first (content-free). */
    async recent(userId, limit = 20) {
      const r = await q(
        `SELECT run_id, kind, status, trigger, started_at, finished_at,
                stages_total, stages_ok, stages_failed, error_class
           FROM pipeline_runs WHERE user_id = ? ORDER BY started_at DESC LIMIT ?`,
        [userId, Number(limit) || 20],
      ).catch(() => null);
      return rows(r);
    },

    /** One run's stages, in display order (content-free). */
    async stages(runId) {
      const r = await q(
        `SELECT stage_name, ord, status, started_at, finished_at, duration_ms, reason
           FROM pipeline_run_stages WHERE run_id = ? ORDER BY ord, stage_name`,
        [runId],
      ).catch(() => null);
      return rows(r);
    },
  };
}

export default createPipelineRunsNamespace;
