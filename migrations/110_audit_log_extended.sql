-- Extend audit_log with fields needed for security event tracking
ALTER TABLE audit_log ADD COLUMN user_id TEXT;
ALTER TABLE audit_log ADD COLUMN ip_address TEXT;
ALTER TABLE audit_log ADD COLUMN event_type TEXT;
ALTER TABLE audit_log ADD COLUMN details TEXT;

CREATE INDEX IF NOT EXISTS idx_audit_log_event_type ON audit_log(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);
