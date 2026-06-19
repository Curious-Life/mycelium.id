-- Embedding-trajectory: the basis-free movement cross-check (Fisher P3a).
--
-- Fisher velocity reads how the territory/realm DISTRIBUTION moved — a clustering
-- construct. This stores a movement signal that routes around the clustering entirely:
-- the angular drift of the GLOBAL embedding centroid (the mean direction of ALL the
-- week's message embeddings, 768D unit vectors), week to week. Because it never touches
-- territory_id, it is invariant to a re-cluster — so when Fisher spikes and this stays
-- flat, the spike is suspect (the map redrew, not your thinking); when this moves and
-- Fisher stays flat, there is intra-territory drift the topic-map can't see. P3b reads
-- both as baseline-z's and renders the 2x2 honesty quadrant.
--
-- GLOBAL-ONLY (one series, no level): Fisher's "level" is the granularity of the whole
-- distribution, not a per-entity breakdown, so a single global centroid-drift series is
-- the correct comparator at every granularity — and the only TRULY basis-free one (a
-- per-realm centroid would re-import the clustering through scope membership).
--
-- HEALTH-HONESTY: this is its OWN table with its OWN freshness family
-- (compute-embedding-trajectory), NOT extra columns on fisher_trajectory — so a failed
-- stage shows up in /measurement-health as "stale BECAUSE the stage failed", instead of
-- inheriting Fisher's freshness and hiding its own failure (the embedding-novelty
-- UPDATE-sibling blind spot this whole effort exists to kill).
--
-- ENCRYPTION: centroid_drift + dispersion are sensitive derived signals (semantic
-- movement) → caller-encrypted via stage_crypto.enc (ENCRYPTED_FIELDS.embedding_trajectory),
-- auto-decrypted by the JS adapter. The CENTROID ITSELF (a 768D semantic fingerprint) is
-- NEVER persisted — only the two scalars derived from it. Structural columns + the
-- low_confidence flag stay plaintext.

CREATE TABLE IF NOT EXISTS embedding_trajectory (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  computed_at TEXT DEFAULT (datetime('now')),
  window_type TEXT NOT NULL DEFAULT 'weekly_step',
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  centroid_drift REAL,    -- ENCRYPTED — angular drift (radians, 0..π) vs the previous window's
                          --   global centroid; NULL for the first window or across an empty week.
  dispersion REAL,        -- ENCRYPTED — spherical variance 1 - R̄ of the window's unit embeddings
                          --   (R̄ = mean resultant length; high dispersion ⇒ directionless week).
  message_count INTEGER NOT NULL,
  low_confidence INTEGER NOT NULL DEFAULT 0,  -- plaintext: 1 when the resultant length is below its
                          --   random-direction floor (R̄·√n < RAYLEIGH_MIN), n is below the floor,
                          --   or there is no adjacent previous centroid to drift from.
  clustering_run_id TEXT NOT NULL,  -- aligns the series to the Fisher era (freshness + P3b join)
  UNIQUE(user_id, window_type, window_start, clustering_run_id)
);

CREATE INDEX IF NOT EXISTS idx_embedding_trajectory_user_run
  ON embedding_trajectory (user_id, window_type, clustering_run_id, window_start);
