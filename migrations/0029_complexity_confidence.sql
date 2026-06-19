-- 0027 — Complexity honesty + the embedding-novelty Tier-1 cross-check.
--
-- The LZ-complexity metric saturated at 1.0 for short activity sequences (the
-- asymptotic n/log₂a normalization is invalid at small n). The fix: surrogate-null
-- normalization + a min-length gate that flags unreliable short sequences via
-- `low_confidence`. And the spec's Tier-1 novelty primary (§4.19, embedding NN
-- distance) — which degrades gracefully where LZ is degenerate — lands here as
-- `embedding_novelty` (computed by the new compute-embedding-novelty stage, which
-- UPDATEs these rows; SEC-encrypted derived signal) + its own confidence flag.
--
-- low_confidence / embedding_novelty_low_conf are plaintext flags (filtering + UI).
-- embedding_novelty is the sensitive metric → ENCRYPTED_FIELDS.complexity_snapshots.
-- Idempotent: ALTER TABLE ADD COLUMN guarded per-statement by applyMigrations.
ALTER TABLE complexity_snapshots ADD COLUMN low_confidence INTEGER DEFAULT 0;
ALTER TABLE complexity_snapshots ADD COLUMN embedding_novelty REAL;
ALTER TABLE complexity_snapshots ADD COLUMN embedding_novelty_low_conf INTEGER DEFAULT 0;
