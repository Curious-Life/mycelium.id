-- Migration: Content Folders Architecture
-- Implements folder-based content organization where:
-- - Folders are the source of truth for all content
-- - System folders (Inbox, Trash) are auto-created for each user
-- - Views (Mindscape, Timeline, Folders) are lenses on the same content
-- - Canvases pull content from folders (many-to-many)

-- =============================================
-- Folders Table
-- =============================================
CREATE TABLE IF NOT EXISTS folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  parent_id UUID REFERENCES folders(id) ON DELETE CASCADE,
  folder_type TEXT NOT NULL DEFAULT 'user' CHECK (folder_type IN ('system', 'user')),
  icon TEXT,  -- Optional icon identifier
  color TEXT, -- Optional color for UI
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for folders
CREATE INDEX IF NOT EXISTS idx_folders_user ON folders(user_id);
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id) WHERE parent_id IS NOT NULL;

-- Unique constraint: no duplicate names in same parent folder
CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_unique_name
  ON folders(user_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), name);

-- =============================================
-- Add folder_id to content tables
-- =============================================

-- Add folder_id to documents (nullable initially for migration)
ALTER TABLE documents ADD COLUMN IF NOT EXISTS folder_id UUID REFERENCES folders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_documents_folder ON documents(folder_id) WHERE folder_id IS NOT NULL;

-- Add folder_id to messages
ALTER TABLE messages ADD COLUMN IF NOT EXISTS folder_id UUID REFERENCES folders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_messages_folder ON messages(folder_id) WHERE folder_id IS NOT NULL;

-- Add folder_id to attachments
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS folder_id UUID REFERENCES folders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_attachments_folder ON attachments(folder_id) WHERE folder_id IS NOT NULL;

-- =============================================
-- Create system folders for existing users
-- =============================================

-- Create Inbox folder for each user (system folder, cannot be deleted)
INSERT INTO folders (user_id, name, folder_type, icon, sort_order)
SELECT id, 'Inbox', 'system', 'inbox', -2 FROM users
WHERE NOT EXISTS (
  SELECT 1 FROM folders WHERE folders.user_id = users.id AND name = 'Inbox' AND folder_type = 'system'
);

-- Create Trash folder for each user (system folder, cannot be deleted)
INSERT INTO folders (user_id, name, folder_type, icon, sort_order)
SELECT id, 'Trash', 'system', 'trash', -1 FROM users
WHERE NOT EXISTS (
  SELECT 1 FROM folders WHERE folders.user_id = users.id AND name = 'Trash' AND folder_type = 'system'
);

-- =============================================
-- Migrate existing documents to Inbox
-- =============================================

-- Move all documents without a folder_id to their user's Inbox
UPDATE documents d
SET folder_id = (
  SELECT f.id FROM folders f
  WHERE f.user_id = d.user_id
  AND f.name = 'Inbox'
  AND f.folder_type = 'system'
)
WHERE d.folder_id IS NULL;

-- Move all messages without a folder_id to their user's Inbox
UPDATE messages m
SET folder_id = (
  SELECT f.id FROM folders f
  WHERE f.user_id = m.user_id
  AND f.name = 'Inbox'
  AND f.folder_type = 'system'
)
WHERE m.folder_id IS NULL AND m.user_id IS NOT NULL;

-- Move all attachments without a folder_id to their user's Inbox
UPDATE attachments a
SET folder_id = (
  SELECT f.id FROM folders f
  WHERE f.user_id = a.user_id
  AND f.name = 'Inbox'
  AND f.folder_type = 'system'
)
WHERE a.folder_id IS NULL AND a.user_id IS NOT NULL;

-- =============================================
-- Canvas-Folder Association (many-to-many)
-- =============================================

-- Table for associating folders with canvases
CREATE TABLE IF NOT EXISTS canvas_folder_associations (
  canvas_id UUID NOT NULL REFERENCES canvas_workspaces(id) ON DELETE CASCADE,
  folder_id UUID NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  include_subfolders BOOLEAN DEFAULT TRUE,
  added_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (canvas_id, folder_id)
);

CREATE INDEX IF NOT EXISTS idx_canvas_folder_canvas ON canvas_folder_associations(canvas_id);
CREATE INDEX IF NOT EXISTS idx_canvas_folder_folder ON canvas_folder_associations(folder_id);

-- =============================================
-- Function to create system folders for new users
-- =============================================

CREATE OR REPLACE FUNCTION create_user_system_folders()
RETURNS TRIGGER AS $$
BEGIN
  -- Create Inbox
  INSERT INTO folders (user_id, name, folder_type, icon, sort_order)
  VALUES (NEW.id, 'Inbox', 'system', 'inbox', -2);

  -- Create Trash
  INSERT INTO folders (user_id, name, folder_type, icon, sort_order)
  VALUES (NEW.id, 'Trash', 'system', 'trash', -1);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for new users (replaces home canvas trigger)
DROP TRIGGER IF EXISTS tr_create_user_system_folders ON users;
CREATE TRIGGER tr_create_user_system_folders
  AFTER INSERT ON users
  FOR EACH ROW
  EXECUTE FUNCTION create_user_system_folders();

-- =============================================
-- Update timestamp trigger for folders
-- =============================================

CREATE OR REPLACE FUNCTION update_folder_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tr_update_folder_timestamp ON folders;
CREATE TRIGGER tr_update_folder_timestamp
  BEFORE UPDATE ON folders
  FOR EACH ROW
  EXECUTE FUNCTION update_folder_timestamp();

-- =============================================
-- RLS Policies for folders
-- =============================================

ALTER TABLE folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE canvas_folder_associations ENABLE ROW LEVEL SECURITY;

-- Users can manage their own folders
CREATE POLICY folders_owner ON folders
  FOR ALL USING (user_id = auth.uid());

-- Canvas folder associations - owner of canvas can manage
CREATE POLICY canvas_folder_assoc_owner ON canvas_folder_associations
  FOR ALL USING (
    canvas_id IN (SELECT id FROM canvas_workspaces WHERE user_id = auth.uid())
  );

-- =============================================
-- Permissions
-- =============================================

GRANT SELECT, INSERT, UPDATE, DELETE ON folders TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON canvas_folder_associations TO authenticated;

-- =============================================
-- Update canvas_workspaces: Remove is_home requirement
-- =============================================

-- Drop the unique constraint on home canvas (no longer needed)
DROP INDEX IF EXISTS idx_canvas_workspaces_home_unique;

-- Mark existing home canvases as regular canvases
-- (keeping the is_home column for backward compatibility but making it optional)
COMMENT ON COLUMN canvas_workspaces.is_home IS 'Deprecated: Home canvas concept replaced by Mindscape view showing all content';
