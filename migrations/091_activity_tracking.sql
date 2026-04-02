-- Activity tracking: stores app usage sessions synced from the Mycelium Transcriber mac app.
-- Sessions are heartbeat-merged (same app+title extends the current session).
-- Personal-scope encrypted: window_title and url fields.

CREATE TABLE IF NOT EXISTS activity_sessions (
    id TEXT PRIMARY KEY,
    agent_id TEXT DEFAULT 'personal-agent',
    app_bundle TEXT NOT NULL,
    app_name TEXT NOT NULL,
    window_title TEXT,
    url TEXT,
    category TEXT DEFAULT 'other',
    productivity INTEGER DEFAULT 50,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    duration_s REAL DEFAULT 0,
    idle INTEGER DEFAULT 0,
    date TEXT NOT NULL,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_activity_agent_date
    ON activity_sessions(agent_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_activity_date_category
    ON activity_sessions(date, category);
CREATE INDEX IF NOT EXISTS idx_activity_started
    ON activity_sessions(started_at);

-- Pre-aggregated daily summaries for fast dashboard queries.
CREATE TABLE IF NOT EXISTS activity_daily (
    date TEXT NOT NULL,
    agent_id TEXT DEFAULT 'personal-agent',
    category TEXT,
    total_s REAL NOT NULL DEFAULT 0,
    session_count INTEGER DEFAULT 0,
    productivity_avg REAL DEFAULT 50,
    PRIMARY KEY (date, agent_id, category)
);
