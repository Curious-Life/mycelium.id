#!/usr/bin/env node
/**
 * Wealth Module MCP Tools Server
 *
 * Portfolio management tools for Rob (wealth-agent).
 * Handles D1 operations for portfolios, transactions, positions, watchlist.
 * Market data fetching is done by Rob via bash/curl — NOT here.
 *
 * Tools (12):
 *   Portfolios:   listPortfolios, createPortfolio, sharePortfolio, removePortfolioAccess
 *   Transactions:  addTransaction, editTransaction, deleteTransaction, listTransactions
 *   Positions:     getPositions, getPerformance
 *   Watchlist:     getWatchlist, addToWatchlist, removeFromWatchlist
 *   Assets:        getAsset, findAssets
 *   Snapshots:     recordSnapshot
 *
 * Config (env vars):
 *   USER_ID            — User UUID (required)
 *   MYA_WORKER_URL     — MYA Cloudflare Worker (required)
 *   MYA_WORKER_SECRET  — Shared auth secret (required)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { initDb, getDb } from '../lib/db.js';

// ── Config ──────────────────────────────────────────────────────────────────

const USER_ID = process.env.USER_ID;

if (!USER_ID) {
  console.error('Missing required env var: USER_ID');
  process.exit(1);
}

let db = null;

// ── Tools ───────────────────────────────────────────────────────────────────

const TOOLS = [
  // -- Portfolios --
  {
    name: 'listPortfolios',
    description: 'List all portfolios the current user has access to, with their role (owner/editor/viewer).',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'createPortfolio',
    description: 'Create a new portfolio. Returns the new portfolio object.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Portfolio name, e.g. "Personal", "Shared with Nate"' },
        baseCurrency: { type: 'string', description: 'Base currency (ISO 4217), default EUR', default: 'EUR' },
        type: { type: 'string', description: 'Portfolio type: personal, shared, agent_managed', default: 'personal' },
      },
      required: ['name'],
    },
  },
  {
    name: 'sharePortfolio',
    description: 'Grant a user access to a portfolio. Requires owner role.',
    inputSchema: {
      type: 'object',
      properties: {
        portfolioId: { type: 'string', description: 'Portfolio ID' },
        targetUserId: { type: 'string', description: 'User ID to grant access to' },
        role: { type: 'string', description: 'Role: viewer, editor', default: 'viewer' },
      },
      required: ['portfolioId', 'targetUserId'],
    },
  },
  {
    name: 'removePortfolioAccess',
    description: 'Remove a user\'s access to a portfolio. Requires owner role.',
    inputSchema: {
      type: 'object',
      properties: {
        portfolioId: { type: 'string', description: 'Portfolio ID' },
        targetUserId: { type: 'string', description: 'User ID to remove' },
      },
      required: ['portfolioId', 'targetUserId'],
    },
  },

  // -- Assets --
  {
    name: 'getAsset',
    description: 'Look up an asset by symbol and type. Returns asset details including lookup_id and price_source.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Asset symbol (e.g. NVDA, BTC, EUR, XAU)' },
        type: { type: 'string', description: 'Asset type: stock, etf, crypto, commodity, prediction, cash, other' },
      },
      required: ['symbol', 'type'],
    },
  },
  {
    name: 'findAssets',
    description: 'Search for assets by symbol or name. Returns up to 20 matches.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (matches symbol or name)' },
      },
      required: ['query'],
    },
  },

  // -- Transactions --
  {
    name: 'addTransaction',
    description: `Record a buy, sell, dividend, staking reward, or transfer. Auto-creates the asset if it doesn't exist yet.
After adding, the position is automatically recalculated.

Transaction types:
- buy/sell: standard trades. quantity = units, price_per_unit = price per unit.
- dividend: cash distribution. quantity = 0, price_per_unit = total dividend amount.
- staking_reward: crypto yield. quantity = tokens received, price_per_unit = market price at receipt.
- transfer_in/transfer_out: moving assets between wallets/brokers (no P&L impact).`,
    inputSchema: {
      type: 'object',
      properties: {
        portfolioId: { type: 'string', description: 'Portfolio ID' },
        symbol: { type: 'string', description: 'Asset symbol (e.g. NVDA, BTC, EUR)' },
        assetName: { type: 'string', description: 'Full asset name (e.g. "NVIDIA Corp", "Bitcoin")' },
        assetType: { type: 'string', description: 'Asset type: stock, etf, crypto, commodity, prediction, cash, other' },
        exchange: { type: 'string', description: 'Exchange (optional, e.g. NASDAQ, XETRA)' },
        lookupId: { type: 'string', description: 'External API identifier (Yahoo symbol, CoinGecko slug, etc.)' },
        priceSource: { type: 'string', description: 'Price source: yahoo, coingecko, polymarket, metal_api, fx, manual' },
        type: { type: 'string', description: 'Transaction type: buy, sell, dividend, staking_reward, transfer_in, transfer_out' },
        quantity: { type: 'number', description: 'Number of units (0 for cash-only events like dividends)' },
        pricePerUnit: { type: 'number', description: 'Price per unit in transaction currency' },
        currency: { type: 'string', description: 'Transaction currency (ISO 4217)' },
        exchangeRate: { type: 'number', description: 'Exchange rate to portfolio base currency. 1.0 if same currency.' },
        fees: { type: 'number', description: 'Transaction fees in transaction currency (default 0)' },
        date: { type: 'string', description: 'Transaction date (ISO 8601, e.g. 2024-03-15 or 2024-03-15T14:30:00Z)' },
        notes: { type: 'string', description: 'Optional notes (broker, reason, context)' },
      },
      required: ['portfolioId', 'symbol', 'assetName', 'assetType', 'priceSource', 'type', 'quantity', 'pricePerUnit', 'currency', 'date'],
    },
  },
  {
    name: 'editTransaction',
    description: 'Edit an existing transaction. Only specify fields to change. Position is recalculated after.',
    inputSchema: {
      type: 'object',
      properties: {
        transactionId: { type: 'string', description: 'Transaction ID' },
        type: { type: 'string', description: 'Transaction type' },
        quantity: { type: 'number' },
        pricePerUnit: { type: 'number' },
        currency: { type: 'string' },
        exchangeRate: { type: 'number' },
        fees: { type: 'number' },
        date: { type: 'string', description: 'Transaction date (ISO 8601)' },
        notes: { type: 'string' },
      },
      required: ['transactionId'],
    },
  },
  {
    name: 'deleteTransaction',
    description: 'Delete a transaction. Position is recalculated after.',
    inputSchema: {
      type: 'object',
      properties: {
        transactionId: { type: 'string', description: 'Transaction ID' },
      },
      required: ['transactionId'],
    },
  },
  {
    name: 'listTransactions',
    description: 'List transactions for a portfolio with optional filters.',
    inputSchema: {
      type: 'object',
      properties: {
        portfolioId: { type: 'string', description: 'Portfolio ID' },
        symbol: { type: 'string', description: 'Filter by asset symbol' },
        type: { type: 'string', description: 'Filter by transaction type' },
        from: { type: 'string', description: 'Filter from date (ISO 8601)' },
        to: { type: 'string', description: 'Filter to date (ISO 8601)' },
        limit: { type: 'number', description: 'Max results (default 100)' },
      },
      required: ['portfolioId'],
    },
  },

  // -- Positions --
  {
    name: 'getPositions',
    description: 'Get all current positions for a portfolio. Returns quantities, cost basis, and asset details. Live prices must be fetched separately via curl.',
    inputSchema: {
      type: 'object',
      properties: {
        portfolioId: { type: 'string', description: 'Portfolio ID' },
      },
      required: ['portfolioId'],
    },
  },
  {
    name: 'getPerformance',
    description: 'Get portfolio performance over time from daily snapshots.',
    inputSchema: {
      type: 'object',
      properties: {
        portfolioId: { type: 'string', description: 'Portfolio ID' },
        from: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
        to: { type: 'string', description: 'End date (YYYY-MM-DD)' },
      },
      required: ['portfolioId'],
    },
  },

  // -- Watchlist --
  {
    name: 'getWatchlist',
    description: 'Get the user\'s watchlist with target prices.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'addToWatchlist',
    description: 'Add an asset to the watchlist with optional price alerts.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Asset symbol' },
        assetType: { type: 'string', description: 'Asset type: stock, etf, crypto, etc.' },
        targetPriceHigh: { type: 'number', description: 'Alert when price goes above this' },
        targetPriceLow: { type: 'number', description: 'Alert when price drops below this' },
        notes: { type: 'string', description: 'Why watching, thesis, etc.' },
      },
      required: ['symbol', 'assetType'],
    },
  },
  {
    name: 'removeFromWatchlist',
    description: 'Remove an asset from the watchlist.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Asset symbol' },
        assetType: { type: 'string', description: 'Asset type' },
      },
      required: ['symbol', 'assetType'],
    },
  },

  // -- Snapshots --
  {
    name: 'recordSnapshot',
    description: 'Record a daily portfolio value snapshot. Called by the daily watcher after fetching live prices.',
    inputSchema: {
      type: 'object',
      properties: {
        portfolioId: { type: 'string', description: 'Portfolio ID' },
        date: { type: 'string', description: 'Date (YYYY-MM-DD)' },
        totalValue: { type: 'number', description: 'Total portfolio value in base currency' },
      },
      required: ['portfolioId', 'date', 'totalValue'],
    },
  },
];

// ── Tool Handler ────────────────────────────────────────────────────────────

async function handleTool(name, args) {
  switch (name) {
    // -- Portfolios --

    case 'listPortfolios': {
      const portfolios = await db.wealth.listPortfolios(USER_ID);
      if (portfolios.length === 0) return 'No portfolios found. Use createPortfolio to create one.';
      return JSON.stringify(portfolios, null, 2);
    }

    case 'createPortfolio': {
      const portfolio = await db.wealth.createPortfolio(
        USER_ID,
        args.name,
        args.baseCurrency || 'EUR',
        args.type || 'personal',
      );
      return `Portfolio created: ${JSON.stringify(portfolio, null, 2)}`;
    }

    case 'sharePortfolio': {
      // Verify caller is owner
      const portfolio = await db.wealth.getPortfolio(args.portfolioId, USER_ID);
      if (!portfolio) return 'Error: Portfolio not found or no access.';
      if (portfolio.role !== 'owner') return 'Error: Only the portfolio owner can share it.';
      await db.wealth.sharePortfolio(args.portfolioId, USER_ID, args.targetUserId, args.role || 'viewer');
      return `Access granted: user ${args.targetUserId} now has ${args.role || 'viewer'} access.`;
    }

    case 'removePortfolioAccess': {
      const portfolio = await db.wealth.getPortfolio(args.portfolioId, USER_ID);
      if (!portfolio) return 'Error: Portfolio not found or no access.';
      if (portfolio.role !== 'owner') return 'Error: Only the portfolio owner can remove access.';
      await db.wealth.removePortfolioAccess(args.portfolioId, args.targetUserId);
      return `Access removed for user ${args.targetUserId}.`;
    }

    // -- Assets --

    case 'getAsset': {
      const asset = await db.wealth.getAsset(args.symbol, args.type);
      if (!asset) return `No asset found for symbol=${args.symbol}, type=${args.type}. It will be auto-created when you add a transaction.`;
      return JSON.stringify(asset, null, 2);
    }

    case 'findAssets': {
      const assets = await db.wealth.findAssets(args.query);
      if (assets.length === 0) return `No assets found matching "${args.query}".`;
      return JSON.stringify(assets, null, 2);
    }

    // -- Transactions --

    case 'addTransaction': {
      // Verify portfolio access
      const portfolio = await db.wealth.getPortfolio(args.portfolioId, USER_ID);
      if (!portfolio) return 'Error: Portfolio not found or no access.';
      if (portfolio.role === 'viewer') return 'Error: Viewers cannot add transactions.';

      // Upsert asset
      const asset = await db.wealth.upsertAsset({
        symbol: args.symbol,
        name: args.assetName,
        type: args.assetType,
        exchange: args.exchange || null,
        currency: args.currency,
        lookup_id: args.lookupId || null,
        price_source: args.priceSource,
      });

      // Add transaction
      const txId = await db.wealth.addTransaction({
        portfolio_id: args.portfolioId,
        asset_id: asset.id,
        type: args.type,
        quantity: args.quantity,
        price_per_unit: args.pricePerUnit,
        currency: args.currency,
        exchange_rate: args.exchangeRate || 1,
        fees: args.fees || 0,
        transacted_at: args.date,
        notes: args.notes || null,
      });

      // Recalculate position
      const position = await db.wealth.recalculatePosition(args.portfolioId, asset.id);

      return `Transaction recorded (ID: ${txId}).
Asset: ${asset.symbol} (${asset.name})
Type: ${args.type} | Qty: ${args.quantity} | Price: ${args.pricePerUnit} ${args.currency}
Updated position: ${position.quantity} units, avg cost: ${position.avg_cost_basis.toFixed(4)} ${portfolio.base_currency}`;
    }

    case 'editTransaction': {
      const tx = await db.wealth.getTransaction(args.transactionId);
      if (!tx) return 'Error: Transaction not found.';

      // Verify access
      const portfolio = await db.wealth.getPortfolio(tx.portfolio_id, USER_ID);
      if (!portfolio) return 'Error: No access to this transaction\'s portfolio.';
      if (portfolio.role === 'viewer') return 'Error: Viewers cannot edit transactions.';

      const fields = {};
      if (args.type) fields.type = args.type;
      if (args.quantity !== undefined) fields.quantity = args.quantity;
      if (args.pricePerUnit !== undefined) fields.price_per_unit = args.pricePerUnit;
      if (args.currency) fields.currency = args.currency;
      if (args.exchangeRate !== undefined) fields.exchange_rate = args.exchangeRate;
      if (args.fees !== undefined) fields.fees = args.fees;
      if (args.date) fields.transacted_at = args.date;
      if (args.notes !== undefined) fields.notes = args.notes;

      await db.wealth.editTransaction(args.transactionId, fields);
      const position = await db.wealth.recalculatePosition(tx.portfolio_id, tx.asset_id);

      return `Transaction ${args.transactionId} updated. Position recalculated: ${position.quantity} units, avg cost: ${position.avg_cost_basis.toFixed(4)}`;
    }

    case 'deleteTransaction': {
      const tx = await db.wealth.getTransaction(args.transactionId);
      if (!tx) return 'Error: Transaction not found.';

      const portfolio = await db.wealth.getPortfolio(tx.portfolio_id, USER_ID);
      if (!portfolio) return 'Error: No access to this transaction\'s portfolio.';
      if (portfolio.role === 'viewer') return 'Error: Viewers cannot delete transactions.';

      const deleted = await db.wealth.deleteTransaction(args.transactionId);
      const position = await db.wealth.recalculatePosition(deleted.portfolio_id, deleted.asset_id);

      return `Transaction deleted. Position recalculated: ${position.quantity} units, avg cost: ${position.avg_cost_basis.toFixed(4)}`;
    }

    case 'listTransactions': {
      const portfolio = await db.wealth.getPortfolio(args.portfolioId, USER_ID);
      if (!portfolio) return 'Error: Portfolio not found or no access.';

      const txs = await db.wealth.listTransactions(args.portfolioId, {
        symbol: args.symbol,
        type: args.type,
        from: args.from,
        to: args.to,
        limit: args.limit,
      });

      if (txs.length === 0) return 'No transactions found.';
      return JSON.stringify(txs, null, 2);
    }

    // -- Positions --

    case 'getPositions': {
      const portfolio = await db.wealth.getPortfolio(args.portfolioId, USER_ID);
      if (!portfolio) return 'Error: Portfolio not found or no access.';

      const positions = await db.wealth.getPositions(args.portfolioId);
      if (positions.length === 0) return 'No positions in this portfolio yet.';

      return `Portfolio: ${portfolio.name} (${portfolio.base_currency})\n\n` +
        JSON.stringify(positions, null, 2);
    }

    case 'getPerformance': {
      const portfolio = await db.wealth.getPortfolio(args.portfolioId, USER_ID);
      if (!portfolio) return 'Error: Portfolio not found or no access.';

      const snapshots = await db.wealth.getSnapshots(args.portfolioId, {
        from: args.from,
        to: args.to,
      });

      if (snapshots.length === 0) return 'No snapshots yet. Performance data will be available after daily snapshots start.';

      const first = snapshots[0];
      const last = snapshots[snapshots.length - 1];
      const change = last.total_value - first.total_value;
      const pctChange = first.total_value > 0 ? (change / first.total_value * 100) : 0;

      return `Portfolio: ${portfolio.name} (${portfolio.base_currency})
Period: ${first.date} → ${last.date} (${snapshots.length} data points)
Start value: ${first.total_value.toFixed(2)} ${first.currency}
End value: ${last.total_value.toFixed(2)} ${last.currency}
Change: ${change >= 0 ? '+' : ''}${change.toFixed(2)} (${pctChange >= 0 ? '+' : ''}${pctChange.toFixed(2)}%)

Daily values:\n` + JSON.stringify(snapshots, null, 2);
    }

    // -- Watchlist --

    case 'getWatchlist': {
      const items = await db.wealth.getWatchlist(USER_ID);
      if (items.length === 0) return 'Watchlist is empty.';
      return JSON.stringify(items, null, 2);
    }

    case 'addToWatchlist': {
      const asset = await db.wealth.getAsset(args.symbol, args.assetType);
      if (!asset) return `Error: Asset ${args.symbol} (${args.assetType}) not found. Add it by creating a transaction first, or use getAsset to check the symbol.`;
      await db.wealth.addToWatchlist(USER_ID, asset.id, {
        targetHigh: args.targetPriceHigh,
        targetLow: args.targetPriceLow,
        notes: args.notes,
      });
      return `Added ${asset.symbol} (${asset.name}) to watchlist.${args.targetPriceHigh ? ` Alert high: ${args.targetPriceHigh}` : ''}${args.targetPriceLow ? ` Alert low: ${args.targetPriceLow}` : ''}`;
    }

    case 'removeFromWatchlist': {
      const asset = await db.wealth.getAsset(args.symbol, args.assetType);
      if (!asset) return `Asset ${args.symbol} (${args.assetType}) not found.`;
      await db.wealth.removeFromWatchlist(USER_ID, asset.id);
      return `Removed ${asset.symbol} from watchlist.`;
    }

    // -- Snapshots --

    case 'recordSnapshot': {
      const portfolio = await db.wealth.getPortfolio(args.portfolioId, USER_ID);
      if (!portfolio) return 'Error: Portfolio not found or no access.';
      await db.wealth.recordSnapshot(args.portfolioId, args.date, args.totalValue, portfolio.base_currency);
      return `Snapshot recorded: ${portfolio.name} = ${args.totalValue.toFixed(2)} ${portfolio.base_currency} on ${args.date}`;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── MCP Server Setup ────────────────────────────────────────────────────────

const server = new Server(
  { name: 'wealth-tools', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const result = await handleTool(name, args || {});
    return { content: [{ type: 'text', text: result }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error in ${name}: ${err.message}` }],
      isError: true,
    };
  }
});

// ── Start ───────────────────────────────────────────────────────────────────

db = await initDb();

const transport = new StdioServerTransport();
await server.connect(transport);
