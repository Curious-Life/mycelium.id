-- 0048_claude_sessions.sql — map a portal-chat conversation to ONE Claude Code CLI
-- session, so the `claude` engine RESUMES the same session each turn (continuity +
-- claude's own in-session auto-compaction) instead of spawning a fresh session per
-- turn. Content-free OPERATIONAL state (an opaque session UUID handle keyed by the
-- plaintext conversation_id) — like harness_runs, it rides d1QueryAdmin and is NOT
-- in ENCRYPTED_FIELDS. One row per (user, conversation).
CREATE TABLE IF NOT EXISTS claude_sessions (
  user_id         TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  created_at      TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, conversation_id)
);
