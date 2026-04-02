-- =============================================
-- Collaborative Document Access
-- =============================================
-- Enables performant collaborative editing through cached access lookups.
-- Documents can be accessed via:
--   1. Ownership (user_id matches)
--   2. Canvas collaboration (document is in a canvas where user has permissions)
--
-- This table is maintained by triggers and provides O(1) access checks.

-- Document access cache table
CREATE TABLE IF NOT EXISTS document_access (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    access_level TEXT NOT NULL CHECK (access_level IN ('owner', 'edit', 'view')),
    via_canvas_id UUID REFERENCES canvas_workspaces(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Unique constraint for ownership (via_canvas_id IS NULL)
CREATE UNIQUE INDEX IF NOT EXISTS idx_document_access_owner_unique
    ON document_access(document_id, user_id) WHERE via_canvas_id IS NULL;

-- Unique constraint for canvas-based access
CREATE UNIQUE INDEX IF NOT EXISTS idx_document_access_canvas_unique
    ON document_access(document_id, user_id, via_canvas_id) WHERE via_canvas_id IS NOT NULL;

-- Fast lookup: "can this user access this document"
CREATE INDEX IF NOT EXISTS idx_document_access_lookup
    ON document_access(document_id, user_id);

-- Fast lookup: "what can this user access"
CREATE INDEX IF NOT EXISTS idx_user_accessible_docs
    ON document_access(user_id, access_level);

-- Fast lookup: owner of a document
CREATE INDEX IF NOT EXISTS idx_document_owner
    ON document_access(document_id) WHERE access_level = 'owner';

-- =============================================
-- Message access (same pattern for messages)
-- =============================================
CREATE TABLE IF NOT EXISTS message_access (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    access_level TEXT NOT NULL CHECK (access_level IN ('owner', 'edit', 'view')),
    via_canvas_id UUID REFERENCES canvas_workspaces(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_message_access_owner_unique
    ON message_access(message_id, user_id) WHERE via_canvas_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_access_canvas_unique
    ON message_access(message_id, user_id, via_canvas_id) WHERE via_canvas_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_message_access_lookup
    ON message_access(message_id, user_id);
CREATE INDEX IF NOT EXISTS idx_user_accessible_msgs
    ON message_access(user_id, access_level);

-- =============================================
-- Attachment access (same pattern)
-- =============================================
CREATE TABLE IF NOT EXISTS attachment_access (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    attachment_id UUID NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    access_level TEXT NOT NULL CHECK (access_level IN ('owner', 'edit', 'view')),
    via_canvas_id UUID REFERENCES canvas_workspaces(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_attachment_access_owner_unique
    ON attachment_access(attachment_id, user_id) WHERE via_canvas_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_attachment_access_canvas_unique
    ON attachment_access(attachment_id, user_id, via_canvas_id) WHERE via_canvas_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_attachment_access_lookup
    ON attachment_access(attachment_id, user_id);
CREATE INDEX IF NOT EXISTS idx_user_accessible_atts
    ON attachment_access(user_id, access_level);

-- =============================================
-- TRIGGERS: Maintain access on content creation
-- =============================================

-- Document created -> add owner access
CREATE OR REPLACE FUNCTION document_access_on_create()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO document_access (document_id, user_id, access_level, via_canvas_id)
    VALUES (NEW.id, NEW.user_id, 'owner', NULL)
    ON CONFLICT DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_document_access_create ON documents;
CREATE TRIGGER trg_document_access_create
    AFTER INSERT ON documents
    FOR EACH ROW EXECUTE FUNCTION document_access_on_create();

-- Message created -> add owner access
CREATE OR REPLACE FUNCTION message_access_on_create()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO message_access (message_id, user_id, access_level, via_canvas_id)
    VALUES (NEW.id, NEW.user_id, 'owner', NULL)
    ON CONFLICT DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_message_access_create ON messages;
CREATE TRIGGER trg_message_access_create
    AFTER INSERT ON messages
    FOR EACH ROW EXECUTE FUNCTION message_access_on_create();

-- Attachment created -> add owner access
CREATE OR REPLACE FUNCTION attachment_access_on_create()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO attachment_access (attachment_id, user_id, access_level, via_canvas_id)
    VALUES (NEW.id, NEW.user_id, 'owner', NULL)
    ON CONFLICT DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_attachment_access_create ON attachments;
CREATE TRIGGER trg_attachment_access_create
    AFTER INSERT ON attachments
    FOR EACH ROW EXECUTE FUNCTION attachment_access_on_create();

-- =============================================
-- TRIGGERS: Maintain access on canvas node changes
-- =============================================

-- Node added to canvas -> grant access to all collaborators
CREATE OR REPLACE FUNCTION content_access_on_canvas_node_insert()
RETURNS TRIGGER AS $$
BEGIN
    -- Grant access to all collaborators of this canvas
    IF NEW.node_type = 'document' THEN
        INSERT INTO document_access (document_id, user_id, access_level, via_canvas_id)
        SELECT
            NEW.node_id::UUID,
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
            NEW.node_id::UUID,
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
            NEW.node_id::UUID,
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

DROP TRIGGER IF EXISTS trg_content_access_canvas_node_insert ON canvas_workspace_nodes;
CREATE TRIGGER trg_content_access_canvas_node_insert
    AFTER INSERT ON canvas_workspace_nodes
    FOR EACH ROW EXECUTE FUNCTION content_access_on_canvas_node_insert();

-- Node removed from canvas -> revoke canvas-based access
CREATE OR REPLACE FUNCTION content_access_on_canvas_node_delete()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.node_type = 'document' THEN
        DELETE FROM document_access
        WHERE document_id = OLD.node_id::UUID
        AND via_canvas_id = OLD.canvas_id;
    ELSIF OLD.node_type = 'message' THEN
        DELETE FROM message_access
        WHERE message_id = OLD.node_id::UUID
        AND via_canvas_id = OLD.canvas_id;
    ELSIF OLD.node_type = 'attachment' THEN
        DELETE FROM attachment_access
        WHERE attachment_id = OLD.node_id::UUID
        AND via_canvas_id = OLD.canvas_id;
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_content_access_canvas_node_delete ON canvas_workspace_nodes;
CREATE TRIGGER trg_content_access_canvas_node_delete
    AFTER DELETE ON canvas_workspace_nodes
    FOR EACH ROW EXECUTE FUNCTION content_access_on_canvas_node_delete();

-- =============================================
-- TRIGGERS: Maintain access on collaborator changes
-- =============================================

-- Collaborator added to canvas -> grant access to all content in canvas
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
        cwn.node_id::UUID,
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
        cwn.node_id::UUID,
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
        cwn.node_id::UUID,
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

DROP TRIGGER IF EXISTS trg_content_access_collaborator_insert ON canvas_collaborators;
CREATE TRIGGER trg_content_access_collaborator_insert
    AFTER INSERT ON canvas_collaborators
    FOR EACH ROW EXECUTE FUNCTION content_access_on_collaborator_insert();

-- Collaborator removed from canvas -> revoke their canvas-based access
CREATE OR REPLACE FUNCTION content_access_on_collaborator_delete()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.user_id IS NULL THEN
        RETURN OLD;
    END IF;

    DELETE FROM document_access
    WHERE user_id = OLD.user_id AND via_canvas_id = OLD.canvas_id;

    DELETE FROM message_access
    WHERE user_id = OLD.user_id AND via_canvas_id = OLD.canvas_id;

    DELETE FROM attachment_access
    WHERE user_id = OLD.user_id AND via_canvas_id = OLD.canvas_id;

    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_content_access_collaborator_delete ON canvas_collaborators;
CREATE TRIGGER trg_content_access_collaborator_delete
    AFTER DELETE ON canvas_collaborators
    FOR EACH ROW EXECUTE FUNCTION content_access_on_collaborator_delete();

-- Collaborator permission changed -> update access levels
CREATE OR REPLACE FUNCTION content_access_on_collaborator_update()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.user_id IS NULL OR OLD.permission = NEW.permission THEN
        RETURN NEW;
    END IF;

    UPDATE document_access
    SET access_level = NEW.permission
    WHERE user_id = NEW.user_id AND via_canvas_id = NEW.canvas_id;

    UPDATE message_access
    SET access_level = NEW.permission
    WHERE user_id = NEW.user_id AND via_canvas_id = NEW.canvas_id;

    UPDATE attachment_access
    SET access_level = NEW.permission
    WHERE user_id = NEW.user_id AND via_canvas_id = NEW.canvas_id;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_content_access_collaborator_update ON canvas_collaborators;
CREATE TRIGGER trg_content_access_collaborator_update
    AFTER UPDATE ON canvas_collaborators
    FOR EACH ROW EXECUTE FUNCTION content_access_on_collaborator_update();

-- =============================================
-- ACCESS CHECK FUNCTIONS
-- =============================================

-- Get document access level for a user (returns 'owner', 'edit', 'view', or NULL)
CREATE OR REPLACE FUNCTION get_document_access(p_document_id UUID, p_user_id UUID)
RETURNS TEXT AS $$
    SELECT CASE
        WHEN 'owner' = ANY(array_agg(access_level)) THEN 'owner'
        WHEN 'edit' = ANY(array_agg(access_level)) THEN 'edit'
        WHEN 'view' = ANY(array_agg(access_level)) THEN 'view'
        ELSE NULL
    END
    FROM document_access
    WHERE document_id = p_document_id AND user_id = p_user_id;
$$ LANGUAGE sql STABLE;

-- Get message access level
CREATE OR REPLACE FUNCTION get_message_access(p_message_id UUID, p_user_id UUID)
RETURNS TEXT AS $$
    SELECT CASE
        WHEN 'owner' = ANY(array_agg(access_level)) THEN 'owner'
        WHEN 'edit' = ANY(array_agg(access_level)) THEN 'edit'
        WHEN 'view' = ANY(array_agg(access_level)) THEN 'view'
        ELSE NULL
    END
    FROM message_access
    WHERE message_id = p_message_id AND user_id = p_user_id;
$$ LANGUAGE sql STABLE;

-- Get attachment access level
CREATE OR REPLACE FUNCTION get_attachment_access(p_attachment_id UUID, p_user_id UUID)
RETURNS TEXT AS $$
    SELECT CASE
        WHEN 'owner' = ANY(array_agg(access_level)) THEN 'owner'
        WHEN 'edit' = ANY(array_agg(access_level)) THEN 'edit'
        WHEN 'view' = ANY(array_agg(access_level)) THEN 'view'
        ELSE NULL
    END
    FROM attachment_access
    WHERE attachment_id = p_attachment_id AND user_id = p_user_id;
$$ LANGUAGE sql STABLE;

-- =============================================
-- BACKFILL EXISTING DATA
-- =============================================

-- Backfill owner access for existing documents
INSERT INTO document_access (document_id, user_id, access_level, via_canvas_id)
SELECT id, user_id, 'owner', NULL FROM documents
ON CONFLICT DO NOTHING;

-- Backfill owner access for existing messages
INSERT INTO message_access (message_id, user_id, access_level, via_canvas_id)
SELECT id, user_id, 'owner', NULL FROM messages
ON CONFLICT DO NOTHING;

-- Backfill owner access for existing attachments
INSERT INTO attachment_access (attachment_id, user_id, access_level, via_canvas_id)
SELECT id, user_id, 'owner', NULL FROM attachments
ON CONFLICT DO NOTHING;

-- Backfill canvas-based access for existing collaborations
INSERT INTO document_access (document_id, user_id, access_level, via_canvas_id)
SELECT cwn.node_id::UUID, cc.user_id, cc.permission, cc.canvas_id
FROM canvas_workspace_nodes cwn
JOIN canvas_collaborators cc ON cc.canvas_id = cwn.canvas_id
WHERE cwn.node_type = 'document'
AND cc.user_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO message_access (message_id, user_id, access_level, via_canvas_id)
SELECT cwn.node_id::UUID, cc.user_id, cc.permission, cc.canvas_id
FROM canvas_workspace_nodes cwn
JOIN canvas_collaborators cc ON cc.canvas_id = cwn.canvas_id
WHERE cwn.node_type = 'message'
AND cc.user_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO attachment_access (attachment_id, user_id, access_level, via_canvas_id)
SELECT cwn.node_id::UUID, cc.user_id, cc.permission, cc.canvas_id
FROM canvas_workspace_nodes cwn
JOIN canvas_collaborators cc ON cc.canvas_id = cwn.canvas_id
WHERE cwn.node_type = 'attachment'
AND cc.user_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- =============================================
-- RLS POLICIES
-- =============================================
ALTER TABLE document_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachment_access ENABLE ROW LEVEL SECURITY;

-- Access tables are read-only for users (maintained by triggers)
CREATE POLICY document_access_read ON document_access
    FOR SELECT USING (user_id = auth.uid());

CREATE POLICY message_access_read ON message_access
    FOR SELECT USING (user_id = auth.uid());

CREATE POLICY attachment_access_read ON attachment_access
    FOR SELECT USING (user_id = auth.uid());

-- Grant permissions
GRANT SELECT ON document_access TO authenticated;
GRANT SELECT ON message_access TO authenticated;
GRANT SELECT ON attachment_access TO authenticated;
