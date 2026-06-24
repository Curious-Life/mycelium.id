-- 0014 — LLM token-usage accounting (TEXT-GENERATION-ABSTRACTION-DESIGN-2026-06-15 §12).
-- One row per generation call: which path/area, which provider+model, and the
-- input/output token counts (provider-reported actuals when available, chars/4
-- estimates otherwise). Powers the /portal/usage transparency surface.
--
-- ENCRYPTION: there are NO content columns. We store COUNTS + DIMENSIONS ONLY —
-- never any prompt or completion text. Token counts are metadata, not content
-- (the egress audit already stores content_length plaintext), so this follows the
-- same plaintext-skeleton boundary as audit_log / background_jobs / cycle_metrics
-- (which likewise carry plaintext input_tokens/output_tokens). Plaintext is
-- required: every column is grouped/summed/ordered by the aggregation queries, and
-- AES-GCM here is non-deterministic (can't be used in WHERE/GROUP BY/ORDER BY).
-- Single-user vault, read only by the owner over loopback/bearer.
CREATE TABLE IF NOT EXISTS llm_usage (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id       TEXT NOT NULL,                                   -- scope key (single-user vault)
  at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), -- event time (grouping)
  source        TEXT NOT NULL,                                   -- entry path: 'chat' | 'gateway' | 'enrichment'
  area          TEXT NOT NULL,                                   -- task: 'chat'|'narrate'|'claims'|'describe'|'cluster'|'caption'|'summarize'|'classify'|'extract'|'complex'
  provider      TEXT,                                            -- 'anthropic'|'openai'|hostname|'local'
  model         TEXT,                                            -- model id
  jurisdiction  TEXT,                                            -- 'local'|'eu-zdr'|'us-zdr'|'us-standard'
  is_local      INTEGER NOT NULL DEFAULT 0,                      -- 1 = on-box (no egress)
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated     INTEGER NOT NULL DEFAULT 0,                      -- 1 = chars/4 estimate, 0 = provider-reported actual
  duration_ms   INTEGER,                                         -- wall-clock for the call, nullable
  created_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_llm_usage_user_at   ON llm_usage(user_id, at);
CREATE INDEX IF NOT EXISTS idx_llm_usage_user_area ON llm_usage(user_id, area);
CREATE INDEX IF NOT EXISTS idx_llm_usage_user_model ON llm_usage(user_id, model);
