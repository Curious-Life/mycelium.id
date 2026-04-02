-- ============================================================================
-- Wealth Module Tables
-- Portfolio tracking, transactions, positions, watchlist, snapshots
-- ============================================================================

-- ── Portfolios ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS wealth_portfolios (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'personal',  -- personal, shared, agent_managed
  base_currency TEXT NOT NULL DEFAULT 'EUR',
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS wealth_portfolio_access (
  portfolio_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',  -- owner, editor, viewer
  PRIMARY KEY (portfolio_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_wpa_user ON wealth_portfolio_access(user_id);

-- ── Assets ─────────────────────────────────────────────────────────────────

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

CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_symbol_type ON wealth_assets(symbol, type);

-- ── Transactions ───────────────────────────────────────────────────────────

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
);

CREATE INDEX IF NOT EXISTS idx_wt_portfolio ON wealth_transactions(portfolio_id);
CREATE INDEX IF NOT EXISTS idx_wt_asset ON wealth_transactions(asset_id);
CREATE INDEX IF NOT EXISTS idx_wt_portfolio_asset ON wealth_transactions(portfolio_id, asset_id);
CREATE INDEX IF NOT EXISTS idx_wt_transacted ON wealth_transactions(transacted_at);

-- ── Positions (denormalized) ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS wealth_positions (
  portfolio_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 0,
  avg_cost_basis REAL NOT NULL DEFAULT 0,
  total_invested REAL NOT NULL DEFAULT 0,
  realized_pnl REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (portfolio_id, asset_id)
);

-- ── Snapshots (daily portfolio values) ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS wealth_snapshots (
  portfolio_id TEXT NOT NULL,
  date TEXT NOT NULL,  -- YYYY-MM-DD
  total_value REAL NOT NULL,
  currency TEXT NOT NULL,
  PRIMARY KEY (portfolio_id, date)
);

-- ── Watchlist ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS wealth_watchlist (
  user_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  target_price_high REAL,
  target_price_low REAL,
  notes TEXT,
  added_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, asset_id)
);

-- ── Wallets (schema ready, used in Phase 2) ────────────────────────────────

CREATE TABLE IF NOT EXISTS wealth_wallets (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  portfolio_id TEXT NOT NULL,
  chain TEXT NOT NULL,
  address TEXT NOT NULL,
  label TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_ww_portfolio ON wealth_wallets(portfolio_id);
