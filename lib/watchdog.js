/**
 * Watchdog — System Health Monitor + Self-Healing + Daily Report
 *
 * Runs inside the orchestrator process (no separate PM2 entry).
 * Checks every 5 minutes, keeps 5 hours of health history in memory.
 *
 * Detection rules:
 *   - Unreachable: 2 consecutive fails → log. 4 → auto-restart. 6 → alert Nate.
 *   - Crash loop: >3 PM2 restarts in 15 min → alert immediately.
 *   - Memory pressure: >900MB → log. >950MB → preemptive restart.
 *   - All agents down → alert immediately.
 *
 * Self-healing:
 *   - Restart stuck processes via PM2
 *   - Consolidated rate-limit alerts
 *
 * Escalation:
 *   - Discord #system-alerts channel
 *   - Telegram to Nate's chat ID
 *   - Suppression: don't re-alert for the same issue within 30 minutes
 *
 * Daily Report (09:00):
 *   - Per-agent uptime %, restart count, peak memory
 *   - Escalation summary
 *   - Task queue depth
 *
 * Usage:
 *   import { startWatchdog, stopWatchdog } from './lib/watchdog.js';
 *   startWatchdog({ agents, agentManager, discordAlertChannelId, telegramBotPort });
 */

import { tryGetDb } from './db.js';

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_HISTORY = 60; // 60 checks × 5 min = 5 hours
const ALERT_SUPPRESSION_MS = 30 * 60 * 1000; // 30 minutes
const REPORT_HOUR = 9; // Send daily report at 09:00

let intervalId = null;
let config = null;

// In-memory health history: Map<agentSlug, Array<{ts, health, restarts, memory}>>
const healthHistory = new Map();

// Alert suppression: Map<alertKey, lastAlertTimestamp>
const alertsSent = new Map();

// Daily stats: Map<agentSlug, { okChecks, totalChecks, peakMemoryMB, restartsSeen }>
const dailyStats = new Map();

// Track escalation count for daily report
let dailyEscalationCount = 0;

// Track which date the last report was sent for (prevents duplicate reports)
let lastReportDate = null;

/**
 * Start the watchdog.
 *
 * @param {Object} opts
 * @param {Array<{slug, name, port}>} opts.agents - Known agents
 * @param {Object} opts.agentManager - PM2 agent manager (getAgentStatus, restartAgent)
 * @param {string} [opts.discordAlertChannelId] - Discord channel for alerts
 * @param {number} [opts.telegramBotPort] - Telegram bot HTTP port for escalation
 * @param {string} [opts.telegramChatId] - Nate's Telegram chat ID
 * @param {string} [opts.timezone] - IANA timezone for daily report (default: 'UTC')
 */
export function startWatchdog(opts) {
  config = { ...opts, timezone: opts.timezone || 'UTC' };

  for (const agent of opts.agents) {
    healthHistory.set(agent.slug, []);
    dailyStats.set(agent.slug, { okChecks: 0, totalChecks: 0, peakMemoryMB: 0, restartsSeen: 0 });
  }

  console.log(`[Watchdog] Started — monitoring ${opts.agents.length} agents every ${CHECK_INTERVAL_MS / 1000}s`);

  // First check immediately, then on interval
  runCheck();
  intervalId = setInterval(runCheck, CHECK_INTERVAL_MS);
}

/**
 * Stop the watchdog.
 */
export function stopWatchdog() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  console.log('[Watchdog] Stopped');
}

/**
 * Run a single health check cycle across all agents.
 */
async function runCheck() {
  if (!config) return;

  const results = [];
  let allDown = true;

  for (const agent of config.agents) {
    const check = await checkAgent(agent);
    results.push(check);

    // Track history
    const history = healthHistory.get(agent.slug) || [];
    history.push(check);
    if (history.length > MAX_HISTORY) history.shift();
    healthHistory.set(agent.slug, history);

    if (check.health === 'ok') allDown = false;

    // ── Track Daily Stats ──
    const stats = dailyStats.get(agent.slug);
    if (stats) {
      stats.totalChecks++;
      if (check.health === 'ok') stats.okChecks++;
      if (check.memoryMB > stats.peakMemoryMB) stats.peakMemoryMB = check.memoryMB;
      if (check.restarts > stats.restartsSeen) stats.restartsSeen = check.restarts;
    }

    // ── Detection Rules ──

    // Count consecutive failures
    const consecutiveFails = countConsecutiveFails(history);

    if (consecutiveFails >= 6) {
      // 6 consecutive fails (30 min) → escalate to Nate
      await escalate(
        `agent_down:${agent.slug}`,
        `Agent **${agent.name}** (${agent.slug}) has been unreachable for 30+ minutes. Last error: ${check.error || 'unknown'}`,
      );
    } else if (consecutiveFails >= 4) {
      // 4 consecutive fails (20 min) → auto-restart
      console.log(`[Watchdog] ${agent.slug}: ${consecutiveFails} consecutive failures — attempting restart`);
      try {
        await config.agentManager.restartAgent(agent.slug);
        console.log(`[Watchdog] ${agent.slug}: restart triggered`);
      } catch (err) {
        console.error(`[Watchdog] ${agent.slug}: restart failed:`, err.message);
      }
    } else if (consecutiveFails >= 2) {
      console.log(`[Watchdog] ${agent.slug}: ${consecutiveFails} consecutive failures — monitoring`);
    }

    // Crash loop detection (>3 restarts in 15 min)
    if (check.restarts > 3 && check.uptimeMs && check.uptimeMs < 15 * 60 * 1000) {
      await escalate(
        `crash_loop:${agent.slug}`,
        `Agent **${agent.name}** (${agent.slug}) is crash-looping: ${check.restarts} restarts, uptime only ${Math.round(check.uptimeMs / 1000)}s`,
      );
    }

    // Memory pressure
    if (check.memoryMB > 950) {
      console.log(`[Watchdog] ${agent.slug}: memory critical (${check.memoryMB}MB) — restarting`);
      try {
        await config.agentManager.restartAgent(agent.slug);
      } catch (err) {
        console.error(`[Watchdog] ${agent.slug}: memory restart failed:`, err.message);
      }
    } else if (check.memoryMB > 900) {
      console.log(`[Watchdog] ${agent.slug}: memory high (${check.memoryMB}MB)`);
    }
  }

  // All agents down → immediate escalation
  if (allDown && config.agents.length > 0) {
    await escalate(
      'all_agents_down',
      `All ${config.agents.length} agents are unreachable. System may be completely down.`,
    );
  }

  // ── Daily Report (09:00) ──
  await maybeRunDailyReport();
}

/**
 * Check a single agent's health.
 */
async function checkAgent(agent) {
  const result = {
    slug: agent.slug,
    name: agent.name,
    ts: Date.now(),
    health: 'unknown',
    error: null,
    restarts: 0,
    memoryMB: 0,
    uptimeMs: null,
  };

  // PM2 status
  try {
    const pm2 = config.agentManager.getAgentStatus(agent.slug);
    if (pm2) {
      result.restarts = pm2.restarts || 0;
      result.memoryMB = pm2.memory ? Math.round(pm2.memory / 1024 / 1024) : 0;
      result.uptimeMs = pm2.uptime ? Date.now() - pm2.uptime : null;
    }
  } catch { /* PM2 check is best-effort */ }

  // HTTP health check
  try {
    const res = await fetch(`http://localhost:${agent.port}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      result.health = 'ok';
    } else {
      result.health = 'error';
      result.error = `HTTP ${res.status}`;
    }
  } catch (err) {
    result.health = 'unreachable';
    result.error = err.message?.includes('timeout') ? 'timeout' : err.message;
  }

  return result;
}

/**
 * Count consecutive failures from the end of the history.
 */
function countConsecutiveFails(history) {
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].health !== 'ok') count++;
    else break;
  }
  return count;
}

/**
 * Escalate an issue to Nate via Discord and/or Telegram.
 * Suppresses duplicate alerts for 30 minutes.
 */
async function escalate(alertKey, message) {
  const lastSent = alertsSent.get(alertKey);
  if (lastSent && Date.now() - lastSent < ALERT_SUPPRESSION_MS) {
    return; // Suppressed
  }

  alertsSent.set(alertKey, Date.now());
  dailyEscalationCount++;
  console.error(`[Watchdog] ESCALATION: ${message}`);

  // Discord alert
  if (config.discordAlertChannelId) {
    try {
      // POST to the orchestrator's own /discord/send endpoint (localhost)
      await fetch('http://localhost:3000/discord/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelId: config.discordAlertChannelId,
          content: `**[Watchdog Alert]** ${message}`,
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      console.error('[Watchdog] Discord escalation failed:', err.message);
    }
  }

  // Telegram alert
  if (config.telegramBotPort && config.telegramChatId) {
    try {
      await fetch(`http://localhost:${config.telegramBotPort}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: config.telegramChatId,
          text: `[Watchdog] ${message}`,
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      console.error('[Watchdog] Telegram escalation failed:', err.message);
    }
  }

  // Clean up old suppression entries
  const cutoff = Date.now() - ALERT_SUPPRESSION_MS * 2;
  for (const [key, ts] of alertsSent.entries()) {
    if (ts < cutoff) alertsSent.delete(key);
  }
}

// ── Daily Report ────────────────────────────────────────────────────────────

/**
 * Check if it's time for the daily report and send it.
 */
async function maybeRunDailyReport() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, hour: 'numeric', hour12: false });
  const dateFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: config.timezone }); // YYYY-MM-DD
  const hour = parseInt(fmt.format(now), 10);
  const dateKey = dateFmt.format(now);

  if (hour !== REPORT_HOUR) return;
  if (lastReportDate === dateKey) return;

  lastReportDate = dateKey;
  console.log('[Watchdog] Generating daily system report');

  try {
    const report = await generateDailyReport(dateKey);
    await sendReport(report);
  } catch (err) {
    console.error('[Watchdog] Daily report failed:', err.message);
  }

  // Reset daily stats after sending
  for (const agent of config.agents) {
    dailyStats.set(agent.slug, { okChecks: 0, totalChecks: 0, peakMemoryMB: 0, restartsSeen: 0 });
  }
  dailyEscalationCount = 0;
}

/**
 * Generate a daily report string.
 */
async function generateDailyReport(dateKey) {
  const agentLines = [];

  // Per-agent summary
  let allHealthy = true;
  for (const agent of config.agents) {
    const stats = dailyStats.get(agent.slug);
    const history = healthHistory.get(agent.slug) || [];
    const latest = history[history.length - 1];
    const currentHealth = latest?.health || 'unknown';

    if (!stats || stats.totalChecks === 0) {
      agentLines.push(`• **${agent.name}** (${agent.slug}): no data`);
      allHealthy = false;
      continue;
    }

    const uptimePct = ((stats.okChecks / stats.totalChecks) * 100).toFixed(1);
    const status = currentHealth === 'ok' ? '✅' : '⚠️';
    if (currentHealth !== 'ok') allHealthy = false;

    let line = `${status} **${agent.name}** — uptime ${uptimePct}%`;
    if (stats.restartsSeen > 0) line += `, ${stats.restartsSeen} restarts`;
    if (stats.peakMemoryMB > 0) line += `, peak ${stats.peakMemoryMB}MB`;
    agentLines.push(line);
  }

  // Build report
  const overallStatus = allHealthy ? '✅ All systems healthy' : '⚠️ Some agents degraded';
  const lines = [
    `**[Daily System Report]** ${dateKey} — ${overallStatus}\n`,
    ...agentLines,
  ];

  // Escalations
  if (dailyEscalationCount > 0) {
    lines.push(`\n🚨 **${dailyEscalationCount} escalation(s)** in the last 24h`);
  }

  // Task queue depth (best-effort via db)
  try {
    const db = tryGetDb();
    if (db) {
      let totalPending = 0;
      for (const agent of config.agents) {
        const pending = await db.agentTasks.getPending(agent.slug, 100);
        totalPending += pending?.length || 0;
      }
      if (totalPending > 0) {
        lines.push(`📋 **${totalPending} pending task(s)** in queue`);
      }
    }
  } catch { /* Queue depth is best-effort */ }

  return lines.join('\n');
}

/**
 * Send the daily report via Discord and Telegram.
 */
async function sendReport(report) {
  console.log(`[Watchdog] Daily report:\n${report}`);

  // Discord
  if (config.discordAlertChannelId) {
    try {
      await fetch('http://localhost:3000/discord/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelId: config.discordAlertChannelId,
          content: report,
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      console.error('[Watchdog] Discord report failed:', err.message);
    }
  }

  // Telegram
  if (config.telegramBotPort && config.telegramChatId) {
    try {
      // Strip markdown bold for Telegram plain text
      const plainReport = report.replace(/\*\*/g, '');
      await fetch(`http://localhost:${config.telegramBotPort}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: config.telegramChatId,
          text: plainReport,
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      console.error('[Watchdog] Telegram report failed:', err.message);
    }
  }
}

/**
 * Get current health snapshot for all agents (used by /system/status).
 */
export function getHealthSnapshot() {
  const snapshot = {};
  for (const [slug, history] of healthHistory.entries()) {
    const latest = history[history.length - 1];
    snapshot[slug] = {
      current: latest || null,
      consecutiveFails: countConsecutiveFails(history),
      checksTotal: history.length,
    };
  }
  return snapshot;
}

export { generateDailyReport };

export default { startWatchdog, stopWatchdog, getHealthSnapshot, generateDailyReport };
