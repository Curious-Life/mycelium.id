-- 0025_messages_user_created_index.sql — composite (user_id, created_at) index
-- on messages. Closes the gap 0018 left open ("messages already has
-- idx_messages_created_at") — that single-column index does NOT serve the
-- windowed read pattern `WHERE user_id = ? AND created_at >= ? AND created_at < ?
-- ORDER BY created_at LIMIT n`: without ANALYZE stats SQLite prefers a
-- user_id-prefixed index (e.g. idx_messages_nlp_created) and then a TEMP B-TREE
-- sort, so every window query scans + sorts the user's ENTIRE message set.
--
-- compute-frequency.py issues one such query per window (≈124 windows across
-- month/week/day). On the encrypted (SQLCipher) vault each of those scans
-- decrypts the user's whole index/table footprint → ~9 min on a 69k-message
-- vault. With this composite index each query is a tight range scan that stops
-- at LIMIT (no temp b-tree), independent of total message count. Verified via
-- EXPLAIN QUERY PLAN with and without stats. Mirrors idx_clustering_user_created
-- / idx_tasks_user_created / idx_documents_user_created. Idempotent.

CREATE INDEX IF NOT EXISTS idx_messages_user_created ON messages(user_id, created_at);
