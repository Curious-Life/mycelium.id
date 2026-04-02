-- =============================================
-- APPLE NOTES IMPORT SUPPORT
-- Adds efficient index for Apple Notes deduplication by identifier
-- =============================================

-- Index for efficient Apple Notes queries by identifier
-- Used for deduplication during import (apple_identifier is stored in metadata)
CREATE INDEX IF NOT EXISTS idx_documents_apple_identifier
ON documents ((metadata->>'apple_identifier'))
WHERE source_type = 'apple_notes';

-- Add updated_at trigger for import_jobs (if not exists)
-- This helps track when jobs are modified during batch processing
CREATE OR REPLACE FUNCTION update_import_jobs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Add updated_at column if it doesn't exist
ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Create trigger only if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'import_jobs_updated_at'
  ) THEN
    CREATE TRIGGER import_jobs_updated_at
      BEFORE UPDATE ON import_jobs
      FOR EACH ROW
      EXECUTE FUNCTION update_import_jobs_updated_at();
  END IF;
END;
$$;

-- Update import_type comment to include apple_notes
COMMENT ON COLUMN import_jobs.import_type IS 'Import source type: obsidian | claude | openai | apple_notes | mya_logs';
