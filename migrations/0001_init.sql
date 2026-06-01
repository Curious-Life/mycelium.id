-- ============================================================================
-- Cloudflare D1 Schema for Mycelium (complete)
-- AUTO-GENERATED on 2026-05-13 from production database.
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

-- ── Tables (111) ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS access_grants (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  entity_type TEXT NOT NULL,        -- document/message/attachment
  entity_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  access_level TEXT DEFAULT 'view', -- owner/edit/view
  via_canvas_id TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS activity_daily (
    date TEXT NOT NULL,
    agent_id TEXT DEFAULT 'personal-agent',
    category TEXT,
    total_s REAL NOT NULL DEFAULT 0,
    session_count INTEGER DEFAULT 0,
    productivity_avg REAL DEFAULT 50,
    PRIMARY KEY (date, agent_id, category)
);
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
CREATE TABLE IF NOT EXISTS agent_customizations (
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  display_name TEXT,
  personality TEXT,
  avatar_emoji TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, agent_id)
);
CREATE TABLE IF NOT EXISTS agent_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  type TEXT NOT NULL,
  agent_id TEXT,
  trace_id TEXT,
  payload TEXT,                     -- JSON object
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
, scope TEXT DEFAULT 'org');
CREATE TABLE IF NOT EXISTS agent_tasks (
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
CREATE TABLE IF NOT EXISTS agent_tokens (
  token_hash TEXT PRIMARY KEY,        -- SHA-256 of the token (never store raw tokens)
  agent TEXT NOT NULL,                 -- e.g. "personal-agent"
  name TEXT NOT NULL,                  -- human-readable label
  user_id TEXT NOT NULL,               -- tenant isolation key
  scopes TEXT NOT NULL DEFAULT 'org',  -- comma-separated: "personal,org,wealth"
  created_at TEXT DEFAULT (datetime('now')),
  last_used_at TEXT,
  disabled INTEGER DEFAULT 0
, tenant_id TEXT DEFAULT NULL, parent_token_hash TEXT DEFAULT NULL, extension_name TEXT DEFAULT NULL, allowed_tables TEXT DEFAULT NULL);
CREATE TABLE IF NOT EXISTS ai_provider_assignments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         TEXT NOT NULL,
  agent_id        TEXT NOT NULL,            -- literal | 'scope:<x>' | '*'
  provider_id     INTEGER NOT NULL REFERENCES ai_providers(id),
  desired_state   TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'applied' | 'failed'
  applied_at      TEXT,
  last_error      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ai_provider_assignments_audit (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id             TEXT NOT NULL,
  actor_user_id       TEXT NOT NULL,
  action              TEXT NOT NULL,    -- 'create' | 'update' | 'delete'
  agent_id            TEXT NOT NULL,
  from_provider_id    INTEGER,
  to_provider_id      INTEGER,
  reason              TEXT,
  ts                  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ai_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,            -- 'claude', 'openai', 'custom'
  label TEXT,                        -- user-given name: 'Work Claude', 'Personal GPT'
  auth_type TEXT NOT NULL,           -- 'oauth' (Claude), 'api_key' (OpenAI/custom)
  credentials TEXT,                  -- encrypted JSON envelope (AES-256-GCM)
  config_dir TEXT,                   -- for Claude: filesystem path to config dir
  model_preference TEXT,             -- e.g. 'claude-sonnet-4-5', 'gpt-4o'
  base_url TEXT,                     -- for custom providers: API endpoint
  is_active INTEGER DEFAULT 0,      -- which one is currently used per provider type
  status TEXT DEFAULT 'pending',     -- 'active', 'pending', 'expired', 'error'
  last_used_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS attachments (
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
CREATE TABLE IF NOT EXISTS "audit_log" (
  id TEXT PRIMARY KEY,
  event_type TEXT,
  agent_id TEXT,
  user_id TEXT,
  ip_address TEXT,
  endpoint TEXT,
  method TEXT,
  scope TEXT,
  table_name TEXT,
  record_count INTEGER,
  success INTEGER DEFAULT 1,
  error TEXT,
  details TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS background_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,                    -- 'mycelium_generate', etc.
  status TEXT NOT NULL DEFAULT 'running', -- 'running' | 'done' | 'error' | 'abandoned'
  step INTEGER DEFAULT 0,
  total_steps INTEGER DEFAULT 0,
  stage_label TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  error TEXT,
  pid INTEGER,
  last_heartbeat TEXT,                   -- updated periodically while job runs
  UNIQUE(user_id, kind, id)
);
CREATE TABLE IF NOT EXISTS batch_jobs (
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
CREATE TABLE IF NOT EXISTS canvas_collaborators (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL REFERENCES canvas_workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  access_level TEXT DEFAULT 'view', -- owner/edit/view
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS canvas_edges (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL REFERENCES canvas_workspaces(id) ON DELETE CASCADE,
  source_node_id TEXT NOT NULL REFERENCES canvas_nodes(id) ON DELETE CASCADE,
  target_node_id TEXT NOT NULL REFERENCES canvas_nodes(id) ON DELETE CASCADE,
  edge_type TEXT,
  metadata TEXT,                    -- JSON object
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS canvas_nodes (
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
CREATE TABLE IF NOT EXISTS canvas_workspaces (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  layout TEXT DEFAULT 'freeform',
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS cascade_state (
  key             TEXT PRIMARY KEY,         -- 'claude-reconciler'
  status          TEXT NOT NULL,            -- 'idle' | 'applying'
  attempt         INTEGER NOT NULL DEFAULT 0,
  started_at      TEXT,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS cluster_events (
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
CREATE TABLE IF NOT EXISTS clustering_points (
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
CREATE TABLE IF NOT EXISTS cognitive_metrics_harmonic (
  -- Grain (PRIMARY KEY; per spec §9 I4)
  user_id            TEXT NOT NULL,
  window_end         TEXT NOT NULL,    -- ISO 8601 UTC
  granularity        TEXT NOT NULL,    -- 'alpha' | 'theta' | 'delta' (window grain)
  language           TEXT NOT NULL DEFAULT 'en',
  clustering_run_id  TEXT NOT NULL,    -- era-${cluster.last_success_at} or era-bootstrap-YYYY-MM-DD

  -- §4.23 information_harmonic_amplitude (5 bands × K=3 orders = 15 cols)
  -- A_k = √(β₁,k² + β₂,k²) from OLS on Fourier basis (Tsipidi 2025).
  harmonic_amplitude_gamma_k1 REAL,
  harmonic_amplitude_gamma_k2 REAL,
  harmonic_amplitude_gamma_k3 REAL,
  harmonic_amplitude_beta_k1  REAL,
  harmonic_amplitude_beta_k2  REAL,
  harmonic_amplitude_beta_k3  REAL,
  harmonic_amplitude_alpha_k1 REAL,
  harmonic_amplitude_alpha_k2 REAL,
  harmonic_amplitude_alpha_k3 REAL,
  harmonic_amplitude_theta_k1 REAL,
  harmonic_amplitude_theta_k2 REAL,
  harmonic_amplitude_theta_k3 REAL,
  harmonic_amplitude_delta_k1 REAL,
  harmonic_amplitude_delta_k2 REAL,
  harmonic_amplitude_delta_k3 REAL,

  -- §4.23 baselines (rolling_90d per Q5; one column per metric column = 15)
  harmonic_amplitude_gamma_k1_baseline_90d REAL,
  harmonic_amplitude_gamma_k2_baseline_90d REAL,
  harmonic_amplitude_gamma_k3_baseline_90d REAL,
  harmonic_amplitude_beta_k1_baseline_90d  REAL,
  harmonic_amplitude_beta_k2_baseline_90d  REAL,
  harmonic_amplitude_beta_k3_baseline_90d  REAL,
  harmonic_amplitude_alpha_k1_baseline_90d REAL,
  harmonic_amplitude_alpha_k2_baseline_90d REAL,
  harmonic_amplitude_alpha_k3_baseline_90d REAL,
  harmonic_amplitude_theta_k1_baseline_90d REAL,
  harmonic_amplitude_theta_k2_baseline_90d REAL,
  harmonic_amplitude_theta_k3_baseline_90d REAL,
  harmonic_amplitude_delta_k1_baseline_90d REAL,
  harmonic_amplitude_delta_k2_baseline_90d REAL,
  harmonic_amplitude_delta_k3_baseline_90d REAL,

  -- §4.24 cross_scale_coupling (PAC, PLV, coherence) — DEFERRED to PR1.5
  -- per design v3 Pivot E. Will land via ALTER TABLE migration when the
  -- alignment-strategy + validation study completes.

  -- §4.33 bigram_flow_features (5 features × 5 bands = 25 cols)
  -- mean_crossing_rate, slope_sign_change_rate, autocorrelation_lag1,
  -- variance, total_spectral_energy — per Palominos et al. 2024.
  mean_crossing_rate_gamma REAL, mean_crossing_rate_beta REAL, mean_crossing_rate_alpha REAL,
  mean_crossing_rate_theta REAL, mean_crossing_rate_delta REAL,
  slope_sign_change_rate_gamma REAL, slope_sign_change_rate_beta REAL, slope_sign_change_rate_alpha REAL,
  slope_sign_change_rate_theta REAL, slope_sign_change_rate_delta REAL,
  autocorrelation_lag1_gamma REAL, autocorrelation_lag1_beta REAL, autocorrelation_lag1_alpha REAL,
  autocorrelation_lag1_theta REAL, autocorrelation_lag1_delta REAL,
  variance_gamma REAL, variance_beta REAL, variance_alpha REAL,
  variance_theta REAL, variance_delta REAL,
  total_spectral_energy_gamma REAL, total_spectral_energy_beta REAL, total_spectral_energy_alpha REAL,
  total_spectral_energy_theta REAL, total_spectral_energy_delta REAL,

  -- §4.33 baselines (25 cols)
  mean_crossing_rate_gamma_baseline_90d REAL, mean_crossing_rate_beta_baseline_90d REAL,
  mean_crossing_rate_alpha_baseline_90d REAL, mean_crossing_rate_theta_baseline_90d REAL,
  mean_crossing_rate_delta_baseline_90d REAL,
  slope_sign_change_rate_gamma_baseline_90d REAL, slope_sign_change_rate_beta_baseline_90d REAL,
  slope_sign_change_rate_alpha_baseline_90d REAL, slope_sign_change_rate_theta_baseline_90d REAL,
  slope_sign_change_rate_delta_baseline_90d REAL,
  autocorrelation_lag1_gamma_baseline_90d REAL, autocorrelation_lag1_beta_baseline_90d REAL,
  autocorrelation_lag1_alpha_baseline_90d REAL, autocorrelation_lag1_theta_baseline_90d REAL,
  autocorrelation_lag1_delta_baseline_90d REAL,
  variance_gamma_baseline_90d REAL, variance_beta_baseline_90d REAL,
  variance_alpha_baseline_90d REAL, variance_theta_baseline_90d REAL,
  variance_delta_baseline_90d REAL,
  total_spectral_energy_gamma_baseline_90d REAL, total_spectral_energy_beta_baseline_90d REAL,
  total_spectral_energy_alpha_baseline_90d REAL, total_spectral_energy_theta_baseline_90d REAL,
  total_spectral_energy_delta_baseline_90d REAL,

  -- §4.34 topology_persistence_entropy (1 col + 1 baseline; H0 ONLY in PR1)
  -- H0 via scipy single-linkage as Vietoris-Rips. H1 deferred per PR0.2
  -- design Pivot A (gudhi has no Linux ARM64 wheel; ripser cascade-risk).
  -- COMPUTED on 256D matryoshka projection (NOT raw 768D) per design v3
  -- Pivot F. NULL when window has < N_MIN_VR=20 messages with embeddings
  -- (sub-threshold: persistence diagram is noise rather than signal).
  topology_h0_persistence_entropy             REAL,
  topology_h0_persistence_entropy_baseline_90d REAL,

  -- Per-window honesty fields (per spec §9 I7 + §4.23 line 494)
  message_count    INTEGER NOT NULL DEFAULT 0,
  low_confidence   INTEGER NOT NULL DEFAULT 1,  -- 1 (true) by default until Phase 6.2 calibrates
  notes            TEXT,                         -- e.g., "non-English language; awaiting validation"

  -- Bookkeeping
  computed_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  PRIMARY KEY (user_id, window_end, granularity, language, clustering_run_id)
);
CREATE TABLE IF NOT EXISTS cognitive_metrics_per_territory (
  user_id      TEXT NOT NULL,
  territory_id INTEGER NOT NULL,
  window_end   TEXT NOT NULL,
  language     TEXT NOT NULL DEFAULT 'en',
  era_id       TEXT NOT NULL,

  -- Territory-recurrence (§4.X)
  recurrence_interval              REAL,        -- days between activations
  recurrence_interval_baseline_90d REAL,

  -- Reserved for PR 5.5: per-territory cofire (§4.15–17)
  -- new_edge_rate REAL,
  -- edge_delta    REAL,
  -- edge_half_life REAL,

  -- Per-row honesty
  message_count  INTEGER NOT NULL DEFAULT 0,
  low_confidence INTEGER NOT NULL DEFAULT 1,
  notes          TEXT,
  computed_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  PRIMARY KEY (user_id, territory_id, window_end, language, era_id)
);
CREATE TABLE IF NOT EXISTS cognitive_metrics_trajectory (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id      TEXT NOT NULL,
  level        TEXT NOT NULL,                  -- 'realm' | 'theme' | 'territory'
  window_type  TEXT NOT NULL,                  -- 'daily' | 'weekly_rolling' | 'weekly_step' | 'monthly'
  window_start TEXT NOT NULL,
  window_end   TEXT NOT NULL,
  era_id       TEXT NOT NULL,                  -- canonical (renamed from clustering_run_id)

  -- Activation distribution (Fisher's input)
  activation_vector TEXT NOT NULL,              -- JSON {id: proportion, ...}

  -- Fisher information-geometry per-step metrics
  velocity              REAL,                   -- ds / Δt (geodesic / days)
  velocity_z            REAL,                   -- z-score vs. pooled-null model; NULL when low_confidence
  displacement          REAL,                   -- D from era anchor
  path_length           REAL,                   -- cumulative L; forward-filled on low-confidence
  R_recent              REAL,                   -- rolling K windows, K=ceil(T/stride), T=90d
  exploration_ratio     REAL,                   -- D/L legacy signal — DISTINCT from R_recent per sweep 2
  phase                 TEXT,                   -- 'stable' | 'cycling' | 'exploring' | 'transforming'
  phase_recent          TEXT,                   -- classifier on (R_recent, path_length_K)
  activation_entropy    REAL,                   -- Shannon, normalized [0,1]
  displacement_lifetime REAL,                   -- D from FIRST window in user history (bounded by π)

  -- Level-grain complexity (replaces complexity_snapshots for level rows)
  lz_complexity   REAL,                         -- LZ76 normalized [0,1]
  raw_complexity  REAL,                         -- raw LZ count
  sequence_length INTEGER,                      -- count of points fed to LZ
  alphabet_size   INTEGER,                      -- distinct symbols in the sequence

  -- Top movers
  top_contributors TEXT,                        -- JSON [{id, contribution_sq, pct, direction: '+'/'-'}]

  -- Metadata
  message_count           INTEGER NOT NULL DEFAULT 0,
  active_territory_count  INTEGER NOT NULL DEFAULT 0,
  low_confidence          INTEGER NOT NULL DEFAULT 0,
  scope                   TEXT NOT NULL DEFAULT 'org',
  computed_at             TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  UNIQUE(user_id, level, window_type, window_start, era_id)
);
CREATE TABLE IF NOT EXISTS cognitive_metrics_window (
  -- Grain (PK)
  user_id      TEXT NOT NULL,
  window_end   TEXT NOT NULL,                  -- ISO 8601 UTC
  granularity  TEXT NOT NULL,                  -- 'alpha' | 'theta' | 'delta'
  language     TEXT NOT NULL DEFAULT 'en',
  era_id       TEXT NOT NULL,                  -- canonical name (renamed from clustering_run_id)

  -- §4.23 information_harmonic_amplitude (5 bands × K=3 orders = 15 cols)
  -- A_k = √(β₁,k² + β₂,k²) from OLS on Fourier basis (Tsipidi 2025).
  harmonic_amplitude_gamma_k1 REAL,
  harmonic_amplitude_gamma_k2 REAL,
  harmonic_amplitude_gamma_k3 REAL,
  harmonic_amplitude_beta_k1  REAL,
  harmonic_amplitude_beta_k2  REAL,
  harmonic_amplitude_beta_k3  REAL,
  harmonic_amplitude_alpha_k1 REAL,
  harmonic_amplitude_alpha_k2 REAL,
  harmonic_amplitude_alpha_k3 REAL,
  harmonic_amplitude_theta_k1 REAL,
  harmonic_amplitude_theta_k2 REAL,
  harmonic_amplitude_theta_k3 REAL,
  harmonic_amplitude_delta_k1 REAL,
  harmonic_amplitude_delta_k2 REAL,
  harmonic_amplitude_delta_k3 REAL,

  -- §4.23 baselines (rolling_90d per Q5; one column per metric column = 15)
  harmonic_amplitude_gamma_k1_baseline_90d REAL,
  harmonic_amplitude_gamma_k2_baseline_90d REAL,
  harmonic_amplitude_gamma_k3_baseline_90d REAL,
  harmonic_amplitude_beta_k1_baseline_90d  REAL,
  harmonic_amplitude_beta_k2_baseline_90d  REAL,
  harmonic_amplitude_beta_k3_baseline_90d  REAL,
  harmonic_amplitude_alpha_k1_baseline_90d REAL,
  harmonic_amplitude_alpha_k2_baseline_90d REAL,
  harmonic_amplitude_alpha_k3_baseline_90d REAL,
  harmonic_amplitude_theta_k1_baseline_90d REAL,
  harmonic_amplitude_theta_k2_baseline_90d REAL,
  harmonic_amplitude_theta_k3_baseline_90d REAL,
  harmonic_amplitude_delta_k1_baseline_90d REAL,
  harmonic_amplitude_delta_k2_baseline_90d REAL,
  harmonic_amplitude_delta_k3_baseline_90d REAL,

  -- §4.33 bigram_flow_features (5 features × 5 bands = 25 cols)
  mean_crossing_rate_gamma REAL, mean_crossing_rate_beta REAL, mean_crossing_rate_alpha REAL,
  mean_crossing_rate_theta REAL, mean_crossing_rate_delta REAL,
  slope_sign_change_rate_gamma REAL, slope_sign_change_rate_beta REAL, slope_sign_change_rate_alpha REAL,
  slope_sign_change_rate_theta REAL, slope_sign_change_rate_delta REAL,
  autocorrelation_lag1_gamma REAL, autocorrelation_lag1_beta REAL, autocorrelation_lag1_alpha REAL,
  autocorrelation_lag1_theta REAL, autocorrelation_lag1_delta REAL,
  variance_gamma REAL, variance_beta REAL, variance_alpha REAL,
  variance_theta REAL, variance_delta REAL,
  total_spectral_energy_gamma REAL, total_spectral_energy_beta REAL, total_spectral_energy_alpha REAL,
  total_spectral_energy_theta REAL, total_spectral_energy_delta REAL,

  -- §4.33 baselines (25 cols)
  mean_crossing_rate_gamma_baseline_90d REAL, mean_crossing_rate_beta_baseline_90d REAL,
  mean_crossing_rate_alpha_baseline_90d REAL, mean_crossing_rate_theta_baseline_90d REAL,
  mean_crossing_rate_delta_baseline_90d REAL,
  slope_sign_change_rate_gamma_baseline_90d REAL, slope_sign_change_rate_beta_baseline_90d REAL,
  slope_sign_change_rate_alpha_baseline_90d REAL, slope_sign_change_rate_theta_baseline_90d REAL,
  slope_sign_change_rate_delta_baseline_90d REAL,
  autocorrelation_lag1_gamma_baseline_90d REAL, autocorrelation_lag1_beta_baseline_90d REAL,
  autocorrelation_lag1_alpha_baseline_90d REAL, autocorrelation_lag1_theta_baseline_90d REAL,
  autocorrelation_lag1_delta_baseline_90d REAL,
  variance_gamma_baseline_90d REAL, variance_beta_baseline_90d REAL,
  variance_alpha_baseline_90d REAL, variance_theta_baseline_90d REAL,
  variance_delta_baseline_90d REAL,
  total_spectral_energy_gamma_baseline_90d REAL, total_spectral_energy_beta_baseline_90d REAL,
  total_spectral_energy_alpha_baseline_90d REAL, total_spectral_energy_theta_baseline_90d REAL,
  total_spectral_energy_delta_baseline_90d REAL,

  -- §4.34 topology_persistence_entropy (1 col + 1 baseline; H0 only in PR1)
  topology_persistence_entropy             REAL,
  topology_persistence_entropy_baseline_90d REAL,

  -- Per-window honesty (per spec §9 I7)
  message_count    INTEGER NOT NULL DEFAULT 0,
  low_confidence   INTEGER NOT NULL DEFAULT 1,  -- 1 by default until Phase 6.2 calibrates
  notes            TEXT,                         -- populated with reason per WSC-FOLLOWUP

  -- Bookkeeping
  computed_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  PRIMARY KEY (user_id, window_end, granularity, language, era_id)
);
CREATE TABLE IF NOT EXISTS complexity_snapshots (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  level TEXT NOT NULL,                    -- 'territory', 'realm', or 'global'
  level_id INTEGER,                       -- territory_id or realm_id (NULL for global)
  level_name TEXT,                        -- territory/realm name at snapshot time
  lz_complexity REAL NOT NULL,            -- normalized LZ complexity [0, 1]
  raw_complexity INTEGER,                 -- raw LZ76 subsequence count
  sequence_length INTEGER,                -- length of input sequence
  alphabet_size INTEGER,                  -- number of distinct symbols
  window_start TEXT,                      -- ISO date — start of measurement window
  window_end TEXT,                        -- ISO date — end of measurement window
  point_count INTEGER,                    -- number of data points in window
  computed_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, level, level_id, window_end)
);
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  user_a TEXT NOT NULL,
  user_b TEXT NOT NULL,
  initiated_by TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  overlap_json TEXT,
  overlap_computed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  accepted_at TEXT, remote_instance TEXT, remote_user_handle TEXT, remote_did TEXT, deep_match_a INTEGER DEFAULT 0, deep_match_b INTEGER DEFAULT 0, deep_overlap_json TEXT, deep_overlap_computed_at TEXT,
  UNIQUE(user_a, user_b)
);
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
CREATE TABLE IF NOT EXISTS context_grants (
  context_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  granted_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (context_id, connection_id),
  FOREIGN KEY (context_id) REFERENCES sharing_contexts(id) ON DELETE CASCADE,
  FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS context_territories (
  context_id TEXT NOT NULL,
  territory_id INTEGER NOT NULL,
  added_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (context_id, territory_id),
  FOREIGN KEY (context_id) REFERENCES sharing_contexts(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS crypto_payments (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  coingate_order_id TEXT NOT NULL,
  plan TEXT NOT NULL,
  amount_eur REAL NOT NULL,
  crypto_amount TEXT,
  crypto_coin TEXT,
  status TEXT DEFAULT 'pending',
  paid_at TEXT,
  credited_months INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS current_arc_chronicles (
  user_id TEXT PRIMARY KEY,
  theme BLOB,
  narrative BLOB,
  phase TEXT,
  last_input_period TEXT,
  generation_model TEXT,
  generated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS cycle_metrics (
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
CREATE TABLE IF NOT EXISTS deployment_log (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  handle TEXT,
  vps_ip TEXT,
  commit_sha TEXT,
  file_hashes TEXT,
  status TEXT,
  error TEXT,
  deployed_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS document_versions (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),document_id TEXT NOT NULL,diff TEXT,changed_by TEXT,change_summary TEXT,created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),FOREIGN KEY (document_id) REFERENCES documents(id));
CREATE TABLE IF NOT EXISTS documents (
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
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), scope TEXT DEFAULT 'org', created_by TEXT, published INTEGER NOT NULL DEFAULT 0, public_slug TEXT, public_visit_count INTEGER NOT NULL DEFAULT 0, embedding_768 TEXT,
  UNIQUE(user_id, path)
);
CREATE TABLE IF NOT EXISTS egress_audit (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                    TEXT NOT NULL DEFAULT (datetime('now')),
  agent_id              TEXT NOT NULL,
  task_id               TEXT,                              -- correlation key when known
  provenance_kind       TEXT NOT NULL,                     -- see kinds list below
  source_module         TEXT NOT NULL,                     -- e.g. 'chat.fallback', 'send-handler', 'agent-egress.notifyArtifactsCreated', 'gmail.send'
  template_id           TEXT,                              -- when provenance_kind='system-template'
  channel_kind          TEXT NOT NULL,                     -- 'telegram' | 'telegram-group' | 'discord' | 'discord-thread' | 'whatsapp' | 'email' | 'other'
  channel_id            TEXT NOT NULL,                     -- platform-native id
  channel_label         TEXT,                              -- human label when registry has one
  inbound_kind          TEXT,                              -- inbound channel kind for this turn (NULL for autonomous)
  inbound_id            TEXT,                              -- inbound channel id for this turn
  cross_channel         INTEGER NOT NULL DEFAULT 0,        -- 1 when channel ≠ inbound
  cross_channel_reason  TEXT,                              -- agent's stated reason if cross_channel=1
  content_hash          TEXT NOT NULL,                     -- sha256 hex of the message body
  content_length        INTEGER NOT NULL,
  decision              TEXT NOT NULL,                     -- 'allowed' | 'denied'
  reason                TEXT,                              -- denial reason or audit code (e.g. 'reply', 'cross-source', 'autonomous-not-allowed')
  delivered             INTEGER,                           -- 0/1 once known; NULL if delivery state not yet observed
  http_status           INTEGER                            -- platform/bot HTTP status when available
);
CREATE TABLE IF NOT EXISTS email_otp_challenges (
  email        TEXT NOT NULL,
  code_hash    TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  expires_at   TEXT NOT NULL,
  consumed_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (email, created_at)
);
CREATE TABLE IF NOT EXISTS federation_keys (
  instance_url TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  key_id TEXT,
  instance_name TEXT,
  protocol_version TEXT DEFAULT '1.0',
  capabilities_json TEXT,
  user_count INTEGER DEFAULT 0,
  last_seen TEXT,
  trust_level INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS federation_log (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL,
  remote_instance TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT DEFAULT 'success',
  details TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS fisher_milestones (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  detected_at TEXT DEFAULT (datetime('now')),

  rule_type TEXT NOT NULL,
    -- 'sustained_cycling' | 'phase_shift' | 'velocity_outlier' | 'displacement_crossing'
  level TEXT NOT NULL DEFAULT 'realm',
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,

  -- Typed context columns (clean queries; rule-specific fields can be NULL).
  phase_from TEXT,                        -- for phase_shift
  phase_to TEXT,                          -- for phase_shift
  velocity_z REAL,                        -- for velocity_outlier
  displacement REAL,                      -- for displacement_crossing

  -- Free-form supplemental context, JSON-encoded.
  detail TEXT,

  -- Pre-rendered headline for the banner UI — server-authoritative copy.
  -- Keeping this server-side means the UI stays generic across rule types.
  headline TEXT NOT NULL,

  -- Lifecycle / delivery
  dismissed_at TEXT,                      -- NULL = active; SET = user dismissed
  notified_via TEXT,                      -- 'banner' | 'banner+telegram' | etc.

  clustering_run_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'org',

  -- Idempotency: same (rule, level, week, run) only ever fires once.
  UNIQUE(user_id, rule_type, level, window_start, clustering_run_id)
);
CREATE TABLE IF NOT EXISTS fisher_trajectory (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  computed_at TEXT DEFAULT (datetime('now')),

  -- Hierarchy and windowing
  level TEXT NOT NULL,                    -- 'realm' | 'theme' | 'territory'
  window_type TEXT NOT NULL,              -- 'daily' | 'weekly_rolling' | 'weekly_step' | 'monthly'
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,

  -- The activation distribution itself, JSON-encoded {id: proportion, ...}
  activation_vector TEXT NOT NULL,

  -- Per-step metrics (vs. previous window of same type+level)
  fisher_velocity REAL,                   -- ds / Δt (geodesic / days)
  fisher_velocity_z REAL,                 -- z-score vs. pooled-null model; NULL when low_confidence
  fisher_displacement REAL,               -- D from anchor (first window in series)
  fisher_trajectory_length REAL,          -- cumulative L; forward-filled on low-confidence
  exploration_ratio REAL,                 -- D/L; NULL when L < L_stable_threshold
  phase TEXT,                             -- 'stable' | 'cycling' | 'exploring' | 'transforming'
  activation_entropy REAL,                -- Shannon entropy of activation_vector

  -- Top movers, JSON-encoded [{id, contribution_sq, pct, direction: '+'/'-'}]
  top_contributors TEXT,

  -- Metadata
  message_count INTEGER NOT NULL,
  active_territory_count INTEGER NOT NULL, -- count > 0 before Laplace smoothing
  clustering_run_id TEXT NOT NULL,
  low_confidence INTEGER NOT NULL DEFAULT 0,  -- bool; SQLite stores as 0/1
  scope TEXT NOT NULL DEFAULT 'org', R_recent REAL, phase_recent TEXT,          -- routing consistency w/ migration 090

  UNIQUE(user_id, level, window_type, window_start, clustering_run_id)
);
CREATE TABLE IF NOT EXISTS fleet_attest_keys (
  handle TEXT PRIMARY KEY,
  key_hex TEXT NOT NULL,              -- 64 hex chars (32-byte HMAC key)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  rotated_at TEXT,                    -- null until first rotation
  revoked_at TEXT                     -- null unless handle is decommissioned
);
CREATE TABLE IF NOT EXISTS fleet_health_reports (
  id TEXT PRIMARY KEY,
  vps_id TEXT NOT NULL,
  reported_at INTEGER NOT NULL,
  arch_version TEXT,
  mycelium_version TEXT,
  summary TEXT NOT NULL,                  -- JSON: {pass,warn,fail,skip,fatal_fail}
  failures TEXT NOT NULL,                 -- JSON: [{id,severity,message,category}]
  raw_bytes INTEGER,                      -- size of original body (for anomaly detection)
  sig_verified INTEGER NOT NULL DEFAULT 1, guardians_json TEXT,
  FOREIGN KEY (vps_id) REFERENCES fleet_registry(vps_id)
);
CREATE TABLE IF NOT EXISTS fleet_registry (
  vps_id TEXT PRIMARY KEY,                -- stable UUID issued at provisioning
  handle TEXT NOT NULL UNIQUE,            -- e.g. 'admin', 'alice', 'bob' (one row per provisioned tenant)
  provisioned_at INTEGER NOT NULL,
  last_report_at INTEGER,
  last_report_status TEXT,                -- 'pass' | 'warn' | 'fail' | null
  last_fatal_count INTEGER DEFAULT 0,
  last_warn_count INTEGER DEFAULT 0,
  arch_version TEXT,                      -- git short sha of last report
  mycelium_version TEXT,                  -- package.json version of last report
  metadata TEXT                           -- JSON: non-secret ops info (region, plan, etc.)
);
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  document_count INTEGER DEFAULT 0,
  parent_id TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
, agent_id TEXT DEFAULT NULL);
CREATE TABLE IF NOT EXISTS frequency_snapshots (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  granularity TEXT NOT NULL DEFAULT 'week',

  -- 5 core cognitive metrics
  coherence REAL,           -- mean pairwise cosine similarity of territory centroids [0, 1]
  entropy REAL,             -- normalized Shannon entropy of territory distribution [0, 1]
  compression REAL,         -- gzip text compression ratio (TCR) [0.05, 0.60]
  learning_rate REAL,       -- mean JSD² between consecutive window distributions [0, 1]
  gradient_signal REAL,     -- max JSD² from initial window distribution [0, 1]

  -- Context for interpretation
  point_count INTEGER,      -- clustering points in this window
  territory_count INTEGER,  -- distinct territories active in window
  message_count INTEGER,    -- messages in window (for compression)

  computed_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, window_end, granularity)
);
CREATE TABLE IF NOT EXISTS handle_reservations (
  handle TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  reserved_at TEXT DEFAULT (datetime('now'))
);
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
CREATE TABLE IF NOT EXISTS identity_channels (
  -- Composite PK: every (kind, value) pair maps to AT MOST ONE owner.
  -- A single user may hold many channels (multiple emails, telegram + discord,
  -- a passkey AND a mycelium-handle). The unique constraint is on the
  -- channel side, not the user side.
  channel_kind     TEXT NOT NULL,
  channel_value    TEXT NOT NULL,

  -- NULL = verified visitor (proven control of channel, no Mycelium user yet).
  -- Set when a user authenticates with this channel for the first time, or via
  -- explicit linkage from an authenticated session (Phase 7).
  owner_user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,

  -- Optional human-readable label (e.g., Telegram username, email's display
  -- name). Never used for auth decisions.
  display_name     TEXT,

  -- Channel-specific evidence retained for audit. Per-protocol shape:
  --   passkey:        { "credential_id": "...", "counter": 42 }
  --   telegram:       { "auth_date": 1735689600, "signature_hex_digest": "..." }
  --   email-otp:      { "code_hash_digest": "...", "issued_at": "..." }
  --   mycelium-handle:{ "did": "did:plc:...", "challenge_nonce": "..." }
  -- NEVER stores the raw secret — only digests / non-reversible evidence.
  evidence_json    TEXT,

  -- Verification timestamps. verified_at = first proof; last_seen_at = most
  -- recent successful auth. Both update on every successful verify.
  verified_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at     TEXT NOT NULL DEFAULT (datetime('now')),

  -- Three orthogonal capability flags (per IDENTITY-CHANNELS.md §3.8):
  --   auth_enabled     — channel can sign in (default 1)
  --   delivery_enabled — agent may send to this channel (default 0; opt-in)
  --   aka_published    — channel appears in DID doc alsoKnownAs (default 0)
  -- Each is independently togglable. Defaults are conservative: auth-yes,
  -- delivery-no, publish-no.
  auth_enabled     INTEGER NOT NULL DEFAULT 1 CHECK (auth_enabled IN (0, 1)),
  delivery_enabled INTEGER NOT NULL DEFAULT 0 CHECK (delivery_enabled IN (0, 1)),
  aka_published    INTEGER NOT NULL DEFAULT 0 CHECK (aka_published IN (0, 1)),

  -- Soft revocation. Bound channels are NEVER hard-deleted; rows persist for
  -- audit. Revoking sets revoked_at; queries filter on `revoked_at IS NULL`.
  revoked_at       TEXT,

  created_at       TEXT NOT NULL DEFAULT (datetime('now')),

  PRIMARY KEY (channel_kind, channel_value)
);
CREATE TABLE IF NOT EXISTS import_jobs (
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
CREATE TABLE IF NOT EXISTS internal_model_items (
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
CREATE TABLE IF NOT EXISTS messages ( id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), user_id TEXT, role TEXT NOT NULL DEFAULT 'user', content TEXT, message_type TEXT DEFAULT 'chat', tags TEXT, suggested_new_tag TEXT, attachment_id TEXT, folder_id TEXT, metadata TEXT, source TEXT, agent_id TEXT DEFAULT 'mya-personal', entities TEXT, relations TEXT, entity_summary TEXT, nlp_processed INTEGER DEFAULT 0, nlp_processed_at TEXT, nlp_error TEXT, thinking TEXT, thinking_enabled INTEGER DEFAULT 0, thinking_tokens INTEGER DEFAULT 0, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) , scope TEXT DEFAULT 'org', contact_id TEXT, conversation_id TEXT, embedding_768 TEXT);
CREATE TABLE IF NOT EXISTS note_links (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  source_type TEXT NOT NULL,        -- document/message
  source_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  link_text TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS oauth_states (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  state TEXT NOT NULL UNIQUE,
  redirect_url TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS outbound_envelope_dedup (
  envelope_hash TEXT PRIMARY KEY,             -- sha256(platform || target || content_hash || window_id)
  platform TEXT NOT NULL,                     -- PLATFORMS enum value
  agent_id TEXT,                              -- nullable when emit context is process-level
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS passkey_credentials (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL REFERENCES users(id),
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
, prf_salt TEXT, name TEXT DEFAULT NULL, last_used_at TEXT DEFAULT NULL);
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  aliases TEXT,                     -- JSON array
  description TEXT,
  metadata TEXT,                    -- JSON object
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
, scope TEXT DEFAULT 'personal', source TEXT DEFAULT 'manual', linkedin_url TEXT, email TEXT, phone TEXT, company TEXT, position TEXT, connected_at TEXT, last_interaction_at TEXT, interaction_count INTEGER DEFAULT 0, status TEXT DEFAULT 'active', outbound_count INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS pipeline_state (
  user_id TEXT NOT NULL,
  stage_name TEXT NOT NULL,
  last_success_at TEXT,             -- ISO 8601 of the last successful run
  last_failure_at TEXT,             -- ISO 8601 of the last failed run
  last_failure_reason TEXT,         -- short error message from the failure
  consecutive_failures INTEGER DEFAULT 0,
  quarantined INTEGER DEFAULT 0,    -- 1 if consecutive_failures >= 3
  one_shot_complete_at TEXT,        -- for oneShot stages (backfill-frequency, etc.)
  last_duration_ms INTEGER,         -- wall-clock of most recent run
  last_details_json TEXT,           -- free-form JSON the stage's trigger returned
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, stage_name)
);
CREATE TABLE IF NOT EXISTS provisioning_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  key_hash TEXT NOT NULL,           -- SHA-256 of master key (never the key itself)
  status TEXT DEFAULT 'pending',    -- pending | provisioning | ready | failed
  hetzner_server_id TEXT,
  hetzner_server_name TEXT,
  vps_ip TEXT,
  d1_database_name TEXT,
  d1_database_id TEXT,
  agent_tokens_json TEXT,           -- encrypted JSON of generated tokens
  passkey_credential_id TEXT,
  passkey_public_key TEXT,
  error TEXT,
  portal_url TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT
, status_step TEXT, handle TEXT, plan TEXT, stripe_customer_id TEXT, ssh_fail_count INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS public_presence (
  session_id      TEXT PRIMARY KEY,        -- random UUID, set as cookie
  user_id         TEXT NOT NULL,           -- owner of the doc being viewed
  public_slug     TEXT NOT NULL,           -- → documents.public_slug
  last_beat_at    TEXT NOT NULL DEFAULT (datetime('now')),
  first_seen_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS realm_neighbors (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  realm_id INTEGER NOT NULL,
  neighbor_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  connection_type TEXT,
  connection_strength REAL,
  shared_territory_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS realms (
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
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), activity_timeline TEXT, explored_percent REAL DEFAULT 0, temporal_saliency REAL DEFAULT 0, embedding_768 TEXT, describe_input_hash TEXT,
  UNIQUE(user_id, realm_id)
);
CREATE TABLE IF NOT EXISTS reflections (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  agent_id TEXT,
  content TEXT,
  trigger TEXT,
  metadata TEXT,                    -- JSON object
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS registration_tokens (
  code TEXT PRIMARY KEY,
  created_by TEXT REFERENCES users(id),
  used_by TEXT REFERENCES users(id),
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS scheduled_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  schedule TEXT,                    -- cron expression or time spec
  enabled INTEGER DEFAULT 1,
  last_run TEXT,
  metadata TEXT,                    -- JSON object
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS secrets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,              -- e.g. "DISCORD_BOT_TOKEN", "SUPABASE_URL"
  value TEXT NOT NULL,            -- Encrypted envelope (AES-256-GCM)
  scope TEXT NOT NULL DEFAULT 'org',  -- Encryption scope: personal | org | wealth
  user_id TEXT NOT NULL DEFAULT 'system',  -- Tenant isolation
  agent TEXT,                     -- NULL = available to all agents in scope; "personal-agent" = only Mya
  version INTEGER NOT NULL DEFAULT 1,  -- Monotonic version counter (for future rotation history)
  description TEXT,               -- Human-readable note
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')), key_family TEXT NOT NULL DEFAULT 'system',
  UNIQUE(key, user_id, agent)    -- One value per key per tenant per agent
);
CREATE TABLE IF NOT EXISTS "semantic_themes" (
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
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), explored_percent REAL DEFAULT 0, temporal_saliency REAL DEFAULT 0, embedding_768 TEXT, describe_input_hash TEXT,
  UNIQUE(user_id, realm_id, semantic_theme_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  state TEXT,                       -- JSON object (merged session_state)
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
, tenant_id TEXT DEFAULT NULL);
CREATE TABLE IF NOT EXISTS share_links (
  token            TEXT PRIMARY KEY,        -- crypto.randomUUID(), 128 bits entropy
  user_id          TEXT NOT NULL,           -- owner
  document_path    TEXT NOT NULL,           -- → documents.path (in user_id's tenant DB)
  invited_email    TEXT,                    -- ENCRYPTED at rest; null when no recipient named
  expires_at       TEXT NOT NULL,           -- ISO timestamp; default = now + 30d, set by caller
  max_views        INTEGER,                 -- nullable = unlimited
  view_count       INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS shared_spaces (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  settings_json TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  accepted_at TEXT,
  FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS sharing_contexts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  is_private INTEGER DEFAULT 0,
  is_default INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, name)
);
CREATE TABLE IF NOT EXISTS space_access (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  space_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  invited_by TEXT,
  invite_token_hash TEXT,
  invite_expires_at TEXT,
  accepted_at TEXT DEFAULT NULL,
  revoked_at TEXT DEFAULT NULL,
  last_active_at TEXT DEFAULT NULL,
  consent_version INTEGER DEFAULT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(space_id, user_id)
);
CREATE TABLE IF NOT EXISTS space_conversations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  space_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  last_message_at TEXT,
  message_count INTEGER DEFAULT 0,
  takeaway_opt_in INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(space_id, user_id)
);
CREATE TABLE IF NOT EXISTS space_invites (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  space_id TEXT NOT NULL,
  invited_by TEXT NOT NULL,
  invited_email TEXT,
  invited_handle TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  token_hash TEXT NOT NULL UNIQUE,
  max_uses INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS space_knowledge (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  space_id TEXT NOT NULL,
  content TEXT NOT NULL,
  source_user_id TEXT,
  source_territory_id TEXT,
  source_type TEXT NOT NULL DEFAULT 'direct',
  visibility TEXT NOT NULL DEFAULT 'all',
  domain_tags TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  embedded INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  revoked_at TEXT DEFAULT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, source_ref TEXT);
CREATE TABLE IF NOT EXISTS space_knowledge_history (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  entry_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  prior_content TEXT NOT NULL,
  prior_domain_tags TEXT,
  edited_by_user_id TEXT NOT NULL,
  edited_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS "space_room_documents" (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  space_id        TEXT NOT NULL,
  room_id         TEXT,                    -- nullable → space root
  document_path   TEXT NOT NULL,
  position        INTEGER NOT NULL DEFAULT 0,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS space_rooms (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  space_id        TEXT NOT NULL,           -- → users.id (type='space')
  parent_id       TEXT,                    -- → space_rooms.id; null = top-level
  name            TEXT NOT NULL,
  essence         TEXT,                    -- short description, optional
  cover_doc_path  TEXT,                    -- → documents.path; null = auto-render contents
  position        INTEGER NOT NULL DEFAULT 0,
  created_by      TEXT NOT NULL,           -- → users.id (the human who made it)
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS step_up_tokens (
  token        TEXT PRIMARY KEY,         -- crypto.randomUUID(), the bearer credential
  user_id      TEXT NOT NULL,            -- the user the step-up is bound to
  tier         TEXT NOT NULL,            -- 'up' | 'uv' | 'uv_urk'
  op_type      TEXT NOT NULL,            -- e.g. 'matrix.peer.add', 'identity.link'
  op_target    TEXT,                     -- e.g. peer hostname; null for op-only
  challenge    TEXT NOT NULL,            -- the WebAuthn challenge that backed this token
  expires_at   TEXT NOT NULL,            -- ISO 8601; ≤5min (up/uv) or ≤60s (uv_urk)
  consumed_at  TEXT,                     -- one-shot; NULL = unused, set at first use
  created_at   TEXT NOT NULL DEFAULT (datetime('now')), session_token TEXT REFERENCES sessions(token) ON DELETE CASCADE,
  CHECK (tier IN ('up', 'uv', 'uv_urk'))
);
CREATE TABLE IF NOT EXISTS stripe_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  stripe_customer_id TEXT NOT NULL,
  stripe_subscription_id TEXT,            -- NULL for decade/lifetime plans
  plan TEXT NOT NULL,                     -- 'monthly', 'annual', 'decade'
  type TEXT NOT NULL DEFAULT 'recurring', -- 'recurring' or 'lifetime'
  status TEXT NOT NULL DEFAULT 'active',  -- active, past_due, suspended, canceled, lifetime
  current_period_end TEXT,                -- ISO8601, NULL for lifetime
  cancel_at_period_end INTEGER DEFAULT 0,
  payment_failed_at TEXT,
  suspended_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
, payment_method TEXT DEFAULT 'stripe', crypto_coin TEXT, crypto_tx TEXT, paid_through TEXT, coingate_order_id TEXT);
CREATE TABLE IF NOT EXISTS tasks (
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
CREATE TABLE IF NOT EXISTS telegram_groups (id TEXT PRIMARY KEY, title TEXT, space_id TEXT, agent_id TEXT DEFAULT 'personal-agent', authorized_by TEXT NOT NULL, authorized_at TEXT NOT NULL DEFAULT (datetime('now')), active INTEGER DEFAULT 1, settings_json TEXT);
CREATE TABLE IF NOT EXISTS telegram_widget_sessions (
  telegram_id   INTEGER NOT NULL,
  auth_date     INTEGER NOT NULL,
  signature_hex TEXT NOT NULL,
  consumed_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (telegram_id, auth_date)
);
CREATE TABLE IF NOT EXISTS territory_cofire (
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
CREATE TABLE IF NOT EXISTS territory_lineage (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  old_territory_id INTEGER NOT NULL,
  new_territory_id INTEGER NOT NULL,
  message_count INTEGER NOT NULL,
  transfer_strength REAL NOT NULL,
  is_dominant INTEGER DEFAULT 0,
  cluster_version TEXT,
  recorded_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, old_territory_id, new_territory_id, cluster_version)
);
CREATE TABLE IF NOT EXISTS territory_neighbors (
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
CREATE TABLE IF NOT EXISTS territory_pass_notes (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  territory_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  pass_number INTEGER NOT NULL,
  points_seen INTEGER NOT NULL,
  total_at_pass INTEGER NOT NULL,
  cumulative_seen INTEGER NOT NULL,
  cumulative_percent REAL NOT NULL,
  notes TEXT NOT NULL,
  key_entities TEXT,
  new_patterns TEXT,
  time_range TEXT,
  model TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, territory_id, pass_number)
);
CREATE TABLE IF NOT EXISTS territory_profiles (
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
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), steward_agent_id TEXT, growth_state TEXT, energy REAL, coherence REAL, velocity REAL, point_delta INTEGER, description_version TEXT, point_count_at_description INTEGER, moments_of_interest TEXT, last_described_at TEXT, activity_timeline TEXT, centroid_3d TEXT, chronicle_cursor TEXT DEFAULT NULL, chronicle TEXT DEFAULT NULL, chronicle_model TEXT DEFAULT NULL, dissolved_at TEXT, dissolved_version TEXT, visibility TEXT DEFAULT 'private', temporal_saliency REAL DEFAULT 0, first_active TEXT, last_active TEXT, days_active INTEGER DEFAULT 0, is_catchall INTEGER DEFAULT 0, current_vitality REAL DEFAULT 0.5, current_phase TEXT DEFAULT 'gift', is_anchored INTEGER DEFAULT 0, anchored_reason TEXT DEFAULT NULL, predecessor_ids TEXT DEFAULT NULL, evolved_from_count INTEGER DEFAULT 0, embedding_768 TEXT,
  UNIQUE(user_id, territory_id)
);
CREATE TABLE IF NOT EXISTS territory_seen_points (
  territory_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  pass_number INTEGER NOT NULL,
  seen_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, territory_id, source_id)
);
CREATE TABLE IF NOT EXISTS "territory_vitality" (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  territory_id INTEGER NOT NULL,
  computed_at TEXT DEFAULT (datetime('now')),
  entropy_diversification REAL NOT NULL,
  connection_growth_rate REAL NOT NULL,
  reach REAL NOT NULL,
  cofire_partner_diversity REAL NOT NULL,
  vitality REAL NOT NULL,
  phase TEXT NOT NULL,
  clustering_run_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
, engagement_depth_normalized REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS theme_cards (
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
CREATE TABLE IF NOT EXISTS time_chronicles (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,

  granularity TEXT NOT NULL,
  period_key TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  parent_period_key TEXT,

  theme BLOB,
  narrative BLOB,
  key_moments BLOB,
  top_territories BLOB,
  top_contacts BLOB,
  top_agents BLOB,
  cross_references BLOB,
  voice_sample BLOB,
  raw_response BLOB,

  signature TEXT,
  point_count INTEGER DEFAULT 0,
  message_count INTEGER DEFAULT 0,
  territory_count INTEGER DEFAULT 0,
  event_count INTEGER DEFAULT 0,
  metrics_snapshot TEXT,
  voice_fingerprint TEXT,

  dirty INTEGER DEFAULT 0,
  generation_model TEXT,
  generated_at TEXT,
  computed_at TEXT DEFAULT (datetime('now')),

  vector_id TEXT,
  embedded_at TEXT,

  UNIQUE(user_id, granularity, period_key)
);
CREATE TABLE IF NOT EXISTS time_seen_points (
  user_id TEXT NOT NULL,
  granularity TEXT NOT NULL,
  period_key TEXT NOT NULL,
  source_id TEXT NOT NULL,
  seen_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, granularity, period_key, source_id)
);
CREATE TABLE IF NOT EXISTS topology_audit_findings (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  snapshot_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  territory_id INTEGER NOT NULL,
  finding_type TEXT NOT NULL,
  severity TEXT DEFAULT 'info',
  message_count INTEGER,
  connection_count INTEGER,
  connected_realms INTEGER,
  coherence REAL,
  bridge_quality REAL,
  explanation TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS topology_audit_snapshots (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  run_at TEXT DEFAULT (datetime('now')),
  cluster_version TEXT,
  total_territories INTEGER,
  total_connections INTEGER,
  catchall_count INTEGER,
  orphan_count INTEGER,
  bridge_count INTEGER,
  max_degree INTEGER,
  mean_degree REAL,
  degree_gini REAL,
  m2_entropy REAL,
  m2_delta REAL,
  m2_trend TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS topology_metrics (
  user_id      TEXT NOT NULL,
  era_id       TEXT NOT NULL,                  -- replaces cluster_version

  -- Audit metrics (from topology-audit.js, ALL columns preserved)
  m2_entropy        REAL,
  m2_delta          REAL,                       -- MISSING from plan-doc
  m2_trend          TEXT,                       -- MISSING from plan-doc (categorical: 'rising'/'falling'/'flat')
  degree_gini       REAL,
  max_degree        INTEGER,                    -- MISSING from plan-doc
  mean_degree       REAL,                       -- MISSING from plan-doc
  orphan_count      INTEGER,
  bridge_count      INTEGER,
  catchall_count    INTEGER,
  total_territories INTEGER,
  total_connections INTEGER,

  computed_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  PRIMARY KEY (user_id, era_id)
);
CREATE TABLE IF NOT EXISTS user_identities (
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
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id TEXT PRIMARY KEY,
  handle TEXT UNIQUE,
  display_name TEXT,
  signature TEXT,
  depth_score REAL,
  breadth_score REAL,
  coherence_score REAL,
  exploration_score REAL,
  territory_count INTEGER DEFAULT 0,
  realm_count INTEGER DEFAULT 0,
  message_count INTEGER DEFAULT 0,
  member_since TEXT,
  public_realms_json TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
, did TEXT, avatar_url TEXT DEFAULT NULL, last_milestone INTEGER DEFAULT 0, last_selfie_at TEXT, exlibris_url TEXT);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  timezone TEXT DEFAULT 'UTC',
  settings TEXT,                    -- JSON object
  budget_limit REAL,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
, handle TEXT, welcome_shown_at TEXT, onboarding_dismissed_at TEXT, type TEXT NOT NULL DEFAULT 'human', created_by TEXT DEFAULT NULL, avatar_url TEXT DEFAULT NULL, exlibris_url TEXT);
CREATE TABLE IF NOT EXISTS visitor_sessions (
  token            TEXT PRIMARY KEY,
  channel_kind     TEXT NOT NULL,
  channel_value    TEXT NOT NULL,

  -- Denormalized from identity_channels at issuance for fast cookie validation
  -- without a join. Updated when the underlying channel binding changes.
  owner_user_id    TEXT,
  display_name     TEXT,

  -- TTL: 24h default per IDENTITY-CHANNELS.md OD2 (long enough to come back
  -- the next day; short enough to limit blast radius if device compromised).
  expires_at       TEXT NOT NULL,
  revoked_at       TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),

  -- Visitor sessions live or die with their backing channel binding.
  -- ON DELETE NO ACTION — channels are soft-deleted (revoked_at), so cascade
  -- isn't needed; revocation cascade is handled in app code.
  FOREIGN KEY (channel_kind, channel_value)
    REFERENCES identity_channels(channel_kind, channel_value)
);
CREATE TABLE IF NOT EXISTS waitlist (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), email TEXT NOT NULL UNIQUE, source TEXT DEFAULT 'landing', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS wealth_assets (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,  -- stock, etf, crypto, commodity, prediction, cash, other
  exchange TEXT,
  currency TEXT NOT NULL,
  lookup_id TEXT,       -- external API identifier (coingecko slug, yahoo symbol, etc.)
  price_source TEXT NOT NULL DEFAULT 'manual'  -- yahoo, coingecko, polymarket, metal_api, fx, manual
);
CREATE TABLE IF NOT EXISTS wealth_portfolio_access (
  portfolio_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',  -- owner, editor, viewer
  PRIMARY KEY (portfolio_id, user_id)
);
CREATE TABLE IF NOT EXISTS wealth_portfolios (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'personal',  -- personal, shared, agent_managed
  base_currency TEXT NOT NULL DEFAULT 'EUR',
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS wealth_positions (
  portfolio_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 0,
  avg_cost_basis REAL NOT NULL DEFAULT 0,
  total_invested REAL NOT NULL DEFAULT 0,
  realized_pnl REAL NOT NULL DEFAULT 0, scope TEXT DEFAULT 'wealth',
  PRIMARY KEY (portfolio_id, asset_id)
);
CREATE TABLE IF NOT EXISTS wealth_snapshots (
  portfolio_id TEXT NOT NULL,
  date TEXT NOT NULL,  -- YYYY-MM-DD
  total_value REAL NOT NULL,
  currency TEXT NOT NULL, scope TEXT DEFAULT 'wealth',
  PRIMARY KEY (portfolio_id, date)
);
CREATE TABLE IF NOT EXISTS wealth_transactions (
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
CREATE TABLE IF NOT EXISTS wealth_wallets (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  portfolio_id TEXT NOT NULL,
  chain TEXT NOT NULL,
  address TEXT NOT NULL,
  label TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS wealth_watchlist (
  user_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  target_price_high REAL,
  target_price_low REAL,
  notes TEXT,
  added_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, asset_id)
);

-- ── Indexes (200) ────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_access_grants_entity ON access_grants(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_access_grants_user ON access_grants(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_agent_date
    ON activity_sessions(agent_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_activity_date_category
    ON activity_sessions(date, category);
CREATE INDEX IF NOT EXISTS idx_activity_started
    ON activity_sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_agent_events_agent ON agent_events(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_events_created ON agent_events(created_at);
CREATE INDEX IF NOT EXISTS idx_agent_events_type ON agent_events(type);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_agent ON agent_tasks(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_pending ON agent_tasks(agent_id, status, priority);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_tokens_extension
  ON agent_tokens(extension_name)
  WHERE extension_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_tokens_parent
  ON agent_tokens(parent_token_hash)
  WHERE parent_token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_tokens_user ON agent_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_providers_active ON ai_providers(user_id, provider, is_active);
CREATE INDEX IF NOT EXISTS idx_ai_providers_user ON ai_providers(user_id);
CREATE INDEX IF NOT EXISTS idx_assignments_audit_user_ts
  ON ai_provider_assignments_audit(user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_assignments_user
  ON ai_provider_assignments(user_id, desired_state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_assignments_user_agent
  ON ai_provider_assignments(user_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_attachments_user ON attachments(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_log(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_event_type ON audit_log(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_user ON topology_audit_snapshots(user_id, run_at);
CREATE INDEX IF NOT EXISTS idx_audit_user_id ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_batch_jobs_status ON batch_jobs(status);
CREATE INDEX IF NOT EXISTS idx_batch_jobs_user ON batch_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_bg_jobs_status ON background_jobs(status);
CREATE INDEX IF NOT EXISTS idx_bg_jobs_user_kind ON background_jobs(user_id, kind, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_canvas_edges_ws ON canvas_edges(workspace_id);
CREATE INDEX IF NOT EXISTS idx_canvas_nodes_ws ON canvas_nodes(workspace_id);
CREATE INDEX IF NOT EXISTS idx_canvas_ws_user ON canvas_workspaces(user_id);
CREATE INDEX IF NOT EXISTS idx_ce_level_type ON cluster_events(level, event_type);
CREATE INDEX IF NOT EXISTS idx_ce_user_level ON cluster_events(user_id, level, created_at);
CREATE INDEX IF NOT EXISTS idx_ce_user_version ON cluster_events(user_id, cluster_version);
CREATE INDEX IF NOT EXISTS idx_clustering_realm ON clustering_points(realm_id);
CREATE INDEX IF NOT EXISTS idx_clustering_source ON clustering_points(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_clustering_territory ON clustering_points(territory_id);
CREATE INDEX IF NOT EXISTS idx_clustering_theme ON clustering_points(theme_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_clustering_unique
  ON clustering_points(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_clustering_user ON clustering_points(user_id);
CREATE INDEX IF NOT EXISTS idx_clustering_user_created
  ON clustering_points(user_id, created_at, territory_id, realm_id);
CREATE INDEX IF NOT EXISTS idx_clustering_user_realm
  ON clustering_points(user_id, realm_id);
CREATE INDEX IF NOT EXISTS idx_clustering_user_territory
  ON clustering_points(user_id, territory_id);
CREATE INDEX IF NOT EXISTS idx_cofire_a ON territory_cofire(territory_a);
CREATE INDEX IF NOT EXISTS idx_cofire_b ON territory_cofire(territory_b);
CREATE INDEX IF NOT EXISTS idx_cofire_session ON territory_cofire(cofire_session);
CREATE INDEX IF NOT EXISTS idx_cofire_user ON territory_cofire(user_id);
CREATE INDEX IF NOT EXISTS idx_cognitive_harmonic_user_era
  ON cognitive_metrics_harmonic(user_id, clustering_run_id);
CREATE INDEX IF NOT EXISTS idx_cognitive_harmonic_user_granularity_window
  ON cognitive_metrics_harmonic(user_id, granularity, window_end DESC);
CREATE INDEX IF NOT EXISTS idx_cognitive_harmonic_user_window
  ON cognitive_metrics_harmonic(user_id, window_end DESC);
CREATE INDEX IF NOT EXISTS idx_complexity_time ON complexity_snapshots(user_id, computed_at);
CREATE INDEX IF NOT EXISTS idx_complexity_user_level ON complexity_snapshots(user_id, level, level_id);
CREATE INDEX IF NOT EXISTS idx_connections_a ON connections(user_a, status);
CREATE INDEX IF NOT EXISTS idx_connections_b ON connections(user_b, status);
CREATE INDEX IF NOT EXISTS idx_context_grants_conn ON context_grants(connection_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_crypto_payments_order
  ON crypto_payments(coingate_order_id);
CREATE INDEX IF NOT EXISTS idx_ct_contact ON contact_territories(contact_id);
CREATE INDEX IF NOT EXISTS idx_ct_territory ON contact_territories(territory_id);
CREATE INDEX IF NOT EXISTS idx_ct_user ON contact_territories(user_id);
CREATE INDEX IF NOT EXISTS idx_cycle_metrics_user ON cycle_metrics(user_id);
CREATE INDEX IF NOT EXISTS idx_doc_versions_doc ON document_versions(document_id);
CREATE INDEX IF NOT EXISTS idx_documents_created_by ON documents(user_id, created_by);
CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(user_id, path);
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_public_slug
  ON documents(user_id, public_slug)
  WHERE public_slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documents_published
  ON documents(user_id, published)
  WHERE published = 1;
CREATE INDEX IF NOT EXISTS idx_documents_scope ON documents(scope);
CREATE INDEX IF NOT EXISTS idx_documents_scope_created ON documents(scope, updated_at);
CREATE INDEX IF NOT EXISTS idx_documents_unencrypted
  ON documents(id) WHERE content IS NOT NULL AND content != '' AND content NOT LIKE 'eyJ%';
CREATE INDEX IF NOT EXISTS idx_documents_user_id ON documents(user_id);
CREATE INDEX IF NOT EXISTS idx_egress_audit_agent_ts
  ON egress_audit(agent_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_egress_audit_channel_ts
  ON egress_audit(channel_kind, channel_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_egress_audit_cross_channel_ts
  ON egress_audit(cross_channel, ts DESC);
CREATE INDEX IF NOT EXISTS idx_egress_audit_provenance_ts
  ON egress_audit(provenance_kind, ts DESC);
CREATE INDEX IF NOT EXISTS idx_email_otp_active
  ON email_otp_challenges(email, expires_at)
  WHERE consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fed_log_instance ON federation_log(remote_instance, created_at);
CREATE INDEX IF NOT EXISTS idx_findings_snapshot ON topology_audit_findings(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_findings_user_type ON topology_audit_findings(user_id, finding_type);
CREATE INDEX IF NOT EXISTS idx_fisher_lookup
  ON fisher_trajectory(user_id, level, window_type, window_start);
CREATE INDEX IF NOT EXISTS idx_fisher_realm_phase
  ON fisher_trajectory(user_id, phase, window_end)
  WHERE level = 'realm';
CREATE INDEX IF NOT EXISTS idx_fisher_realm_phase_recent
  ON fisher_trajectory(user_id, phase_recent, window_end)
  WHERE level = 'realm';
CREATE INDEX IF NOT EXISTS idx_fisher_run
  ON fisher_trajectory(user_id, clustering_run_id);
CREATE INDEX IF NOT EXISTS idx_fleet_registry_last_report ON fleet_registry(last_report_at DESC);
CREATE INDEX IF NOT EXISTS idx_fleet_reports_recent ON fleet_health_reports(reported_at DESC);
CREATE INDEX IF NOT EXISTS idx_fleet_reports_vps_time ON fleet_health_reports(vps_id, reported_at DESC);
CREATE INDEX IF NOT EXISTS idx_folders_user ON folders(user_id);
CREATE INDEX IF NOT EXISTS idx_folders_user_agent
  ON folders (user_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_freq_user_time ON frequency_snapshots(user_id, window_end);
CREATE INDEX IF NOT EXISTS idx_health_daily_user_date
    ON health_daily(user_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_identities_provider ON user_identities(provider, provider_id);
CREATE INDEX IF NOT EXISTS idx_identities_user ON user_identities(user_id);
CREATE INDEX IF NOT EXISTS idx_identity_channels_kind
  ON identity_channels(channel_kind);
CREATE INDEX IF NOT EXISTS idx_identity_channels_owner
  ON identity_channels(owner_user_id)
  WHERE owner_user_id IS NOT NULL AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_identity_channels_unbound
  ON identity_channels(verified_at)
  WHERE owner_user_id IS NULL AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_import_jobs_user ON import_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_internal_model_section ON internal_model_items(user_id, section);
CREATE INDEX IF NOT EXISTS idx_internal_model_user ON internal_model_items(user_id);
CREATE INDEX IF NOT EXISTS idx_lineage_new ON territory_lineage(user_id, new_territory_id);
CREATE INDEX IF NOT EXISTS idx_lineage_old ON territory_lineage(user_id, old_territory_id);
CREATE INDEX IF NOT EXISTS idx_messages_agent_id ON messages(agent_id);
CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_nlp_created
  ON messages(user_id, nlp_processed, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_nlp_pending
  ON messages(created_at)
  WHERE nlp_processed = 0 OR nlp_processed IS NULL;
CREATE INDEX IF NOT EXISTS idx_messages_rehydrate
  ON messages(user_id, id)
  WHERE embedding_768 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_scope ON messages(scope);
CREATE INDEX IF NOT EXISTS idx_messages_scope_created ON messages(scope, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_source ON messages(source);
CREATE INDEX IF NOT EXISTS idx_messages_unencrypted
  ON messages(id) WHERE content IS NOT NULL AND content != '' AND content NOT LIKE 'eyJ%';
CREATE INDEX IF NOT EXISTS idx_messages_user_agent ON messages(user_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);
CREATE INDEX IF NOT EXISTS idx_milestones_run
  ON fisher_milestones(user_id, clustering_run_id);
CREATE INDEX IF NOT EXISTS idx_milestones_undismissed
  ON fisher_milestones(user_id, detected_at)
  WHERE dismissed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_note_links_source ON note_links(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_note_links_target ON note_links(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_oauth_states_expires
  ON oauth_states(expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_states_state ON oauth_states(state);
CREATE INDEX IF NOT EXISTS idx_outbound_dedup_created
  ON outbound_envelope_dedup(created_at);
CREATE INDEX IF NOT EXISTS idx_passkeys_user ON passkey_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_people_linkedin ON people(linkedin_url);
CREATE INDEX IF NOT EXISTS idx_people_status ON people(user_id, status);
CREATE INDEX IF NOT EXISTS idx_people_user ON people(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_people_user_name ON people(user_id, name);
CREATE INDEX IF NOT EXISTS idx_per_territory_user_era
  ON cognitive_metrics_per_territory(user_id, era_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_state_quarantined
  ON pipeline_state(user_id, quarantined)
  WHERE quarantined = 1;
CREATE INDEX IF NOT EXISTS idx_provisioning_email ON provisioning_jobs(email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_provisioning_handle ON provisioning_jobs(handle) WHERE status != 'failed';
CREATE INDEX IF NOT EXISTS idx_provisioning_status ON provisioning_jobs(status);
CREATE INDEX IF NOT EXISTS idx_public_presence_doc_beat
  ON public_presence(user_id, public_slug, last_beat_at);
CREATE INDEX IF NOT EXISTS idx_public_presence_stale
  ON public_presence(last_beat_at);
CREATE INDEX IF NOT EXISTS idx_realm_neighbors_user ON realm_neighbors(user_id);
CREATE INDEX IF NOT EXISTS idx_realms_user ON realms(user_id);
CREATE INDEX IF NOT EXISTS idx_reflections_user ON reflections(user_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_events_user ON scheduled_events(user_id);
CREATE INDEX IF NOT EXISTS idx_secrets_lookup ON secrets(user_id, scope);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_share_links_doc
  ON share_links(user_id, document_path);
CREATE INDEX IF NOT EXISTS idx_share_links_owner
  ON share_links(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_share_links_owner_recent
  ON share_links(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_shared_spaces_conn ON shared_spaces(connection_id);
CREATE INDEX IF NOT EXISTS idx_sharing_contexts_user ON sharing_contexts(user_id);
CREATE INDEX IF NOT EXISTS idx_space_access_space ON space_access(space_id);
CREATE INDEX IF NOT EXISTS idx_space_access_user ON space_access(user_id);
CREATE INDEX IF NOT EXISTS idx_space_invites_token ON space_invites(token_hash);
CREATE INDEX IF NOT EXISTS idx_space_knowledge_history_entry
  ON space_knowledge_history(entry_id, edited_at DESC);
CREATE INDEX IF NOT EXISTS idx_space_knowledge_source ON space_knowledge(source_user_id);
CREATE INDEX IF NOT EXISTS idx_space_knowledge_source_ref
  ON space_knowledge(space_id, source_ref);
CREATE INDEX IF NOT EXISTS idx_space_knowledge_space ON space_knowledge(space_id);
CREATE INDEX IF NOT EXISTS idx_space_knowledge_status ON space_knowledge(space_id, status);
CREATE INDEX IF NOT EXISTS idx_space_room_docs_doc
  ON space_room_documents(document_path);
CREATE INDEX IF NOT EXISTS idx_space_room_docs_room
  ON space_room_documents(room_id, position)
  WHERE room_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_space_room_docs_root
  ON space_room_documents(space_id, position)
  WHERE room_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_space_room_docs_space
  ON space_room_documents(space_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_space_room_documents_unique_folder
  ON space_room_documents(room_id, document_path)
  WHERE room_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_space_room_documents_unique_root
  ON space_room_documents(space_id, document_path)
  WHERE room_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_space_rooms_creator
  ON space_rooms(created_by);
CREATE INDEX IF NOT EXISTS idx_space_rooms_tree
  ON space_rooms(space_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_step_up_tokens_session
  ON step_up_tokens(session_token);
CREATE INDEX IF NOT EXISTS idx_step_up_tokens_unconsumed
  ON step_up_tokens(consumed_at, expires_at)
  WHERE consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_step_up_tokens_user_op
  ON step_up_tokens(user_id, op_type, consumed_at);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_stripe_cust ON subscriptions(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_sub ON subscriptions(stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(user_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tc_dirty
  ON time_chronicles(user_id, dirty) WHERE dirty = 1;
CREATE INDEX IF NOT EXISTS idx_tc_parent
  ON time_chronicles(user_id, parent_period_key);
CREATE INDEX IF NOT EXISTS idx_tc_user_gran_period
  ON time_chronicles(user_id, granularity, period_end);
CREATE INDEX IF NOT EXISTS idx_telegram_groups_active ON telegram_groups(active);
CREATE INDEX IF NOT EXISTS idx_telegram_groups_space ON telegram_groups(space_id);
CREATE INDEX IF NOT EXISTS idx_territory_dissolved ON territory_profiles(dissolved_at);
CREATE INDEX IF NOT EXISTS idx_territory_neighbors_tid ON territory_neighbors(territory_id);
CREATE INDEX IF NOT EXISTS idx_territory_neighbors_user ON territory_neighbors(user_id);
CREATE INDEX IF NOT EXISTS idx_territory_profiles_realm ON territory_profiles(realm_id);
CREATE INDEX IF NOT EXISTS idx_territory_profiles_territory_user
  ON territory_profiles(territory_id, user_id);
CREATE INDEX IF NOT EXISTS idx_territory_profiles_theme ON territory_profiles(semantic_theme_id);
CREATE INDEX IF NOT EXISTS idx_territory_profiles_user ON territory_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_tg_widget_consumed_at
  ON telegram_widget_sessions(consumed_at);
CREATE INDEX IF NOT EXISTS idx_theme_cards_theme ON theme_cards(theme_id);
CREATE INDEX IF NOT EXISTS idx_theme_cards_user ON theme_cards(user_id);
CREATE INDEX IF NOT EXISTS idx_themes_lookup ON semantic_themes(user_id, realm_id, semantic_theme_id);
CREATE INDEX IF NOT EXISTS idx_themes_realm ON semantic_themes(realm_id);
CREATE INDEX IF NOT EXISTS idx_themes_user ON semantic_themes(user_id);
CREATE INDEX IF NOT EXISTS idx_topology_user_computed
  ON topology_metrics(user_id, computed_at DESC);
CREATE INDEX IF NOT EXISTS idx_tp_description_version ON territory_profiles(description_version);
CREATE INDEX IF NOT EXISTS idx_tp_steward ON territory_profiles(steward_agent_id);
CREATE INDEX IF NOT EXISTS idx_tpn_territory ON territory_pass_notes(user_id, territory_id);
CREATE INDEX IF NOT EXISTS idx_traj_lookup
  ON cognitive_metrics_trajectory(user_id, level, window_type, window_start);
CREATE INDEX IF NOT EXISTS idx_traj_realm_phase
  ON cognitive_metrics_trajectory(user_id, phase, window_end)
  WHERE level = 'realm';
CREATE INDEX IF NOT EXISTS idx_traj_user_era
  ON cognitive_metrics_trajectory(user_id, era_id);
CREATE INDEX IF NOT EXISTS idx_tsp_territory ON territory_seen_points(user_id, territory_id);
CREATE INDEX IF NOT EXISTS idx_tv_computed       ON territory_vitality(user_id, computed_at);
CREATE INDEX IF NOT EXISTS idx_tv_user_territory ON territory_vitality(user_id, territory_id);
CREATE INDEX IF NOT EXISTS idx_user_identities_provider
  ON user_identities(provider, provider_id);
CREATE INDEX IF NOT EXISTS idx_user_identities_user_id
  ON user_identities(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_handle ON users(handle);
CREATE INDEX IF NOT EXISTS idx_visitor_sessions_active
  ON visitor_sessions(expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_visitor_sessions_channel
  ON visitor_sessions(channel_kind, channel_value);
CREATE INDEX IF NOT EXISTS idx_visitor_sessions_owner
  ON visitor_sessions(owner_user_id)
  WHERE owner_user_id IS NOT NULL AND revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_symbol_type ON wealth_assets(symbol, type);
CREATE INDEX IF NOT EXISTS idx_window_user_era
  ON cognitive_metrics_window(user_id, era_id);
CREATE INDEX IF NOT EXISTS idx_window_user_grain_era
  ON cognitive_metrics_window(user_id, granularity, era_id, window_end DESC);
CREATE INDEX IF NOT EXISTS idx_wpa_user ON wealth_portfolio_access(user_id);
CREATE INDEX IF NOT EXISTS idx_wt_asset ON wealth_transactions(asset_id);
CREATE INDEX IF NOT EXISTS idx_wt_portfolio ON wealth_transactions(portfolio_id);
CREATE INDEX IF NOT EXISTS idx_wt_portfolio_asset ON wealth_transactions(portfolio_id, asset_id);
CREATE INDEX IF NOT EXISTS idx_wt_transacted ON wealth_transactions(transacted_at);
CREATE INDEX IF NOT EXISTS idx_ww_portfolio ON wealth_wallets(portfolio_id);

-- ── Triggers ────────────────────────────────────────────────────────────

CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN INSERT INTO documents_fts(documents_fts, rowid, title, content, summary) VALUES ('delete', OLD.rowid, OLD.title, OLD.content, OLD.summary); END;
CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN INSERT INTO documents_fts(rowid, title, content, summary) VALUES (NEW.rowid, NEW.title, NEW.content, NEW.summary); END;
CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN INSERT INTO documents_fts(documents_fts, rowid, title, content, summary) VALUES ('delete', OLD.rowid, OLD.title, OLD.content, OLD.summary); INSERT INTO documents_fts(rowid, title, content, summary) VALUES (NEW.rowid, NEW.title, NEW.content, NEW.summary); END;

-- ── Virtual Tables (FTS5) ─────────────────────────────────────────────

CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(title, content, summary, content=documents, content_rowid=rowid);
