-- =============================================
-- Canvas Share Links
-- =============================================
-- Stores share link metadata (permission level) for canvas workspaces.
-- The share_token itself is stored on canvas_workspaces.

CREATE TABLE IF NOT EXISTS canvas_share_links (
    canvas_id UUID PRIMARY KEY REFERENCES canvas_workspaces(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    permission TEXT NOT NULL CHECK (permission IN ('view', 'edit')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for token lookup
CREATE INDEX IF NOT EXISTS idx_canvas_share_links_token ON canvas_share_links(token);

-- RLS policies
ALTER TABLE canvas_share_links ENABLE ROW LEVEL SECURITY;

-- Owner can manage share links
CREATE POLICY canvas_share_links_owner ON canvas_share_links
    FOR ALL USING (
        canvas_id IN (SELECT id FROM canvas_workspaces WHERE user_id = auth.uid())
    );

-- Anyone can read share links (for join flow validation)
CREATE POLICY canvas_share_links_public_read ON canvas_share_links
    FOR SELECT USING (true);

-- Grant permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON canvas_share_links TO authenticated;
GRANT SELECT ON canvas_share_links TO anon;
