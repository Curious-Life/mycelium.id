-- Migration 067e: Backfill documents fts in batches
-- Documents have large content, so smaller batches (200 per statement)
-- Run this file multiple times until it reports 0 rows updated

UPDATE documents SET fts = to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(content, ''))
WHERE id IN (SELECT id FROM documents WHERE fts IS NULL LIMIT 200);

UPDATE documents SET fts = to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(content, ''))
WHERE id IN (SELECT id FROM documents WHERE fts IS NULL LIMIT 200);

UPDATE documents SET fts = to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(content, ''))
WHERE id IN (SELECT id FROM documents WHERE fts IS NULL LIMIT 200);

UPDATE documents SET fts = to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(content, ''))
WHERE id IN (SELECT id FROM documents WHERE fts IS NULL LIMIT 200);

UPDATE documents SET fts = to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(content, ''))
WHERE id IN (SELECT id FROM documents WHERE fts IS NULL LIMIT 200);
