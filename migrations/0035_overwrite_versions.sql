-- 0035 — Overwrite recoverability (red-team RT2-H1, 2026-06-19).
-- `remember` and `saveDocument` overwrite in place (ON CONFLICT DO UPDATE). A poisoned
-- write driven by forwarded channel content was UNRECOVERABLE. These version rows capture
-- the PRIOR value before every content-changing overwrite, so the owner can restore it —
-- the recovery layer behind the owner-write grant (audit = detect, versions = recover).
--
-- SECURITY (§1 zero-plaintext-leakage): the snapshot columns hold the prior DOCUMENT/FACT
-- content, so they MUST be encrypted at rest. They are registered in ENCRYPTED_FIELDS
-- (src/crypto/crypto-local.js): document_versions[title,summary,content], fact_versions[value].
-- The adapter auto-encrypts on INSERT and auto-decrypts on read under the uniform 'personal'
-- scope (same as documents.content / facts.value). NEVER SELECT these columns into a log.

-- ── document_versions: extend the existing table (migration 0001) ──
-- Pre-existing cols: id, document_id, diff, changed_by, change_summary, created_at.
-- Add a full prior-snapshot + scoping/provenance. ALTER ADD COLUMN is NULL-safe on the
-- rows the bulk importer may already have written (their snapshot cols stay NULL).
ALTER TABLE document_versions ADD COLUMN user_id TEXT;
ALTER TABLE document_versions ADD COLUMN path TEXT;
ALTER TABLE document_versions ADD COLUMN title TEXT;     -- ENCRYPTED (prior title)
ALTER TABLE document_versions ADD COLUMN summary TEXT;   -- ENCRYPTED (prior summary)
ALTER TABLE document_versions ADD COLUMN content TEXT;   -- ENCRYPTED (prior body)
ALTER TABLE document_versions ADD COLUMN trigger TEXT;   -- overwrite | channel | chat | import
ALTER TABLE document_versions ADD COLUMN reason TEXT;    -- optional short note (plaintext label)
CREATE INDEX IF NOT EXISTS idx_doc_versions_user_path ON document_versions(user_id, path, created_at);

-- ── fact_versions: new ──
CREATE TABLE IF NOT EXISTS fact_versions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  fact_id TEXT,
  category TEXT,
  key TEXT,
  value TEXT,                   -- ENCRYPTED (prior fact value)
  confidence TEXT,
  trigger TEXT,                 -- overwrite | channel | chat
  reason TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_fact_versions_user_key ON fact_versions(user_id, category, key, created_at);
