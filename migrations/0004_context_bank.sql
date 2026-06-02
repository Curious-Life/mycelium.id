-- 0004 — Context Bank upgrade, Phase 1 (forget + salience).
--
-- Adds soft-redact + user-asserted salience to messages and documents.
--   forgotten_at → tombstone marker. forget() sets it and nulls content +
--                  embeddings in the same op. Every content-returning read
--                  filters `forgotten_at IS NULL`; the in-RAM search loader too.
--   pinned       → user-asserted importance (surfaced first in getContext).
--   sensitive    → user-asserted sensitivity (excluded from proactive recall +
--                  egress in later phases).
-- documents already has is_pinned; it gains sensitive + forgotten_at.
--
-- NOTE: multiple ADD COLUMNs in one file is safe because applyMigrations()
-- (src/db/migrate.js) guards EVERY bare ADD COLUMN, not just the first.
ALTER TABLE messages ADD COLUMN pinned INTEGER DEFAULT 0;
ALTER TABLE messages ADD COLUMN sensitive INTEGER DEFAULT 0;
ALTER TABLE messages ADD COLUMN forgotten_at TEXT;
ALTER TABLE documents ADD COLUMN sensitive INTEGER DEFAULT 0;
ALTER TABLE documents ADD COLUMN forgotten_at TEXT;
