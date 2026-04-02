-- Agent Registry for Federation
-- Enables cross-instance agent discovery. Each MYA instance publishes its
-- local agents here with a heartbeat. Remote instances query for alive agents.

CREATE TABLE IF NOT EXISTS agent_registry (
  agent_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  url TEXT NOT NULL,
  port INTEGER,
  tier INTEGER DEFAULT 1,
  card JSONB DEFAULT '{}',
  last_heartbeat BIGINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (agent_id, instance_id)
);

-- Index for fast discovery queries (exclude stale entries)
CREATE INDEX IF NOT EXISTS idx_agent_registry_heartbeat
  ON agent_registry (last_heartbeat DESC);

CREATE INDEX IF NOT EXISTS idx_agent_registry_instance
  ON agent_registry (instance_id);

-- Enable RLS (service role key bypasses, but good practice)
ALTER TABLE agent_registry ENABLE ROW LEVEL SECURITY;

-- Policy: service role can do everything (agents use service role key)
CREATE POLICY "Service role full access on agent_registry"
  ON agent_registry
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Cleanup function: remove entries not heartbeated in 10 minutes
-- Call via pg_cron or application-level cleanup
CREATE OR REPLACE FUNCTION cleanup_stale_agents()
RETURNS void
LANGUAGE sql
AS $$
  DELETE FROM agent_registry
  WHERE last_heartbeat < (EXTRACT(EPOCH FROM now()) * 1000 - 600000);
$$;
