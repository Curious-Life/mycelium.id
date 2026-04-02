/**
 * Commercial Intelligence Agent Discord Bot (Rex)
 *
 * Dedicated Discord bot for the commercial intelligence agent.
 * Uses the unified AgentDiscordBot class in single-agent mode.
 */

import './lib/sentry.js';
import 'dotenv/config';
import { bootstrapSecrets, refreshSecrets } from './lib/bootstrap-secrets.js';
import { AgentDiscordBot } from './lib/discord-bot.js';

await bootstrapSecrets();

const bot = new AgentDiscordBot({
  token: process.env.DISCORD_COMMERCIAL_INTEL_BOT_TOKEN,
  httpPort: parseInt(process.env.REX_BOT_PORT || '5005'),
  mode: 'single',
  botName: 'Rex',
  agentUrl: process.env.COMMERCIAL_INTEL_AGENT_URL || 'http://localhost:5003',
  agentId: 'commercial-intelligence-agent',
  channelId: process.env.DISCORD_COMMERCIAL_INTEL_CHANNEL,
  allowedServers: (process.env.DISCORD_ALLOWED_SERVERS || '').split(',').filter(Boolean),
  allowedUsers: (process.env.DISCORD_ALLOWED_USERS || '').split(',').filter(Boolean),
});

export async function startCommercialIntelBot() {
  return bot.start();
}

export async function stopCommercialIntelBot() {
  return bot.stop();
}

export default { startCommercialIntelBot, stopCommercialIntelBot, client: bot.client };

// Auto-start
startCommercialIntelBot().catch(console.error);
