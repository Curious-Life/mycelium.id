-- 0027 — per-pair effective sample count for the cross-scale-coupling family
-- (audit METRICS-AUDIT-vs-LITERATURE-2026-06-19 finding S3: low-N statistical
-- bias was unguarded).
--
-- The PAC / PLV / Welch-coherence estimators in compute-cross-scale-coupling.py
-- are mathematically faithful but were called outside their valid sample regime:
-- PLV's expected value under ZERO coupling is ≈ √(π/4N), so a slow-band pair
-- with only ~8-12 co-occurring samples writes a large "coupling" number that is
-- pure finite-sample bias. The fix hard-floors the estimate (NULL below the
-- floor) and surrogate-debiases PLV, but the read layer still needs to know how
-- many RAW co-occurring samples backed each surviving estimate so it can
-- suppress / down-weight near-floor values.
--
-- These four columns store that raw co-occurring N per adjacent band pair
-- (the min of the two raw band lengths BEFORE any interpolation). They are
-- COUNTS, not metric values → PLAINTEXT, per the harmonic-table convention
-- (user_id / time keys / *_count / low_confidence stay plaintext for indexed
-- reads; only metric scalars are caller-encrypted). Written even when the
-- estimate is NULL, so a suppressed row still records why. Idempotent.

ALTER TABLE cognitive_metrics_harmonic ADD COLUMN couple_eff_n_gamma_beta INTEGER;
ALTER TABLE cognitive_metrics_harmonic ADD COLUMN couple_eff_n_beta_alpha INTEGER;
ALTER TABLE cognitive_metrics_harmonic ADD COLUMN couple_eff_n_alpha_theta INTEGER;
ALTER TABLE cognitive_metrics_harmonic ADD COLUMN couple_eff_n_theta_delta INTEGER;
