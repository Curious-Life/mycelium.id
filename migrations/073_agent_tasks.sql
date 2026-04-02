-- Agent Tasks Queue
-- Allows agents to queue async work and report back when done

CREATE TABLE IF NOT EXISTS agent_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL DEFAULT 'mya-company',

  -- Task definition
  type TEXT NOT NULL, -- 'research', 'build', 'analyze', 'write', etc.
  description TEXT NOT NULL,
  context JSONB DEFAULT '{}', -- Additional context (message history, etc.)
  priority TEXT DEFAULT 'normal', -- 'low', 'normal', 'high', 'urgent'

  -- Who requested and where to report
  requested_by TEXT, -- Discord user ID or other identifier
  channel_id TEXT, -- Where to send the completion message

  -- Status tracking
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'in_progress', 'completed', 'failed'

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  reported_at TIMESTAMPTZ, -- When the agent reported back to the user

  -- Results
  result JSONB, -- Full result data
  summary TEXT, -- Short summary for the report-back message
  error TEXT -- Error message if failed
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_agent_tasks_agent_status ON agent_tasks(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_pending ON agent_tasks(agent_id, status, priority, created_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_agent_tasks_to_report ON agent_tasks(agent_id, status, reported_at)
  WHERE status = 'completed' AND reported_at IS NULL;

COMMENT ON TABLE agent_tasks IS 'Queue for async agent tasks - research, builds, analysis, etc.';
COMMENT ON COLUMN agent_tasks.context IS 'JSON with message history, related docs, or other context';
COMMENT ON COLUMN agent_tasks.result IS 'JSON with full task results (research findings, code changes, etc.)';
