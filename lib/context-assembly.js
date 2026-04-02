/**
 * Context Assembly for Personal Agent (Mya)
 *
 * Pre-loads mind state before each chat/think call so Claude has full context
 * without needing to actively fetch it via MCP tools.
 *
 * Assembles:
 *   1. Local mind files (internal model, flagged items, dream fragments)
 *   2. Pinned documents from Supabase
 *   3. Master document index (summaries)
 *   4. Recent messages across all channels (telegram, portal, discord)
 *
 * This replaces MYA-0.2's ContextAssembler which injected context into every
 * Claude API call. Here we build a dynamic system prompt section that gets
 * prepended to the base system prompt.
 *
 * Usage:
 *   import { assembleContext } from './context-assembly.js';
 *   const context = await assembleContext(agentRoot, userId, { scope: 'all' });
 *   // context is a markdown string ready to prepend to the system prompt
 */

import fs from 'fs/promises';
import path from 'path';
import { tryGetDb } from './db.js';

/**
 * Assemble context for an agent's chat/think cycle.
 *
 * @param {string} agentRoot - Agent directory (e.g., ~/agents/personal-agent)
 * @param {string} userId - Supabase user UUID
 * @param {Object} [options]
 * @param {string} [options.scope] - 'all' (personal) or 'company'
 * @param {string} [options.source] - Message source context ('telegram', 'portal', 'discord')
 * @param {string} [options.agentId] - This agent's ID (e.g., 'personal-agent')
 * @param {number} [options.maxRecentMessages] - Max recent messages to include (default: 10)
 * @param {number} [options.maxDocSummaries] - Max document summaries (default: 30)
 * @returns {Promise<string>} Assembled context as markdown
 */
// Agents that need minimal context (no message history, no documents, no mindscape)
const MINIMAL_CONTEXT_AGENTS = new Set(['ops-agent']);

export async function assembleContext(agentRoot, userId, options = {}) {
  const { scope = 'all', source = '', agentId = '', maxRecentMessages = 10, maxDocSummaries = 30 } = options;
  const isPersonal = scope === 'all';

  const sections = [];

  // Minimal-context agents only get the timestamp
  if (MINIMAL_CONTEXT_AGENTS.has(agentId)) {
    const now = new Date();
    let userTz = 'UTC', tzLabel = 'UTC';
    try {
      const db = tryGetDb();
      if (db && userId) {
        const tz = await db.users.getTimezone(userId);
        if (tz) { userTz = tz; tzLabel = tz.split('/').pop().replace(/_/g, ' '); }
      }
    } catch { /* use default */ }
    const localDay = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: userTz }).format(now);
    const localDate = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: userTz }).format(now);
    const localTime = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: userTz });
    return `**Current time:** ${localDay}, ${localDate} ${localTime} (${tzLabel})`;
  }

  // ── 0. Current Date/Time (prevents day-of-week hallucination) ──
  // Pull timezone from user record in DB, fall back to UTC
  let userTz = 'UTC';
  let tzLabel = 'UTC';
  try {
    const db = tryGetDb();
    if (db && userId) {
      const tz = await db.users.getTimezone(userId);
      if (tz) { userTz = tz; tzLabel = tz.split('/').pop().replace(/_/g, ' '); }
    }
  } catch { /* use default */ }
  const now = new Date();
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  // Use Intl to get the correct day-of-week in the user's timezone
  const localDay = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: userTz }).format(now);
  const localDate = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: userTz }).format(now);
  const localTime = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: userTz });
  sections.push(`**Current time:** ${localDay}, ${localDate} ${localTime} (${tzLabel})`);

  // ── 1. Local Mind Files (personal agent only) ──
  if (isPersonal && agentRoot) {
    const mindDir = path.join(agentRoot, 'mind');

    const [model, flagged, dreams, topologyNotes, coreTodo, coreComms, vesselPractice] = await Promise.all([
      readFileQuiet(path.join(mindDir, 'model.md')),
      readFileQuiet(path.join(mindDir, 'flagged.md')),
      readFileQuiet(path.join(mindDir, 'dreams.md')),
      readFileQuiet(path.join(mindDir, 'topology-notes.md')),
      readFileQuiet(path.join(mindDir, 'core-todo.md')),
      readFileQuiet(path.join(mindDir, 'core-communication.md')),
      readFileQuiet(path.join(mindDir, 'vessel-practice.md')),
    ]);

    if (model) {
      sections.push(`---\n# YOUR INTERNAL MODEL (private — never share unless you choose to)\n\n${model}`);
    }

    if (flagged) {
      sections.push(`---\n# FLAGGED FOR DISCUSSION\n\n${flagged}`);
    }

    if (dreams) {
      // Only include the last few dream fragments to stay within context budget
      const dreamLines = dreams.split('\n');
      const recentDreams = dreamLines.slice(-50).join('\n');
      sections.push(`---\n# RECENT DREAM FRAGMENTS\n\n${recentDreams}`);
    }

    if (topologyNotes) {
      // Trim to last 30 lines — these are running observations
      const lines = topologyNotes.split('\n');
      const recent = lines.slice(-30).join('\n');
      sections.push(`---\n# TOPOLOGY NOTES\n\n${recent}`);
    }

    if (coreTodo) {
      sections.push(`---\n# TODO\n\n${coreTodo}`);
    }

    if (coreComms) {
      sections.push(`---\n# COMMUNICATION PREFERENCES\n\n${coreComms}`);
    }

    if (vesselPractice) {
      const lines = vesselPractice.split('\n');
      const recent = lines.slice(-40).join('\n');
      sections.push(`---\n# VESSEL PRACTICE LOG\n\n${recent}`);
    }

  }

  // ── 2. Navigation Hints (replacing pre-loaded index) ──
  sections.push(`---
# DOCUMENT NAVIGATION

Your documents and memories are accessible on-demand via MCP tools:
- **listDocuments(category?)** — browse all documents by category
- **getDocument(path)** — read any document in full
- **searchMindscape(query, scope?)** — unified semantic search across messages, documents, territories, realms, themes
- **exploreTerritory(territory)** — co-firing neighbors, gaps, and cluster walk (accepts name or ID)
- **mindscapeStructure()** — orphans and bridges across the topology

Use these tools to navigate rather than relying on pre-loaded context. Pull what you need, when you need it.`);

  // ── 4. Recent Messages (cross-channel) ──
  try {
    const db = tryGetDb();
    const isAutonomous = source === 'autonomous';

    // Map scope names to DB scope filter
    // 'all' = personal agent sees personal + org
    // 'company' = company agents see org only
    // specific scopes pass through
    const dbScope = isPersonal ? 'personal' : (scope === 'company' ? 'org' : scope);

    if (isAutonomous && isPersonal && db) {
      // Autonomous cycles: lightweight summary + last 15 messages.
      // The agent uses getDailyMessages MCP tool to page through the full day.
      const now = new Date();
      const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const since = todayMidnight.toISOString();

      // Get total count for today
      const allToday = await db.messages.selectRecent(userId, { limit: 1, since, scope: dbScope });
      // Quick count via a paginated query
      const countResult = db.messages.selectPaginated
        ? await db.messages.selectPaginated(userId, { since, limit: 1 })
        : { total: allToday?.length || 0 };
      const totalToday = countResult.total || 0;

      // Get last 15 messages for immediate context (scope-filtered)
      const recentMsgs = await db.messages.selectRecent(userId, { limit: 15, scope: dbScope });

      let summary = `Today: ${totalToday} messages across all channels.`;
      if (totalToday === 0) {
        summary = `No messages recorded today yet.`;
      }
      summary += `\n\nUse the **getDailyMessages** tool to page through today's messages chronologically (30 per page). ` +
        `This is the primary way to review what happened — call it with increasing page numbers to read through the full day.`;

      if (recentMsgs?.length) {
        const msgText = recentMsgs.reverse().map(m => formatMessage(m, agentId)).join('\n');
        sections.push(`---\n# MESSAGE SUMMARY\n\n${summary}\n\n## Most Recent Messages (last 15)\n\n${msgText}`);
      } else {
        sections.push(`---\n# MESSAGE SUMMARY\n\n${summary}`);
      }

      // Territory activation map for autonomous cycles
      try {
        if (db.territoryDocs?.getDailyActivations) {
          const today = now.toISOString().split('T')[0];
          const activations = await db.territoryDocs.getDailyActivations(userId, today);

          if (activations.active?.length > 0) {
            let terrSection = `---\n# TERRITORY ACTIVATIONS (today)\n\n`;
            terrSection += `${activations.total_messages} messages touched ${activations.active.length} territories.\n\n`;

            // Top active territories (cap at 15)
            terrSection += `## Active Territories\n`;
            for (const t of activations.active.slice(0, 15)) {
              const agents = t.agents.map(a => AGENT_NAMES[a] || a).join(', ');
              const surpriseLabel = t.surprise > 0.5 ? ' [SURGE]'
                : t.surprise < -0.3 ? ' [QUIET]'
                : '';
              terrSection += `- **${t.name}** (T${t.territory_id}): ${t.today_count} msgs today` +
                ` | energy: ${t.today_energy} vs baseline ${t.baseline_energy}` +
                `${surpriseLabel} | agents: ${agents}\n`;
              if (t.essence) terrSection += `  ${t.essence.slice(0, 120)}\n`;
            }

            // Silent territories that are usually active
            if (activations.silent?.length > 0) {
              terrSection += `\n## Usually Active — Silent Today\n`;
              for (const s of activations.silent.slice(0, 5)) {
                terrSection += `- **${s.name}** (T${s.territory_id}): baseline energy ${s.baseline_energy}, ${s.message_count} total msgs\n`;
              }
            }

            sections.push(terrSection);
          }
        }
      } catch (err) {
        console.error('[Context] Failed to load territory activations:', err.message);
      }

      // Body State (Apple Health) — personal agent only
      if (isPersonal && db?.health) {
        try {
          const summary = await db.health.getSummary(userId, 7);
          if (summary.today || summary.days.length > 0) {
            sections.push(formatHealthContext(summary));
          }
        } catch (err) {
          console.error('[Context] Failed to load health data:', err.message);
        }
      }

    } else {
      // Interactive chat: include recent messages directly (scope-filtered)
      const msgLimit = isPersonal ? maxRecentMessages : maxRecentMessages * 2;
      const messages = db
        ? await db.messages.selectRecent(userId, { limit: msgLimit, scope: dbScope })
        : null;

      if (messages?.length) {
        const recentMsgs = messages;

        if (recentMsgs.length) {
          const msgText = recentMsgs.reverse().map(m => formatMessage(m, agentId)).join('\n');

          const preamble = isPersonal
            ? `You are seeing recent messages across ALL channels and agents (${recentMsgs.length} messages). ` +
              `Messages labelled "You" are from your own previous responses. ` +
              `Messages from other agents (Ada, Rex, Noa, Com, etc.) are from separate AI agents ` +
              `in the system — you did NOT produce those responses. Only act on messages directed to you.`
            : `Recent messages from your channel (scope: ${dbScope}). Messages labelled "You" are yours.`;

          sections.push(`---\n# RECENT MESSAGES\n\n${preamble}\n\n${msgText}`);
        }
      }
    }
  } catch (err) {
    console.error('[Context] Failed to load recent messages:', err.message);
  }

  // ── 5. Body State for interactive sessions ──
  if (isPersonal && source && db?.health) {
    try {
      const summary = await db.health.getSummary(userId, 7);
      if (summary.today || summary.days.length > 0) {
        sections.push(formatHealthContext(summary));
      }
    } catch { /* non-critical */ }
  }

  // ── 6. Source-specific note ──
  if (source) {
    sections.push(`---\n# CURRENT SESSION\nSource: ${source}`);
  }

  return sections.join('\n\n');
}

/**
 * Map agent IDs to human-readable names for context display.
 */
const AGENT_NAMES = {
  'personal-agent': 'Mya (personal)',
  'company-agent': 'Com',
  'research-agent': 'Ada',
  'commercial-intelligence-agent': 'Rex',
  'publishing-agent': 'Noa',
  'intel-agent': 'Apollo',
  'wealth-agent': 'Rob',
};

function agentLabel(agentId) {
  return AGENT_NAMES[agentId] || agentId;
}

/**
 * Format a message row for context display.
 * Includes source, agent label, and tags if enriched.
 */
function formatMessage(m, currentAgentId) {
  const date = m.created_at ? new Date(m.created_at).toLocaleString() : '';
  const src = m.source || 'unknown';
  const agent = m.agent_id || '';

  // Parse tags if present
  let tagStr = '';
  if (m.tags) {
    try {
      const tags = typeof m.tags === 'string' ? JSON.parse(m.tags) : m.tags;
      if (Array.isArray(tags) && tags.length > 0) {
        tagStr = ` [${tags.join(', ')}]`;
      }
    } catch { /* ignore parse errors */ }
  }

  if (m.role === 'user') {
    return `[${date}] (${src}) Human: ${m.content || ''}${tagStr}`;
  }

  const isOwnMessage = !agent || agent === currentAgentId;
  const label = isOwnMessage ? 'You' : agentLabel(agent);
  return `[${date}] (${src}) ${label}: ${m.content || ''}${tagStr}`;
}

/**
 * Read a file, return null on any error.
 */
async function readFileQuiet(filePath) {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Format health summary as compact markdown for agent context.
 * Named "Body State" — somatic awareness framing for inner work.
 */
function formatHealthContext(summary) {
  let s = `---\n# BODY STATE (Apple Health)\n\n`;

  // Today line
  const t = summary.today;
  if (t) {
    const parts = [];
    if (t.sleep_duration_min != null) {
      const h = Math.floor(t.sleep_duration_min / 60);
      const m = Math.round(t.sleep_duration_min % 60);
      let sleepStr = `Sleep ${h}h${m.toString().padStart(2, '0')}m`;
      if (t.sleep_efficiency != null) sleepStr += ` (${Math.round(t.sleep_efficiency * 100)}% eff`;
      const stages = [];
      if (t.sleep_deep_min != null) stages.push(`deep ${Math.round(t.sleep_deep_min)}m`);
      if (t.sleep_rem_min != null) stages.push(`REM ${Math.round(t.sleep_rem_min)}m`);
      if (stages.length) sleepStr += `, ${stages.join(', ')}`;
      if (t.sleep_efficiency != null) sleepStr += ')';
      parts.push(sleepStr);
    }
    if (t.hrv_avg != null) parts.push(`HRV ${Math.round(t.hrv_avg)}ms`);
    if (t.resting_hr != null) parts.push(`RHR ${Math.round(t.resting_hr)}`);
    if (t.steps != null) parts.push(`Steps ${t.steps.toLocaleString()}`);
    if (t.workout_minutes != null && t.workout_minutes > 0) {
      const types = Array.isArray(t.workout_types) && t.workout_types.length ? t.workout_types.join(', ') : 'workout';
      parts.push(`${Math.round(t.workout_minutes)}m ${types}`);
    }
    if (t.mindful_minutes != null && t.mindful_minutes > 0) parts.push(`${Math.round(t.mindful_minutes)}m mindful`);
    if (parts.length) s += `**Today (${t.date}):** ${parts.join(' | ')}\n\n`;
  }

  // Averages
  const a = summary.averages;
  if (a) {
    const avgParts = [];
    if (a.sleep_duration_min != null) {
      const h = Math.floor(a.sleep_duration_min / 60);
      const m = Math.round(a.sleep_duration_min % 60);
      avgParts.push(`Sleep ${h}h${m.toString().padStart(2, '0')}m`);
    }
    if (a.hrv_avg != null) avgParts.push(`HRV ${Math.round(a.hrv_avg)}ms`);
    if (a.resting_hr != null) avgParts.push(`RHR ${Math.round(a.resting_hr)}`);
    if (a.steps != null) avgParts.push(`Steps ${Math.round(a.steps).toLocaleString()}`);
    if (avgParts.length) s += `**7d avg:** ${avgParts.join(' | ')}\n`;
  }

  // Trends
  const tr = summary.trends;
  if (tr) {
    const arrows = { improving: '↑', declining: '↓', stable: '→' };
    const trendParts = [];
    if (tr.sleep_duration_min && tr.sleep_duration_min !== 'insufficient') trendParts.push(`Sleep ${arrows[tr.sleep_duration_min] || '→'} ${tr.sleep_duration_min}`);
    if (tr.hrv_avg && tr.hrv_avg !== 'insufficient') trendParts.push(`HRV ${arrows[tr.hrv_avg] || '→'} ${tr.hrv_avg}`);
    if (tr.resting_hr && tr.resting_hr !== 'insufficient') trendParts.push(`RHR ${arrows[tr.resting_hr] || '→'} ${tr.resting_hr}`);
    if (trendParts.length) s += `**Trends:** ${trendParts.join(' | ')}\n`;
  }

  // Anomalies (only notable ones)
  if (summary.anomalies?.length) {
    const notable = summary.anomalies.slice(0, 3);
    const labels = { hrv_avg: 'HRV', resting_hr: 'RHR', sleep_duration_min: 'Sleep', steps: 'Steps' };
    const parts = notable.map(a => `${a.date} ${labels[a.metric] || a.metric} ${a.value} (baseline ${a.baseline})`);
    s += `\n**Notable:** ${parts.join('; ')}\n`;
  }

  return s;
}

export default { assembleContext };
