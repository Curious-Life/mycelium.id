/**
 * Publishing Agent Discord Bot (Noa)
 *
 * Dedicated Discord bot for the publishing agent.
 * Uses the unified AgentDiscordBot class in single-agent mode.
 *
 * Noa specializes in writing, content creation, and publishing.
 * Has read-only access to Ada's research findings for reference.
 */

import '@mycelium/core/sentry.js';
import 'dotenv/config';
import { bootstrapSecrets, refreshSecrets } from '@mycelium/core/bootstrap-secrets.js';
import { AgentDiscordBot } from '@mycelium/core/discord-bot.js';

await bootstrapSecrets();

const bot = new AgentDiscordBot({
  token: process.env.DISCORD_PUBLISHING_BOT_TOKEN,
  httpPort: parseInt(process.env.NOA_BOT_PORT || '5007'),
  mode: 'single',
  botName: 'Noa',
  agentUrl: process.env.PUBLISHING_AGENT_URL || 'http://localhost:5006',
  agentId: 'publishing-agent',
  channelId: process.env.DISCORD_PUBLISHING_CHANNEL,
  allowedServers: (process.env.DISCORD_ALLOWED_SERVERS || '').split(',').filter(Boolean),
  allowedUsers: (process.env.DISCORD_ALLOWED_USERS || '').split(',').filter(Boolean),
});

export async function startPublishingBot() {
  return bot.start();
}

export async function stopPublishingBot() {
  return bot.stop();
}

export default { startPublishingBot, stopPublishingBot, client: bot.client };

// Auto-start
startPublishingBot().catch(console.error);
