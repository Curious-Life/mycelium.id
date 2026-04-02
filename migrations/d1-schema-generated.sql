-- ============================================================================
-- Cloudflare D1 Schema for Mycelium (complete)
-- AUTO-GENERATED on 2026-03-31 from production database.
-- Regenerate: bash scripts/generate-schema.sh
--
-- Fresh install:
--   npx wrangler d1 execute <db-name> --remote --file=migrations/d1-schema-generated.sql
--
-- Also create via wrangler CLI:
--   npx wrangler vectorize create mycelium-search --dimensions=1024 --metric=cosine
--   npx wrangler vectorize create mycelium-cluster --dimensions=256 --metric=cosine
--   npx wrangler r2 bucket create mycelium-attachments
--   npx wrangler kv namespace create mycelium-kv
-- ============================================================================

-- ── Tables (51) ─────────────────────────────────────────────────────

CREATE TABLE access_grants (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  entity_type TEXT NOT NULL,        -- document/message/attachment
  entity_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  access_level TEXT DEFAULT 'view', -- owner/edit/view
  via_canvas_id TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
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
CREATE TABLE agent_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  type TEXT NOT NULL,
  agent_id TEXT,
  trace_id TEXT,
  payload TEXT,                     -- JSON object
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
, scope TEXT DEFAULT 'org');
CREATE TABLE agent_tasks (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  agent_id TEXT NOT NULL,
  type TEXT,
  description TEXT,
  context TEXT,                     -- JSON object
  status TEXT DEFAULT 'pending',    -- pending/in_progress/completed/failed
  priority TEXT DEFAULT 'normal',   -- low/normal/high/urgent
  requested_by TEXT,
  channel_id TEXT,
  result TEXT,                      -- JSON object
  summary TEXT,
  error TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at TEXT,
  completed_at TEXT,
  reported_at TEXT
, scope TEXT DEFAULT 'org');
CREATE TABLE attachments (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT,
  message_id TEXT,
  r2_key TEXT,
  stream_uid TEXT,
  file_name TEXT,
  file_type TEXT,
  file_size INTEGER,
  transcript TEXT,
  description TEXT,
  metadata TEXT,                    -- JSON object
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
, scope TEXT DEFAULT 'org');
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
CREATE TABLE batch_jobs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  job_type TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  params TEXT,                      -- JSON object
  result TEXT,                      -- JSON object
  error TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at TEXT,
  completed_at TEXT
);
CREATE TABLE canvas_collaborators (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL REFERENCES canvas_workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  access_level TEXT DEFAULT 'view', -- owner/edit/view
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE canvas_edges (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL REFERENCES canvas_workspaces(id) ON DELETE CASCADE,
  source_node_id TEXT NOT NULL REFERENCES canvas_nodes(id) ON DELETE CASCADE,
  target_node_id TEXT NOT NULL REFERENCES canvas_nodes(id) ON DELETE CASCADE,
  edge_type TEXT,
  metadata TEXT,                    -- JSON object
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE canvas_nodes (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL REFERENCES canvas_workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  node_type TEXT NOT NULL,          -- document, message, territory, etc.
  ref_id TEXT,
  position_x REAL DEFAULT 0,
  position_y REAL DEFAULT 0,
  width REAL DEFAULT 300,
  height REAL DEFAULT 200,
  metadata TEXT,                    -- JSON object
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE canvas_workspaces (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  layout TEXT DEFAULT 'freeform',
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
CREATE TABLE clustering_points (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  content TEXT,
  atom_id INTEGER,
  territory_id INTEGER,
  theme_id INTEGER,
  realm_id INTEGER,
  is_liminal INTEGER DEFAULT 0,
  landscape_x REAL,
  landscape_y REAL,
  landscape_z REAL,
  landscape_x_2d REAL,
  landscape_y_2d REAL,
  cluster_version TEXT,
  embedding_model TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
, scope TEXT DEFAULT 'org', nomic_embedding BLOB);
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
CREATE TABLE cycle_metrics (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  cycle_type TEXT,
  started_at TEXT,
  completed_at TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost_cents REAL DEFAULT 0,
  items_created TEXT,               -- JSON object
  items_pruned INTEGER DEFAULT 0,
  exploration_calls_used INTEGER DEFAULT 0,
  exploration_budget INTEGER DEFAULT 0,
  quality_score REAL,
  status TEXT,
  error_message TEXT,
  metadata TEXT,                    -- JSON object
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE document_versions (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),document_id TEXT NOT NULL,diff TEXT,changed_by TEXT,change_summary TEXT,created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),FOREIGN KEY (document_id) REFERENCES documents(id));
CREATE TABLE documents (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  path TEXT NOT NULL,
  title TEXT,
  content TEXT,
  summary TEXT,
  is_internal INTEGER DEFAULT 0,
  is_pinned INTEGER DEFAULT 0,
  tags TEXT,                        -- JSON array
  entities TEXT,                    -- JSON object
  relations TEXT,                   -- JSON array
  entity_summary TEXT,
  source_type TEXT,
  source_path TEXT,
  content_hash TEXT,
  folder_id TEXT,
  metadata TEXT,                    -- JSON object
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), scope TEXT DEFAULT 'org', created_by TEXT,
  UNIQUE(user_id, path)
);
CREATE TABLE folders (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  document_count INTEGER DEFAULT 0,
  parent_id TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE import_jobs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  total_items INTEGER DEFAULT 0,
  processed_items INTEGER DEFAULT 0,
  error TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT
);
CREATE TABLE internal_model_items (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  section TEXT NOT NULL,            -- hypotheses/questions/observations/contradictions/patterns/dream_fragments
  content TEXT,
  reinforcement_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',     -- active/promoted/archived/resolved
  source_cycle_id TEXT,
  metadata TEXT,                    -- JSON object
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_reinforced_at TEXT
);
CREATE TABLE messages ( id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), user_id TEXT, role TEXT NOT NULL DEFAULT 'user', content TEXT, message_type TEXT DEFAULT 'chat', tags TEXT, suggested_new_tag TEXT, attachment_id TEXT, folder_id TEXT, metadata TEXT, source TEXT, agent_id TEXT DEFAULT 'mya-personal', entities TEXT, relations TEXT, entity_summary TEXT, nlp_processed INTEGER DEFAULT 0, nlp_processed_at TEXT, nlp_error TEXT, thinking TEXT, thinking_enabled INTEGER DEFAULT 0, thinking_tokens INTEGER DEFAULT 0, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) , scope TEXT DEFAULT 'org', contact_id TEXT, conversation_id TEXT);
CREATE TABLE note_links (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  source_type TEXT NOT NULL,        -- document/message
  source_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  link_text TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE oauth_states (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  state TEXT NOT NULL UNIQUE,
  redirect_url TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE passkey_credentials (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL REFERENCES users(id),
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE people (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  aliases TEXT,                     -- JSON array
  description TEXT,
  metadata TEXT,                    -- JSON object
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
, scope TEXT DEFAULT 'personal', source TEXT DEFAULT 'manual', linkedin_url TEXT, email TEXT, phone TEXT, company TEXT, position TEXT, connected_at TEXT, last_interaction_at TEXT, interaction_count INTEGER DEFAULT 0, status TEXT DEFAULT 'active', outbound_count INTEGER DEFAULT 0);
CREATE TABLE realm_neighbors (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  realm_id INTEGER NOT NULL,
  neighbor_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  connection_type TEXT,
  connection_strength REAL,
  shared_territory_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE realms (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  realm_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT,
  essence TEXT,
  archetype_type TEXT,
  archetype_character TEXT,
  territory_count INTEGER DEFAULT 0,
  message_count INTEGER DEFAULT 0,
  territory_ids TEXT,               -- JSON array
  top_entities TEXT,                -- JSON array
  signature_patterns TEXT,          -- JSON array
  story_birth TEXT,
  story_arc TEXT,
  story_peak_moments TEXT,
  story_current_chapter TEXT,
  uncertainty_open_questions TEXT,   -- JSON array
  uncertainty_edges TEXT,
  neighbors TEXT,                   -- JSON array
  agent_expertise TEXT,
  agent_curious_about TEXT,
  agent_can_help_with TEXT,         -- JSON array
  centroid_256 TEXT,                 -- JSON array (256D Nomic vector, stored as JSON)
  raw_response TEXT,
  generated_at TEXT,
  generation_model TEXT,
  generation_version TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), activity_timeline TEXT,
  UNIQUE(user_id, realm_id)
);
CREATE TABLE reflections (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  agent_id TEXT,
  content TEXT,
  trigger TEXT,
  metadata TEXT,                    -- JSON object
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE registration_tokens (
  code TEXT PRIMARY KEY,
  created_by TEXT REFERENCES users(id),
  used_by TEXT REFERENCES users(id),
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE scheduled_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  schedule TEXT,                    -- cron expression or time spec
  enabled INTEGER DEFAULT 1,
  last_run TEXT,
  metadata TEXT,                    -- JSON object
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  state TEXT,                       -- JSON object (merged session_state)
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE share_links (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  entity_type TEXT NOT NULL,        -- document/canvas/message
  entity_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  access_level TEXT DEFAULT 'view',
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'pending',
  priority TEXT DEFAULT 'normal',
  due_date TEXT,
  metadata TEXT,                    -- JSON object
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT
);
CREATE TABLE territory_cofire (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  territory_a INTEGER NOT NULL,
  territory_b INTEGER NOT NULL,
  cofire_immediate REAL DEFAULT 0,  -- half-life 1h
  cofire_session REAL DEFAULT 0,    -- half-life 4h
  cofire_daily REAL DEFAULT 0,      -- half-life 24h
  cofire_weekly REAL DEFAULT 0,     -- half-life 7d
  last_cofire_at TEXT,
  last_computed TEXT,
  UNIQUE(user_id, territory_a, territory_b),
  CHECK(territory_a < territory_b)
);
CREATE TABLE territory_neighbors (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  territory_id INTEGER NOT NULL,
  neighbor_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  connection_type TEXT,
  distance REAL,
  overlap_start TEXT,
  overlap_end TEXT,
  shared_entities TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE territory_profiles (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  territory_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  realm_id INTEGER,
  semantic_theme_id INTEGER,
  name TEXT,
  essence TEXT,
  archetype_type TEXT,
  archetype_character TEXT,
  message_count INTEGER DEFAULT 0,
  atom_count INTEGER DEFAULT 0,
  explored_count INTEGER DEFAULT 0,
  explored_percent REAL DEFAULT 0,
  top_entities TEXT,                -- JSON array
  signature_patterns TEXT,          -- JSON array
  story_birth TEXT,
  story_arc TEXT,
  story_peak_moments TEXT,
  story_current_chapter TEXT,
  uncertainty_open_questions TEXT,   -- JSON array
  uncertainty_edges TEXT,
  agent_expertise TEXT,
  agent_curious_about TEXT,
  agent_can_help_with TEXT,         -- JSON array
  agent_would_consult TEXT,         -- JSON array
  centroid_256 TEXT,                 -- JSON array (256D Nomic vector)
  raw_response TEXT,
  generated_at TEXT,
  generation_model TEXT,
  generation_version TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), steward_agent_id TEXT, growth_state TEXT, energy REAL, vitality REAL, velocity REAL, point_delta INTEGER, description_version TEXT, point_count_at_description INTEGER, moments_of_interest TEXT, last_described_at TEXT, activity_timeline TEXT, centroid_3d TEXT, chronicle_cursor TEXT DEFAULT NULL, chronicle TEXT DEFAULT NULL, chronicle_model TEXT DEFAULT NULL,
  UNIQUE(user_id, territory_id)
);
CREATE TABLE theme_cards (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  theme_id INTEGER,
  territory_id INTEGER,
  user_id TEXT NOT NULL,
  title TEXT,
  essence TEXT,
  message_count INTEGER DEFAULT 0,
  explored_count INTEGER DEFAULT 0,
  explored_percent REAL DEFAULT 0,
  sample_message_ids TEXT,          -- JSON array
  top_entities TEXT,                -- JSON array
  story_birth TEXT,
  story_arc TEXT,
  story_peak_moments TEXT,
  story_current_chapter TEXT,
  uncertainty_open_questions TEXT,   -- JSON array
  uncertainty_edges TEXT,
  raw_response TEXT,
  generated_at TEXT,
  generation_model TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE user_identities (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,           -- discord/telegram/github
  provider_id TEXT NOT NULL,
  provider_username TEXT,
  provider_avatar TEXT,
  verified_at TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(user_id, provider),
  UNIQUE(provider, provider_id)
);
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  timezone TEXT DEFAULT 'UTC',
  settings TEXT,                    -- JSON object
  budget_limit REAL,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE waitlist (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), email TEXT NOT NULL UNIQUE, source TEXT DEFAULT 'landing', created_at TEXT DEFAULT (datetime('now')));
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

-- ── Indexes (94) ────────────────────────────────────────────────────

CREATE INDEX idx_access_grants_entity ON access_grants(entity_type, entity_id);
CREATE INDEX idx_access_grants_user ON access_grants(user_id);
CREATE INDEX idx_activity_agent_date
    ON activity_sessions(agent_id, date DESC);
CREATE INDEX idx_activity_date_category
    ON activity_sessions(date, category);
CREATE INDEX idx_activity_started
    ON activity_sessions(started_at);
CREATE INDEX idx_agent_events_agent ON agent_events(agent_id);
CREATE INDEX idx_agent_events_created ON agent_events(created_at);
CREATE INDEX idx_agent_events_type ON agent_events(type);
CREATE INDEX idx_agent_tasks_agent ON agent_tasks(agent_id);
CREATE INDEX idx_agent_tasks_pending ON agent_tasks(agent_id, status, priority);
CREATE INDEX idx_agent_tasks_status ON agent_tasks(agent_id, status);
CREATE INDEX idx_attachments_message ON attachments(message_id);
CREATE INDEX idx_attachments_user ON attachments(user_id);
CREATE INDEX idx_audit_log_agent ON audit_log(agent_id, created_at);
CREATE INDEX idx_audit_log_created ON audit_log(created_at);
CREATE INDEX idx_batch_jobs_status ON batch_jobs(status);
CREATE INDEX idx_batch_jobs_user ON batch_jobs(user_id);
CREATE INDEX idx_canvas_edges_ws ON canvas_edges(workspace_id);
CREATE INDEX idx_canvas_nodes_ws ON canvas_nodes(workspace_id);
CREATE INDEX idx_canvas_ws_user ON canvas_workspaces(user_id);
CREATE INDEX idx_ce_level_type ON cluster_events(level, event_type);
CREATE INDEX idx_ce_user_level ON cluster_events(user_id, level, created_at);
CREATE INDEX idx_ce_user_version ON cluster_events(user_id, cluster_version);
CREATE INDEX idx_clustering_realm ON clustering_points(realm_id);
CREATE INDEX idx_clustering_source ON clustering_points(source_type, source_id);
CREATE INDEX idx_clustering_territory ON clustering_points(territory_id);
CREATE INDEX idx_clustering_theme ON clustering_points(theme_id);
CREATE INDEX idx_clustering_user ON clustering_points(user_id);
CREATE INDEX idx_cofire_a ON territory_cofire(territory_a);
CREATE INDEX idx_cofire_b ON territory_cofire(territory_b);
CREATE INDEX idx_cofire_session ON territory_cofire(cofire_session);
CREATE INDEX idx_cofire_user ON territory_cofire(user_id);
CREATE INDEX idx_ct_contact ON contact_territories(contact_id);
CREATE INDEX idx_ct_territory ON contact_territories(territory_id);
CREATE INDEX idx_ct_user ON contact_territories(user_id);
CREATE INDEX idx_cycle_metrics_user ON cycle_metrics(user_id);
CREATE INDEX idx_doc_versions_doc ON document_versions(document_id);
CREATE INDEX idx_documents_created_by ON documents(user_id, created_by);
CREATE INDEX idx_documents_path ON documents(user_id, path);
CREATE INDEX idx_documents_scope ON documents(scope);
CREATE INDEX idx_documents_scope_created ON documents(scope, updated_at);
CREATE INDEX idx_documents_unencrypted
  ON documents(id) WHERE content IS NOT NULL AND content != '' AND content NOT LIKE 'eyJ%';
CREATE INDEX idx_documents_user_id ON documents(user_id);
CREATE INDEX idx_folders_user ON folders(user_id);
CREATE INDEX idx_identities_provider ON user_identities(provider, provider_id);
CREATE INDEX idx_identities_user ON user_identities(user_id);
CREATE INDEX idx_import_jobs_user ON import_jobs(user_id);
CREATE INDEX idx_internal_model_section ON internal_model_items(user_id, section);
CREATE INDEX idx_internal_model_user ON internal_model_items(user_id);
CREATE INDEX idx_messages_agent_id ON messages(agent_id);
CREATE INDEX idx_messages_contact ON messages(contact_id);
CREATE INDEX idx_messages_conversation ON messages(conversation_id);
CREATE INDEX idx_messages_created_at ON messages(created_at);
CREATE INDEX idx_messages_scope ON messages(scope);
CREATE INDEX idx_messages_scope_created ON messages(scope, created_at);
CREATE INDEX idx_messages_source ON messages(source);
CREATE INDEX idx_messages_unencrypted
  ON messages(id) WHERE content IS NOT NULL AND content != '' AND content NOT LIKE 'eyJ%';
CREATE INDEX idx_messages_user_agent ON messages(user_id, agent_id);
CREATE INDEX idx_messages_user_id ON messages(user_id);
CREATE INDEX idx_note_links_source ON note_links(source_type, source_id);
CREATE INDEX idx_note_links_target ON note_links(target_type, target_id);
CREATE INDEX idx_oauth_states_state ON oauth_states(state);
CREATE INDEX idx_passkeys_user ON passkey_credentials(user_id);
CREATE INDEX idx_people_linkedin ON people(linkedin_url);
CREATE INDEX idx_people_status ON people(user_id, status);
CREATE INDEX idx_people_user ON people(user_id);
CREATE UNIQUE INDEX idx_people_user_name ON people(user_id, name);
CREATE INDEX idx_realm_neighbors_user ON realm_neighbors(user_id);
CREATE INDEX idx_realms_user ON realms(user_id);
CREATE INDEX idx_reflections_user ON reflections(user_id);
CREATE INDEX idx_scheduled_events_user ON scheduled_events(user_id);
CREATE INDEX idx_secrets_lookup ON secrets(user_id, scope);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_share_links_token ON share_links(token);
CREATE INDEX idx_tasks_status ON tasks(user_id, status);
CREATE INDEX idx_tasks_user ON tasks(user_id);
CREATE INDEX idx_territory_neighbors_tid ON territory_neighbors(territory_id);
CREATE INDEX idx_territory_neighbors_user ON territory_neighbors(user_id);
CREATE INDEX idx_territory_profiles_realm ON territory_profiles(realm_id);
CREATE INDEX idx_territory_profiles_theme ON territory_profiles(semantic_theme_id);
CREATE INDEX idx_territory_profiles_user ON territory_profiles(user_id);
CREATE INDEX idx_theme_cards_theme ON theme_cards(theme_id);
CREATE INDEX idx_theme_cards_user ON theme_cards(user_id);
CREATE INDEX idx_themes_lookup ON semantic_themes(user_id, realm_id, semantic_theme_id);
CREATE INDEX idx_themes_realm ON semantic_themes(realm_id);
CREATE INDEX idx_themes_user ON semantic_themes(user_id);
CREATE INDEX idx_tp_description_version ON territory_profiles(description_version);
CREATE INDEX idx_tp_steward ON territory_profiles(steward_agent_id);
CREATE UNIQUE INDEX idx_wa_symbol_type ON wealth_assets(symbol, type);
CREATE INDEX idx_wpa_user ON wealth_portfolio_access(user_id);
CREATE INDEX idx_wt_asset ON wealth_transactions(asset_id);
CREATE INDEX idx_wt_portfolio ON wealth_transactions(portfolio_id);
CREATE INDEX idx_wt_portfolio_asset ON wealth_transactions(portfolio_id, asset_id);
CREATE INDEX idx_wt_transacted ON wealth_transactions(transacted_at);
CREATE INDEX idx_ww_portfolio ON wealth_wallets(portfolio_id);

-- ── Triggers ────────────────────────────────────────────────────────────

CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN INSERT INTO documents_fts(documents_fts, rowid, title, content, summary) VALUES ('delete', OLD.rowid, OLD.title, OLD.content, OLD.summary); END;
CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN INSERT INTO documents_fts(rowid, title, content, summary) VALUES (NEW.rowid, NEW.title, NEW.content, NEW.summary); END;
CREATE TRIGGER documents_au AFTER UPDATE ON documents BEGIN INSERT INTO documents_fts(documents_fts, rowid, title, content, summary) VALUES ('delete', OLD.rowid, OLD.title, OLD.content, OLD.summary); INSERT INTO documents_fts(rowid, title, content, summary) VALUES (NEW.rowid, NEW.title, NEW.content, NEW.summary); END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN INSERT INTO messages_fts(messages_fts, rowid, content, entity_summary) VALUES ('delete', OLD.rowid, OLD.content, OLD.entity_summary); END;
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid, content, entity_summary) VALUES (NEW.rowid, NEW.content, NEW.entity_summary); END;
CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN INSERT INTO messages_fts(messages_fts, rowid, content, entity_summary) VALUES ('delete', OLD.rowid, OLD.content, OLD.entity_summary); INSERT INTO messages_fts(rowid, content, entity_summary) VALUES (NEW.rowid, NEW.content, NEW.entity_summary); END;

-- ── Virtual Tables (FTS5) ─────────────────────────────────────────────

CREATE VIRTUAL TABLE documents_fts USING fts5(title, content, summary, content=documents, content_rowid=rowid);
CREATE VIRTUAL TABLE messages_fts USING fts5(content, entity_summary, content=messages, content_rowid=rowid);
