-- Social Layer: extend people table + contact-territory links
-- Keeps it minimal: people + one linking table

-- Add unique constraint for upsert support
CREATE UNIQUE INDEX IF NOT EXISTS idx_people_user_name ON people(user_id, name);

-- Extend people with external IDs and source tracking
ALTER TABLE people ADD COLUMN source TEXT DEFAULT 'manual';
ALTER TABLE people ADD COLUMN linkedin_url TEXT;
ALTER TABLE people ADD COLUMN email TEXT;
ALTER TABLE people ADD COLUMN phone TEXT;
ALTER TABLE people ADD COLUMN company TEXT;
ALTER TABLE people ADD COLUMN position TEXT;
ALTER TABLE people ADD COLUMN connected_at TEXT;
ALTER TABLE people ADD COLUMN last_interaction_at TEXT;
ALTER TABLE people ADD COLUMN interaction_count INTEGER DEFAULT 0;
ALTER TABLE people ADD COLUMN status TEXT DEFAULT 'active';

CREATE INDEX IF NOT EXISTS idx_people_status ON people(user_id, status);
CREATE INDEX IF NOT EXISTS idx_people_linkedin ON people(linkedin_url);

-- Contact <-> Territory links
CREATE TABLE IF NOT EXISTS contact_territories (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  contact_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  territory_id INTEGER NOT NULL,
  strength REAL DEFAULT 0,
  mention_count INTEGER DEFAULT 0,
  first_seen TEXT,
  last_seen TEXT,
  UNIQUE(contact_id, territory_id)
);

CREATE INDEX IF NOT EXISTS idx_ct_contact ON contact_territories(contact_id);
CREATE INDEX IF NOT EXISTS idx_ct_territory ON contact_territories(territory_id);
CREATE INDEX IF NOT EXISTS idx_ct_user ON contact_territories(user_id);
