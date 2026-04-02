-- Migration: Session state persistence for crash recovery
-- Stores lightweight session state that can rebuild context if server crashes mid-conversation

CREATE TABLE IF NOT EXISTS session_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Session identification
  session_id TEXT NOT NULL,  -- Client-generated session ID
  conversation_id UUID,      -- Reference to messages table (not duplicated content)
  turn_number INTEGER NOT NULL DEFAULT 0,

  -- Retrieval parameters (lightweight - just enough to rebuild context)
  retrieval_params JSONB DEFAULT '{}',
  -- Structure: {
  --   messageEmbedding: number[],
  --   matchedRealmIds: number[],
  --   matchedThemeIds: number[],
  --   matchedTerritoryIds: number[],
  --   matchedDocPaths: string[]
  -- }

  -- Pending work (only uncommitted work needs full storage)
  pending_tool_calls JSONB DEFAULT '[]',

  -- Timing
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Status tracking
  status TEXT NOT NULL DEFAULT 'active',  -- 'active', 'completed', 'crashed', 'recovered'

  -- Recovery metadata
  metadata JSONB DEFAULT '{}'
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_session_state_user_active
  ON session_state(user_id, status)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_session_state_session_id
  ON session_state(session_id);

CREATE INDEX IF NOT EXISTS idx_session_state_last_activity
  ON session_state(last_activity_at DESC);

-- Cleanup old sessions (sessions older than 24h can be cleaned up)
CREATE INDEX IF NOT EXISTS idx_session_state_cleanup
  ON session_state(last_activity_at)
  WHERE status IN ('completed', 'crashed');

-- Unique constraint: only one active session per user at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_state_user_active_unique
  ON session_state(user_id)
  WHERE status = 'active';

-- Comments for documentation
COMMENT ON TABLE session_state IS 'Lightweight session state for crash recovery - stores retrieval params, not full context';
COMMENT ON COLUMN session_state.retrieval_params IS 'Embedding and matched IDs - context rebuilt from these on recovery';
COMMENT ON COLUMN session_state.pending_tool_calls IS 'Only uncommitted tool calls stored in full';
COMMENT ON COLUMN session_state.status IS 'active: in progress, completed: finished normally, crashed: detected crash, recovered: rebuilt from crash';
