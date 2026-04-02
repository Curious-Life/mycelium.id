/**
 * Intelligence Agent Discord Bot (Apollo)
 *
 * Dedicated Discord bot for the intelligence agent.
 * Uses the unified AgentDiscordBot class in single-agent mode.
 */

import './lib/sentry.js';
import 'dotenv/config';
import { bootstrapSecrets, refreshSecrets } from './lib/bootstrap-secrets.js';
import { AgentDiscordBot } from './lib/discord-bot.js';

await bootstrapSecrets();

const bot = new AgentDiscordBot({
  token: process.env.DISCORD_INTEL_BOT_TOKEN,
  httpPort: parseInt(process.env.APOLLO_BOT_PORT || '5013'),
  mode: 'single',
  botName: 'Apollo',
  agentUrl: process.env.INTEL_AGENT_URL || 'http://localhost:5012',
  agentId: 'intel-agent',
  channelId: process.env.DISCORD_INTEL_CHANNEL,
  allowedServers: (process.env.DISCORD_ALLOWED_SERVERS || '').split(',').filter(Boolean),
  allowedUsers: (process.env.DISCORD_ALLOWED_USERS || '').split(',').filter(Boolean),
});

export async function startIntelBot() {
  return bot.start();
}

export async function stopIntelBot() {
  return bot.stop();
}

export default { startIntelBot, stopIntelBot, client: bot.client };

// Auto-start
startIntelBot().catch(console.error);
