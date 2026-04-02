/**
 * Personal Agent Discord Bot (Mya)
 *
 * Dedicated Discord bot for the personal agent.
 * Uses the unified AgentDiscordBot class in single-agent mode.
 * No channelId — responds only when @mentioned in any channel.
 */

import './lib/sentry.js';
import 'dotenv/config';
import { bootstrapSecrets, refreshSecrets } from './lib/bootstrap-secrets.js';
import { AgentDiscordBot } from './lib/discord-bot.js';

await bootstrapSecrets();

const bot = new AgentDiscordBot({
  token: process.env.DISCORD_MYA_BOT_TOKEN,
  httpPort: parseInt(process.env.MYA_BOT_PORT || '5009'),
  mode: 'single',
  botName: 'Mya',
  agentUrl: process.env.PERSONAL_AGENT_URL || 'http://localhost:3004',
  agentId: 'personal-agent',
  channelId: process.env.MYA_CHANNEL_ID, // Private channel where Mya responds without @mention
  allowedServers: (process.env.DISCORD_ALLOWED_SERVERS || '').split(',').filter(Boolean),
  allowedUsers: (process.env.DISCORD_ALLOWED_USERS || '').split(',').filter(Boolean),
});

export async function startMyaBot() {
  return bot.start();
}

export async function stopMyaBot() {
  return bot.stop();
}

export default { startMyaBot, stopMyaBot, client: bot.client };

// Auto-start
startMyaBot().catch(console.error);
