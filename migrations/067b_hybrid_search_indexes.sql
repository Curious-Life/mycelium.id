-- Migration 067b: Create GIN indexes for full-text search
-- These may take a while on large tables but should complete within timeout

CREATE INDEX IF NOT EXISTS idx_messages_fts ON messages USING GIN (fts);
CREATE INDEX IF NOT EXISTS idx_documents_fts ON documents USING GIN (fts);
CREATE INDEX IF NOT EXISTS idx_attachments_fts ON attachments USING GIN (fts);
