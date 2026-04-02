#!/usr/bin/env node
/**
 * Polymarket Intelligence MCP Tools Server
 *
 * Prediction market data tools for Rex (commercial-intelligence-agent).
 * Wraps the prediction market signal API with smart money tracking,
 * entity analysis, and ranked recommendations.
 *
 * Tools (5):
 *   getRecommendations  — Ranked trading signals with entity data
 *   getSignals          — Raw signal feed (whale, smart money, volume spikes)
 *   searchMarkets       — Search markets by keyword
 *   getMarketDetail     — Deep detail: signals, smart wallet trades, entity positions
 *   getEntities         — Entity cluster stats
 *
 * Config (env vars):
 *   POLYMARKET_API_URL      — Base URL for the signal API (required)
 *   POLYMARKET_API_USER     — HTTP Basic auth username (required)
 *   POLYMARKET_API_PASSWORD — HTTP Basic auth password (required)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// ── Config ──────────────────────────────────────────────────────────────────

const API_URL = process.env.POLYMARKET_API_URL;
const API_USER = process.env.POLYMARKET_API_USER;
const API_PASSWORD = process.env.POLYMARKET_API_PASSWORD;

if (!API_URL || !API_USER || !API_PASSWORD) {
  console.error('Missing required env vars: POLYMARKET_API_URL, POLYMARKET_API_USER, POLYMARKET_API_PASSWORD');
  process.exit(1);
}

const AUTH_HEADER = 'Basic ' + Buffer.from(`${API_USER}:${API_PASSWORD}`).toString('base64');

// ── API Helper ──────────────────────────────────────────────────────────────

async function apiFetch(endpoint, params = {}) {
  const url = new URL(endpoint, API_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url.toString(), {
    headers: {
      'Authorization': AUTH_HEADER,
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`API ${response.status}: ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`);
  }

  return response.json();
}

// ── Tools ───────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'getRecommendations',
    description: `Get ranked trading signals with entity data from prediction markets. Returns pre-ranked high-confidence opportunities across all markets. Best starting point for finding actionable trades.

Each recommendation includes: market question, confidence score, signal types that triggered it, entity positions, and current pricing.`,
    inputSchema: {
      type: 'object',
      properties: {
        hours: { type: 'number', description: 'Lookback window in hours (default: 24)' },
        min_conf: { type: 'number', description: 'Minimum confidence threshold 0-1 (default: 0.5)' },
        limit: { type: 'number', description: 'Max results (default: 20)' },
      },
      required: [],
    },
  },
  {
    name: 'getSignals',
    description: `Get raw signal feed from prediction markets. Signal types:
- stealth_whale: Large positions built gradually to avoid detection
- whale_entry: Single large trade by a known whale
- smart_convergence: Multiple smart wallets taking the same position
- smart_accumulation: Smart money steadily building a position
- volume_spike: Unusual volume surge on a market

Use this for monitoring specific signal types or getting the raw firehose of market activity.`,
    inputSchema: {
      type: 'object',
      properties: {
        hours: { type: 'number', description: 'Lookback window in hours (default: 24)' },
        signal_type: { type: 'string', description: 'Filter by signal type: stealth_whale, whale_entry, smart_convergence, smart_accumulation, volume_spike' },
        limit: { type: 'number', description: 'Max results (default: 50)' },
      },
      required: [],
    },
  },
  {
    name: 'searchMarkets',
    description: `Search prediction markets by keyword. Use this to find markets about specific topics — e.g. "war", "tariff", "trump", "fed", "bitcoin", "election".

Returns matching markets with their current status and pricing. Follow up with getMarketDetail on interesting results to see smart money positioning.`,
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Search keyword (e.g. "war", "tariff", "bitcoin")' },
        active_only: { type: 'boolean', description: 'Only return active markets (default: true)' },
        limit: { type: 'number', description: 'Max results (default: 20)' },
      },
      required: ['q'],
    },
  },
  {
    name: 'getMarketDetail',
    description: `Get deep detail on a specific prediction market by its condition ID. Returns:
- Market info and current pricing
- All signals detected on this market
- Smart wallet trades and positions
- Entity cluster analysis

Use this after searchMarkets or getRecommendations to drill into a specific market.`,
    inputSchema: {
      type: 'object',
      properties: {
        condition_id: { type: 'string', description: 'Market condition ID (from search or recommendations results)' },
      },
      required: ['condition_id'],
    },
  },
  {
    name: 'getEntities',
    description: `Get entity cluster statistics. Entities are clusters of wallets identified as belonging to the same actor (whale, fund, market maker, etc.).

Returns entity profiles with their historical accuracy, total volume, and recent activity.`,
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default: 50)' },
      },
      required: [],
    },
  },
];

// ── Tool Handler ────────────────────────────────────────────────────────────

async function handleTool(name, args) {
  switch (name) {
    case 'getRecommendations': {
      const data = await apiFetch('/api/recommendations', {
        hours: args.hours,
        min_conf: args.min_conf,
        limit: args.limit,
      });
      if (!data || (Array.isArray(data) && data.length === 0)) {
        return 'No recommendations found for the given criteria. Try increasing the hours window or lowering min_conf.';
      }
      return JSON.stringify(data, null, 2);
    }

    case 'getSignals': {
      const data = await apiFetch('/api/signals', {
        hours: args.hours,
        signal_type: args.signal_type,
        limit: args.limit,
      });
      if (!data || (Array.isArray(data) && data.length === 0)) {
        return 'No signals found. Try increasing the hours window or removing the signal_type filter.';
      }
      return JSON.stringify(data, null, 2);
    }

    case 'searchMarkets': {
      const data = await apiFetch('/api/search', {
        q: args.q,
        active_only: args.active_only,
        limit: args.limit,
      });
      if (!data || (Array.isArray(data) && data.length === 0)) {
        return `No markets found for "${args.q}". Try different keywords.`;
      }
      return JSON.stringify(data, null, 2);
    }

    case 'getMarketDetail': {
      const data = await apiFetch(`/api/market/${args.condition_id}`);
      return JSON.stringify(data, null, 2);
    }

    case 'getEntities': {
      const data = await apiFetch('/api/entities', {
        limit: args.limit,
      });
      if (!data || (Array.isArray(data) && data.length === 0)) {
        return 'No entity data available.';
      }
      return JSON.stringify(data, null, 2);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── MCP Server Setup ────────────────────────────────────────────────────────

const server = new Server(
  { name: 'polymarket-tools', version: '1.0.0' },
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

const transport = new StdioServerTransport();
await server.connect(transport);
