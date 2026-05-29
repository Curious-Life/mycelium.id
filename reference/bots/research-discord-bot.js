/**
 * Research Agent Discord Bot (Ada)
 *
 * Dedicated Discord bot for the research agent.
 * Uses the unified AgentDiscordBot class in single-agent mode.
 */

import '@mycelium/core/sentry.js';
import 'dotenv/config';
import { bootstrapSecrets, refreshSecrets } from '@mycelium/core/bootstrap-secrets.js';
import { AgentDiscordBot } from '@mycelium/core/discord-bot.js';

await bootstrapSecrets();

const bot = new AgentDiscordBot({
  token: process.env.DISCORD_RESEARCH_BOT_TOKEN,
  httpPort: parseInt(process.env.ADA_BOT_PORT || '5003'),
  mode: 'single',
  botName: 'Ada',
  agentUrl: process.env.RESEARCH_AGENT_URL || 'http://localhost:5002',
  agentId: 'research-agent',
  channelId: process.env.DISCORD_RESEARCH_CHANNEL,
  allowedServers: (process.env.DISCORD_ALLOWED_SERVERS || '').split(',').filter(Boolean),
  allowedUsers: (process.env.DISCORD_ALLOWED_USERS || '').split(',').filter(Boolean),
});

export async function startResearchBot() {
  return bot.start();
}

export async function stopResearchBot() {
  return bot.stop();
}

export default { startResearchBot, stopResearchBot, client: bot.client };

// Auto-start
startResearchBot().catch(console.error);
