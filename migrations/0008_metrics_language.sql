-- 0008 — language column on the remaining metric tables ("language day-1").
--
-- cognitive_metrics_harmonic / _window / _per_territory already carry `language`
-- (in their PKs). These four did not — added so EVERY metric table is language-
-- scoped from the start (multilingual users; the embedding-anchor + harmonic
-- families are language-relative). NOT NULL DEFAULT 'en'; migrate.js guards the
-- ADD COLUMN so re-runs are idempotent.
ALTER TABLE cognitive_metrics_trajectory ADD COLUMN language TEXT NOT NULL DEFAULT 'en';
ALTER TABLE topology_metrics ADD COLUMN language TEXT NOT NULL DEFAULT 'en';
ALTER TABLE frequency_snapshots ADD COLUMN language TEXT NOT NULL DEFAULT 'en';
ALTER TABLE complexity_snapshots ADD COLUMN language TEXT NOT NULL DEFAULT 'en';
