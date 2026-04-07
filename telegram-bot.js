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

import './lib/sentry.js';
import 'dotenv/config';
import { bootstrapSecrets, refreshSecrets } from './lib/bootstrap-secrets.js';
import crypto from 'crypto';
import http from 'http';
import { Bot, InputFile } from 'grammy';
import express from 'express';
import { processAttachment, createAttachmentRecord } from './lib/attachments.js';
import { initDb } from './lib/db.js';
import { captureError } from './lib/error-classifier.js';
import { readFile, stat } from 'fs/promises';
import pathModule from 'path';

// Bootstrap secrets from D1 API before reading config
await bootstrapSecrets();

// ── Config ──────────────────────────────────────────────────────────────────

// Support agent-specific bot token override (e.g. TELEGRAM_BOT_TOKEN_MOM for moms-telegram-bot)
const TOKEN = process.env.TELEGRAM_BOT_TOKEN_OVERRIDE || process.env.TELEGRAM_BOT_TOKEN;
const OWNER_ID = process.env.OWNER_TELEGRAM_ID;
const AGENT_URL = process.env.AGENT_URL || 'http://localhost:3004';
const HTTP_PORT = parseInt(process.env.TELEGRAM_BOT_PORT || '3003');
const USER_ID = process.env.USER_ID;

// TTS config (for voice message replies)
const WORKER_URL = process.env.WORKER_URL || process.env.MYA_WORKER_URL;
const WORKER_SECRET = process.env.WORKER_SECRET || process.env.MYA_WORKER_SECRET;
const TTS_ENABLED = WORKER_URL && WORKER_SECRET;
const TTS_VOICE = process.env.TTS_VOICE || 'onyx'; // OpenAI voices: alloy, ash, coral, echo, fable, nova, onyx, sage, shimmer
const TTS_MAX_CHARS = 50000; // Max text length for TTS (generous limit, chunked at 4096)

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
initDb().catch(err => console.error('[Telegram] DB init failed:', err.message));

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
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const suffix = i < chunks.length - 1 ? '\n\n...' : '';
    const msg = chunk + suffix;

    try {
      await ctx.reply(escapeMarkdown(msg), { parse_mode: 'Markdown' });
    } catch {
      try {
        await ctx.reply(msg);
      } catch (err) {
        console.error('Reply failed:', err.message);
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
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const suffix = i < chunks.length - 1 ? '\n\n...' : '';
    const msg = chunk + suffix;

    try {
      await bot.api.sendMessage(chatId, escapeMarkdown(msg), { parse_mode: 'Markdown' });
    } catch {
      try {
        await bot.api.sendMessage(chatId, msg);
      } catch (err) {
        console.error('sendMessage failed:', err.message);
      }
    }

    if (i < chunks.length - 1) {
      await new Promise(r => setTimeout(r, 100));
    }
  }
}

// ── Agent-Server Communication ──────────────────────────────────────────────

const MAX_RETRIES = 5;
const RETRY_BASE_MS = 5000;
const RETRY_MAX_MS = 120_000;

// Error types that should NOT be retried
const NON_RETRYABLE_STATUSES = new Set([401, 402, 403, 422]);

async function chatWithAgent(message, telegramUserId) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      // Auth: prefer agent token, fall back to worker secret (both bypass CSRF)
      const botAgentToken = process.env.AGENT_TOKEN || process.env.WORKER_SECRET || process.env.MYA_WORKER_SECRET;
      if (botAgentToken) headers['Authorization'] = `Bearer ${botAgentToken}`;

      const response = await longFetch(`${AGENT_URL}/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          message,
          channelId: `telegram_${telegramUserId}`,
          userId: USER_ID,
          source: 'telegram',
        }),
        timeout: 65 * 60 * 1000, // 65 minutes — Claude can run up to 60 min
      });

      if (!response.ok) {
        const text = await response.text();
        if (NON_RETRYABLE_STATUSES.has(response.status)) {
          throw new Error(`Agent returned ${response.status}: ${text.slice(0, 200)}`);
        }
        throw Object.assign(new Error(`Agent returned ${response.status}: ${text.slice(0, 200)}`), { retryable: true });
      }

      const data = await response.json();

      // NO_REPLY: agent decided not to respond (silent processing)
      if (data.noReply) {
        return null; // Signal to caller: don't send a message
      }

      return data.response || data.result || data.message || 'No response from agent.';
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

const TTS_CHUNK_SIZE = 4096; // OpenAI per-request character limit

/**
 * Split text into chunks at sentence boundaries for TTS.
 * Each chunk stays within OpenAI's 4096 char limit.
 */
function splitTextForTTS(text, maxLen = TTS_CHUNK_SIZE) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) { chunks.push(remaining); break; }
    let breakAt = -1;
    for (const sep of ['. ', '! ', '? ', '.\n', '!\n', '?\n']) {
      const idx = remaining.lastIndexOf(sep, maxLen);
      if (idx > maxLen * 0.3 && idx > breakAt) breakAt = idx + sep.length;
    }
    if (breakAt <= 0) breakAt = remaining.lastIndexOf(' ', maxLen);
    if (breakAt <= 0) breakAt = maxLen;
    chunks.push(remaining.substring(0, breakAt).trim());
    remaining = remaining.substring(breakAt).trim();
  }
  return chunks.filter(c => c.length > 0);
}

/**
 * Call Worker TTS for a single text chunk, return Buffer of OGG/Opus audio.
 */
async function callTTS(text) {
  const resp = await fetch(`${WORKER_URL}/api/tts`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WORKER_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text, speaker: TTS_VOICE }),
    signal: AbortSignal.timeout(120000),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`TTS ${resp.status}: ${errText.slice(0, 200)}`);
  }
  return Buffer.from(await resp.arrayBuffer());
}

/**
 * Strip markdown formatting for cleaner speech synthesis.
 */
function stripMarkdownForTTS(text) {
  return text
    .replace(/```[\s\S]*?```/g, '')          // Remove code blocks
    .replace(/`[^`]+`/g, '')                 // Remove inline code
    .replace(/^\s*[-*+] \[[ x]\]\s*/gm, '')  // Remove task list markers
    .replace(/^\s*#{1,6}\s+/gm, '')          // Remove heading markers (line-anchored)
    .replace(/^\s*>\s?/gm, '')               // Remove blockquote markers
    .replace(/^\s*[-*_]{3,}\s*$/gm, '')      // Remove horizontal rules
    .replace(/\*{3}([^*]+)\*{3}/g, '$1')     // ***bold italic*** → plain
    .replace(/\*{2}([^*]+)\*{2}/g, '$1')     // **bold** → plain
    .replace(/\*([^*]+)\*/g, '$1')           // *italic* → plain
    .replace(/__([^_]+)__/g, '$1')           // __bold__ → plain
    .replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1') // _italic_ → plain
    .replace(/~~([^~]+)~~/g, '$1')           // ~~strikethrough~~ → plain
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [links](url) → text only
    .replace(/^\s*[-*+]\s+/gm, '')           // Remove bullet list markers
    .replace(/^\s*\d+\.\s+/gm, '')           // Remove numbered list markers
    .replace(/[*_`#~]/g, '')                 // Remove any remaining formatting chars
    .replace(/\n{3,}/g, '\n\n')              // Collapse excessive newlines
    .trim();
}

/**
 * Validate OGG/Opus audio buffer — checks magic bytes and minimum size.
 */
function isValidOggAudio(buf) {
  return buf && buf.length >= 1000 &&
    buf[0] === 0x4F && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53;
}

/**
 * Generate TTS and send voice reply as one or more voice messages.
 * Sends each chunk individually — no fragile ffmpeg concatenation.
 */
async function sendVoiceReply(ctx, text) {
  if (!TTS_ENABLED) return;

  const cleanText = stripMarkdownForTTS(text);
  if (!cleanText || cleanText.length < 20) {
    console.log(`[TTS] Text too short after cleanup (${cleanText?.length || 0} chars) — skipping`);
    return;
  }

  const ttsText = cleanText.substring(0, TTS_MAX_CHARS);
  const chunks = splitTextForTTS(ttsText);
  console.log(`[TTS] Generating voice for ${ttsText.length} chars (${chunks.length} chunk${chunks.length > 1 ? 's' : ''})...`);

  const voiceInterval = setInterval(() => {
    ctx.replyWithChatAction('record_voice').catch(() => {});
  }, 4000);

  try {
    await ctx.replyWithChatAction('record_voice');

    let sentCount = 0;
    for (let i = 0; i < chunks.length; i++) {
      try {
        const audio = await callTTS(chunks[i]);

        if (!isValidOggAudio(audio)) {
          console.error(`[TTS] Chunk ${i + 1}/${chunks.length} invalid (${audio?.length || 0} bytes, header: ${audio?.slice(0, 4)?.toString('hex') || 'none'})`);
          continue;
        }

        await ctx.replyWithVoice(new InputFile(audio, 'voice.ogg'));
        sentCount++;
        console.log(`[TTS] Voice ${i + 1}/${chunks.length} sent (${(audio.length / 1024).toFixed(0)}KB)`);
      } catch (chunkErr) {
        console.error(`[TTS] Chunk ${i + 1}/${chunks.length} failed:`, chunkErr.message);
        captureError(chunkErr, { agentId: 'mya-telegram', taskType: 'tts', chunk: i + 1, total: chunks.length });
      }
    }

    if (sentCount === 0 && chunks.length > 0) {
      console.error('[TTS] All chunks failed — no voice sent');
    }
  } catch (err) {
    console.error('[TTS] Voice reply error:', err.message);
    captureError(err, { agentId: 'mya-telegram', taskType: 'tts' });
  } finally {
    clearInterval(voiceInterval);
  }
}

// ── Grammy Bot Setup ────────────────────────────────────────────────────────

const bot = new Bot(TOKEN);

// Only respond to the owner
bot.use(async (ctx, next) => {
  if (ctx.from?.id.toString() !== OWNER_ID) {
    console.log(`[Telegram] Ignoring message from non-owner: ${ctx.from?.id}`);
    return;
  }
  await next();
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

// Handle text messages
bot.on('message:text', async (ctx) => {
  const text = ctx.message.text;
  console.log(`[Telegram] Message from owner: ${text.slice(0, 100)}${text.length > 100 ? '...' : ''}`);

  // Show typing indicator
  await ctx.replyWithChatAction('typing');

  // Keep typing indicator alive during processing (every 4s)
  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction('typing').catch(() => {});
  }, 4000);

  try {
    const replyContext = getReplyContext(ctx);
    const response = await chatWithAgent(replyContext + text, ctx.from.id);
    clearInterval(typingInterval);
    if (response !== null) {
      await sendReply(ctx, response);
    } else {
      console.log('[Telegram] Agent chose NO_REPLY — silent processing');
    }
  } catch (err) {
    clearInterval(typingInterval);
    console.error('[Telegram] Agent chat failed:', err.message);
    captureError(err, { agentId: 'mya-telegram', taskType: 'chat' });
    await ctx.reply(`Something went wrong, but your message was received. I'll follow up when I can.`).catch(() => {});
  }
});

// ── Attachment Helper ─────────────────────────────────────────────────────
// Uses lib/attachments.js to process files: R2 storage, AI description,
// transcription, PDF extraction — same pipeline as Discord.

async function handleTelegramFile(ctx, fileId, filename, mimeType, fileSize, caption, isVoice = false) {
  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction('typing').catch(() => {});
  }, 4000);

  try {
    const file = await ctx.api.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;

    // Use the attachments library (R2 storage + AI processing)
    const result = await processAttachment(
      { name: filename, url: fileUrl, size: fileSize, contentType: mimeType },
      USER_ID,
    );

    // Create attachment record in DB
    if (result.r2Key || result.streamInfo) {
      createAttachmentRecord(null, {
        userId: USER_ID,
        type: result.type,
        filename,
        mimeType,
        size: fileSize,
        r2Key: result.r2Key,
        streamInfo: result.streamInfo,
        description: result.description,
        transcript: result.transcript,
        discordMetadata: { source: 'telegram' },
      }).catch(err => console.error('[Telegram] Attachment record failed:', err.message));
    }

    // Build message for the agent (include reply context if replying to a message)
    const replyContext = getReplyContext(ctx);
    let messageText = replyContext + (result.content || `[File: ${filename}]`);
    if (caption) messageText += `\n\nCaption: ${caption}`;

    const response = await chatWithAgent(messageText, ctx.from.id);
    clearInterval(typingInterval);
    if (response !== null) {
      // Always send text reply first
      await sendReply(ctx, response);

      // For voice messages, also generate and send a voice reply
      if (isVoice && TTS_ENABLED && response.length > 0) {
        await sendVoiceReply(ctx, response);
      }
    } else {
      console.log('[Telegram] Agent chose NO_REPLY for file — silent processing');
    }
  } catch (err) {
    clearInterval(typingInterval);
    console.error(`[Telegram] File handling failed (${filename}):`, err.message);
    captureError(err, { agentId: 'mya-telegram', taskType: 'file', filename });
    await ctx.reply(`Error processing file: ${err.message}`).catch(() => {});
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

// Send message to owner (used by scheduler and agent-server)
app.post('/telegram/send', requireSecret, async (req, res) => {
  const { chatId, text } = req.body;
  const targetChat = chatId || OWNER_ID;

  if (!text) return res.status(400).json({ error: 'text required' });

  console.log(`[Telegram HTTP] Sending: "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}" (${text.length} chars)`);

  try {
    await sendMessage(bot, targetChat, text);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Telegram HTTP] Send failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Send a file to the owner (used by agent-server for document delivery)
app.post('/telegram/send-file', requireSecret, async (req, res) => {
  const { chatId, filePath, base64, filename, caption } = req.body;
  const targetChat = chatId || OWNER_ID;

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
      try { await bot.api.deleteWebhook({ drop_pending_updates: false }); } catch {}

      await bot.start({
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

// Graceful shutdown
function shutdown(signal) {
  console.log(`[Telegram] Received ${signal}, shutting down...`);
  releaseLock();
  bot.stop().then(() => process.exit(0)).catch(() => process.exit(0));
  // Force exit after 5s if graceful shutdown hangs
  setTimeout(() => process.exit(0), 5000);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', () => releaseLock());
process.on('uncaughtException', (err) => {
  console.error(`[Telegram] Uncaught exception:`, err);
  releaseLock();
  process.exit(1);
});
