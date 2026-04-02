-- =============================================
-- Fix Canvas Multi-Canvas Support
-- =============================================
-- Adds canvas_id to canvas_positions, canvas_edges, and canvas_node_sizes
-- to support multiple canvases per user (from migration 036_canvas_workspaces.sql).
-- Previously these tables stored positions globally per user, not per canvas.

-- ===========================================
-- 1. Add canvas_id column to all tables
-- ===========================================

-- Add canvas_id to canvas_positions (nullable first for migration)
ALTER TABLE canvas_positions
ADD COLUMN IF NOT EXISTS canvas_id UUID REFERENCES canvas_workspaces(id) ON DELETE CASCADE;

-- Add canvas_id to canvas_edges
ALTER TABLE canvas_edges
ADD COLUMN IF NOT EXISTS canvas_id UUID REFERENCES canvas_workspaces(id) ON DELETE CASCADE;

-- Add canvas_id to canvas_node_sizes
ALTER TABLE canvas_node_sizes
ADD COLUMN IF NOT EXISTS canvas_id UUID REFERENCES canvas_workspaces(id) ON DELETE CASCADE;

-- ===========================================
-- 2. Migrate existing data to home canvas
-- ===========================================

-- Update canvas_positions with user's home canvas
UPDATE canvas_positions cp
SET canvas_id = (
    SELECT cw.id FROM canvas_workspaces cw
    WHERE cw.user_id = cp.user_id AND cw.is_home = TRUE
    LIMIT 1
)
WHERE cp.canvas_id IS NULL;

-- Update canvas_edges with user's home canvas
UPDATE canvas_edges ce
SET canvas_id = (
    SELECT cw.id FROM canvas_workspaces cw
    WHERE cw.user_id = ce.user_id AND cw.is_home = TRUE
    LIMIT 1
)
WHERE ce.canvas_id IS NULL;

-- Update canvas_node_sizes with user's home canvas
UPDATE canvas_node_sizes cns
SET canvas_id = (
    SELECT cw.id FROM canvas_workspaces cw
    WHERE cw.user_id = cns.user_id AND cw.is_home = TRUE
    LIMIT 1
)
WHERE cns.canvas_id IS NULL;

-- For any remaining orphaned records (user has no home canvas),
-- use their first canvas
UPDATE canvas_positions cp
SET canvas_id = (
    SELECT cw.id FROM canvas_workspaces cw
    WHERE cw.user_id = cp.user_id
    ORDER BY cw.created_at ASC
    LIMIT 1
)
WHERE cp.canvas_id IS NULL;

UPDATE canvas_edges ce
SET canvas_id = (
    SELECT cw.id FROM canvas_workspaces cw
    WHERE cw.user_id = ce.user_id
    ORDER BY cw.created_at ASC
    LIMIT 1
)
WHERE ce.canvas_id IS NULL;

UPDATE canvas_node_sizes cns
SET canvas_id = (
    SELECT cw.id FROM canvas_workspaces cw
    WHERE cw.user_id = cns.user_id
    ORDER BY cw.created_at ASC
    LIMIT 1
)
WHERE cns.canvas_id IS NULL;

-- Delete any truly orphaned records (user has no canvases at all)
DELETE FROM canvas_positions WHERE canvas_id IS NULL;
DELETE FROM canvas_edges WHERE canvas_id IS NULL;
DELETE FROM canvas_node_sizes WHERE canvas_id IS NULL;

-- ===========================================
-- 3. Make canvas_id NOT NULL and update constraints
-- ===========================================

-- Make canvas_id NOT NULL
ALTER TABLE canvas_positions ALTER COLUMN canvas_id SET NOT NULL;
ALTER TABLE canvas_edges ALTER COLUMN canvas_id SET NOT NULL;
ALTER TABLE canvas_node_sizes ALTER COLUMN canvas_id SET NOT NULL;

-- Drop old unique constraints
ALTER TABLE canvas_positions DROP CONSTRAINT IF EXISTS canvas_positions_user_id_node_id_key;
ALTER TABLE canvas_edges DROP CONSTRAINT IF EXISTS canvas_edges_user_id_source_id_target_id_key;
ALTER TABLE canvas_node_sizes DROP CONSTRAINT IF EXISTS canvas_node_sizes_user_id_node_id_key;

-- Create new unique constraints including canvas_id
ALTER TABLE canvas_positions
ADD CONSTRAINT canvas_positions_canvas_node_unique UNIQUE(canvas_id, node_id);

ALTER TABLE canvas_edges
ADD CONSTRAINT canvas_edges_canvas_source_target_unique UNIQUE(canvas_id, source_id, target_id);

ALTER TABLE canvas_node_sizes
ADD CONSTRAINT canvas_node_sizes_canvas_node_unique UNIQUE(canvas_id, node_id);

-- ===========================================
-- 4. Update indexes
-- ===========================================

-- Drop old indexes
DROP INDEX IF EXISTS idx_canvas_positions_user;
DROP INDEX IF EXISTS idx_canvas_edges_user;
DROP INDEX IF EXISTS idx_canvas_edges_source;
DROP INDEX IF EXISTS idx_canvas_edges_target;
DROP INDEX IF EXISTS idx_canvas_node_sizes_user;

-- Create new indexes including canvas_id
CREATE INDEX idx_canvas_positions_canvas ON canvas_positions(canvas_id);
CREATE INDEX idx_canvas_positions_user ON canvas_positions(user_id);
CREATE INDEX idx_canvas_edges_canvas ON canvas_edges(canvas_id);
CREATE INDEX idx_canvas_edges_user ON canvas_edges(user_id);
CREATE INDEX idx_canvas_edges_canvas_source ON canvas_edges(canvas_id, source_id);
CREATE INDEX idx_canvas_edges_canvas_target ON canvas_edges(canvas_id, target_id);
CREATE INDEX idx_canvas_node_sizes_canvas ON canvas_node_sizes(canvas_id);
CREATE INDEX idx_canvas_node_sizes_user ON canvas_node_sizes(user_id);

-- ===========================================
-- 5. Update RPC function for upsert_canvas_positions
-- ===========================================

-- Drop old function
DROP FUNCTION IF EXISTS upsert_canvas_positions(UUID, JSONB);

-- Create new function with canvas_id parameter
CREATE OR REPLACE FUNCTION upsert_canvas_positions(
    p_user_id UUID,
    p_canvas_id UUID,
    p_positions JSONB  -- Array of {node_id, x, y}
)
RETURNS INT
SECURITY INVOKER
SET search_path = public
LANGUAGE plpgsql
AS $$
DECLARE
    v_count INT := 0;
    v_pos JSONB;
BEGIN
    -- Verify user owns this canvas or has access
    IF NOT EXISTS (
        SELECT 1 FROM canvas_workspaces
        WHERE id = p_canvas_id AND user_id = p_user_id
    ) THEN
        RAISE EXCEPTION 'Access denied to canvas';
    END IF;

    FOR v_pos IN SELECT * FROM jsonb_array_elements(p_positions)
    LOOP
        INSERT INTO canvas_positions (user_id, canvas_id, node_id, x, y, updated_at)
        VALUES (
            p_user_id,
            p_canvas_id,
            v_pos->>'node_id',
            (v_pos->>'x')::FLOAT,
            (v_pos->>'y')::FLOAT,
            NOW()
        )
        ON CONFLICT (canvas_id, node_id)
        DO UPDATE SET
            x = EXCLUDED.x,
            y = EXCLUDED.y,
            updated_at = NOW();
        v_count := v_count + 1;
    END LOOP;

    RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION upsert_canvas_positions(UUID, UUID, JSONB) TO authenticated;

-- ===========================================
-- 6. Update RLS policies to use canvas_id
-- ===========================================

-- Drop old policies
DROP POLICY IF EXISTS canvas_positions_user_policy ON canvas_positions;
DROP POLICY IF EXISTS canvas_edges_user_policy ON canvas_edges;
DROP POLICY IF EXISTS canvas_node_sizes_user_policy ON canvas_node_sizes;

-- Create new policies that check canvas ownership
CREATE POLICY canvas_positions_owner_policy ON canvas_positions
    FOR ALL USING (
        canvas_id IN (SELECT id FROM canvas_workspaces WHERE user_id = auth.uid())
    );

CREATE POLICY canvas_edges_owner_policy ON canvas_edges
    FOR ALL USING (
        canvas_id IN (SELECT id FROM canvas_workspaces WHERE user_id = auth.uid())
    );

CREATE POLICY canvas_node_sizes_owner_policy ON canvas_node_sizes
    FOR ALL USING (
        canvas_id IN (SELECT id FROM canvas_workspaces WHERE user_id = auth.uid())
    );

-- Allow collaborators to view (for shared canvases)
-- Only create these policies if canvas_collaborators table exists
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'canvas_collaborators') THEN
        -- Drop existing collaborator policies if they exist
        DROP POLICY IF EXISTS canvas_positions_collaborator_policy ON canvas_positions;
        DROP POLICY IF EXISTS canvas_edges_collaborator_policy ON canvas_edges;
        DROP POLICY IF EXISTS canvas_node_sizes_collaborator_policy ON canvas_node_sizes;

        -- Create collaborator policies
        CREATE POLICY canvas_positions_collaborator_policy ON canvas_positions
            FOR SELECT USING (
                canvas_id IN (SELECT canvas_id FROM canvas_collaborators WHERE user_id = auth.uid())
            );

        CREATE POLICY canvas_edges_collaborator_policy ON canvas_edges
            FOR SELECT USING (
                canvas_id IN (SELECT canvas_id FROM canvas_collaborators WHERE user_id = auth.uid())
            );

        CREATE POLICY canvas_node_sizes_collaborator_policy ON canvas_node_sizes
            FOR SELECT USING (
                canvas_id IN (SELECT canvas_id FROM canvas_collaborators WHERE user_id = auth.uid())
            );
    END IF;
END $$;
