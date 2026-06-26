-- 0042 — Inner-state axes (E2, Tier-1). Extends the embedding-anchor family
-- (migrations/0010_embedding_anchors.sql) from 4 single-pole constructs to N
-- BIPOLAR axes scored as a signed lean:
--     lean_<axis> = mean over window of ( cos(msg, +pole) − cos(msg, −pole) )
-- the generalization of §4.13 affective_volatility's cos_pos − cos_neg. Design +
-- evidence: docs/DESIGN-inner-states-engine-2026-06-24.md (3 sweep cycles + spikes).
--
-- (1) Per-window axis leans on cognitive_metrics_anchor (one REAL column per axis;
--     ENCRYPTED at write via stage_crypto.enc, like the existing anchor metrics).
--     NULL means the axis ABSTAINED (its poles do not separate — see (2)). Every
--     value still carries the table's existing low_confidence=1 + cvp_status='pending'
--     honesty gate; these MUST NOT surface as validated until operator-labeled CVP.
--
-- (2) cognitive_axis_separability — instrument metadata (NOT user data, plaintext):
--     the leave-one-out separability of each axis's seed phrases at a given
--     anchor_version, used to decide measurable-vs-abstain at compute time. Stored so
--     the gate is auditable and reproducible per version.
--
-- `tone_lean` reuses the existing affect_positive/affect_negative anchors (no new
-- constructs) — it is the MEAN of what affective_volatility takes the STDDEV of.
--
-- ADD COLUMNs are individually guarded by src/db/migrate.js (idempotent).

ALTER TABLE cognitive_metrics_anchor ADD COLUMN tone_lean REAL;
ALTER TABLE cognitive_metrics_anchor ADD COLUMN charge_lean REAL;
ALTER TABLE cognitive_metrics_anchor ADD COLUMN warmth_lean REAL;
ALTER TABLE cognitive_metrics_anchor ADD COLUMN gatheredness_lean REAL;
ALTER TABLE cognitive_metrics_anchor ADD COLUMN holding_lean REAL;
ALTER TABLE cognitive_metrics_anchor ADD COLUMN noticing_lean REAL;
ALTER TABLE cognitive_metrics_anchor ADD COLUMN edges_lean REAL;
ALTER TABLE cognitive_metrics_anchor ADD COLUMN kusala_lean REAL;

CREATE TABLE IF NOT EXISTS cognitive_axis_separability (
  axis           TEXT NOT NULL,       -- 'tone' | 'charge' | ... (plaintext enum)
  anchor_version TEXT NOT NULL,       -- which seed set produced this gate (provenance)
  loo_auc        REAL,                -- leave-one-out pole-separation AUC (0.5=chance, 1=perfect)
  antonym_cos    REAL,                -- cos(+centroid, −centroid) — high means poles collapse
  measurable     INTEGER NOT NULL DEFAULT 0,  -- 1 iff loo_auc>=0.70 AND antonym_cos<0.975
  seed_count     INTEGER NOT NULL DEFAULT 0,  -- phrases per pole (gate is noisier at low n)
  -- Per-axis Construct Validity Protocol record (spec §2.3). This is the PER-AXIS
  -- surfacing gate: cognitive_metrics_anchor.cvp_status is row-level (shared by all
  -- metrics in a row), but CVP validity is per-axis — tone may pass while edges never
  -- does. The gated reader (src/db/anchor.js) resolves each <axis>_lean column to the
  -- status here. DEFAULT 'pending' = fail-closed (a missing/un-run axis never surfaces).
  -- Only runCVP (src/metrics/cvp.js) with >= min_n operator labels may write 'pass'.
  cvp_status     TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'pass' | 'fail'
  cvp_criteria   TEXT,                             -- JSON of runCVP.criteria (evidence trail)
  cvp_labeled_n  INTEGER NOT NULL DEFAULT 0,       -- labeled samples used in the last CVP run
  cvp_run_at     TEXT,                             -- when CVP last ran for this axis/version
  computed_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (axis, anchor_version)
);
