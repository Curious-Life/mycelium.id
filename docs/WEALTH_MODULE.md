# Wealth Module — Specification

**Agent**: Thera (wealth-agent)
**Status**: Draft v2 (incorporates Thera's feedback)
**Last updated**: 2026-02-28

---

## Overview

A financial portfolio management module for Mycelium, operated by Thera (wealth-agent). Tracks positions across stocks, ETFs, crypto, physical commodities, and prediction markets. Provides market data, research, and analysis through both conversational (Discord/chat) and visual (portal UI) interfaces.

Core principle: **lean storage, live data**. We store only what we own and what we did. Market data is fetched on demand, never persisted (except daily value snapshots for performance charts).

---

## Data Model (D1)

### `wealth_portfolios`

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | UUID |
| name | TEXT | e.g. "Personal", "Shared with Nate" |
| type | TEXT | `personal`, `shared`, `agent_managed` |
| base_currency | TEXT | ISO 4217 — EUR, USD, etc. |
| created_at | TEXT | ISO 8601 |

`agent_managed` type is reserved for Thera's future autonomous trading portfolio. Same schema, different access control rules (Thera executes, humans approve/review).

### `wealth_portfolio_access`

| Column | Type | Notes |
|--------|------|-------|
| portfolio_id | TEXT FK | → wealth_portfolios.id |
| user_id | TEXT FK | → users.id |
| role | TEXT | `owner`, `editor`, `viewer` |

Composite PK: `(portfolio_id, user_id)`.

- `owner`: full control — invite/remove users, delete portfolio
- `editor`: add/edit transactions, manage positions
- `viewer`: read-only access to positions and performance

### `wealth_assets`

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | UUID |
| symbol | TEXT | NVDA, BTC, XAU, EUR, USD, etc. |
| name | TEXT | "NVIDIA Corp", "Bitcoin", "Physical Gold", "Euro Cash", etc. |
| type | TEXT | `stock`, `etf`, `crypto`, `commodity`, `prediction`, `cash`, `other` |
| exchange | TEXT NULL | NASDAQ, NYSE, XETRA — optional metadata, not part of uniqueness |
| currency | TEXT | Asset's native trading currency |
| lookup_id | TEXT NULL | External API identifier (CoinGecko ID, Yahoo symbol, etc.) |
| price_source | TEXT | `yahoo`, `coingecko`, `polymarket`, `metal_api`, `fx`, `manual` |

Unique constraint: **`(symbol, type)`**. Exchange is metadata only — BTC is BTC regardless of where it's held. For stocks listed on multiple exchanges (e.g. Siemens on XETRA vs NYSE), use distinct symbols (SIE.DE vs SIEGY) as Yahoo Finance does. Thera asks the user to clarify when ambiguous.

**Cash as an asset**: Cash holdings are tracked as positions with `type: cash`. Each currency is a separate asset (EUR, USD, GBP, etc.) with `price_source: fx` — valued at 1.0 in its own currency, converted to portfolio base_currency via FX rates. This lets Thera show total cash exposure, currency allocation, and the real cost of holding cash against inflation. Transactions like `transfer_in` add cash; buys implicitly reduce it if the user wants to track that level of detail (optional — cash can also just be set as a lump position).

### `wealth_transactions`

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | UUID |
| portfolio_id | TEXT FK | → wealth_portfolios.id |
| asset_id | TEXT FK | → wealth_assets.id |
| type | TEXT | `buy`, `sell`, `dividend`, `staking_reward`, `transfer_in`, `transfer_out` |
| quantity | REAL | Number of units (0 for cash-only events like dividends paid in cash) |
| price_per_unit | REAL | Price in transaction currency |
| currency | TEXT | Currency of the transaction |
| exchange_rate | REAL | Rate to portfolio base_currency at time of transaction |
| fees | REAL DEFAULT 0 | Transaction fees (in transaction currency) |
| transacted_at | TEXT | When the trade actually happened (ISO 8601) |
| notes | TEXT NULL | Free text — broker, reason, context |
| created_at | TEXT | When record was entered |

Transaction types:
- `buy` / `sell` — standard trades
- `dividend` — cash distribution from stocks/ETFs. `quantity` = 0, `price_per_unit` = total dividend amount
- `staking_reward` — crypto yield. `quantity` = tokens received, `price_per_unit` = market price at receipt
- `transfer_in` / `transfer_out` — moving assets between wallets/brokers (no P&L impact)

### `wealth_positions` (denormalized)

| Column | Type | Notes |
|--------|------|-------|
| portfolio_id | TEXT FK | → wealth_portfolios.id |
| asset_id | TEXT FK | → wealth_assets.id |
| quantity | REAL | Current holdings (sum of buys + staking - sells - transfers_out + transfers_in) |
| avg_cost_basis | REAL | Weighted average cost in portfolio base_currency |
| total_invested | REAL | Total cost basis in portfolio base_currency |
| realized_pnl | REAL | Cumulative realized P&L from sells, in portfolio base_currency |

Composite PK: `(portfolio_id, asset_id)`.

Recalculated whenever a transaction is added/modified/deleted for that portfolio + asset pair.

**Tax lot tracking**: The `avg_cost_basis` serves display purposes. For tax-aware sell decisions (FIFO, LIFO, specific lot), Thera walks the transaction log chronologically at query time. No separate lots table needed — transactions ARE the lots. When Thera processes a sell, he can report which lots are being closed and the per-lot P&L. This is a query-time calculation, not stored state.

### `wealth_snapshots`

| Column | Type | Notes |
|--------|------|-------|
| portfolio_id | TEXT FK | → wealth_portfolios.id |
| date | TEXT | YYYY-MM-DD |
| total_value | REAL | Portfolio value in base_currency |
| currency | TEXT | Same as portfolio base_currency |

Composite PK: `(portfolio_id, date)`.

One row per portfolio per day. Populated by Thera's daily watcher/scheduled task. Enables performance-over-time charts without storing historical prices. If a day is missed, it can be backfilled by replaying positions against historical price lookups.

### `wealth_watchlist`

| Column | Type | Notes |
|--------|------|-------|
| user_id | TEXT FK | → users.id |
| asset_id | TEXT FK | → wealth_assets.id |
| target_price_high | REAL NULL | Alert when price goes above |
| target_price_low | REAL NULL | Alert when price drops below |
| notes | TEXT NULL | Why watching, thesis, etc. |
| added_at | TEXT | ISO 8601 |

Composite PK: `(user_id, asset_id)`.

### `wealth_wallets` (designed now, implemented Phase 2)

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | UUID |
| portfolio_id | TEXT FK | → wealth_portfolios.id |
| chain | TEXT | `ethereum`, `solana`, `bitcoin`, etc. |
| address | TEXT | Wallet address |
| label | TEXT NULL | "Cold storage", "MetaMask", etc. |
| created_at | TEXT | ISO 8601 |

Enables auto-reconciliation: Thera reads on-chain balances and compares against recorded positions. Flags discrepancies. Not used for Phase 1, but the table exists so the schema doesn't need migration later.

---

## Market Data

### Sources

| Asset Type | Source | Rate Limit | Auth |
|------------|--------|------------|------|
| Crypto | CoinGecko API (free) | 30 req/min | None |
| Stocks/ETFs | Yahoo Finance (unofficial) | ~2000/hr | None |
| Gold/Commodities | Metal price API (goldapi.io or similar) | Varies | API key (free tier) |
| Prediction markets | Polymarket API | Liberal | None |
| FX rates (primary) | ECB daily (EUR-based) | Unlimited | None |
| FX rates (fallback) | exchangerate.host or Open Exchange Rates | Varies | API key for OER |

ECB rates are daily and EUR-centric — sufficient for end-of-day tracking. For intraday FX on volatile days, Thera falls back to exchangerate.host.

### Caching Strategy

No price data in D1. Caching options by priority:

1. **In-memory on agent-server** — simple JS Map with TTL (15 min). Good enough for 10-50 assets.
2. **Cloudflare KV** — if we need cross-request caching or the Worker serves prices. 15-min TTL.

### Price Fetch Flow

```
Request for portfolio → get positions from D1 → collect unique symbols
  → batch fetch current prices from relevant APIs (grouped by price_source)
  → calculate P&L client-side or in response
```

Gold: fetched from commodity price API using spot price. User only manually enters buy/sell transactions — price is live like any other asset.

### Currency Conversion

- ECB daily rates as primary source (free, reliable, EUR-based)
- Fallback to exchangerate.host for intraday or non-EUR pairs
- Exchange rate stored on each transaction at time of entry (immutable historical record)
- Display conversion uses current rates, fetched on demand (cached 1 hour)

---

## MCP Tools (Thera)

Structured tools for D1 data operations. Kept minimal — Thera uses bash/curl for market data, research, and anything else.

### Portfolio Management

- **`listPortfolios()`** — returns portfolios the current user has access to, with role
- **`createPortfolio(name, baseCurrency, type?)`** — creates portfolio, grants owner role
- **`sharePortfolio(portfolioId, email, role)`** — invite user (triggers email if new)
- **`removePortfolioAccess(portfolioId, userId)`** — revoke access

### Transaction Management

- **`addTransaction(portfolioId, symbol, type, quantity, price, currency, date, notes?, fees?)`**
  - Auto-creates asset record if symbol not yet in `wealth_assets` (Thera resolves the right `lookup_id` and `price_source` via external lookup first)
  - If symbol is ambiguous (e.g. multiple exchanges), Thera asks the user to clarify before calling
  - Fetches exchange rate if transaction currency differs from portfolio base
  - Recalculates position after insert
- **`editTransaction(transactionId, fields)`** — update any field, recalculates position
- **`deleteTransaction(transactionId)`** — removes and recalculates position
- **`listTransactions(portfolioId, filters?)`** — optional filters: symbol, type, date range

### Query Tools

- **`getPositions(portfolioId)`** — returns positions with current quantities and cost basis (no live prices — Thera fetches those separately via curl)
- **`getPerformance(portfolioId, period?)`** — reads from `wealth_snapshots` for historical performance
- **`getWatchlist()`** / **`addToWatchlist(symbol, targetHigh?, targetLow?)`** / **`removeFromWatchlist(symbol)`**
- **`getAsset(symbol)`** — lookup asset details and resolve identity
- **`recordSnapshot(portfolioId, totalValue)`** — save daily portfolio value (called by watcher)

### What Thera Does Via Bash (not MCP tools)

- `curl` CoinGecko, Yahoo Finance, Polymarket, gold/commodity APIs, FX APIs for live prices
- Web search for market news and research
- On-chain wallet balance lookups via public APIs
- Calculations, analysis, comparisons
- Polymarket market browsing and odds checking

Total MCP tools: ~12, all focused on D1 operations.

---

## Access Control

### Per-Portfolio Permissions

All data access is filtered through `wealth_portfolio_access`. A user can only see/modify portfolios they have a row in this table for.

- API endpoints check `user_id` against `portfolio_access` for every request
- Thera checks the requesting user's identity and filters accordingly
- Portal UI only shows portfolios the logged-in user has access to

### Invite Flow

1. Owner tells Thera: *"invite nate@email.com to the shared portfolio as editor"*
2. Thera calls `sharePortfolio()` which:
   - Generates a single-use invite code (UUID, stored in D1 with expiry)
   - Sends invite email via Worker (or logged for manual sending initially)
3. Invitee clicks link → portal registration page → creates passkey
4. On account creation, invite code is consumed, `portfolio_access` row created
5. If invitee already has an account, just create the access row

### Cross-Instance Sharing (Future — Not Phase 1)

For users like Nate who run their own Mycelium: the simplest path is that Nate creates an account on your portal for shared portfolios. His own instance stays separate. Federation (API-to-API) is a Phase 2+ consideration if the need arises.

---

## Portal UI — `/wealth`

### Dashboard View

- Portfolio selector (dropdown/tabs for switching between portfolios)
- Total portfolio value in base currency, with daily change (amount + %)
- Performance chart over time (from `wealth_snapshots` — line chart, selectable period)
- Allocation breakdown — donut/pie chart by asset or by type
- Top movers — which positions changed most today

### Positions Table

| Asset | Type | Qty | Avg Cost | Current Price | Value | P&L | P&L % | Allocation % |
|-------|------|-----|----------|---------------|-------|-----|-------|-------------|

- Sortable by any column
- Click row → expand to show transaction history for that asset
- Color-coded P&L (green/red)

### Transaction Log

- Full list of all transactions across the portfolio
- Filterable by asset, type (buy/sell/dividend/staking), date range
- Add transaction button → opens form

### Add Transaction Form

- Asset search (autocomplete against `wealth_assets` + external search for new assets)
- Type: buy / sell / dividend / staking reward / transfer in / transfer out
- Quantity, price per unit, currency
- Date picker (defaults to today, allows past dates for backfilling)
- Fees field (optional)
- Notes field

### Watchlist

- List of watched assets with current price, daily change
- Target price columns (high/low) — editable inline
- Visual indicator when price is near or past target
- Add/remove buttons

### Shared Portfolio Indicator

- Badge showing portfolio role (Owner / Editor / Viewer)
- Settings gear → manage access (owner only): see members, invite, remove
- Viewer role: all edit/add buttons hidden

---

## Agent Behavior

### Conversational Portfolio Management

Thera handles natural language for all portfolio operations:

- *"I bought 100 NVDA at $120 on March 15, 2024"* → resolves symbol, confirms, calls `addTransaction()`
- *"Sell 0.5 BTC at 62,000 EUR today"* → `addTransaction(type: sell)`
- *"I bought 10g of gold at 58 EUR/g last Tuesday"* → uses XAU commodity asset
- *"I received 0.05 ETH staking reward yesterday"* → `addTransaction(type: staking_reward)`, fetches ETH price at that date
- *"Got a $1.20/share dividend on MSFT"* → `addTransaction(type: dividend)`
- *"I have 50,000 EUR in cash in my personal portfolio"* → creates EUR cash asset, `addTransaction(type: transfer_in)`
- *"Show me the tech portfolio"* → `getPositions()` + fetches live prices
- *"What's my total exposure to crypto?"* → aggregates across portfolios
- *"Remove that last NVDA transaction, the price was wrong"* → `deleteTransaction()` or `editTransaction()`

**Ambiguity handling**: When a symbol could refer to multiple assets (e.g. "Siemens" → SIE.DE on XETRA or SIEGY on NYSE), Thera asks: *"Did you mean SIE on XETRA (EUR) or SIEGY on NYSE (USD)?"* — never assumes.

**Confirmation**: Thera always confirms before executing: *"Adding: BUY 100 NVDA at $120.00 on 2024-03-15 to Personal portfolio. Correct?"*

### Market Research

Thera uses web search, API calls, and analysis tools to:

- Summarize market conditions for watched/owned assets
- Research companies/tokens on request
- Browse Polymarket for relevant prediction markets and odds
- Provide buy/sell considerations with reasoning (clearly marked as not financial advice)

### Scheduled Tasks (via watcher/scheduler)

- **Daily snapshot**: Record portfolio values to `wealth_snapshots` for performance charts
- **Price alerts**: Check watchlist against target prices, notify via Discord if triggered
- **Weekly recap** (optional): Performance summary posted to Discord

---

## Implementation Phases

### Phase 1 — Portfolio Tracking + Chat (MVP)

**Goal**: Thera can manage portfolios through chat. Track what you own, what you paid, what it's worth. Portal UI for viewing.

1. D1 tables: all `wealth_*` tables (including `wealth_wallets` schema, unused until Phase 2)
2. DB methods in `lib/db-d1.js` for all CRUD operations
3. MCP tools for Thera: `wealth-tools.js` as a separate MCP server
4. Market data fetching via bash/curl (CoinGecko, Yahoo Finance, gold API, ECB FX)
5. Position recalculation logic (in MCP tools, triggered on transaction changes)
6. Portal API endpoints in `agent-server.js` (CRUD + position queries)
7. Portal UI: dashboard, positions table, transaction log, add transaction form, watchlist
8. Daily snapshot watcher
9. Backfill existing portfolio through chat with Thera

**Thera is useful from the moment MCP tools + bash work** — Discord-only, no portal needed to start.

### Phase 2 — Sharing, Alerts & Wallets

1. Invite flow (email invite codes, new user registration)
2. Portfolio sharing with role-based access in UI
3. Watchlist price alerts (watcher checks targets, notifies via Discord)
4. Polymarket position tracking
5. On-chain wallet connection + balance reconciliation
6. Multi-currency display toggle in portal
7. Market news aggregation

### Phase 3 — Intelligence & Automation

1. Scheduled portfolio reports (daily/weekly to Discord)
2. Trade analysis and suggestions based on market data + research
3. Risk metrics (concentration, correlation, volatility)
4. Tax lot reporting (FIFO/LIFO P&L per lot on sell)
5. Autonomous trading wallet (`agent_managed` portfolio type)
6. Cross-instance federation for shared portfolios

---

## Technical Notes

- All `wealth_*` tables prefixed to avoid collision with existing D1 schema
- Position recalculation is application-side, not D1 triggers
- **Separate MCP server**: `wealth-tools.js` loaded only by Thera, not shared with other agents
- Historical prices NOT stored — snapshots capture portfolio-level values only
- The Worker (`MYA-0.2`) may get a `/api/market-data` endpoint if caching becomes necessary, but not required for Phase 1
- Tax lot tracking is implicit in transaction history — no separate lots table, just chronological walk at query time
- Gold price fetched live from commodity API — user tracks buy/sell dates and quantities, not price
