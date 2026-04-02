-- ============================================================================
-- Cloudflare D1 Schema for Mycelium
-- AUTO-GENERATED on 2026-03-31 — do not edit manually.
-- Regenerate: bash scripts/generate-schema.sh
--
-- Fresh install (one command):
--   npx wrangler d1 execute <db-name> --remote --file=migrations/d1-schema.sql
--
-- Existing database upgrades: apply individual migrations/NNN_*.sql files.
--
-- Also create (via wrangler CLI, not SQL):
--   Vectorize: mycelium-search  (1024D, cosine)
--   Vectorize: mycelium-cluster (256D, cosine)
--   R2 bucket: mycelium-attachments
--   KV namespace: mycelium-kv
-- ============================================================================

-- ── Tables (16) ─────────────────────────────────────────────────────

CREATE TABLE activity_daily (
    date TEXT NOT NULL,
    agent_id TEXT DEFAULT 'personal-agent',
    category TEXT,
    total_s REAL NOT NULL DEFAULT 0,
    session_count INTEGER DEFAULT 0,
    productivity_avg REAL DEFAULT 50,
    PRIMARY KEY (date, agent_id, category)
);
CREATE TABLE activity_sessions (
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
CREATE TABLE audit_log (
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
CREATE TABLE cluster_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  cluster_version TEXT NOT NULL,
  level TEXT NOT NULL,                  -- 'atom' | 'territory' | 'theme' | 'realm'
  event_type TEXT NOT NULL,             -- 'formed' | 'grew' | 'split' | 'merged' | 'dissolved' | 'stable'
  cluster_id INTEGER,                   -- new cluster ID (null if dissolved)
  old_cluster_ids TEXT,                 -- JSON array of predecessor IDs
  new_cluster_ids TEXT,                 -- JSON array of successor IDs (for splits)
  jaccard_score REAL,                   -- overlap with best-matching predecessor
  point_count INTEGER,                  -- points in this cluster
  point_delta INTEGER,                  -- change from previous version
  sample_tags TEXT,                     -- JSON: top tags in this cluster
  sample_entities TEXT,                 -- JSON: top entities
  description TEXT,                     -- human-readable event description
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE contact_territories (
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
CREATE TABLE secrets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,              -- e.g. "DISCORD_BOT_TOKEN", "SUPABASE_URL"
  value TEXT NOT NULL,            -- Encrypted envelope (AES-256-GCM)
  scope TEXT NOT NULL DEFAULT 'org',  -- Encryption scope: personal | org | wealth
  user_id TEXT NOT NULL DEFAULT 'system',  -- Tenant isolation
  agent TEXT,                     -- NULL = available to all agents in scope; "personal-agent" = only Mya
  version INTEGER NOT NULL DEFAULT 1,  -- Monotonic version counter (for future rotation history)
  description TEXT,               -- Human-readable note
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(key, user_id, agent)    -- One value per key per tenant per agent
);
CREATE TABLE "semantic_themes" (
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
CREATE TABLE territory_cofire (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  territory_a INT NOT NULL,  -- Lower territory_id (enforced by CHECK)
  territory_b INT NOT NULL,  -- Higher territory_id

  -- Multi-scale co-firing weights (temporal decay, not raw counts)
  -- Each scale uses exponential decay: weight = exp(-time_delta / half_life)
  cofire_immediate FLOAT DEFAULT 0,  -- half-life 1h: focused work sessions
  cofire_session FLOAT DEFAULT 0,    -- half-life 4h: single conversation session
  cofire_daily FLOAT DEFAULT 0,      -- half-life 24h: daily rhythm
  cofire_weekly FLOAT DEFAULT 0,     -- half-life 7d: project-level patterns

  -- Metadata
  last_cofire_at TIMESTAMPTZ,        -- When these territories last co-occurred
  last_computed TIMESTAMPTZ,         -- When weights were last recalculated

  UNIQUE(user_id, territory_a, territory_b),
  CHECK (territory_a < territory_b)  -- Store only one direction (undirected graph)
);
CREATE TABLE wealth_assets (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,  -- stock, etf, crypto, commodity, prediction, cash, other
  exchange TEXT,
  currency TEXT NOT NULL,
  lookup_id TEXT,       -- external API identifier (coingecko slug, yahoo symbol, etc.)
  price_source TEXT NOT NULL DEFAULT 'manual'  -- yahoo, coingecko, polymarket, metal_api, fx, manual
);
CREATE TABLE wealth_portfolio_access (
  portfolio_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',  -- owner, editor, viewer
  PRIMARY KEY (portfolio_id, user_id)
);
CREATE TABLE wealth_portfolios (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'personal',  -- personal, shared, agent_managed
  base_currency TEXT NOT NULL DEFAULT 'EUR',
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE wealth_positions (
  portfolio_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 0,
  avg_cost_basis REAL NOT NULL DEFAULT 0,
  total_invested REAL NOT NULL DEFAULT 0,
  realized_pnl REAL NOT NULL DEFAULT 0, scope TEXT DEFAULT 'wealth',
  PRIMARY KEY (portfolio_id, asset_id)
);
CREATE TABLE wealth_snapshots (
  portfolio_id TEXT NOT NULL,
  date TEXT NOT NULL,  -- YYYY-MM-DD
  total_value REAL NOT NULL,
  currency TEXT NOT NULL, scope TEXT DEFAULT 'wealth',
  PRIMARY KEY (portfolio_id, date)
);
CREATE TABLE wealth_transactions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  portfolio_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  type TEXT NOT NULL,  -- buy, sell, dividend, staking_reward, transfer_in, transfer_out
  quantity REAL NOT NULL DEFAULT 0,
  price_per_unit REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL,
  exchange_rate REAL NOT NULL DEFAULT 1.0,
  fees REAL NOT NULL DEFAULT 0,
  transacted_at TEXT NOT NULL,
  notes TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
, scope TEXT DEFAULT 'wealth');
CREATE TABLE wealth_wallets (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  portfolio_id TEXT NOT NULL,
  chain TEXT NOT NULL,
  address TEXT NOT NULL,
  label TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE wealth_watchlist (
  user_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  target_price_high REAL,
  target_price_low REAL,
  notes TEXT,
  added_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, asset_id)
);

-- ── Indexes (25) ────────────────────────────────────────────────────

CREATE INDEX idx_activity_agent_date
    ON activity_sessions(agent_id, date DESC);
CREATE INDEX idx_activity_date_category
    ON activity_sessions(date, category);
CREATE INDEX idx_activity_started
    ON activity_sessions(started_at);
CREATE INDEX idx_audit_log_agent ON audit_log(agent_id, created_at);
CREATE INDEX idx_audit_log_created ON audit_log(created_at);
CREATE INDEX idx_ce_level_type ON cluster_events(level, event_type);
CREATE INDEX idx_ce_user_level ON cluster_events(user_id, level, created_at);
CREATE INDEX idx_ce_user_version ON cluster_events(user_id, cluster_version);
CREATE INDEX idx_cofire_session_strength
  ON territory_cofire(user_id, cofire_session DESC);
CREATE INDEX idx_cofire_user_territory_a
  ON territory_cofire(user_id, territory_a);
CREATE INDEX idx_cofire_user_territory_b
  ON territory_cofire(user_id, territory_b);
CREATE INDEX idx_cofire_weekly_strength
  ON territory_cofire(user_id, cofire_weekly DESC);
CREATE INDEX idx_ct_contact ON contact_territories(contact_id);
CREATE INDEX idx_ct_territory ON contact_territories(territory_id);
CREATE INDEX idx_ct_user ON contact_territories(user_id);
CREATE INDEX idx_secrets_lookup ON secrets(user_id, scope);
CREATE INDEX idx_themes_lookup ON semantic_themes(user_id, realm_id, semantic_theme_id);
CREATE INDEX idx_themes_realm ON semantic_themes(realm_id);
CREATE INDEX idx_themes_user ON semantic_themes(user_id);
CREATE UNIQUE INDEX idx_wa_symbol_type ON wealth_assets(symbol, type);
CREATE INDEX idx_wpa_user ON wealth_portfolio_access(user_id);
CREATE INDEX idx_wt_asset ON wealth_transactions(asset_id);
CREATE INDEX idx_wt_portfolio ON wealth_transactions(portfolio_id);
CREATE INDEX idx_wt_portfolio_asset ON wealth_transactions(portfolio_id, asset_id);
CREATE INDEX idx_wt_transacted ON wealth_transactions(transacted_at);
CREATE INDEX idx_ww_portfolio ON wealth_wallets(portfolio_id);
