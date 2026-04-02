-- Fix semantic_themes unique constraint to include realm_id
-- Old: UNIQUE(user_id, semantic_theme_id) — broken when theme_ids repeat across realms
-- New: UNIQUE(user_id, realm_id, semantic_theme_id)

-- SQLite can't ALTER unique constraints, so recreate the table
CREATE TABLE semantic_themes_new (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  realm_id INTEGER NOT NULL,
  semantic_theme_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT,
  essence TEXT,
  territory_count INTEGER DEFAULT 0,
  message_count INTEGER DEFAULT 0,
  territory_ids TEXT,
  included_territory_count INTEGER DEFAULT 0,
  coverage_percent REAL DEFAULT 0,
  top_entities TEXT,
  signature_patterns TEXT,
  story_birth TEXT,
  story_arc TEXT,
  story_peak_moments TEXT,
  story_current_chapter TEXT,
  uncertainty_open_questions TEXT,
  uncertainty_edges TEXT,
  centroid_256 TEXT,
  raw_response TEXT,
  generated_at TEXT,
  generation_model TEXT,
  generation_version TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(user_id, realm_id, semantic_theme_id)
);

-- Copy existing data
INSERT INTO semantic_themes_new SELECT * FROM semantic_themes;

-- Swap tables
DROP TABLE semantic_themes;
ALTER TABLE semantic_themes_new RENAME TO semantic_themes;

-- Recreate indexes
CREATE INDEX idx_themes_realm ON semantic_themes(realm_id);
CREATE INDEX idx_themes_user ON semantic_themes(user_id);
CREATE INDEX idx_themes_lookup ON semantic_themes(user_id, realm_id, semantic_theme_id);
