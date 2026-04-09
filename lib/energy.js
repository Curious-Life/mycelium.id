/**
 * Energy Ledger — Token usage tracking for the mycelium network.
 *
 * Tokens are the mycelium's energy. Every agent/process consumes energy
 * to function. This module records and queries that consumption.
 *
 * Storage: JSONL files at agents/.shared/energy/<YYYY-MM-DD>.jsonl
 * One line per Claude CLI run, with full token breakdown.
 *
 * Usage:
 *   import { recordEnergy, queryEnergy } from './energy.js';
 *   await recordEnergy({ agent, model, ... });
 *   const records = await queryEnergy({ agent: 'alpha', days: 7 });
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const AGENTS_ROOT = process.env.AGENTS_ROOT || path.join(os.homedir(), 'agents');
const ENERGY_DIR = path.join(AGENTS_ROOT, '.shared', 'energy');

/**
 * Record a single energy consumption event.
 *
 * @param {Object} record
 * @param {string} record.agent - Agent ID (e.g., 'alpha', 'beta')
 * @param {string} record.process - Task type (e.g., 'chat', 'think', 'spawn', 'research')
 * @param {string} record.model - Model used (e.g., 'sonnet', 'opus', 'haiku')
 * @param {number} record.inputTokens - Input tokens consumed
 * @param {number} record.outputTokens - Output tokens generated
 * @param {number} [record.cacheRead] - Cache read input tokens
 * @param {number} [record.cacheCreation] - Cache creation input tokens
 * @param {number} [record.costUsd] - Total cost in USD (if available)
 * @param {string} [record.sessionId] - Claude session ID
 * @param {number} [record.durationMs] - Run duration in milliseconds
 * @param {string} [record.trigger] - What triggered this run (discord, telegram, portal, schedule, delegation)
 *
 * Security note: do NOT add CLAUDE_CONFIG_DIR or other subscription identifiers
 * to the record — the ledger is plaintext JSONL on disk and leaking subscription
 * topology on VPS compromise is an unnecessary risk.
 */
export async function recordEnergy(record) {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];

  const entry = {
    ts: now.toISOString(),
    agent: record.agent,
    process: record.process || 'unknown',
    model: record.model || 'unknown',
    inputTokens: record.inputTokens || 0,
    outputTokens: record.outputTokens || 0,
    cacheRead: record.cacheRead || 0,
    cacheCreation: record.cacheCreation || 0,
    costUsd: record.costUsd || null,
    sessionId: record.sessionId || null,
    durationMs: record.durationMs || null,
    trigger: record.trigger || null,
  };

  try {
    await fs.mkdir(ENERGY_DIR, { recursive: true });
    const file = path.join(ENERGY_DIR, `${dateStr}.jsonl`);
    await fs.appendFile(file, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error(`[Energy] Failed to record: ${err.message}`);
  }

  return entry;
}

/**
 * Query energy records.
 *
 * @param {Object} [opts]
 * @param {string} [opts.agent] - Filter by agent ID
 * @param {string} [opts.model] - Filter by model
 * @param {string} [opts.process] - Filter by process type
 * @param {number} [opts.days=1] - How many days back to query
 * @param {string} [opts.from] - Start date (YYYY-MM-DD), overrides days
 * @param {string} [opts.to] - End date (YYYY-MM-DD), defaults to today
 * @returns {Promise<Array>} Array of energy records
 */
export async function queryEnergy(opts = {}) {
  const days = opts.days || 1;
  const to = opts.to ? new Date(opts.to + 'T23:59:59Z') : new Date();
  const from = opts.from
    ? new Date(opts.from + 'T00:00:00Z')
    : new Date(to.getTime() - days * 24 * 60 * 60 * 1000);

  const records = [];
  const dates = getDateRange(from, to);

  for (const dateStr of dates) {
    const file = path.join(ENERGY_DIR, `${dateStr}.jsonl`);
    try {
      const content = await fs.readFile(file, 'utf-8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (opts.agent && record.agent !== opts.agent) continue;
          if (opts.model && record.model !== opts.model) continue;
          if (opts.process && record.process !== opts.process) continue;
          records.push(record);
        } catch { /* skip bad lines */ }
      }
    } catch { /* file doesn't exist for this date */ }
  }

  return records;
}

/**
 * Get aggregated energy summary.
 *
 * @param {Object} [opts] - Same as queryEnergy
 * @returns {Promise<Object>} Summary with totals and per-agent breakdowns
 */
export async function energySummary(opts = {}) {
  const records = await queryEnergy(opts);

  const byAgent = {};
  const byModel = {};
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheCreation = 0;
  let totalCost = 0;
  let totalRuns = records.length;

  for (const r of records) {
    totalInput += r.inputTokens;
    totalOutput += r.outputTokens;
    totalCacheRead += r.cacheRead || 0;
    totalCacheCreation += r.cacheCreation || 0;
    if (r.costUsd) totalCost += r.costUsd;

    // Per agent
    if (!byAgent[r.agent]) {
      byAgent[r.agent] = { runs: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0, models: {} };
    }
    const a = byAgent[r.agent];
    a.runs++;
    a.inputTokens += r.inputTokens;
    a.outputTokens += r.outputTokens;
    a.cacheRead += r.cacheRead || 0;
    a.cacheCreation += r.cacheCreation || 0;
    if (r.costUsd) a.costUsd += r.costUsd;
    a.models[r.model] = (a.models[r.model] || 0) + 1;

    // Per model
    if (!byModel[r.model]) {
      byModel[r.model] = { runs: 0, inputTokens: 0, outputTokens: 0 };
    }
    const m = byModel[r.model];
    m.runs++;
    m.inputTokens += r.inputTokens;
    m.outputTokens += r.outputTokens;
  }

  // Per date (time series)
  const byDate = {};
  for (const r of records) {
    if (r.model === '<synthetic>') continue;
    const date = r.ts.split('T')[0];
    if (!byDate[date]) byDate[date] = { runs: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, agents: {} };
    const d = byDate[date];
    d.runs++;
    d.inputTokens += r.inputTokens;
    d.outputTokens += r.outputTokens;
    d.cacheRead += r.cacheRead || 0;
    if (!d.agents[r.agent]) d.agents[r.agent] = { runs: 0, tokens: 0 };
    d.agents[r.agent].runs++;
    d.agents[r.agent].tokens += r.inputTokens + r.outputTokens;
  }

  // Flows: 3-stage pipeline (model → agent → process)
  const flows = {};
  const flowsOut = {};
  for (const r of records) {
    if (r.model === '<synthetic>') continue;
    // Stage 1: model → agent
    const key1 = `${r.model}→${r.agent}`;
    if (!flows[key1]) flows[key1] = { source: r.model, target: r.agent, tokens: 0, runs: 0 };
    flows[key1].tokens += r.inputTokens + r.outputTokens;
    flows[key1].runs++;
    // Stage 2: agent → process type (output)
    const proc = r.process === 'chat' ? 'conversation' : r.process === 'think' ? 'autonomous' : r.process === 'spawn' ? 'sub-task' : 'session';
    const key2 = `${r.agent}→${proc}`;
    if (!flowsOut[key2]) flowsOut[key2] = { source: r.agent, target: proc, tokens: 0, runs: 0 };
    flowsOut[key2].tokens += r.outputTokens;
    flowsOut[key2].runs++;
  }

  // Filter out <synthetic> from byModel
  delete byModel['<synthetic>'];

  return {
    period: { from: opts.from || null, to: opts.to || null, days: opts.days || 1 },
    totals: {
      runs: totalRuns,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cacheRead: totalCacheRead,
      cacheCreation: totalCacheCreation,
      costUsd: Math.round(totalCost * 10000) / 10000,
    },
    byAgent,
    byModel,
    byDate,
    flows: Object.values(flows).sort((a, b) => b.tokens - a.tokens),
    flowsOut: Object.values(flowsOut).sort((a, b) => b.tokens - a.tokens),
  };
}

function getDateRange(from, to) {
  const dates = [];
  const current = new Date(from);
  while (current <= to) {
    dates.push(current.toISOString().split('T')[0]);
    current.setDate(current.getDate() + 1);
  }
  return dates;
}