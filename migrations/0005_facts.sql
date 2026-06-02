-- 0005_facts.sql — Context Bank Upgrade Phase 2: typed facts store.
--
-- A fact is a small, durable, user-asserted truth: category + key -> value
-- (e.g. identity/name -> "Alex", preferences/coffee -> "oat flat white").
-- Distinct from messages (conversation) and documents (long-form): facts are
-- the structured spine the agent should always know. Written via `remember`,
-- surfaced in getContext + searchMindscape({scope:'facts'}), curated via
-- forget/mark (the unified {type,id} ref handle).
--
-- Encryption: `value` is the only sensitive column -> ENCRYPTED_FIELDS.facts =
-- ['value'] (crypto-local.js). category/key stay plaintext so they can be
-- queried, deduped, and carry the UNIQUE upsert target. Local SQLite vault;
-- the adapter auto-encrypts the bound `value` param on write and auto-decrypts
-- on read.
--
-- NOTE (deviation from the design-spec draft schema): `value` is NULLABLE, not
-- NOT NULL. Soft-redact (forget) nulls `value` and stamps forgotten_at, leaving
-- an auditable husk — a NOT NULL constraint would make redact impossible. The
-- `remember` tool validates a non-empty value, so every LIVE fact has one;
-- only forgotten husks carry NULL.
--
-- Idempotent: CREATE TABLE / INDEX IF NOT EXISTS (migrate.js re-execs the whole
-- file on every boot; no ADD COLUMN here).

CREATE TABLE IF NOT EXISTS facts (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id       TEXT NOT NULL,
  category      TEXT NOT NULL,                 -- plaintext: query/group/dedup
  key           TEXT NOT NULL,                 -- plaintext: query/dedup
  value         TEXT,                          -- ENCRYPTED envelope; NULL only on forgotten husk
  confidence    TEXT DEFAULT 'stated',         -- stated | inferred | uncertain
  source        TEXT DEFAULT 'user',           -- user | assistant | import
  pinned        INTEGER DEFAULT 0,             -- salience: surfaced first
  sensitive     INTEGER DEFAULT 0,             -- salience: excluded from proactive recall
  superseded_by TEXT,                          -- reserved for future versioning (V1 upserts in place)
  forgotten_at  TEXT,                          -- soft-redact tombstone stamp
  created_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id, category, key)               -- upsert target for remember()
);

-- Live-fact reads (getContext recent, scope:'facts' listing): partial index on
-- non-forgotten rows ordered the way the readers scan them.
CREATE INDEX IF NOT EXISTS idx_facts_user_live
  ON facts(user_id, category, updated_at)
  WHERE forgotten_at IS NULL;

-- Pinned-first surfacing in getContext.
CREATE INDEX IF NOT EXISTS idx_facts_user_pinned
  ON facts(user_id, pinned)
  WHERE forgotten_at IS NULL;
