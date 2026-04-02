-- Migration: Enable anonymous canvas viewing via share links
-- Similar to get_shared_content() for documents, but for canvas workspaces

-- Create the function with SECURITY DEFINER (runs with owner's privileges)
CREATE OR REPLACE FUNCTION get_shared_canvas(share_token TEXT)
RETURNS JSON
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $$
DECLARE
    share_record RECORD;
    canvas_record RECORD;
    result JSON;
    nodes_json JSON;
    positions_json JSON;
    sizes_json JSON;
    edges_json JSON;
BEGIN
    -- Look up share link from canvas_share_links
    SELECT csl.canvas_id, csl.permission, csl.token
    INTO share_record
    FROM canvas_share_links csl
    WHERE csl.token = share_token;

    IF NOT FOUND THEN
        RETURN json_build_object('error', 'Share link not found', 'status', 404);
    END IF;

    -- Get canvas metadata
    SELECT id, name, user_id, created_at
    INTO canvas_record
    FROM canvas_workspaces
    WHERE id = share_record.canvas_id;

    IF NOT FOUND THEN
        RETURN json_build_object('error', 'Canvas not found', 'status', 404);
    END IF;

    -- Get canvas owner info
    SELECT json_build_object(
        'displayName', u.display_name,
        'username', u.username
    ) INTO result
    FROM users u
    WHERE u.id = canvas_record.user_id;

    -- Get all node IDs in this canvas with their types
    SELECT json_agg(json_build_object(
        'nodeId', cwn.node_id,
        'nodeType', cwn.node_type
    ))
    INTO nodes_json
    FROM canvas_workspace_nodes cwn
    WHERE cwn.canvas_id = share_record.canvas_id;

    -- Get positions for all nodes
    SELECT json_object_agg(
        cp.node_id,
        json_build_object('x', cp.x, 'y', cp.y)
    )
    INTO positions_json
    FROM canvas_positions cp
    WHERE cp.canvas_id = share_record.canvas_id;

    -- Get sizes for all nodes
    SELECT json_object_agg(
        cns.node_id,
        json_build_object('width', cns.width, 'height', cns.height)
    )
    INTO sizes_json
    FROM canvas_node_sizes cns
    WHERE cns.canvas_id = share_record.canvas_id;

    -- Get edges for this canvas
    SELECT json_agg(json_build_object(
        'id', ce.id,
        'source', ce.source_id,
        'target', ce.target_id,
        'label', ce.label
    ))
    INTO edges_json
    FROM canvas_edges ce
    WHERE ce.canvas_id = share_record.canvas_id;

    -- Build final result
    RETURN json_build_object(
        'status', 200,
        'canvasId', canvas_record.id,
        'canvasName', canvas_record.name,
        'permission', share_record.permission,
        'owner', result,
        'nodes', COALESCE(nodes_json, '[]'::json),
        'positions', COALESCE(positions_json, '{}'::json),
        'sizes', COALESCE(sizes_json, '{}'::json),
        'edges', COALESCE(edges_json, '[]'::json)
    );
END;
$$;

-- Grant execute permission to anon role (public access)
GRANT EXECUTE ON FUNCTION get_shared_canvas(TEXT) TO anon;

-- Revoke from other roles to be explicit
REVOKE EXECUTE ON FUNCTION get_shared_canvas(TEXT) FROM authenticated;
REVOKE EXECUTE ON FUNCTION get_shared_canvas(TEXT) FROM PUBLIC;

-- Re-grant to anon after revoking from PUBLIC
GRANT EXECUTE ON FUNCTION get_shared_canvas(TEXT) TO anon;


-- Create function to get content for shared canvas nodes
-- This returns the actual document/message/attachment content
CREATE OR REPLACE FUNCTION get_shared_canvas_content(
    share_token TEXT,
    node_ids TEXT[]
)
RETURNS JSON
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $$
DECLARE
    share_record RECORD;
    canvas_record RECORD;
    documents_json JSON;
    messages_json JSON;
    attachments_json JSON;
    doc_ids UUID[];
    msg_ids UUID[];
    att_ids UUID[];
    current_node_id TEXT;
BEGIN
    -- Validate share token
    SELECT csl.canvas_id, csl.permission
    INTO share_record
    FROM canvas_share_links csl
    WHERE csl.token = share_token;

    IF NOT FOUND THEN
        RETURN json_build_object('error', 'Share link not found', 'status', 404);
    END IF;

    -- Verify canvas exists
    SELECT id, user_id INTO canvas_record
    FROM canvas_workspaces
    WHERE id = share_record.canvas_id;

    IF NOT FOUND THEN
        RETURN json_build_object('error', 'Canvas not found', 'status', 404);
    END IF;

    -- Verify all requested nodes are actually in this canvas
    FOR current_node_id IN SELECT unnest(node_ids) LOOP
        IF NOT EXISTS (
            SELECT 1 FROM canvas_workspace_nodes cwn
            WHERE cwn.canvas_id = share_record.canvas_id
            AND cwn.node_id = current_node_id
        ) THEN
            RETURN json_build_object('error', 'Node not in canvas', 'status', 403);
        END IF;
    END LOOP;

    -- Parse node IDs into their respective tables
    doc_ids := ARRAY(
        SELECT CAST(substring(n from 5) AS UUID)
        FROM unnest(node_ids) n
        WHERE n LIKE 'doc-%'
    );

    msg_ids := ARRAY(
        SELECT CAST(substring(n from 5) AS UUID)
        FROM unnest(node_ids) n
        WHERE n LIKE 'msg-%'
    );

    att_ids := ARRAY(
        SELECT CAST(substring(n from 5) AS UUID)
        FROM unnest(node_ids) n
        WHERE n LIKE 'att-%'
    );

    -- Get documents
    SELECT json_agg(json_build_object(
        'id', d.id,
        'path', d.path,
        'title', d.title,
        'content', d.content,
        'summary', d.summary,
        'tags', d.tags,
        'metadata', d.metadata,
        'updatedAt', d.updated_at
    ))
    INTO documents_json
    FROM documents d
    WHERE d.id = ANY(doc_ids)
    AND d.user_id = canvas_record.user_id;

    -- Get messages
    SELECT json_agg(json_build_object(
        'id', m.id,
        'role', m.role,
        'content', m.content,
        'tags', m.tags,
        'metadata', m.metadata,
        'createdAt', m.created_at
    ))
    INTO messages_json
    FROM messages m
    WHERE m.id = ANY(msg_ids)
    AND m.user_id = canvas_record.user_id;

    -- Get attachments (just metadata, URLs generated server-side)
    SELECT json_agg(json_build_object(
        'id', a.id,
        'attachmentType', a.attachment_type,
        'r2Key', a.r2_key,
        'streamUid', a.stream_uid,
        'transcript', a.transcript,
        'description', a.description,
        'tags', a.tags,
        'createdAt', a.created_at
    ))
    INTO attachments_json
    FROM attachments a
    WHERE a.id = ANY(att_ids)
    AND a.user_id = canvas_record.user_id;

    RETURN json_build_object(
        'status', 200,
        'documents', COALESCE(documents_json, '[]'::json),
        'messages', COALESCE(messages_json, '[]'::json),
        'attachments', COALESCE(attachments_json, '[]'::json)
    );
END;
$$;

-- Grant to anon
GRANT EXECUTE ON FUNCTION get_shared_canvas_content(TEXT, TEXT[]) TO anon;
REVOKE EXECUTE ON FUNCTION get_shared_canvas_content(TEXT, TEXT[]) FROM authenticated;
REVOKE EXECUTE ON FUNCTION get_shared_canvas_content(TEXT, TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_shared_canvas_content(TEXT, TEXT[]) TO anon;
