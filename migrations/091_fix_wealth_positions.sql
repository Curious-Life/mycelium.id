-- Fix wealth tracker data issues (March 2026)
-- 1. European ETF lookup_ids resolving to wrong US tickers on Yahoo Finance
-- 2. XAU gold position: wrong quantity (13→14) and avg cost (€3000→€3214.29)
-- 3. Cash positions: exchange_rate=1 causing inflated EUR totals

-- ═══════════════════════════════════════════════════════════
-- 1. Fix European ETF lookup_ids for correct Yahoo Finance resolution
-- ═══════════════════════════════════════════════════════════

-- DFND: was resolving to US ETF ($43.22) instead of iShares Global Aerospace & Defence ($10.31)
UPDATE wealth_assets SET lookup_id = 'DFND.SW' WHERE symbol = 'DFND' AND type = 'etf';

-- WDEF: was resolving to US ETF ($33.53) instead of WisdomTree Europe Defence (€34.28)
UPDATE wealth_assets SET lookup_id = 'WDEF.MI' WHERE symbol = 'WDEF' AND type = 'etf';

-- IMAE: no price (null lookup_id) → iShares Core MSCI Europe Acc on Amsterdam
UPDATE wealth_assets SET lookup_id = 'IMAE.AS' WHERE symbol = 'IMAE' AND type = 'etf';

-- VUAA: no price → Vanguard S&P 500 UCITS ETF Acc on Xetra
UPDATE wealth_assets SET lookup_id = 'VUAA.DE' WHERE symbol = 'VUAA' AND type = 'etf';

-- XDWT: no price → Xtrackers MSCI World IT 1C on London (USD class)
UPDATE wealth_assets SET lookup_id = 'XDWT.L' WHERE symbol = 'XDWT' AND type = 'etf';

-- XEON: no price → Xtrackers EUR Overnight Rate Swap 1C on Xetra
UPDATE wealth_assets SET lookup_id = 'XEON.DE' WHERE symbol = 'XEON' AND type = 'etf';

-- ═══════════════════════════════════════════════════════════
-- 2. Fix XAU gold: 13oz @ €3000 → 14oz @ €3214.29 = €45,000
-- ═══════════════════════════════════════════════════════════

UPDATE wealth_transactions
SET quantity = 14, price_per_unit = 3214.29
WHERE id = '096597c1b9094507bbf14911d09e9e0a';

UPDATE wealth_positions
SET quantity = 14, avg_cost_basis = 3214.29, total_invested = 45000.06
WHERE portfolio_id = '9405d4c9-7a20-4e62-9b0b-9b19d6dc6713'
  AND asset_id = '6ceb5dc01d824b429a6d036947eb1685';

-- ═══════════════════════════════════════════════════════════
-- 3. Fix cash positions: apply EUR exchange rates
--    All had exchange_rate=1, treating foreign currency units as euros
-- ═══════════════════════════════════════════════════════════

-- NOK 20,378.54 × 0.085 EUR/NOK = €1,732.18
UPDATE wealth_transactions SET exchange_rate = 0.085
WHERE id = 'a8621c431a084440ae65c22b437abc59';

UPDATE wealth_positions SET avg_cost_basis = 0.085, total_invested = 1732.18
WHERE portfolio_id = '9405d4c9-7a20-4e62-9b0b-9b19d6dc6713'
  AND asset_id = '6e5a881d70c241de885d6106255df63f';

-- USD 1,763.92 × 0.926 EUR/USD = €1,633.79
UPDATE wealth_transactions SET exchange_rate = 0.926
WHERE id = 'e34a3532433542a291c5d513e2851a1b';

UPDATE wealth_positions SET avg_cost_basis = 0.926, total_invested = 1633.79
WHERE portfolio_id = '9405d4c9-7a20-4e62-9b0b-9b19d6dc6713'
  AND asset_id = 'c40dc2af42834842925ee389428b0eb2';

-- CHF 1,623.01 × 1.064 EUR/CHF = €1,726.88
UPDATE wealth_transactions SET exchange_rate = 1.064
WHERE id = 'cf254cb0763a40009d4ff05c35daae07';

UPDATE wealth_positions SET avg_cost_basis = 1.064, total_invested = 1726.88
WHERE portfolio_id = '9405d4c9-7a20-4e62-9b0b-9b19d6dc6713'
  AND asset_id = '62ae938ae8474176983e1c5803868946';
