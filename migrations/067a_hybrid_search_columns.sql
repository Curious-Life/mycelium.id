-- Migration 067a: Add tsvector columns
-- Run this first, it's fast (just adds nullable columns)

ALTER TABLE messages ADD COLUMN IF NOT EXISTS fts tsvector;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS fts tsvector;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS fts tsvector;
