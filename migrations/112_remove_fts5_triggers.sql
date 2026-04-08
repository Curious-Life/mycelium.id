-- Remove FTS5 triggers that index ciphertext (useless and wasteful)
-- FTS5 cannot search encrypted content. Semantic search via Vectorize works.
-- See docs/ENCRYPTION.md "FTS5 is broken for encrypted rows"

-- Drop triggers that auto-index message content into FTS5
DROP TRIGGER IF EXISTS messages_ai;  -- AFTER INSERT
DROP TRIGGER IF EXISTS messages_au;  -- AFTER UPDATE
DROP TRIGGER IF EXISTS messages_ad;  -- AFTER DELETE

-- Drop the FTS5 virtual table itself (contains only ciphertext, no value)
DROP TABLE IF EXISTS messages_fts;
