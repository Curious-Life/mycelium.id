-- 0018_streams_feed_indexes.sql — keyset-pagination indexes for the unified
-- Streams river (db.streams.feed). The feed reads each table with
-- `WHERE user_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT n`.
-- messages already has idx_messages_created_at and health_daily has
-- (user_id, date); tasks and documents had no (user_id, created_at) index, so
-- those arms would table-scan per page. Idempotent (IF NOT EXISTS).

CREATE INDEX IF NOT EXISTS idx_tasks_user_created ON tasks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_user_created ON documents(user_id, created_at DESC);
