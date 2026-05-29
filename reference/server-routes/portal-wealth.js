/**
 * Portal wealth router (Phase 10 PR 7C-a).
 *
 * Owns the personal wealth surface — portfolios, positions, transactions,
 * performance snapshots, watchlist, asset search. 10 handlers:
 *
 *   Portfolios (3):
 *     GET    /portal/wealth/portfolios
 *     POST   /portal/wealth/portfolios
 *     DELETE /portal/wealth/portfolios/:id
 *
 *   Positions + performance (2):
 *     GET    /portal/wealth/portfolios/:id/positions   — live-price + FX enriched
 *     GET    /portal/wealth/portfolios/:id/performance — historical snapshots
 *
 *   Transactions (3):
 *     GET    /portal/wealth/portfolios/:id/transactions
 *     POST   /portal/wealth/portfolios/:id/transactions — viewer role → 403
 *     DELETE /portal/wealth/transactions/:id            — viewer role → 403
 *
 *   Market data (2):
 *     GET    /portal/wealth/watchlist — live-price enriched
 *     GET    /portal/wealth/assets    — symbol search
 *
 * Portal-session-only. Row-level role enforcement happens via
 * `portfolio.role` returned from `db.wealth.getPortfolio(id, userId)`.
 *
 * Bug-fix folded in during extraction:
 *   - FX enrichment (positions handler) previously collected quote
 *     currencies in mixed case (`priceCurrencies.add(p.currency)`) but
 *     compared with `.toUpperCase()` and looked up with mixed-case keys.
 *     The `|| 1` fallback silently produced un-converted values when the
 *     case didn't match what `fetchFxRates` returned. Now every currency
 *     flows through `.toUpperCase()` before hitting the rate map, so the
 *     fallback only fires on a genuine rate-service miss.
 */

import { Router } from 'express';

import { fetchPrices, fetchFxRates } from '@mycelium/core/price-fetcher.js';

/**
 * @typedef {object} CreatePortalWealthRouterDeps
 * @property {(req: any) => Promise<object|null>} authenticatePortalRequest
 * @property {() => object|null}                  tryGetDb
 * @property {object} config                      — { LOG_PREFIX }
 * @property {object} [log]
 */

export function createPortalWealthRouter(deps) {
  if (!deps) throw new TypeError('createPortalWealthRouter: deps required');
  const {
    authenticatePortalRequest,
    tryGetDb,
    config,
    log,
  } = deps;

  if (typeof authenticatePortalRequest !== 'function') {
    throw new TypeError('createPortalWealthRouter: authenticatePortalRequest required');
  }
  if (typeof tryGetDb !== 'function') {
    throw new TypeError('createPortalWealthRouter: tryGetDb required');
  }
  if (!config?.LOG_PREFIX) {
    throw new TypeError('createPortalWealthRouter: config.LOG_PREFIX required');
  }

  const { LOG_PREFIX } = config;
  const logger = log || console;
  const router = Router();

  // Enrich a list of holdings (positions or watchlist items) with live
  // prices. For positions, also converts market values to the portfolio
  // base currency. Case-normalized end-to-end: every currency key flows
  // through UPPER before touching the FX map.
  const enrichWithPrices = async (items, baseCurrency) => {
    let prices;
    try {
      prices = await fetchPrices(items);
    } catch (err) {
      logger.error?.(`[${LOG_PREFIX}] Price fetch failed:`, err.message);
      return;
    }

    const normalizedBase = baseCurrency ? baseCurrency.toUpperCase() : null;

    let fxRates = null;
    if (normalizedBase) {
      const quoteCurrencies = new Set();
      for (const item of items) {
        const p = prices.get(item.asset_id);
        if (!p) continue;
        const quote = p.currency?.toUpperCase();
        if (quote && quote !== normalizedBase) quoteCurrencies.add(quote);
      }
      if (quoteCurrencies.size > 0) {
        try {
          fxRates = await fetchFxRates(normalizedBase, [...quoteCurrencies]);
        } catch (err) {
          logger.error?.(`[${LOG_PREFIX}] FX fetch failed:`, err.message);
        }
      }
    }

    for (const item of items) {
      const p = prices.get(item.asset_id);
      if (!p) continue;
      item.current_price = p.price;
      item.price_currency = p.currency;
      item.price_fetched_at = new Date(p.fetchedAt).toISOString();

      // Only positions have the quantity/invested fields; watchlist items
      // skip market-value computation naturally.
      if (typeof item.quantity === 'number' && typeof item.total_invested === 'number' && normalizedBase) {
        const quote = p.currency?.toUpperCase();
        const fxRate = (quote === normalizedBase) ? 1 : (fxRates?.get(quote) ?? 1);
        item.current_value = p.price * item.quantity * fxRate;
        item.unrealized_pnl = item.current_value - item.total_invested;
      }
    }
  };

  // ══════════════════════════════════════════════════════════════════
  // Portfolios
  // ══════════════════════════════════════════════════════════════════

  router.get('/portal/wealth/portfolios', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });
      const portfolios = await db.wealth.listPortfolios(user.id);
      res.json({ portfolios });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Wealth list portfolios failed:`, e.message);
      res.status(500).json({ error: 'Failed to load portfolios' });
    }
  });

  router.post('/portal/wealth/portfolios', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });
      const { name, baseCurrency, type } = req.body || {};
      if (!name) return res.status(400).json({ error: 'name is required' });
      const portfolio = await db.wealth.createPortfolio(
        user.id, name, baseCurrency || 'EUR', type || 'personal',
      );
      res.json({ portfolio });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Wealth create portfolio failed:`, e.message);
      res.status(500).json({ error: 'Failed to create portfolio' });
    }
  });

  router.delete('/portal/wealth/portfolios/:id', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });
      await db.wealth.deletePortfolio(req.params.id, user.id);
      res.json({ ok: true });
    } catch (e) {
      const status = e.message?.includes('Only owner') ? 403 : 500;
      res.status(status).json({ error: e.message || 'Failed to delete portfolio' });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // Positions + performance
  // ══════════════════════════════════════════════════════════════════

  router.get('/portal/wealth/portfolios/:id/positions', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const portfolio = await db.wealth.getPortfolio(req.params.id, user.id);
      if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });

      const positions = await db.wealth.getPositions(req.params.id);
      await enrichWithPrices(positions, portfolio.base_currency || 'EUR');
      res.json({ portfolio, positions });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Wealth positions failed:`, e.message);
      res.status(500).json({ error: 'Failed to load positions' });
    }
  });

  router.get('/portal/wealth/portfolios/:id/performance', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });
      const portfolio = await db.wealth.getPortfolio(req.params.id, user.id);
      if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });
      const { from, to } = req.query;
      const snapshots = await db.wealth.getSnapshots(req.params.id, { from, to });
      res.json({ portfolio, snapshots });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Wealth performance failed:`, e.message);
      res.status(500).json({ error: 'Failed to load performance data' });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // Transactions
  // ══════════════════════════════════════════════════════════════════

  router.get('/portal/wealth/portfolios/:id/transactions', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });
      const portfolio = await db.wealth.getPortfolio(req.params.id, user.id);
      if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });
      const { symbol, type, from, to, limit } = req.query;
      const transactions = await db.wealth.listTransactions(req.params.id, {
        symbol, type, from, to, limit: limit ? parseInt(limit, 10) : 100,
      });
      res.json({ transactions });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Wealth list transactions failed:`, e.message);
      res.status(500).json({ error: 'Failed to load transactions' });
    }
  });

  router.post('/portal/wealth/portfolios/:id/transactions', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const portfolio = await db.wealth.getPortfolio(req.params.id, user.id);
      if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });
      if (portfolio.role === 'viewer') {
        return res.status(403).json({ error: 'Viewers cannot add transactions' });
      }

      const {
        symbol, assetName, assetType, exchange, lookupId, priceSource,
        type, quantity, pricePerUnit, currency, exchangeRate, fees, date, notes,
      } = req.body || {};
      if (!symbol || !assetName || !assetType || !type || !currency || !date) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const asset = await db.wealth.upsertAsset({
        symbol, name: assetName, type: assetType,
        exchange: exchange || null, currency,
        lookup_id: lookupId || null,
        price_source: priceSource || 'manual',
      });

      const txId = await db.wealth.addTransaction({
        portfolio_id: req.params.id,
        asset_id: asset.id,
        type,
        quantity: quantity || 0,
        price_per_unit: pricePerUnit || 0,
        currency,
        exchange_rate: exchangeRate || 1,
        fees: fees || 0,
        transacted_at: date,
        notes: notes || null,
      });

      const position = await db.wealth.recalculatePosition(req.params.id, asset.id);
      res.json({ transactionId: txId, asset, position });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Wealth add transaction failed:`, e.message);
      res.status(500).json({ error: 'Failed to add transaction' });
    }
  });

  router.delete('/portal/wealth/transactions/:id', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const tx = await db.wealth.getTransaction(req.params.id);
      if (!tx) return res.status(404).json({ error: 'Transaction not found' });

      const portfolio = await db.wealth.getPortfolio(tx.portfolio_id, user.id);
      if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });
      if (portfolio.role === 'viewer') {
        return res.status(403).json({ error: 'Viewers cannot delete transactions' });
      }

      const deleted = await db.wealth.deleteTransaction(req.params.id);
      await db.wealth.recalculatePosition(deleted.portfolio_id, deleted.asset_id);
      res.json({ ok: true });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Wealth delete transaction failed:`, e.message);
      res.status(500).json({ error: 'Failed to delete transaction' });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // Market data
  // ══════════════════════════════════════════════════════════════════

  router.get('/portal/wealth/watchlist', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const items = await db.wealth.getWatchlist(user.id);
      // Watchlist items have no portfolio → no FX conversion; pass null
      // baseCurrency so enrichWithPrices just attaches raw prices.
      await enrichWithPrices(items, null);
      res.json({ watchlist: items });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Wealth watchlist failed:`, e.message);
      res.status(500).json({ error: 'Failed to load watchlist' });
    }
  });

  router.get('/portal/wealth/assets', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });
      const { q } = req.query;
      if (!q) return res.json({ assets: [] });
      const assets = await db.wealth.findAssets(q);
      res.json({ assets });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Wealth find assets failed:`, e.message);
      res.status(500).json({ error: 'Failed to search assets' });
    }
  });

  logger.info?.('[portal-wealth-router] mounted 10 handlers');
  return router;
}
