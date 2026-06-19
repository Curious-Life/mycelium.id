-- 0035 — RT2-H1 hardening (red-team 2026-06-19, follow-up to 0034).
-- Three gaps the version-layer red team surfaced:
--   HIGH-1  unbounded growth → an injection loop of overwrites bloats the vault (the
--           recovery table becomes a storage-DoS amplifier). Fixed in the DAL with a
--           keep-last-N prune after each capture (mirrors activity-feed.prune).
--   MED-1   documents only versioned title/summary/content; tags/entities/relations/
--           metadata/entity_summary/source_path were overwritten with NO version. Add an
--           ENCRYPTED full-snapshot column so a document overwrite is fully recoverable.
--   MED-2   remember(entity) overwrote summary/aliases in place with no version. Add
--           entity_versions (parallel to fact_versions).
--
-- SECURITY (§1): snapshot_json holds the prior ENCRYPTED-field set of a document as JSON;
-- entity_versions.{name,aliases,summary} hold prior entity content. All are registered in
-- ENCRYPTED_FIELDS (crypto-local.js) and encrypt at rest under the 'personal' scope.

-- MED-1: full prior snapshot for documents (JSON of every prior encrypted field).
ALTER TABLE document_versions ADD COLUMN snapshot_json TEXT;   -- ENCRYPTED (full prior field set)

-- MED-2: entity overwrite recoverability.
CREATE TABLE IF NOT EXISTS entity_versions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  entity_id TEXT,
  type TEXT,
  name TEXT,                    -- ENCRYPTED (prior name, canonical casing preserved)
  aliases TEXT,                 -- ENCRYPTED (prior aliases JSON)
  summary TEXT,                 -- ENCRYPTED (prior summary)
  trigger TEXT,                 -- overwrite | channel | chat
  reason TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_entity_versions_user_eid ON entity_versions(user_id, entity_id, created_at);
