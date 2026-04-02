-- Fix message_access trigger to handle NULL user_id
-- Agent messages (from Discord, etc.) may not have a user_id

CREATE OR REPLACE FUNCTION message_access_on_create()
RETURNS TRIGGER AS $$
BEGIN
    -- Only create access entry if user_id is not null
    IF NEW.user_id IS NOT NULL THEN
        INSERT INTO message_access (message_id, user_id, access_level, via_canvas_id)
        VALUES (NEW.id, NEW.user_id, 'owner', NULL)
        ON CONFLICT DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Also fix document and attachment triggers for consistency
CREATE OR REPLACE FUNCTION document_access_on_create()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.user_id IS NOT NULL THEN
        INSERT INTO document_access (document_id, user_id, access_level, via_canvas_id)
        VALUES (NEW.id, NEW.user_id, 'owner', NULL)
        ON CONFLICT DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION attachment_access_on_create()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.user_id IS NOT NULL THEN
        INSERT INTO attachment_access (attachment_id, user_id, access_level, via_canvas_id)
        VALUES (NEW.id, NEW.user_id, 'owner', NULL)
        ON CONFLICT DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
