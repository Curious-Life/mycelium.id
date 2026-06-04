-- 0007 — cognitive_events: discrete measurement events (spec I4).
--
-- Greenfield in V1 AND canonical (neither had it). Holds the discrete events the
-- criticality family emits — §4.27 phase_lock_event_sigma, regime shifts,
-- flickering — as distinct rows, NOT per-window scalars (those live in the
-- cognitive_metrics_* tables). One row per (event_type, window_end, era).
--
-- Encryption (see ENCRYPTED_FIELDS.cognitive_events): magnitude, detail
-- (per-event JSON: per-level z-scores / contributing territory IDs) and the
-- server-rendered headline are ALL ENCRYPTED (numeric magnitude via the
-- type-agnostic adapter; the read path Number()s it). event_type/level/severity
-- are enums; era_id/window_*/timestamps scope + ORDER (plaintext).
CREATE TABLE IF NOT EXISTS cognitive_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  era_id TEXT,                    -- clustering_run_id / era (era-skip + scoping)
  event_type TEXT NOT NULL,       -- phase_lock | regime_shift | flickering | ...
  level TEXT,                     -- realm | theme | territory | global (nullable)
  window_start TEXT,
  window_end TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  magnitude REAL,                 -- ENCRYPTED effect size (e.g. joint sigma); read path Number()s it
  severity TEXT,                  -- notable | rare (interpretation tier; enum)
  detail TEXT,                    -- ENCRYPTED JSON: per-event specifics
  headline TEXT,                  -- ENCRYPTED: server-rendered human text
  detected_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  dismissed_at TEXT,
  UNIQUE(user_id, event_type, window_end, era_id)
);
CREATE INDEX IF NOT EXISTS idx_cognitive_events_user ON cognitive_events(user_id);
CREATE INDEX IF NOT EXISTS idx_cognitive_events_type ON cognitive_events(user_id, event_type);
