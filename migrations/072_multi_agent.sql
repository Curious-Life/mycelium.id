-- Multi-Agent Support Migration
-- Adds agent_id column to messages and documents for scoped memory

-- Add agent_id to messages table
ALTER TABLE messages ADD COLUMN IF NOT EXISTS agent_id TEXT DEFAULT 'mya-personal';

-- Create index for efficient agent-scoped queries
CREATE INDEX IF NOT EXISTS idx_messages_agent_id ON messages(agent_id);

-- Composite index for user + agent queries
CREATE INDEX IF NOT EXISTS idx_messages_user_agent ON messages(user_id, agent_id);

-- Add agent_id to documents table
ALTER TABLE documents ADD COLUMN IF NOT EXISTS agent_id TEXT DEFAULT 'mya-personal';

-- Create index for document agent scoping
CREATE INDEX IF NOT EXISTS idx_documents_agent_id ON documents(agent_id);

-- Composite index for user + agent document queries
CREATE INDEX IF NOT EXISTS idx_documents_user_agent ON documents(user_id, agent_id);

-- Update RLS policies to include agent_id filtering (optional, can be done at app level)
-- For now we handle scoping in the application layer

COMMENT ON COLUMN messages.agent_id IS 'Agent that created/owns this message (mya-personal, mya-research, mya-builder, mya-company)';
COMMENT ON COLUMN documents.agent_id IS 'Agent that created/owns this document (mya-personal, mya-research, mya-builder, mya-company)';
