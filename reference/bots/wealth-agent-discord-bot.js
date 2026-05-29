/**
 * Rob — Wealth Agent Discord Bot
 *
 * Dedicated Discord bot for the wealth-agent.
 * Uses the unified AgentDiscordBot class in single-agent mode.
 */

import '@mycelium/core/sentry.js';
import 'dotenv/config';
import { bootstrapSecrets, refreshSecrets } from '@mycelium/core/bootstrap-secrets.js';
import { AgentDiscordBot } from '@mycelium/core/discord-bot.js';

await bootstrapSecrets();

const bot = new AgentDiscordBot({
  token: process.env.DISCORD_WEALTH_BOT_TOKEN,
  httpPort: parseInt(process.env.WEALTH_BOT_PORT || '5011'),
  mode: 'single',
  botName: 'Rob',
  agentUrl: process.env.WEALTH_AGENT_URL || 'http://localhost:5010',
  agentId: 'wealth-agent',
  channelId: process.env.DISCORD_WEALTH_CHANNEL,
  allowedServers: (process.env.DISCORD_ALLOWED_SERVERS || '').split(',').filter(Boolean),
  allowedUsers: (process.env.DISCORD_ALLOWED_USERS || '').split(',').filter(Boolean),
  // Webhook bots whose messages Rob should process (e.g., Captain Hook trading reports)
  webhookBotIds: (process.env.DISCORD_WEBHOOK_BOT_IDS || '1480182601640841387').split(',').filter(Boolean),
});

export async function startRobBot() {
  return bot.start();
}

export async function stopRobBot() {
  return bot.stop();
}

export default { startRobBot, stopRobBot, client: bot.client };

// Auto-start
startRobBot().catch(console.error);
