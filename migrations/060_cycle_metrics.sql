-- Migration: Cycle observability metrics
-- Track metrics for reflection, dream, and other autonomous cycles

CREATE TABLE IF NOT EXISTS cycle_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Cycle identification
  cycle_type TEXT NOT NULL,  -- 'reflection', 'dream', 'morning', 'evening', 'weekly', 'triage'
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,

  -- Token usage
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost_cents INTEGER DEFAULT 0,

  -- Items created during cycle
  items_created JSONB DEFAULT '{}',  -- {"hypotheses": 1, "questions": 2, "flags": 0}

  -- Items pruned/archived (for decay cycles)
  items_pruned INTEGER DEFAULT 0,

  -- Exploration stats (for dream cycle)
  exploration_calls_used INTEGER DEFAULT 0,
  exploration_budget INTEGER DEFAULT 0,

  -- Quality metrics
  quality_score NUMERIC(3,2),  -- Self-assessed by Claude (0.00-1.00)

  -- Status
  status TEXT DEFAULT 'running',  -- 'running', 'completed', 'failed', 'skipped'
  error_message TEXT,

  -- Metadata
  metadata JSONB DEFAULT '{}'
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_cycle_metrics_user_type ON cycle_metrics(user_id, cycle_type);
CREATE INDEX IF NOT EXISTS idx_cycle_metrics_started_at ON cycle_metrics(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_cycle_metrics_status ON cycle_metrics(status) WHERE status = 'running';

-- Comments for documentation
COMMENT ON TABLE cycle_metrics IS 'Tracks metrics for autonomous cycles (reflection, dream, etc.)';
COMMENT ON COLUMN cycle_metrics.cycle_type IS 'Type of cycle: reflection, dream, morning, evening, weekly, triage';
COMMENT ON COLUMN cycle_metrics.items_created IS 'JSON object tracking items created: {hypotheses, questions, flags, dream_fragments, topology_notes}';
COMMENT ON COLUMN cycle_metrics.quality_score IS 'Self-assessed quality from 0.00 to 1.00';
