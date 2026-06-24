-- 0033 — PARTIAL COVERING indexes for the Streams aggregates (db.streams.spectrum
-- + db.streams.dailyVolume), finishing the job 0032 started.
--
-- 0032 added (user_id, source, created_at) indexes, but the two redaction-aware
-- aggregate queries filter `forgotten_at IS NULL` — a column NOT in those indexes.
-- So on the at-rest SQLCipher vault SQLite uses the index for ordering but must
-- still fault in and DECRYPT every table page to test forgotten_at per row. The
-- plan reads "USING INDEX …" (passes a naive plan check) yet is NOT covering, so
-- the page-decrypt cost stays. Measured on a born-encrypted 107 MB / 69k-message
-- vault: spectrum ≈ 2.15 s, dailyVolume ≈ 2.16 s — i.e. #285 did NOT actually
-- fix the cold open on the encrypted vault (the perf gate ran on a PLAINTEXT test
-- db, which has no page-decrypt cost, and so missed it).
--
-- A PARTIAL index whose predicate (`WHERE forgotten_at IS NULL`) exactly matches
-- the query lets SQLite drop the per-row table probe entirely: every column the
-- aggregate needs (user_id, source/source_type, created_at) is in the index, and
-- the redaction filter is implied by the partial predicate. The query becomes an
-- index-only scan over the small plaintext index — no table page is decrypted.
-- Same 107 MB vault, same queries: spectrum ≈ 11 ms, dailyVolume ≈ 25 ms
-- (~195× / ~86×). EXPLAIN QUERY PLAN confirms the planner picks the partial index.
--
-- Predicate fidelity is load-bearing: the aggregates index ONLY non-forgotten
-- rows, which is EXACTLY the set the queries count — so results are bit-identical
-- to the pre-index path (verify:streams-aggregate-perf golden-diffs this, incl.
-- seeded forgotten rows that must stay excluded). No query/behaviour change; the
-- indexed columns (source, source_type, created_at) are plaintext tags, so this
-- adds ZERO decryption surface (§7).
--
-- ADDITIVE, not a replacement: 0032's idx_messages_user_source_created still backs
-- the non-redaction `GROUP BY source` in portal-compat.js (filters source IS NOT
-- NULL, not forgotten_at) and so cannot be dropped. health_daily/tasks have no
-- forgotten_at (hard-deleted) → their 0032 indexes are already covering; no
-- partial index needed.
--
-- Idempotent (IF NOT EXISTS) — applyMigrations re-runs each file every boot.
CREATE INDEX IF NOT EXISTS idx_messages_user_source_created_live
  ON messages(user_id, source, created_at) WHERE forgotten_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_documents_user_srctype_created_live
  ON documents(user_id, source_type, created_at) WHERE forgotten_at IS NULL;
