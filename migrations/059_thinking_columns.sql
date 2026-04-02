-- Migration: Add thinking mode columns to messages table
-- This enables storing extended thinking content from Claude API responses

-- Add thinking columns to messages table
ALTER TABLE messages ADD COLUMN IF NOT EXISTS thinking text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS thinking_enabled boolean DEFAULT false;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS thinking_tokens integer;

-- Add comment for documentation
COMMENT ON COLUMN messages.thinking IS 'Extended thinking content from Claude API (stored for later review)';
COMMENT ON COLUMN messages.thinking_enabled IS 'Whether thinking mode was enabled for this response';
COMMENT ON COLUMN messages.thinking_tokens IS 'Estimated thinking tokens (derived: output_tokens - estimateTokens(content))';

-- Create index for analytics queries on thinking usage
CREATE INDEX IF NOT EXISTS idx_messages_thinking_enabled ON messages(thinking_enabled) WHERE thinking_enabled = true;
