-- =============================================
-- Canvas Layout Persistence
-- =============================================
-- Stores user-defined node positions and connections for the Canvas view.
-- Per-user: each user has their own layout.

-- Node positions on canvas
CREATE TABLE canvas_positions (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,  -- 'doc-uuid', 'att-uuid', etc.
    x FLOAT NOT NULL,
    y FLOAT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(user_id, node_id)
);

-- User-created edges (connections between nodes)
CREATE TABLE canvas_edges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL,  -- Node ID
    target_id TEXT NOT NULL,  -- Node ID
    label TEXT,               -- Optional label for the edge
    created_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(user_id, source_id, target_id)
);

-- RLS Policies
ALTER TABLE canvas_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE canvas_edges ENABLE ROW LEVEL SECURITY;

CREATE POLICY canvas_positions_user_policy ON canvas_positions
    FOR ALL USING (user_id = auth.uid());

CREATE POLICY canvas_edges_user_policy ON canvas_edges
    FOR ALL USING (user_id = auth.uid());

-- Indexes for efficient lookups
CREATE INDEX idx_canvas_positions_user ON canvas_positions(user_id);
CREATE INDEX idx_canvas_edges_user ON canvas_edges(user_id);
CREATE INDEX idx_canvas_edges_source ON canvas_edges(user_id, source_id);
CREATE INDEX idx_canvas_edges_target ON canvas_edges(user_id, target_id);

-- Function to upsert multiple positions at once
CREATE OR REPLACE FUNCTION upsert_canvas_positions(
    p_user_id UUID,
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
    FOR v_pos IN SELECT * FROM jsonb_array_elements(p_positions)
    LOOP
        INSERT INTO canvas_positions (user_id, node_id, x, y, updated_at)
        VALUES (
            p_user_id,
            v_pos->>'node_id',
            (v_pos->>'x')::FLOAT,
            (v_pos->>'y')::FLOAT,
            NOW()
        )
        ON CONFLICT (user_id, node_id)
        DO UPDATE SET
            x = EXCLUDED.x,
            y = EXCLUDED.y,
            updated_at = NOW();
        v_count := v_count + 1;
    END LOOP;

    RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION upsert_canvas_positions(UUID, JSONB) TO authenticated;
