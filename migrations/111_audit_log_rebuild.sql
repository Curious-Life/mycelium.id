-- Rebuild audit_log with relaxed constraints for comprehensive event logging.
-- Original schema had NOT NULL on agent_id/endpoint/method which blocks auth events.
-- New schema uses TEXT primary key (UUID) instead of autoincrement integer.

CREATE TABLE IF NOT EXISTS audit_log_new (
  id TEXT PRIMARY KEY,
  event_type TEXT,
  agent_id TEXT,
  user_id TEXT,
  ip_address TEXT,
  endpoint TEXT,
  method TEXT,
  scope TEXT,
  table_name TEXT,
  record_count INTEGER,
  success INTEGER DEFAULT 1,
  error TEXT,
  details TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Migrate existing data (if any)
INSERT OR IGNORE INTO audit_log_new
  SELECT
    COALESCE(CAST(id AS TEXT), lower(hex(randomblob(16)))),
    event_type, agent_id, user_id, ip_address,
    endpoint, method, scope, table_name, record_count,
    success, error, details, created_at
  FROM audit_log;

DROP TABLE IF EXISTS audit_log;
ALTER TABLE audit_log_new RENAME TO audit_log;

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_audit_event_type ON audit_log(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_user_id ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_log(agent_id, created_at);
