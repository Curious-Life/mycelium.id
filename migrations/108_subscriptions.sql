-- Stripe billing: subscriptions lifecycle + webhook idempotency
-- Run: cd worker && npx wrangler d1 execute mycelium-v2 --remote --file=../migrations/108_subscriptions.sql

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
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_stripe_cust ON subscriptions(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_sub ON subscriptions(stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);

-- Stripe webhook idempotency — prevent double-processing events
CREATE TABLE IF NOT EXISTS stripe_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TEXT DEFAULT (datetime('now'))
);

-- Extend provisioning_jobs with billing context
ALTER TABLE provisioning_jobs ADD COLUMN plan TEXT;
ALTER TABLE provisioning_jobs ADD COLUMN stripe_customer_id TEXT;
