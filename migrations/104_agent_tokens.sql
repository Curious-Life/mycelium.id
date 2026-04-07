-- Dynamic agent tokens for managed hosting customers.
-- Supplements the static AGENT_REGISTRY Worker secret (which stays for the owner's agents).
-- Customer agent tokens are registered here via POST /api/admin/register-agent.

CREATE TABLE IF NOT EXISTS agent_tokens (
  token_hash TEXT PRIMARY KEY,        -- SHA-256 of the token (never store raw tokens)
  agent TEXT NOT NULL,                 -- e.g. "personal-agent"
  name TEXT NOT NULL,                  -- human-readable label
  user_id TEXT NOT NULL,               -- tenant isolation key
  scopes TEXT NOT NULL DEFAULT 'org',  -- comma-separated: "personal,org,wealth"
  created_at TEXT DEFAULT (datetime('now')),
  last_used_at TEXT,
  disabled INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_agent_tokens_user ON agent_tokens(user_id);
