/**
 * Energy State — Computed energy levels and budget management.
 *
 * Reads from the energy ledger (lib/energy.js) and classifies system state.
 * The mycelium's self-awareness of its metabolic rate.
 *
 * Energy levels:
 *   abundant  — under 50% of daily budget → agents may do extra work
 *   normal    — 50-80% → default behavior
 *   low       — 80-95% → start conserving
 *   critical  — over 95% → emergency conservation
 *
 * Opt-in:
 *   Energy-aware behavior (scheduler gating, model downshift, spawn/delegation
 *   throttling) is disabled unless ENERGY_ENABLED=1 is set in the environment.
 *   When disabled, all callers receive a neutral "normal" state so no behavior
 *   changes silently. The ledger itself still records runs if lib/energy.js is
 *   imported from lib/runner.js — that is a separate opt-in (ENERGY_LEDGER_ENABLED).
 *
 * Config: agents/.shared/energy-config.json
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { energySummary } from './energy.js';

const AGENTS_ROOT = process.env.AGENTS_ROOT || path.join(os.homedir(), 'agents');
const CONFIG_FILE = path.join(AGENTS_ROOT, '.shared', 'energy-config.json');

// Master opt-in switch for energy-aware behavior.
// When false, getEnergyState/getAgentEnergyState return a neutral "normal"
// state so scheduler, spawner, delegation, and model-fallback become no-ops.
const ENERGY_ENABLED = process.env.ENERGY_ENABLED === '1';

// Neutral state returned when energy is disabled — classified as "normal"
// so no callers trigger conservation or abundance behavior.
const NEUTRAL_STATE = Object.freeze({
  global: {
    level: 'normal',
    usedTokens: 0,
    budgetTokens: 0,
    pctUsed: 0,
    burnRate: 0,
    runs: 0,
  },
  byAgent: {},
  timestamp: null,
  disabled: true,
});

const NEUTRAL_AGENT_STATE = Object.freeze({
  level: 'normal',
  usedTokens: 0,
  budgetTokens: 0,
  pctUsed: 0,
  runsToday: 0,
  burnRate: 0,
  disabled: true,
});

// Default config (used when no config file exists)
const DEFAULTS = {
  dailyBudget: 50_000_000, // 50M tokens/day
  thresholds: { abundant: 0.5, low: 0.8, critical: 0.95 },
  perAgent: {},
};

// In-memory cache (30s TTL, same pattern as cooldowns.js)
let _stateCache = null;
let _stateCacheTime = 0;
const CACHE_TTL = 30_000;

let _configCache = null;
let _configCacheTime = 0;
const CONFIG_TTL = 60_000;

/**
 * Load energy config from disk (with caching).
 */
export async function getEnergyConfig() {
  const now = Date.now();
  if (_configCache && (now - _configCacheTime) < CONFIG_TTL) return _configCache;

  try {
    const data = await fs.readFile(CONFIG_FILE, 'utf-8');
    _configCache = { ...DEFAULTS, ...JSON.parse(data) };
  } catch {
    _configCache = { ...DEFAULTS };
  }
  _configCacheTime = now;
  return _configCache;
}

/**
 * Classify energy level from percentage used.
 * @param {number} pctUsed - 0 to 1
 * @param {Object} thresholds
 * @returns {'abundant' | 'normal' | 'low' | 'critical'}
 */
export function classifyLevel(pctUsed, thresholds = DEFAULTS.thresholds) {
  if (pctUsed >= thresholds.critical) return 'critical';
  if (pctUsed >= thresholds.low) return 'low';
  if (pctUsed < thresholds.abundant) return 'abundant';
  return 'normal';
}

/**
 * Get global energy state across all agents.
 *
 * When ENERGY_ENABLED is not set, returns a neutral "normal" state with
 * `disabled: true` — callers should treat this as "no signal, behave normally".
 *
 * @returns {Promise<Object>} { global: { level, usedTokens, budgetTokens, burnRate, pctUsed }, byAgent, timestamp }
 */
export async function getEnergyState() {
  if (!ENERGY_ENABLED) return NEUTRAL_STATE;

  const now = Date.now();
  if (_stateCache && (now - _stateCacheTime) < CACHE_TTL) return _stateCache;

  const config = await getEnergyConfig();
  const summary = await energySummary({ days: 1 });

  const usedTokens = summary.totals.inputTokens + summary.totals.outputTokens;
  const budgetTokens = config.dailyBudget;
  const pctUsed = budgetTokens > 0 ? usedTokens / budgetTokens : 0;
  const burnRate = await getBurnRate();

  const byAgent = {};
  for (const [agentId, data] of Object.entries(summary.byAgent)) {
    const agentBudget = config.perAgent?.[agentId]?.dailyBudget || budgetTokens;
    const agentUsed = data.inputTokens + data.outputTokens;
    const agentPct = agentBudget > 0 ? agentUsed / agentBudget : 0;
    byAgent[agentId] = {
      level: classifyLevel(agentPct, config.thresholds),
      usedTokens: agentUsed,
      budgetTokens: agentBudget,
      pctUsed: Math.round(agentPct * 1000) / 10,
      runsToday: data.runs,
      burnRate: 0, // per-agent burn rate not yet computed
    };
  }

  _stateCache = {
    global: {
      level: classifyLevel(pctUsed, config.thresholds),
      usedTokens,
      budgetTokens,
      pctUsed: Math.round(pctUsed * 1000) / 10,
      burnRate,
      runs: summary.totals.runs,
    },
    byAgent,
    timestamp: new Date().toISOString(),
  };
  _stateCacheTime = now;
  return _stateCache;
}

/**
 * Get energy state for a specific agent.
 *
 * When ENERGY_ENABLED is not set, returns the neutral "normal" state.
 * When an agent has no recorded runs today, returns neutral rather than
 * "abundant" — "abundant" would incorrectly encourage extra work during
 * bootstrap or quiet periods.
 *
 * @param {string} agentId
 * @returns {Promise<Object>} { level, usedTokens, budgetTokens, pctUsed, runsToday, burnRate }
 */
export async function getAgentEnergyState(agentId) {
  if (!ENERGY_ENABLED) return NEUTRAL_AGENT_STATE;

  const state = await getEnergyState();
  return state.byAgent[agentId] || {
    level: 'normal',
    usedTokens: 0,
    budgetTokens: state.global.budgetTokens,
    pctUsed: 0,
    runsToday: 0,
    burnRate: 0,
  };
}

/**
 * Calculate token burn rate (tokens/hour) over the last N hours.
 *
 * When ENERGY_ENABLED is not set, returns 0.
 *
 * @param {Object} [opts]
 * @param {number} [opts.hours=3] - Hours to look back
 * @returns {Promise<number>} Tokens per hour
 */
export async function getBurnRate(opts = {}) {
  if (!ENERGY_ENABLED) return 0;

  const hours = opts.hours || 3;
  const now = new Date();
  const from = new Date(now.getTime() - hours * 60 * 60 * 1000);

  const summary = await energySummary({
    from: from.toISOString().split('T')[0],
    to: now.toISOString().split('T')[0],
    days: Math.ceil(hours / 24) + 1,
  });

  const totalTokens = summary.totals.inputTokens + summary.totals.outputTokens;
  return Math.round(totalTokens / hours);
}

/**
 * Clear the energy state cache (useful after a burst of activity).
 */
export function clearEnergyCache() {
  _stateCache = null;
  _stateCacheTime = 0;
}