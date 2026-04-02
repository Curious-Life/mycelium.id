/**
 * Agent Collaboration Module
 *
 * Enables agents to communicate via #agent-collab Discord channel.
 * - Rate limiting for delegations (max 3/hour per agent)
 * - Helper functions for detecting collab messages
 * - Bot identity registration (URL, Discord user ID, display name)
 * - Collab announcements with debounce (visible delegation in #agent-collab)
 *
 * Two name resolution modes (critical for loop prevention):
 * - getBotLabel(agentId)   → "**Ada**" (bold text, for announcements — never triggers bots)
 * - getBotMention(agentId) → "<@1234567890>" (real @mention — only for intentional conversations)
 */

// Configuration
const COLLAB_CHANNEL_ID = process.env.DISCORD_COLLAB_CHANNEL;
const MAX_DELEGATIONS_PER_HOUR = 3;

// Known bot IDs — loaded from agents/*.json config
import { getCollabBotIds, getAgentToBotName } from './agent-config.js';
const BOT_IDS = getCollabBotIds();

// Bot identity maps (populated by each bot on startup via registerBot*)
const BOT_URLS = new Map();      // agentId → bot HTTP URL
const BOT_MENTIONS = new Map();  // agentId → Discord user ID
const BOT_NAMES = new Map();     // agentId → display name

// Rate limiting (in-memory, resets on restart)
// For persistence, could move to Supabase
const delegations = new Map(); // agentId -> { count, resetAt }

/**
 * Check if an agent can delegate (hasn't exceeded rate limit)
 */
export function canDelegate(agentId) {
  const now = Date.now();
  const record = delegations.get(agentId) || { count: 0, resetAt: now + 3600000 };

  // Reset if hour passed
  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + 3600000;
    delegations.set(agentId, record);
  }

  return record.count < MAX_DELEGATIONS_PER_HOUR;
}

/**
 * Record a delegation and return remaining count
 */
export function recordDelegation(agentId) {
  const now = Date.now();
  let record = delegations.get(agentId) || { count: 0, resetAt: now + 3600000 };

  if (now > record.resetAt) {
    record = { count: 1, resetAt: now + 3600000 };
  } else {
    record.count++;
  }

  delegations.set(agentId, record);
  return MAX_DELEGATIONS_PER_HOUR - record.count;
}

/**
 * Get remaining delegations for an agent
 */
export function getRemainingDelegations(agentId) {
  const now = Date.now();
  const record = delegations.get(agentId) || { count: 0, resetAt: now + 3600000 };

  if (now > record.resetAt) {
    return MAX_DELEGATIONS_PER_HOUR;
  }

  return Math.max(0, MAX_DELEGATIONS_PER_HOUR - record.count);
}

/**
 * Check if a channel is the collab channel
 */
export function isCollabChannel(channelId) {
  return COLLAB_CHANNEL_ID && channelId === COLLAB_CHANNEL_ID;
}

/**
 * Get the collab channel ID
 */
export function getCollabChannelId() {
  return COLLAB_CHANNEL_ID;
}

/**
 * Check if a message is from a known bot (not the current one)
 */
export function isFromOtherBot(message, myBotId) {
  if (!message.author.bot) return false;
  if (message.author.id === myBotId) return false;
  return true;
}

/**
 * Check if the current bot was mentioned in the message
 */
export function wasMentionedInCollab(message, myBotId) {
  return message.mentions.users.has(myBotId);
}

/**
 * Set bot ID for tracking
 */
export function setBotId(name, id) {
  BOT_IDS[name] = id;
}

/**
 * Get bot ID by name
 */
export function getBotId(name) {
  return BOT_IDS[name];
}

/**
 * Check if collab is configured
 */
export function isCollabConfigured() {
  return !!COLLAB_CHANNEL_ID;
}

/**
 * Populate bot IDs from agent discovery.
 * Call on startup and periodically to keep in sync with running agents.
 * Falls back to env vars for any bots not found via discovery.
 *
 * @param {Function} discoverFn - async function returning agent list (e.g., discoverAgentsWithCards)
 */
// Map agentId → short bot name — loaded from agents/*.json config
const AGENT_TO_BOT_NAME = getAgentToBotName();

export async function refreshBotIds(discoverFn) {
  try {
    const agents = await discoverFn();
    for (const agent of agents) {
      if (agent.isRemote) continue;  // only track local bot IDs
      const botName = AGENT_TO_BOT_NAME[agent.agentId];
      if (botName) {
        setBotId(botName, agent.discordBotId || BOT_IDS[botName]);
      } else if (agent.discordBotId) {
        setBotId(agent.agentId, agent.discordBotId);
      }
    }
  } catch {
    // Non-fatal — keep using env var defaults
  }
}

// ============================================
// Bot Identity Registration
// ============================================

/**
 * Register a bot's HTTP URL (called by each bot on startup)
 */
export function registerBotUrl(agentId, httpUrl) {
  BOT_URLS.set(agentId, httpUrl);
}

/**
 * Register a bot's Discord user ID (called by each bot on startup)
 */
export function registerBotMention(agentId, discordUserId) {
  BOT_MENTIONS.set(agentId, discordUserId);
}

/**
 * Register a bot's display name (called by each bot on startup)
 */
export function registerBotName(agentId, displayName) {
  BOT_NAMES.set(agentId, displayName);
}

// ============================================
// Name Resolution (loop prevention)
// ============================================

/**
 * Get bold text label for an agent — for announcements.
 * NEVER triggers a bot. Use this in all delegation announcements.
 *
 * @param {string} agentId
 * @returns {string} e.g. "**Ada**"
 */
export function getBotLabel(agentId) {
  const name = BOT_NAMES.get(agentId) || agentId;
  return `**${name}**`;
}

/**
 * Get real Discord @mention for an agent — for intentional conversation starts.
 * ONLY use this when you want to trigger the bot to respond.
 *
 * @param {string} agentId
 * @returns {string} e.g. "<@1234567890>" or the agentId if not registered
 */
export function getBotMention(agentId) {
  const botUserId = BOT_MENTIONS.get(agentId);
  return botUserId ? `<@${botUserId}>` : agentId;
}

// ============================================
// Bot URL Resolution
// ============================================

/**
 * Resolve the HTTP URL of a bot process for an agent.
 * Falls back to orchestrator bot if not registered.
 *
 * @param {string} agentId
 * @returns {string} HTTP URL (e.g. "http://localhost:5003")
 */
export function resolveBotHttpUrl(agentId) {
  if (BOT_URLS.has(agentId)) return BOT_URLS.get(agentId);
  // Check env var (set per-agent in ecosystem.config.cjs)
  if (process.env.DISCORD_BOT_URL) return process.env.DISCORD_BOT_URL;
  // Default: orchestrator bot
  return process.env.ORCHESTRATOR_URL?.replace(':3000', ':3001') || 'http://localhost:3001';
}

// ============================================
// Collab Announcements (with debounce)
// ============================================

let pendingAnnouncements = [];
let debounceTimer = null;

/**
 * Announce to #agent-collab via the agent's own bot.
 * Fire-and-forget — delegation works even if Discord is down.
 * Batches announcements within 1 second to avoid Discord rate limits.
 *
 * @param {string} agentId - The agent making the announcement (determines which bot sends it)
 * @param {string} message - The message to post (use getBotLabel, NOT getBotMention)
 */
export function announceToCollab(agentId, message) {
  if (!COLLAB_CHANNEL_ID) return;

  pendingAnnouncements.push({ agentId, message });

  if (!debounceTimer) {
    debounceTimer = setTimeout(async () => {
      const batch = [...pendingAnnouncements];
      pendingAnnouncements = [];
      debounceTimer = null;

      // Group by agent so each bot sends its own messages
      const byAgent = new Map();
      for (const { agentId: aid, message: msg } of batch) {
        if (!byAgent.has(aid)) byAgent.set(aid, []);
        byAgent.get(aid).push(msg);
      }

      for (const [aid, messages] of byAgent) {
        const botUrl = resolveBotHttpUrl(aid);
        const content = messages.join('\n');
        try {
          await fetch(`${botUrl}/discord/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channelId: COLLAB_CHANNEL_ID, content }),
            signal: AbortSignal.timeout(3000),
          });
        } catch {
          // Fire-and-forget — delegation works without Discord
        }
      }
    }, 1000);
  }
}

export default {
  canDelegate,
  recordDelegation,
  getRemainingDelegations,
  isCollabChannel,
  getCollabChannelId,
  isFromOtherBot,
  wasMentionedInCollab,
  setBotId,
  getBotId,
  isCollabConfigured,
  refreshBotIds,
  // Bot identity
  registerBotUrl,
  registerBotMention,
  registerBotName,
  // Name resolution
  getBotLabel,
  getBotMention,
  // Bot URL resolution
  resolveBotHttpUrl,
  // Announcements
  announceToCollab,
  MAX_DELEGATIONS_PER_HOUR,
};
