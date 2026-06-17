-- 0022 — Narration walk checkpoint (Phase 3: UI-controlled, pausable narration).
--
-- One row per narration walk. The job updates progress/status here; the walk reads
-- status between entities to pause/cancel cleanly (never mid-write), and done_ids is
-- the resume checkpoint (entities already completed in a prior segment are skipped).
-- All columns are plaintext operational metadata (no vault content): ids, counts,
-- status, a content-free current-area LABEL is NOT stored (only an opaque kind:id).
-- CREATE TABLE IF NOT EXISTS → idempotent across boots.
CREATE TABLE IF NOT EXISTS narration_runs (
  run_id          TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  scope           TEXT NOT NULL,                       -- JSON: "all" | {"realm_id":N} | {"territory_id":N}
  provider        TEXT,                                -- chosen narrate provider label (privacy surfacing)
  status          TEXT NOT NULL DEFAULT 'running',     -- running | paused | done | canceled | error
  done_ids        TEXT NOT NULL DEFAULT '[]',          -- JSON array of completed "kind:id" keys (resume checkpoint)
  described       INTEGER NOT NULL DEFAULT 0,
  reflected       INTEGER NOT NULL DEFAULT 0,
  skipped         INTEGER NOT NULL DEFAULT 0,
  total           INTEGER NOT NULL DEFAULT 0,
  current_kind    TEXT,                                -- 'realm'|'territory' currently in progress (no name)
  current_id      INTEGER,
  cluster_version TEXT,                                -- abort if the mindscape re-clusters mid-walk
  error           TEXT,
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_narration_runs_user ON narration_runs (user_id, started_at DESC);
