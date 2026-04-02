-- =============================================
-- Health Metrics (Apple Health integration)
-- =============================================
-- Daily health summaries synced from iOS HealthKit.
-- All metric columns are TEXT because they store AES-256-GCM encrypted values
-- (base64 JSON envelopes). The worker db-proxy transparently encrypts on write
-- and decrypts on read. Personal scope — only accessible to Mya (personal-agent).

CREATE TABLE IF NOT EXISTS health_daily (
    id TEXT PRIMARY KEY,            -- '{user_id}:{date}' deterministic key
    user_id TEXT NOT NULL,
    date TEXT NOT NULL,             -- 'YYYY-MM-DD'

    -- Sleep (all encrypted via db-proxy)
    sleep_duration_min TEXT,        -- Total sleep time in minutes
    sleep_in_bed_min TEXT,          -- Total time in bed
    sleep_efficiency TEXT,          -- 0.0-1.0 (duration / in_bed)
    sleep_deep_min TEXT,            -- AASM stage 3
    sleep_rem_min TEXT,             -- REM stage
    sleep_core_min TEXT,            -- AASM stages 1 & 2 (light)
    sleep_awake_min TEXT,           -- Awakenings during sleep
    sleep_start TEXT,               -- ISO datetime sleep began
    sleep_end TEXT,                 -- ISO datetime sleep ended

    -- Heart (all encrypted)
    hrv_avg TEXT,                   -- HRV SDNN daily average (ms)
    hrv_sleep_avg TEXT,             -- HRV during sleep (ms)
    resting_hr TEXT,                -- Resting heart rate (bpm)

    -- Movement (all encrypted)
    steps TEXT,                     -- Step count
    active_energy_kcal TEXT,        -- Active energy burned (kcal)
    workout_count TEXT,             -- Number of workouts
    workout_minutes TEXT,           -- Total workout duration (min)
    workout_types TEXT,             -- JSON array of workout type strings

    -- Mindfulness (encrypted)
    mindful_minutes TEXT,           -- Mindful session duration (min)

    -- Meta (not encrypted — needed for queries)
    source TEXT DEFAULT 'apple_health',
    scope TEXT DEFAULT 'personal',
    synced_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_health_daily_user_date
    ON health_daily(user_id, date DESC);
