-- AI provider credentials (Claude, OpenAI, custom)
-- Supports multiple accounts per provider per user
CREATE TABLE IF NOT EXISTS ai_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,            -- 'claude', 'openai', 'custom'
  label TEXT,                        -- user-given name: 'Work Claude', 'Personal GPT'
  auth_type TEXT NOT NULL,           -- 'oauth' (Claude), 'api_key' (OpenAI/custom)
  credentials TEXT,                  -- encrypted JSON envelope (AES-256-GCM)
  config_dir TEXT,                   -- for Claude: filesystem path to config dir
  model_preference TEXT,             -- e.g. 'claude-sonnet-4-5', 'gpt-4o'
  base_url TEXT,                     -- for custom providers: API endpoint
  is_active INTEGER DEFAULT 0,      -- which one is currently used per provider type
  status TEXT DEFAULT 'pending',     -- 'active', 'pending', 'expired', 'error'
  last_used_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_providers_user ON ai_providers(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_providers_active ON ai_providers(user_id, provider, is_active);
