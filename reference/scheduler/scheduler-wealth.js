/**
 * Scheduled Jobs for Wealth Agent (Rob)
 *
 * Monitors portfolios, tracks Polymarket positions, and manages trades.
 * Rob has autonomous trading authority on Polymarket — he trades first,
 * reports after. For traditional assets, he flags recommendations.
 *
 * Jobs:
 *   08:00  Morning portfolio review (daily)
 *   20:00  Evening portfolio review (daily)
 *   10:00  Weekly portfolio report (Sundays)
 *
 * Usage:
 *   Runs as a PM2 process with env vars from ecosystem.config.cjs.
 *   AGENT_URL=http://localhost:5010 USER_ID=<uuid> node lib/scheduler-wealth.js
 */

import './sentry.js';
import { tryGetDb } from './db.js';
import { writeFile, readFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

const CHECK_INTERVAL_MS = 60_000;

// Track which jobs ran to prevent duplicates
// Key format: 'YYYY-MM-DD:jobName'
const jobsRan = new Map();

let intervalId = null;
let config = null;

/**
 * Start the wealth scheduler.
 */
export async function startScheduler(opts) {
  config = {
    agentUrl: opts.agentUrl,
    userId: opts.userId,
    timezone: opts.timezone || null,
  };

  if (!config.timezone) {
    try {
      const db = tryGetDb();
      if (db) {
        const tz = await db.users.getTimezone(config.userId);
        config.timezone = tz || 'UTC';
      }
    } catch {
      config.timezone = 'UTC';
    }
  }
  config.timezone = config.timezone || 'UTC';

  console.log(`[ROB Scheduler] Started for user ${config.userId} (${config.timezone})`);
  console.log(`[ROB Scheduler] Agent URL: ${config.agentUrl}`);

  // Write wake-cycles.json so the agent can see and modify its cycles
  await writeWakeCycles();
  // Re-read wake-cycles.json every 5 minutes (picks up agent edits)
  setInterval(reloadWakeCycles, 5 * 60 * 1000);

  checkJobs();
  intervalId = setInterval(checkJobs, CHECK_INTERVAL_MS);
}

export function stopScheduler() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  console.log('[ROB Scheduler] Stopped');
}

// ── Wake Cycles File ──────────────────────────────────────────────────────

const AGENT_ID = process.env.AGENT_ID || 'wealth-agent';
const AGENTS_ROOT = process.env.AGENTS_ROOT || join(homedir(), 'agents');
const CYCLES_PATH = join(AGENTS_ROOT, AGENT_ID, 'wake-cycles.json');

// Default cycles — written to wake-cycles.json if not present
const DEFAULT_CYCLES = [
  { id: 'morning-review', description: 'Morning portfolio review — check overnight moves, scan news, execute trades if warranted', schedule: 'daily:8', maxTurns: 50, enabled: true },
  { id: 'market-evaluator', description: 'Market evaluation — scan 600+ Polymarket markets, web search for context, evaluate mispricings, update watchlist, execute trades', schedule: 'every:6h', maxTurns: 50, enabled: true },
  { id: 'evening-review', description: 'Evening portfolio review — assess day\'s performance, manage overnight exposure', schedule: 'daily:20', maxTurns: 50, enabled: true },
  { id: 'weekly-report', description: 'Comprehensive weekly portfolio and prediction market report', schedule: 'weekly:0:10', maxTurns: 50, enabled: true },
];

let activeCycles = null;
const lastFireTimes = new Map(); // cycleId → timestamp (for interval-based cycles)

async function writeWakeCycles() {
  try {
    const existing = await readFile(CYCLES_PATH, 'utf-8').catch(() => null);
    if (existing) {
      activeCycles = JSON.parse(existing);
      // Merge any new default cycles that don't exist in the file
      for (const def of DEFAULT_CYCLES) {
        if (!activeCycles.cycles.find(c => c.id === def.id)) {
          activeCycles.cycles.push(def);
          console.log(`[ROB Scheduler] Added missing default cycle: ${def.id}`);
        }
      }
      console.log(`[ROB Scheduler] Loaded ${activeCycles.cycles.length} wake cycles from file`);
      return;
    }
  } catch { /* ignore parse errors, overwrite */ }

  activeCycles = {
    agentId: AGENT_ID,
    timezone: config.timezone,
    cycles: DEFAULT_CYCLES,
  };
  await mkdir(join(AGENTS_ROOT, AGENT_ID), { recursive: true });
  await writeFile(CYCLES_PATH, JSON.stringify(activeCycles, null, 2));
  console.log(`[ROB Scheduler] Wrote default wake-cycles.json (${activeCycles.cycles.length} cycles)`);
}

async function reloadWakeCycles() {
  try {
    const data = await readFile(CYCLES_PATH, 'utf-8');
    const parsed = JSON.parse(data);
    if (parsed.cycles) activeCycles = parsed;
  } catch { /* keep existing */ }
}

// ── Schedule Parsing ─────────────────────────────────────────────────────

/**
 * Parse a schedule string into a structured object.
 * Formats:
 *   daily:HH           — fire at hour HH (0-23)
 *   weekly:DOW:HH      — fire on day of week (0=Sun) at hour HH
 *   every:Nh           — fire every N hours (at hours where hour % N === 0)
 *   interval:Nm        — fire every N minutes (minimum 30)
 */
function parseSchedule(schedule) {
  if (!schedule || typeof schedule !== 'string') return null;
  const parts = schedule.split(':');

  switch (parts[0]) {
    case 'daily': {
      const hour = parseInt(parts[1], 10);
      return !isNaN(hour) ? { type: 'daily', hour } : null;
    }
    case 'weekly': {
      const dow = parseInt(parts[1], 10);
      const hour = parseInt(parts[2], 10);
      return (!isNaN(dow) && !isNaN(hour)) ? { type: 'weekly', dayOfWeek: dow, hour } : null;
    }
    case 'every': {
      const match = parts[1]?.match(/^(\d+)h$/);
      return match ? { type: 'every', intervalHours: parseInt(match[1], 10) } : null;
    }
    case 'interval': {
      const match = parts[1]?.match(/^(\d+)m$/);
      if (!match) return null;
      const minutes = Math.max(30, parseInt(match[1], 10));
      return { type: 'interval', intervalMinutes: minutes };
    }
    default:
      return null;
  }
}

// Map built-in cycle IDs to their PROMPTS keys
const PROMPT_MAP = {
  'morning-review': () => PROMPTS.morningReview,
  'market-evaluator': () => PROMPTS.marketEvaluator,
  'evening-review': () => PROMPTS.eveningReview,
  'weekly-report': () => PROMPTS.weeklyReport,
};

function getPromptForCycle(cycle) {
  if (cycle.prompt) return cycle.prompt;
  const getter = PROMPT_MAP[cycle.id];
  if (getter) return getter();
  return cycle.description || '';
}

// ── Dynamic Job Scheduler ────────────────────────────────────────────────

function checkJobs() {
  if (!config) return;
  if (!activeCycles?.cycles) return;

  const now = new Date();
  const { hour, minute, dayOfWeek, dateKey } = getTimeInZone(now, config.timezone);
  const nowMs = Date.now();

  for (const cycle of activeCycles.cycles) {
    if (cycle.enabled === false) continue;
    if (cycle.status === 'paused' || cycle.status === 'cancelled') continue;
    if (!cycle.schedule) continue;

    const sched = parseSchedule(cycle.schedule);
    if (!sched) {
      if (!lastFireTimes.has(`_bad_${cycle.id}`)) {
        console.warn(`[ROB Scheduler] Bad schedule format for cycle '${cycle.id}': ${cycle.schedule}`);
        lastFireTimes.set(`_bad_${cycle.id}`, true);
      }
      continue;
    }

    const prompt = getPromptForCycle(cycle);
    if (!prompt) continue;

    const opts = { maxTurns: cycle.maxTurns || 50, timeout: 1_800_000 };

    switch (sched.type) {
      case 'interval': {
        const lastFire = lastFireTimes.get(cycle.id) || 0;
        if (nowMs - lastFire >= sched.intervalMinutes * 60_000) {
          lastFireTimes.set(cycle.id, nowMs);
          triggerIfNotRan(dateKey, `${cycle.id}-${hour}-${minute}`, prompt, opts);
        }
        break;
      }
      case 'every': {
        if (minute > 1) break;
        if (hour % sched.intervalHours === 0) {
          triggerIfNotRan(dateKey, `${cycle.id}-${hour}`, prompt, opts);
        }
        break;
      }
      case 'daily': {
        if (minute > 1) break;
        if (hour === sched.hour) {
          triggerIfNotRan(dateKey, cycle.id, prompt, opts);
        }
        break;
      }
      case 'weekly': {
        if (minute > 1) break;
        if (dayOfWeek === sched.dayOfWeek && hour === sched.hour) {
          triggerIfNotRan(dateKey, cycle.id, prompt, opts);
        }
        break;
      }
    }
  }
}

function triggerIfNotRan(dateKey, jobName, prompt, options = {}) {
  const key = `${dateKey}:${jobName}`;
  if (jobsRan.has(key)) return;

  jobsRan.set(key, true);
  console.log(`[ROB Scheduler] Triggering: ${jobName}`);

  fireThink(prompt, jobName, options).catch(err => {
    console.error(`[ROB Scheduler] ${jobName} failed:`, err.message);
    jobsRan.delete(key);
  });

  // Cleanup old date keys (keep last 3 days)
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 3);
  const cutoffKey = cutoff.toISOString().split('T')[0];
  for (const k of jobsRan.keys()) {
    if (k < cutoffKey) jobsRan.delete(k);
  }
}

async function fireThink(prompt, trigger, options = {}) {
  const body = { prompt, trigger };
  if (options.maxTurns) body.maxTurns = options.maxTurns;

  const fetchTimeout = options.timeout || 1_800_000;

  const thinkHeaders = { 'Content-Type': 'application/json' };
  if (process.env.AGENT_INTERNAL_SECRET) thinkHeaders['x-internal-secret'] = process.env.AGENT_INTERNAL_SECRET;
  const res = await fetch(`${config.agentUrl}/think`, {
    method: 'POST',
    headers: thinkHeaders,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(fetchTimeout),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`/think returned ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  if (data.skipped) {
    console.log(`[ROB Scheduler] ${trigger} skipped: ${data.reason}`);
  } else {
    console.log(`[ROB Scheduler] ${trigger} completed`);
  }
}

function getTimeInZone(date, timezone) {
  const hourFmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hour12: false });
  const minuteFmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, minute: 'numeric' });
  const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' });
  const dateFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: timezone });

  const hour = parseInt(hourFmt.format(date), 10) % 24;
  const minute = parseInt(minuteFmt.format(date), 10);
  const day = dayFmt.format(date);
  const dayOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(day);
  const dateKey = dateFmt.format(date);

  return { hour, minute, dayOfWeek, dateKey };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROMPTS
// ═══════════════════════════════════════════════════════════════════════════════

const PROMPTS = {

morningReview: `SCHEDULED: Morning Portfolio Review

This is your morning check-in. You are monitoring ALL portfolios — stocks, ETFs, crypto, commodities, and prediction markets.

== STEP 1: GATHER DATA (mandatory — do all of these) ==

1. Call listPortfolios() to see all portfolios
2. For each portfolio, call getPositions() to get current holdings with cost basis
3. For each portfolio, call listTransactions() with from=yesterday to see recent activity
4. Call getWatchlist() to check any watched assets or price alerts
5. For stocks/ETFs/crypto: use bash/curl to fetch current market prices (Yahoo Finance, CoinGecko, or other public APIs). Compare current prices to cost basis from positions.
6. For Polymarket positions: use bash/curl to check current prices on the Polymarket CLOB API. Compare to entry prices.
7. Check relevant news: market-moving headlines, earnings, macro events, geopolitical developments. Use bash/curl.
8. Record a daily snapshot with recordSnapshot() for each portfolio after fetching live prices.

== STEP 2: ANALYZE ==

For EACH portfolio and position type:

Traditional assets (stocks, ETFs, crypto, commodities):
- Overnight moves: what changed? Significant movers (>3% stocks, >5% crypto)?
- Any earnings or macro events today that affect holdings?
- Positions approaching your watchlist price targets (high or low)?
- Concentration risk: is any single position >25% of portfolio value?
- Cost basis comparison: which positions are in profit vs underwater, and by how much?

Prediction markets:
- Compare current odds vs entry prices
- Positions approaching expiry — what's the timeline?
- Has the thesis weakened or strengthened based on news?
- Exit opportunities: positions at 85c+ (lock in profit)
- Cut-loss situations: thesis invalidated

Cross-portfolio:
- Total exposure across all portfolios
- Correlation risk (are multiple bets on the same theme?)
- Cash positions and liquidity across portfolios

== STEP 3: TAKE ACTION ==

Polymarket: You have AUTONOMOUS AUTHORITY to trade.
- Sell at 85c+ (profit-taking) or when thesis invalidates. Execute the trade, don't just recommend.
- Buy if strong opportunity and available USDC.e balance. Don't overcommit.
- After any trade, record it with addTransaction().

Traditional assets: RECOMMEND only, do not trade.
- Flag specific buy/sell/rebalance suggestions with reasoning and target prices.
- Note any positions that need urgent attention.

== STEP 4: REPORT ==

Send a message to your Discord channel. Format:

**Morning Portfolio Check — [date]**
[One-line summary: calm / action needed / traded]

For each portfolio with positions:
- Portfolio name: total value, daily change
- Notable positions: [symbol]: [current price] vs [cost basis] ([+/-X%])

Predictions: [current prices vs entry for active Polymarket bets]
News: [relevant developments, 1-2 sentences each]
Actions taken: [any trades executed, with reasoning]
Recommendations: [suggested moves for traditional assets, if any]
Watchlist: [any alerts triggered or approaching]

Rules:
- If nothing meaningful changed, keep it to 2-3 lines. Don't pad.
- If you traded, explain WHY in one sentence.
- Reference specific positions, specific prices, specific news. No generic "markets are moving" filler.
- If there's genuinely nothing to report, send a one-liner: "All positions stable, no action needed."

After sending to Discord, respond NO_REPLY.`,


eveningReview: `SCHEDULED: Evening Portfolio Review

This is your evening check-in. Review ALL portfolios — how did the day go, and what needs attention overnight?

== STEP 1: GATHER DATA (mandatory — do all of these) ==

1. Call listPortfolios() and getPositions() for current state across all portfolios
2. For stocks/ETFs/crypto: fetch closing or current prices via bash/curl. Compare to morning or cost basis.
3. For Polymarket positions: check current prices via bash/curl on the CLOB API
4. Check the day's news developments that affect ANY positions (market, macro, geopolitical)
5. Call listTransactions() with from=today to review any trades made today (by you or others)
6. Call getPerformance() for each portfolio to see today's movement
7. Update portfolio snapshots with recordSnapshot() if not done already today.

== STEP 2: ANALYZE ==

Across all portfolios:
- How did positions move today vs this morning?
- Any stocks/crypto with after-hours risk (earnings after close, pending announcements)?
- Any prediction markets with significant overnight risk (events that could resolve while owner sleeps)?
- Any positions that should be adjusted before overnight exposure?
- Day's P&L across all portfolios

== STEP 3: TAKE ACTION ==

Same Polymarket authority as morning: if a trade is warranted, execute it.
- Priority: protect gains and limit losses before overnight exposure.
- If any prediction markets expire within 48 hours, assess whether to hold or exit.
Traditional assets: recommend only, flag anything urgent.

== STEP 4: REPORT ==

Send a Discord message only if:
- Something meaningful changed during the day (>3% move on any position)
- You executed a trade
- A position needs attention before tomorrow
- An event is imminent that could affect positions overnight
- A watchlist target was hit

If the day was quiet and nothing changed: DO NOT send a message. Respond NO_REPLY.

If sending:
**Evening Check — [date]**
[Day summary across all portfolios in 1-2 sentences]
[Notable movers: specific positions with specific numbers]
[Any trades or actions taken]
[Overnight watchpoints if any]

After sending (or deciding not to), respond NO_REPLY.`,


weeklyReport: `SCHEDULED: Weekly Portfolio Report

Comprehensive weekly review of ALL wealth management activity across every portfolio.

== STEP 1: GATHER DATA ==

1. listPortfolios() + getPositions() for current state of every portfolio
2. getPerformance() for each portfolio over the past 7 days
3. listTransactions() for the past 7 days across all portfolios
4. For stocks/ETFs/crypto: fetch current prices via bash/curl. Calculate unrealized P&L vs cost basis.
5. For Polymarket: check current prices vs entry prices
6. Review which prediction markets resolved or expired this week
7. Calculate overall P&L: realized gains/losses from closed positions, unrealized from open
8. Check macro context: major index performance (S&P 500, BTC, EUR/USD) for the week

== STEP 2: WEEKLY ANALYSIS ==

For each portfolio:
- Week-over-week performance (% change, absolute change in base currency)
- Best and worst performers with specific numbers
- Trades executed (by you or manually recorded) with outcomes
- Current allocation breakdown (by asset type, sector, geography)

Prediction markets specifically:
- Which bets are on track, which are drifting
- Upcoming expiry dates and resolution probability assessment
- Any markets that resolved — what was the outcome vs your position?

Cross-portfolio strategy review:
- Total net worth across all portfolios
- Overall week-over-week change
- Concentration risk (too much in one theme across portfolios?)
- Cash / liquidity position — enough for opportunities?
- Correlation between prediction market bets and traditional holdings
- What's the forward calendar? (upcoming expiries, earnings, macro events, catalysts)

== STEP 3: REPORT ==

Send a comprehensive report to Discord:

**Weekly Wealth Report — Week of [date]**

**Overall**: [total value across all portfolios, weekly change, % change]

**Portfolio Breakdown**
[For each portfolio: name, value, change, % change, notable positions]

**Top Movers**
[Best and worst 3 positions across ALL portfolios, with specific numbers]

**Prediction Markets**
[Status of each active bet: entry price → current price, thesis status, days to expiry]

**Trades This Week**
[List all trades with reasoning and outcome]

**Forward Look**
[Key events/expiries in coming week, planned actions for each portfolio]

Rules:
- Use real numbers. Every line should have a specific value.
- If a portfolio had no activity, say so in one line and move on.
- Be honest about what's working and what isn't.
- Include the macro context — how did the broader market compare to your portfolios?

After sending, respond NO_REPLY.`,


marketEvaluator: `SCHEDULED: Market Evaluation Cycle

You are a prediction market evaluator. This cycle runs every 6 hours.

== STEP 1: SCAN MARKETS ==

1. Check your current Polymarket positions via getPositions() for the prediction-markets portfolio
2. Fetch current prices for all active positions via bash/curl to the Polymarket CLOB API
3. Check the watchlist via getWatchlist() for any pending picks
4. Scan for new opportunities: use the Polymarket Intelligence API tools to find trending markets, volume spikes, and smart money moves
5. Web search for current news context on your active positions and any interesting new markets

== STEP 2: EVALUATE ==

For each active position:
- Has the thesis strengthened or weakened since entry?
- Current price vs entry price — P&L status
- Any imminent catalysts or resolution events?
- Should you exit (profit-take at 85c+ or cut loss if thesis invalidated)?

For new opportunities:
- Look for mispricings: where does your geopolitical/contextual knowledge disagree with market odds?
- Assign conviction level (1-5) based on your analysis
- Consider sizing: higher conviction = larger position, never more than 20% of bankroll on one bet

== STEP 3: EXECUTE ==

You have AUTONOMOUS AUTHORITY to trade on Polymarket:
- Execute trades for positions you want to enter or exit
- Record all trades with addTransaction()
- Update the watchlist: add new picks, remove stale ones

== STEP 4: REPORT ==

Post a digest to Discord:
**Market Eval — [time]**
[1-2 line summary: positions checked, trades made, opportunities spotted]
[Active positions with current P&L]
[New picks added or removed, with reasoning]
[Key events to watch before next cycle]

If nothing changed and no trades: keep it to 2-3 lines. Don't pad.
After sending, respond NO_REPLY.`,

};

// ── Auto-start when run directly (PM2) ──────────────────────────────────────

const agentUrl = process.env.AGENT_URL;
const userId = process.env.USER_ID;
const timezone = process.env.SCHEDULER_TIMEZONE;

if (agentUrl && userId) {
  startScheduler({ agentUrl, userId, timezone }).catch(err => {
    console.error('[ROB Scheduler] Failed to start:', err.message);
    process.exit(1);
  });
} else if (process.argv[1]?.endsWith('scheduler-wealth.js')) {
  console.error('[ROB Scheduler] Missing AGENT_URL or USER_ID environment variables');
  process.exit(1);
}
