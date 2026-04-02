-- Migration: Remove Home Canvas System
-- Users now create all canvases themselves - no auto-created "Home" canvas
-- Existing home canvases become regular canvases (can be renamed/deleted)

-- 1. Drop the trigger that auto-creates home canvas for new users
DROP TRIGGER IF EXISTS tr_create_user_home_canvas ON users;

-- 2. Drop the function that creates home canvases
DROP FUNCTION IF EXISTS create_user_home_canvas();

-- 3. Drop the unique index that enforced one home canvas per user
DROP INDEX IF EXISTS idx_canvas_workspaces_home_unique;

-- 4. Remove the is_home column (existing home canvases become regular canvases)
ALTER TABLE canvas_workspaces DROP COLUMN IF EXISTS is_home;

-- Note: Existing "Home" canvases are preserved as regular canvases.
-- Users can now rename or delete them like any other canvas.
-- New users will need to create their first canvas manually.
