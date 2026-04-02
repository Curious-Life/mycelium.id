-- Add unique constraint for upsert support in scheduled_events
-- Allows user settings to be toggled on/off per event type

-- First drop any existing rows that would violate the constraint
-- (keep only one row per user+event_type, preferring the most recently modified one)
DELETE FROM scheduled_events a
USING scheduled_events b
WHERE a.user_id = b.user_id
  AND a.event_type = b.event_type
  AND a.id < b.id;

-- Add the unique constraint
ALTER TABLE scheduled_events
  ADD CONSTRAINT unique_user_event_type UNIQUE (user_id, event_type);

-- Grant the necessary permissions for portal to manage user's own settings
-- Note: RLS still enforced, but portal uses service-level access via SUPABASE_ANON_KEY
GRANT SELECT, INSERT, UPDATE ON scheduled_events TO anon;
