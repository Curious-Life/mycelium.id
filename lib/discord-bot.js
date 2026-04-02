/**
 * Unified Discord Bot Class
 *
 * Replaces 3 near-identical bot files (discord-bot.js, research-discord-bot.js,
 * commercial-intel-discord-bot.js) with a single configurable class.
 *
 * Two modes:
 * - 'orchestrator': Routes messages to different agents by channel
 * - 'single': All messages go to one agent
 *
 * Shared logic extracted:
 * - Discord.js client lifecycle
 * - Message chunking (2000-char limit)
 * - Message persistence (via D1)
 * - Express HTTP server (/send, /react, /health)
 * - Attachment processing via lib/attachments.js
 * - Collaboration channel handling via lib/collab.js
 * - Silent reply detection via lib/tokens.js
 * - Typing indicators
 * - Server allowlist enforcement
 *
 * Adding a new agent's bot = 6 lines of config, not a 200-line file copy.
 */

import { Client, GatewayIntentBits, Events, AttachmentBuilder } from 'discord.js';
import { Routes } from 'discord-api-types/v10';
import express from 'express';
import http from 'http';
import path from 'path';
import { readFile, writeFile, stat } from 'fs/promises';

/**
 * HTTP fetch that bypasses Node.js 22's built-in undici 5-minute headersTimeout.
 * The built-in fetch() uses undici internally, which has a hardcoded 300s (5 min)
 * headersTimeout that AbortSignal.timeout() does NOT override. For long-running
 * Claude requests (up to 60 min), we use http.request directly.
 *
 * @param {string} url - Full URL to fetch
 * @param {Object} options - { method, headers, body, timeout }
 * @returns {Promise<{ok: boolean, status: number, text: () => Promise<string>, json: () => Promise<any>}>}
 */
function longFetch(url, { method = 'POST', headers = {}, body, timeout = 65 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = http.request({
      hostname: urlObj.hostname,
      port: urlObj.port || 80,
      path: urlObj.pathname + urlObj.search,
      method,
      headers,
      timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString();
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          text: () => Promise.resolve(data),
          json: () => Promise.resolve(JSON.parse(data)),
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Request timeout (longFetch)')));

    if (body) req.write(body);
    req.end();
  });
}
import { processAllAttachments, processMessageUrls, createAttachmentRecord, isConfigured as attachmentsConfigured } from './attachments.js';
import { isCollabChannel, wasMentionedInCollab, isCollabConfigured, registerBotUrl, registerBotMention, registerBotName } from './collab.js';
import { getSessionForThread } from './session-store.js';
import { isSilentReply } from './tokens.js';
import { getAgentPaths } from './paths.js';
import { classifyError, captureError, ErrorReason, sleep } from './error-classifier.js';
import { tryGetDb } from './db.js';

export class AgentDiscordBot {
  /**
   * @param {Object} config
   * @param {string} config.token - Discord bot token
   * @param {number} [config.httpPort] - HTTP server port for send/react API
   * @param {string} [config.mode='single'] - 'orchestrator' or 'single'
   * @param {string} [config.botName='Bot'] - Display name for logging
   * @param {string} [config.botUserId] - Bot user ID for message metadata
   * @param {string[]} [config.allowedServers] - Server ID allowlist
   *
   * Single mode:
   * @param {string} [config.agentUrl] - Agent API URL
   * @param {string} [config.agentId] - Agent identifier
   * @param {string} [config.channelId] - Primary channel to listen to
   *
   * Orchestrator mode:
   * @param {Array<{channelId: string, agentUrl: string, agentId: string}>} [config.routes] - Channel→agent routing
   * @param {string[]} [config.skipChannels] - Channels handled by other bots (orchestrator skips these)
   *
   */
  constructor(config) {
    this.config = config;
    this.mode = config.mode || 'single';
    this.botName = config.botName || 'Bot';
    this.botUserId = config.botUserId || `bot:${this.botName.toLowerCase()}`;
    this.allowedServers = config.allowedServers || [];
    this.allowedUsers = config.allowedUsers || [];
    this.client = null;
    this.httpApp = null;
    this.httpServer = null;

    // Build agent bot map (name → Discord user ID) from env vars.
    // Used for: (1) auto-replacing @AgentName with <@ID> in /discord/send,
    //           (2) accepting cross-agent messages in primary channels.
    // Webhook bot IDs to treat as user messages (e.g., Captain Hook reports)
    this.webhookBotIds = config.webhookBotIds || [];

    this.agentBotMap = config.agentBotMap || {};
    const autoAgents = [
      ['Mya', 'DISCORD_MYA_BOT_ID'],
      ['Com', 'DISCORD_COM_BOT_ID'],
      ['Ada', 'DISCORD_ADA_BOT_ID'],
      ['Rex', 'DISCORD_REX_BOT_ID'],
      ['Noa', 'DISCORD_NOA_BOT_ID'],
      ['Rob', 'DISCORD_ROB_BOT_ID'],
    ];
    for (const [name, envKey] of autoAgents) {
      if (!this.agentBotMap[name] && process.env[envKey]) {
        this.agentBotMap[name] = process.env[envKey];
      }
    }
  }

  /**
   * Start the Discord bot and HTTP server
   */
  async start() {
    if (!this.config.token) {
      console.error(`[${this.botName}] Missing Discord bot token`);
      return null;
    }

    // Create Discord client
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
      ],
    });

    // Wire up event handlers
    this.client.once(Events.ClientReady, (c) => this._onReady(c));
    this.client.on(Events.MessageCreate, (msg) => this._onMessage(msg));
    this.client.on(Events.GuildCreate, (guild) => this._onGuildCreate(guild));

    // Start HTTP server if port specified
    if (this.config.httpPort) {
      this._startHttpServer();
    }

    // Login
    console.log(`[${this.botName}] Starting Discord bot...`);
    await this.client.login(this.config.token);
    return this.client;
  }

  /**
   * Stop the Discord bot gracefully
   */
  async stop() {
    console.log(`[${this.botName}] Shutting down bot...`);
    if (this.httpServer) {
      this.httpServer.close();
    }
    if (this.client) {
      await this.client.destroy();
    }
  }

  // ============================================
  // Routing
  // ============================================

  /**
   * Get the agent configuration for a message.
   * Override this for custom routing logic.
   *
   * @param {import('discord.js').Message} message
   * @returns {{ agentUrl: string, agentId: string } | null}
   */
  routeMessage(message) {
    if (this.mode === 'orchestrator') {
      return this._orchestratorRoute(message);
    }
    // Single mode — always route to the configured agent
    return {
      agentUrl: this.config.agentUrl,
      agentId: this.config.agentId,
    };
  }

  /**
   * Orchestrator routing: match channel to agent, with wildcard fallback
   */
  _orchestratorRoute(message) {
    const routes = this.config.routes || [];
    const channelId = message.channel.id;

    // Find exact channel match
    const match = routes.find(r => r.channelId === channelId);
    if (match) return { agentUrl: match.agentUrl, agentId: match.agentId };

    // Find wildcard fallback
    const wildcard = routes.find(r => r.channelId === '*');
    if (wildcard) return { agentUrl: wildcard.agentUrl, agentId: wildcard.agentId };

    return null;
  }

  // ============================================
  // Message Filtering
  // ============================================

  /**
   * Determine if a message should be processed.
   * Override this for custom filtering logic.
   *
   * @param {import('discord.js').Message} message
   * @returns {boolean}
   */
  shouldProcessMessage(message) {
    // Server allowlist
    if (this.allowedServers.length > 0 && message.guild) {
      if (!this.allowedServers.includes(message.guild.id)) {
        return false;
      }
    }

    // User allowlist — if set, only process messages from allowed human users
    // Bot messages (cross-agent collab) are always permitted
    if (this.allowedUsers.length > 0 && !message.author.bot) {
      if (!this.allowedUsers.includes(message.author.id)) {
        return false;
      }
    }

    // Collab channel (or thread within it): respond to @mentions and continue thread conversations
    const inCollabChannel = isCollabChannel(message.channel.id);
    const inCollabThread = message.channel.isThread?.() && isCollabChannel(message.channel.parentId);

    if (inCollabChannel || inCollabThread) {
      if (message.author.id === this.client.user?.id) return false;

      // Real @mention — always process (this starts or continues a conversation)
      if (wasMentionedInCollab(message, this.client.user?.id)) {
        const source = message.author.bot ? 'another bot' : message.author.username;
        console.log(`[${this.botName}] Collab: ${source} mentioned ${this.botName} - processing`);
        return true;
      }

      // Name-based addressing — "Hey Ada" or "Com, can you..." (no @mention needed)
      // ONLY for human messages — bot-to-bot must use explicit @mentions to prevent loops
      if (this.botName && message.content && !message.author.bot) {
        const namePattern = new RegExp(`\\b${this.botName}\\b`, 'i');
        if (namePattern.test(message.content)) {
          console.log(`[${this.botName}] Collab: ${message.author.username} addressed ${this.botName} by name - processing`);
          return true;
        }
      }

      // In a collab thread — continue if we have an active session for it
      // (async check happens in _onMessage, this is the sync fast-path)
      if (inCollabThread) {
        // Bot messages in collab threads: only process @mentions (not queue notifications, status messages, etc.)
        // This prevents ping-pong loops where queue notifications bounce between bots
        if (message.author.bot) {
          if (this.client.user && message.mentions.users.has(this.client.user.id)) {
            console.log(`[${this.botName}] Collab thread: bot @mentioned us - processing`);
          } else {
            return false;
          }
        }
        // Mark for async session check in _onMessage
        message._collabThreadCheck = true;
        return true;
      }

      return false;
    }

    if (this.mode === 'orchestrator') {
      // Monitor channels: process bot/webhook messages (e.g., error notifications)
      const monitorChannels = this.config.monitorChannels || [];
      if (monitorChannels.includes(message.channel.id)) {
        if (message.author.id === this.client.user?.id) return false; // skip own messages
        console.log(`[${this.botName}] Monitor channel #${message.channel.name || message.channel.id}: processing ${message.author.bot ? 'bot' : 'user'} message`);
        return true;
      }

      // Orchestrator ignores bot messages in all other channels
      if (message.author.bot) return false;

      // Skip messages that @mention another agent's bot — let that bot handle it
      const agentBotIds = this.config.agentBotIds || [];
      if (agentBotIds.some(id => message.mentions.users.has(id))) {
        // Unless we're ALSO mentioned (user wants both)
        if (!(this.client.user && message.mentions.users.has(this.client.user.id))) {
          console.log(`[${this.botName}] Skipping — message mentions another agent bot`);
          return false;
        }
      }

      // Always respond to @mentions, even in channels owned by other bots
      if (this.client.user && message.mentions.users.has(this.client.user.id)) {
        console.log(`[${this.botName}] @mentioned in #${message.channel.name || 'unknown'} - responding`);
        return true;
      }

      // Allowlist mode: only respond in specific channels
      const allowChannels = this.config.allowChannels || [];
      if (allowChannels.length > 0) {
        if (!allowChannels.includes(message.channel.id)) return false;
        return true;
      }

      // Skip channels handled by other dedicated bots
      const skipChannels = this.config.skipChannels || [];
      if (skipChannels.includes(message.channel.id)) return false;

      // Process everything else
      return true;
    }

    // Single mode: process primary channel
    if (this.config.channelId && message.channel.id === this.config.channelId) {
      // Ignore own messages to prevent self-loops
      if (message.author.id === this.client.user?.id) return false;
      // Bot messages: process if @mentioned, known agent bot, or whitelisted webhook bot
      if (message.author.bot) {
        if (this.client.user && message.mentions.users.has(this.client.user.id)) {
          console.log(`[${this.botName}] Bot @mentioned in primary channel - processing`);
          return true;
        }
        // Accept messages from known agent bots (cross-agent communication)
        const knownBotIds = Object.values(this.agentBotMap);
        if (knownBotIds.includes(message.author.id)) {
          console.log(`[${this.botName}] Known agent bot message in primary channel from ${message.author.username} - processing`);
          return true;
        }
        // Accept messages from whitelisted webhook bots (e.g., Captain Hook reports)
        if (this.webhookBotIds.includes(message.author.id)) {
          console.log(`[${this.botName}] Webhook bot message in primary channel from ${message.author.username} - processing`);
          return true;
        }
        return false;
      }
      // Human messages: if they @mention someone else but NOT this bot, skip
      if (message.mentions.users.size > 0) {
        const mentionsBot = this.client.user && message.mentions.users.has(this.client.user.id);
        if (!mentionsBot) {
          console.log(`[${this.botName}] Skipping message in primary channel - mentions other users but not this bot`);
          return false;
        }
      }
      return true;
    }

    // Ignore bot messages in other channels (not primary, not collab)
    if (message.author.bot) return false;

    // Respond if @mentioned in any other channel
    if (this.client.user && message.mentions.users.has(this.client.user.id)) {
      console.log(`[${this.botName}] Mentioned in #${message.channel.name || 'unknown'} - responding`);
      return true;
    }

    return false;
  }

  // ============================================
  // Message Processing
  // ============================================

  /**
   * Process a Discord message through the appropriate agent
   */
  async processMessage(message) {
    const route = this.routeMessage(message);
    if (!route) return;

    const { agentUrl, agentId } = route;
    let channelName = message.channel.name || 'unknown';
    const serverName = message.guild?.name || 'Unknown Server';
    const username = message.author.username;

    // Detect collab context — these get longer timeouts (research-grade)
    const inCollabMain = isCollabChannel(message.channel.id) && !message.channel.isThread?.();
    const inCollabThread = message.channel.isThread?.() && isCollabChannel(message.channel.parentId);
    const isCollabRequest = inCollabMain || inCollabThread;

    // Auto-thread: when @mentioned in #agent-collab (not already in a thread),
    // create a thread for the conversation so the channel stays clean
    if (inCollabMain) {
      try {
        const threadTitle = `${this.botName} — ${(message.content || '').replace(/<@!?\d+>/g, '').trim().slice(0, 50) || 'conversation'}`;
        const thread = await message.startThread({ name: threadTitle.slice(0, 100) });
        // Redirect replies to the thread — the thread's channelId will be used for session mapping
        message._replyChannel = thread;
        channelName = thread.name || channelName;
        console.log(`[${this.botName}] Created collab thread: "${threadTitle}"`);
      } catch (err) {
        console.log(`[${this.botName}] Could not create thread: ${err.message}`);
        // Fall through — reply directly in channel
      }
    }

    // Look up linked MYA user_id
    const linkedUserId = await this._lookupUserFromDiscord(message.author.id);

    // Process attachments
    const { content: attachmentContent, results: attachmentResults } = await this._processAttachments(
      message.attachments,
      linkedUserId,
    );

    // Extract reply-to context (when user replies to a previous message)
    let replyContext = '';
    if (message.reference?.messageId) {
      try {
        const refMsg = await message.channel.messages.fetch(message.reference.messageId);
        if (refMsg) {
          let refContent = this._resolveMentions(refMsg.content || '', message.guild);
          if (refMsg.attachments.size > 0) {
            const names = [...refMsg.attachments.values()].map(a => a.name).join(', ');
            refContent = refContent ? `${refContent} [attachments: ${names}]` : `[attachments: ${names}]`;
          }
          if (refContent) {
            const refAuthor = refMsg.author?.username || 'Unknown';
            replyContext = `[Replying to ${refAuthor}'s message: "${refContent}"]\n\n`;
          }
        }
      } catch (err) {
        console.log(`[${this.botName}] Could not fetch referenced message: ${err.message}`);
      }
    }

    // Build full message content — resolve <@ID> mentions to readable names
    let fullContent = this._resolveMentions(message.content || '', message.guild);
    if (replyContext) {
      fullContent = replyContext + fullContent;
    }

    // Extract embed content (webhook bots like Captain Hook send data as embeds)
    if (message.embeds?.length > 0) {
      const embedText = message.embeds.map(embed => {
        const parts = [];
        if (embed.title) parts.push(`**${embed.title}**`);
        if (embed.description) parts.push(embed.description);
        if (embed.fields?.length > 0) {
          for (const field of embed.fields) {
            parts.push(`${field.name}: ${field.value}`);
          }
        }
        if (embed.footer?.text) parts.push(embed.footer.text);
        return parts.join('\n');
      }).join('\n\n');
      if (embedText) {
        fullContent = fullContent
          ? `${fullContent}\n\n${embedText}`
          : embedText;
      }
    }

    if (attachmentContent) {
      fullContent = fullContent
        ? `${fullContent}\n\n[Attached files:]\n${attachmentContent}`
        : `[Attached files:]\n${attachmentContent}`;
    }

    // Process URLs in message (Google Docs, etc.)
    const { extractedContent } = await processMessageUrls(message.content);
    if (extractedContent.length > 0) {
      const urlContent = extractedContent.map(e => e.content).join('\n\n');
      fullContent = fullContent ? `${fullContent}\n\n${urlContent}` : urlContent;
      console.log(`[${this.botName}] Extracted content from ${extractedContent.length} URL(s)`);
    }

    if (!fullContent.trim()) return;

    const hasAttachments = attachmentResults.length > 0;
    console.log(`[${this.botName}] Processing: ${username} in #${channelName} -> ${agentId}: "${fullContent.substring(0, 50)}..."${hasAttachments ? ` (${attachmentResults.length} attachments)` : ''}`);

    // Fetch Discord message history
    const discordHistory = await this._fetchDiscordHistory(message.channel, message);
    const history = [...discordHistory, { role: 'user', content: fullContent, username }];

    try {
      // Save user message to DB
      const savedMessageId = await this._saveMessage({
        role: 'user',
        content: fullContent,
        discordUserId: message.author.id,
        discordUsername: username,
        channelId: message.channel.id,
        channelName,
        messageId: message.id,
        serverId: message.guild?.id,
        serverName,
        agentId,
      });

      // Create attachment records
      if (attachmentResults.length > 0 && tryGetDb()) {
        for (const att of attachmentResults) {
          if (att.r2Key || att.streamInfo) {
            await createAttachmentRecord(null, {
              userId: linkedUserId,
              messageId: savedMessageId,
              type: att.type,
              filename: att.filename,
              mimeType: att.mimeType,
              size: att.size,
              r2Key: att.r2Key,
              streamInfo: att.streamInfo,
              description: att.description,
              transcript: att.transcript,
              discordMetadata: {
                source: 'discord',
                discord_user_id: message.author.id,
                discord_username: username,
                discord_channel_id: message.channel.id,
                discord_message_id: message.id,
              },
            });
          }
        }
      }

      // Use thread channel for replies if we auto-created one
      const replyChannel = message._replyChannel || message.channel;
      const effectiveChannelId = replyChannel.id;

      // Check if agent is busy — notify user if their message will be queued
      // Skip queue notifications for bot messages — bots can't read them and they cause ping-pong loops
      try {
        const queueStatus = !message.author.bot
          ? await fetch(`${agentUrl}/queue`, { signal: AbortSignal.timeout(3000) })
              .then(r => r.ok ? r.json() : null)
              .catch(() => null)
          : null;

        if (queueStatus?.processing && queueStatus.active) {
          const active = queueStatus.active;
          const position = queueStatus.queueLength + 1;

          let queueMsg = `Your message is queued`;
          if (active.username) {
            queueMsg += ` — currently processing a request from **${active.username}**`;
            if (active.channel) queueMsg += ` in #${active.channel}`;
          }
          queueMsg += position === 1 ? `. You're next in line.` : `. Position: ${position} in queue.`;

          await replyChannel.send(`-# ${queueMsg}`).catch(() => {});
        }
      } catch { /* queue check is best-effort */ }

      // Show typing indicator + keep refreshing it while waiting
      await replyChannel.sendTyping();
      let typingInterval = setInterval(() => {
        replyChannel.sendTyping().catch(() => {});
      }, 8000);

      // Retry configuration — exponential backoff for transient failures
      const MAX_RETRIES = 5;
      const RETRYABLE_REASONS = new Set([
        ErrorReason.RATE_LIMIT,
        ErrorReason.NETWORK,
        ErrorReason.PROCESS_ERROR,
        ErrorReason.UNKNOWN,
      ]);

      // Human-readable error descriptions
      const REASON_LABELS = {
        [ErrorReason.RATE_LIMIT]: 'rate limited by the AI provider',
        [ErrorReason.NETWORK]: 'network connection issue',
        [ErrorReason.PROCESS_ERROR]: 'agent process crashed',
        [ErrorReason.TIMEOUT]: 'request timed out',
        [ErrorReason.AUTH]: 'authentication error',
        [ErrorReason.BILLING]: 'billing/quota issue',
        [ErrorReason.CONTEXT_OVERFLOW]: 'conversation too long (context overflow)',
        [ErrorReason.MODEL_ERROR]: 'model returned an invalid response',
        [ErrorReason.UNKNOWN]: 'unexpected error',
      };

      let response;
      let lastError;
      let attempts = 0;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        attempts = attempt;
        try {
          // Call agent server (pass thread channelId so session maps to thread)
          // Uses longFetch() to bypass Node.js 22's undici 5-min headersTimeout.
          // Timeout: 65 minutes (agent server has up to 60min timeout for Claude)
          response = await longFetch(`${agentUrl}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prompt: fullContent,
              channel: channelName,
              username,
              userId: message.author.id,
              history,
              channelId: effectiveChannelId,
              messageId: message.id,
              taskType: isCollabRequest ? 'research' : 'chat',
            }),
            timeout: 65 * 60 * 1000,
          });

          // Treat HTTP errors as throwable so they enter the retry logic
          if (!response.ok) {
            const errorText = await response.text();
            const httpError = new Error(`Agent ${agentId} HTTP ${response.status}: ${errorText}`);
            httpError.status = response.status;
            throw httpError;
          }

          break; // Success — exit retry loop
        } catch (err) {
          lastError = err;
          clearInterval(typingInterval);

          const reason = classifyError(err);
          const isTimeout = reason === ErrorReason.TIMEOUT;

          console.error(`[${this.botName}] Attempt ${attempt}/${MAX_RETRIES} failed (${reason}):`, err.message);

          const reasonLabel = REASON_LABELS[reason] || 'unexpected error';

          // Non-retryable errors or final attempt — bail immediately
          if (!RETRYABLE_REASONS.has(reason) || attempt === MAX_RETRIES) {
            try {
              const msg = isTimeout
                ? `The task is taking longer than expected. My work has been checkpointed — you can follow up or I'll continue on the next wake cycle.`
                : attempt > 1
                  ? `Failed after ${attempt} attempts (${reasonLabel}). Please try again later.`
                  : `Something went wrong (${reasonLabel}). Please try again.`;
              await replyChannel.send(msg);
            } catch { /* best effort */ }
            return;
          }

          // Retryable — notify user and backoff (ramps up to 2 min max)
          const backoffSec = Math.min(120, 5 * Math.pow(2, attempt - 1)); // 5s, 10s, 20s, 40s
          try {
            await replyChannel.send(
              `Something went wrong (${reasonLabel}) — retrying (attempt ${attempt + 1}/${MAX_RETRIES}, waiting ${backoffSec}s)...`
            );
          } catch { /* best effort */ }

          await sleep(backoffSec * 1000);

          // Restart typing indicator for next attempt
          await replyChannel.sendTyping().catch(() => {});
          typingInterval = setInterval(() => {
            replyChannel.sendTyping().catch(() => {});
          }, 8000);
        }
      }

      clearInterval(typingInterval);

      const data = await response.json();
      const reply = data.response || '';

      // Check for silent reply
      if (data.noReply || isSilentReply(reply)) {
        console.log(`[${this.botName}] Agent chose not to reply in #${channelName}`);
        return;
      }

      // Notify if context was compacted (session was too long, agent retried with fresh context)
      if (data.compacted) {
        await replyChannel.send(`-# Context was getting long — compacted session and retried with fresh context.`).catch(() => {});
      }

      // Guard against empty responses (Discord rejects empty messages)
      if (!reply || !reply.trim()) {
        console.log(`[${this.botName}] Agent returned empty response in #${channelName} — skipping send`);
        return;
      }

      // Send response — split into multiple messages at Discord's 2000-char limit
      let sentMessageId = null;
      const chunks = splitMessage(reply, 2000);
      for (const chunk of chunks) {
        if (!chunk || !chunk.trim()) continue;
        const sent = this.mode === 'orchestrator'
          ? await message.reply(chunk)
          : await replyChannel.send(chunk);
        if (!sentMessageId) sentMessageId = sent.id;
      }

      // Save assistant response to DB
      await this._saveMessage({
        role: 'assistant',
        content: reply,
        discordUserId: this.client.user?.id,
        discordUsername: this.client.user?.username || this.botName,
        channelId: effectiveChannelId,
        channelName,
        messageId: sentMessageId,
        serverId: message.guild?.id,
        serverName,
        agentId,
      });

      if (attempts > 1) {
        console.log(`[${this.botName}] Responded in #${channelName} via ${agentId} (after ${attempts} attempts)`);
      } else {
        console.log(`[${this.botName}] Responded in #${channelName} via ${agentId}`);
      }
    } catch (error) {
      const reason = classifyError(error);
      captureError(error, { agentId: agentId || this.botName, taskType: 'chat' });
      console.error(`[${this.botName}] Outer error (${reason}):`, error.message, error.stack?.split('\n').slice(0, 3).join('\n'));
      try {
        const replyChannel = message._replyChannel || message.channel;
        const reasonLabel = {
          [ErrorReason.RATE_LIMIT]: 'rate limited by the AI provider',
          [ErrorReason.NETWORK]: 'network connection issue',
          [ErrorReason.PROCESS_ERROR]: 'agent process crashed',
          [ErrorReason.TIMEOUT]: 'request timed out',
          [ErrorReason.AUTH]: 'authentication error',
          [ErrorReason.BILLING]: 'billing/quota issue',
          [ErrorReason.CONTEXT_OVERFLOW]: 'conversation too long',
          [ErrorReason.MODEL_ERROR]: 'model returned an invalid response',
        }[reason] || error.message?.slice(0, 120) || 'unexpected error';
        await replyChannel.send(`Something went wrong (${reasonLabel}). Please try again.`);
      } catch { /* best effort */ }
    }
  }

  // ============================================
  // Event Handlers
  // ============================================

  async _onReady(c) {
    console.log(`[${this.botName}] Bot ready! Logged in as ${c.user.tag}`);
    console.log(`[${this.botName}] Allowed servers: ${this.allowedServers.length > 0 ? this.allowedServers.join(', ') : 'ALL'}`);
    console.log(`[${this.botName}] Allowed users: ${this.allowedUsers.length > 0 ? this.allowedUsers.join(', ') : 'ALL'}`);

    if (this.mode === 'orchestrator') {
      const routes = this.config.routes || [];
      for (const r of routes) {
        console.log(`[${this.botName}] Route: ${r.channelId === '*' ? 'default' : r.channelId} -> ${r.agentId} (${r.agentUrl})`);
      }
      if (this.config.allowChannels?.length) {
        console.log(`[${this.botName}] Allow channels: ${this.config.allowChannels.join(', ')}`);
      } else if (this.config.skipChannels?.length) {
        console.log(`[${this.botName}] Skipping channels: ${this.config.skipChannels.join(', ')}`);
      }
    } else {
      console.log(`[${this.botName}] Channel: ${this.config.channelId || 'all'}`);
      console.log(`[${this.botName}] Agent: ${this.config.agentId} (${this.config.agentUrl})`);
    }

    if (isCollabConfigured()) {
      console.log(`[${this.botName}] Collab channel: enabled`);
    }

    // Populate mention map with human guild members (for outgoing @Name → <@ID> replacement)
    for (const guild of this.client.guilds.cache.values()) {
      try {
        await guild.members.fetch({ time: 3000 });
      } catch { /* cache is fine */ }
      for (const member of guild.members.cache.values()) {
        if (!member.user.bot && !this.agentBotMap[member.displayName]) {
          this.agentBotMap[member.displayName] = member.user.id;
        }
        if (!member.user.bot && member.user.username && !this.agentBotMap[member.user.username]) {
          this.agentBotMap[member.user.username] = member.user.id;
        }
      }
    }

    // Register bot identity with collab module + write identity files
    if (this.config.agentId && c.user?.id) {
      registerBotMention(this.config.agentId, c.user.id);
      registerBotName(this.config.agentId, this.botName);
      if (this.config.httpPort) {
        registerBotUrl(this.config.agentId, `http://localhost:${this.config.httpPort}`);
      }

      // Write identity files so agent-server can read them (survives restarts)
      try {
        const agentPaths = getAgentPaths(this.config.agentId);
        await writeFile(path.join(agentPaths.root, '.discord-bot-id'), c.user.id);
        await writeFile(path.join(agentPaths.root, '.discord-bot-name'), this.botName);
        if (this.config.httpPort) {
          await writeFile(path.join(agentPaths.root, '.bot-http-url'), `http://localhost:${this.config.httpPort}`);
        }
        console.log(`[${this.botName}] Identity registered: ${c.user.id} (${this.botName})`);
      } catch (err) {
        console.log(`[${this.botName}] Could not write identity files: ${err.message}`);
      }
    }

    // Log attachment capabilities
    const attachConfig = attachmentsConfigured();
    console.log(`[${this.botName}] Attachments: vision=${attachConfig.vision ? 'Y' : 'N'} storage=${attachConfig.storage ? 'Y' : 'N'} transcription=${attachConfig.transcription ? 'Y' : 'N'}`);

    // Health check agents
    await this._healthCheckAgents();

    // Leave unauthorized servers
    await this._leaveUnauthorizedServers();
  }

  async _onMessage(message) {
    if (!this.shouldProcessMessage(message)) return;

    // Async guard for collab thread continuation
    if (message._collabThreadCheck) {
      delete message._collabThreadCheck;
      if (this.config.agentId) {
        try {
          const agentPaths = getAgentPaths(this.config.agentId);
          const threadKey = `discord_${message.channel.id}`;
          const hasSession = await getSessionForThread(agentPaths.root, threadKey);
          if (hasSession) {
            console.log(`[${this.botName}] Collab thread: continuing session in ${message.channel.name}`);
          } else if (message.channel.isThread?.()) {
            // Check if this bot authored the starter message — meaning we initiated
            // this conversation (e.g., Mya @mentioned Rex, Rex created thread).
            // We should pick up the response so the conversation continues.
            const starterMessage = await message.channel.fetchStarterMessage().catch(() => null);
            if (starterMessage?.author?.id === this.client.user?.id) {
              console.log(`[${this.botName}] Collab thread: picking up response to our @mention in ${message.channel.name}`);
            } else {
              return; // Not our thread
            }
          } else {
            return;
          }
        } catch {
          return;  // Can't check — skip
        }
      } else {
        return;
      }
    }

    await this.processMessage(message);
  }

  async _onGuildCreate(guild) {
    if (this.allowedServers.length > 0 && !this.allowedServers.includes(guild.id)) {
      console.log(`[${this.botName}] Leaving unauthorized server: ${guild.name}`);
      await guild.leave();
    }
  }

  // ============================================
  // HTTP API Server
  // ============================================

  _startHttpServer() {
    this.httpApp = express();
    this.httpApp.use(express.json({ limit: '25mb' }));

    // Send a message to a Discord channel
    this.httpApp.post('/discord/send', async (req, res) => {
      const { channelId, content } = req.body;
      if (!channelId || !content) {
        return res.status(400).json({ error: 'channelId and content required' });
      }

      try {
        const channel = await this.client.channels.fetch(channelId);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });

        // Auto-replace @AgentName with proper Discord <@ID> mentions
        let processedContent = content;
        for (const [name, id] of Object.entries(this.agentBotMap)) {
          processedContent = processedContent.replace(new RegExp(`@${name}\\b`, 'gi'), `<@${id}>`);
        }

        // Split long messages into multiple Discord messages at the 2000-char limit
        const chunks = splitMessage(processedContent, 2000);
        for (const chunk of chunks) {
          if (!chunk || !chunk.trim()) continue;
          await channel.send(chunk);
        }

        console.log(`[${this.botName}] Sent message to #${channel.name}`);
        res.json({ ok: true, sent: true, channelId });
      } catch (error) {
        console.error(`[${this.botName}] Send error:`, error.message);
        res.status(500).json({ error: error.message });
      }
    });

    // Send a file to a Discord channel
    // Text files (.md, .txt) are intercepted and sent as split messages instead of attachments.
    // Binary files (PDFs, images, etc.) are sent as attachments normally.
    this.httpApp.post('/discord/send-file', async (req, res) => {
      const { channelId, filePath, base64, filename, content } = req.body;
      if (!channelId) {
        return res.status(400).json({ error: 'channelId required' });
      }
      if (!filePath && !base64) {
        return res.status(400).json({ error: 'filePath or base64 required' });
      }

      try {
        const channel = await this.client.channels.fetch(channelId);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });

        // Intercept text files — send as split messages instead of attachments
        const resolvedName = (filename || (filePath ? path.basename(filePath) : '')).toLowerCase();
        const textExts = ['.md', '.txt', '.markdown', '.text'];
        if (textExts.some(ext => resolvedName.endsWith(ext))) {
          try {
            let textContent;
            if (filePath) {
              textContent = (await readFile(filePath)).toString('utf-8');
            } else if (base64) {
              textContent = Buffer.from(base64, 'base64').toString('utf-8');
            }
            if (textContent && textContent.trim()) {
              const fullMessage = content ? `${content}\n\n${textContent}` : textContent;
              const chunks = splitMessage(fullMessage, 2000);
              for (const chunk of chunks) {
                if (!chunk || !chunk.trim()) continue;
                await channel.send(chunk);
              }
              console.log(`[${this.botName}] Sent text file as messages in #${channel.name}: ${resolvedName} (${textContent.length} chars)`);
              return res.json({ ok: true, sent: true, channelId, convertedToMessages: true });
            }
          } catch (readErr) {
            console.error(`[${this.botName}] Text file conversion failed, sending as attachment:`, readErr.message);
            // Fall through to attachment send
          }
        }

        let attachment;
        if (filePath) {
          // Read file from disk — validate it exists and isn't too large (25MB Discord limit)
          const info = await stat(filePath);
          if (info.size > 25 * 1024 * 1024) {
            return res.status(413).json({ error: 'File exceeds 25MB Discord limit' });
          }
          const data = await readFile(filePath);
          const name = filename || path.basename(filePath);
          attachment = new AttachmentBuilder(data, { name });
        } else {
          // base64-encoded data
          const data = Buffer.from(base64, 'base64');
          if (data.length > 25 * 1024 * 1024) {
            return res.status(413).json({ error: 'File exceeds 25MB Discord limit' });
          }
          if (!filename) {
            return res.status(400).json({ error: 'filename required when using base64' });
          }
          attachment = new AttachmentBuilder(data, { name: filename });
        }

        await channel.send({
          content: content || '',
          files: [attachment],
        });

        console.log(`[${this.botName}] Sent file to #${channel.name}: ${filename || path.basename(filePath)}`);
        res.json({ ok: true, sent: true, channelId });
      } catch (error) {
        console.error(`[${this.botName}] Send file error:`, error.message);
        res.status(500).json({ error: error.message });
      }
    });

    // Send a voice message to a Discord channel
    // Uses client.rest.post() directly because channel.send() drops duration_secs/waveform
    // from the attachments array (MessagePayload.resolveBody only passes id + description)
    this.httpApp.post('/discord/send-voice', async (req, res) => {
      const { channelId, audio, durationSecs, waveform } = req.body;
      if (!channelId || !audio) {
        return res.status(400).json({ error: 'channelId and audio (base64) required' });
      }
      if (durationSecs === undefined || !waveform) {
        return res.status(400).json({ error: 'durationSecs and waveform required for voice messages' });
      }

      try {
        const channel = await this.client.channels.fetch(channelId);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });

        const audioBuffer = Buffer.from(audio, 'base64');
        if (audioBuffer.length > 25 * 1024 * 1024) {
          return res.status(413).json({ error: 'Audio exceeds 25MB Discord limit' });
        }

        // Build multipart request with voice metadata
        const body = {
          content: '',
          flags: 8192, // MessageFlags.IsVoiceMessage
          attachments: [{
            id: '0',
            filename: 'voice-message.ogg',
            duration_secs: durationSecs,
            waveform: waveform,
          }],
        };

        const files = [{
          data: audioBuffer,
          name: 'voice-message.ogg',
          contentType: 'audio/ogg',
        }];

        await this.client.rest.post(Routes.channelMessages(channelId), { body, files });

        console.log(`[${this.botName}] Sent voice message to #${channel.name || channelId} (${durationSecs.toFixed(1)}s, ${audioBuffer.length} bytes)`);
        res.json({ ok: true, sent: true, channelId, durationSecs });
      } catch (error) {
        console.error(`[${this.botName}] Send voice error:`, error.message);
        res.status(500).json({ error: error.message });
      }
    });

    // Also support /send (without /discord prefix) for backward compat
    this.httpApp.post('/send', async (req, res) => {
      const { channelId, content } = req.body;
      if (!channelId || !content) {
        return res.status(400).json({ error: 'channelId and content required' });
      }

      try {
        const channel = await this.client.channels.fetch(channelId);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });

        // Auto-replace @AgentName with proper Discord <@ID> mentions
        let processedContent = content;
        for (const [name, id] of Object.entries(this.agentBotMap)) {
          processedContent = processedContent.replace(new RegExp(`@${name}\\b`, 'gi'), `<@${id}>`);
        }

        const chunks = splitMessage(processedContent, 2000);
        let sentMessageId = null;
        for (const chunk of chunks) {
          if (!chunk || !chunk.trim()) continue;
          const sent = await channel.send(chunk);
          if (!sentMessageId) sentMessageId = sent.id;
        }
        console.log(`[${this.botName}] Sent message to channel ${channelId}`);
        res.json({ success: true, messageId: sentMessageId });
      } catch (error) {
        console.error(`[${this.botName}] Send error:`, error.message);
        res.status(500).json({ error: error.message });
      }
    });

    // React to a message
    this.httpApp.post('/discord/react', async (req, res) => {
      const { channelId, messageId, emoji } = req.body;
      if (!channelId || !messageId || !emoji) {
        return res.status(400).json({ error: 'channelId, messageId, and emoji required' });
      }

      try {
        const channel = await this.client.channels.fetch(channelId);
        const msg = await channel.messages.fetch(messageId);
        await msg.react(emoji);

        console.log(`[${this.botName}] Reacted to ${messageId} with ${emoji}`);
        res.json({ ok: true, reacted: true });
      } catch (error) {
        console.error(`[${this.botName}] React error:`, error.message);
        res.status(500).json({ error: error.message });
      }
    });

    // Also support /react (without /discord prefix)
    this.httpApp.post('/react', async (req, res) => {
      const { channelId, messageId, emoji } = req.body;
      if (!channelId || !messageId || !emoji) {
        return res.status(400).json({ error: 'channelId, messageId, and emoji required' });
      }

      try {
        const channel = await this.client.channels.fetch(channelId);
        const msg = await channel.messages.fetch(messageId);
        await msg.react(emoji);

        console.log(`[${this.botName}] Reacted to ${messageId} with ${emoji}`);
        res.json({ success: true });
      } catch (error) {
        console.error(`[${this.botName}] React error:`, error.message);
        res.status(500).json({ error: error.message });
      }
    });

    // Create a thread from a message and send initial content
    this.httpApp.post('/discord/thread', async (req, res) => {
      const { channelId, messageId, title, content } = req.body;
      if (!channelId || !title) {
        return res.status(400).json({ error: 'channelId and title required' });
      }

      try {
        const channel = await this.client.channels.fetch(channelId);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });

        let thread;
        if (messageId) {
          const msg = await channel.messages.fetch(messageId);
          thread = await msg.startThread({ name: title.slice(0, 100) });
        } else {
          thread = await channel.threads.create({ name: title.slice(0, 100) });
        }

        let sentMessageId = null;
        if (content) {
          const chunks = splitMessage(content, 2000);
          for (const chunk of chunks) {
            const sent = await thread.send(chunk);
            if (!sentMessageId) sentMessageId = sent.id;
          }
        }

        console.log(`[${this.botName}] Created thread "${title}" in #${channel.name}`);
        res.json({ ok: true, threadId: thread.id, messageId: sentMessageId });
      } catch (error) {
        console.error(`[${this.botName}] Thread create error:`, error.message);
        res.status(500).json({ error: error.message });
      }
    });

    // Send a message in an existing thread
    this.httpApp.post('/discord/send-in-thread', async (req, res) => {
      const { threadId, content } = req.body;
      if (!threadId || !content) {
        return res.status(400).json({ error: 'threadId and content required' });
      }

      try {
        const thread = await this.client.channels.fetch(threadId);
        if (!thread?.isThread()) return res.status(404).json({ error: 'Thread not found' });

        // Auto-replace @AgentName with proper Discord <@ID> mentions
        let processedContent = content;
        for (const [name, id] of Object.entries(this.agentBotMap)) {
          processedContent = processedContent.replace(new RegExp(`@${name}\\b`, 'gi'), `<@${id}>`);
        }

        const chunks = splitMessage(processedContent, 2000);
        let sentMessageId = null;
        for (const chunk of chunks) {
          const sent = await thread.send(chunk);
          if (!sentMessageId) sentMessageId = sent.id;
        }

        console.log(`[${this.botName}] Sent message in thread ${threadId}`);
        res.json({ ok: true, messageId: sentMessageId });
      } catch (error) {
        console.error(`[${this.botName}] Thread send error:`, error.message);
        res.status(500).json({ error: error.message });
      }
    });

    // List all visible text channels (for dynamic prompt injection)
    this.httpApp.get('/discord/channels', (req, res) => {
      if (!this.client?.isReady()) {
        return res.status(503).json({ error: 'Discord not ready' });
      }

      try {
        const channels = [];
        for (const guild of this.client.guilds.cache.values()) {
          for (const channel of guild.channels.cache.values()) {
            // Text channels (0) and announcement channels (5)
            if (channel.type === 0 || channel.type === 5) {
              channels.push({
                id: channel.id,
                name: channel.name,
                category: channel.parent?.name || null,
              });
            }
          }
        }
        res.json({ channels });
      } catch (error) {
        console.error(`[${this.botName}] Channel list error:`, error.message);
        res.status(500).json({ error: error.message });
      }
    });

    // List guild members (humans + bots) with roles
    this.httpApp.get('/discord/members', async (req, res) => {
      if (!this.client?.isReady()) {
        return res.status(503).json({ error: 'Discord not ready' });
      }

      try {
        const members = [];
        for (const guild of this.client.guilds.cache.values()) {
          // Try to fetch fresh members (3s timeout), fall back to cache
          try {
            await guild.members.fetch({ time: 3000 });
          } catch {
            // Cache is fine — populated on startup via GuildMembers intent
          }
          for (const member of guild.members.cache.values()) {
            members.push({
              id: member.user.id,
              username: member.user.username,
              displayName: member.displayName,
              bot: member.user.bot,
              roles: member.roles.cache
                .filter(r => r.name !== '@everyone')
                .map(r => r.name),
            });
          }
        }
        res.json({ members });
      } catch (error) {
        console.error(`[${this.botName}] Member list error:`, error.message);
        res.status(500).json({ error: error.message });
      }
    });

    // Health check
    this.httpApp.get('/health', (req, res) => {
      res.json({
        ok: true,
        status: this.client?.isReady() ? 'ok' : 'not_ready',
        bot: this.botName,
        mode: this.mode,
        discord: this.client?.isReady() ? 'connected' : 'disconnected',
        timestamp: new Date().toISOString(),
      });
    });

    this.httpServer = this.httpApp.listen(this.config.httpPort, '127.0.0.1', () => {
      console.log(`[${this.botName}] HTTP API on 127.0.0.1:${this.config.httpPort}`);
    });
  }

  // ============================================
  // Internal Helpers
  // ============================================

  async _lookupUserFromDiscord(discordUserId) {
    const db = tryGetDb();
    if (!db) return null;
    try {
      return await db.userIdentities.lookupByDiscord(discordUserId);
    } catch {
      return null;
    }
  }

  async _saveMessage({ role, content, discordUserId, discordUsername, channelId, channelName, messageId, serverId, serverName, agentId }) {
    const db = tryGetDb();
    if (!db) return null;
    try {
      let linkedUserId = null;
      if (role === 'user') {
        linkedUserId = await this._lookupUserFromDiscord(discordUserId);
      }

      const message = {
        role,
        content,
        message_type: 'text',
        agent_id: agentId,
        ...(linkedUserId && { user_id: linkedUserId }),
        metadata: {
          user_id: role === 'user' ? `discord:${discordUserId}` : this.botUserId,
          source: 'discord',
          bot: this.botName.toLowerCase(),
          discord_user_id: discordUserId,
          discord_username: discordUsername,
          discord_channel_id: channelId,
          discord_channel_name: channelName,
          discord_message_id: messageId,
          discord_server_id: serverId,
          discord_server_name: serverName,
          linked: !!linkedUserId,
        },
      };

      const data = await db.messages.insert(message);
      return data?.[0]?.id || null;
    } catch (error) {
      console.error(`[${this.botName}] DB error:`, error.message);
      return null;
    }
  }

  async _processAttachments(attachments, userId) {
    if (!attachments || attachments.size === 0) {
      return { content: null, results: [] };
    }
    try {
      return await processAllAttachments(attachments, userId);
    } catch (error) {
      console.error(`[${this.botName}] Attachment error:`, error.message);
      return { content: null, results: [] };
    }
  }

  /**
   * Resolve Discord <@ID> and <@!ID> mentions to readable @DisplayName.
   * Uses guild member cache + agent bot map for fast lookups.
   */
  _resolveMentions(content, guild) {
    if (!content) return content;
    return content.replace(/<@!?(\d+)>/g, (match, id) => {
      // Check agent bot map first (reverse lookup: id → name)
      for (const [name, botId] of Object.entries(this.agentBotMap)) {
        if (botId === id) return `@${name}`;
      }
      // Look up in guild member cache
      if (guild) {
        const member = guild.members.cache.get(id);
        if (member) return `@${member.displayName}`;
      }
      // Fallback: check all guilds
      for (const g of this.client?.guilds?.cache?.values() || []) {
        const member = g.members.cache.get(id);
        if (member) return `@${member.displayName}`;
      }
      return match; // keep raw if unresolvable
    });
  }

  async _fetchDiscordHistory(channel, beforeMessage, limit = 20) {
    try {
      const messages = await channel.messages.fetch({ limit, before: beforeMessage.id });
      const guild = channel.guild;
      return Array.from(messages.values())
        .reverse()
        .map((msg) => {
          const role = msg.author.bot ? 'assistant' : 'user';
          let content = this._resolveMentions(msg.content || '', guild);
          if (msg.attachments.size > 0) {
            const names = [...msg.attachments.values()].map(a => a.name).join(', ');
            content = content ? `${content} [attachments: ${names}]` : `[attachments: ${names}]`;
          }
          return content.trim() ? { role, content: role === 'user' ? `${msg.author.username}: ${content}` : content, username: role === 'user' ? msg.author.username : null } : null;
        })
        .filter(Boolean);
    } catch (error) {
      console.error(`[${this.botName}] Failed to fetch history:`, error.message);
      return [];
    }
  }

  async _healthCheckAgents() {
    const urls = new Set();
    if (this.mode === 'orchestrator') {
      for (const r of (this.config.routes || [])) {
        if (r.channelId !== '*') urls.add(r.agentUrl);
      }
    } else if (this.config.agentUrl) {
      urls.add(this.config.agentUrl);
    }

    for (const url of urls) {
      try {
        const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
        const data = await health.json();
        console.log(`[${this.botName}] Agent ${url}: ${data.status || 'ok'}`);
      } catch (error) {
        console.error(`[${this.botName}] Agent ${url}: not reachable (${error.message})`);
      }
    }
  }

  async _leaveUnauthorizedServers() {
    if (this.allowedServers.length === 0) return;
    for (const guild of this.client.guilds.cache.values()) {
      if (!this.allowedServers.includes(guild.id)) {
        console.log(`[${this.botName}] Leaving unauthorized server: ${guild.name}`);
        try {
          await guild.leave();
        } catch (error) {
          console.error(`[${this.botName}] Failed to leave ${guild.name}:`, error.message);
        }
      }
    }
  }
}

/**
 * Split message into chunks for Discord's character limit
 */
export function splitMessage(text, maxLength = 2000) {
  if (!text || text.length <= maxLength) return [text];

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

export default AgentDiscordBot;
