-- Migration: Canvas Workspaces
-- Enables users to organize content into multiple canvases (workspaces)
-- Each user has a Home canvas (auto-created, undeletable) plus custom canvases

-- Canvas workspaces table
CREATE TABLE IF NOT EXISTS canvas_workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_home BOOLEAN DEFAULT FALSE,
  share_token TEXT UNIQUE,
  is_public BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for user's canvases
CREATE INDEX IF NOT EXISTS idx_canvas_workspaces_user ON canvas_workspaces(user_id);
CREATE INDEX IF NOT EXISTS idx_canvas_workspaces_share_token ON canvas_workspaces(share_token) WHERE share_token IS NOT NULL;

-- Ensure each user has exactly one home canvas
CREATE UNIQUE INDEX IF NOT EXISTS idx_canvas_workspaces_home_unique
  ON canvas_workspaces(user_id) WHERE is_home = TRUE;

-- Canvas node associations (which nodes are on which canvas)
CREATE TABLE IF NOT EXISTS canvas_workspace_nodes (
  canvas_id UUID NOT NULL REFERENCES canvas_workspaces(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  node_type TEXT NOT NULL CHECK (node_type IN ('document', 'message', 'attachment')),
  position_x FLOAT,
  position_y FLOAT,
  added_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (canvas_id, node_id)
);

-- Index for finding canvases containing a node
CREATE INDEX IF NOT EXISTS idx_canvas_workspace_nodes_node ON canvas_workspace_nodes(node_id);

-- Canvas collaborators for sharing
CREATE TABLE IF NOT EXISTS canvas_collaborators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canvas_id UUID NOT NULL REFERENCES canvas_workspaces(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  email TEXT,
  permission TEXT NOT NULL CHECK (permission IN ('view', 'comment', 'edit')),
  added_at TIMESTAMPTZ DEFAULT NOW(),
  -- Either user_id or email must be set
  CONSTRAINT canvas_collaborators_user_or_email CHECK (user_id IS NOT NULL OR email IS NOT NULL)
);

-- Unique constraint: one entry per (canvas, user) when user_id is set
CREATE UNIQUE INDEX IF NOT EXISTS idx_canvas_collaborators_user_unique
  ON canvas_collaborators(canvas_id, user_id) WHERE user_id IS NOT NULL;

-- Unique constraint: one entry per (canvas, email) when only email is set
CREATE UNIQUE INDEX IF NOT EXISTS idx_canvas_collaborators_email_unique
  ON canvas_collaborators(canvas_id, email) WHERE user_id IS NULL AND email IS NOT NULL;

-- Create home canvas for existing users
INSERT INTO canvas_workspaces (user_id, name, is_home)
SELECT id, 'Home', TRUE FROM users
WHERE NOT EXISTS (
  SELECT 1 FROM canvas_workspaces WHERE canvas_workspaces.user_id = users.id AND is_home = TRUE
);

-- Function to auto-create home canvas for new users
CREATE OR REPLACE FUNCTION create_user_home_canvas()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO canvas_workspaces (user_id, name, is_home)
  VALUES (NEW.id, 'Home', TRUE);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for new users
DROP TRIGGER IF EXISTS tr_create_user_home_canvas ON users;
CREATE TRIGGER tr_create_user_home_canvas
  AFTER INSERT ON users
  FOR EACH ROW
  EXECUTE FUNCTION create_user_home_canvas();

-- RLS policies
ALTER TABLE canvas_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE canvas_workspace_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE canvas_collaborators ENABLE ROW LEVEL SECURITY;

-- Canvas workspace policies
CREATE POLICY canvas_workspaces_owner ON canvas_workspaces
  FOR ALL USING (user_id = auth.uid());

CREATE POLICY canvas_workspaces_collaborator ON canvas_workspaces
  FOR SELECT USING (
    id IN (SELECT canvas_id FROM canvas_collaborators WHERE user_id = auth.uid())
  );

CREATE POLICY canvas_workspaces_public ON canvas_workspaces
  FOR SELECT USING (is_public = TRUE);

-- Canvas nodes policies (inherit from canvas access)
CREATE POLICY canvas_workspace_nodes_owner ON canvas_workspace_nodes
  FOR ALL USING (
    canvas_id IN (SELECT id FROM canvas_workspaces WHERE user_id = auth.uid())
  );

CREATE POLICY canvas_workspace_nodes_collaborator ON canvas_workspace_nodes
  FOR SELECT USING (
    canvas_id IN (SELECT canvas_id FROM canvas_collaborators WHERE user_id = auth.uid())
  );

-- Collaborators policies
CREATE POLICY canvas_collaborators_owner ON canvas_collaborators
  FOR ALL USING (
    canvas_id IN (SELECT id FROM canvas_workspaces WHERE user_id = auth.uid())
  );

CREATE POLICY canvas_collaborators_self ON canvas_collaborators
  FOR SELECT USING (user_id = auth.uid());

-- Update timestamp trigger
CREATE OR REPLACE FUNCTION update_canvas_workspace_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tr_update_canvas_workspace_timestamp ON canvas_workspaces;
CREATE TRIGGER tr_update_canvas_workspace_timestamp
  BEFORE UPDATE ON canvas_workspaces
  FOR EACH ROW
  EXECUTE FUNCTION update_canvas_workspace_timestamp();

-- Grant permissions for portal access
GRANT SELECT, INSERT, UPDATE, DELETE ON canvas_workspaces TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON canvas_workspace_nodes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON canvas_collaborators TO authenticated;
