-- =============================================
-- Fix canvas_workspace_nodes.node_id type
-- =============================================
-- The node_id column should be TEXT (to support prefixed IDs like "doc-uuid", "msg-uuid")
-- but was incorrectly created as UUID in some deployments.

-- Change node_id from UUID to TEXT
ALTER TABLE canvas_workspace_nodes
ALTER COLUMN node_id TYPE TEXT;
