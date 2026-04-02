-- =============================================
-- Fix canvas node triggers to handle prefixed node_ids
-- =============================================
-- The canvas_workspace_nodes.node_id uses prefixed format: doc-{uuid}, msg-{uuid}, att-{uuid}
-- But the access tables (document_access, message_access, attachment_access) use plain UUIDs.
-- This migration updates the triggers to extract the UUID from the prefixed node_id.

-- Helper function to extract UUID from prefixed node_id
-- Handles: doc-{uuid}, msg-{uuid}, att-{uuid}
CREATE OR REPLACE FUNCTION extract_node_uuid(p_node_id TEXT)
RETURNS UUID AS $$
BEGIN
    -- All prefixes are 4 chars (doc-, msg-, att-), so skip first 4 characters
    RETURN SUBSTRING(p_node_id FROM 5)::UUID;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- =============================================
-- Fix: Node added to canvas -> grant access to all collaborators
-- =============================================
CREATE OR REPLACE FUNCTION content_access_on_canvas_node_insert()
RETURNS TRIGGER AS $$
DECLARE
    v_uuid UUID;
BEGIN
    -- Extract UUID from prefixed node_id
    v_uuid := extract_node_uuid(NEW.node_id);

    -- Grant access to all collaborators of this canvas
    IF NEW.node_type = 'document' THEN
        INSERT INTO document_access (document_id, user_id, access_level, via_canvas_id)
        SELECT
            v_uuid,
            cc.user_id,
            cc.permission,
            NEW.canvas_id
        FROM canvas_collaborators cc
        WHERE cc.canvas_id = NEW.canvas_id
        AND cc.user_id IS NOT NULL
        ON CONFLICT DO NOTHING;
    ELSIF NEW.node_type = 'message' THEN
        INSERT INTO message_access (message_id, user_id, access_level, via_canvas_id)
        SELECT
            v_uuid,
            cc.user_id,
            cc.permission,
            NEW.canvas_id
        FROM canvas_collaborators cc
        WHERE cc.canvas_id = NEW.canvas_id
        AND cc.user_id IS NOT NULL
        ON CONFLICT DO NOTHING;
    ELSIF NEW.node_type = 'attachment' THEN
        INSERT INTO attachment_access (attachment_id, user_id, access_level, via_canvas_id)
        SELECT
            v_uuid,
            cc.user_id,
            cc.permission,
            NEW.canvas_id
        FROM canvas_collaborators cc
        WHERE cc.canvas_id = NEW.canvas_id
        AND cc.user_id IS NOT NULL
        ON CONFLICT DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================
-- Fix: Node removed from canvas -> revoke canvas-based access
-- =============================================
CREATE OR REPLACE FUNCTION content_access_on_canvas_node_delete()
RETURNS TRIGGER AS $$
DECLARE
    v_uuid UUID;
BEGIN
    -- Extract UUID from prefixed node_id
    v_uuid := extract_node_uuid(OLD.node_id);

    IF OLD.node_type = 'document' THEN
        DELETE FROM document_access
        WHERE document_id = v_uuid
        AND via_canvas_id = OLD.canvas_id;
    ELSIF OLD.node_type = 'message' THEN
        DELETE FROM message_access
        WHERE message_id = v_uuid
        AND via_canvas_id = OLD.canvas_id;
    ELSIF OLD.node_type = 'attachment' THEN
        DELETE FROM attachment_access
        WHERE attachment_id = v_uuid
        AND via_canvas_id = OLD.canvas_id;
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- =============================================
-- Fix: Collaborator added to canvas -> grant access to all content
-- =============================================
CREATE OR REPLACE FUNCTION content_access_on_collaborator_insert()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.user_id IS NULL THEN
        -- Email-based collaborator, skip until they claim
        RETURN NEW;
    END IF;

    -- Grant access to all documents in this canvas
    INSERT INTO document_access (document_id, user_id, access_level, via_canvas_id)
    SELECT
        extract_node_uuid(cwn.node_id),
        NEW.user_id,
        NEW.permission,
        NEW.canvas_id
    FROM canvas_workspace_nodes cwn
    WHERE cwn.canvas_id = NEW.canvas_id
    AND cwn.node_type = 'document'
    ON CONFLICT DO NOTHING;

    -- Grant access to all messages in this canvas
    INSERT INTO message_access (message_id, user_id, access_level, via_canvas_id)
    SELECT
        extract_node_uuid(cwn.node_id),
        NEW.user_id,
        NEW.permission,
        NEW.canvas_id
    FROM canvas_workspace_nodes cwn
    WHERE cwn.canvas_id = NEW.canvas_id
    AND cwn.node_type = 'message'
    ON CONFLICT DO NOTHING;

    -- Grant access to all attachments in this canvas
    INSERT INTO attachment_access (attachment_id, user_id, access_level, via_canvas_id)
    SELECT
        extract_node_uuid(cwn.node_id),
        NEW.user_id,
        NEW.permission,
        NEW.canvas_id
    FROM canvas_workspace_nodes cwn
    WHERE cwn.canvas_id = NEW.canvas_id
    AND cwn.node_type = 'attachment'
    ON CONFLICT DO NOTHING;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
