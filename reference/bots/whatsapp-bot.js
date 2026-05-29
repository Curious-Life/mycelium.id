#!/usr/bin/env node
/**
 * WhatsApp Bot Adapter for Mya
 *
 * Baileys WebSocket client that bridges WhatsApp messages to the agent-server.
 * Runs as a separate PM2 process.
 *
 * Flow:
 *   WhatsApp Web → Baileys → POST /chat on agent-server → response → WhatsApp
 *
 * Resilience:
 *   - longFetch bypasses Node.js undici 5-min hardcoded timeout (supports 65 min)
 *   - Retry with exponential backoff (5 retries)
 *   - Auto-reconnect on disconnect (1s→30s backoff)
 *   - Message debouncing (500ms window batches rapid messages)
 *
 * HTTP API for proactive messaging:
 *   POST /whatsapp/send { jid?, number?, text } — Send text message
 *   POST /whatsapp/send-file { jid?, number?, base64, filename, caption, mimeType } — Send file
 *
 * Config (env vars):
 *   WHATSAPP_ALLOWED_NUMBERS  — Comma-separated phone numbers without + (required)
 *   AGENT_URL                 — Agent-server URL (default: http://localhost:3004)
 *   WHATSAPP_BOT_PORT         — HTTP API port (default: 5011)
 *   USER_ID                   — Supabase user UUID (for message routing)
 */

import '@mycelium/core/sentry.js';
import 'dotenv/config';
import { bootstrapSecrets, refreshSecrets } from '@mycelium/core/bootstrap-secrets.js';
import http from 'http';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { processAttachment, createAttachmentRecord } from '@mycelium/core/attachments.js';
import { initDb } from '@mycelium/core/db.js';
import { captureError } from '@mycelium/core/error-classifier.js';
// Explicit-send architecture (f1db18d) removed the data.response consumer
// in chatWithAgent below. isSilentReply was the client-side mirror of the
// server's NO_REPLY check on agent free-form text — no longer needed since
// the bot never reads agent text from /chat.
import { redactId, redactText } from '@mycelium/core/log-redact.js';

// Bootstrap secrets from D1 API before reading config
await bootstrapSecrets();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const AUTH_DIR = path.join(REPO_ROOT, '.whatsapp-auth');

// ── Config ──────────────────────────────────────────────────────────────────

const ALLOWED_NUMBERS_RAW = process.env.WHATSAPP_ALLOWED_NUMBERS || '';
const AGENT_URL = process.env.AGENT_URL || 'http://localhost:3004';
const HTTP_PORT = parseInt(process.env.WHATSAPP_BOT_PORT || '5011');
const USER_ID = process.env.USER_ID;

// Per-number routing: JSON map of phone number → agent URL
// Example: {"37120000000":"http://localhost:5014"}
// Numbers not in the map fall back to AGENT_URL
const WHATSAPP_ROUTES = (() => {
  try { return JSON.parse(process.env.WHATSAPP_ROUTES || '{}'); }
  catch { return {}; }
})();

function getAgentUrl(senderNumber) {
  return WHATSAPP_ROUTES[senderNumber] || AGENT_URL;
}

// Parse allowlist: strip non-numeric, dedupe
const ALLOWED_NUMBERS = new Set(
  ALLOWED_NUMBERS_RAW.split(',')
    .map(n => n.replace(/\D/g, ''))
    .filter(Boolean)
);

if (ALLOWED_NUMBERS.size === 0) {
  console.error('WHATSAPP_ALLOWED_NUMBERS is required (comma-separated phone numbers, no + prefix)');
  process.exit(1);
}

// Initialize database for attachment records
initDb().catch(err => console.error('[WhatsApp] DB init failed:', err.message));

console.log(`[WhatsApp] Allowed numbers: ${[...ALLOWED_NUMBERS].join(', ')}`);

// ── JID Utilities ───────────────────────────────────────────────────────────

function jidToNumber(jid) {
  if (!jid) return '';
  // Strip @s.whatsapp.net and any :deviceId suffix
  return jid.split('@')[0].split(':')[0];
}

function numberToJid(number) {
  const clean = number.replace(/\D/g, '');
  return `${clean}@s.whatsapp.net`;
}

function isAllowed(jid) {
  return ALLOWED_NUMBERS.has(jidToNumber(jid));
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

// ── WhatsApp Message Helpers ────────────────────────────────────────────────

const WHATSAPP_MAX_LENGTH = 4000; // WhatsApp limit is ~65536 but keep chunks readable

function splitMessage(text, maxLength = WHATSAPP_MAX_LENGTH) {
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

// ── Error reply dedupe ──────────────────────────────────────────────────
// Avoid spamming a chat with repeated "Something went wrong" replies when
// the agent-server fails in rapid succession (e.g. rate limit, billing).
const ERROR_REPLY_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes per jid
const _errorReplyLastSentByJid = new Map();
function shouldEmitErrorReply(jid) {
  const now = Date.now();
  const last = _errorReplyLastSentByJid.get(jid) || 0;
  if (now - last < ERROR_REPLY_COOLDOWN_MS) return false;
  _errorReplyLastSentByJid.set(jid, now);
  return true;
}

async function sendTextMessage(sock, jid, text) {
  const chunks = splitMessage(text);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const suffix = i < chunks.length - 1 ? '\n\n...' : '';
    await sock.sendMessage(jid, { text: chunk + suffix });
    if (i < chunks.length - 1) {
      await new Promise(r => setTimeout(r, 300)); // 300ms between chunks
    }
  }
}

// ── Agent-Server Communication ──────────────────────────────────────────────

const MAX_RETRIES = 5;
const RETRY_BASE_MS = 5000;
const RETRY_MAX_MS = 120_000;

// Error types that should NOT be retried
const NON_RETRYABLE_STATUSES = new Set([401, 402, 403, 422]);

/**
 * Hand the user's inbound message to the local agent's /chat endpoint.
 *
 * Explicit-send architecture (f1db18d invariant): /chat returns
 * scratchpad-only diagnostics — never agent text. The agent's reply,
 * if any, is delivered by the agent's explicit curl to /whatsapp/send
 * during its run. This function therefore ALWAYS returns null on
 * success; callers should not auto-deliver anything based on the
 * return value.
 *
 * `inboundChatId` (the canonical WhatsApp number) is passed so the
 * server-side prompt can pre-fill the agent's curl with the correct
 * recipient. `dedupeNonce` lets /chat short-circuit retries / re-
 * deliveries from Baileys with the same Baileys message ID.
 */
async function chatWithAgent(message, whatsappNumber, opts = {}) {
  const agentUrl = getAgentUrl(whatsappNumber);
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await longFetch(`${agentUrl}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          channelId: `whatsapp_${whatsappNumber}`,
          userId: USER_ID,
          source: 'whatsapp',
          inboundChatId: whatsappNumber,
          ...(opts.inboundMessageId ? { inboundMessageId: opts.inboundMessageId } : {}),
          ...(opts.dedupeNonce ? { dedupeNonce: opts.dedupeNonce } : {}),
        }),
        timeout: 65 * 60 * 1000, // 65 minutes
      });

      if (!response.ok) {
        const text = await response.text();
        if (NON_RETRYABLE_STATUSES.has(response.status)) {
          throw new Error(`Agent returned ${response.status}: ${text.slice(0, 200)}`);
        }
        throw Object.assign(new Error(`Agent returned ${response.status}: ${text.slice(0, 200)}`), { retryable: true });
      }

      // Drain the body for diagnostics-only logging. Do NOT read
      // data.response / data.result / data.message — under the
      // explicit-send architecture, those fields don't exist (and a
      // future server bug that resurrected them would create a leak
      // surface; the bot's job is transport, not authorship).
      const data = await response.json().catch(() => ({}));
      if (data.error) {
        console.error(`[WhatsApp] /chat returned error: ${data.error}`);
      }
      return null;
    } catch (err) {
      lastError = err;

      // Timeout: re-throw so the caller (processTextBatch /
      // handleMediaMessage) can decide whether to surface a system-
      // authored timeout reply via direct sock.sendMessage. Previously
      // this branch returned a user-facing string that the caller
      // auto-delivered; that auto-delivery is gone, so the timeout
      // path now goes through the catch block below.
      if (err.message?.includes('timeout')) {
        console.log(`[WhatsApp] Agent request timed out (attempt ${attempt + 1})`);
        throw err;
      }

      // Non-retryable error
      if (!err.retryable && !err.message?.includes('ECONNREFUSED') && !err.message?.includes('ECONNRESET')) {
        throw err;
      }

      // Retryable: exponential backoff
      if (attempt < MAX_RETRIES) {
        const delay = Math.min(RETRY_BASE_MS * Math.pow(2, attempt), RETRY_MAX_MS);
        console.log(`[WhatsApp] Retry ${attempt + 1}/${MAX_RETRIES} in ${delay / 1000}s: ${err.message}`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  throw lastError || new Error('All retries exhausted');
}

// ── Message Debouncing ──────────────────────────────────────────────────────
// WhatsApp users send rapid fragments. Batch them with a 500ms window.

const pendingMessages = new Map(); // jid → { texts: string[], timer, firstKey }

function debounceMessage(jid, text, messageKey, onBatch) {
  let pending = pendingMessages.get(jid);

  if (!pending) {
    pending = { texts: [], timer: null, firstKey: messageKey };
    pendingMessages.set(jid, pending);
  }

  pending.texts.push(text);

  // Reset the timer on each new message
  if (pending.timer) clearTimeout(pending.timer);

  pending.timer = setTimeout(() => {
    const batch = pendingMessages.get(jid);
    pendingMessages.delete(jid);
    if (batch) {
      onBatch(jid, batch.texts.join('\n'), batch.firstKey);
    }
  }, 500);
}

// ── Baileys Connection ──────────────────────────────────────────────────────

let sock = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30_000;

async function connectWhatsApp() {
  // Dynamic import — Baileys is CJS with ESM interop
  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = await import('@whiskeysockets/baileys');

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  // Suppress verbose Baileys logging, keep warn/error
  const logger = {
    level: 'warn',
    info: () => {},
    debug: () => {},
    trace: () => {},
    warn: (...args) => console.warn('[Baileys]', ...args),
    error: (...args) => console.error('[Baileys]', ...args),
    fatal: (...args) => console.error('[Baileys FATAL]', ...args),
    child: () => logger,
  };

  sock = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: true,
    // Browser identification
    browser: ['Mycelium', 'Chrome', '22.0'],
    // Mark messages as read automatically
    markOnlineOnConnect: true,
  });

  // Save credentials when updated
  sock.ev.on('creds.update', saveCreds);

  // ── Connection updates ──────────────────────────────────────────────

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('[WhatsApp] Scan the QR code above to authenticate');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason = lastDisconnect?.error?.message || 'unknown';

      console.log(`[WhatsApp] Connection closed: ${reason} (status: ${statusCode})`);

      // Don't reconnect if logged out (requires re-auth)
      if (statusCode === DisconnectReason.loggedOut) {
        console.error('[WhatsApp] Logged out. Delete .whatsapp-auth/ and restart to re-authenticate.');
        return;
      }

      // Auto-reconnect with backoff
      console.log(`[WhatsApp] Reconnecting in ${reconnectDelay / 1000}s...`);
      setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
        connectWhatsApp();
      }, reconnectDelay);
    }

    if (connection === 'open') {
      reconnectDelay = 1000; // Reset backoff on successful connection
      console.log(`[WhatsApp] Connected! Default agent: ${AGENT_URL}${Object.keys(WHATSAPP_ROUTES).length ? `, routes: ${JSON.stringify(WHATSAPP_ROUTES)}` : ''}`);
    }
  });

  // ── Message handler ─────────────────────────────────────────────────

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // Only process new messages, not history sync
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        await handleMessage(msg, sock, downloadMediaMessage);
      } catch (err) {
        console.error('[WhatsApp] Message handler error:', err.message);
        captureError(err, { agentId: 'mya-whatsapp', taskType: 'message-handler' });
      }
    }
  });
}

// ── Message Processing ──────────────────────────────────────────────────────

async function handleMessage(msg, sock, downloadMediaMessage) {
  const jid = msg.key.remoteJid;
  if (!jid) return;

  // Skip group messages
  if (jid.endsWith('@g.us')) return;

  // Skip status broadcasts
  if (jid === 'status@broadcast') return;

  // Skip reactions (no text content)
  if (msg.message?.reactionMessage) return;

  // Determine sender number
  const senderNumber = msg.key.fromMe ? jidToNumber(sock.user?.id) : jidToNumber(jid);

  // Allowlist check
  if (!ALLOWED_NUMBERS.has(senderNumber)) {
    return; // Silently ignore
  }

  // Unwrap ephemeral messages
  const message = msg.message?.ephemeralMessage?.message || msg.message;
  if (!message) return;

  // ── Media messages → immediate processing (bypass debounce) ───────
  const imageMessage = message.imageMessage;
  const audioMessage = message.audioMessage;
  const videoMessage = message.videoMessage;
  const documentMessage = message.documentMessage;

  if (imageMessage || audioMessage || videoMessage || documentMessage) {
    await handleMediaMessage(msg, jid, message, sock, downloadMediaMessage);
    return;
  }

  // ── Text messages → debounce ──────────────────────────────────────
  const text = message.conversation
    || message.extendedTextMessage?.text
    || '';

  if (!text) return;

  // Privacy: redact sender (PII) + content. ID-prefix lets ops correlate
  // the same user across log lines without naming them. CLAUDE.md §1.
  console.log(`[WhatsApp] Message from ${redactId(senderNumber, 'wa-')}: ${redactText(text)}`);

  debounceMessage(jid, text, msg.key, async (batchJid, batchText, firstKey) => {
    await processTextBatch(batchJid, batchText, firstKey, sock);
  });
}

// ── Text Batch Processing ───────────────────────────────────────────────────

async function processTextBatch(jid, text, firstKey, sock) {
  // React with 👀 to acknowledge
  try {
    await sock.sendMessage(jid, { react: { text: '👀', key: firstKey } });
  } catch {}

  // Typing indicator
  const typingInterval = setInterval(() => {
    sock.sendPresenceUpdate('composing', jid).catch(() => {});
  }, 4000);

  try {
    await sock.sendPresenceUpdate('composing', jid);
    const senderNumber = jidToNumber(jid);
    // Pass Baileys message id as inboundMessageId + dedupeNonce so /chat
    // can short-circuit re-deliveries and the prompt knows the exact
    // inbound event. Under explicit-send (f1db18d) chatWithAgent always
    // returns null on success; the agent's reply, if any, is delivered
    // via its own curl to /whatsapp/send during the run.
    await chatWithAgent(text, senderNumber, {
      inboundMessageId: firstKey?.id,
      dedupeNonce: firstKey?.id ? `wa:${firstKey.id}` : undefined,
    });

    clearInterval(typingInterval);
    await sock.sendPresenceUpdate('paused', jid);

    // Clear reaction (👀 → cleared) — same UX whether the agent replied
    // or chose NO_REPLY. The bot is pure transport; we can't observe
    // the agent's internal decision from here.
    try {
      await sock.sendMessage(jid, { react: { text: '', key: firstKey } });
    } catch {}
  } catch (err) {
    clearInterval(typingInterval);
    await sock.sendPresenceUpdate('paused', jid).catch(() => {});
    console.error('[WhatsApp] Agent chat failed:', err.message);
    captureError(err, { agentId: 'mya-whatsapp', taskType: 'chat' });

    try {
      if (shouldEmitErrorReply(jid)) {
        // System-authored error reply (not agent text) — direct sock.send
        // so it bypasses the egress chokepoint. Acceptable: this is the
        // bot itself acknowledging the failure, not the agent speaking.
        await sock.sendMessage(jid, { text: 'Something went wrong, but your message was received. I\'ll follow up when I can.' });
      }
      await sock.sendMessage(jid, { react: { text: '', key: firstKey } });
    } catch {}
  }
}

// ── Media Message Handling ──────────────────────────────────────────────────

async function handleMediaMessage(msg, jid, message, sock, downloadMediaMessage) {
  const senderNumber = jidToNumber(jid);
  const imageMessage = message.imageMessage;
  const audioMessage = message.audioMessage;
  const videoMessage = message.videoMessage;
  const documentMessage = message.documentMessage;

  let filename, mimeType, fileSize, caption;

  if (imageMessage) {
    filename = `photo_${Date.now()}.jpg`;
    mimeType = imageMessage.mimetype || 'image/jpeg';
    fileSize = imageMessage.fileLength || 0;
    caption = imageMessage.caption || '';
  } else if (audioMessage) {
    const isVoice = audioMessage.ptt; // push-to-talk = voice note
    filename = isVoice ? `voice_${Date.now()}.ogg` : `audio_${Date.now()}.ogg`;
    mimeType = audioMessage.mimetype || 'audio/ogg';
    fileSize = audioMessage.fileLength || 0;
    caption = '';
  } else if (videoMessage) {
    filename = `video_${Date.now()}.mp4`;
    mimeType = videoMessage.mimetype || 'video/mp4';
    fileSize = videoMessage.fileLength || 0;
    caption = videoMessage.caption || '';
  } else if (documentMessage) {
    filename = documentMessage.fileName || `document_${Date.now()}`;
    mimeType = documentMessage.mimetype || 'application/octet-stream';
    fileSize = documentMessage.fileLength || 0;
    caption = documentMessage.caption || '';
  }

  console.log(`[WhatsApp] Media from ${senderNumber}: ${filename} (${Math.round(fileSize / 1024)}KB)`);

  // React to acknowledge
  try {
    await sock.sendMessage(jid, { react: { text: '👀', key: msg.key } });
  } catch {}

  const typingInterval = setInterval(() => {
    sock.sendPresenceUpdate('composing', jid).catch(() => {});
  }, 4000);

  try {
    await sock.sendPresenceUpdate('composing', jid);

    // Download media via Baileys
    const buffer = await downloadMediaMessage(msg, 'buffer', {});

    // Use the attachments library (R2 storage + AI processing)
    // Pass buffer directly via attachment.data (no URL needed)
    const result = await processAttachment(
      { name: filename, data: buffer, size: fileSize, contentType: mimeType },
      USER_ID,
    );

    // PR 5.10: per-upload attribution. WhatsApp doesn't have persistent
    // user IDs the way Telegram does — `senderNumber` IS the identity
    // (E.164 phone or WhatsApp-internal number). Owner detection via
    // OWNER_WHATSAPP_NUMBER env if set; otherwise default to isOwner=true
    // (legacy behaviour). Group chats are jids ending in `@g.us`; DMs
    // end in `@s.whatsapp.net`.
    const ownerWaNumber = process.env.OWNER_WHATSAPP_NUMBER || null;
    const isOwner       = !ownerWaNumber || (senderNumber && String(ownerWaNumber) === String(senderNumber));
    const isGroupChat   = String(jid).endsWith('@g.us');
    const senderName    = msg.pushName || null;

    // Create attachment record
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
        discordMetadata: { source: 'whatsapp' },
        // PR 5.10 attribution
        platform: 'whatsapp',
        senderId: senderNumber,
        senderName,
        isOwner,
        channelId: jid,
        channelTitle: null,         // WhatsApp group titles aren't on the message; would need a separate group-info fetch
        channelKind: isGroupChat ? 'group' : 'dm',
      }).catch(err => console.error('[WhatsApp] Attachment record failed:', err.message));
    }

    // Build message for the agent
    let messageText = result.content || `[File: ${filename}]`;
    if (caption) messageText += `\n\nCaption: ${caption}`;

    // Same explicit-send invariant as processTextBatch — chatWithAgent
    // always returns null on success; agent reply via its explicit
    // /whatsapp/send curl during the run.
    await chatWithAgent(messageText, senderNumber, {
      inboundMessageId: msg.key?.id,
      dedupeNonce: msg.key?.id ? `wa:${msg.key.id}` : undefined,
    });

    clearInterval(typingInterval);
    await sock.sendPresenceUpdate('paused', jid);

    // Clear reaction
    try {
      await sock.sendMessage(jid, { react: { text: '', key: msg.key } });
    } catch {}
  } catch (err) {
    clearInterval(typingInterval);
    await sock.sendPresenceUpdate('paused', jid).catch(() => {});
    console.error(`[WhatsApp] Media handling failed (${filename}):`, err.message);
    captureError(err, { agentId: 'mya-whatsapp', taskType: 'media', filename });

    try {
      await sock.sendMessage(jid, { text: `Error processing file: ${err.message}` });
      await sock.sendMessage(jid, { react: { text: '', key: msg.key } });
    } catch {}
  }
}

// ── HTTP API for Proactive Messaging ────────────────────────────────────────

const app = express();
app.use(express.json());

// Resolve JID from request body (accepts jid or number)
function resolveJid(body) {
  if (body.jid) return body.jid;
  if (body.number) return numberToJid(body.number);
  // Default to first allowed number
  return numberToJid([...ALLOWED_NUMBERS][0]);
}

// Send message (used by agent-server for proactive messaging)
app.post('/whatsapp/send', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });

  if (!sock) return res.status(503).json({ error: 'WhatsApp not connected' });

  const jid = resolveJid(req.body);

  try {
    await sendTextMessage(sock, jid, text);
    res.json({ ok: true });
  } catch (err) {
    console.error('[WhatsApp HTTP] Send failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Send file (used by agent-server for document delivery)
app.post('/whatsapp/send-file', async (req, res) => {
  const { base64, filename, caption, mimeType } = req.body;
  if (!base64) return res.status(400).json({ error: 'base64 required' });

  if (!sock) return res.status(503).json({ error: 'WhatsApp not connected' });

  const jid = resolveJid(req.body);
  const name = filename || 'document';

  try {
    const buffer = Buffer.from(base64, 'base64');

    // Detect type and send appropriately
    const mime = mimeType || 'application/octet-stream';
    if (mime.startsWith('image/')) {
      await sock.sendMessage(jid, { image: buffer, caption: caption || '', mimetype: mime });
    } else if (mime.startsWith('audio/')) {
      await sock.sendMessage(jid, { audio: buffer, mimetype: mime, ptt: false });
    } else if (mime.startsWith('video/')) {
      await sock.sendMessage(jid, { video: buffer, caption: caption || '', mimetype: mime });
    } else {
      await sock.sendMessage(jid, { document: buffer, mimetype: mime, fileName: name, caption: caption || '' });
    }

    console.log(`[WhatsApp HTTP] File sent: ${name}`);
    res.json({ ok: true, filename: name });
  } catch (err) {
    console.error('[WhatsApp HTTP] Send file failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    bot: 'whatsapp',
    connected: sock !== null,
    allowedNumbers: [...ALLOWED_NUMBERS],
  });
});

// ── Start ───────────────────────────────────────────────────────────────────

app.listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`[WhatsApp] HTTP API listening on 127.0.0.1:${HTTP_PORT}`);
});

connectWhatsApp().catch(err => {
  console.error('[WhatsApp] Initial connection failed:', err.message);
  captureError(err, { agentId: 'mya-whatsapp', taskType: 'connect' });
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('[WhatsApp] Shutting down...');
  if (sock) sock.end(undefined);
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log('[WhatsApp] Shutting down...');
  if (sock) sock.end(undefined);
  process.exit(0);
});
