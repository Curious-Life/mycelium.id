-- Message buffer for handling Telegram's automatic message splitting
-- When messages exceed 4096 chars, Telegram splits them into multiple messages
-- This table buffers chunks until we have the complete message

CREATE TABLE IF NOT EXISTS message_buffer (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  telegram_chat_id BIGINT NOT NULL,
  chunk_text TEXT NOT NULL,
  chunk_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Index for quick lookups
  CONSTRAINT message_buffer_user_chat_idx UNIQUE (user_id, telegram_chat_id, chunk_order, created_at)
);

-- Index for finding recent chunks
CREATE INDEX IF NOT EXISTS message_buffer_recent_idx
ON message_buffer(user_id, telegram_chat_id, created_at DESC);

-- Auto-cleanup old buffer entries (older than 1 minute)
-- This prevents orphaned chunks from accumulating
CREATE OR REPLACE FUNCTION cleanup_old_buffer_entries()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM message_buffer
  WHERE created_at < NOW() - INTERVAL '1 minute';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Run cleanup on each insert
DROP TRIGGER IF EXISTS cleanup_buffer_trigger ON message_buffer;
CREATE TRIGGER cleanup_buffer_trigger
AFTER INSERT ON message_buffer
EXECUTE FUNCTION cleanup_old_buffer_entries();

-- RLS: Only service_role can access
ALTER TABLE message_buffer ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access to message_buffer"
ON message_buffer
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- Revoke all from other roles
REVOKE ALL ON message_buffer FROM anon, authenticated;
