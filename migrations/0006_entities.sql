-- 0006_entities.sql — Context Bank Upgrade Phase 3: first-class entities registry.
--
-- People, projects, places, orgs as durable nodes — distinct from facts (typed
-- KV truths) and messages (conversation). Written via remember(kind:'entity')
-- and the `link` verb (entity <-> message/document/fact), surfaced in getContext
-- (PEOPLE/PROJECTS, pinned-only) + searchMindscape({scope:'entities'}), curated
-- via the unified forget/mark verbs. NLP-extracted proper nouns from
-- messages.entities are promoted in (source='nlp') and merged with user curation.
--
-- Encryption (ENCRYPTED_FIELDS.entities = ['name','aliases','summary']): the
-- identifying + descriptive columns are sensitive. entity_links holds only
-- ids/enums -> all plaintext (joins/dedup).
--
-- NOTE (two deviations from the design-spec draft schema, both forced by the
-- encryption reality — verified against crypto-local.js):
--   1. NO `UNIQUE(user_id, type, name)`. `name` is encrypted with a random IV
--      (non-deterministic), so a UNIQUE constraint / ON CONFLICT(name) can never
--      match — same name encrypts differently every time. Dedup is done in the
--      application layer (db/entities.js: scan this user's entities of a type,
--      match name case-insensitively on the decrypted value, upsert by id).
--   2. `name`/`summary`/`aliases` are NULLABLE (soft-redact nulls them; the
--      remember tool validates a non-empty name for live entities).
--
-- entity_links DOES keep UNIQUE(user_id, entity_id, ref_type, ref_id) — all
-- plaintext, so INSERT OR IGNORE dedups links cleanly.
--
-- Idempotent: CREATE TABLE / INDEX IF NOT EXISTS (no ADD COLUMN here).

CREATE TABLE IF NOT EXISTS entities (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id       TEXT NOT NULL,
  type          TEXT NOT NULL,                 -- person|project|place|org|proper (nlp-unclassified)
  name          TEXT,                          -- ENCRYPTED; NULL only on forgotten husk
  aliases       TEXT,                          -- ENCRYPTED (JSON array)
  summary       TEXT,                          -- ENCRYPTED
  source        TEXT DEFAULT 'user',           -- user | assistant | nlp
  mention_count INTEGER DEFAULT 0,             -- NLP-promote frequency signal
  pinned        INTEGER DEFAULT 0,             -- salience: surfaced first (getContext PEOPLE)
  sensitive     INTEGER DEFAULT 0,             -- salience: excluded from proactive recall
  forgotten_at  TEXT,                          -- soft-redact tombstone stamp
  created_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  -- No UNIQUE(name): name is encrypted (non-deterministic). Dedup in app layer.
);

-- List/scan live entities by type (the app-layer dedup + scope:'entities' read).
CREATE INDEX IF NOT EXISTS idx_entities_user_type
  ON entities(user_id, type)
  WHERE forgotten_at IS NULL;

-- Pinned-first surfacing in getContext PEOPLE/PROJECTS.
CREATE INDEX IF NOT EXISTS idx_entities_user_pinned
  ON entities(user_id, pinned)
  WHERE forgotten_at IS NULL;

CREATE TABLE IF NOT EXISTS entity_links (
  id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id    TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  ref_type   TEXT NOT NULL,                    -- message|document|fact
  ref_id     TEXT NOT NULL,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id, entity_id, ref_type, ref_id) -- all plaintext -> INSERT OR IGNORE dedups
);

CREATE INDEX IF NOT EXISTS idx_entity_links_entity
  ON entity_links(user_id, entity_id);
