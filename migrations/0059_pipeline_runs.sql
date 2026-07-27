-- 0059_pipeline_runs.sql — durable run history for the clustering/measure pipeline.
--
-- WHY (the pipeline-sprint design Part 1). Per-STAGE health was already
-- persisted (pipeline_state, written by 17 of 21 stages via pipeline/lib/stage-result.js).
-- The RUN was not persisted anywhere: its whole state lived in a plain `jobs` Map in
-- src/jobs.js, evicted at 50 entries and gone the moment the process exits. So:
--   · a crash mid-run left no record that a run had ever started
--   · "which run failed, where, and why" was unanswerable after a restart
--   · nothing could be resumed, because nothing recorded what had completed
--
-- CONTENT-FREE BY CONSTRUCTION. Stage names, counts, timestamps, and a bounded error
-- CLASS only — never a realm/territory name, message content, or model output. Same class
-- as pipeline_state / background_jobs / audit_log, so these route through d1QueryAdmin and
-- are absent from ENCRYPTED_FIELDS by design, not by omission.

CREATE TABLE IF NOT EXISTS pipeline_runs (
  run_id         TEXT PRIMARY KEY,          -- the existing job id (gen_xxx / measure_xxx)
  user_id        TEXT NOT NULL,
  kind           TEXT NOT NULL,             -- 'generate' | 'measure'
  status         TEXT NOT NULL,             -- 'running' | 'ok' | 'partial' | 'failed' | 'aborted'
  trigger        TEXT,                      -- 'user' | 'auto' | null
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  -- Liveness. Boot reconciliation reads this: a 'running' row whose heartbeat predates the
  -- process start cannot be live, because a live run heartbeats from the parent that died.
  heartbeat_at   TEXT NOT NULL,
  stages_total   INTEGER,
  stages_ok      INTEGER DEFAULT 0,
  stages_failed  INTEGER DEFAULT 0,
  -- Bounded, content-free failure class (jobs.js classifyPipelineFailure output), never the
  -- child's raw stderr — that stays in the in-memory job, behind the authed status route.
  error_class    TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_user_started
  ON pipeline_runs(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_live
  ON pipeline_runs(status, heartbeat_at);

-- One row per (run, stage). The per-run history pipeline_state cannot hold: it upserts on
-- (user_id, stage_name), so it knows the LATEST outcome of a stage and can never show a trend
-- or say which RUN a failure belonged to.
CREATE TABLE IF NOT EXISTS pipeline_run_stages (
  run_id      TEXT NOT NULL,
  -- SAME key as pipeline_state.stage_name. Shared deliberately: the two tables answer
  -- different questions ("is this metric family healthy now?" vs "what did run X do?") and
  -- are only joinable while the key is one vocabulary.
  stage_name  TEXT NOT NULL,
  ord         INTEGER NOT NULL,             -- display order only, NEVER identity
  status      TEXT NOT NULL,                -- 'running'|'ok'|'failed'|'skipped'|'interrupted'
  started_at  TEXT,
  finished_at TEXT,
  duration_ms INTEGER,
  reason      TEXT,                         -- bounded class, content-free
  PRIMARY KEY (run_id, stage_name)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_run_stages_run
  ON pipeline_run_stages(run_id, ord);
