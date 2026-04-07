# Crypto Payments — Implementation Plan

## Overview

One-time crypto payments for prepaid subscription blocks. Customer pays in crypto, gets N months of service credited. No auto-renewal — manual top-up via emailed payment link when time runs out.

## Processor

**CoinGate** (coingate.com)
- MiCA-licensed (Lithuania, EU passporting)
- 1% flat fee, no monthly fees
- EUR settlement via SEPA (auto-convert)
- 70+ coins, REST API, webhooks
- Handles all AML/KYC compliance

## Pricing

EUR-denominated, converted to crypto at checkout. Same pricing as card.

| Plan | Price |
|---|---|
| 1 month | EUR 10 |
| 1 year | EUR 100 |
| Decade | EUR 800 |

## Supported Coins (Day 1)

- USDC (primary pitch — no volatility)
- USDT
- BTC (on-chain + Lightning via CoinGate)
- ETH
- SOL

CoinGate handles all coin support. No extra work per coin.

## Database Changes

### Migration: `108_crypto_payments.sql`

```sql
-- Track crypto payments alongside Stripe
-- paid_through is populated for BOTH payment methods (single field for access control)
ALTER TABLE subscriptions ADD COLUMN payment_method TEXT DEFAULT 'stripe';
ALTER TABLE subscriptions ADD COLUMN crypto_coin TEXT;
ALTER TABLE subscriptions ADD COLUMN crypto_tx TEXT;
ALTER TABLE subscriptions ADD COLUMN paid_through TEXT;
ALTER TABLE subscriptions ADD COLUMN coingate_order_id TEXT;

-- Crypto payment history (for audit, renewal tracking, and portal receipts)
CREATE TABLE IF NOT EXISTS crypto_payments (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  coingate_order_id TEXT NOT NULL UNIQUE,
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_crypto_payments_order
  ON crypto_payments(coingate_order_id);
```

**Note on `paid_through`**: Populate this for Stripe subscribers too (from `current_period_end`). This gives a single field to check for access control regardless of payment method, simplifying portal logic.

**Note on `payment_method`**: Reflects the *current* payment method, not history. The `crypto_payments` table + Stripe's own records provide the full payment history.

## API Endpoints

### 1. `POST /api/crypto/invoice` (Worker)

Creates a CoinGate order. Called from signup page or portal settings.

**Request:**
```json
{
  "plan": "annual",
  "user_id": "abc123",
  "email": "user@example.com"
}
```

**Backend logic:**
```
VALID_PLANS = { monthly: 10, annual: 95, decade: 750 }

// Validate plan input — never trust the client
if (!VALID_PLANS[plan]) return 400 "Invalid plan"
price = VALID_PLANS[plan]

POST https://api.coingate.com/v2/orders
{
  "order_id": "mycelium_{user_id}_{timestamp}",
  "price_amount": price,
  "price_currency": "EUR",
  "receive_currency": "EUR",
  "title": "Mycelium {plan} subscription",
  "description": "Prepaid {plan} access to Mycelium",
  "callback_url": "${WORKER_URL}/api/crypto/webhook",
  "success_url": "https://mycelium.id/signup/?crypto=success",
  "cancel_url": "https://mycelium.id/signup/?crypto=cancel",
  "token": COINGATE_API_KEY
}
```

**Response:** `{ "payment_url": "https://coingate.com/pay/...", "order_id": "..." }`

### 2. `POST /api/crypto/webhook` (Worker)

CoinGate sends this when payment is confirmed.

**Webhook payload (from CoinGate):**
```json
{
  "id": 123456,
  "order_id": "mycelium_abc123_1712345678",
  "status": "paid",
  "price_amount": "95.00",
  "price_currency": "EUR",
  "receive_amount": "94.05",
  "receive_currency": "EUR",
  "pay_amount": "0.00103",
  "pay_currency": "BTC",
  "created_at": "2026-04-06T12:00:00Z"
}
```

**Backend logic:**
```
1. Verify webhook via HMAC signature
   - CoinGate sends x-coingate-callback-token header
   - Verify against COINGATE_WEBHOOK_SECRET
   - Do NOT use IP whitelist (unreliable on Cloudflare Workers)

2. Idempotency check — prevent double-crediting on webhook retries
   - SELECT * FROM crypto_payments WHERE coingate_order_id = ?
   - If exists AND status = 'paid': return 200 OK (already processed)

3. Parse order_id to extract user_id

4. Determine credited months from price:
   - EUR 10 → 1 month
   - EUR 95 → 12 months
   - EUR 750 → 120 months

5. Atomic paid_through extension (prevents race condition on double top-up):
   UPDATE subscriptions SET
     payment_method = 'crypto',
     crypto_coin = pay_currency,
     crypto_tx = coingate_order_id,
     paid_through = datetime(
       MAX(COALESCE(paid_through, datetime('now')), datetime('now')),
       '+N months'
     ),
     status = 'active'
   WHERE user_id = ?
   
   Single UPDATE — no read-then-write. MAX ensures we extend from
   whichever is later: existing paid_through or now.

6. INSERT INTO crypto_payments (...) — unique constraint on
   coingate_order_id prevents duplicates even if step 2 races

7. If new user: trigger provisioning
8. Send confirmation email
```

### 3. `GET /api/crypto/status/:order_id` (Worker)

Poll payment status (for the checkout UI while waiting).

**Response:** `{ "status": "pending" | "paid" | "expired" | "cancelled" }`

**Frontend handling for `expired`**: CoinGate orders expire after ~20 minutes (volatile coins) or longer (stablecoins). When status is `expired`, show: "Payment window expired" with a "Create new invoice" button — not a dead state. The user picks up where they left off with a fresh invoice.

## Frontend Changes

### Signup Page (`mycelium.id-site/signup/index.html`)

After plan selection, add payment method toggle:

```
[Monthly EUR 10] [Annual EUR 95] [Decade EUR 750]

Payment method:
  (o) Card     ( ) Crypto

[Card selected] → Stripe Checkout (existing)
[Crypto selected] → "Pay with crypto" button
  → Creates CoinGate invoice
  → Redirects to CoinGate payment page
  → Customer selects coin, scans QR, pays
  → CoinGate redirects to success_url
  → Webhook credits account, triggers provisioning
```

Crypto prices shown when crypto is selected. Card prices when card is selected.

### Portal Settings (subscription section)

For crypto subscribers, show:

```
Subscription
  Plan: Annual
  Paid through: Apr 6, 2027 (365 days remaining)
  Payment method: BTC (crypto)
  
  [Top up with crypto]  [Switch to card billing]
```

"Top up with crypto" creates a new CoinGate invoice for the same or different plan duration, extends `paid_through`.

### Portal: Payment History (receipts)

Crypto users don't get Stripe's automatic receipts. Show a payment history table in settings:

```
Payment History
  Date          Amount    Coin    Months    Order ID
  Apr 6, 2026   EUR 95    BTC     12       cg_abc123
  Apr 6, 2025   EUR 10    USDC     1       cg_def456
```

Data comes from `crypto_payments` table. Render in settings alongside the subscription status.

## Expiry & Renewal Flow

### Email schedule (managed by a cron or scheduled Worker)

| Trigger | Action |
|---|---|
| 30 days before expiry | Email: "Your Mycelium subscription expires on [date]. Top up to continue." + payment link |
| 7 days before | Email: "7 days remaining" + payment link |
| 1 day before | Email: "Last day" + payment link |
| Expired | Portal banner: "Your subscription has expired. Top up to continue." |
| Expired + 7 days | Service pauses: agents stop, portal shows top-up only. Email: "Service paused" |
| Expired + 37 days | Email: "Data will be deleted in 7 days unless you reactivate" |
| Expired + 44 days | Data deletion |

### Portal awareness

- `paid_through` checked on every authenticated request
- If `paid_through` is in the past: show banner, restrict writes after grace period
- Settings page shows days remaining, color-coded (green > 30d, yellow 7-30d, red < 7d)

## Environment Variables

```
COINGATE_API_KEY=...          # CoinGate API auth token
COINGATE_WEBHOOK_SECRET=...   # For webhook signature verification
COINGATE_ENVIRONMENT=live     # 'sandbox' for testing
```

Add to Worker secrets: `npx wrangler secret put COINGATE_API_KEY`

## File Changes

| File | Change |
|---|---|
| `worker/src/index.ts` | Add `/api/crypto/invoice`, `/api/crypto/webhook`, `/api/crypto/status` routes |
| `worker/src/services/coingate.ts` | New: CoinGate API client (create order, verify webhook) |
| `migrations/108_crypto_payments.sql` | New: schema changes |
| `mycelium.id-site/signup/index.html` | Add crypto payment method toggle + flow |
| `portal/src/routes/(app)/settings/+page.svelte` | Show crypto subscription status, top-up button |
| `agent-server.js` | Proxy `/portal/crypto/topup` to Worker, expiry banner logic |

## Testing

1. CoinGate sandbox environment (test API key, fake payments)
2. Create test invoice, verify webhook handling
3. Test expiry flow with short durations
4. Test plan switching (crypto → card, card → crypto)
5. Test top-up extending existing paid_through

## Security

- Webhook verification via HMAC (`x-coingate-callback-token` header vs `COINGATE_WEBHOOK_SECRET`). No IP whitelist — unreliable on Workers.
- Idempotent webhook processing: unique constraint on `coingate_order_id` prevents double-crediting on retries
- Atomic `paid_through` extension: single UPDATE with MAX(), no read-then-write race condition
- Server-side plan validation: only accept `monthly | annual | decade`, reject anything else
- Rate limit invoice creation (max 5 per user per hour)
- No crypto held — auto-convert to EUR immediately
- All payment records in D1 for audit trail
- Email confirmation on every payment

## Timeline

- **Day 1**: CoinGate account setup + KYB verification (Martin)
- **Day 1**: Migration + Worker endpoints
- **Day 2**: Signup page crypto toggle + CoinGate redirect flow
- **Day 2**: Portal settings subscription display
- **Day 3**: Expiry emails + renewal flow
- **Day 3**: Testing with sandbox
- **Day 4**: Go live
