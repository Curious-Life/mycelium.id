-- 0027 — Covering indexes for the Streams source spectrum (db.streams.spectrum).
--
-- spectrum() runs, per table, `SELECT source, MAX(created_at), SUM(CASE created_at>=?…)
-- … WHERE user_id=? GROUP BY source` with NO created_at bound — so SQLite must scan
-- every row for the user to compute the group/MAX/windowed-SUM. On a ~70k-row
-- messages table inside a whole-file SQLCipher vault that scan decrypts every page
-- → a measured 7–12s for a 5 KB response (src/db/streams.js:64-78).
--
-- A composite (user_id, source, created_at) lets SQLite serve the GROUP BY + MAX +
-- created_at range as an INDEX-ONLY scan: it reads the small index (3 plaintext
-- columns) instead of decrypting full table pages. No query or behavior change —
-- source/source_type/created_at are all plaintext tags, so this adds zero decryption
-- surface. tasks.source is the constant 'task' (no GROUP BY benefit) → not indexed.
--
-- Idempotent (IF NOT EXISTS): a no-op once applied, safe to re-exec every boot
-- (applyMigrations re-runs each file).
CREATE INDEX IF NOT EXISTS idx_messages_user_source_created
  ON messages(user_id, source, created_at);
CREATE INDEX IF NOT EXISTS idx_documents_user_srctype_created
  ON documents(user_id, source_type, created_at);
CREATE INDEX IF NOT EXISTS idx_health_daily_user_source_created
  ON health_daily(user_id, source, created_at);
