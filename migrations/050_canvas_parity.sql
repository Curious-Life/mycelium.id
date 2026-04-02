-- =============================================
-- CANVAS PARITY WITH OBSIDIAN JSON CANVAS
-- Adds groups, node colors, and edge routing
-- =============================================

-- =============================================
-- CANVAS GROUPS (Visual Grouping Nodes)
-- =============================================

CREATE TABLE IF NOT EXISTS canvas_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    canvas_id UUID NOT NULL REFERENCES canvas_workspaces(id) ON DELETE CASCADE,
    label TEXT,                          -- Group title
    position_x FLOAT NOT NULL DEFAULT 0,
    position_y FLOAT NOT NULL DEFAULT 0,
    width FLOAT NOT NULL DEFAULT 400,
    height FLOAT NOT NULL DEFAULT 300,
    color TEXT,                          -- Hex color like '#ff5555' or preset '1'-'6'
    background TEXT,                     -- Optional background image/color
    background_style TEXT CHECK (background_style IN ('cover', 'ratio', 'repeat')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_canvas_groups_canvas ON canvas_groups(canvas_id);

-- =============================================
-- NODE COLORS
-- =============================================

-- Add color to workspace nodes (for coloring existing content nodes)
ALTER TABLE canvas_workspace_nodes
    ADD COLUMN IF NOT EXISTS color TEXT;

-- =============================================
-- EDGE ROUTING AND STYLING
-- =============================================

-- Add routing properties to edges
ALTER TABLE canvas_edges
    ADD COLUMN IF NOT EXISTS from_side TEXT CHECK (from_side IN ('top', 'right', 'bottom', 'left')),
    ADD COLUMN IF NOT EXISTS to_side TEXT CHECK (to_side IN ('top', 'right', 'bottom', 'left')),
    ADD COLUMN IF NOT EXISTS from_end TEXT CHECK (from_end IN ('none', 'arrow')) DEFAULT 'none',
    ADD COLUMN IF NOT EXISTS to_end TEXT CHECK (to_end IN ('none', 'arrow')) DEFAULT 'arrow',
    ADD COLUMN IF NOT EXISTS color TEXT;

-- Support edges from/to groups
-- Edge source_id and target_id can now reference:
-- - Content nodes: 'doc-{uuid}', 'msg-{uuid}', 'att-{uuid}'
-- - Group nodes: 'grp-{uuid}'
COMMENT ON COLUMN canvas_edges.source_id IS 'Node ID: doc-{uuid}, msg-{uuid}, att-{uuid}, or grp-{uuid} for groups';
COMMENT ON COLUMN canvas_edges.target_id IS 'Node ID: doc-{uuid}, msg-{uuid}, att-{uuid}, or grp-{uuid} for groups';

-- =============================================
-- RLS POLICIES
-- =============================================

ALTER TABLE canvas_groups ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS canvas_groups_owner ON canvas_groups;
DROP POLICY IF EXISTS canvas_groups_collaborator ON canvas_groups;
DROP POLICY IF EXISTS canvas_groups_public ON canvas_groups;

-- Groups: owner access through canvas ownership
CREATE POLICY canvas_groups_owner ON canvas_groups
    FOR ALL USING (
        canvas_id IN (SELECT id FROM canvas_workspaces WHERE user_id = auth.uid())
    );

-- Groups: collaborator read access
CREATE POLICY canvas_groups_collaborator ON canvas_groups
    FOR SELECT USING (
        canvas_id IN (SELECT canvas_id FROM canvas_collaborators WHERE user_id = auth.uid())
    );

-- Groups: public canvas read access
CREATE POLICY canvas_groups_public ON canvas_groups
    FOR SELECT USING (
        canvas_id IN (SELECT id FROM canvas_workspaces WHERE is_public = TRUE)
    );

-- =============================================
-- GRANTS
-- =============================================

GRANT SELECT, INSERT, UPDATE, DELETE ON canvas_groups TO authenticated;

-- =============================================
-- HELPER FUNCTIONS
-- =============================================

-- Upsert group (create or update)
CREATE OR REPLACE FUNCTION upsert_canvas_group(
    p_canvas_id UUID,
    p_group_id UUID,
    p_label TEXT,
    p_position_x FLOAT,
    p_position_y FLOAT,
    p_width FLOAT,
    p_height FLOAT,
    p_color TEXT DEFAULT NULL,
    p_background TEXT DEFAULT NULL,
    p_background_style TEXT DEFAULT NULL
)
RETURNS UUID
SECURITY INVOKER
SET search_path = public
LANGUAGE plpgsql
AS $$
DECLARE
    v_group_id UUID;
BEGIN
    -- Verify user owns the canvas
    IF NOT EXISTS (
        SELECT 1 FROM canvas_workspaces
        WHERE id = p_canvas_id AND user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Access denied';
    END IF;

    INSERT INTO canvas_groups (id, canvas_id, label, position_x, position_y, width, height, color, background, background_style)
    VALUES (
        COALESCE(p_group_id, gen_random_uuid()),
        p_canvas_id,
        p_label,
        p_position_x,
        p_position_y,
        p_width,
        p_height,
        p_color,
        p_background,
        p_background_style
    )
    ON CONFLICT (id)
    DO UPDATE SET
        label = EXCLUDED.label,
        position_x = EXCLUDED.position_x,
        position_y = EXCLUDED.position_y,
        width = EXCLUDED.width,
        height = EXCLUDED.height,
        color = EXCLUDED.color,
        background = EXCLUDED.background,
        background_style = EXCLUDED.background_style,
        updated_at = NOW()
    RETURNING id INTO v_group_id;

    RETURN v_group_id;
END;
$$;

GRANT EXECUTE ON FUNCTION upsert_canvas_group(UUID, UUID, TEXT, FLOAT, FLOAT, FLOAT, FLOAT, TEXT, TEXT, TEXT) TO authenticated;

-- Update timestamp trigger for groups
CREATE OR REPLACE FUNCTION update_canvas_group_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tr_update_canvas_group_timestamp ON canvas_groups;
CREATE TRIGGER tr_update_canvas_group_timestamp
    BEFORE UPDATE ON canvas_groups
    FOR EACH ROW
    EXECUTE FUNCTION update_canvas_group_timestamp();

-- =============================================
-- COLOR PRESETS (Obsidian compatible)
-- =============================================
-- Preset colors can be stored as '1'-'6' and resolved by the frontend:
-- '1' = '#ff5555' (red)
-- '2' = '#ffaa00' (orange)
-- '3' = '#ffff55' (yellow)
-- '4' = '#55ff55' (green)
-- '5' = '#55ffff' (cyan)
-- '6' = '#aa55ff' (purple)
-- Or hex colors like '#ff5555' can be stored directly
