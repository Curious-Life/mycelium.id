-- 0049_cluster_gravity.sql — Per-cluster "gravity" (attentional weight).
--
-- gravity = mass × recency × centrality, normalized per level; gravity_share is the
-- share of total gravity (sums to 1 across a level). Computed by pipeline/compute-gravity.js
-- (step 9.5, after vitality) and written via db.rawQuery.
--
-- Stored exactly like `energy` / `current_vitality`: plaintext-inside-cipher (the whole
-- vault is SQLCipher at rest; column-envelope ENCRYPTED_FIELDS for these tables is []).
-- Plain REAL columns; no ENCRYPTED_FIELDS change. Structural ids stay plaintext.
--
-- migrate.js applies .sql in lexical order and auto-guards each ADD COLUMN against an
-- already-present column, so this file is idempotent / safe to re-run.

ALTER TABLE territory_profiles ADD COLUMN gravity REAL DEFAULT 0;
ALTER TABLE territory_profiles ADD COLUMN gravity_share REAL DEFAULT 0;

ALTER TABLE realms ADD COLUMN gravity REAL DEFAULT 0;
ALTER TABLE realms ADD COLUMN gravity_share REAL DEFAULT 0;

ALTER TABLE semantic_themes ADD COLUMN gravity REAL DEFAULT 0;
ALTER TABLE semantic_themes ADD COLUMN gravity_share REAL DEFAULT 0;
