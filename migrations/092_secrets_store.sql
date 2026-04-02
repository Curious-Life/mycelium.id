-- Centralized secrets store
-- Secrets are encrypted at rest using envelope encryption (same as messages/documents)
CREATE TABLE IF NOT EXISTS secrets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,              -- e.g. "DISCORD_BOT_TOKEN", "SUPABASE_URL"
  value TEXT NOT NULL,            -- Encrypted envelope (AES-256-GCM)
  scope TEXT NOT NULL DEFAULT 'org',  -- Encryption scope: personal | org | wealth
  user_id TEXT NOT NULL DEFAULT 'system',  -- Tenant isolation
  agent TEXT,                     -- NULL = available to all agents in scope; "personal-agent" = only Mya
  version INTEGER NOT NULL DEFAULT 1,  -- Monotonic version counter (for future rotation history)
  description TEXT,               -- Human-readable note
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(key, user_id, agent)    -- One value per key per tenant per agent
);

-- Index for the primary query pattern
CREATE INDEX IF NOT EXISTS idx_secrets_lookup ON secrets(user_id, scope);
