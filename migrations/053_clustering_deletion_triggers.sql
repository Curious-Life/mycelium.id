-- =============================================
-- Clustering Points Deletion Triggers
-- =============================================
-- Automatically delete from clustering_points when source records are deleted.
-- This keeps the clustering table in sync with source tables.

-- Trigger function to delete clustering_point when message is deleted
CREATE OR REPLACE FUNCTION on_message_delete_cleanup_clustering()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    DELETE FROM clustering_points
    WHERE source_type = 'message' AND source_id = OLD.id;
    RETURN OLD;
END;
$$;

-- Trigger function to delete clustering_point when document is deleted
CREATE OR REPLACE FUNCTION on_document_delete_cleanup_clustering()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    DELETE FROM clustering_points
    WHERE source_type = 'document' AND source_id = OLD.id;
    RETURN OLD;
END;
$$;

-- Trigger function to delete clustering_point when attachment is deleted
-- (handles both transcripts and image_descriptions)
CREATE OR REPLACE FUNCTION on_attachment_delete_cleanup_clustering()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- Delete transcript clustering point if it exists
    DELETE FROM clustering_points
    WHERE source_type = 'transcript' AND source_id = OLD.id;

    -- Delete image_description clustering point if it exists
    DELETE FROM clustering_points
    WHERE source_type = 'image_description' AND source_id = OLD.id;

    RETURN OLD;
END;
$$;

-- Trigger function to delete clustering_point when reflection is deleted
CREATE OR REPLACE FUNCTION on_reflection_delete_cleanup_clustering()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    DELETE FROM clustering_points
    WHERE source_type = 'reflection' AND source_id = OLD.id;
    RETURN OLD;
END;
$$;

-- Create the triggers

-- Messages deletion trigger
DROP TRIGGER IF EXISTS trg_message_delete_cleanup_clustering ON messages;
CREATE TRIGGER trg_message_delete_cleanup_clustering
    AFTER DELETE ON messages
    FOR EACH ROW
    EXECUTE FUNCTION on_message_delete_cleanup_clustering();

-- Documents deletion trigger
DROP TRIGGER IF EXISTS trg_document_delete_cleanup_clustering ON documents;
CREATE TRIGGER trg_document_delete_cleanup_clustering
    AFTER DELETE ON documents
    FOR EACH ROW
    EXECUTE FUNCTION on_document_delete_cleanup_clustering();

-- Attachments deletion trigger
DROP TRIGGER IF EXISTS trg_attachment_delete_cleanup_clustering ON attachments;
CREATE TRIGGER trg_attachment_delete_cleanup_clustering
    AFTER DELETE ON attachments
    FOR EACH ROW
    EXECUTE FUNCTION on_attachment_delete_cleanup_clustering();

-- Reflections deletion trigger
DROP TRIGGER IF EXISTS trg_reflection_delete_cleanup_clustering ON reflections;
CREATE TRIGGER trg_reflection_delete_cleanup_clustering
    AFTER DELETE ON reflections
    FOR EACH ROW
    EXECUTE FUNCTION on_reflection_delete_cleanup_clustering();

-- Also handle updates that might clear the content (set to NULL or empty)
-- For attachments, if transcript/description is cleared, remove the clustering point

CREATE OR REPLACE FUNCTION on_attachment_update_cleanup_clustering()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- If transcript was cleared, delete the transcript clustering point
    IF OLD.transcript IS NOT NULL AND (NEW.transcript IS NULL OR LENGTH(NEW.transcript) <= 10) THEN
        DELETE FROM clustering_points
        WHERE source_type = 'transcript' AND source_id = NEW.id;
    END IF;

    -- If description was cleared, delete the image_description clustering point
    IF OLD.description IS NOT NULL AND (NEW.description IS NULL OR LENGTH(NEW.description) <= 10) THEN
        DELETE FROM clustering_points
        WHERE source_type = 'image_description' AND source_id = NEW.id;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_attachment_update_cleanup_clustering ON attachments;
CREATE TRIGGER trg_attachment_update_cleanup_clustering
    AFTER UPDATE ON attachments
    FOR EACH ROW
    EXECUTE FUNCTION on_attachment_update_cleanup_clustering();

-- Grant execute on trigger functions
GRANT EXECUTE ON FUNCTION on_message_delete_cleanup_clustering() TO service_role;
GRANT EXECUTE ON FUNCTION on_document_delete_cleanup_clustering() TO service_role;
GRANT EXECUTE ON FUNCTION on_attachment_delete_cleanup_clustering() TO service_role;
GRANT EXECUTE ON FUNCTION on_reflection_delete_cleanup_clustering() TO service_role;
GRANT EXECUTE ON FUNCTION on_attachment_update_cleanup_clustering() TO service_role;
