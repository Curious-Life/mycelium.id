-- Migration 067d: Backfill fts columns in batches
-- Each UPDATE is limited to 500 rows to avoid timeout

-- Backfill messages (batch 1-3)
UPDATE messages SET fts = to_tsvector('english', COALESCE(content, ''))
WHERE id IN (SELECT id FROM messages WHERE fts IS NULL LIMIT 500);

UPDATE messages SET fts = to_tsvector('english', COALESCE(content, ''))
WHERE id IN (SELECT id FROM messages WHERE fts IS NULL LIMIT 500);

UPDATE messages SET fts = to_tsvector('english', COALESCE(content, ''))
WHERE id IN (SELECT id FROM messages WHERE fts IS NULL LIMIT 500);

-- Backfill attachments
UPDATE attachments SET fts = to_tsvector('english', COALESCE(transcript, '') || ' ' || COALESCE(description, ''))
WHERE id IN (SELECT id FROM attachments WHERE fts IS NULL LIMIT 500);
