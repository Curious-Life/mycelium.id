-- 0033_claims_bitemporal.sql — Context Engine Phase 2a: extend person_claims to a bi-temporal,
-- distribution-aware claim (Ada's science → verified code). NOT a new table: person_claim_snapshots
-- already carries transaction-time history. We add VALID-time + the supersede link + the Layer-1
-- domain axis + the Whole-Trait DISTRIBUTION params. All plaintext (queryable) — "distribution, not
-- point" is only real if variability + context can be reasoned over and filtered, never prose:
--   valid_from / valid_to   when the trait/fact is/was TRUE in the world (NULL valid_to = currently true)
--   superseded_by           successor claim id — the revision chain (close+open, never overwrite)
--   domain                  taxonomy-v1 life area on the claim
--   variability             distribution dispersion [0,1]; LOW = trait-like (stable), HIGH = state-like
--   context_primary         the dominant context-domain the state conditions on (DIAMONDS situation);
--                           the full conditioning distribution lives structured in support.contexts JSON
-- status gains a 'pending' value (born-pending; CVP-gated out of getContext until promoted) — a new
-- TEXT value, no DDL. Per-change TRANSACTION-time: the lifecycle writes granularity='change' snapshot
-- rows (idx below) so the as-of belief replay is GAPLESS — the existing per-window snapshots were
-- periodic checkpoints (writeSnapshot keyed by window_end+granularity), which left intermediate
-- revisions invisible.
ALTER TABLE person_claims ADD COLUMN valid_from      TEXT;
ALTER TABLE person_claims ADD COLUMN valid_to        TEXT;
ALTER TABLE person_claims ADD COLUMN superseded_by   TEXT;
ALTER TABLE person_claims ADD COLUMN domain          TEXT;
ALTER TABLE person_claims ADD COLUMN variability     REAL;
ALTER TABLE person_claims ADD COLUMN context_primary TEXT;
UPDATE person_claims SET valid_from = created_at WHERE valid_from IS NULL;
CREATE INDEX IF NOT EXISTS idx_claims_validity ON person_claims(user_id, valid_to, valid_from);
CREATE INDEX IF NOT EXISTS idx_claim_changes   ON person_claim_snapshots(user_id, claim_id, granularity, window_end);
