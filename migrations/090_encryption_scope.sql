-- Migration 090: Encryption Scope Columns & Audit Log
-- Adds scope column to all content tables for encryption scope filtering.
-- Creates audit_log table for security event tracking.

-- ── Scope columns ──────────────────────────────────────────────────

-- Default 'org' — most content is organization-scoped
ALTER TABLE messages ADD COLUMN scope TEXT DEFAULT 'org';
ALTER TABLE documents ADD COLUMN scope TEXT DEFAULT 'org';
ALTER TABLE attachments ADD COLUMN scope TEXT DEFAULT 'org';
ALTER TABLE clustering_points ADD COLUMN scope TEXT DEFAULT 'org';
ALTER TABLE agent_events ADD COLUMN scope TEXT DEFAULT 'org';
ALTER TABLE agent_tasks ADD COLUMN scope TEXT DEFAULT 'org';

-- People are always personal-scoped
ALTER TABLE people ADD COLUMN scope TEXT DEFAULT 'personal';

-- Wealth tables are always wealth-scoped
ALTER TABLE wealth_transactions ADD COLUMN scope TEXT DEFAULT 'wealth';
ALTER TABLE wealth_positions ADD COLUMN scope TEXT DEFAULT 'wealth';
ALTER TABLE wealth_snapshots ADD COLUMN scope TEXT DEFAULT 'wealth';

-- ── Indexes for scope-based filtering ──────────────────────────────

CREATE INDEX IF NOT EXISTS idx_messages_scope ON messages(scope);
CREATE INDEX IF NOT EXISTS idx_documents_scope ON documents(scope);
CREATE INDEX IF NOT EXISTS idx_messages_scope_created ON messages(scope, created_at);
CREATE INDEX IF NOT EXISTS idx_documents_scope_created ON documents(scope, updated_at);

-- ── Backfill tracking indexes ──────────────────────────────────────
-- Partial indexes to find unencrypted rows during backfill.
-- Base64-encoded JSON envelopes starting with {"v":1,...} always begin with 'eyJ'.

CREATE INDEX IF NOT EXISTS idx_messages_unencrypted
  ON messages(id) WHERE content IS NOT NULL AND content != '' AND content NOT LIKE 'eyJ%';

CREATE INDEX IF NOT EXISTS idx_documents_unencrypted
  ON documents(id) WHERE content IS NOT NULL AND content != '' AND content NOT LIKE 'eyJ%';

-- ── Audit log table ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL,
  scope TEXT,
  table_name TEXT,
  record_count INTEGER,
  success INTEGER NOT NULL,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_agent ON audit_log(agent_id, created_at);
