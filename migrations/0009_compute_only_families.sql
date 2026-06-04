-- 0009 — schema for the four "compute-only" cognitive-metric families
-- (H1 §4.24 refinements, criticality-phase-transitions, coherence-universal,
-- behavioral-temporal). All compute time-series/statistics over data that
-- ALREADY exists in the vault (fisher_trajectory, messages.embedding_768,
-- messages.created_at) — no embedder, no LLM, no new external dependency.
--
-- ENCRYPTION MODEL (mirrors fisher_trajectory exactly): the Python writer
-- caller-encrypts the sensitive metric VALUES via crypto_local.encrypt_str
-- (scope 'personal', wrapped-DEK envelope). The JS adapter AUTO-DECRYPTS them
-- on read (autoDecryptResults decrypts ANY encrypted-looking string column that
-- is not in NEVER_AUTO_DECRYPT_COLUMNS), so these columns are NOT added to
-- ENCRYPTED_FIELDS (that list only drives the JS WRITE path, and no JS writer
-- touches these tables). Structural columns (ids, user_id, time keys, era id,
-- low-card enums, counts, low_confidence) stay PLAINTEXT for indexed
-- lookups / ORDER BY / WHERE — those columns are never encrypted.
--
-- Sensitive (ENCRYPTED at rest, caller-encrypt): every metric scalar, every
-- detail/headline JSON-or-text column (marked "ENCRYPTED" inline below).
-- Plaintext: user_id, *_id, window_* / *_at timestamps, era_id, granularity,
-- level, window_type, event_type, severity, language, *_count, low_confidence.

-- ── H1 §4.24 cross_scale_coupling + §4.34 Wasserstein (ALTER the harmonic table) ──
-- §4.24: PAC / PLV / spectral-coherence between the 4 ADJACENT band pairs
-- (gamma-beta, beta-alpha, alpha-theta, theta-delta). 3 sub-metrics × 4 pairs
-- = 12 columns. §4.34 addition: Wasserstein distance between this window's H0
-- persistence diagram and the PREVIOUS window's (narrative-shift event signal).
-- All ENCRYPTED (caller-encrypt in compute_cross_scale_coupling.py). The
-- harmonic table itself is written by the Python harmonics stages, which
-- already caller-encrypt nothing today (legacy plaintext) — these NEW columns
-- are written caller-encrypted; the JS read path auto-decrypts envelopes and
-- passes through legacy plaintext, so a mixed table still loads.
ALTER TABLE cognitive_metrics_harmonic ADD COLUMN pac_gamma_beta REAL;
ALTER TABLE cognitive_metrics_harmonic ADD COLUMN pac_beta_alpha REAL;
ALTER TABLE cognitive_metrics_harmonic ADD COLUMN pac_alpha_theta REAL;
ALTER TABLE cognitive_metrics_harmonic ADD COLUMN pac_theta_delta REAL;
ALTER TABLE cognitive_metrics_harmonic ADD COLUMN plv_gamma_beta REAL;
ALTER TABLE cognitive_metrics_harmonic ADD COLUMN plv_beta_alpha REAL;
ALTER TABLE cognitive_metrics_harmonic ADD COLUMN plv_alpha_theta REAL;
ALTER TABLE cognitive_metrics_harmonic ADD COLUMN plv_theta_delta REAL;
ALTER TABLE cognitive_metrics_harmonic ADD COLUMN coh_gamma_beta REAL;
ALTER TABLE cognitive_metrics_harmonic ADD COLUMN coh_beta_alpha REAL;
ALTER TABLE cognitive_metrics_harmonic ADD COLUMN coh_alpha_theta REAL;
ALTER TABLE cognitive_metrics_harmonic ADD COLUMN coh_theta_delta REAL;
ALTER TABLE cognitive_metrics_harmonic ADD COLUMN topology_h0_wasserstein_prev REAL;

-- ── criticality-phase-transitions (§4.25/4.26/4.27 + flickering + ml stub) ──
-- Per-window CSD scalars over the existing fisher_trajectory series. Discrete
-- detections (phase-lock, flickering, regime shift) go to cognitive_events
-- (migration 0007). This table holds the per-window early-warning scalars.
CREATE TABLE IF NOT EXISTS cognitive_metrics_criticality (
  user_id      TEXT NOT NULL,
  level        TEXT NOT NULL,                  -- 'realm' | 'theme' | 'territory' (plaintext enum)
  window_type  TEXT NOT NULL,                  -- 'weekly_step' | ... (plaintext enum)
  window_start TEXT NOT NULL,                  -- plaintext time key
  window_end   TEXT NOT NULL,                  -- plaintext time key
  era_id       TEXT NOT NULL,                  -- clustering_run_id (plaintext, era-skip)
  language     TEXT NOT NULL DEFAULT 'en',

  -- §4.25 critical_slowing_autocorrelation — AR(1) on rolling-K source series. ENCRYPTED.
  ar1_autocorrelation       REAL,
  -- §4.26 critical_slowing_variance — rolling-K stddev companion. ENCRYPTED.
  rolling_variance          REAL,
  -- Joint early-warning flag (4.25 ∧ 4.26 both rising). ENCRYPTED scalar (0/1 as float).
  early_warning_joint       REAL,
  -- NEW flickering_detection — alternation count between two prior states. ENCRYPTED.
  flickering_score          REAL,
  -- NEW ml_transition_detector — HONEST STUB (no trained model). ENCRYPTED; always NULL
  -- (see compute-criticality.py: returns None + low_confidence + notes).
  ml_transition_score       REAL,

  -- Per-window honesty (plaintext)
  window_count   INTEGER NOT NULL DEFAULT 0,   -- # of source windows in the rolling slice
  low_confidence INTEGER NOT NULL DEFAULT 1,
  notes          TEXT,                          -- ENCRYPTED (may carry sensitivity context)
  computed_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  PRIMARY KEY (user_id, level, window_type, window_start, language, era_id)
);
CREATE INDEX IF NOT EXISTS idx_cog_crit_user ON cognitive_metrics_criticality(user_id, era_id);

-- ── coherence-universal (§4.31 + discourse_coherence_embedding) ──
-- Per-window mean pairwise cosine similarity of CONSECUTIVE message
-- embedding_768 vectors. semantic_coherence_adjacent (§4.31) and
-- discourse_coherence_embedding (§3.2.5) are the SAME computation on the same
-- consecutive-pair signal (insight noted in spec §3.2.5 / §4.31); both stored.
-- entity_grid_coherence (Tier-2, needs NER) is an HONEST STUB → always NULL.
CREATE TABLE IF NOT EXISTS cognitive_metrics_coherence (
  user_id      TEXT NOT NULL,
  window_end   TEXT NOT NULL,                  -- plaintext time key
  granularity  TEXT NOT NULL,                  -- 'alpha' | 'theta' | 'delta' (plaintext enum)
  era_id       TEXT NOT NULL,                  -- plaintext, era-skip
  language     TEXT NOT NULL DEFAULT 'en',

  -- §4.31 semantic_coherence_adjacent — mean consecutive cosine sim. ENCRYPTED.
  semantic_coherence_adjacent REAL,
  -- §4.31 companion: stddev of consecutive cosine sim (flow volatility). ENCRYPTED.
  coherence_stddev            REAL,
  -- §3.2.5 discourse_coherence_embedding — same consecutive-pair mean (distinct
  -- spec metric id; kept as its own column per the spec metric inventory). ENCRYPTED.
  discourse_coherence_embedding REAL,
  -- NEW entity_grid_coherence (Tier-2, Barzilay & Lapata; needs NER) — HONEST
  -- STUB → always NULL (see compute-coherence.py). ENCRYPTED column reserved.
  entity_grid_coherence       REAL,

  -- Honesty (plaintext)
  pair_count     INTEGER NOT NULL DEFAULT 0,   -- # consecutive pairs in window
  message_count  INTEGER NOT NULL DEFAULT 0,
  low_confidence INTEGER NOT NULL DEFAULT 1,
  notes          TEXT,                          -- ENCRYPTED
  computed_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  PRIMARY KEY (user_id, window_end, granularity, language, era_id)
);
CREATE INDEX IF NOT EXISTS idx_cog_coh_user ON cognitive_metrics_coherence(user_id, era_id);

-- ── behavioral-temporal (Tier-0; diurnal + session cadence) ──
-- Computed from message timestamps ONLY (no content, no embeddings). One row
-- per era summarizing the whole history (diurnal is a 24-bin distribution; the
-- session-cadence entropy is a single scalar over all inter-session gaps).
CREATE TABLE IF NOT EXISTS cognitive_metrics_behavioral (
  user_id      TEXT NOT NULL,
  window_end   TEXT NOT NULL,                  -- plaintext time key (history end)
  era_id       TEXT NOT NULL,                  -- plaintext, era-skip
  language     TEXT NOT NULL DEFAULT 'en',

  -- diurnal_pattern_metrics — ENCRYPTED scalars + ENCRYPTED JSON distribution.
  diurnal_entropy            REAL,              -- Shannon entropy of 24h volume dist (normalized) ENCRYPTED
  diurnal_peak_hour          REAL,              -- modal hour of writing [0..23] ENCRYPTED
  diurnal_concentration      REAL,              -- 1 - normalized entropy (peakiness) ENCRYPTED
  diurnal_hist               TEXT,              -- ENCRYPTED JSON: 24-element volume histogram

  -- session_cadence_regularity — ENCRYPTED scalars.
  session_count              REAL,              -- # of sessions (gap-split). ENCRYPTED (reveals cadence)
  intersession_entropy       REAL,              -- Shannon entropy of inter-session interval dist. ENCRYPTED
  intersession_cv            REAL,              -- coefficient of variation of intervals. ENCRYPTED

  -- Honesty (plaintext)
  message_count  INTEGER NOT NULL DEFAULT 0,
  low_confidence INTEGER NOT NULL DEFAULT 1,
  notes          TEXT,                          -- ENCRYPTED
  computed_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  PRIMARY KEY (user_id, window_end, language, era_id)
);
CREATE INDEX IF NOT EXISTS idx_cog_behav_user ON cognitive_metrics_behavioral(user_id, era_id);
