-- =============================================
-- OBSIDIAN ATTACHMENT IMPORT SUPPORT
-- Extends attachments table to track import jobs and original paths
-- =============================================

-- Add import_job_id to track which import an attachment came from
ALTER TABLE attachments
ADD COLUMN IF NOT EXISTS import_job_id UUID REFERENCES import_jobs(id) ON DELETE SET NULL;

-- Add source_type to distinguish native uploads from imports
-- Values: 'native' | 'obsidian' | 'claude_import' | 'telegram'
ALTER TABLE attachments
ADD COLUMN IF NOT EXISTS source_type TEXT DEFAULT 'native';

-- Add original_path to preserve the original path in the source vault
-- Used for resolving wiki link embeds like ![[images/photo.png]]
ALTER TABLE attachments
ADD COLUMN IF NOT EXISTS original_path TEXT;

-- Index for efficient lookup by import job (for batch deletion)
CREATE INDEX IF NOT EXISTS idx_attachments_import_job
ON attachments(import_job_id) WHERE import_job_id IS NOT NULL;

-- Index for lookup by source type (for stats/management)
CREATE INDEX IF NOT EXISTS idx_attachments_source_type
ON attachments(user_id, source_type);

-- Index for resolving wiki links by original path
CREATE INDEX IF NOT EXISTS idx_attachments_original_path
ON attachments(user_id, original_path) WHERE original_path IS NOT NULL;

-- =============================================
-- Helper function to get attachments by import job
-- =============================================

CREATE OR REPLACE FUNCTION get_import_attachments(p_user_id UUID, p_import_job_id UUID)
RETURNS TABLE (
    id UUID,
    r2_key TEXT,
    stream_uid TEXT,
    original_path TEXT,
    attachment_type TEXT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT id, r2_key, stream_uid, original_path, attachment_type
    FROM attachments
    WHERE user_id = p_user_id
      AND import_job_id = p_import_job_id;
$$;

-- =============================================
-- Helper function to resolve attachment by original path
-- Used for wiki link resolution during embed rewriting
-- =============================================

CREATE OR REPLACE FUNCTION resolve_obsidian_attachment(
    p_user_id UUID,
    p_import_job_id UUID,
    p_target_name TEXT
)
RETURNS TABLE (
    id UUID,
    r2_key TEXT,
    stream_uid TEXT,
    attachment_type TEXT,
    original_filename TEXT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT id, r2_key, stream_uid, attachment_type, original_filename
    FROM attachments
    WHERE user_id = p_user_id
      AND import_job_id = p_import_job_id
      AND (
          -- Exact path match
          original_path = p_target_name
          -- Filename only match (Obsidian default behavior)
          OR original_filename = p_target_name
          -- Match without leading folder
          OR original_path LIKE '%/' || p_target_name
      )
    LIMIT 1;
$$;

-- =============================================
-- Cleanup function for deleting import with attachments
-- =============================================

CREATE OR REPLACE FUNCTION delete_import_with_attachments(
    p_user_id UUID,
    p_import_job_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    attachment_count INTEGER;
    document_count INTEGER;
    r2_keys TEXT[];
    stream_uids TEXT[];
BEGIN
    -- Verify ownership
    IF NOT EXISTS (
        SELECT 1 FROM import_jobs
        WHERE id = p_import_job_id AND user_id = p_user_id
    ) THEN
        RETURN json_build_object('error', 'Import job not found or unauthorized', 'status', 404);
    END IF;

    -- Get R2 keys and Stream UIDs for cleanup (before deletion)
    SELECT
        array_agg(r2_key) FILTER (WHERE r2_key IS NOT NULL),
        array_agg(stream_uid) FILTER (WHERE stream_uid IS NOT NULL)
    INTO r2_keys, stream_uids
    FROM attachments
    WHERE import_job_id = p_import_job_id AND user_id = p_user_id;

    -- Count attachments before deletion
    SELECT COUNT(*) INTO attachment_count
    FROM attachments
    WHERE import_job_id = p_import_job_id AND user_id = p_user_id;

    -- Delete attachments
    DELETE FROM attachments
    WHERE import_job_id = p_import_job_id AND user_id = p_user_id;

    -- Count and delete documents from this import
    SELECT COUNT(*) INTO document_count
    FROM documents
    WHERE user_id = p_user_id
      AND source_type = 'obsidian'
      AND metadata->>'import_job_id' = p_import_job_id::text;

    DELETE FROM documents
    WHERE user_id = p_user_id
      AND source_type = 'obsidian'
      AND metadata->>'import_job_id' = p_import_job_id::text;

    -- Delete the import job record
    DELETE FROM import_jobs
    WHERE id = p_import_job_id AND user_id = p_user_id;

    RETURN json_build_object(
        'status', 200,
        'deleted_attachments', attachment_count,
        'deleted_documents', document_count,
        'r2_keys', COALESCE(r2_keys, ARRAY[]::TEXT[]),
        'stream_uids', COALESCE(stream_uids, ARRAY[]::TEXT[])
    );
END;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION get_import_attachments(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION resolve_obsidian_attachment(UUID, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION delete_import_with_attachments(UUID, UUID) TO authenticated;
