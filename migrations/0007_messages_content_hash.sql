-- 0007 — content-aware dedup for messages.
--
-- Adds a plaintext content_hash (SHA-256 of the message body, computed on
-- plaintext at the ingestion boundary in captureMessage). Mirrors
-- documents.content_hash: it stays PLAINTEXT (NOT in ENCRYPTED_FIELDS.messages)
-- so change-detection can compare without decrypting. Dedup is by the `id` PK,
-- so no index on content_hash is needed.
--
-- Before this, captureMessage used INSERT OR IGNORE on the id PK, so an upstream
-- EDIT to a stable-id connector item (gmail:<id>, linear:<id>) was a no-op (the
-- vault kept the stale copy) and an edited content-addressed note duplicated.
-- With content_hash, capture can detect a real change and UPDATE-in-place +
-- re-enrich so the mindscape reflects the edit. See
-- docs/DESIGN-connector-content-upsert-2026-06-04.md.

ALTER TABLE messages ADD COLUMN content_hash TEXT;
