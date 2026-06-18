// src/db/pipeline-state.js — per-stage measurement-health ledger over the
// pipeline_state table (migrations/0001_init.sql:994). Content-free infrastructure
// state (stage names, timestamps, counts, a bounded DB-error class) → d1QueryAdmin,
// same class as background_jobs / audit_log / llm_usage. NEVER carries a realm/
// territory name, message, or model output.
//
// The table already EXISTS and is already READ by era-resolution (src/db/metrics.js
// getCurrentEra, pipeline/stage_base.py derive_era_id) and by the /metric-freshness
// endpoint (src/portal-measurement.js) — but nothing in V1 wrote it, so era rung 1
// was permanently dark and freshness could never say WHY a family was stale. These
// recorders, driven by pipeline/lib/stage-result.js finalize(), populate it:
//   recordSuccess → last_success_at + reset streak/quarantine + duration + details
//   recordFailure → last_failure_at + reason + streak++ + quarantine at the 3rd strike
//
// Robustness (CLAUDE.md §10): consecutive_failures + quarantined make a chronically
// broken stage VISIBLE and persistent across runs (the health surface badges it),
// instead of vanishing on a silent exit 0.

const QUARANTINE_AT = 3; // consecutive failures that flip quarantined=1

export function createPipelineStateNamespace({ d1QueryAdmin }) {
  if (typeof d1QueryAdmin !== 'function') throw new TypeError('createPipelineStateNamespace: d1QueryAdmin required');
  const q = d1QueryAdmin;

  return {
    QUARANTINE_AT,

    /** Stage completed cleanly: stamp success, clear the failure streak + quarantine,
     *  store the content-free {attempted,written,failed} detail blob + wall-clock. */
    async recordSuccess(userId, stage, { durationMs = null, details = null } = {}) {
      await q(
        `INSERT INTO pipeline_state
           (user_id, stage_name, last_success_at, consecutive_failures, quarantined, last_duration_ms, last_details_json, updated_at)
         VALUES (?, ?, datetime('now'), 0, 0, ?, ?, datetime('now'))
         ON CONFLICT(user_id, stage_name) DO UPDATE SET
           last_success_at = datetime('now'),
           consecutive_failures = 0,
           quarantined = 0,
           last_duration_ms = excluded.last_duration_ms,
           last_details_json = excluded.last_details_json,
           updated_at = datetime('now')`,
        [userId, stage, durationMs, details ? JSON.stringify(details) : null],
      ).catch(() => {});
    },

    /** Stage failed / was materially incomplete: stamp failure, bounded reason,
     *  increment the streak, quarantine at the QUARANTINE_AT-th consecutive strike. */
    async recordFailure(userId, stage, { reason = null, durationMs = null } = {}) {
      const r = reason != null ? String(reason).slice(0, 300) : null;
      await q(
        `INSERT INTO pipeline_state
           (user_id, stage_name, last_failure_at, last_failure_reason, consecutive_failures, quarantined, last_duration_ms, updated_at)
         VALUES (?, ?, datetime('now'), ?, 1, 0, ?, datetime('now'))
         ON CONFLICT(user_id, stage_name) DO UPDATE SET
           last_failure_at = datetime('now'),
           last_failure_reason = excluded.last_failure_reason,
           consecutive_failures = pipeline_state.consecutive_failures + 1,
           quarantined = CASE WHEN pipeline_state.consecutive_failures + 1 >= ${QUARANTINE_AT} THEN 1 ELSE 0 END,
           last_duration_ms = excluded.last_duration_ms,
           updated_at = datetime('now')`,
        [userId, stage, r, durationMs],
      ).catch(() => {});
    },

    /** All per-stage health rows for a user (for the /measurement-health surface). */
    async all(userId) {
      const r = await q(
        `SELECT stage_name, last_success_at, last_failure_at, last_failure_reason,
                consecutive_failures, quarantined, last_duration_ms, last_details_json, updated_at
           FROM pipeline_state WHERE user_id = ?`,
        [userId],
      ).catch(() => null);
      return (Array.isArray(r) ? r : r?.results) || [];
    },

    /** One stage's health row, or null. */
    async get(userId, stage) {
      const rows = await this.all(userId);
      return rows.find((s) => s.stage_name === stage) || null;
    },

    /** Convenience: the {success,failure} recorder pair for one (userId, stage),
     *  shaped for pipeline/lib/stage-result.js createStageResult({ record }). */
    recorderFor(userId, stage) {
      return {
        success: (o) => this.recordSuccess(userId, stage, o),
        failure: (o) => this.recordFailure(userId, stage, o),
      };
    },
  };
}

export default createPipelineStateNamespace;
