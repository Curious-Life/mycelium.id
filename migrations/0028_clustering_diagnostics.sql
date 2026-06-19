-- 0028_clustering_diagnostics.sql — per-run clustering-VALIDITY health metrics.
--
-- METRICS-AUDIT-vs-LITERATURE-2026-06-19.md finding S5: the hierarchy's cluster
-- COUNTS are deterministic √n targets (cluster.py scale_targets) — the correct
-- fix for the cosine-silhouette k=2 realm-collapse (REALM-K-CLUSTERING-FIX-DESIGN-
-- 2026-06-17.md) — but that left realm/theme/territory counts as ASSUMPTIONS
-- presented as measurements, with no validity/stability check watching whether
-- the shipped partition is actually well-formed. This single-row-per-user table
-- holds the cheap read-only diagnostics computed at the end of each clustering
-- run (pipeline/cluster_diagnostics.py). They are STORED, never used to select k
-- (re-introducing index-driven k-selection would re-introduce the original bug —
-- see docs/CLUSTERING-ALGORITHM-DECISION-LOG-2026-06-19.md).
--
-- PLAINTEXT BY DESIGN. These are GLOBAL partition-GEOMETRY quality scalars (how
-- balanced / reproducible the math is), not per-entity cognitive signal. They sit
-- in the same disclosure class as the noise percentages and realm/territory COUNTS
-- already surfaced plaintext in GET /mindscape `meta` — and far below the per-
-- territory cognitive scalars (energy/coherence/velocity) that ARE encrypted
-- (crypto-local.js ENCRYPTED_FIELDS). They reveal nothing about content. If a later
-- multi-vault threat-model disagrees, promotion to an AES-GCM envelope is a one-line
-- ENCRYPTED_FIELDS addition + a decrypt in db/mindscape.js (mirrors territory scalars).

CREATE TABLE IF NOT EXISTS clustering_diagnostics (
  user_id TEXT NOT NULL PRIMARY KEY,
  cluster_version TEXT,                 -- ISO of the run that produced these values
  realm_max_share REAL,                 -- largest realm's fraction of assigned points [0,1]
  realm_count INTEGER,                  -- number of realms this run produced
  territory_validity REAL,              -- cheap cohesion/separation index (NOT DBCV; informational, never gates)
  bootstrap_ari_mean REAL,              -- mean reference-anchored Adjusted-Rand over subsamples (NULL = not measured)
  bootstrap_ari_std REAL,
  bootstrap_ari_runs INTEGER DEFAULT 0, -- successful bootstrap reps (0 = not measured — NEVER read as a pass)
  low_confidence INTEGER DEFAULT 0,     -- 1 if realm_max_share > 0.5 OR bootstrap_ari_mean < 0.6
  confidence_note TEXT,                 -- generic, content-free caveat string for the UI
  updated_at TEXT DEFAULT (datetime('now'))
);
