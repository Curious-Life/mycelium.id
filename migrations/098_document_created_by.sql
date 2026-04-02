-- Add created_by column to documents table
-- Tracks who authored the document: agent ID (e.g. 'personal-agent', 'wealth-agent') or 'user' for portal uploads
ALTER TABLE documents ADD COLUMN created_by TEXT;

-- Index for filtering by author
CREATE INDEX IF NOT EXISTS idx_documents_created_by ON documents(user_id, created_by);

-- Backfill: infer created_by from source_type for existing documents
-- Import sources → user uploaded
UPDATE documents SET created_by = 'user'
WHERE created_by IS NULL
  AND source_type IN ('import_obsidian', 'import_claude', 'import_chatgpt', 'upload', 'portal');

-- Transcriptions → user (call recordings)
UPDATE documents SET created_by = 'user'
WHERE created_by IS NULL AND source_type = 'transcription';

-- Native docs with identity/internal paths → personal-agent (Mya's mind files)
UPDATE documents SET created_by = 'personal-agent'
WHERE created_by IS NULL AND source_type = 'native'
  AND (path LIKE 'identity/%' OR path LIKE 'internal/%' OR path LIKE 'states/%' OR path LIKE 'phenomena/%');

-- Remaining native docs → user (portal-created)
UPDATE documents SET created_by = 'user'
WHERE created_by IS NULL AND source_type = 'native';
