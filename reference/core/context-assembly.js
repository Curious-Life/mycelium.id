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
import { createTTLCache } from './ttl-cache.js';
import { createMindFiles } from './mind-files.js';

// Per-process TTL caches keyed on userId. Each cached primitive is a
// function of userId only — agentId / scope / source enter assembly
// downstream. Bounded staleness (60s for live data, 1h for timezone)
// is acceptable because the awareness output is system-prompt prose,
// never parsed by a tool or branched on. See
// docs/D1-COST-CHANGE-4-DESIGN-2026-05-06.md §3 for the full rationale.
const TZ_CACHE = createTTLCache({ ttlMs: 3_600_000, maxSize: 16 });
const FISHER_CACHE = createTTLCache({ ttlMs: 60_000, maxSize: 16 });
const HEALTH_CACHE = createTTLCache({ ttlMs: 60_000, maxSize: 16 });
const AWARENESS_CACHE = createTTLCache({ ttlMs: 60_000, maxSize: 16 });

/**
 * Drop every cached entry across all context-assembly caches.
 * Test-only helper — production code should let TTL expire naturally.
 */
export function clearAllCaches() {
  TZ_CACHE.clear();
  FISHER_CACHE.clear();
  HEALTH_CACHE.clear();
  AWARENESS_CACHE.clear();
}

/**
 * Snapshot of cache stats for /health/context-cache observability.
 */
export function contextCacheStats() {
  return {
    timezone: TZ_CACHE.stats(),
    fisher: FISHER_CACHE.stats(),
    health: HEALTH_CACHE.stats(),
    awareness: AWARENESS_CACHE.stats(),
  };
}

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

  // Resolve DB once at function scope. Sections 0, 4, 5, 6 all need it;
  // previously each section declared its own `const db = tryGetDb()`
  // inside a try block, so later sections referenced an undefined `db`
  // and silently failed with "db is not defined" (including the body-
  // state health read and the awareness-state mindscape probe —
  // meaning the agent never got territory coverage context).
  let db = null;
  try { db = tryGetDb(); } catch { /* use null */ }

  // Minimal-context agents only get the timestamp
  if (MINIMAL_CONTEXT_AGENTS.has(agentId)) {
    const now = new Date();
    let userTz = 'UTC', tzLabel = 'UTC';
    try {
      if (db && userId) {
        const tz = await TZ_CACHE.getOrLoad(userId, () => db.users.getTimezone(userId));
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
    if (db && userId) {
      const tz = await TZ_CACHE.getOrLoad(userId, () => db.users.getTimezone(userId));
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
    // Encryption-aware reads: createMindFiles wraps fs.readFile with
    // crypto-local decrypt-on-read (magic-bytes detection + scope from
    // mind/<filename> path). Plaintext-passthrough during rollout.
    // See packages/core/mind-files.js + design v2.2 §"Architecture".
    const mindFiles = createMindFiles({ agentRoot, agentId, fs, path });
    const { readMindFile } = mindFiles;

    const [model, flagged, dreams, topologyNotes, coreTodo, coreComms, vesselPractice] = await Promise.all([
      readMindFile('model.md'),
      readMindFile('flagged.md'),
      readMindFile('dreams.md'),
      readMindFile('topology-notes.md'),
      readMindFile('core-todo.md'),
      readMindFile('core-communication.md'),
      readMindFile('vessel-practice.md'),
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
              const agents = t.agents.map(a => agentLabel(a)).join(', ');
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

      // Cognitive Movement (Fisher Trajectory) — personal agent only.
      // Phase is decision-steering: cycling → integrate, transforming →
      // support, stable → ground, exploring → support divergence. Pre-load
      // headline at all three levels (realm / theme / territory) plus the
      // newest active milestone — when phases differ across scales they
      // tell the agent something specific (e.g., realm cycling + theme
      // exploring = local growth within a stable larger arc).
      // Detailed trajectory queries stay on-demand via MCP tools.
      if (isPersonal && db?.fisher) {
        try {
          const fisherData = await FISHER_CACHE.getOrLoad(userId, async () => ({
            phase: await db.fisher.getCurrentPhase(userId, { level: 'all' }),
            milestones: await db.fisher.getActiveMilestones(userId, { limit: 1 }),
          }));
          const { phase: allLevels, milestones } = fisherData;
          if (allLevels || milestones.length > 0) {
            sections.push(formatCognitiveMovement(allLevels, milestones[0] || null));
          }
        } catch (err) {
          console.error('[Context] Failed to load Fisher trajectory:', err.message);
        }
      }

      // Body State (Apple Health) — personal agent only
      if (isPersonal && db?.health) {
        try {
          const summary = await HEALTH_CACHE.getOrLoad(userId, () => db.health.getSummary(userId, 7));
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
      const summary = await HEALTH_CACHE.getOrLoad(userId, () => db.health.getSummary(userId, 7));
      if (summary.today || summary.days.length > 0) {
        sections.push(formatHealthContext(summary));
      }
    } catch { /* non-critical */ }
  }

  // ── 6. Awareness State — what you've seen, what you haven't ──
  if (db && userId) {
    try {
      const awarenessSection = await AWARENESS_CACHE.getOrLoad(
        userId,
        () => buildAwarenessContext(db, userId),
      );
      if (awarenessSection) sections.push(awarenessSection);
    } catch (err) {
      console.error('[Context] Failed to build awareness state:', err.message);
    }
  }

  // ── 7. Source-specific note ──
  if (source) {
    sections.push(`---\n# CURRENT SESSION\nSource: ${source}`);
  }

  return sections.join('\n\n');
}

import { getAgentDisplayName } from './agent-config.js';

function agentLabel(agentId) {
  return getAgentDisplayName(agentId);
}

/**
 * Build spatial-temporal awareness context.
 * Tells the agent what it has explored, what it hasn't, and where its understanding is strong vs weak.
 */
async function buildAwarenessContext(db, userId) {
  // Query exploration stats in parallel
  const [totalStats, realmStats, darkPeriods, recentExploration] = await Promise.all([
    // Global coverage
    db.rawQuery(
      `SELECT COUNT(*) as total_territories,
              COUNT(chronicle) as described,
              COALESCE(SUM(explored_count), 0) as analyzed,
              COALESCE(SUM(message_count), 0) as total_points
       FROM territory_profiles WHERE user_id = ?`,
      [userId],
    ).then(r => r[0] || {}),

    // Per-realm coverage (top 8 realms by size)
    db.rawQuery(
      `SELECT r.name, r.realm_id,
              COUNT(tp.territory_id) as territories,
              COALESCE(ROUND(SUM(tp.explored_percent * tp.message_count) / NULLIF(SUM(tp.message_count), 0), 0), 0) as explored_pct,
              COALESCE(SUM(tp.message_count), 0) as points
       FROM realms r
       LEFT JOIN territory_profiles tp ON tp.realm_id = r.realm_id AND tp.user_id = r.user_id
       WHERE r.user_id = ?
       GROUP BY r.realm_id
       ORDER BY points DESC LIMIT 8`,
      [userId],
    ),

    // Months with data but no chronicles (dark periods).
    // user_id = ? (was IS NOT NULL): admin DB has 10+ user_ids — legacy text
    // '<owner-handle>', NULL Telegram-bug rows, Discord snowflakes, cross-tenant
    // operator-routing rows — and the open form was contaminating the owner's
    // awareness section with months dominated by other-user data.
    db.rawQuery(
      `SELECT substr(cp.created_at, 1, 7) as month, COUNT(*) as points
       FROM clustering_points cp
       WHERE cp.user_id = ?
         AND substr(cp.created_at, 1, 7) NOT IN (
           SELECT substr(period_key, 1, 7) FROM time_chronicles WHERE user_id = ? AND granularity = 'day'
         )
       GROUP BY month ORDER BY points DESC LIMIT 5`,
      [userId, userId],
    ),

    // Most recent exploration (last pass note)
    db.rawQuery(
      `SELECT tpn.created_at, tp.name as territory_name, tpn.cumulative_percent
       FROM territory_pass_notes tpn
       LEFT JOIN territory_profiles tp ON tp.territory_id = tpn.territory_id AND tp.user_id = tpn.user_id
       WHERE tpn.user_id = ?
       ORDER BY tpn.created_at DESC LIMIT 1`,
      [userId],
    ),
  ]);

  const total = totalStats.total_territories || 0;
  const described = totalStats.described || 0;
  const analyzed = totalStats.analyzed || 0;
  const totalPoints = totalStats.total_points || 0;

  if (total === 0) return null;

  const globalPct = totalPoints > 0 ? Math.round((analyzed / totalPoints) * 100) : 0;

  let section = `---\n# YOUR AWARENESS STATE\n\n`;
  section += `You have explored **${globalPct}%** of the content in this vault. `;
  section += `${described} of ${total} territories have chronicles. `;
  section += `${analyzed.toLocaleString()} of ${totalPoints.toLocaleString()} data points have been read.\n\n`;

  // What you know well
  const strong = (realmStats || []).filter(r => r.explored_pct >= 50 && r.name);
  const weak = (realmStats || []).filter(r => r.explored_pct < 30 && r.name && r.points > 10);

  if (strong.length > 0) {
    section += `**You know well:** ${strong.map(r => `${r.name} (${r.explored_pct}%)`).join(', ')}\n`;
  }
  if (weak.length > 0) {
    section += `**You have gaps in:** ${weak.map(r => `${r.name} (${r.explored_pct}%)`).join(', ')}\n`;
  }

  // Dark periods
  if (darkPeriods?.length > 0) {
    const darkList = darkPeriods.slice(0, 3).map(d => `${d.month} (${d.points} points)`).join(', ');
    section += `**Unilluminated periods:** ${darkList}\n`;
  }

  // Recency
  if (recentExploration?.length > 0) {
    const last = recentExploration[0];
    const ago = Math.round((Date.now() - new Date(last.created_at).getTime()) / 3600000);
    const agoLabel = ago < 1 ? 'just now' : ago < 24 ? `${ago}h ago` : `${Math.round(ago / 24)}d ago`;
    section += `**Last exploration:** ${agoLabel}`;
    if (last.territory_name) section += ` (${last.territory_name}, ${last.cumulative_percent}% coverage)`;
    section += '\n';
  }

  section += `\nWhen you answer questions or reflect, be honest about what you have and haven't read. `;
  section += `If your answer draws on well-explored territories, you can be confident. `;
  section += `If it touches areas you haven't explored, say so — "I haven't read much from that period" or "my understanding of that area is thin." `;
  section += `This honesty builds trust and helps your person know when to point the lens at dark spots.`;

  return section;
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

/**
 * Format Fisher trajectory headline for the agent's system context.
 *
 * Pre-loaded for personal-scope agents only. Three compact lines (one per
 * hierarchy level: realm / theme / territory) + the newest active milestone
 * if any. Full trajectory access stays on-demand via MCP tools to keep
 * prompt budget lean.
 *
 * Phase is decision-steering, not just informational — see tone-tuning
 * paragraph below. When phases differ across levels they carry distinct
 * signal (realm cycling + theme exploring = local growth in a stable arc).
 *
 * Accepts either:
 *   - { realm, theme, territory } — multi-level dict from getCurrentPhase('all')
 *   - a single phaseRow (legacy single-level call)
 *   - null (no data yet)
 */
function formatCognitiveMovement(allLevels, milestone) {
  const lines = ['---', '# COGNITIVE MOVEMENT (Fisher Trajectory)', ''];

  // Helper: format one phase row as a single line.
  const formatRow = (label, row) => {
    if (!row) return `${label}: _no data_`;
    const phase = row.phase || 'unknown';
    const parts = [];
    if (row.exploration_ratio != null) parts.push(`R=${Number(row.exploration_ratio).toFixed(2)}`);
    if (row.fisher_velocity_z != null) parts.push(`z=${Number(row.fisher_velocity_z).toFixed(1)}σ`);
    const detail = parts.length ? ` (${parts.join(', ')})` : '';
    const lc = row.low_confidence ? ' _low-conf_' : '';
    return `${label}: **${phase}**${detail}${lc}`;
  };

  // Single-level legacy shape: a row with .phase at the top level.
  const isSingle = allLevels && typeof allLevels === 'object' && 'phase' in allLevels && !('realm' in allLevels);
  if (isSingle) {
    lines.push(formatRow('Phase', allLevels));
  } else if (allLevels) {
    lines.push(formatRow('Realm    ', allLevels.realm));
    lines.push(formatRow('Theme    ', allLevels.theme));
    lines.push(formatRow('Territory', allLevels.territory));
  } else {
    lines.push('Phase: no trajectory data yet (Fisher pipeline not run, or insufficient history).');
  }

  if (milestone) {
    lines.push('');
    lines.push(`Active milestone (realm): ${milestone.headline || `(${milestone.rule_type})`}`);
  }

  // Tone-tuning addendum — kept terse so it doesn't bloat the prompt.
  // The phase signal earns this paragraph of guidance because it's a
  // wayfinding cue: the same agent should respond differently to the
  // same question depending on where you are in your arc.
  //
  // Multi-level reading: when realm and theme differ, theme is the more
  // immediate signal; realm is the longer arc. If realm is cycling but
  // theme is exploring, the user has local growth happening within a
  // stable larger pattern — support both.
  lines.push('');
  lines.push('When phase is `cycling`, prefer integration moves (synthesizing what is already present) over expansion. When `transforming`, support the trajectory — name what is shifting. When `stable`, hold ground and depth. When `exploring`, follow divergence. When realm and theme phases differ, the theme is the closer signal to current activity; realm is the longer arc.');

  return lines.join('\n');
}

export default { assembleContext };
