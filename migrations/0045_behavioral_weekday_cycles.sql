-- 0045 — Routine: weekday distribution + activity-cycle detection. Extends the
-- Tier-0 behavioral family (migrations/0009_compute_only_families.sql) which until
-- now only captured a 24-bin hour-of-day histogram. Adds two things the Routine
-- surface needs to answer "when do I write, really":
--
--   (1) WEEKDAY structure — a 7-bin Mon..Sun volume histogram, a 7×24 weekday×hour
--       matrix (the heat-map of "which day + which hour"), the modal weekday, and a
--       weekday concentration (1 − normalized entropy = how routine-bound the week is).
--
--   (2) ACTIVITY CYCLES — autocorrelation of the daily-volume series finds the
--       dominant repeating period (in days) and its strength [0..1], plus the
--       7-day (weekly) autocorrelation specifically, since a weekly rhythm is the
--       most interpretable cycle. Descriptive only — NOT a circadian/clinical claim.
--
-- All values reveal the user's routine, so — like every existing column in this
-- table — they are ENCRYPTED at write via stage_crypto.enc (compute-behavioral.py).
-- Structural keys (counts, low_confidence) stay plaintext.
--
-- ADD COLUMNs are individually guarded by src/db/migrate.js (idempotent), so this
-- is safe to re-run and backward-compatible (existing rows read these as NULL until
-- a measurement-only refresh repopulates the behavioral stage).

ALTER TABLE cognitive_metrics_behavioral ADD COLUMN weekday_hist           TEXT;  -- ENCRYPTED JSON: 7-element Mon..Sun volume histogram
ALTER TABLE cognitive_metrics_behavioral ADD COLUMN weekday_hour_hist      TEXT;  -- ENCRYPTED JSON: 7×24 weekday×hour matrix (heat-map)
ALTER TABLE cognitive_metrics_behavioral ADD COLUMN peak_weekday           REAL;  -- ENCRYPTED: modal weekday [0=Mon..6=Sun]
ALTER TABLE cognitive_metrics_behavioral ADD COLUMN weekday_concentration  REAL;  -- ENCRYPTED: 1 − normalized entropy of weekday_hist
ALTER TABLE cognitive_metrics_behavioral ADD COLUMN dominant_cycle_days    REAL;  -- ENCRYPTED: lag (days) of strongest activity autocorrelation
ALTER TABLE cognitive_metrics_behavioral ADD COLUMN dominant_cycle_strength REAL; -- ENCRYPTED: autocorrelation at that lag [0..1]
ALTER TABLE cognitive_metrics_behavioral ADD COLUMN weekly_cycle_strength  REAL;  -- ENCRYPTED: autocorrelation at lag = 7 days [0..1]
