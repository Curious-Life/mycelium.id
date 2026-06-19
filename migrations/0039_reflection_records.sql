-- 0039_reflection_records.sql — Context Engine: the per-cycle reflection record ("day card").
--
-- A dated, queryable digest of what the agent reflected each cycle — so days can be categorized
-- and red threads traced over time. This is NOT a duplicate of model.md / reflections.md (the
-- agent's evolving, consolidated scratchpad): those are the interiority; THIS is the structured,
-- retrospective record the user (and a timeline surface) queries by date / cycle / theme.
--
-- Plaintext keys for SQL filtering: cycle (which cycle), day (the date it's about). The agent's
-- characterizations are CONTENT → encrypted (ENCRYPTED_FIELDS.reflection_records:
-- summary, themes, day_type, body). created_at/scope plaintext like every other table.
CREATE TABLE IF NOT EXISTS reflection_records (
  id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id    TEXT NOT NULL,
  cycle      TEXT NOT NULL,                 -- plaintext: morning|reflection|evening|triage|integration|weekly|adhoc
  day        TEXT,                          -- plaintext date (YYYY-MM-DD) the reflection is about
  summary    TEXT,                          -- ENCRYPTED — 1-2 sentence digest
  themes     TEXT,                          -- ENCRYPTED — JSON array of red-thread labels
  day_type   TEXT,                          -- ENCRYPTED — the kind of day, in the agent's read
  body       TEXT,                          -- ENCRYPTED — optional fuller copy of the reflection
  scope      TEXT DEFAULT 'personal',
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_reflection_records_user_day   ON reflection_records(user_id, day);
CREATE INDEX IF NOT EXISTS idx_reflection_records_user_cycle ON reflection_records(user_id, cycle);
