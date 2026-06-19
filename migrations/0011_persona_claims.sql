-- 0011_persona_claims.sql — Persona-Claims subsystem (PersonaTree adoption +
-- temporal claim evolution). See docs/PERSONA-CLAIMS-DESIGN-2026-06-06.md.
--
-- Two tables: person_claims (current root-level claims, PersonaTree "Root") and
-- person_claim_snapshots (per-window state, cloned from frequency_snapshots so
-- the same TimeSeries.svelte / *-series read path shows how a claim changes over
-- time). Leaves = existing `messages` (timestamped, embedded evidence).
--
-- ENCRYPTION (registered in src/crypto/crypto-local.js ENCRYPTED_FIELDS):
--   person_claims:          claim_type, content, confidence_logodds, decay_class, support
--   person_claim_snapshots: confidence_logodds, content, evidence_count, delta_kind
-- embedding_768 is a vector envelope → NEVER_AUTO_DECRYPT (handled like messages).
-- Structural columns stay plaintext so SQL can filter: id/user_id (keys),
-- subject/status/scope (enums), content_hash (tombstone/dedup key), window_*/
-- granularity (time keys), *_at (timestamps). Both tables are SCOPE_AWARE.

-- Current root-level claims. One row per live claim; tombstones kept (status='rejected').
CREATE TABLE IF NOT EXISTS person_claims (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT 'self',   -- 'self' or people.id
  claim_type TEXT,                         -- ENCRYPTED  personality|value|principle|identity|boundary
  content TEXT,                            -- ENCRYPTED  the claim sentence
  confidence_logodds TEXT,                 -- ENCRYPTED  REAL; JS writes a number, Number() on read
  decay_class TEXT,                        -- ENCRYPTED  boundary|identity|fact|preference|mood
  support TEXT,                            -- ENCRYPTED  JSON {messages:[id…], territories:[id…]}
  content_hash TEXT,                       -- plaintext  SHA-256 of normalized text (tombstone/dedup key)
  embedding_768 TEXT,                      -- NEVER_AUTO_DECRYPT vector envelope (identity-match + retrieval)
  status TEXT NOT NULL DEFAULT 'active',   -- plaintext  active|archived|superseded|rejected
  scope TEXT DEFAULT 'personal',           -- plaintext  (SCOPE_AWARE_TABLES)
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_evidence_at TEXT,                   -- plaintext time key (drives decay Δt)
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_claims_user ON person_claims(user_id, status);
CREATE INDEX IF NOT EXISTS idx_claims_hash ON person_claims(user_id, content_hash);

-- Per-window state of each claim (clone of frequency_snapshots). Drives "over time".
CREATE TABLE IF NOT EXISTS person_claim_snapshots (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  window_start TEXT NOT NULL,              -- plaintext time key
  window_end TEXT NOT NULL,                -- plaintext time key
  granularity TEXT NOT NULL DEFAULT 'week',-- plaintext  day|week|month|quarter
  confidence_logodds TEXT,                 -- ENCRYPTED
  content TEXT,                            -- ENCRYPTED  claim text as of this window
  evidence_count TEXT,                     -- ENCRYPTED  number → repr/Number round-trip
  delta_kind TEXT,                         -- ENCRYPTED  new|strengthened|weakened|contradicted|stable|retired
  scope TEXT DEFAULT 'personal',           -- plaintext  (SCOPE_AWARE_TABLES)
  computed_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, claim_id, window_end, granularity)
);
CREATE INDEX IF NOT EXISTS idx_claim_snap ON person_claim_snapshots(user_id, claim_id, granularity, window_end);
