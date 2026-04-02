-- =============================================
-- Canvas Node Sizes
-- =============================================
-- Stores user-defined node sizes for the Canvas view.
-- Per-user: each user has their own sizes.

CREATE TABLE IF NOT EXISTS canvas_node_sizes (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,  -- 'doc-uuid', 'att-uuid', etc.
    width FLOAT NOT NULL,
    height FLOAT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(user_id, node_id)
);

-- RLS Policies
ALTER TABLE canvas_node_sizes ENABLE ROW LEVEL SECURITY;

CREATE POLICY canvas_node_sizes_user_policy ON canvas_node_sizes
    FOR ALL USING (user_id = auth.uid());

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_canvas_node_sizes_user ON canvas_node_sizes(user_id);
