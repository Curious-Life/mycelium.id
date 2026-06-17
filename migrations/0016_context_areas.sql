-- 0016 — Context Areas (#19): the "areas of context" lens on sharing_contexts.
-- A sharing_contexts row already names a facet ("Work Self", …) and groups
-- territories for federation sharing. This adds the second lens the spec asks
-- for: attach DOCUMENTS to an area + a high-level AI SUMMARY that gives the AI
-- context about that life-domain.
--
-- SECURITY: `summary` is a synthesis of the user's documents → a semantic
-- fingerprint of plaintext → ENCRYPTED at rest via ENCRYPTED_FIELDS.sharing_contexts
-- (added in src/crypto/crypto-local.js). `name` stays plaintext (a queryable facet
-- label, as today). The summary is only ever written via UPDATE (setSummary), never
-- an INSERT, so the auto-encrypt VALUES-paren caveat (see 0008/0015) does not apply.
--
-- context_documents holds only (context_id, document_path); document.path is the
-- plaintext UNIQUE key already, so the junction adds NO new at-rest exposure.
--
-- Public Space (#19): user_profiles gains an enable flag + an intentionally-public
-- bio (plaintext by design — it is meant to be world-readable; NOT encrypted).

ALTER TABLE sharing_contexts ADD COLUMN summary TEXT;             -- ENCRYPTED (registry)
ALTER TABLE sharing_contexts ADD COLUMN summary_updated_at TEXT;  -- plaintext timestamp

CREATE TABLE IF NOT EXISTS context_documents (
  context_id    TEXT NOT NULL,
  document_path TEXT NOT NULL,
  added_at      TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (context_id, document_path)
);

ALTER TABLE user_profiles ADD COLUMN public_space_enabled INTEGER DEFAULT 0;
ALTER TABLE user_profiles ADD COLUMN public_bio TEXT;             -- PUBLIC by design → plaintext
