-- Federation support: DIDs, remote connections, instance key cache, audit log
-- Applied to each instance's D1

-- DID for identity portability (survives instance death)
ALTER TABLE user_profiles ADD COLUMN did TEXT;

-- Remote connection tracking
ALTER TABLE connections ADD COLUMN remote_instance TEXT;
ALTER TABLE connections ADD COLUMN remote_user_handle TEXT;
ALTER TABLE connections ADD COLUMN remote_did TEXT;

-- Cached public keys of known federation peers
CREATE TABLE IF NOT EXISTS federation_keys (
  instance_url TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  key_id TEXT,
  instance_name TEXT,
  protocol_version TEXT DEFAULT '1.0',
  capabilities_json TEXT,
  user_count INTEGER DEFAULT 0,
  last_seen TEXT,
  trust_level INTEGER DEFAULT 0
);

-- Federation audit trail
CREATE TABLE IF NOT EXISTS federation_log (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL,
  remote_instance TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT DEFAULT 'success',
  details TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fed_log_instance ON federation_log(remote_instance, created_at);
