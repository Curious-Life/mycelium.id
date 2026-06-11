/**
 * Wealth namespace — portfolios, assets, transactions, positions,
 * snapshots, watchlist. Rob (wealth-agent) drives most writes; the
 * portal surfaces reads.
 *
 * Access model: `wealth_portfolio_access` is the ACL. A portfolio can
 * have exactly one `owner` (checked on delete), plus any number of
 * `viewer` / shared roles granted via `sharePortfolio`. Row-level
 * auth lives in the caller — this namespace trusts the userId it's
 * handed and only enforces the owner-for-delete invariant.
 *
 * `recalculatePosition` is the one piece of real arithmetic here:
 * it replays the transaction history in chronological order and
 * maintains running (quantity, total_cost, realized_pnl). Buys
 * increase both quantity and cost; sells subtract at average cost
 * and book realized P&L; dividends are income with no position
 * change. Everything is converted to portfolio base currency via
 * `exchange_rate`.
 *
 * @typedef {object} WealthNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {(statements: Array<{sql: string, params: any[]}>) => Promise<any[]>} d1Batch
 * @property {() => string} [randomUUID] — test seam; defaults to node:crypto.randomUUID
 */

import { randomUUID as nodeRandomUUID } from 'node:crypto';
import { clampLimit } from './column-guard.js';

export function createWealthNamespace(deps) {
  if (!deps) throw new TypeError('createWealthNamespace: deps required');
  const { d1Query, d1Batch, randomUUID = nodeRandomUUID } = deps;
  if (typeof d1Query !== 'function') throw new TypeError('createWealthNamespace: d1Query required');
  if (typeof d1Batch !== 'function') throw new TypeError('createWealthNamespace: d1Batch required');

  return {
    // ── Portfolios ──────────────────────────────────────────────────────────

    async listPortfolios(userId) {
      const result = await d1Query(
        `SELECT p.*, pa.role
         FROM wealth_portfolios p
         JOIN wealth_portfolio_access pa ON pa.portfolio_id = p.id
         WHERE pa.user_id = ?
         ORDER BY p.created_at`,
        [userId],
      );
      return result.results || [];
    },

    async getPortfolio(portfolioId, userId) {
      const result = await d1Query(
        `SELECT p.*, pa.role
         FROM wealth_portfolios p
         JOIN wealth_portfolio_access pa ON pa.portfolio_id = p.id
         WHERE p.id = ? AND pa.user_id = ?`,
        [portfolioId, userId],
      );
      return result.results?.[0] || null;
    },

    async createPortfolio(userId, name, baseCurrency = 'EUR', type = 'personal') {
      const id = randomUUID();
      await d1Batch([
        {
          sql: `INSERT INTO wealth_portfolios (id, name, type, base_currency) VALUES (?, ?, ?, ?)`,
          params: [id, name, type, baseCurrency],
        },
        {
          sql: `INSERT INTO wealth_portfolio_access (portfolio_id, user_id, role) VALUES (?, ?, 'owner')`,
          params: [id, userId],
        },
      ]);
      return { id, name, type, base_currency: baseCurrency };
    },

    async deletePortfolio(portfolioId, userId) {
      // Only owner can delete — cascade cleanup is manual since D1 has
      // no enforced FKs on these tables.
      const access = await d1Query(
        `SELECT role FROM wealth_portfolio_access WHERE portfolio_id = ? AND user_id = ?`,
        [portfolioId, userId],
      );
      if (access.results?.[0]?.role !== 'owner') throw new Error('Only owner can delete portfolio');
      await d1Batch([
        { sql: `DELETE FROM wealth_transactions WHERE portfolio_id = ?`,      params: [portfolioId] },
        { sql: `DELETE FROM wealth_positions WHERE portfolio_id = ?`,         params: [portfolioId] },
        { sql: `DELETE FROM wealth_snapshots WHERE portfolio_id = ?`,         params: [portfolioId] },
        { sql: `DELETE FROM wealth_portfolio_access WHERE portfolio_id = ?`,  params: [portfolioId] },
        { sql: `DELETE FROM wealth_portfolios WHERE id = ?`,                  params: [portfolioId] },
      ]);
    },

    async sharePortfolio(portfolioId, userId, targetUserId, role = 'viewer') {
      await d1Query(
        `INSERT OR REPLACE INTO wealth_portfolio_access (portfolio_id, user_id, role) VALUES (?, ?, ?)`,
        [portfolioId, targetUserId, role],
      );
    },

    async removePortfolioAccess(portfolioId, targetUserId) {
      await d1Query(
        `DELETE FROM wealth_portfolio_access WHERE portfolio_id = ? AND user_id = ?`,
        [portfolioId, targetUserId],
      );
    },

    // ── Assets ──────────────────────────────────────────────────────────────

    async getAsset(symbol, type) {
      const result = await d1Query(
        `SELECT * FROM wealth_assets WHERE symbol = ? AND type = ?`,
        [symbol, type],
      );
      return result.results?.[0] || null;
    },

    async getAssetById(id) {
      const result = await d1Query(
        `SELECT * FROM wealth_assets WHERE id = ?`,
        [id],
      );
      return result.results?.[0] || null;
    },

    async findAssets(query) {
      const result = await d1Query(
        `SELECT * FROM wealth_assets WHERE symbol LIKE ? OR name LIKE ? ORDER BY symbol LIMIT 20`,
        [`%${query}%`, `%${query}%`],
      );
      return result.results || [];
    },

    async upsertAsset({ symbol, name, type, exchange, currency, lookup_id, price_source }) {
      // Find-or-create by (symbol, type). If found, write back only the
      // provided fields; unspecified fields retain the existing value.
      // `exchange` and `lookup_id` use ?? because empty string is a
      // meaningful value (different from "not provided").
      const existing = await d1Query(
        `SELECT * FROM wealth_assets WHERE symbol = ? AND type = ?`,
        [symbol, type],
      );
      if (existing.results?.[0]) {
        const asset = existing.results[0];
        await d1Query(
          `UPDATE wealth_assets SET name = ?, exchange = ?, currency = ?, lookup_id = ?, price_source = ? WHERE id = ?`,
          [name || asset.name, exchange ?? asset.exchange, currency || asset.currency,
           lookup_id ?? asset.lookup_id, price_source || asset.price_source, asset.id],
        );
        return {
          ...asset,
          name:         name         || asset.name,
          exchange:     exchange     ?? asset.exchange,
          currency:     currency     || asset.currency,
          lookup_id:    lookup_id    ?? asset.lookup_id,
          price_source: price_source || asset.price_source,
        };
      }
      const id = randomUUID();
      await d1Query(
        `INSERT INTO wealth_assets (id, symbol, name, type, exchange, currency, lookup_id, price_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, symbol, name, type, exchange || null, currency, lookup_id || null, price_source || 'manual'],
      );
      return { id, symbol, name, type, exchange, currency, lookup_id, price_source };
    },

    // ── Transactions ────────────────────────────────────────────────────────

    async addTransaction(tx) {
      const id = randomUUID();
      await d1Query(
        `INSERT INTO wealth_transactions (id, portfolio_id, asset_id, type, quantity, price_per_unit, currency, exchange_rate, fees, transacted_at, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, tx.portfolio_id, tx.asset_id, tx.type, tx.quantity, tx.price_per_unit,
         tx.currency, tx.exchange_rate || 1, tx.fees || 0, tx.transacted_at, tx.notes || null],
      );
      return id;
    },

    async editTransaction(transactionId, fields) {
      const allowed = ['portfolio_id', 'asset_id', 'type', 'quantity', 'price_per_unit',
                       'currency', 'exchange_rate', 'fees', 'transacted_at', 'notes'];
      const sets = [];
      const params = [];
      for (const [key, val] of Object.entries(fields)) {
        if (allowed.includes(key)) {
          sets.push(`${key} = ?`);
          params.push(val);
        }
      }
      if (sets.length === 0) return;
      params.push(transactionId);
      await d1Query(`UPDATE wealth_transactions SET ${sets.join(', ')} WHERE id = ?`, params);
    },

    async deleteTransaction(transactionId) {
      const result = await d1Query(
        `SELECT portfolio_id, asset_id FROM wealth_transactions WHERE id = ?`,
        [transactionId],
      );
      const tx = result.results?.[0];
      if (!tx) throw new Error('Transaction not found');
      await d1Query(`DELETE FROM wealth_transactions WHERE id = ?`, [transactionId]);
      return tx; // Caller uses this to recalculate the affected position.
    },

    async getTransaction(transactionId) {
      const result = await d1Query(
        `SELECT * FROM wealth_transactions WHERE id = ?`,
        [transactionId],
      );
      return result.results?.[0] || null;
    },

    async listTransactions(portfolioId, { symbol, type, asset_id, from, to, limit = 100 } = {}) {
      limit = clampLimit(limit, 100);
      let sql = `SELECT t.*, a.symbol, a.name as asset_name, a.type as asset_type
                  FROM wealth_transactions t
                  JOIN wealth_assets a ON a.id = t.asset_id
                  WHERE t.portfolio_id = ?`;
      const params = [portfolioId];
      if (asset_id) { sql += ` AND t.asset_id = ?`;         params.push(asset_id); }
      if (symbol)   { sql += ` AND a.symbol = ?`;           params.push(symbol); }
      if (type)     { sql += ` AND t.type = ?`;             params.push(type); }
      if (from)     { sql += ` AND t.transacted_at >= ?`;   params.push(from); }
      if (to)       { sql += ` AND t.transacted_at <= ?`;   params.push(to); }
      sql += ` ORDER BY t.transacted_at DESC LIMIT ?`;
      params.push(limit);
      const result = await d1Query(sql, params);
      return result.results || [];
    },

    // ── Positions ───────────────────────────────────────────────────────────

    async getPositions(portfolioId) {
      const result = await d1Query(
        `SELECT p.*, a.symbol, a.name as asset_name, a.type as asset_type, a.currency, a.price_source, a.lookup_id
         FROM wealth_positions p
         JOIN wealth_assets a ON a.id = p.asset_id
         WHERE p.portfolio_id = ? AND p.quantity != 0
         ORDER BY p.total_invested DESC`,
        [portfolioId],
      );
      return result.results || [];
    },

    /**
     * Replay all transactions for (portfolio, asset) in chronological
     * order to derive the current position. The running state is
     * (quantity, totalCost, realizedPnl) in portfolio base currency.
     *
     * Semantics:
     *   buy / transfer_in / staking_reward → add quantity at cost
     *   sell                                → reduce at avg cost, book P&L
     *   transfer_out                        → reduce at avg cost (no P&L)
     *   dividend                            → income only (price_per_unit = total)
     */
    async recalculatePosition(portfolioId, assetId) {
      const result = await d1Query(
        `SELECT * FROM wealth_transactions WHERE portfolio_id = ? AND asset_id = ? ORDER BY transacted_at ASC`,
        [portfolioId, assetId],
      );
      const txs = result.results || [];

      let quantity = 0;
      let totalCost = 0; // in portfolio base currency
      let realizedPnl = 0;

      for (const tx of txs) {
        const costInBase = tx.price_per_unit * tx.exchange_rate;
        switch (tx.type) {
          case 'buy':
          case 'transfer_in':
          case 'staking_reward':
            totalCost += tx.quantity * costInBase + (tx.fees || 0) * tx.exchange_rate;
            quantity += tx.quantity;
            break;
          case 'sell':
          case 'transfer_out': {
            const avgCost = quantity > 0 ? totalCost / quantity : 0;
            const proceeds = tx.quantity * costInBase - (tx.fees || 0) * tx.exchange_rate;
            if (tx.type === 'sell') {
              realizedPnl += proceeds - tx.quantity * avgCost;
            }
            totalCost -= tx.quantity * avgCost;
            quantity  -= tx.quantity;
            break;
          }
          case 'dividend':
            realizedPnl += tx.price_per_unit * tx.exchange_rate;
            break;
        }
      }

      const avgCostBasis = quantity > 0 ? totalCost / quantity : 0;

      await d1Query(
        `INSERT OR REPLACE INTO wealth_positions (portfolio_id, asset_id, quantity, avg_cost_basis, total_invested, realized_pnl)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [portfolioId, assetId, quantity, avgCostBasis, totalCost, realizedPnl],
      );

      return { quantity, avg_cost_basis: avgCostBasis, total_invested: totalCost, realized_pnl: realizedPnl };
    },

    // ── Snapshots ───────────────────────────────────────────────────────────

    async recordSnapshot(portfolioId, date, totalValue, currency) {
      await d1Query(
        `INSERT OR REPLACE INTO wealth_snapshots (portfolio_id, date, total_value, currency) VALUES (?, ?, ?, ?)`,
        [portfolioId, date, totalValue, currency],
      );
    },

    async getSnapshots(portfolioId, { from, to, limit = 365 } = {}) {
      let sql = `SELECT * FROM wealth_snapshots WHERE portfolio_id = ?`;
      const params = [portfolioId];
      if (from) { sql += ` AND date >= ?`; params.push(from); }
      if (to)   { sql += ` AND date <= ?`; params.push(to); }
      sql += ` ORDER BY date ASC LIMIT ?`;
      params.push(limit);
      const result = await d1Query(sql, params);
      return result.results || [];
    },

    // ── Watchlist ───────────────────────────────────────────────────────────

    async getWatchlist(userId) {
      const result = await d1Query(
        `SELECT w.*, a.symbol, a.name as asset_name, a.type as asset_type, a.currency, a.price_source, a.lookup_id
         FROM wealth_watchlist w
         JOIN wealth_assets a ON a.id = w.asset_id
         WHERE w.user_id = ?
         ORDER BY w.added_at DESC`,
        [userId],
      );
      return result.results || [];
    },

    async addToWatchlist(userId, assetId, { targetHigh, targetLow, notes } = {}) {
      await d1Query(
        `INSERT OR REPLACE INTO wealth_watchlist (user_id, asset_id, target_price_high, target_price_low, notes) VALUES (?, ?, ?, ?, ?)`,
        [userId, assetId, targetHigh || null, targetLow || null, notes || null],
      );
    },

    async removeFromWatchlist(userId, assetId) {
      await d1Query(
        `DELETE FROM wealth_watchlist WHERE user_id = ? AND asset_id = ?`,
        [userId, assetId],
      );
    },
  };
}
