-- 0034 — COVERING-prefix indexes for two Curious-Life metric reads that filter on
-- a plaintext structural column NOT present in the existing index. Same class of
-- fix as 0032/0033: on the at-rest SQLCipher vault a non-covering index lets the
-- planner seek/order by the index but it must still fault in and DECRYPT every
-- candidate table page to test the missing filter column. Putting that column in
-- the index lets SQLite resolve the filter from the (plaintext) index alone and
-- decrypt only the rows actually returned.
--
-- 1) /frequency/series — db.metrics frequency_snapshots:
--      WHERE user_id = ? AND granularity = ? ORDER BY window_end ASC LIMIT ?
--    Existing idx_freq_user_time(user_id, window_end) omits `granularity`, so on a
--    vault with multiple granularities (day/week/month) every window for the user
--    is page-decrypted to test granularity before the LIMIT bites. The new index
--    resolves (user_id, granularity) in the index and yields window_end already
--    ordered → only the LIMIT-N matching rows decrypt.
--
-- 2) /vitality/snapshot — db.metrics territory_vitality (Q2, the per-run fetch):
--      WHERE user_id = ? AND clustering_run_id IS ? ORDER BY territory_id
--    Existing idx_tv_user_territory(user_id, territory_id) omits clustering_run_id,
--    so across multiple runs all of the user's vitality rows are page-decrypted to
--    test the run id. The new index resolves (user_id, clustering_run_id) in the
--    index, ordered by territory_id → only the current run's rows decrypt. (Q1, the
--    latest-run probe ORDER BY computed_at DESC LIMIT 1, stays on idx_tv_computed.)
--
-- The indexed columns are plaintext structural columns (granularity, window_end,
-- clustering_run_id, territory_id) — the encrypted metric values are NOT indexed,
-- so this adds ZERO new decryption surface (§7). ADDITIVE: the existing indexes
-- still back their other queries and are not dropped. No query/behaviour change —
-- bit-identical results, fewer page decrypts.
--
-- Idempotent (IF NOT EXISTS) — applyMigrations re-runs each file every boot.
CREATE INDEX IF NOT EXISTS idx_freq_user_gran_time
  ON frequency_snapshots(user_id, granularity, window_end);
CREATE INDEX IF NOT EXISTS idx_tv_user_run_territory
  ON territory_vitality(user_id, clustering_run_id, territory_id);
