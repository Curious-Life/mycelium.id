/**
 * Discord Bot — Orchestrator (Com)
 *
 * Routes Discord messages to the appropriate MYA agent based on channel.
 * Uses the unified AgentDiscordBot class in orchestrator mode.
 *
 * Channels handled by dedicated bots (skipped here):
 * - #research → Ada (research-discord-bot.js)
 * - #commercial-intel → Rex (commercial-intel-discord-bot.js)
 * - #publishing → Noa (publishing-discord-bot.js)
 * - #intel → Apollo (intel-discord-bot.js)
 *
 * @mention routing: If a user @mentions another agent's bot in a general
 * channel, the orchestrator steps aside and lets that agent's own bot handle it.
 */

import './lib/sentry.js';
import 'dotenv/config';
import { AgentDiscordBot } from './lib/discord-bot.js';

// Agent URLs
const COMPANY_AGENT_URL = process.env.COMPANY_AGENT_URL || 'http://localhost:3002';

// Allowlist — Com only responds in these channels (general, product, marketing)
// All other channels belong to dedicated agent bots.
const allowChannels = [
  process.env.DISCORD_COMPANY_CHANNEL,   // #general / #product
  process.env.DISCORD_COLLAB_CHANNEL,    // #collab
].filter(Boolean);

// Other agent bot Discord IDs — when these are @mentioned, let their own bot handle it
const AGENT_BOT_IDS = [
  process.env.DISCORD_ADA_BOT_ID,
  process.env.DISCORD_REX_BOT_ID,
  process.env.DISCORD_NOA_BOT_ID,
  process.env.DISCORD_MYA_BOT_ID,
  process.env.DISCORD_ROB_BOT_ID,
  process.env.DISCORD_IRIS_BOT_ID,
].filter(Boolean);

// Monitor channels: bot/webhook messages ARE processed (e.g., bug notifications)
// Bug reports channel removed — Com was auto-reacting to Sentry notifications
// and trying to fix bugs autonomously. Bugs should be triaged manually.
const monitorChannels = [
].filter(Boolean);

// Bot instance created lazily (after bootstrap-secrets has populated process.env)
let bot = null;

function getBot() {
  if (!bot) {
    bot = new AgentDiscordBot({
      token: process.env.DISCORD_BOT_TOKEN,
      httpPort: parseInt(process.env.DISCORD_BOT_HTTP_PORT || '3001'),
      mode: 'orchestrator',
      botName: 'Com',
      botUserId: 'com-discord-bot',
      allowedServers: (process.env.DISCORD_ALLOWED_SERVERS || '').split(',').filter(Boolean),
      allowedUsers: (process.env.DISCORD_ALLOWED_USERS || '').split(',').filter(Boolean),
      allowChannels,
      monitorChannels,
      agentBotIds: AGENT_BOT_IDS,
      routes: [
        // Default: everything else goes to company-agent (Com)
        { channelId: '*', agentUrl: COMPANY_AGENT_URL, agentId: 'company-agent' },
      ],
    });
  }
  return bot;
}

export async function startDiscordBot() {
  return getBot().start();
}

export async function stopDiscordBot() {
  return getBot().stop();
}

export default { startDiscordBot, stopDiscordBot, get client() { return getBot().client; } };

// Auto-start if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  startDiscordBot().catch(console.error);
}
