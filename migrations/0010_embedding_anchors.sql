-- 0010 — embedding-anchor family (E1, Tier-1; spec §2.4 anchor infrastructure
-- + §4.5/4.11/4.12/4.13 anchor metrics). Greenfield.
--
-- Two tables:
--   (1) cognitive_anchor_vectors — the embedded mean anchor vector per construct
--       (insight / reflection / affect_positive / affect_negative). The vector is
--       ENCRYPTED at rest as a vector envelope (crypto_local.encrypt_vector,
--       byte-compatible with the embedding_768 path). The column name
--       `anchor_vector` is added to NEVER_AUTO_DECRYPT_COLUMNS in crypto-local.js
--       (it is a typed-binary vector envelope, decrypted only by the typed
--       consumer pipeline/compute-anchors.py — NOT by the generic JS adapter,
--       which would double-decrypt-then-JSON-parse float bytes and throw).
--       Structural columns stay plaintext: construct, anchor_version,
--       seed_content_hash, dim, seed_count (for re-embed detection / lookup).
--
--   (2) cognitive_metrics_anchor — per-window cosine-proximity metrics of each
--       message embedding to each construct anchor:
--         §4.5  insight_embedding_proximity        (mean proximity to insight)
--         §4.12 reflective_embedding_density       (fraction of msgs > threshold
--                                                   to reflection anchor)
--         §4.11 inner_territory_presence           (mean proximity to reflection
--                                                   anchor — "inner/reflective"
--                                                   presence, distinct framing)
--         §4.13 affective_volatility_within_window (stddev of
--                                                   cos(pos)-cos(neg) across msgs)
--       All metric scalars + notes ENCRYPTED (caller-encrypt via stage_crypto.enc).
--       Structural columns stay plaintext.
--
-- CVP GATE (spec §2.3 — MANDATORY before any Tier-1 embedding metric ships):
-- real CVP requires operator human-labeled held-out data, which is unavailable.
-- Per spec §2.3 these metrics are computed + stored with low_confidence=1 and
-- cvp_status='pending' (plaintext enum) and are NOT surfaced as validated through
-- the S1 REST bridge. This is the correct spec-mandated state, not a shortcut.

CREATE TABLE IF NOT EXISTS cognitive_anchor_vectors (
  construct          TEXT NOT NULL,    -- 'insight' | 'reflection' | 'affect_positive' | 'affect_negative' (plaintext enum)
  anchor_version     TEXT NOT NULL,    -- versioned anchor definition (plaintext; anchor change = metric change, spec §2.4)
  seed_content_hash  TEXT NOT NULL,    -- sha256 of the sorted seed-phrase set (plaintext; re-embed detection)
  dim                INTEGER NOT NULL, -- vector dim (768 — same space as messages.embedding_768)
  seed_count         INTEGER NOT NULL, -- # of seed phrases averaged into the anchor
  embedder_label     TEXT NOT NULL,    -- 'nomic-v1.5' (prod) | 'stub-deterministic' (verify) (plaintext provenance)

  -- The mean anchor vector — ENCRYPTED vector envelope (NEVER_AUTO_DECRYPT).
  anchor_vector      TEXT NOT NULL,

  computed_at        TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  PRIMARY KEY (construct, anchor_version)
);

CREATE TABLE IF NOT EXISTS cognitive_metrics_anchor (
  user_id        TEXT NOT NULL,
  window_end     TEXT NOT NULL,        -- plaintext time key
  granularity    TEXT NOT NULL,        -- 'alpha' | 'theta' | 'delta' (plaintext enum)
  era_id         TEXT NOT NULL,        -- clustering_run_id (plaintext, era-skip)
  language       TEXT NOT NULL DEFAULT 'en',
  anchor_version TEXT NOT NULL,        -- which anchor set produced these (plaintext; metric provenance)

  -- §4.5 insight_embedding_proximity — mean cos(msg, C_insight) over window. ENCRYPTED.
  insight_embedding_proximity    REAL,
  -- §4.12 reflective_embedding_density — fraction of msgs with cos(msg, C_reflection)
  --       above a calibrated threshold. The threshold is NOT calibrated (no
  --       operator labels) → REFLECT_THRESHOLD is a documented provisional value
  --       (compute-anchors.py); low_confidence + cvp_status carry the honesty. ENCRYPTED.
  reflective_embedding_density    REAL,
  -- §4.11 inner_territory_presence — mean cos(msg, C_reflection) over window
  --       (auto-derived embedding-space distance to a reflection anchor, spec §4.11). ENCRYPTED.
  inner_territory_presence       REAL,
  -- §4.13 affective_volatility_within_window — stddev over window of
  --       cos(msg, C_affect_pos) - cos(msg, C_affect_neg). ENCRYPTED.
  affective_volatility_within_window REAL,

  -- CVP gate (spec §2.3) — plaintext enum. 'pending' until operator-labeled CVP
  -- calibration runs. NEVER surfaced as validated while pending.
  cvp_status     TEXT NOT NULL DEFAULT 'pending',

  -- Honesty (plaintext)
  message_count  INTEGER NOT NULL DEFAULT 0,
  low_confidence INTEGER NOT NULL DEFAULT 1,
  notes          TEXT,                 -- ENCRYPTED
  computed_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  PRIMARY KEY (user_id, window_end, granularity, language, era_id, anchor_version)
);
CREATE INDEX IF NOT EXISTS idx_cog_anchor_user ON cognitive_metrics_anchor(user_id, era_id);
