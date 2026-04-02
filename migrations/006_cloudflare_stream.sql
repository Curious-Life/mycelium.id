-- Migration: Add Cloudflare Stream support for iOS-compatible video playback
-- Videos uploaded to Stream will have stream_uid, while R2-stored videos have r2_key

-- Add stream_uid column to attachments table
ALTER TABLE attachments ADD COLUMN stream_uid TEXT;

-- Make r2_key nullable (Stream videos won't have an R2 key)
ALTER TABLE attachments ALTER COLUMN r2_key DROP NOT NULL;

-- Add constraint: attachment must have either r2_key or stream_uid
ALTER TABLE attachments ADD CONSTRAINT attachment_storage_check
    CHECK (r2_key IS NOT NULL OR stream_uid IS NOT NULL);

-- Index for stream_uid lookups
CREATE INDEX idx_attachments_stream_uid ON attachments(stream_uid) WHERE stream_uid IS NOT NULL;

-- Update the get_shared_content function to include stream_uid
CREATE OR REPLACE FUNCTION get_shared_content(share_token TEXT, provided_password TEXT DEFAULT NULL)
RETURNS JSON
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $$
DECLARE
    share_record RECORD;
    result JSON;
    password_hash_check TEXT;
BEGIN
    -- Look up share link
    SELECT * INTO share_record
    FROM share_links
    WHERE token = share_token;

    IF NOT FOUND THEN
        RETURN json_build_object('error', 'Share link not found', 'status', 404);
    END IF;

    -- Check expiry
    IF share_record.expires_at < NOW() THEN
        RETURN json_build_object('error', 'Share link has expired', 'status', 410);
    END IF;

    -- Check max views
    IF share_record.max_views IS NOT NULL AND share_record.view_count >= share_record.max_views THEN
        RETURN json_build_object('error', 'Share link has reached maximum views', 'status', 410);
    END IF;

    -- Check password if required
    IF share_record.password_hash IS NOT NULL THEN
        IF provided_password IS NULL OR provided_password = '' THEN
            RETURN json_build_object('error', 'Password required', 'requiresPassword', true, 'status', 401);
        END IF;
        -- Hash the provided password (SHA-256, hex encoded)
        password_hash_check := encode(sha256(convert_to(provided_password, 'UTF8')), 'hex');
        IF password_hash_check != share_record.password_hash THEN
            RETURN json_build_object('error', 'Invalid password', 'requiresPassword', true, 'status', 401);
        END IF;
    END IF;

    -- Increment view count
    UPDATE share_links SET view_count = view_count + 1 WHERE id = share_record.id;

    -- Fetch content based on resource type
    IF share_record.resource_type = 'document' THEN
        SELECT json_build_object(
            'type', 'document',
            'data', json_build_object(
                'id', d.id,
                'title', COALESCE(d.title, split_part(d.path, '/', array_length(string_to_array(d.path, '/'), 1))),
                'content', d.content,
                'summary', d.summary,
                'path', d.path,
                'updatedAt', d.updated_at
            ),
            'status', 200
        ) INTO result
        FROM documents d
        WHERE d.id = share_record.resource_id;

    ELSIF share_record.resource_type = 'attachment' THEN
        SELECT json_build_object(
            'type', 'attachment',
            'attachmentType', a.attachment_type,
            'data', json_build_object(
                'id', a.id,
                'r2Key', a.r2_key,
                'streamUid', a.stream_uid,
                'filename', a.original_filename,
                'transcript', a.transcript,
                'description', a.description,
                'createdAt', a.created_at
            ),
            'status', 200
        ) INTO result
        FROM attachments a
        WHERE a.id = share_record.resource_id;

    ELSE
        RETURN json_build_object('error', 'Unknown resource type', 'status', 400);
    END IF;

    IF result IS NULL THEN
        RETURN json_build_object('error', 'Content not found', 'status', 404);
    END IF;

    RETURN result;
END;
$$;

-- Grant execute permission to anon role (public access)
GRANT EXECUTE ON FUNCTION get_shared_content(TEXT, TEXT) TO anon;
