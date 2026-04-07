-- Provisioning jobs for managed hosting customers
-- Tracks the lifecycle of VPS provisioning from signup to ready

CREATE TABLE IF NOT EXISTS provisioning_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  key_hash TEXT NOT NULL,           -- SHA-256 of master key (never the key itself)
  status TEXT DEFAULT 'pending',    -- pending | provisioning | ready | failed
  hetzner_server_id TEXT,
  hetzner_server_name TEXT,
  vps_ip TEXT,
  d1_database_name TEXT,
  d1_database_id TEXT,
  agent_tokens_json TEXT,           -- encrypted JSON of generated tokens
  passkey_credential_id TEXT,
  passkey_public_key TEXT,
  error TEXT,
  portal_url TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_provisioning_status ON provisioning_jobs(status);
CREATE INDEX IF NOT EXISTS idx_provisioning_email ON provisioning_jobs(email);
