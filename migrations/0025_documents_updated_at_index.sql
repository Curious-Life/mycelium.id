-- 0025 — Index backing the paginated Library list sort.
--
-- db.documents.list() pages per-user, newest-first (WHERE user_id = ? …
-- ORDER BY updated_at DESC LIMIT/OFFSET). Existing document indexes cover
-- (user_id, created_at), (user_id, path), (user_id, created_by) — none matches
-- the updated_at sort, so SQLite filesorts the whole user's set on every page.
-- This composite lets the sort + page read straight off the index.
--
-- Idempotent: CREATE INDEX IF NOT EXISTS is a no-op once applied, safe to
-- re-run on every boot (applyMigrations re-execs each file).
CREATE INDEX IF NOT EXISTS idx_documents_user_updated
  ON documents (user_id, updated_at DESC);
