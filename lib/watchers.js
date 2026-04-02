/**
 * Persistent Watcher Subagents
 *
 * Lightweight, scheduled subagents that run inside the parent agent's process.
 * Agents create watchers by writing config files to memory/watchers/<id>/config.json.
 * The WatcherManager discovers them, schedules timers, and runs them via runClaudeCode().
 *
 * Each watcher has its own knowledge directory that accumulates findings across runs.
 */

import fs from 'fs/promises';
import path from 'path';
import { runClaudeCode } from './runner.js';
import { enqueue } from './lanes.js';
import { getTimeout } from './timeouts.js';

// Schedule → milliseconds
const SCHEDULE_MS = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

// Guardrails
const MAX_WATCHERS = 5;
const MIN_INTERVAL_MS = 60 * 60 * 1000; // 1 hour minimum
const MAX_FINDINGS = 100;
const WATCHER_TIMEOUT = 30 * 60 * 1000; // 30 minutes per tick
const WATCHER_MAX_TURNS = 30;

/**
 * Parse a schedule string into milliseconds
 * Supports: 'hourly', 'daily', 'weekly', '6h', '12h', '2d'
 */
function parseSchedule(schedule) {
  if (SCHEDULE_MS[schedule]) return SCHEDULE_MS[schedule];

  const match = schedule.match(/^(\d+)(h|d)$/);
  if (match) {
    const value = parseInt(match[1], 10);
    const unit = match[2];
    if (unit === 'h') return value * 60 * 60 * 1000;
    if (unit === 'd') return value * 24 * 60 * 60 * 1000;
  }

  return null; // invalid
}

/**
 * Deterministic stagger offset for a watcher ID.
 * Distributes watchers evenly across the interval so they don't all fire at once.
 * For daily watchers, this spreads them across ~24h in ~2-4 hour gaps.
 */
function getStaggerOffset(watcherId, intervalMs) {
  // Simple hash of watcher ID → number between 0 and 1
  let hash = 0;
  for (let i = 0; i < watcherId.length; i++) {
    hash = ((hash << 5) - hash + watcherId.charCodeAt(i)) | 0;
  }
  const fraction = Math.abs(hash % 1000) / 1000;
  // Offset up to 80% of interval (avoid clustering near the boundary)
  return Math.floor(fraction * intervalMs * 0.8);
}

export class WatcherManager {
  /**
   * @param {string} agentId - Parent agent ID
   * @param {Object} agentPaths - From getAgentPaths()
   * @param {Object} options
   * @param {Function} options.hasActiveTasks - Returns true if agent has active /chat tasks
   * @param {Function} options.addActivity - Activity stream logger
   */
  constructor(agentId, agentPaths, options = {}) {
    this.agentId = agentId;
    this.paths = agentPaths;
    this.watchersDir = path.join(agentPaths.root, 'memory', 'watchers');
    this.watchers = new Map(); // id → { config, timer, state }
    this.hasActiveTasks = options.hasActiveTasks || (() => false);
    this.addActivity = options.addActivity || (() => {});
    this.running = false;
  }

  /**
   * Start the watcher manager — load all watchers from disk
   */
  async start() {
    this.running = true;
    await fs.mkdir(this.watchersDir, { recursive: true });
    await this.syncWatchers();
    console.log(`[Watchers] Started for ${this.agentId} — ${this.watchers.size} watcher(s) active`);
  }

  /**
   * Stop all watcher timers (for graceful shutdown)
   */
  stop() {
    this.running = false;
    for (const [id, watcher] of this.watchers) {
      if (watcher.timer) {
        clearInterval(watcher.timer);
        watcher.timer = null;
      }
    }
    console.log(`[Watchers] Stopped all watchers for ${this.agentId}`);
  }

  /**
   * Scan memory/watchers/* for config files, start new watchers, stop deleted ones
   */
  async syncWatchers() {
    let entries;
    try {
      entries = await fs.readdir(this.watchersDir, { withFileTypes: true });
    } catch {
      return; // dir doesn't exist yet
    }

    const diskIds = new Set();

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const configPath = path.join(this.watchersDir, entry.name, 'config.json');
      try {
        const raw = await fs.readFile(configPath, 'utf-8');
        const config = JSON.parse(raw);

        if (!config.id) config.id = entry.name;
        diskIds.add(config.id);

        const existing = this.watchers.get(config.id);

        if (!existing) {
          // New watcher discovered
          await this._startWatcher(config);
        } else if (config.status !== existing.config.status) {
          // Status changed (e.g. paused/active)
          if (config.status === 'paused' && existing.timer) {
            clearInterval(existing.timer);
            existing.timer = null;
            existing.config = config;
            console.log(`[Watchers] Paused: ${config.id}`);
          } else if (config.status === 'active' && !existing.timer) {
            existing.config = config;
            this._scheduleTimer(config.id);
            console.log(`[Watchers] Resumed: ${config.id}`);
          }
        }
      } catch {
        // Invalid or missing config, skip
      }
    }

    // Remove watchers that no longer have config on disk
    for (const [id, watcher] of this.watchers) {
      if (!diskIds.has(id)) {
        if (watcher.timer) clearInterval(watcher.timer);
        this.watchers.delete(id);
        console.log(`[Watchers] Removed (config deleted): ${id}`);
      }
    }
  }

  /**
   * Start tracking a new watcher
   */
  async _startWatcher(config) {
    if (this.watchers.size >= MAX_WATCHERS) {
      console.warn(`[Watchers] Cannot start ${config.id} — max ${MAX_WATCHERS} watchers reached`);
      return;
    }

    const intervalMs = parseSchedule(config.schedule);
    if (!intervalMs || intervalMs < MIN_INTERVAL_MS) {
      console.warn(`[Watchers] Invalid schedule for ${config.id}: ${config.schedule} (min 1 hour)`);
      return;
    }

    // Load state from disk
    const state = await this._loadState(config.id);

    this.watchers.set(config.id, {
      config,
      state,
      timer: null,
      running: false,
    });

    if (config.status === 'active') {
      this._scheduleTimer(config.id);
    }

    console.log(`[Watchers] Started: ${config.id} (schedule: ${config.schedule})`);
    this.addActivity('status', `Watcher started: ${config.id} (${config.schedule})`, {
      type: 'watcher-start',
      watcherId: config.id,
    });
  }

  /**
   * Set up the interval timer for a watcher.
   * Applies a deterministic stagger offset so watchers don't all fire at once.
   */
  _scheduleTimer(watcherId) {
    const watcher = this.watchers.get(watcherId);
    if (!watcher) return;

    const intervalMs = parseSchedule(watcher.config.schedule);
    if (!intervalMs) return;

    // Deterministic offset so watchers spread across the interval
    const staggerMs = getStaggerOffset(watcherId, intervalMs);

    // If last run was recent, delay the first tick
    let initialDelay = intervalMs;
    if (watcher.state.lastRun) {
      const elapsed = Date.now() - new Date(watcher.state.lastRun).getTime();
      initialDelay = Math.max(0, intervalMs - elapsed);
    } else {
      // First-ever run: use stagger offset so watchers don't all fire on boot
      initialDelay = staggerMs;
    }

    const staggerHours = Math.round(staggerMs / 3600000 * 10) / 10;
    console.log(`[Watchers] Scheduling ${watcherId}: first tick in ${Math.round(initialDelay / 60000)}min, stagger offset: ${staggerHours}h`);

    // First tick after delay, then regular interval
    const startInterval = () => {
      watcher.timer = setInterval(() => {
        this.runWatcherTick(watcherId).catch(err => {
          console.error(`[Watchers] Tick error for ${watcherId}:`, err.message);
        });
      }, intervalMs);
    };

    if (initialDelay > 0) {
      setTimeout(() => {
        if (!this.running || !this.watchers.has(watcherId)) return;
        this.runWatcherTick(watcherId).catch(err => {
          console.error(`[Watchers] Initial tick error for ${watcherId}:`, err.message);
        });
        startInterval();
      }, initialDelay);
    } else {
      // Due now — run immediately
      this.runWatcherTick(watcherId).catch(err => {
        console.error(`[Watchers] Tick error for ${watcherId}:`, err.message);
      });
      startInterval();
    }
  }

  /**
   * Run one cycle for a watcher
   */
  async runWatcherTick(watcherId) {
    const watcher = this.watchers.get(watcherId);
    if (!watcher || watcher.running) return;
    if (watcher.config.status !== 'active') return;

    // Skip if agent has active /chat tasks
    if (this.hasActiveTasks()) {
      console.log(`[Watchers] Skipping ${watcherId} tick — agent has active tasks`);
      return;
    }

    watcher.running = true;
    const startTime = Date.now();

    console.log(`[Watchers] Running tick for ${watcherId} (run #${(watcher.state.runCount || 0) + 1})`);
    this.addActivity('action', `Watcher tick: ${watcherId}`, {
      type: 'watcher-tick',
      watcherId,
      runCount: watcher.state.runCount || 0,
    });

    try {
      // Build the watcher prompt
      const prompt = this._buildWatcherPrompt(watcher);

      // Enqueue in the agent's lane (serialized with /chat and /think)
      const laneId = `agent:${this.agentId}`;
      const { result, sessionId } = await enqueue(laneId, async () => {
        return runClaudeCode(prompt, {
          model: watcher.config.model || 'sonnet',
          cwd: this.paths.repo,
          taskType: 'research',
          timeout: WATCHER_TIMEOUT,
          maxTurns: watcher.config.maxTurns || WATCHER_MAX_TURNS,
          agentRoot: this.paths.root,
          agentId: this.agentId,
          skipDedup: true,
        });
      }, { taskType: 'watcher', watcherId });

      // Parse findings from response
      const findings = this._parseFindings(result, watcherId);

      // Update state
      watcher.state.lastRun = new Date().toISOString();
      watcher.state.runCount = (watcher.state.runCount || 0) + 1;
      watcher.state.lastDurationMs = Date.now() - startTime;

      if (findings) {
        if (!watcher.state.findings) watcher.state.findings = [];
        watcher.state.findings.push({
          date: new Date().toISOString().split('T')[0],
          runNumber: watcher.state.runCount,
          ...findings,
        });
        // Cap findings history
        if (watcher.state.findings.length > MAX_FINDINGS) {
          watcher.state.findings = watcher.state.findings.slice(-MAX_FINDINGS);
        }
      }

      await this._saveState(watcherId, watcher.state);

      // Update config lastRun on disk
      watcher.config.lastRun = watcher.state.lastRun;
      watcher.config.runCount = watcher.state.runCount;
      await this._saveConfig(watcherId, watcher.config);

      // Post to Discord if configured
      if (watcher.config.reportChannel && result) {
        await this._postToDiscord(watcher.config.reportChannel, watcherId, result);
      }

      console.log(`[Watchers] Tick complete for ${watcherId} (${Math.round((Date.now() - startTime) / 1000)}s)`);
      this.addActivity('output', `Watcher tick complete: ${watcherId}`, {
        type: 'watcher-tick-complete',
        watcherId,
        durationMs: Date.now() - startTime,
      });
    } catch (error) {
      console.error(`[Watchers] Tick failed for ${watcherId}:`, error.message);
      this.addActivity('error', `Watcher tick failed: ${watcherId}: ${error.message}`, {
        type: 'watcher-tick-error',
        watcherId,
      });

      // Save error in state
      watcher.state.lastError = error.message;
      watcher.state.lastErrorAt = new Date().toISOString();
      await this._saveState(watcherId, watcher.state);
    } finally {
      watcher.running = false;
    }
  }

  /**
   * Build the prompt sent to Claude Code for a watcher tick
   */
  _buildWatcherPrompt(watcher) {
    const { config, state } = watcher;
    const recentFindings = (state.findings || []).slice(-10);

    let prompt = `You are a watcher subagent. You run on a schedule to perform a specific recurring task.

## Your Purpose
${config.purpose}

## Run Info
- Watcher ID: ${config.id}
- Schedule: ${config.schedule}
- Run number: ${(state.runCount || 0) + 1}
- Last run: ${state.lastRun || 'never'}
- Created by: ${config.createdBy || 'unknown'}
`;

    if (recentFindings.length > 0) {
      prompt += `
## Your Accumulated Findings (last ${recentFindings.length} runs)
${JSON.stringify(recentFindings, null, 2)}
`;
    }

    prompt += `
## Instructions
1. Carry out your purpose as described above
2. Build on your accumulated findings — don't repeat work already done
3. At the end of your response, output your findings in this format:

FINDINGS_START
{
  "summary": "One-line summary of this run's findings",
  "details": "Detailed findings from this run",
  "items": ["key item 1", "key item 2"]
}
FINDINGS_END

4. If you have nothing new to report, output FINDINGS_START {"summary": "No new findings", "details": "", "items": []} FINDINGS_END
`;

    return prompt;
  }

  /**
   * Parse structured findings from a watcher response
   */
  _parseFindings(result, watcherId) {
    const match = result.match(/FINDINGS_START\s*([\s\S]*?)\s*FINDINGS_END/);
    if (!match) {
      // Fallback: use the whole response as the summary
      return {
        summary: result.slice(0, 200),
        details: result,
        items: [],
      };
    }

    try {
      return JSON.parse(match[1]);
    } catch {
      console.warn(`[Watchers] Failed to parse findings JSON for ${watcherId}`);
      return {
        summary: match[1].slice(0, 200),
        details: match[1],
        items: [],
      };
    }
  }

  /**
   * Post watcher results to Discord via the agent's bot
   */
  async _postToDiscord(channelId, watcherId, content) {
    const truncated = content.length > 1800
      ? content.slice(0, 1800) + '...'
      : content;

    const message = `**Watcher Report: ${watcherId}**\n\n${truncated}`;

    try {
      const response = await fetch(`http://localhost:3000/discord/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId, content: message }),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        console.warn(`[Watchers] Discord post failed for ${watcherId}: ${response.status}`);
      }
    } catch (error) {
      console.warn(`[Watchers] Discord post error for ${watcherId}: ${error.message}`);
    }
  }

  // ── State persistence ──────────────────────────────────

  async _loadState(watcherId) {
    const statePath = path.join(this.watchersDir, watcherId, 'state.json');
    try {
      const raw = await fs.readFile(statePath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return { lastRun: null, runCount: 0, findings: [] };
    }
  }

  async _saveState(watcherId, state) {
    const statePath = path.join(this.watchersDir, watcherId, 'state.json');
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, JSON.stringify(state, null, 2));
  }

  async _saveConfig(watcherId, config) {
    const configPath = path.join(this.watchersDir, watcherId, 'config.json');
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  }

  // ── API methods (for REST endpoints) ───────────────────

  /**
   * List all watchers with their current status
   */
  listWatchers() {
    const result = [];
    for (const [id, watcher] of this.watchers) {
      result.push({
        id,
        purpose: watcher.config.purpose,
        schedule: watcher.config.schedule,
        status: watcher.config.status,
        model: watcher.config.model || 'sonnet',
        reportChannel: watcher.config.reportChannel || null,
        createdBy: watcher.config.createdBy || null,
        createdAt: watcher.config.createdAt || null,
        lastRun: watcher.state.lastRun,
        runCount: watcher.state.runCount || 0,
        lastError: watcher.state.lastError || null,
        running: watcher.running,
        findingsCount: (watcher.state.findings || []).length,
      });
    }
    return result;
  }

  /**
   * Get detailed info for a single watcher
   */
  getWatcher(watcherId) {
    const watcher = this.watchers.get(watcherId);
    if (!watcher) return null;

    return {
      config: watcher.config,
      state: watcher.state,
      running: watcher.running,
      hasTimer: !!watcher.timer,
    };
  }

  /**
   * Pause a watcher
   */
  async pauseWatcher(watcherId) {
    const watcher = this.watchers.get(watcherId);
    if (!watcher) return false;

    watcher.config.status = 'paused';
    if (watcher.timer) {
      clearInterval(watcher.timer);
      watcher.timer = null;
    }

    await this._saveConfig(watcherId, watcher.config);
    console.log(`[Watchers] Paused: ${watcherId}`);
    this.addActivity('status', `Watcher paused: ${watcherId}`, { type: 'watcher-pause', watcherId });
    return true;
  }

  /**
   * Resume a paused watcher
   */
  async resumeWatcher(watcherId) {
    const watcher = this.watchers.get(watcherId);
    if (!watcher) return false;

    watcher.config.status = 'active';
    await this._saveConfig(watcherId, watcher.config);

    if (!watcher.timer) {
      this._scheduleTimer(watcherId);
    }

    console.log(`[Watchers] Resumed: ${watcherId}`);
    this.addActivity('status', `Watcher resumed: ${watcherId}`, { type: 'watcher-resume', watcherId });
    return true;
  }

  /**
   * Delete a watcher entirely (config + state + timer)
   */
  async deleteWatcher(watcherId) {
    const watcher = this.watchers.get(watcherId);
    if (!watcher) return false;

    if (watcher.timer) clearInterval(watcher.timer);
    this.watchers.delete(watcherId);

    // Remove files from disk
    const watcherDir = path.join(this.watchersDir, watcherId);
    try {
      await fs.rm(watcherDir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[Watchers] Failed to delete watcher dir: ${err.message}`);
    }

    console.log(`[Watchers] Deleted: ${watcherId}`);
    this.addActivity('status', `Watcher deleted: ${watcherId}`, { type: 'watcher-delete', watcherId });
    return true;
  }
}

export default { WatcherManager };
