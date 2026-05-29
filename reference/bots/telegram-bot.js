#!/usr/bin/env node
/**
 * Telegram Bot Adapter for Mya
 *
 * Grammy long-polling bot that bridges Telegram messages to the agent-server.
 * Runs as a separate PM2 process.
 *
 * Flow:
 *   Telegram → Grammy → POST /chat on agent-server → response → Telegram
 *
 * Resilience:
 *   - longFetch bypasses Node.js undici 5-min hardcoded timeout (supports 65 min)
 *   - Retry with exponential backoff (5 retries)
 *   - Typing indicator kept alive throughout
 *   - Graceful timeout messages instead of errors
 *
 * HTTP API for proactive messaging:
 *   POST /telegram/send { chatId, text } — Send text message
 *   POST /telegram/send-file { chatId, filePath|base64, filename, caption } — Send file
 *
 * Config (env vars):
 *   TELEGRAM_BOT_TOKEN       — Telegram bot token (required)
 *   OWNER_TELEGRAM_ID        — Owner's Telegram user ID (required)
 *   AGENT_URL                — Agent-server URL (default: http://localhost:3004)
 *   TELEGRAM_BOT_PORT        — HTTP API port (default: 3003)
 *   USER_ID                  — User UUID (for message routing)
 */

import '@mycelium/core/sentry.js';
import 'dotenv/config';
import { bootstrapSecrets, refreshSecrets } from '@mycelium/core/bootstrap-secrets.js';
import crypto from 'crypto';
import http from 'http';
import { Bot, InputFile } from 'grammy';
import express from 'express';
import { processAttachment, createAttachmentRecord, signalShutdown as signalAttachmentShutdown } from '@mycelium/core/attachments.js';
import { initDb, tryGetDb } from '@mycelium/core/db.js';
import { getCanonicalOperatorId } from '@mycelium/core/canonical-user-id.js';
import { isOperatorTelegram, bootstrapOwnerBindingFromEnv } from '@mycelium/core/identity-telegram.js';
import { parseOperatorCommand } from '@mycelium/core/operator-commands.js';
import { redactId, redactText } from '@mycelium/core/log-redact.js';
import { captureError } from '@mycelium/core/error-classifier.js';
// Note: isUsageLimitMessage / isSilentReply are no longer consumed here.
// Under explicit-send the bot doesn't inspect agent text — it delegates
// to /chat for processing and to /telegram/send for delivery (which
// applies the assertDeliverable gate as last-line defense).
import { getWorkerUrl, getWorkerSecret, hasWorkerSecret } from '@mycelium/core/env.js';
import { readFile, stat } from 'fs/promises';
import pathModule from 'path';

// Bootstrap secrets from D1 API before reading config
await bootstrapSecrets();

// ── Config ──────────────────────────────────────────────────────────────────

// Support agent-specific bot token override (e.g. TELEGRAM_BOT_TOKEN_MOM for moms-telegram-bot).
// CRITICAL: if AGENT_ID is not the default mya-telegram-bot, an override is REQUIRED.
// Otherwise two bots fight over the same Telegram polling slot and neither works (409 loop).
const AGENT_ID = process.env.AGENT_ID || 'mya-telegram-bot';
const REQUIRES_OVERRIDE = AGENT_ID !== 'mya-telegram-bot';
if (REQUIRES_OVERRIDE && !process.env.TELEGRAM_BOT_TOKEN_OVERRIDE) {
  console.error(`[Telegram] ${AGENT_ID}: TELEGRAM_BOT_TOKEN_OVERRIDE is required (would conflict with mya-telegram-bot polling slot)`);
  process.exit(1);
}
const TOKEN = process.env.TELEGRAM_BOT_TOKEN_OVERRIDE || process.env.TELEGRAM_BOT_TOKEN;
const OWNER_ID = process.env.OWNER_TELEGRAM_ID;
const AGENT_URL = process.env.AGENT_URL || 'http://localhost:3004';
const HTTP_PORT = parseInt(process.env.TELEGRAM_BOT_PORT || '3003');
// USER_ID — the operator's canonical user.id, used in:
//   • /chat /chat/triage requests (so the agent knows which user this is for)
//   • db.telegramGroups.authorize/list (so the portal sees the same id when
//     it lists authorised groups)
//   • db.spaces.listForUser
//
// Sourced via getCanonicalOperatorId(db) which delegates to db.users.getFirst()
// — the SAME function authenticatePortalRequest uses. This guarantees writes
// from the bot match reads from the portal. process.env.USER_ID is the
// fallback for the boot window before D1 is reachable.
//
// Memoised at the canonical-user-id module level after first success.
const ENV_USER_ID = process.env.USER_ID;
async function getUserId() {
  return getCanonicalOperatorId(tryGetDb(), { envFallback: ENV_USER_ID });
}

// TTS lives at the egress chokepoint (/telegram/send accepts `voice: true`
// and synthesizes via @mycelium/core/tts). The bot is pure transport —
// it never authors voice replies. The voice-reply mechanism is now: bot
// passes `voiceMode: true` to /chat → prompt pre-fills the agent's curl
// with `voice: true` → /telegram/send synthesizes + uploads.

// WORKER_SECRET is still used by the HTTP auth middleware below
// (requireSecret) to gate the /telegram/send / /telegram/process endpoints
// against same-host loopback callers. It has nothing to do with TTS now.
const WORKER_SECRET = process.env.WORKER_SECRET || getWorkerSecret();

// ── Lockfile guard — prevent duplicate instances ───────────────────────────
// Each telegram bot identifies itself by AGENT_ID (or process.title fallback)
// to allow multiple bots (mya, moms, etc.) to coexist with separate locks.
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';

const LOCK_NAME = process.env.AGENT_ID || process.env.npm_package_name || 'telegram-bot';
const LOCK_PATH = `${tmpdir()}/mycelium-${LOCK_NAME}.lock`;

function acquireLock() {
  if (existsSync(LOCK_PATH)) {
    try {
      const existingPid = parseInt(readFileSync(LOCK_PATH, 'utf-8').trim(), 10);
      // Check if the PID is actually alive
      try {
        process.kill(existingPid, 0); // signal 0 = test if alive
        console.error(`[Telegram] Another instance is running (PID ${existingPid}). Lockfile: ${LOCK_PATH}`);
        console.error(`[Telegram] Exiting to avoid Telegram getUpdates conflict.`);
        process.exit(0); // exit 0 so PM2 doesn't immediately restart
      } catch {
        console.warn(`[Telegram] Stale lockfile (PID ${existingPid} not alive), reclaiming.`);
        unlinkSync(LOCK_PATH);
      }
    } catch (e) {
      console.warn(`[Telegram] Could not read lockfile: ${e.message}, reclaiming.`);
      try { unlinkSync(LOCK_PATH); } catch {}
    }
  }
  writeFileSync(LOCK_PATH, String(process.pid));
  console.log(`[Telegram] Acquired lock: ${LOCK_PATH} (PID ${process.pid})`);
}

function releaseLock() {
  try {
    if (existsSync(LOCK_PATH)) {
      const lockPid = parseInt(readFileSync(LOCK_PATH, 'utf-8').trim(), 10);
      if (lockPid === process.pid) {
        unlinkSync(LOCK_PATH);
        console.log(`[Telegram] Released lock: ${LOCK_PATH}`);
      }
    }
  } catch {}
}

acquireLock();

// Initialize database for attachment records
// initDb is fire-and-forget; bootstrapOwnerBindingFromEnv chains after it
// to write the OWNER_TELEGRAM_ID → operator binding into identity_channels
// (Phase 2 V6). Idempotent: no-op once the binding exists. The auth checks
// below prefer the DB binding and use OWNER_TELEGRAM_ID only as a
// bootstrap fallback.
initDb()
  .then(async () => {
    try {
      const result = await bootstrapOwnerBindingFromEnv(tryGetDb(), {
        log: console,
        // audit handled by the helper itself if a logger is available
      });
      if (result?.wrote) {
        console.log(`[Telegram] Bootstrap binding written (${result.reason})`);
      }
    } catch (err) {
      console.error('[Telegram] Bootstrap binding failed:', err?.message || err);
    }
  })
  .catch(err => console.error('[Telegram] DB init failed:', err.message));

if (!TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is required');
  releaseLock();
  process.exit(1);
}

if (!OWNER_ID) {
  console.error('OWNER_TELEGRAM_ID is required');
  releaseLock();
  process.exit(1);
}

// ── longFetch — bypass Node.js undici 5-min hardcoded headersTimeout ──────
// Node.js 22's built-in fetch() uses undici internally, which has a hardcoded
// 300s (5 min) headersTimeout that AbortSignal.timeout() does NOT override.
// For long-running Claude requests (up to 60 min), we use http.request directly.

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

// ── Telegram Message Helpers ────────────────────────────────────────────────

const TELEGRAM_MAX_LENGTH = 4096;

function splitMessage(text, maxLength = TELEGRAM_MAX_LENGTH - 100) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitPoint = -1;

    // Try paragraph break
    const paraBreak = remaining.lastIndexOf('\n\n', maxLength);
    if (paraBreak > maxLength * 0.5) splitPoint = paraBreak + 2;

    // Try line break
    if (splitPoint === -1) {
      const lineBreak = remaining.lastIndexOf('\n', maxLength);
      if (lineBreak > maxLength * 0.5) splitPoint = lineBreak + 1;
    }

    // Try sentence end
    if (splitPoint === -1) {
      const sentEnd = Math.max(
        remaining.lastIndexOf('. ', maxLength),
        remaining.lastIndexOf('! ', maxLength),
        remaining.lastIndexOf('? ', maxLength),
      );
      if (sentEnd > maxLength * 0.5) splitPoint = sentEnd + 2;
    }

    // Try word boundary
    if (splitPoint === -1) {
      const wordBreak = remaining.lastIndexOf(' ', maxLength);
      if (wordBreak > maxLength * 0.5) splitPoint = wordBreak + 1;
    }

    // Hard cut
    if (splitPoint === -1) splitPoint = maxLength;

    chunks.push(remaining.substring(0, splitPoint).trim());
    remaining = remaining.substring(splitPoint).trim();
  }

  return chunks;
}

function escapeMarkdown(text) {
  const underscoreCount = (text.match(/_/g) || []).length;
  const asteriskCount = (text.match(/\*/g) || []).length;
  const backtickCount = (text.match(/`/g) || []).length;

  let result = text;
  if (underscoreCount % 2 !== 0) result = result.replace(/_/g, '\\_');
  if (asteriskCount % 2 !== 0) result = result.replace(/\*/g, '\\*');
  if (backtickCount % 2 !== 0) result = result.replace(/`/g, '\\`');
  result = result.replace(/\[([^\]]+)\](?!\()/g, '\\[$1\\]');
  return result;
}

async function sendReply(ctx, text) {
  const chunks = splitMessage(text);
  if (chunks.length > 1) {
    console.log(`[Telegram] Splitting reply into ${chunks.length} chunks: ${chunks.map((c, i) => `[${i + 1}]=${c.length}ch`).join(', ')}`);
  }
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const suffix = i < chunks.length - 1 ? '\n\n...' : '';
    const msg = chunk + suffix;

    if (!msg || msg.trim().length === 0) {
      console.warn(`[Telegram] Skipping empty chunk ${i + 1}/${chunks.length}`);
      continue;
    }

    try {
      await ctx.reply(escapeMarkdown(msg), { parse_mode: 'Markdown' });
    } catch (mdErr) {
      console.warn(`[Telegram] Markdown send failed for chunk ${i + 1}/${chunks.length} (${msg.length}ch): ${mdErr.message?.slice(0, 120)}`);
      try {
        await ctx.reply(msg);
      } catch (err) {
        console.error(`[Telegram] Plain text also failed for chunk ${i + 1}/${chunks.length}: ${err.message}`);
        if (i === 0) {
          try { await ctx.reply('I have a response but encountered an error sending it.'); } catch {}
        }
      }
    }

    if (i < chunks.length - 1) {
      await new Promise(r => setTimeout(r, 100));
    }
  }
}

async function sendMessage(bot, chatId, text) {
  const chunks = splitMessage(text);
  if (chunks.length > 1) {
    console.log(`[Telegram] Splitting message into ${chunks.length} chunks: ${chunks.map((c, i) => `[${i + 1}]=${c.length}ch`).join(', ')}`);
  }
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const suffix = i < chunks.length - 1 ? '\n\n...' : '';
    const msg = chunk + suffix;

    if (!msg || msg.trim().length === 0) {
      console.warn(`[Telegram] Skipping empty chunk ${i + 1}/${chunks.length}`);
      continue;
    }

    try {
      await bot.api.sendMessage(chatId, escapeMarkdown(msg), { parse_mode: 'Markdown' });
    } catch (mdErr) {
      console.warn(`[Telegram] Markdown send failed for chunk ${i + 1}/${chunks.length} (${msg.length}ch): ${mdErr.message?.slice(0, 120)}`);
      try {
        await bot.api.sendMessage(chatId, msg);
      } catch (err) {
        console.error(`[Telegram] Plain text also failed for chunk ${i + 1}/${chunks.length}: ${err.message}`);
      }
    }

    if (i < chunks.length - 1) {
      await new Promise(r => setTimeout(r, 100));
    }
  }
}

async function sendGroupReply(ctx, text) {
  const chunks = splitMessage(text);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const suffix = i < chunks.length - 1 ? '\n\n...' : '';
    const msg = chunk + suffix;
    if (!msg?.trim()) continue;

    try {
      await ctx.reply(escapeMarkdown(msg), {
        parse_mode: 'Markdown',
        reply_to_message_id: ctx.message?.message_id,
      });
    } catch {
      try {
        await ctx.reply(msg, { reply_to_message_id: ctx.message?.message_id });
      } catch (err) {
        console.error(`[Telegram] Group reply failed chunk ${i + 1}/${chunks.length}: ${err.message}`);
      }
    }

    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 100));
  }
}

// ── Agent-Server Communication ──────────────────────────────────────────────

// Agent calls can run for several minutes. A retry that arrives while the
// primary is still executing lands in the coalesce queue on the agent side;
// the server-side fix silences coalesced duplicates, but we still want to
// be conservative about retrying at all. Two attempts is plenty for a
// transient TCP reset; beyond that we're almost always compounding harm.
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 5000;
const RETRY_MAX_MS = 120_000;

// Error types that should NOT be retried
const NON_RETRYABLE_STATUSES = new Set([401, 402, 403, 422]);

/**
 * Ask the agent to triage a group message: REPLY or NO_REPLY?
 *
 * Calls /chat/triage which runs the agent through Claude Code with the
 * full normal context but a triage-mode terminal prompt. The endpoint
 * returns a structured decision with no prose. If the endpoint is missing
 * (older server), we fail open and treat as REPLY — graceful fallback
 * during rollout. The client-side isSilentReply mirror in chatWithAgent
 * still catches anything that leaks past.
 *
 * Fail-closed on triage server errors that aren't 404 (real server is
 * up but triage failed) — security over availability.
 */
async function chatTriage(message, telegramUserId, opts = {}) {
  const { source = 'telegram', channelId: overrideChannelId, messageId, username, channel } = opts;

  try {
    const headers = { 'Content-Type': 'application/json' };
    const botAgentToken = process.env.AGENT_TOKEN || process.env.WORKER_SECRET || getWorkerSecret();
    if (botAgentToken) headers['Authorization'] = `Bearer ${botAgentToken}`;

    const body = {
      message,
      channelId: overrideChannelId || `telegram_${telegramUserId}`,
      userId: await getUserId(),
      source,
      username: username || 'telegram-user',
      channel: channel || 'telegram-dm',
    };
    if (messageId != null) body.dedupeNonce = `tg-triage:${messageId}`;

    const response = await longFetch(`${AGENT_URL}/chat/triage`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      timeout: 6 * 60 * 1000, // 6 minutes (server caps triage at 5 min internally)
    });

    if (response.status === 404) {
      // Older server without /chat/triage. Fall back to direct /chat call
      // by treating triage as REPLY. The egress gate + client-side mirror
      // still protect against leaks; we just lose the typing-on-decision UX.
      console.warn('[Telegram] /chat/triage returned 404 — falling back to direct /chat (older server)');
      return 'REPLY';
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.warn(`[Telegram] Triage returned ${response.status}: ${text.slice(0, 200)} — fail-closed NO_REPLY`);
      return 'NO_REPLY';
    }

    const data = await response.json();
    if (data.decision === 'REPLY') return 'REPLY';
    return 'NO_REPLY';
  } catch (err) {
    // Network error, timeout, etc. — fail closed.
    console.warn(`[Telegram] Triage error — fail-closed NO_REPLY: ${err.message}`);
    return 'NO_REPLY';
  }
}

async function chatWithAgent(message, telegramUserId, opts = {}) {
  const {
    spaceId, source = 'telegram',
    channelId: overrideChannelId, messageId, username, channel,
    // Explicit-send architecture: bot is transport. The /chat endpoint
    // returns ONLY diagnostics — never agent text. Bot does NOT auto-
    // reply. The agent must curl /telegram/send during its run to
    // actually deliver a message. These three fields tell the prompt
    // exactly which curl to compose:
    //   inboundChatId   — real telegram chatId (required for the curl)
    //   inboundMessageId — for reply-to in groups
    //   voiceMode       — true if user sent voice, prompt suggests voice:true
    inboundChatId, inboundMessageId, voiceMode,
    // attachmentId — links the freshly-stored attachment row to the
    // user message /chat will write. Without this, the portal chat
    // history can't render images sent over Telegram (it sees only
    // the agent-prompt bracket placeholder).
    attachmentId,
  } = opts;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      const botAgentToken = process.env.AGENT_TOKEN || process.env.WORKER_SECRET || getWorkerSecret();
      if (botAgentToken) headers['Authorization'] = `Bearer ${botAgentToken}`;

      // username + channel populate the agent's currentMessageSection
      // and log line. Without them the agent logs "Chat from undefined
      // in #undefined". Telegram has no channel concept per se, so we
      // use the group title (when in a group) or 'DM' for private chats.
      const body = {
        message,
        channelId: overrideChannelId || `telegram_${telegramUserId}`,
        userId: await getUserId(),
        source,
        username: username || 'telegram-user',
        channel: channel || 'telegram-dm',
        // Explicit-send: provide the *real* chatId so the prompt can
        // pre-fill the agent's curl with the correct target.
        inboundChatId: inboundChatId != null ? String(inboundChatId) : String(telegramUserId),
      };
      if (inboundMessageId != null) body.inboundMessageId = inboundMessageId;
      if (voiceMode) body.voiceMode = true;
      if (spaceId) body.spaceId = spaceId;
      if (attachmentId) body.attachmentId = attachmentId;
      // Pass Telegram message_id as dedupeNonce so that the runner's dedup hash
      // is unique per inbound message — prevents legitimate "yes"/"ok" replies
      // from being blocked as duplicates while still catching Telegram retries
      // (which reuse the same message_id).
      if (messageId != null) body.dedupeNonce = `tg:${messageId}`;

      const response = await longFetch(`${AGENT_URL}/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        timeout: 65 * 60 * 1000, // 65 minutes — Claude can run up to 60 min
      });

      if (!response.ok) {
        const text = await response.text();
        if (NON_RETRYABLE_STATUSES.has(response.status)) {
          throw new Error(`Agent returned ${response.status}: ${text.slice(0, 200)}`);
        }
        throw Object.assign(new Error(`Agent returned ${response.status}: ${text.slice(0, 200)}`), { retryable: true });
      }

      const data = await response.json().catch(() => ({}));

      // Explicit-send architecture: /chat now returns diagnostics only —
      // never agent text. The agent's actual reply, if any, was delivered
      // by its own curl to /telegram/send during the run. The bot is pure
      // transport and never authors messages from /chat output.
      if (data.error) {
        console.warn(`[Telegram] /chat returned error: ${data.error}`);
      }
      return null;
    } catch (err) {
      lastError = err;

      // Timeout: don't retry — the work is checkpointed
      if (err.message?.includes('timeout')) {
        console.log(`[Telegram] Agent request timed out (attempt ${attempt + 1})`);
        return 'This is taking longer than expected. My work has been checkpointed — I\'ll continue and get back to you.';
      }

      // Non-retryable error
      if (!err.retryable && !err.message?.includes('ECONNREFUSED') && !err.message?.includes('ECONNRESET')) {
        throw err;
      }

      // Retryable: exponential backoff
      if (attempt < MAX_RETRIES) {
        const delay = Math.min(RETRY_BASE_MS * Math.pow(2, attempt), RETRY_MAX_MS);
        console.log(`[Telegram] Retry ${attempt + 1}/${MAX_RETRIES} in ${delay / 1000}s: ${err.message}`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  throw lastError || new Error('All retries exhausted');
}

// ── TTS Voice Generation ─────────────────────────────────────────────────────
//
// Voice synthesis used to live here, called from the bot's reply path.
// Under the explicit-send architecture, it moved to /telegram/send (the
// egress chokepoint) where the agent invokes it via `voice: true` on its
// curl. This bot is now pure transport — it never authors voice (or text)
// replies.
//
// The bot still tells /chat that the inbound was voice (via voiceMode:
// true on the request body), and the prompt-section pre-fills the agent's
// curl with `voice: true`. The agent can opt out by removing the flag.

// ── Grammy Bot Setup ────────────────────────────────────────────────────────

const bot = new Bot(TOKEN);

// Raw update logger — catches EVERYTHING before middleware. Privacy:
// chat titles + sender names are PII (group names can reveal social
// context; first names link to humans). Log only kind + redacted ids.
bot.use(async (ctx, next) => {
  const chatType = ctx.chat?.type || 'unknown';
  const updateType = Object.keys(ctx.update).filter(k => k !== 'update_id').join(',');
  console.log(`[Telegram] RAW UPDATE: type=${updateType} chat=${chatType} chatId=${redactId(ctx.chat?.id, 'c-')} from=${redactId(ctx.from?.id, 'u-')}`);
  return next();
});

// ── Group Chat Rate Limiting ─────────────────────────────────────────────
const groupRateLimit = new Map();
const userGroupRateLimit = new Map();
const GROUP_RATE_LIMIT = 60;
const USER_GROUP_RATE_LIMIT = 20;

// ── Error reply dedupe ───────────────────────────────────────────────────
// If the agent-server keeps failing (rate limit, billing, network), we MUST
// NOT spam the chat with "something went wrong" for every inbound message.
// Keep track of the last time we emitted an error reply per chat, and stay
// silent inside the cooldown window.
const ERROR_REPLY_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes per chat
const _errorReplyLastSentByChat = new Map();
function shouldEmitErrorReply(chatId) {
  const now = Date.now();
  const last = _errorReplyLastSentByChat.get(chatId) || 0;
  if (now - last < ERROR_REPLY_COOLDOWN_MS) return false;
  _errorReplyLastSentByChat.set(chatId, now);
  return true;
}

// ── Usage-limit reply dedupe ─────────────────────────────────────────────
// Claude Code returns "You've hit your limit · resets 11p…" / "Limits hit,
// 💸" as the normal result text when the subscription runs out of weekly
// or 5-hour tokens. Because the runner resolves those successfully, the
// existing error-reply cooldown never fires. Without this gate, every
// inbound message while limits are exhausted produces another limit
// message to the chat — the "bot keeps spamming the limit notice" bug.
//
// Policy: emit the limit message once per chat, then stay silent until
// the subscription window rolls over. Claude Code's usage windows are
// 5 hours, so the cooldown matches — anything shorter re-surfaces the
// notice inside the same dead window and produces the same spam the
// gate is meant to prevent.
const LIMIT_REPLY_COOLDOWN_MS = 5 * 60 * 60 * 1000; // 5 hours per chat
const _limitReplyLastSentByChat = new Map();
function shouldEmitLimitReply(chatId) {
  const now = Date.now();
  const last = _limitReplyLastSentByChat.get(chatId) || 0;
  if (now - last < LIMIT_REPLY_COOLDOWN_MS) return false;
  _limitReplyLastSentByChat.set(chatId, now);
  return true;
}

function checkGroupRateLimit(groupId, userId) {
  const now = Date.now();
  const hourMs = 3600_000;

  let groupBucket = groupRateLimit.get(groupId);
  if (!groupBucket || now > groupBucket.resetAt) {
    groupBucket = { count: 0, resetAt: now + hourMs };
    groupRateLimit.set(groupId, groupBucket);
  }
  if (groupBucket.count >= GROUP_RATE_LIMIT) return false;

  const userKey = `${groupId}:${userId}`;
  let userBucket = userGroupRateLimit.get(userKey);
  if (!userBucket || now > userBucket.resetAt) {
    userBucket = { count: 0, resetAt: now + hourMs };
    userGroupRateLimit.set(userKey, userBucket);
  }
  if (userBucket.count >= USER_GROUP_RATE_LIMIT) return false;

  groupBucket.count++;
  userBucket.count++;
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of groupRateLimit) if (now > v.resetAt) groupRateLimit.delete(k);
  for (const [k, v] of userGroupRateLimit) if (now > v.resetAt) userGroupRateLimit.delete(k);
}, 600_000);

// ── Auth Middleware — owner for DMs, authorized group check for groups ──
bot.use(async (ctx, next) => {
  const chatType = ctx.chat?.type;
  if (chatType === 'group' || chatType === 'supergroup') {
    console.log(`[Telegram] Group update from ${redactId(ctx.from?.id, 'u-')} in ${redactId(ctx.chat?.id, 'g-')} (type: ${ctx.update?.message ? 'message' : ctx.update?.my_chat_member ? 'my_chat_member' : 'other'})`);
  }

  if (chatType === 'private') {
    // V6: identity_channels is source of truth; OWNER_TELEGRAM_ID is
    // bootstrap fallback only (resolved inside isOperatorTelegram).
    if (!(await isOperatorTelegram(tryGetDb(), ctx.from?.id))) {
      console.log(`[Telegram] Ignoring DM from non-owner ${redactId(ctx.from?.id, 'u-')}`);
      return;
    }
    return next();
  }

  if (chatType === 'group' || chatType === 'supergroup') {
    if (ctx.message?.text?.startsWith('/') &&
        await isOperatorTelegram(tryGetDb(), ctx.from?.id)) {
      ctx._isGroupOwnerCommand = true;
      return next();
    }

    const msg = ctx.message;
    if (!msg) return;

    // Skip bot's own messages
    if (msg.from?.id === bot.botInfo?.id) return;

    const db = tryGetDb();
    if (!db?.telegramGroups) return;

    const groupId = String(ctx.chat.id);
    let group;
    try {
      group = await db.telegramGroups.get(groupId);
    } catch (err) {
      console.error(`[Telegram] Group lookup failed for ${groupId}:`, err.message);
      return;
    }

    if (!group) {
      console.log(`[Telegram] Ignoring unauthorized group ${redactId(groupId, 'g-')}`);
      return;
    }

    if (!checkGroupRateLimit(groupId, String(ctx.from?.id))) {
      if (shouldEmitErrorReply(ctx.chat?.id)) {
        try { await ctx.reply('Rate limit reached. Please try again later.', { reply_to_message_id: msg.message_id }); } catch {}
      }
      return;
    }

    ctx._telegramGroup = group;
    ctx._isGroupChat = true;

    if (ctx.chat.title && ctx.chat.title !== group.title) {
      db.telegramGroups.updateTitle(groupId, ctx.chat.title).catch(() => {});
    }

    return next();
  }

  return;
});

// Extract reply-to message context (when user replies to a previous message)
function getReplyContext(ctx) {
  const reply = ctx.message?.reply_to_message;
  if (!reply) return '';

  let replyContent = '';
  if (reply.text) {
    replyContent = reply.text;
  } else if (reply.caption) {
    replyContent = reply.caption;
  } else if (reply.voice) {
    replyContent = '[voice message]';
  } else if (reply.photo) {
    replyContent = '[photo]';
  } else if (reply.document) {
    replyContent = `[document: ${reply.document.file_name || 'file'}]`;
  }

  if (!replyContent) return '';

  const from = reply.from?.first_name || reply.from?.username || 'Unknown';
  return `[Replying to ${from}'s message: "${replyContent}"]\n\n`;
}

// ── /start — conversation-aware greeting ────────────────────────────────
bot.command('start', async (ctx) => {
  try {
    // Check if user already has conversation history
    const headers = { 'Content-Type': 'application/json' };
    const botAgentToken = process.env.AGENT_TOKEN || process.env.WORKER_SECRET || getWorkerSecret();
    if (botAgentToken) headers['Authorization'] = `Bearer ${botAgentToken}`;

    let hasHistory = false;
    try {
      const histRes = await fetch(`${AGENT_URL}/portal/chat/history?limit=3`, { headers });
      if (histRes.ok) {
        const hist = await histRes.json();
        hasHistory = (hist.messages || []).length > 0;
      }
    } catch {}

    if (hasHistory) {
      await ctx.reply(
        `This channel is now connected. I have context from our earlier conversations — just pick up where you left off.`,
        { parse_mode: 'Markdown' },
      );
    } else {
      await ctx.reply(
        `Welcome to your Mycelium. I'm your personal agent — you can talk to me here just like in the portal.\n\nEverything you share is encrypted end-to-end. What would you like to start with?`,
        { parse_mode: 'Markdown' },
      );
    }
  } catch (err) {
    console.error('[Telegram] /start handler error:', err.message);
    await ctx.reply(`Connected. Send me a message to get started.`).catch(() => {});
  }
});

// ── Channel Authority Commands ─────────────────────────────────────────
//
// Five operator commands gate the registry from chat surfaces:
//   /allow                       — register current group (persistent)
//   /allow autonomous            — flip allowAutonomous on this channel
//   /allow autonomous all        — flip global kill-switch ON
//   /allow <space-name>          — route current group to a Space (legacy)
//   /disallow                    — soft-delete current group from registry
//   /disallow autonomous         — flip allowAutonomous off (channel)
//   /disallow autonomous all     — flip global kill-switch OFF
//   /channels                    — list registered channels (DM only)
//
// Aliases preserved for back-compat: /revoke = /disallow, /groups = /channels.
//
// Dispatch path: bot parses the command via the shared parser, then HTTPs
// agent-server's /portal/channels/* endpoints over loopback (with the
// WORKER_SECRET as Bearer auth). agent-server is the single owner of the
// registry's state file — no two-process race on channels.json.
//
// Operator gate: ctx.from.id must equal OWNER_TELEGRAM_ID. Non-operators
// hit a silent return — no reply, no error log.

async function callPortalChannels(method, pathname, body) {
  const headers = { 'Content-Type': 'application/json' };
  const secret = process.env.WORKER_SECRET || getWorkerSecret();
  if (secret) headers['Authorization'] = `Bearer ${secret}`;
  const res = await fetch(`${AGENT_URL}${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { ok: res.ok, status: res.status, body: parsed, raw: text };
}

async function dispatchOperatorCommand(ctx) {
  // V6: identity_channels source of truth (env-var bootstrap fallback).
  if (!(await isOperatorTelegram(tryGetDb(), ctx.from?.id))) return false;  // silent ignore
  const text = ctx.message?.text;
  const cmd = parseOperatorCommand(text);
  if (!cmd) return false;

  const chatType = ctx.chat?.type;
  const isGroup = chatType === 'group' || chatType === 'supergroup';
  const isDM = chatType === 'private';

  // Global kill-switch — works anywhere.
  if (cmd.scope === 'global') {
    const enable = cmd.kind === 'allow';
    const r = await callPortalChannels('PATCH', '/portal/channels/global', {
      autonomousGlobalEnabled: enable,
    });
    if (!r.ok) {
      await ctx.reply(`Error: ${r.body?.error || 'failed to update global flag'}`);
      return true;
    }
    if (enable) {
      await ctx.reply(`✓ Autonomous globally ON. Per-channel allowAutonomous flags govern again.`);
    } else {
      await ctx.reply(`✓ Autonomous globally OFF. Wake-cycle output silenced; per-channel flags preserved for resume.`);
    }
    return true;
  }

  // /channels — DM only.
  if (cmd.kind === 'channels') {
    if (!isDM) {
      await ctx.reply('Use /channels in a DM with me.');
      return true;
    }
    const r = await callPortalChannels('GET', '/portal/channels');
    if (!r.ok) {
      await ctx.reply(`Error: ${r.body?.error || 'failed to load channels'}`);
      return true;
    }
    const { channels = [], autonomousGlobalEnabled = true } = r.body || {};
    if (channels.length === 0) {
      await ctx.reply('No channels registered yet. Add me to a group and run /allow.');
      return true;
    }
    const lines = channels.map((c) => {
      const flags = [];
      if (c.isOperatorDM) flags.push('operator');
      if (c.allowAutonomous) flags.push('autonomous');
      const flagStr = flags.length ? ` [${flags.join(', ')}]` : '';
      return `• ${c.label}  —  ${c.kind}_${c.id}${flagStr}`;
    });
    const header = autonomousGlobalEnabled
      ? 'Authorised channels:'
      : 'Authorised channels (autonomous globally OFF):';
    await ctx.reply(`${header}\n${lines.join('\n')}`);
    return true;
  }

  // /allow-space — preserved legacy form; resolves a Space and writes via
  // the unified portal endpoint (which mirrors to telegram_groups).
  if (cmd.kind === 'allow-space') {
    if (!isGroup) {
      await ctx.reply('Use /allow <space-name> in a group chat to route it to a Space.');
      return true;
    }
    const args = cmd.spaceName;
    const groupId = String(ctx.chat.id);
    const db = tryGetDb();
    if (!db) { await ctx.reply('Database unavailable.'); return true; }

    if (args.toLowerCase() === 'personal') {
      const r = await callPortalChannels('POST', '/portal/channels', {
        kind: 'telegram-group', id: groupId, label: ctx.chat.title,
        learnedFrom: 'runtime:/allow',
      });
      if (!r.ok) { await ctx.reply(`Error: ${r.body?.error || 'failed'}`); return true; }
      await ctx.reply(`✓ Group authorised with personal-agent context.\n\nI'll participate naturally in the conversation.`);
      console.log(`[Telegram] Group ${redactId(groupId, 'g-')} authorised → personal`);
      return true;
    }

    if (db.spaces) {
      const spaces = await db.spaces.listForUser(await getUserId());
      const match = spaces.find((s) =>
        s.handle?.toLowerCase() === args.toLowerCase()
        || s.display_name?.toLowerCase() === args.toLowerCase());
      if (match) {
        const r = await callPortalChannels('POST', '/portal/channels', {
          kind: 'telegram-group', id: groupId, label: ctx.chat.title,
          spaceId: match.id, learnedFrom: 'runtime:/allow',
        });
        if (!r.ok) { await ctx.reply(`Error: ${r.body?.error || 'failed'}`); return true; }
        await ctx.reply(`✓ Group authorised → "${match.display_name || match.handle}"\n\nI'll participate naturally in the conversation.`);
        console.log(`[Telegram] Group ${redactId(groupId, 'g-')} authorised → Space ${redactId(match.id, 's-')}`);
        return true;
      }
      const available = spaces.map((s) => `  • ${s.display_name || s.handle || s.id}`).join('\n');
      await ctx.reply(`Space "${args}" not found.\n\nOptions:\n  • /allow — personal-agent context\n  • /allow <space_name>\n\nAvailable spaces:\n${available || '(none)'}`);
    } else {
      const r = await callPortalChannels('POST', '/portal/channels', {
        kind: 'telegram-group', id: groupId, label: ctx.chat.title,
        learnedFrom: 'runtime:/allow',
      });
      if (!r.ok) { await ctx.reply(`Error: ${r.body?.error || 'failed'}`); return true; }
      await ctx.reply(`✓ Group authorised with personal-agent context.`);
    }
    return true;
  }

  // Per-channel allow/disallow + autonomous toggles.
  const groupId = String(ctx.chat.id);
  const isTelegramKindable = isGroup || isDM;
  if (!isTelegramKindable) {
    await ctx.reply('This command only works in a group or DM.');
    return true;
  }
  const channelKind = isGroup ? 'telegram-group' : 'telegram';
  const channelId = isGroup ? groupId : String(ctx.from.id);
  const labelFallback = isGroup ? ctx.chat.title : 'operator-dm';

  if (cmd.kind === 'allow') {
    if (cmd.autonomous) {
      // /allow autonomous — flip flag on this channel; record first if missing.
      // POST is idempotent (upsert) and sets allowAutonomous.
      const r = await callPortalChannels('POST', '/portal/channels', {
        kind: channelKind, id: channelId, label: labelFallback,
        allowAutonomous: true, learnedFrom: 'runtime:/allow autonomous',
      });
      if (!r.ok) { await ctx.reply(`Error: ${r.body?.error || 'failed'}`); return true; }
      await ctx.reply(`✓ Autonomous output ENABLED for "${r.body?.channel?.label || labelFallback}".`);
      return true;
    }
    // Plain /allow: register without autonomous.
    const r = await callPortalChannels('POST', '/portal/channels', {
      kind: channelKind, id: channelId, label: labelFallback,
      allowAutonomous: false, learnedFrom: 'runtime:/allow',
    });
    if (!r.ok) { await ctx.reply(`Error: ${r.body?.error || 'failed'}`); return true; }
    await ctx.reply(`✓ Channel authorised with personal-agent context.\n\nI'll participate naturally in the conversation.`);
    return true;
  }

  if (cmd.kind === 'disallow') {
    if (cmd.autonomous) {
      // /disallow autonomous — keep registered, flip allowAutonomous off.
      const r = await callPortalChannels('PATCH', `/portal/channels/${channelKind}/${encodeURIComponent(channelId)}`, {
        allowAutonomous: false,
      });
      if (!r.ok) {
        if (r.status === 409 && r.body?.error === 'cannot-disallow-operator-dm') {
          await ctx.reply(`Operator DM is structural — autonomous can't be disabled here. Use /disallow autonomous all to silence wake cycles globally instead.`);
        } else {
          await ctx.reply(`Error: ${r.body?.error || 'failed'}`);
        }
        return true;
      }
      await ctx.reply(`✓ Autonomous output DISABLED for "${r.body?.channel?.label || labelFallback}".`);
      return true;
    }
    // Plain /disallow: soft-delete the channel.
    const r = await callPortalChannels('DELETE', `/portal/channels/${channelKind}/${encodeURIComponent(channelId)}`);
    if (!r.ok) { await ctx.reply(`Error: ${r.body?.error || 'failed'}`); return true; }
    await ctx.reply(`✓ Channel removed. I'll stop responding here.`);
    return true;
  }

  if (cmd.kind === 'invalid') {
    await ctx.reply(`Unrecognised command. Use /allow, /disallow, or /channels.`);
    return true;
  }

  return false;
}

// Dispatch all five operator commands through the shared parser. Each
// bot.command(...) handler invokes the unified dispatcher, which gates
// by operator id and calls portal-channels via loopback. Aliases:
//   /revoke = /disallow
//   /groups = /channels
bot.command('allow',     async (ctx) => { await dispatchOperatorCommand(ctx); });
bot.command('disallow',  async (ctx) => { await dispatchOperatorCommand(ctx); });
bot.command('channels',  async (ctx) => { await dispatchOperatorCommand(ctx); });

bot.command('revoke', async (ctx) => {
  // Back-compat alias for /disallow. Rewrite the message text so the
  // shared parser sees /disallow shape.
  if (ctx.message?.text) {
    const rewritten = ctx.message.text.replace(/^\/revoke(@\w+)?/i, '/disallow');
    ctx.message.text = rewritten;
  }
  await dispatchOperatorCommand(ctx);
});

bot.command('groups', async (ctx) => {
  // Back-compat alias for /channels.
  if (ctx.message?.text) {
    const rewritten = ctx.message.text.replace(/^\/groups(@\w+)?/i, '/channels');
    ctx.message.text = rewritten;
  }
  await dispatchOperatorCommand(ctx);
});

// ── Detect bot added/removed from groups ──
bot.on('my_chat_member', async (ctx) => {
  const chat = ctx.myChatMember.chat;
  const newStatus = ctx.myChatMember.new_chat_member?.status;

  if (chat.type === 'group' || chat.type === 'supergroup') {
    if (newStatus === 'member' || newStatus === 'administrator') {
      console.log(`[Telegram] Bot added to group ${redactId(chat.id, 'g-')}`);
      try {
        await bot.api.sendMessage(OWNER_ID,
          `I was added to "${chat.title}". Use /allow <space_name> in that group to authorize me.`
        );
      } catch {}
    } else if (newStatus === 'left' || newStatus === 'kicked') {
      console.log(`[Telegram] Bot removed from group ${redactId(chat.id, 'g-')}`);
      const db = tryGetDb();
      if (db?.telegramGroups) {
        db.telegramGroups.revoke(String(chat.id)).catch(() => {});
      }
    }
  }
});

// ── Message Coalescing ──────────────────────────────────────────────────
// Telegram caps individual messages at 4096 chars, so long pasted content
// arrives as multiple rapid-fire messages. Users also often type a thought,
// send it, then immediately follow up. Buffer text per chat and flush after
// a brief silence window so we respond once to the combined thought.
const TEXT_DEBOUNCE_MS = 1500;
const textBuffers = new Map(); // chatId → { parts, replyContext, lastCtx, timer, typingInterval }

function clearBufferIntervals(buf) {
  if (buf.timer) { clearTimeout(buf.timer); buf.timer = null; }
  if (buf.typingInterval) { clearInterval(buf.typingInterval); buf.typingInterval = null; }
}

function flushTextBuffer(chatId) {
  const buf = textBuffers.get(chatId);
  if (!buf || buf.parts.length === 0) return;
  textBuffers.delete(chatId);
  clearBufferIntervals(buf);

  const combined = buf.parts.join('\n\n');
  if (buf.parts.length > 1) {
    console.log(`[Telegram] Coalescing ${buf.parts.length} fragments into ${combined.length} chars`);
  }

  // Pass triage signal to the handler. groupUnaddressed=true means:
  // group chat AND none of the buffered fragments was directly addressed
  // (no @mention, no reply-to-bot). The handler triages first; typing
  // indicator fires only on REPLY decision.
  const groupUnaddressed = buf.isGroupChat && !buf.directlyAddressed;

  // Fire-and-forget so new messages aren't blocked by an in-flight reply.
  // Agent-server's own coalescing handles concurrent /chat calls from the same channel.
  handleCoalescedText(buf.lastCtx, buf.replyContext + combined, buf.parts.length, { groupUnaddressed }).catch(err => {
    console.error('[Telegram] Coalesced handler error:', err.message);
  });
}

async function handleCoalescedText(ctx, fullMessage, fragmentCount, opts = {}) {
  // groupUnaddressed = group chat AND no @mention / no reply-to-bot.
  // For these, we triage FIRST (no typing yet), then start typing only
  // if the agent decides REPLY. This is the structural fix for the
  // monologue leak: the triage call's prose is structurally discarded
  // server-side, so reflection cannot reach the channel.
  const groupUnaddressed = !!opts.groupUnaddressed;

  const chatOpts = {};
  if (ctx._isGroupChat && ctx._telegramGroup) {
    if (ctx._telegramGroup.space_id) {
      chatOpts.spaceId = ctx._telegramGroup.space_id;
    }
    chatOpts.source = 'telegram-group';
    chatOpts.channelId = `telegram-group_${ctx.chat.id}`;
    chatOpts.channel = ctx.chat?.title || `telegram-group-${ctx.chat.id}`;
  } else {
    chatOpts.channel = 'telegram-dm';
  }
  chatOpts.username = ctx.from?.first_name
    ? (ctx.from.last_name ? `${ctx.from.first_name} ${ctx.from.last_name}` : ctx.from.first_name)
    : (ctx.from?.username || `tg:${ctx.from?.id || 'unknown'}`);
  if (ctx.message?.message_id != null) chatOpts.messageId = ctx.message.message_id;

  // Explicit-send architecture: prompt-injects the agent's curl with the
  // real chatId + (for groups) reply-to messageId. (Voice inbound goes
  // through handleTelegramFile, not this text path — voiceMode is set
  // there.)
  chatOpts.inboundChatId = ctx.chat?.id;
  if (ctx._isGroupChat && ctx.message?.message_id != null) {
    chatOpts.inboundMessageId = ctx.message.message_id;
  }

  // Triage gate for unaddressed group messages. DMs and directly-addressed
  // group messages skip triage (the answer is "of course reply") and go
  // straight to /chat with typing-on.
  if (groupUnaddressed) {
    console.log(`[Telegram] Triage gate active for ${fragmentCount} fragment(s) in group ${ctx.chat?.title}`);
    let decision;
    try {
      decision = await chatTriage(fullMessage, ctx.from.id, chatOpts);
    } catch (err) {
      console.error('[Telegram] Triage error (unhandled):', err.message);
      return; // fail closed — silent
    }
    if (decision !== 'REPLY') {
      console.log(`[Telegram] Triage: ${decision} — silent (no typing, no reply)`);
      return;
    }
    console.log('[Telegram] Triage: REPLY — proceeding to /chat with typing');
  }

  // Start typing now — either we're DM/directly-addressed (existing flow)
  // or triage decided REPLY (new flow). Either way, the agent is
  // committed to producing a response.
  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction('typing').catch(() => {});
  }, 4000);
  ctx.replyWithChatAction('typing').catch(() => {});

  try {
    // Explicit-send architecture: chatWithAgent always returns null. The
    // agent's reply, if any, was delivered by its own curl to
    // /telegram/send during the run. Bot is transport.
    await chatWithAgent(fullMessage, ctx.from.id, chatOpts);
    clearInterval(typingInterval);
  } catch (err) {
    clearInterval(typingInterval);
    console.error('[Telegram] Agent chat failed:', err.message);
    captureError(err, { agentId: 'mya-telegram', taskType: 'chat' });
    // Only surface one error reply per chat per cooldown window to avoid
    // spamming groups when the agent-server keeps failing (e.g. rate limit).
    if (shouldEmitErrorReply(ctx.chat?.id)) {
      await ctx.reply(`Something went wrong, but your message was received. I'll follow up when I can.`).catch(() => {});
    } else {
      console.log(`[Telegram] Suppressing error reply for chat ${ctx.chat?.id} (cooldown active)`);
    }
  }
}

// Handle text messages — buffer and debounce to coalesce fragmented messages
bot.on('message:text', async (ctx) => {
  const chatId = ctx.chat.id;
  let text = ctx.message.text;

  // Detect @mention on the ORIGINAL text. Stripping (below) removes the
  // tag from the prompt body; if we did the includes() check after the
  // strip, every @mention would look like a non-addressed message and
  // fall through triage → NO_REPLY (the bug observed on a specific host's
  // #Atmosphere group, 2026-04-27).
  const botUsername = bot.botInfo?.username;
  const wasMentioned = !!(ctx._isGroupChat && botUsername && new RegExp(`@${botUsername}\\b`, 'i').test(text));

  if (ctx._isGroupChat && botUsername) {
    text = text.replace(new RegExp(`@${botUsername}\\b`, 'gi'), '').trim();
    if (!text) return;
  }

  let directlyAddressed = false;
  if (ctx._isGroupChat) {
    const senderName = ctx.from?.first_name || ctx.from?.username || 'Unknown';
    const senderUsername = ctx.from?.username ? `@${ctx.from.username}` : '';
    const isRepliedTo = ctx.message?.reply_to_message?.from?.id === bot.botInfo?.id;
    directlyAddressed = wasMentioned || isRepliedTo;

    text = `[Group: "${ctx.chat.title}" | From: ${senderName}${senderUsername ? ` (${senderUsername})` : ''}${directlyAddressed ? ' | Addressed to you' : ''}]\n${text}`;

    // ⚠ The emoji-style guidance previously appended here leaked into the
    // user's saved content (Timeline showed "marco\n\n[Use emojis freely…]"
    // as user-visible text — a prompt fragment masquerading as user input).
    // Style instructions belong in the SYSTEM PROMPT, never the user
    // message. Re-add via a prompt section if needed; do not append to
    // user text here.
    //
    // For unaddressed group messages we deliberately do NOT inject the
    // "respond with NO_REPLY if nothing valuable" guidance — the triage
    // call (which runs FIRST, before /chat) is the structural gate now.
  }

  // Same fix for DM: no instruction injection into user text. See above.

  // Privacy: log channel kind + redacted ids + length only.
  console.log(`[Telegram] Message in ${ctx._isGroupChat ? `group ${redactId(chatId, 'g-')}` : `dm ${redactId(ctx.from?.id, 'u-')}`}: ${redactText(text)}`);

  // Typing indicator gating:
  //   - DM or directly-addressed group: typing fires immediately (existing UX)
  //   - Unaddressed group: typing is deferred until triage decides REPLY
  //     (avoids the "Mya saw it and chose silence" side-channel leak in groups)
  const groupUnaddressed = ctx._isGroupChat && !directlyAddressed;
  if (!groupUnaddressed) {
    ctx.replyWithChatAction('typing').catch(() => {});
  }

  let buf = textBuffers.get(chatId);
  if (!buf) {
    buf = {
      parts: [],
      replyContext: getReplyContext(ctx) || '',
      lastCtx: ctx,
      timer: null,
      isGroupChat: !!ctx._isGroupChat,
      directlyAddressed,
      // Typing keepalive only for paths where typing has fired. For
      // unaddressed groups, the keepalive starts in handleCoalescedText
      // after triage decides REPLY.
      typingInterval: groupUnaddressed ? null : setInterval(() => {
        ctx.replyWithChatAction('typing').catch(() => {});
      }, 4000),
    };
    textBuffers.set(chatId, buf);
  }
  buf.parts.push(text);
  buf.lastCtx = ctx;
  // If ANY fragment in the burst was directly addressed, treat the whole
  // burst as addressed — skip triage and reply with typing on.
  if (directlyAddressed) buf.directlyAddressed = true;

  // Reset debounce timer on every new fragment
  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(() => flushTextBuffer(chatId), TEXT_DEBOUNCE_MS);
});

// ── Attachment Helper ─────────────────────────────────────────────────────
// Uses lib/attachments.js to process files: R2 storage, AI description,
// transcription, PDF extraction — same pipeline as Discord.

async function handleTelegramFile(ctx, fileId, filename, mimeType, fileSize, caption, isVoice = false) {
  // Flush any pending text buffer first so ordering is preserved and the
  // attachment isn't accidentally swallowed into a text coalesce window.
  flushTextBuffer(ctx.chat.id);

  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction('typing').catch(() => {});
  }, 4000);

  try {
    const file = await ctx.api.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;

    // Use the attachments library (R2 storage + AI processing)
    const userId = await getUserId();
    const result = await processAttachment(
      { name: filename, url: fileUrl, size: fileSize, contentType: mimeType },
      userId,
    );

    // PR 5.10: capture per-upload sender + channel attribution. Owner
    // detection via OWNER_TELEGRAM_ID env (set per agent at boot). When
    // the env is unset (older deploys) we conservatively treat the
    // sender as the owner — preserves legacy "You" UI label rather than
    // showing a stranger token. The senderId/name + channel info land
    // in attachments.metadata + documents.metadata (encrypted) so the
    // library can render real names for non-owner uploads.
    const senderTgId  = ctx.from?.id != null ? String(ctx.from.id) : null;
    const senderName  = ctx.from?.first_name
      ? (ctx.from.last_name ? `${ctx.from.first_name} ${ctx.from.last_name}` : ctx.from.first_name)
      : (ctx.from?.username || null);
    // V6: identity_channels source of truth (env-var bootstrap fallback).
    // The legacy "fall back to true when env unset" behavior is replaced by
    // a positive operator check; if neither DB nor env confirm operator,
    // treat sender as non-owner (correct attribution for non-owner uploads).
    const isOwner     = senderTgId
      ? await isOperatorTelegram(tryGetDb(), senderTgId)
      : false;
    const chatId      = ctx.chat?.id != null ? String(ctx.chat.id) : null;
    const chatTitle   = ctx.chat?.title || null;
    const chatKind    = ctx.chat?.type || null;   // 'private' | 'group' | 'supergroup' | 'channel'

    // Create attachment record in DB. Awaited (was fire-and-forget) so
    // we can pass the attachmentId through to /chat and link the user
    // message that's about to be stored — without that link the portal
    // chat surface has no way to render the actual image, just the
    // bracket placeholder text the agent saw in its prompt.
    let attachmentId = null;
    if (result.r2Key || result.streamInfo) {
      try {
        // createAttachmentRecord returns the inserted row's id (string),
        // not an object — see packages/core/attachments.js line 859.
        attachmentId = await createAttachmentRecord(null, {
          userId,
          type: result.type,
          filename,
          mimeType,
          size: fileSize,
          r2Key: result.r2Key,
          streamInfo: result.streamInfo,
          description: result.description,
          transcript: result.transcript,
          discordMetadata: { source: 'telegram' },
          // PR 5.10 attribution
          platform: 'telegram',
          senderId: senderTgId,
          senderName,
          isOwner,
          channelId: chatId,
          channelTitle: chatTitle,
          channelKind: chatKind,
        });
      } catch (err) {
        console.error('[Telegram] Attachment record failed:', err.message);
      }
    }

    // Build message for the agent (include reply context if replying to a message)
    const replyContext = getReplyContext(ctx);
    let messageText = replyContext + (result.content || `[File: ${filename}]`);
    if (caption) messageText += `\n\nCaption: ${caption}`;

    // Explicit-send architecture: chatWithAgent always returns null. The
    // agent's reply, if any, was delivered by its own curl to
    // /telegram/send during the run (with `voice: true` if the user
    // sent voice and the agent decided to reply with voice).
    await chatWithAgent(messageText, ctx.from.id, {
      messageId: ctx.message?.message_id,
      inboundChatId: ctx.chat?.id,
      inboundMessageId: ctx.chat?.type !== 'private' ? ctx.message?.message_id : undefined,
      voiceMode: !!isVoice,
      attachmentId,
      username: ctx.from?.first_name
        ? (ctx.from.last_name ? `${ctx.from.first_name} ${ctx.from.last_name}` : ctx.from.first_name)
        : (ctx.from?.username || `tg:${ctx.from?.id || 'unknown'}`),
      channel: ctx.chat?.type === 'private' ? 'telegram-dm' : (ctx.chat?.title || `telegram-${ctx.chat?.id}`),
    });
    clearInterval(typingInterval);
  } catch (err) {
    clearInterval(typingInterval);
    console.error(`[Telegram] File handling failed (${filename}):`, err.message);
    captureError(err, { agentId: 'mya-telegram', taskType: 'file', filename });
    if (shouldEmitErrorReply(ctx.chat?.id)) {
      await ctx.reply(`Error processing file: ${err.message}`).catch(() => {});
    }
  }
}

// Handle photos
bot.on('message:photo', async (ctx) => {
  await ctx.replyWithChatAction('typing');
  const caption = ctx.message.caption || 'Image shared';
  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  const ext = '.jpg';
  await handleTelegramFile(ctx, photo.file_id, `photo_${Date.now()}${ext}`, 'image/jpeg', photo.file_size || 0, caption);
});

// Handle documents
bot.on('message:document', async (ctx) => {
  await ctx.replyWithChatAction('typing');
  const doc = ctx.message.document;
  const caption = ctx.message.caption || '';
  await handleTelegramFile(ctx, doc.file_id, doc.file_name || 'document', doc.mime_type || 'application/octet-stream', doc.file_size || 0, caption);
});

// Handle voice messages — reply with both text and voice
bot.on('message:voice', async (ctx) => {
  await ctx.replyWithChatAction('typing');
  const voice = ctx.message.voice;
  await handleTelegramFile(ctx, voice.file_id, `voice_${Date.now()}.ogg`, 'audio/ogg', voice.file_size || 0, '', true);
});

// Handle audio files (mp3, m4a, etc. sent as audio — distinct from voice notes)
bot.on('message:audio', async (ctx) => {
  console.log(`[Telegram] Audio file received: ${ctx.message.audio?.file_name} (${ctx.message.audio?.file_size} bytes)`);
  await ctx.replyWithChatAction('typing');
  const audio = ctx.message.audio;
  const ext = audio.file_name ? audio.file_name.slice(audio.file_name.lastIndexOf('.')) : '.ogg';
  const filename = audio.file_name || `audio_${Date.now()}${ext}`;
  const mime = audio.mime_type || 'audio/mpeg';
  await handleTelegramFile(ctx, audio.file_id, filename, mime, audio.file_size || 0, '', true);
});

// Catch-all: log unhandled message types for debugging
bot.on('message', async (ctx) => {
  const msg = ctx.message;
  const types = ['text', 'photo', 'document', 'voice', 'audio', 'video', 'sticker', 'animation', 'video_note'];
  const detected = types.filter(t => msg[t]);
  console.log(`[Telegram] Unhandled message type: ${detected.join(', ') || 'unknown'} | keys: ${Object.keys(msg).filter(k => !['message_id','from','chat','date'].includes(k)).join(', ')}`);
});

// ── HTTP API for Proactive Messaging ────────────────────────────────────────

const app = express();
app.use(express.json());

// Auth middleware — require x-worker-secret for all HTTP API endpoints
function requireSecret(req, res, next) {
  const remoteIp = req.socket?.remoteAddress;
  const isLocal = remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1';
  if (!isLocal && WORKER_SECRET) {
    const secret = req.headers['x-worker-secret'];
    // Timing-safe comparison to prevent token brute-force via timing analysis
    if (!secret || !timingSafeCompare(secret, WORKER_SECRET)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }
  next();
}

function timingSafeCompare(a, b) {
  if (!a || !b) return false;
  const aBuf = Buffer.from(String(a));
  const bBuf = Buffer.from(String(b));
  if (aBuf.length !== bBuf.length) {
    crypto.timingSafeEqual(aBuf, aBuf); // constant-time even on length mismatch
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

// Send message — caller MUST specify chatId. (A.25 fail-closed: previous
// `chatId || OWNER_ID` fallback silently routed agent replies to the
// operator's DM whenever chatId was omitted, leaking cross-channel.)
//
// Voice: when `voice: true` is set, after sending text we also synthesize
// the same text via @mycelium/core/tts and upload one voice message per
// TTS chunk. This is the egress chokepoint promised by the comment at
// line 85 — without it, the natural-text fallback path (which posts to
// THIS endpoint when the agent doesn't have Bash perm to curl its own
// agent-server route) silently drops the voice flag and voice-in →
// voice-out never happens. The agent-server's /telegram/send in
// packages/server/routes/bots.js mirrors this same pattern.
//
// TTS failure must NOT break the text send: text already succeeded
// above; just log + continue.
app.post('/telegram/send', requireSecret, async (req, res) => {
  const { chatId, text, voice, replyToMessageId } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  if (!chatId) {
    return res.status(400).json({
      error: 'chatId required',
      hint: 'Server does not fall back to OWNER_ID. Pass chatId explicitly. Group chat IDs start with "-".',
    });
  }
  const targetChat = chatId;

  // Privacy: redact target id + content. Chat kind inferred from id prefix.
  const targetKind = String(targetChat).startsWith('-') ? 'g' : 'u';
  console.log(`[Telegram HTTP] Sending to ${redactId(targetChat, `${targetKind}-`)}: ${redactText(text)}${voice ? ' [voice]' : ''}`);

  try {
    await sendMessage(bot, targetChat, text);
  } catch (err) {
    console.error('[Telegram HTTP] Send failed:', err.message);
    return res.status(500).json({ error: err.message });
  }

  let voiceSent = 0;
  let voiceTotal = 0;
  if (voice) {
    try {
      const tts = await import('@mycelium/core/tts/index.js');
      if (tts.isEnabled()) {
        const { readFile } = await import('fs/promises');
        for await (const chunk of tts.synthesizeForTelegram(text, { agentId: process.env.AGENT_ID })) {
          voiceTotal = chunk.total;
          if (!chunk.ok) {
            console.warn(`[Telegram HTTP] TTS chunk ${chunk.index + 1}/${chunk.total} failed (${chunk.code}): ${chunk.error}`);
            continue;
          }
          try {
            const audioBuf = await readFile(chunk.path);
            const opts = {};
            if (replyToMessageId != null) opts.reply_to_message_id = replyToMessageId;
            await bot.api.sendVoice(targetChat, new InputFile(audioBuf, 'voice.ogg'), opts);
            voiceSent++;
            console.log(`[Telegram HTTP] Voice ${chunk.index + 1}/${chunk.total} sent to ${redactId(targetChat, `${targetKind}-`)} (${(chunk.size / 1024).toFixed(0)}KB)`);
          } catch (uploadErr) {
            console.error(`[Telegram HTTP] Voice upload failed for chunk ${chunk.index + 1}/${chunk.total}: ${uploadErr.message}`);
          } finally {
            await chunk.cleanup();
          }
        }
      } else {
        console.log(`[Telegram HTTP] Voice requested but TTS not configured — skipping voice (text already sent)`);
      }
    } catch (ttsErr) {
      console.error('[Telegram HTTP] TTS pipeline error:', ttsErr.message);
    }
  }

  res.json({ ok: true, ...(voice ? { voiceSent, voiceTotal } : {}) });
});

// Send a file — caller MUST specify chatId. Same A.25 fail-closed rationale.
app.post('/telegram/send-file', requireSecret, async (req, res) => {
  const { chatId, filePath, base64, filename, caption } = req.body;
  if (!chatId) {
    return res.status(400).json({
      error: 'chatId required',
      hint: 'Server does not fall back to OWNER_ID. Pass chatId explicitly.',
    });
  }
  const targetChat = chatId;

  if (!filePath && !base64) {
    return res.status(400).json({ error: 'filePath or base64 required' });
  }

  try {
    let document;
    let name;

    if (filePath) {
      const info = await stat(filePath);
      if (info.size > 50 * 1024 * 1024) {
        return res.status(413).json({ error: 'File exceeds 50MB Telegram limit' });
      }
      const data = await readFile(filePath);
      name = filename || pathModule.basename(filePath);
      document = new InputFile(data, name);
    } else {
      const data = Buffer.from(base64, 'base64');
      if (data.length > 50 * 1024 * 1024) {
        return res.status(413).json({ error: 'File exceeds 50MB Telegram limit' });
      }
      name = filename || 'document';
      document = new InputFile(data, name);
    }

    await bot.api.sendDocument(targetChat, document, {
      caption: caption || '',
    });

    console.log(`[Telegram HTTP] File sent: ${name}`);
    res.json({ ok: true, filename: name });
  } catch (err) {
    console.error('[Telegram HTTP] Send file failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ ok: true, bot: 'telegram', owner: OWNER_ID });
});

// Force refresh of bootstrap-secrets so a portal-side credential save
// (e.g. user pastes a new OPENAI_API_KEY) propagates into THIS bot's
// process.env immediately rather than waiting for the 5-min auto-refresh
// cron at line 1385. Loopback-only by default (requireSecret) — same VPS,
// from agent-server.js's portal handler.
app.post('/refresh-secrets', requireSecret, async (req, res) => {
  try {
    await refreshSecrets({ force: true });
    res.json({ ok: true });
  } catch (err) {
    console.error('[Telegram HTTP] /refresh-secrets failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Start ───────────────────────────────────────────────────────────────────

app.listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`[Telegram] HTTP API listening on 127.0.0.1:${HTTP_PORT}`);
});

// Start bot with graceful 409 conflict handling.
// When Telegram reports 409 (another getUpdates session active), it needs ~15-30s
// to release the old polling slot after the previous instance exits. We retry
// in-process with backoff instead of exiting, so PM2 doesn't crash-loop.
async function startBot() {
  const MAX_409_ATTEMPTS = 6;
  const BACKOFFS_MS = [5000, 10000, 15000, 20000, 30000, 60000];

  for (let attempt = 0; attempt < MAX_409_ATTEMPTS; attempt++) {
    try {
      // Explicitly clear any webhook to ensure polling mode
      try {
        const delResult = await bot.api.deleteWebhook({ drop_pending_updates: false });
        console.log(`[Telegram] deleteWebhook result: ${delResult}`);
        const whInfo = await bot.api.getWebhookInfo();
        console.log(`[Telegram] Webhook after delete: url="${whInfo.url || '(none)'}", pending=${whInfo.pending_update_count}`);
      } catch (e) {
        console.error(`[Telegram] deleteWebhook failed:`, e.message);
      }

      await bot.start({
        allowed_updates: ['message', 'my_chat_member'],
        onStart: (info) => {
          console.log(`[Telegram] Bot started: @${info.username} (owner: ${OWNER_ID})`);
          console.log(`[Telegram] Agent URL: ${AGENT_URL}`);
        },
      });
      return; // success
    } catch (err) {
      if (err?.error_code === 409) {
        const wait = BACKOFFS_MS[attempt] || 60000;
        console.warn(`[Telegram] 409 Conflict (attempt ${attempt + 1}/${MAX_409_ATTEMPTS}). Waiting ${wait / 1000}s for Telegram to release polling slot...`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      console.error(`[Telegram] Bot start failed:`, err);
      releaseLock();
      process.exit(1);
    }
  }

  console.error(`[Telegram] Failed to start after ${MAX_409_ATTEMPTS} attempts. Exiting cleanly.`);
  releaseLock();
  process.exit(0); // exit 0 so PM2 backs off via restart_delay
}

bot.catch((err) => {
  const e = err.error || err;
  if (e?.error_code === 409) {
    console.warn(`[Telegram] 409 Conflict during polling — likely transient. Bot will reconnect.`);
  } else {
    console.error(`[Telegram] Bot error:`, e?.message || e);
  }
});

startBot();

// Periodic secret refresh (5 min)
setInterval(refreshSecrets, 5 * 60 * 1000);

// Graceful shutdown — stop polling, wait for Telegram to release the slot, then exit.
// Without the wait, the next instance hits 409 Conflict because Telegram still
// considers the old long-poll connection active for ~30s.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Telegram] Received ${signal}, shutting down...`);
  for (const chatId of Array.from(textBuffers.keys())) {
    try { flushTextBuffer(chatId); } catch {}
  }
  signalAttachmentShutdown();
  releaseLock();
  bot.stop()
    .catch(() => {})
    .finally(() => {
      console.log('[Telegram] Polling stopped. Waiting 5s for Telegram to release slot...');
      setTimeout(() => process.exit(0), 5000);
    });
  setTimeout(() => process.exit(0), 15000);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', () => releaseLock());
process.on('uncaughtException', (err) => {
  console.error(`[Telegram] Uncaught exception:`, err);
  releaseLock();
  process.exit(1);
});
