/**
 * Discord inbound gateway — lazy-imports discord.js (an OPTIONAL dep, like the
 * Agent SDK). The gateway is a stateful WS protocol with heartbeat/resume/zombie
 * footguns; discord.js handles them battle-tested, so we don't hand-roll it.
 * Egress stays raw-fetch REST (discord-api.js) — discord.js is ONLY for inbound.
 *
 * Requires the privileged MESSAGE_CONTENT intent (enable it in the Discord dev
 * portal) to read message text in guilds; DMs always include content.
 */
import { normalizeDiscordMessage } from './discord-normalize.js';

async function loadDiscordJs() {
  try {
    return await import('discord.js');
  } catch (e) {
    throw new Error('channel-daemon: discord.js is required for the Discord inbound gateway (npm i discord.js). Underlying: ' + e.message);
  }
}

/**
 * @param {object} deps
 * @param {string} deps.botToken
 * @param {(msg:object)=>Promise<void>} deps.handleInbound
 * @param {string} [deps.logPrefix]
 */
export function createDiscordGateway({ botToken, handleInbound, logPrefix = 'channel-daemon' }) {
  if (!botToken) throw new TypeError('createDiscordGateway: botToken required');
  if (typeof handleInbound !== 'function') throw new TypeError('createDiscordGateway: handleInbound required');
  let client = null;

  return {
    async start() {
      const { Client, GatewayIntentBits, Partials, Events } = await loadDiscordJs();
      client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent, // privileged — enable in dev portal
          GatewayIntentBits.DirectMessages,
        ],
        partials: [Partials.Channel], // required to receive DMs
      });
      client.on(Events.MessageCreate, async (msg) => {
        try {
          const norm = normalizeDiscordMessage(msg);
          if (!norm || norm.isBot) return; // never react to bot messages (loop guard)
          await handleInbound(norm);
        } catch (e) {
          console.error(`[${logPrefix}] discord inbound error: ${e.message}`);
        }
      });
      client.once(Events.ClientReady, (c) => console.log(`[${logPrefix}] discord gateway ready as ${c.user?.tag}`));
      client.on('error', (e) => console.error(`[${logPrefix}] discord client error: ${e.message}`));
      await client.login(botToken);
    },
    async stop() {
      try { await client?.destroy(); } catch { /* */ }
    },
  };
}
