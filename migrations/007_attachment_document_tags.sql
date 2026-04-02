-- Migration: Add tags column to attachments and documents tables
-- This allows proper tagging of uploaded media and markdown files

-- Add tags array column to attachments
ALTER TABLE attachments
ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';

-- Add tags array column to documents
ALTER TABLE documents
ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';

-- Create index for tag-based queries on attachments
CREATE INDEX IF NOT EXISTS idx_attachments_tags ON attachments USING GIN (tags);

-- Create index for tag-based queries on documents
CREATE INDEX IF NOT EXISTS idx_documents_tags ON documents USING GIN (tags);

-- Migrate existing tags from metadata.tags to the new column (attachments)
UPDATE attachments
SET tags = ARRAY(SELECT jsonb_array_elements_text(metadata->'tags'))
WHERE metadata->>'tags' IS NOT NULL
  AND tags = '{}';

-- Migrate existing tags from metadata.tags to the new column (documents)
UPDATE documents
SET tags = ARRAY(SELECT jsonb_array_elements_text(metadata->'tags'))
WHERE metadata->>'tags' IS NOT NULL
  AND tags = '{}';

-- Comment on columns
COMMENT ON COLUMN attachments.tags IS 'Array of tags assigned during upload processing';
COMMENT ON COLUMN documents.tags IS 'Array of tags assigned during upload or document creation';
