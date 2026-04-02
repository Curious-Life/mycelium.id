-- Migration: Add starred functionality to documents, attachments, and messages
-- Allows users to star/favorite items for quick access

-- Add starred columns to documents table
ALTER TABLE documents ADD COLUMN IF NOT EXISTS is_starred BOOLEAN DEFAULT false;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS starred_at TIMESTAMPTZ;

-- Add starred columns to attachments table
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS is_starred BOOLEAN DEFAULT false;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS starred_at TIMESTAMPTZ;

-- Add starred columns to messages table
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_starred BOOLEAN DEFAULT false;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS starred_at TIMESTAMPTZ;

-- Create partial indexes for efficient starred queries (only index starred items)
CREATE INDEX IF NOT EXISTS idx_documents_starred
  ON documents(user_id, starred_at DESC)
  WHERE is_starred = true;

CREATE INDEX IF NOT EXISTS idx_attachments_starred
  ON attachments(user_id, starred_at DESC)
  WHERE is_starred = true;

CREATE INDEX IF NOT EXISTS idx_messages_starred
  ON messages(user_id, starred_at DESC)
  WHERE is_starred = true;

-- Comment for documentation
COMMENT ON COLUMN documents.is_starred IS 'Whether the document is starred/favorited by the user';
COMMENT ON COLUMN documents.starred_at IS 'Timestamp when the document was starred';
COMMENT ON COLUMN attachments.is_starred IS 'Whether the attachment is starred/favorited by the user';
COMMENT ON COLUMN attachments.starred_at IS 'Timestamp when the attachment was starred';
COMMENT ON COLUMN messages.is_starred IS 'Whether the message is starred/favorited by the user';
COMMENT ON COLUMN messages.starred_at IS 'Timestamp when the message was starred';
