-- Add source column to messages table to track where messages originated
-- Values: 'telegram', 'web', 'claude_export', 'openai_export', 'portal_upload', etc.

-- Step 1: Add the column (defaults to 'telegram' for truly new messages)
ALTER TABLE messages
ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'telegram';

-- Step 2: Migrate existing source values from metadata JSON
-- This preserves source info from imports (claude_export, openai_export, etc.)
UPDATE messages
SET source = metadata->>'source'
WHERE metadata->>'source' IS NOT NULL
  AND metadata->>'source' != '';

-- Step 3: Create index for efficient filtering by source
CREATE INDEX IF NOT EXISTS idx_messages_source ON messages(user_id, source);

-- Documentation
COMMENT ON COLUMN messages.source IS 'Message origin: telegram, web, claude_export, openai_export, portal_upload, etc.';
