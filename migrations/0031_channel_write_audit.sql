-- 0031 — Channel write audit (red-team RT2-H2, 2026-06-19).
-- Every vault WRITE performed by an autonomous turn (an owner-trusted channel DM, or a
-- scheduled wake-cycle) is recorded here so the owner can answer "what did my assistant
-- write to my vault from a channel?" — the detection layer behind the owner-write grant.
--
-- SECURITY (§1 zero-plaintext-leakage): STRUCTURAL + HASHES ONLY, never content. The tool
-- name + conversation id + a sha256 PREFIX of the args + a timestamp. No target path, no
-- fact value, no document body — arg_hash is one-way and lets the owner correlate/dedupe
-- without exposing what was written. NOT encrypted (it carries no plaintext), like
-- harness_runs.
CREATE TABLE IF NOT EXISTS channel_write_audit (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  conversation_id TEXT,
  trigger TEXT,                 -- channel | scheduler
  tool TEXT NOT NULL,           -- the write tool name (remember / saveDocument / …)
  arg_hash TEXT,                -- sha256(args) prefix — correlate, never reverse
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_cwa_user_created ON channel_write_audit(user_id, created_at);
