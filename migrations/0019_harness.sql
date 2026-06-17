-- 0018 — Native agent harness state (Phase 5).
-- Backs docs/NATIVE-AGENT-HARNESS-SPEC-2026-06-17.md §6. Three tables:
--   scheduled_tasks       — autonomous wake-cycles / scheduled work (the executor D5 dropped)
--   harness_runs          — per-turn run lifecycle + recovery sentinel + dedup + token counts
--   conversation_summaries — auto-compaction summaries keyed on messages.conversation_id
--
-- Field set adopts the best patterns from the reference harnesses (see spec §4):
--   odysseus task_scheduler.ScheduledTask (schedule DSL, next_run, then_task_id chaining,
--     output_target, notifications, status, trigger_type), canonical wake-cycles
--     (essential flag, max_turns), hermes cost accounting (input/output token counts),
--     canonical checkpoint.js (prompt_hash dedup + running→aborted restart sentinel).
--
-- SECURITY (§1 zero-plaintext-leakage):
--   • scheduled_tasks.prompt is USER-AUTHORED CONTENT → ENCRYPTED at rest
--     (registered in src/crypto/crypto-local.js ENCRYPTED_FIELDS.scheduled_tasks).
--   • conversation_summaries.summary is a synthesis of conversation plaintext — a
--     semantic fingerprint → ENCRYPTED (ENCRYPTED_FIELDS.conversation_summaries).
--   • Everything else is STRUCTURAL operational state the server queries: schedule
--     DSL, status, timestamps, run_count, token COUNTS (never content), prompt_hash
--     (a sha256 of trigger+conversation+input — not reversible to content), and
--     last_error / harness_runs.error which carry CODES ONLY (§8), never plaintext.
--   • Encrypted columns are written only via DAL INSERTs that bind EVERY value as a
--     `?` (no datetime('now')/randomblob() literals in VALUES) — the auto-encrypt
--     INSERT parser truncates VALUES at the first ')' (see 0008/0015). id + all
--     timestamps are computed in JS (src/db/harness.js).

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL,
  name                  TEXT,                       -- plaintext label (queryable)
  prompt                TEXT,                       -- ENCRYPTED (registry) — the instruction
  schedule              TEXT,                       -- DSL: daily:HH | weekly:DOW:HH | monthly:DOM:HH | every:Nh | interval:Nm | once | cron:<expr>
  scheduled_at          TEXT,                       -- for once: the ISO datetime
  tz                    TEXT,                       -- IANA zone; NULL = UTC
  status                TEXT DEFAULT 'active',       -- active | paused | completed
  trigger_type          TEXT DEFAULT 'schedule',     -- schedule | event (event deferred)
  next_run              TEXT,                       -- ISO UTC of the next fire
  last_run              TEXT,
  last_status           TEXT,                       -- success | error | skipped:<reason>
  last_error            TEXT,                       -- CODE only (§8)
  run_count             INTEGER DEFAULT 0,
  then_task_id          TEXT,                       -- chaining (same user_id only — fail-closed in scheduler)
  output_target         TEXT DEFAULT 'none',         -- none | session | notification | channel:<id>
  enabled_tools         TEXT,                       -- JSON array; NULL = default autonomy set
  essential             INTEGER DEFAULT 0,           -- energy gating: 1 = always run
  max_turns             INTEGER DEFAULT 8,
  notifications_enabled INTEGER DEFAULT 1,
  created_by            TEXT,                        -- user | agent | seed
  created_at            TEXT,
  updated_at            TEXT
);
CREATE INDEX IF NOT EXISTS idx_sched_due ON scheduled_tasks(status, next_run);
CREATE INDEX IF NOT EXISTS idx_sched_user ON scheduled_tasks(user_id);

CREATE TABLE IF NOT EXISTS harness_runs (
  id              TEXT PRIMARY KEY,
  user_id         TEXT,
  trigger         TEXT,                              -- chat | channel | scheduler
  conversation_id TEXT,
  task_id         TEXT,                              -- scheduled_tasks.id (NULL for chat/channel)
  status          TEXT DEFAULT 'queued',             -- queued | running | done | failed | aborted | skipped
  prompt_hash     TEXT,                              -- dedup (sha256 prefix; no content)
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  error           TEXT,                              -- CODE only (§8)
  started_at      TEXT,
  finished_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_status ON harness_runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_dedup ON harness_runs(prompt_hash, status);
CREATE INDEX IF NOT EXISTS idx_runs_task ON harness_runs(task_id);

CREATE TABLE IF NOT EXISTS conversation_summaries (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT,
  conversation_id    TEXT,
  summary            TEXT,                           -- ENCRYPTED (registry) — compaction summary
  through_message_id TEXT,                           -- newest message folded into the summary
  tokens_before      INTEGER,
  compaction_count   INTEGER DEFAULT 1,
  created_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_summ_conv ON conversation_summaries(conversation_id, created_at);
