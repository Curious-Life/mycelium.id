/**
 * Operations Agent Discord Bot (LevOps)
 *
 * Dedicated Discord bot for the ops-agent.
 * Uses the unified AgentDiscordBot class in single-agent mode.
 * Listens in #admin channel.
 */

import '@mycelium/core/sentry.js';
import 'dotenv/config';
import { bootstrapSecrets, refreshSecrets } from '@mycelium/core/bootstrap-secrets.js';
import { AgentDiscordBot } from '@mycelium/core/discord-bot.js';

await bootstrapSecrets();

const bot = new AgentDiscordBot({
  token: process.env.DISCORD_OPS_BOT_TOKEN,
  httpPort: parseInt(process.env.OPS_BOT_PORT || '5019'),
  mode: 'single',
  botName: 'LevOps',
  agentUrl: process.env.OPS_AGENT_URL || 'http://localhost:5018',
  agentId: 'ops-agent',
  channelId: process.env.DISCORD_ADMIN_CHANNEL,
  allowedServers: (process.env.DISCORD_ALLOWED_SERVERS || '').split(',').filter(Boolean),
  allowedUsers: (process.env.DISCORD_ALLOWED_USERS || '').split(',').filter(Boolean),
});

export async function startOpsBot() {
  return bot.start();
}

export async function stopOpsBot() {
  return bot.stop();
}

export default { startOpsBot, stopOpsBot, get client() { return bot.client; } };

// Auto-start
startOpsBot().catch(console.error);

// Periodic secret refresh
setInterval(refreshSecrets, 5 * 60 * 1000);
