-- =============================================
-- Cleanup orphaned canvas_workspace_nodes
-- =============================================
-- Removes entries where the referenced content no longer exists

-- Delete document nodes where the document doesn't exist
DELETE FROM canvas_workspace_nodes
WHERE node_type = 'document'
AND NOT EXISTS (
    SELECT 1 FROM documents d
    WHERE d.id = SUBSTRING(canvas_workspace_nodes.node_id FROM 5)::UUID
);

-- Delete message nodes where the message doesn't exist
DELETE FROM canvas_workspace_nodes
WHERE node_type = 'message'
AND NOT EXISTS (
    SELECT 1 FROM messages m
    WHERE m.id = SUBSTRING(canvas_workspace_nodes.node_id FROM 5)::UUID
);

-- Delete attachment nodes where the attachment doesn't exist
DELETE FROM canvas_workspace_nodes
WHERE node_type = 'attachment'
AND NOT EXISTS (
    SELECT 1 FROM attachments a
    WHERE a.id = SUBSTRING(canvas_workspace_nodes.node_id FROM 5)::UUID
);

-- Delete nodes referencing non-existent canvases (should be handled by FK but just in case)
DELETE FROM canvas_workspace_nodes
WHERE NOT EXISTS (
    SELECT 1 FROM canvas_workspaces cw
    WHERE cw.id = canvas_workspace_nodes.canvas_id
);
