-- 108: Crypto payment support (CoinGate)
-- Pre-paid subscription blocks via cryptocurrency

-- Extend subscriptions table for crypto payments
-- paid_through is used for BOTH Stripe and crypto (single access control field)
ALTER TABLE subscriptions ADD COLUMN payment_method TEXT DEFAULT 'stripe';
ALTER TABLE subscriptions ADD COLUMN crypto_coin TEXT;
ALTER TABLE subscriptions ADD COLUMN crypto_tx TEXT;
ALTER TABLE subscriptions ADD COLUMN paid_through TEXT;
ALTER TABLE subscriptions ADD COLUMN coingate_order_id TEXT;

-- Crypto payment history (audit trail + portal receipts)
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

-- Prevent double-crediting on webhook retries
CREATE UNIQUE INDEX IF NOT EXISTS idx_crypto_payments_order
  ON crypto_payments(coingate_order_id);
