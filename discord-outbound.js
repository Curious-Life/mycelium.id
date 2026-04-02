/**
 * Discord Outbound - Proactive messaging for the autonomous agent
 *
 * This module provides the capability for the agent to send messages
 * to Discord channels without being prompted by a user message.
 *
 * It integrates with the existing Discord bot client for authentication
 * and channel access.
 */

import discordBot from './discord-bot.js';

// Default channel for company communications
const DEFAULT_CHANNEL = process.env.DISCORD_COMPANY_CHANNEL;

// Message templates for common scenarios
const TEMPLATES = {
  greeting: (name) => `Good morning ${name}! Ready to tackle the day.`,
  update: (content) => content,
  question: (content) => content,
  escalation: (content) => content,
  celebration: (content) => content,
};

/**
 * Send a message to a Discord channel
 * @param {string} channelId - The Discord channel ID
 * @param {string} content - The message content
 * @param {Object} options - Additional options
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
export async function sendMessage(channelId, content, options = {}) {
  const client = discordBot.client;

  if (!client || !client.isReady()) {
    console.error('[Discord Outbound] Client not ready');
    return { success: false, error: 'Discord client not ready' };
  }

  if (!channelId) {
    channelId = DEFAULT_CHANNEL;
  }

  if (!channelId) {
    return { success: false, error: 'No channel ID provided and no default set' };
  }

  try {
    const channel = await client.channels.fetch(channelId);

    if (!channel) {
      return { success: false, error: 'Channel not found' };
    }

    if (!channel.isTextBased()) {
      return { success: false, error: 'Channel is not text-based' };
    }

    // Show typing indicator if requested
    if (options.showTyping) {
      await channel.sendTyping();
      // Small delay to make it feel natural
      await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000));
    }

    // Split long messages
    const chunks = splitMessage(content, 2000);
    const messageIds = [];

    for (const chunk of chunks) {
      const sent = await channel.send(chunk);
      messageIds.push(sent.id);
    }

    console.log(`[Discord Outbound] Sent message to #${channel.name}: "${content.substring(0, 50)}..."`);

    return {
      success: true,
      messageIds,
      channelName: channel.name
    };
  } catch (error) {
    console.error('[Discord Outbound] Error:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Reply to a specific message
 * @param {string} channelId - The channel ID
 * @param {string} messageId - The message ID to reply to
 * @param {string} content - The reply content
 */
export async function replyToMessage(channelId, messageId, content) {
  const client = discordBot.client;

  if (!client || !client.isReady()) {
    return { success: false, error: 'Discord client not ready' };
  }

  try {
    const channel = await client.channels.fetch(channelId);
    const message = await channel.messages.fetch(messageId);
    const reply = await message.reply(content);

    return { success: true, messageId: reply.id };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Add an emoji reaction to a message
 * @param {string} channelId - The channel ID
 * @param {string} messageId - The message ID to react to
 * @param {string} emoji - The emoji to react with (Unicode emoji or custom emoji ID)
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function reactToMessage(channelId, messageId, emoji) {
  const client = discordBot.client;

  if (!client || !client.isReady()) {
    return { success: false, error: 'Discord client not ready' };
  }

  try {
    const channel = await client.channels.fetch(channelId);
    const message = await channel.messages.fetch(messageId);
    await message.react(emoji);

    console.log(`[Discord Outbound] Reacted to message ${messageId} with ${emoji}`);

    return { success: true };
  } catch (error) {
    console.error('[Discord Outbound] Reaction Error:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Send a DM to a user
 * @param {string} userId - The user's Discord ID
 * @param {string} content - The message content
 */
export async function sendDM(userId, content) {
  const client = discordBot.client;

  if (!client || !client.isReady()) {
    return { success: false, error: 'Discord client not ready' };
  }

  try {
    const user = await client.users.fetch(userId);
    const dm = await user.createDM();
    const sent = await dm.send(content);

    console.log(`[Discord Outbound] Sent DM to ${user.username}: "${content.substring(0, 50)}..."`);

    return { success: true, messageId: sent.id };
  } catch (error) {
    console.error('[Discord Outbound] DM Error:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Get channel info
 * @param {string} channelId - The channel ID
 */
export async function getChannelInfo(channelId) {
  const client = discordBot.client;

  if (!client || !client.isReady()) {
    return { success: false, error: 'Discord client not ready' };
  }

  try {
    const channel = await client.channels.fetch(channelId);

    return {
      success: true,
      channel: {
        id: channel.id,
        name: channel.name,
        type: channel.type,
        guildName: channel.guild?.name
      }
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Get recent messages from a channel (for context)
 * @param {string} channelId - The channel ID
 * @param {number} limit - Max messages to fetch
 */
export async function getRecentMessages(channelId, limit = 10) {
  const client = discordBot.client;

  if (!client || !client.isReady()) {
    return { success: false, error: 'Discord client not ready' };
  }

  try {
    const channel = await client.channels.fetch(channelId);
    const messages = await channel.messages.fetch({ limit });

    const formatted = [...messages.values()].map(msg => ({
      id: msg.id,
      author: msg.author.username,
      content: msg.content,
      timestamp: msg.createdAt.toISOString(),
      isBot: msg.author.bot
    })).reverse();

    return { success: true, messages: formatted };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Check if the bot can send to a channel
 * @param {string} channelId - The channel ID
 */
export async function canSendToChannel(channelId) {
  const client = discordBot.client;

  if (!client || !client.isReady()) {
    return { allowed: false, reason: 'client_not_ready' };
  }

  try {
    const channel = await client.channels.fetch(channelId);

    if (!channel) {
      return { allowed: false, reason: 'channel_not_found' };
    }

    if (!channel.isTextBased()) {
      return { allowed: false, reason: 'not_text_channel' };
    }

    // Check permissions
    const permissions = channel.permissionsFor(client.user);
    if (!permissions.has('SendMessages')) {
      return { allowed: false, reason: 'no_send_permission' };
    }

    return { allowed: true, channelName: channel.name };
  } catch (error) {
    return { allowed: false, reason: error.message };
  }
}

/**
 * Split message into chunks for Discord's character limit
 */
function splitMessage(text, maxLength = 2000) {
  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let breakPoint = remaining.lastIndexOf('\n', maxLength);
    if (breakPoint === -1 || breakPoint < maxLength / 2) {
      breakPoint = remaining.lastIndexOf(' ', maxLength);
    }
    if (breakPoint === -1 || breakPoint < maxLength / 2) {
      breakPoint = maxLength;
    }

    chunks.push(remaining.substring(0, breakPoint));
    remaining = remaining.substring(breakPoint).trim();
  }

  return chunks;
}

export default {
  sendMessage,
  replyToMessage,
  reactToMessage,
  sendDM,
  getChannelInfo,
  getRecentMessages,
  canSendToChannel,
  TEMPLATES
};
