/**
 * MYA Agent API Server (Config-Driven)
 *
 * Generic agent server that can run as any MYA agent (company, research, etc.)
 * based on environment variables. This server handles:
 * - Discord bot /chat endpoint
 * - Autonomous /think endpoint
 * - Proactive Discord messaging /discord/send
 * - Standard status/info endpoints
 *
 * Configuration via env vars:
 * - AGENT_ID: Agent identifier (e.g., 'company-agent', 'mya-research')
 * - PORT: Server port
 * - DISCORD_CHANNEL: Discord channel for this agent
 *
 * Uses lib/ modules for:
 * - Standardized paths (fixes triple-state-file problem)
 * - Proper timeouts
 * - Event logging
 * - Claude Code execution
 */

// SECURITY: Block --inspect in production. Heap snapshots via inspector
// would expose master key material in mlock'd buffers.
if (process.execArgv.some(a => a.includes('inspect'))) {
  console.error('FATAL: --inspect detected. Node inspector is not allowed in production.');
  process.exit(1);
}

import './lib/sentry.js';
import 'dotenv/config';
import { bootstrapSecrets, refreshSecrets } from './lib/bootstrap-secrets.js';

// Bootstrap secrets from centralized API before anything else reads env
await bootstrapSecrets();

import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { spawn, execSync, execFileSync } from 'child_process';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { tryGetDb } from './lib/db.js';

// Full path to Claude Code CLI (required for PM2 environment)
// Common locations: /usr/bin/claude, /home/claude/.local/bin/claude, /usr/local/bin/claude
const CLAUDE_BIN = process.env.CLAUDE_BIN || '/usr/bin/claude';

// Import from lib modules
import { getAgentPaths, getAgentsRoot, ensureAgentStructure, readFile, writeFile } from './lib/paths.js';
import os from 'os';
import { writeMcpSettings } from './mcp/setup.js';
import { runClaudeCode } from './lib/runner.js';
import { fetchPrices, fetchFxRates } from './lib/price-fetcher.js';
import { getTimeout, TIMEOUTS } from './lib/timeouts.js';
import { logEvent, log as eventLog } from './lib/events.js';
import { isSilentReply } from './lib/tokens.js';
import {
  readAllCheckpoints,
  clearCheckpoint,
  archiveCheckpoint,
  getCheckpointSummary,
  cleanupArchivedCheckpoints,
} from './lib/checkpoint.js';
import {
  getSessionMessages,
  cleanupOldSessions,
  loadSessionMetadata,
  updateSessionMapping,
  getSessionForThread,
  getContextSummary,
  checkSessionTokens,
  clearSessionMapping,
} from './lib/session-store.js';
import { createRuntimeWithDb, getModelForTask } from './lib/runtime.js';
import { spawnTask, listActiveSpawns, getSpawnResult, getSpawnLimits } from './lib/spawner.js';
import { handleDelegation, completeDelegation } from './lib/delegation.js';
import { resolveBotHttpUrl } from './lib/collab.js';
import { assembleContext } from './lib/context-assembly.js';
import { enqueue, getLaneInfo, clearLane, drainMatching, cancelActive } from './lib/lanes.js';
// Wake cycles: agents see their scheduled cycles from wake-cycles.json
import { readFile as readFileRaw } from 'fs/promises';
import { classifyError, captureError, ErrorReason, sleep } from './lib/error-classifier.js';
import Busboy from 'busboy';
import { processAttachment, createAttachmentRecord } from './lib/attachments.js';
import { detectExportType, processClaudeExport, processOpenAIExport, processObsidianExport, processLinkedInExport } from './lib/import-parsers.js';
import { buildSentryFixPrompt } from './lib/qa-pipeline.js';
import {
  writeContinuation,
  readReadyContinuations,
  readAllContinuations,
  updateContinuation,
  clearContinuation,
  cleanupOldContinuations,
} from './lib/continuation.js';

// ── Extracted routers (Phase 3 — incremental extraction from this file)
import healthRouter from './routes/health.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Timing-safe string comparison to prevent timing attacks on secrets. */
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    // Burn constant time even on length mismatch
    const dummy = Buffer.alloc(Math.max(aBuf.length, 1));
    crypto.timingSafeEqual(dummy, dummy);
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

/** Sanitize error messages for external responses — never leak paths or internals */
function safeError(err, fallback = 'Internal server error') {
  // Always log the real error server-side
  return fallback;
}

const app = express();
app.set('trust proxy', 'loopback'); // Trust X-Forwarded-For only from localhost (Caddy)
const PORT = process.env.PORT || 3002;
const AGENT_ID = process.env.AGENT_ID || 'company-agent';
const MAX_TURNS = parseInt(process.env.MAX_TURNS, 10) || 30;
const MAX_CONTINUATIONS = parseInt(process.env.MAX_CONTINUATIONS, 10) || 2;

// Dynamic log prefix based on agent ID (e.g., 'company-agent' -> 'Company', 'mya-research' -> 'Research')
const LOG_PREFIX = AGENT_ID.includes('-')
  ? AGENT_ID.split('-').pop().charAt(0).toUpperCase() + AGENT_ID.split('-').pop().slice(1)
  : AGENT_ID.charAt(0).toUpperCase() + AGENT_ID.slice(1);

/** Safe truncation — returns '' if value is nullish. Accepts (str, len) or (str, 0, len) */
function trunc(str, start, end) { if (!str) return ''; return end != null ? str.substring(start, end) : str.substring(0, start); }

// Agent config — loaded from agents/*.json (single source of truth)
import {
  getAgentNames, getAgentRegistry, getAgentBotIds,
  getAgentConfig, getAgentDisplayName,
} from './lib/agent-config.js';

const AGENT_NAMES = getAgentNames();
const AGENT_REGISTRY = getAgentRegistry();
const AGENT_BOT_IDS = getAgentBotIds();

// getAgentDisplayName imported from lib/agent-config.js above
function _deprecated_getAgentDisplayName(agentId) {
  return getAgentDisplayName(agentId);
}

/**
 * Build source-specific file sending instructions for the agent prompt
 */
function getFileSendingInstructions(source, channelId, messageId) {
  if (source === 'telegram') {
    return `## Sending Files
You can send files to the user via Telegram:
\`\`\`bash
curl -X POST http://localhost:${PORT}/telegram/send-file -H "Content-Type: application/json" -d '{"filePath":"/path/to/file.pdf","caption":"Here is the document"}'
\`\`\`
Supports any file type up to 50MB. Use \`filePath\` for files on disk, or \`base64\` + \`filename\` for generated content.

**IMPORTANT — Sending files WITHOUT truncation**:
- **Existing files on disk**: Pass the \`filePath\` directly to /telegram/send-file. Do NOT read the file first — the Read tool truncates at ~2000 lines (~68KB).
- **Generated content** (>1500 chars): Write to a file first, then send via /telegram/send-file. Never include long documents as your text response.
`;
  }

  if (source === 'portal') {
    return `## Sending Files
You can send files to the user via the portal:
\`\`\`bash
curl -X POST http://localhost:${PORT}/portal/send-file -H "Content-Type: application/json" -d '{"filePath":"/path/to/file.pdf","filename":"report.pdf"}'
\`\`\`
This uploads to cloud storage and returns a URL. Include the returned \`url\` in your response so the user can download it.
Supports \`filePath\` for files on disk or \`base64\` + \`filename\` for generated content.

**IMPORTANT — Sending files WITHOUT truncation**:
- **Existing files on disk**: Pass the \`filePath\` directly to /portal/send-file. Do NOT read the file first — the Read tool truncates at ~2000 lines (~68KB).
- **Generated content** (>1500 chars): Write to a file first, then send via /portal/send-file. Never include long documents as your text response.
`;
  }

  // Discord: existing behavior
  if (channelId && messageId) {
    return `## Discord Actions
You can react to this message with emojis:
\`\`\`bash
curl -X POST http://localhost:${PORT}/discord/react -H "Content-Type: application/json" -d '{"channelId":"${channelId}","messageId":"${messageId}","emoji":"👍"}'
\`\`\`
Common reactions: 👍 ✅ 👀 🎯 💡 🚀 ❤️

**NEVER send .txt or .md files as responses.** Always write your full response as text — it is automatically split into multiple Discord messages. File attachments are only for binary files (images, PDFs, CSVs) that the user explicitly requests.

You can send a voice message (text-to-speech) to any Discord channel:
\`\`\`bash
curl -X POST http://localhost:${PORT}/discord/send-voice -H "Content-Type: application/json" -d '{"channelId":"${channelId}","text":"Your message to speak aloud"}'
\`\`\`
Converts text to a voice message using OpenAI tts-1-hd. Max 6000 characters (up to ~6 min speech). You can optionally specify a voice by adding "speaker" to the JSON: "speaker":"nova" (default). Available voices: alloy, ash, coral, echo, fable, nova, onyx, sage, shimmer. Only send voice when the user explicitly asks for one or when a voice reply is clearly more appropriate.

You can send messages to OTHER Discord channels (not the current one — your reply goes here automatically):
\`\`\`bash
curl -X POST http://localhost:${PORT}/discord/send -H "Content-Type: application/json" -d '{"channelId":"TARGET_CHANNEL_ID","content":"Your message here"}'
\`\`\`
Use this when someone asks you to post something in a specific channel. Look up the channel ID from the channel list below.
`;
  }

  return '';
}

/**
 * Build inter-agent collab instructions for the agent prompt
 */
function getCollabInstructions(channelId) {
  if (!process.env.DISCORD_COLLAB_CHANNEL) return '';

  const otherAgents = Object.entries(AGENT_NAMES)
    .filter(([id]) => id !== AGENT_ID)
    .map(([id, name]) => `${name} (\`${id}\`)`)
    .join(', ');

  const isInThread = channelId && channelId !== process.env.DISCORD_COLLAB_CHANNEL;
  const threadParam = isInThread ? `,"threadId":"${channelId}"` : '';

  return `## Inter-Agent Communication
To send a request to another agent via #agent-collab:
\`\`\`bash
curl -X POST http://localhost:${PORT}/collab/send -H "Content-Type: application/json" -d '{"targetAgent":"research-agent","message":"Please analyze this topic..."${threadParam}}'
\`\`\`
To send a file along with a request:
\`\`\`bash
curl -X POST http://localhost:${PORT}/collab/send -H "Content-Type: application/json" -d '{"targetAgent":"company-agent","message":"Please review this spec","filePath":"/path/to/file.md"${threadParam}}'
\`\`\`
This automatically @mentions the target agent so they see and respond in a thread. Do NOT use /discord/send directly for inter-agent requests — use /collab/send so the @mention is handled correctly.
${isInThread ? `
**You are currently in a collab thread (${channelId}).** The threadId is already included in the examples above — your replies will stay in this thread automatically.
` : `
**Thread continuity:** When you receive a reply from another agent in a collab thread, include \`"threadId"\` with the channel ID from that conversation to keep replies in the same thread.
`}
**IMPORTANT — how agent-to-agent messaging works in Discord:**
- Agents only respond to explicit **@mentions** from other bots. Plain text messages from bots (without @mention) are ignored.
- Use \`/collab/send\` which handles @mentioning automatically — never send plain messages expecting another agent to pick them up.
- If you're in a collab thread and want the other agent to respond, you MUST @mention them. Status messages, queue notifications, and non-@mention messages are invisible to other agents.
- If an agent is busy, your request is queued and processed in order — do NOT resend it.
- **When posting in another agent's channel via /discord/send, @mention THAT agent (not yourself).** Use the mention ID from the Team Directory above (e.g. \`<@THEIR_BOT_ID>\`). Never tag yourself in messages to other agents — tag the agent you're reaching out to.

Available agents: ${otherAgents}
`;
}

// Generic Discord channel (can be DISCORD_CHANNEL or agent-specific like DISCORD_COMPANY_CHANNEL)
const DISCORD_CHANNEL = process.env.DISCORD_CHANNEL || process.env.DISCORD_COMPANY_CHANNEL;

// Search infrastructure
const MYA_WORKER_URL = process.env.MYA_WORKER_URL;
const MYA_WORKER_SECRET = process.env.MYA_WORKER_SECRET;

// Initialize runtime context (frozen, threaded through all operations)
let runtime = null;
async function initRuntime() {
  runtime = await createRuntimeWithDb(AGENT_ID);
  console.log(`[${LOG_PREFIX}] Runtime initialized (tier: ${runtime.tier}, model: ${runtime.model}, db: ${!!tryGetDb()})`);
  console.log(`[${LOG_PREFIX}] Model routing: think=${runtime.models.think}, chat=${runtime.models.chat}, spawn=${runtime.models.spawn}, research=${runtime.models.research}`);
}

// Get standardized paths for this agent
const paths = getAgentPaths(AGENT_ID);

// Load system prompt with fallback to default template
const DEFAULT_PROMPT_PATH = path.join(__dirname, 'templates', 'default-system-prompt.md');
async function loadSystemPrompt() {
  try {
    const prompt = await loadSystemPrompt();
    if (prompt.trim()) return prompt;
  } catch { /* no custom prompt */ }
  try {
    const fallback = await fs.readFile(DEFAULT_PROMPT_PATH, 'utf-8');
    console.log(`[${LOG_PREFIX}] Using default system prompt template`);
    return fallback;
  } catch { return ''; }
}

/**
 * Store user + assistant messages in D1 for cross-channel search.
 * Called fire-and-forget after each successful chat response.
 * After insert, triggers the enrichment pipeline (tag + embed) via Worker.
 */
async function storeMessages(userId, source, userMessage, assistantResponse, requestTime) {
  const db = tryGetDb();
  if (!db) return;
  const userTime = requestTime || new Date();
  const assistantTime = new Date(); // actual completion time
  // Ensure assistant is always at least 1ms after user (in case of instant responses)
  if (assistantTime.getTime() <= userTime.getTime()) {
    assistantTime.setTime(userTime.getTime() + 1);
  }
  const agentId = AGENT_ID || 'personal-agent';
  const rows = [
    { user_id: userId, role: 'user', content: userMessage, source, agent_id: agentId, created_at: userTime.toISOString() },
    { user_id: userId, role: 'assistant', content: assistantResponse, source, agent_id: agentId, created_at: assistantTime.toISOString() },
  ];
  const inserted = await db.messages.insert(rows);

  // Enrichment pipeline: tag + embed via Worker (fire-and-forget)
  enrichMessages(inserted, userId, agentId);
}

/**
 * Fire-and-forget: send message IDs to local enrichment service for async
 * tagging (Qwen2.5-3B via llama-server) and embedding (BGE-M3 via ONNX).
 * Never blocks chat responses — returns immediately.
 */
function enrichMessages(insertedRows, userId, agentId) {
  if (!insertedRows?.length) return;

  const messageIds = insertedRows.map(r => r.id).filter(Boolean);
  if (messageIds.length === 0) return;

  const enrichUrl = process.env.ENRICHMENT_URL || 'http://localhost:8095';
  fetch(`${enrichUrl}/enrich`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageIds, userId, agentId }),
    signal: AbortSignal.timeout(1000), // 1s — truly async, don't wait
  }).catch(() => {}); // Swallow errors — enrichment is best-effort background task
}

/**
 * Create attachment + message records in D1 so agent-sent files appear in chat history.
 * Does NOT upload to R2 — pass r2Key if file is already stored there (e.g. portal uploads).
 *
 * @param {Object} opts
 * @param {string} opts.filename - Original filename
 * @param {string} opts.mimeType - MIME type
 * @param {string} opts.source - Channel source ('discord', 'telegram', 'portal')
 * @param {number} [opts.fileSize] - File size in bytes
 * @param {string} [opts.caption] - Optional caption/content text
 * @param {string} [opts.r2Key] - R2 key if already uploaded
 * @returns {Promise<{attachmentId: string} | null>}
 */
async function storeAttachmentRecord({ filename, mimeType, source, fileSize, caption, r2Key }) {
  const db = tryGetDb();
  if (!db) return null;

  const userId = process.env.USER_ID;
  if (!userId) return null;

  try {
    // Determine attachment type from mime
    let attachmentType = 'file';
    if (mimeType?.startsWith('image/')) attachmentType = 'image';
    else if (mimeType?.startsWith('audio/')) attachmentType = 'voice';
    else if (mimeType?.startsWith('video/')) attachmentType = 'video';

    // Create attachment record
    const attachment = await db.attachments.insert({
      user_id: userId,
      file_name: filename || null,
      file_type: attachmentType,
      r2_key: r2Key || null,
      file_size: fileSize || null,
      metadata: JSON.stringify({ source, agent_id: AGENT_ID, mime_type: mimeType }),
    });

    // Create assistant message linked to this attachment
    try {
      await db.messages.insert({
        user_id: userId,
        role: 'assistant',
        content: caption || filename,
        message_type: attachmentType === 'file' ? 'file' : attachmentType,
        attachment_id: attachment.id,
        source: source || AGENT_ID,
        agent_id: AGENT_ID,
        created_at: new Date().toISOString(),
      });
    } catch (msgErr) {
      console.error(`[${LOG_PREFIX}] Message record for attachment failed:`, msgErr.message);
    }

    console.log(`[${LOG_PREFIX}] Attachment stored: ${filename} (${attachment.id})`);

    // Auto-create document record for text-based files so they appear in Library
    const isTextFile = mimeType?.startsWith('text/') ||
      /\.(txt|md|csv|json|xml|html|log|yml|yaml|toml|ini|conf|sh|py|js|ts)$/i.test(filename || '');
    if (isTextFile && r2Key) {
      try {
        const docPath = `uploads/${filename || 'untitled'}`;
        const docTitle = (filename || 'untitled').replace(/\.[^.]+$/, '');
        // Fetch the file content from R2 for the document record
        const r2Res = await fetch(`${MYA_WORKER_URL}/attachments/${encodeURIComponent(r2Key)}`, {
          headers: { 'Authorization': `Bearer ${MYA_WORKER_SECRET}` },
          signal: AbortSignal.timeout(15000),
        });
        if (r2Res.ok) {
          const docContent = await r2Res.text();
          await db.documents.upsert({
            user_id: userId,
            path: docPath,
            title: docTitle,
            content: docContent.substring(0, 50000),
            summary: docContent.substring(0, 200),
            source_type: 'upload',
            created_by: AGENT_ID,
          });
          console.log(`[${LOG_PREFIX}] Document created for attachment: ${docPath}`);
        }
      } catch (docErr) {
        console.error(`[${LOG_PREFIX}] Auto-document for attachment failed:`, docErr.message);
      }
    }

    return { attachmentId: attachment.id };
  } catch (err) {
    console.error(`[${LOG_PREFIX}] storeAttachmentRecord error:`, err.message);
    return null;
  }
}

/**
 * Upload a local file to R2 and return the r2Key.
 * Used by send-file endpoints to persist agent-generated files.
 */
async function uploadFileToR2(filePath, base64, filename, mimeType) {
  if (!MYA_WORKER_URL || !MYA_WORKER_SECRET) return null;
  try {
    let data;
    if (filePath) {
      data = await fs.readFile(filePath);
    } else if (base64) {
      data = Buffer.from(base64, 'base64');
    } else {
      return null;
    }
    const userId = process.env.USER_ID || 'agent';
    const response = await fetch(`${MYA_WORKER_URL}/api/store-attachment`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${MYA_WORKER_SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: data.toString('base64'),
        userId,
        type: 'file',
        filename: filename || 'file',
        mimeType: mimeType || 'application/octet-stream',
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.error(`[${LOG_PREFIX}] R2 upload failed: ${response.status} ${errText.substring(0, 200)}`);
      return { r2Key: null, fileSize: data.length, localData: data };
    }
    const result = await response.json();
    return { r2Key: result.key, fileSize: data.length };
  } catch (err) {
    console.error(`[${LOG_PREFIX}] R2 upload error:`, err.message);
    return null;
  }
}

/**
 * Post-response file scanner: after each chat/think response, check the agent's
 * repo for recently modified text files and auto-create document records + R2 upload.
 * This catches files the agent wrote via the Write tool but didn't send via /send-file.
 */
const _lastFileScan = new Map(); // filename → mtime to avoid re-processing

async function scanAgentFilesForDocuments() {
  const db = tryGetDb();
  const userId = process.env.USER_ID;
  if (!db || !userId) return;

  const scanDirs = [
    paths.repo, // agent's main repo
    path.join(paths.repo, 'output'),
    path.join(paths.repo, 'documents'),
  ];

  const textExts = /\.(txt|md|csv|json|xml|html|log|yml|yaml|toml|ini|conf|sh|py|js|ts)$/i;
  const ignorePatterns = [/node_modules/, /\.git\//, /\.claude\//, /package-lock/, /HEARTBEAT\.md$/];
  const fiveMinAgo = Date.now() - 5 * 60 * 1000;
  let found = 0;

  for (const dir of scanDirs) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }

    for (const entry of entries) {
      if (!entry.isFile() || !textExts.test(entry.name)) continue;
      if (ignorePatterns.some(p => p.test(entry.name))) continue;

      const filePath = path.join(dir, entry.name);
      if (ignorePatterns.some(p => p.test(filePath))) continue;

      try {
        const stats = await fs.stat(filePath);
        if (stats.mtimeMs < fiveMinAgo) continue; // only recent files
        if (stats.size > 500000) continue; // skip huge files

        // Check if already processed at this mtime
        const prevMtime = _lastFileScan.get(filePath);
        if (prevMtime && prevMtime >= stats.mtimeMs) continue;
        _lastFileScan.set(filePath, stats.mtimeMs);

        const content = await fs.readFile(filePath, 'utf-8');
        if (!content || content.length < 10) continue;

        const docPath = `uploads/${entry.name}`;
        const docTitle = entry.name.replace(/\.[^.]+$/, '');

        // Upload to R2
        const r2Result = await uploadFileToR2(filePath, null, entry.name, 'text/plain');

        // Create/update document record
        await db.documents.upsert({
          user_id: userId,
          path: docPath,
          title: docTitle,
          content: content.substring(0, 50000),
          summary: content.substring(0, 200),
          source_type: 'upload',
          created_by: AGENT_ID,
        });

        // Store attachment record if R2 succeeded
        if (r2Result?.r2Key) {
          storeAttachmentRecord({
            filename: entry.name,
            mimeType: 'text/plain',
            source: 'agent-file',
            r2Key: r2Result.r2Key,
            fileSize: r2Result.fileSize,
          }).catch(() => {});
        }

        found++;
        console.log(`[${LOG_PREFIX}] Auto-captured agent file: ${docPath} (${content.length} chars)`);
      } catch (err) {
        console.error(`[${LOG_PREFIX}] File scan error for ${entry.name}:`, err.message);
      }
    }
  }

  if (found > 0) {
    console.log(`[${LOG_PREFIX}] File scan: ${found} new/updated file(s) captured`);
  }
}

// Wake cycles cache (loaded from wake-cycles.json written by scheduler)
let _wakeCyclesCache = null;
let _wakeCyclesLastRead = 0;

// Use standardized timeout configuration
const PROMPT_TIMEOUT = getTimeout('chat');
const KEEPALIVE_INTERVAL = TIMEOUTS.keepalive;

// ============================================
// Discord Channel Discovery (cached)
// ============================================

let _channelCache = null;
let _channelCacheTime = 0;
const CHANNEL_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function getDiscordChannels() {
  if (_channelCache && Date.now() - _channelCacheTime < CHANNEL_CACHE_TTL) {
    return _channelCache;
  }
  try {
    const botUrl = resolveBotHttpUrl(AGENT_ID);
    const res = await fetch(`${botUrl}/discord/channels`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return _channelCache || [];
    const { channels } = await res.json();
    _channelCache = channels || [];
    _channelCacheTime = Date.now();
    return _channelCache;
  } catch {
    return _channelCache || [];
  }
}

async function getWakeCycles() {
  const now = Date.now();
  if (_wakeCyclesCache && now - _wakeCyclesLastRead < 60_000) return _wakeCyclesCache;
  try {
    const cyclesPath = `${paths.root}/wake-cycles.json`;
    const data = await readFileRaw(cyclesPath, 'utf-8');
    _wakeCyclesCache = JSON.parse(data);
    _wakeCyclesLastRead = now;
    return _wakeCyclesCache;
  } catch {
    return null;
  }
}

function formatWakeCycleDocs(cycles) {
  if (!cycles || !cycles.cycles || cycles.cycles.length === 0) {
    return `\n## Wake Cycles\nYou have no scheduled wake cycles. Your scheduler may not be running.\n`;
  }

  const cyclesPath = `${paths.root}/wake-cycles.json`;

  let text = `## Wake Cycles

Your scheduler triggers you on these cycles. Each cycle wakes you via /think with a specific purpose.

### Your Active Cycles
`;
  for (const c of cycles.cycles) {
    const status = c.enabled === false ? ' *(disabled)*' : '';
    text += `- **${c.id}**${status}\n`;
    text += `  Schedule: \`${c.schedule}\` | Max turns: ${c.maxTurns || 50}\n`;
    if (c.description) text += `  Description: ${c.description}\n`;
    if (c.prompt) text += `  Prompt: ${c.prompt.length > 200 ? c.prompt.slice(0, 200) + '...' : c.prompt}\n`;
  }

  text += `
### Modifying Your Wake Cycles
You can edit your cycles by modifying \`${cyclesPath}\`.
The scheduler re-reads this file every 5 minutes.

**To add a cycle**, append to the \`cycles\` array:
\`\`\`json
{
  "id": "my-new-cycle",
  "description": "What this cycle does",
  "schedule": "daily:14",
  "prompt": "The full prompt for this cycle",
  "maxTurns": 50,
  "enabled": true
}
\`\`\`

**To disable a cycle**, set \`"enabled": false\` on it.
**To change timing**, edit the \`schedule\` field.

**Schedule format**: \`daily:HH\` (daily at hour), \`weekly:DOW:HH\` (weekly, 0=Sun), \`every:Nh\` (every N hours), \`interval:Nm\` (every N minutes, min 30)

**IMPORTANT**: Only modify your cycles when a human explicitly asks you to, or when adjusting your own existing cycles based on what you've learned. Do not create new cycles autonomously.
`;

  return text;
}

function formatChannelList(channels) {
  if (!channels || channels.length === 0) return '';
  const grouped = new Map();
  for (const ch of channels) {
    const cat = ch.category || 'General';
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat).push(ch);
  }
  let text = '## Discord Channels\n';
  for (const [category, chs] of grouped) {
    text += `**${category}:**\n`;
    for (const ch of chs) {
      text += `- #${ch.name}: \`${ch.id}\`\n`;
    }
  }
  return text;
}

// ============================================
// Discord Member Discovery (cached)
// ============================================

let _memberCache = null;
let _memberCacheTime = 0;
const MEMBER_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function getDiscordMembers() {
  if (_memberCache && Date.now() - _memberCacheTime < MEMBER_CACHE_TTL) {
    return _memberCache;
  }
  try {
    const botUrl = resolveBotHttpUrl(AGENT_ID);
    const res = await fetch(`${botUrl}/discord/members`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return _memberCache || [];
    const { members } = await res.json();
    _memberCache = members || [];
    _memberCacheTime = Date.now();
    return _memberCache;
  } catch {
    return _memberCache || [];
  }
}

/**
 * Build a team directory from live Discord guild data.
 * Shows all server members (bots and humans) with mention IDs.
 * Enriches bots with agent IDs and API ports from AGENT_BOT_IDS.
 */
function getWarRoomContext() {
  if (!process.env.WARROOM_PATH) return '';
  const p = process.env.WARROOM_PATH;
  return `\n---\n# War Room — Geopolitical Intelligence Platform
Path: ${p}
You have full read/write access. You can edit files, run scripts, commit and push via git.

## Architecture
- **main.py** — APScheduler daemon, runs all ingestion + narrative jobs on intervals
- **db.py** — SQLite schema (events, actors, actor_links, blocs, theaters, threads)
- **config.py** — Poll intervals, RSS feeds (16 categories, 60+ feeds), theater definitions, watch zones

## Ingestion Modules (21 active, in ingestion/)
| Module | Source | Interval | Auth |
|--------|--------|----------|------|
| rss.py | 60+ RSS feeds across 16 categories (news, think tanks, gov, Baltic, nuclear, Asia-Pacific, Middle East, cyber, adversary) | 5 min | none |
| polymarket.py | Polymarket Intelligence API | 5 min | basic auth |
| telegram_osint.py | 20 OSINT Telegram channels (Aurora Intel, OSINTdefender, DeepState, NEXTA, etc.) via public web scraping | 5 min | none |
| gdelt.py | GDELT global events | 30 min | none |
| gdelt_events.py | GDELT Event Database (precise lat/lng conflict events) | 15 min | none |
| usgs.py | USGS earthquakes (M4.5+) | 15 min | none |
| firms.py | NASA FIRMS/EFFIS satellite fire detection | 30 min | none |
| gdacs.py | GDACS disaster alerts (quakes, floods, cyclones) | 30 min | none |
| acled.py | ACLED conflict events | 1 hr | API key |
| cloudflare.py | Cloudflare Radar internet outages | 15 min | API token |
| adsb.py | OpenSky ADS-B military flight tracking | 6 hr | none |
| ais.py | AIS vessel tracking in 11 strategic maritime zones (Hormuz, Suez, Taiwan Strait, Baltic, etc.) | 30 min | AISSTREAM_API_KEY |
| oref.py | OREF (Israel Home Front Command) rocket/missile alerts, Hebrew→English translation, wave detection | 5 min | none |
| gpsjam.py | GPS jamming detection via gpsjam.org — 11 conflict regions, H3 hex cell analysis | 1 hr | none |
| wingbits.py | Wingbits premium ADS-B enrichment — aircraft registration, operator, military classification | 2 hr | WINGBITS_API_KEY |
| usni.py | USNI (U.S. Naval Institute) weekly fleet deployment reports — carrier strike groups, hull numbers | 6 hr | none |
| finnhub.py | Finnhub market data — defense ETFs (ITA, DFEN), energy (USO, UNG), country ETFs (FXI, EWY, TUR, EIS), VIX | 15 min | FINNHUB_API_KEY |
| market_velocity.py | Market velocity tracking | 15 min | none |
| calendar.py | Calendar events | configurable | none |
| bases.py | Military bases reference layer (53 bases) | seed only | none |
| infrastructure.py | Critical infrastructure (69 IX points, data centers) | seed only | none |

## Intelligence Algorithms (in narrative/)
| Module | Purpose | Interval |
|--------|---------|----------|
| baselines.py | Welford's online algorithm — rolling mean/variance per theater, anomaly detection at 2σ/3σ/4σ | 1 hr |
| convergence.py | 1° grid geographic convergence — flags when 2+ independent sources report in same cell within 6h | 30 min |
| instability.py | Enhanced Country Instability Index (0-100) — 8 components: conflict 25%, military 20%, market 12%, infrastructure 12%, baseline 10%, disaster 8%, electronic warfare (GPS jamming) 8%, OSINT 5%. OREF boost for Israel, GPS jamming boost, conflict zone floors (Ukraine≥55, Syria≥45, etc.) | 1 hr |
| trending.py | Trending keyword spike detection — 2h window vs 7-day baseline, 3x surge threshold, compound term extraction (world leaders, CVEs, APT groups), min 2 source diversity | 30 min |
| state.py | World state assembly for map rendering | on demand |
| actors.py | Seed actors, links, blocs data (59 actors, 58 links, 11 blocs) | seed only |
| theaters.py | Theater definitions (8 theaters) | seed only |

## Dashboard API (FastAPI, port 8050 on VPS)
- GET /api/state — Full world state: theaters, actors, actor_links, blocs, threads, events (top 50)
- GET /api/cii — Country Instability Index scores
- The Mycelium portal proxies /api/state via /portal/intel/warroom-state

## How to Develop
- Edit files at ${p}, test with: cd ${p} && .venv/bin/python3 -c "import module; module.function()"
- Commit and push: cd ${p} && git add -A && git commit -m "message" && git push
- Restart daemon: pm2 restart warroom-daemon
- View logs: pm2 logs warroom-daemon --lines 50
- The portal map at /intel reads from this API — any new data you add flows to the map automatically
`;
}

function getIntelContext() {
  const _conf = getAgentConfig(AGENT_ID);
  if (!_conf?.modules?.includes('intel')) return '';
  return `
---
# Intel Portal — Your Strategic Intelligence Dashboard

You own the **Intel page** at /intel in the Mycelium portal. It is a unified strategic intelligence interface combining geopolitical monitoring with prediction market analysis.

## Portal Layout (what users see at /intel)
1. **Strategic Map** (top, 65vh, always visible) — World map with:
   - Country fills colored by alliance blocs (NATO green, BRICS orange, EU blue, Five Eyes purple, OPEC+ orange-brown, Axis of Resistance, Quad)
   - Colors blend where countries belong to multiple blocs
   - Event pins (pulsing red = high impact, orange = medium, grey = low)
   - Smart Money overlays — top Polymarket bets geo-located by keyword (e.g. "Iran" bets near Tehran)
   - Theater status rings, major actor dots, bloc labels
   - 2D (Leaflet) / 3D (globe.gl) toggle
   - Sidebar: theater list with status + event counts, active threads
2. **Intelligence Summary** — Top conviction plays + critical signals from smart money
3. **Situation Report** (tab) — Your SITUATION_REPORT.md rendered as markdown. Updated by your scheduled briefs.
4. **Theater of Operations** (tab) — Ranked Polymarket recommendations with confidence, edge, entity positions
5. **Signal Intelligence** (tab) — Real-time signals: whale entries, smart convergence, stealth whales, volume spikes
6. **Shadow Actors** (tab) — Entity clusters (wallet groups), volume, P&L, win rates
7. **Insider Detection** (tab) — Binomial p-value scoring of suspicious win rates

## Data Sources (21 ingestion modules + Polymarket Intelligence)
- **War Room daemon** — 21 active ingestion modules feeding events, actors, blocs, threads into SQLite (see War Room section)
- **Polymarket Intelligence API** (${process.env.POLYMARKET_API_URL || 'not configured'}) — recommendations, signals, entities, insiders
- **Telegram OSINT** — 20 curated channels (Aurora Intel, OSINTdefender, DeepState, NEXTA, BNO News, etc.) scraped every 5 min
- **OREF alerts** — Real-time Israeli rocket/missile alerts with Hebrew→English translation, attack wave grouping
- **GPS jamming** — 11 strategic regions monitored (Baltic/Kaliningrad, Ukraine, Levant, Iran, South China Sea, etc.)
- **AIS vessel tracking** — Naval vessels in 11 maritime chokepoints (needs AISSTREAM_API_KEY)
- **USNI fleet reports** — Weekly carrier strike group positions, deployment status, hull numbers
- **Finnhub market data** — Defense ETFs, energy, country ETFs as instability proxy, VIX (needs FINNHUB_API_KEY)
- **Trending keywords** — Spike detection: 2h window vs 7-day baseline, 3x surge, compound terms (leaders, CVEs, APTs)
- **RSS** — 60+ feeds across 16 categories including think tanks (ISW, CSIS, Carnegie, Atlantic Council), Baltic news (ERR, LSM), nuclear (IAEA, 38 North), government (DoD, NATO, UN), adversary (TASS), cyber (CISA, KrebsOnSecurity)
- **Your SITUATION_REPORT.md** — at $WARROOM_PATH/SITUATION_REPORT.md, served via /portal/intel/report

## How the Map Gets Data
The portal calls /portal/intel/warroom-state which proxies to the war-room dashboard at http://127.0.0.1:8050/api/state.
Any events you add to the war-room SQLite DB (via ingestion modules) appear on the map automatically.
Events with lat/lng get plotted as pins. Actors, blocs, and alliances color the country fills.
Polymarket recommendations are overlaid on the map, geo-located by keyword matching.

## Intelligence Products You Generate
- **Country Instability Index (CII)** — 8 components including GPS jamming, OREF, Telegram OSINT density. View at /api/cii.
- **Convergence alerts** — Automatic when 2+ independent sources flag same 1° grid cell within 6h.
- **Trending keyword spikes** — Automated detection of surging terms across all sources.
- **Baselines & anomalies** — Welford's algorithm tracks mean/variance per theater; 2σ/3σ/4σ alerts fire automatically.

## How to Improve the System
You can evolve the entire intelligence platform:
- **Add data sources**: Create new ingestion modules in $WARROOM_PATH/ingestion/. Follow the pattern: fetch data → score impact → insert events with lat/lng/theater.
- **Add RSS feeds**: Append to RSS_FEEDS dict in $WARROOM_PATH/config.py — the daemon picks them up on restart.
- **Improve algorithms**: Edit $WARROOM_PATH/narrative/ — baselines, convergence detection, instability index, trending detection.
- **Update the map**: The portal code is in the mycelium repo at portal/src/routes/(app)/intel/+page.svelte. You can edit it.
- **Write situation reports**: Update $WARROOM_PATH/SITUATION_REPORT.md — the portal reads and renders it.
- **Evolve actors/alliances**: Edit $WARROOM_PATH/narrative/actors.py to add/update actors, links, blocs.

## Your Mission
You are the **grand strategist**. Your job:
- Synthesize signals from 21+ sources (Telegram OSINT, RSS, GDELT, USGS, GDACS, FIRMS, ACLED, AIS, OREF, GPS jamming, USNI, Finnhub, Polymarket, trending) into coherent intelligence
- Detect convergence — when multiple independent sources flag the same area/event
- Track the instability index and flag countries crossing thresholds
- Monitor GPS jamming and electronic warfare indicators
- Watch OREF for escalation in Israel/Iran theater
- Identify smart money positioning on geopolitical outcomes via Polymarket
- Spot hidden patterns: stealth whales, pre-resolution trades, entity coordination across markets
- Brief your principal with actionable intelligence, not raw data
- Continuously improve the platform — add sources, refine algorithms, update the map
`;
}

async function buildTeamDirectory() {
  const myName = getAgentDisplayName(AGENT_ID);
  let text = `You are **${myName}** (${AGENT_ID}).\n\n`;

  const members = await getDiscordMembers();

  // Build reverse map: Discord bot user ID → agentId
  const botIdToAgent = {};
  for (const [agentId, botId] of Object.entries(AGENT_BOT_IDS)) {
    botIdToAgent[botId] = agentId;
  }
  const agentPorts = Object.fromEntries(
    Object.entries(AGENT_REGISTRY).map(([id, info]) => [id, info.port])
  );

  const bots = [];
  const humans = [];

  for (const m of members) {
    const agentId = botIdToAgent[m.id];
    if (m.bot && agentId) {
      // Known agent bot
      const name = AGENT_NAMES[agentId] || m.displayName;
      const isMe = agentId === AGENT_ID;
      const port = agentPorts[agentId] || '?';
      bots.push(`- **${name}** (${agentId})${isMe ? ' ← you' : ''} — mention: \`<@${m.id}>\`, API: \`http://localhost:${port}\``);
    } else if (m.bot) {
      // Other bot (not a known agent) — skip to keep directory clean
    } else {
      // Human member
      const roles = m.roles.length > 0 ? ` (${m.roles.join(', ')})` : '';
      humans.push(`- **${m.displayName}**${roles} — mention: \`<@${m.id}>\``);
    }
  }

  // Fallback: if Discord fetch failed, show known agents from config
  if (bots.length === 0) {
    for (const [agentId, name] of Object.entries(AGENT_NAMES)) {
      const botId = AGENT_BOT_IDS[agentId];
      const isMe = agentId === AGENT_ID;
      const port = agentPorts[agentId] || '?';
      bots.push(`- **${name}** (${agentId})${isMe ? ' ← you' : ''} — mention: \`<@${botId}>\`, API: \`http://localhost:${port}\``);
    }
  }

  if (bots.length > 0) {
    text += '## AI Agents\n' + bots.join('\n') + '\n';
  }
  if (humans.length > 0) {
    text += '\n## Humans\n' + humans.join('\n') + '\n';
  }
  text += '\nUse the mention syntax (e.g. `<@ID>`) to tag someone in Discord messages.\n';
  return text;
}

// ============================================
// Activity Stream (Live Updates) - Persistent
// ============================================

// Ring buffer for recent activity (last 500 entries)
let activityBuffer = [];
const MAX_ACTIVITY_ENTRIES = 500;
const activitySubscribers = new Set();
const ACTIVITY_LOG_FILE = path.join(paths.root, 'activity.jsonl');

// Load activity from disk on startup
async function loadActivityFromDisk() {
  try {
    const content = await fs.readFile(ACTIVITY_LOG_FILE, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    // Load last MAX_ACTIVITY_ENTRIES
    const entries = lines.slice(-MAX_ACTIVITY_ENTRIES).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    activityBuffer = entries;
    console.log(`[${LOG_PREFIX}] Loaded ${activityBuffer.length} activity entries from disk`);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error(`[${LOG_PREFIX}] Failed to load activity log:`, e.message);
    }
    activityBuffer = [];
  }
}

// Append activity to disk (async, non-blocking)
async function persistActivity(entry) {
  try {
    await fs.appendFile(ACTIVITY_LOG_FILE, JSON.stringify(entry) + '\n');
  } catch (e) {
    console.error(`[${LOG_PREFIX}] Failed to persist activity:`, e.message);
  }
}

function addActivity(type, content, metadata = {}) {
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
    type, // 'thought', 'action', 'output', 'error', 'status'
    content,
    timestamp: new Date().toISOString(),
    ...metadata
  };

  activityBuffer.push(entry);
  if (activityBuffer.length > MAX_ACTIVITY_ENTRIES) {
    activityBuffer.shift();
  }

  // Persist to disk (don't await, fire and forget)
  persistActivity(entry);

  // Broadcast to all subscribers
  const message = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of activitySubscribers) {
    res.write(message);
  }

  return entry;
}

// Load activity on module init
loadActivityFromDisk();

// Rate limits for autonomous messaging (10x increased from original 3/12/20)
const LIMITS = {
  maxMessagesPerHour: 30,
  maxMessagesPerDay: 120,
  minTimeBetweenMessages: 1, // minutes
};

// Active task tracking (for queue-aware heartbeat skip)
let activeTaskCount = 0;
let lastModelUsed = null;  // tracks the actual model used on the most recent task

// Track explicit outbound sends during task execution.
// When an agent explicitly sends messages via /discord/send or /telegram/send
// during a chat or think cycle, the final output is a meta-report (e.g. "Done.
// Here's what I did:") that should NOT also be delivered to the channel.
// Tasks are serial (lane queue), so a simple counter is safe.
let _taskExplicitSends = 0;

function resetExplicitSends() {
  _taskExplicitSends = 0;
}

function trackExplicitSend() {
  if (activeTaskCount > 0) {
    _taskExplicitSends++;
  }
}

function incrementActiveTask() {
  activeTaskCount++;
  console.log(`[${LOG_PREFIX}] Active tasks: ${activeTaskCount}`);
}

function decrementActiveTask() {
  activeTaskCount = Math.max(0, activeTaskCount - 1);
  console.log(`[${LOG_PREFIX}] Active tasks: ${activeTaskCount}`);
}

function hasActiveTasks() {
  return activeTaskCount > 0;
}

const ALLOWED_ORIGINS = [
  'https://in.mycelium.id',
  'http://localhost:5173',
  'http://localhost:4173',
  ...(process.env.PORTAL_ORIGINS || '').split(',').filter(Boolean),
];
app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
// Security headers — applied to all responses
app.use((_req, res, next) => {
  res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(csrfProtect); // CSRF validation for cookie-authenticated portal requests
app.use(express.json({ limit: '10mb' })); // Increased for file attachments + history

// SECURITY: Inter-agent authentication middleware (Finding 3)
// Protects internal endpoints from unauthorized access by requiring a shared secret.
// Only active when AGENT_INTERNAL_SECRET is set in .env (dev mode bypasses silently).
const INTERNAL_ENDPOINTS = ['/delegation-callback', '/spawn-task-async', '/think', '/delegate'];
app.use((req, res, next) => {
  if (!INTERNAL_ENDPOINTS.includes(req.path)) return next();
  const secret = process.env.AGENT_INTERNAL_SECRET;
  if (!secret) return next(); // dev mode bypass — no secret configured
  if (req.headers['x-internal-secret'] !== secret) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
});

// Simple cookie parser (avoids cookie-parser dependency)
app.use((req, _res, next) => {
  req.cookies = {};
  const cookie = req.headers.cookie;
  if (cookie) {
    for (const part of cookie.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k) req.cookies[k.trim()] = decodeURIComponent(v.join('='));
    }
  }
  next();
});

// Ensure agent structure exists on startup
ensureAgentStructure(AGENT_ID).then(() => {
  // Write MCP settings into repo dir (Claude Code's cwd) with AGENT_ROOT pointing to agent root (for mind files)
  // Extra MCP servers from agent config (agents/*.json)
  const extraMcpServers = getAgentConfig(AGENT_ID)?.extraMcpServers || [];

  return writeMcpSettings(paths.repo, process.env.USER_ID || '', {
    agentRoot: paths.root,
    memoryScope: process.env.MEMORY_SCOPE || 'all',
    extraEnv: { AGENT_URL: `http://localhost:${PORT}` },
    extraMcpServers,
  });
}).catch(err => {
  console.error(`[${LOG_PREFIX}] Failed to ensure agent structure / MCP setup:`, err.message);
});

// ============================================
// State Management (using lib/paths.js)
// ============================================

async function loadState() {
  const state = await readFile(paths.state, {
    messagesThisHour: 0,
    messagesToday: 0,
    lastMessageTime: null,
    lastHumanMessageTime: null,
    dateKey: new Date().toISOString().split('T')[0],
    hourKey: new Date().toISOString().split(':')[0],
    pendingThoughts: [],
    currentGoals: [],
  });
  return state;
}

async function saveState(state) {
  try {
    await writeFile(paths.state, state);
    addActivity('action', 'State saved', { type: 'state-save', phase: state.currentPhase });
  } catch (e) {
    console.error(`[${LOG_PREFIX}] Failed to save state:`, e.message);
    eventLog.error('saveState', e);
    addActivity('error', `Failed to save state: ${e.message}`, { type: 'state-save' });
  }
}

function resetCountersIfNeeded(state) {
  const now = new Date();
  const dateKey = now.toISOString().split('T')[0];
  const hourKey = now.toISOString().split(':')[0];

  if (state.dateKey !== dateKey) {
    state.messagesToday = 0;
    state.dateKey = dateKey;
  }
  if (state.hourKey !== hourKey) {
    state.messagesThisHour = 0;
    state.hourKey = hourKey;
  }
  return state;
}

// ============================================
// File-Based Task Queue (using lib/paths.js)
// ============================================

async function loadTasks() {
  return await readFile(paths.knowledge.pendingTasks, { tasks: [] });
}

async function saveTasks(tasksData) {
  try {
    await writeFile(paths.knowledge.pendingTasks, tasksData);
  } catch (e) {
    console.error(`[${LOG_PREFIX}] Failed to save tasks:`, e.message);
    eventLog.error('saveTasks', e);
  }
}

async function addTask(task) {
  const data = await loadTasks();
  const newTask = {
    id: `task-${Date.now()}`,
    ...task,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  data.tasks.push(newTask);
  await saveTasks(data);
  console.log(`[${LOG_PREFIX}] Added task: ${newTask.id} - ${task.description?.substring(0, 50)}...`);
  eventLog.taskCreated(AGENT_ID, newTask.id, task.description);
  addActivity('action', `Created task: ${task.description?.substring(0, 100)}`, {
    type: 'task-created',
    taskId: newTask.id,
    requestedBy: task.requestedBy
  });
  return newTask.id;
}

function canSendProactiveMessage(state) {
  if (state.messagesThisHour >= LIMITS.maxMessagesPerHour) {
    return { allowed: false, reason: 'hourly_limit' };
  }
  if (state.messagesToday >= LIMITS.maxMessagesPerDay) {
    return { allowed: false, reason: 'daily_limit' };
  }
  if (state.lastMessageTime) {
    const minutesSince = (Date.now() - new Date(state.lastMessageTime).getTime()) / 60000;
    if (minutesSince < LIMITS.minTimeBetweenMessages) {
      return { allowed: false, reason: 'too_soon' };
    }
  }
  return { allowed: true };
}

/**
 * Generate approximate waveform from audio bytes for Discord voice messages.
 * Discord expects ~256 amplitude samples as a base64-encoded byte array.
 * Samples raw OGG bytes — no real Opus decoding needed for visual display.
 */
function generateWaveform(audioBuffer, numSamples = 256) {
  const samples = Buffer.alloc(numSamples);
  if (audioBuffer.length === 0) return samples.toString('base64');

  // Skip OGG header (metadata, not audio)
  const headerSkip = Math.min(200, Math.floor(audioBuffer.length * 0.05));
  const audioData = audioBuffer.subarray(headerSkip);
  const chunkSize = Math.max(1, Math.floor(audioData.length / numSamples));

  for (let i = 0; i < numSamples; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, audioData.length);
    if (start >= audioData.length) { samples[i] = 0; continue; }

    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      sum += Math.abs(audioData[j] - 128);
      count++;
    }
    samples[i] = Math.min(255, Math.round((count > 0 ? sum / count : 0) * 2));
  }
  return samples.toString('base64');
}

// ============================================
// Core Endpoints
// ============================================

// A2A-compatible agent card — declares capabilities, not deployment config
app.get('/.well-known/agent.json', async (req, res) => {
  // Load description from system prompt if available
  let description = `${AGENT_ID} agent`;
  try {
    const systemPrompt = await loadSystemPrompt();
    // Extract first meaningful line as description
    const firstLine = systemPrompt.split('\n').find(l => l.trim() && !l.startsWith('#'));
    if (firstLine) description = firstLine.trim().slice(0, 200);
  } catch { /* use default */ }

  // Read Discord bot identity (written by the bot process on startup)
  let discordBotUserId = null;
  try {
    discordBotUserId = (await fs.readFile(path.join(paths.root, '.discord-bot-id'), 'utf-8')).trim();
  } catch { /* bot hasn't started yet or no bot for this agent */ }

  res.json({
    name: AGENT_ID,
    description,
    version: '1.0.0',
    url: runtime?.publicUrl || `http://localhost:${PORT}`,
    instance_id: runtime?.instanceId || null,
    discordBotUserId,
    skills: [],  // populated per-agent via system prompt
    capabilities: {
      streaming: false,
      delegation: true,
      spawning: true,
    },
  });
});

app.get('/health', async (req, res) => {
  const state = await loadState();

  // Stack checks
  const checks = { d1: 'unknown', auth: 'unknown', encryption: 'unknown' };
  try {
    const db = tryGetDb();
    if (db) {
      await db.rawQuery('SELECT 1');
      checks.d1 = 'ok';
    } else {
      checks.d1 = 'no_db';
    }
  } catch { checks.d1 = 'error'; }

  checks.auth = process.env.AGENT_TOKEN ? 'ok' : 'missing';
  // Encryption: tmpfs (preferred) or env var (fallback)
  checks.encryption = (existsSync('/run/mycelium/master.key') || process.env.ENCRYPTION_MASTER_KEY) ? 'ok' : 'disabled';

  const status = checks.d1 === 'ok' && checks.auth === 'ok' ? 'ok' : 'degraded';

  // Unauthenticated: minimal response for uptime monitors
  const isAuthed = requireWorkerSecretSilent(req);
  if (!isAuthed) {
    return res.json({ status, timestamp: new Date().toISOString() });
  }

  // Authenticated: full operational details
  let version = null;
  try { version = (await fs.readFile(path.join(__dirname, '.version'), 'utf-8')).trim(); } catch {}

  res.json({
    status,
    agent: AGENT_ID,
    tier: runtime?.tier || 1,
    model: runtime?.model || 'sonnet',
    models: runtime?.models || {},
    lastModelUsed,
    account: process.env.CLAUDE_CONFIG_DIR ? 'configured' : 'default',
    checks,
    identity: identityCheck.verified !== undefined ? {
      verified: identityCheck.verified,
      mode: identityCheck.mode,
      handle: identityCheck.handle,
    } : undefined,
    version,
    features: ['chat', 'think', 'discord-outbound', 'checkpoint-recovery', 'session-resume', 'wake-cycles'],
    timeouts: {
      chat: TIMEOUTS.chat / 1000 + 's',
      think: TIMEOUTS.think / 1000 + 's',
      research: TIMEOUTS.research / 1000 + 's',
    },
    state: {
      messagesThisHour: state.messagesThisHour,
      messagesToday: state.messagesToday,
      lastMessageTime: state.lastMessageTime,
      activeTasks: activeTaskCount,
    },
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.get('/info', async (req, res) => {
  if (!requireWorkerSecret(req, res)) return;
  try {
    const [systemPrompt, context] = await Promise.all([
      fs.readFile(paths.prompts.system, 'utf-8').catch(() => 'No system prompt'),
      fs.readFile(paths.knowledge.context, 'utf-8').catch(() => 'No context')
    ]);

    res.json({
      agent: AGENT_ID,
      directory: paths.root,
      repository: paths.repo,
      systemPrompt: systemPrompt.substring(0, 500) + '...',
      contextPreview: context.substring(0, 500) + '...'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Discord Chat Endpoint (Discord Bot Integration)
// ============================================

app.post('/chat', async (req, res) => {
  // Use socket address (not req.ip — req.ip respects X-Forwarded-For which is
  // spoofable). Direct localhost socket connections skip auth; everything else
  // (including proxied requests via Caddy) requires the worker secret.
  if (!requireWorkerSecret(req, res)) return;

  const requestTime = new Date(); // capture arrival time for message timestamps
  const { channel, username, userId, history, channelId, messageId, taskType: requestedTaskType, sourceAgent, priority: taskPriority, context: taskContext } = req.body;
  // Accept both 'prompt' (Discord bot) and 'message' (Telegram bot, Portal chat-proxy)
  const prompt = req.body.prompt || req.body.message;
  if (!prompt) {
    return res.status(400).json({ error: 'Prompt required' });
  }
  // Use taskType from request if provided (e.g. 'research' for collab), otherwise default to 'chat'
  const taskType = requestedTaskType || 'chat';

  // Record human message for autonomous timing
  let state = await loadState();
  state = resetCountersIfNeeded(state);
  state.lastHumanMessageTime = new Date().toISOString();
  await saveState(state);

  // Load system prompt, context, and heartbeat (consciousness state)
  let systemPrompt = '';
  let context = '';
  let heartbeat = '';
  const wakeCycles = await getWakeCycles();
  try {
    systemPrompt = await loadSystemPrompt();
    context = await fs.readFile(paths.knowledge.context, 'utf-8').catch(() => '');
    // Load HEARTBEAT.md from repo - this is the agent's memory of autonomous work
    heartbeat = await fs.readFile(path.join(paths.repo, 'HEARTBEAT.md'), 'utf-8').catch(() => '');
  } catch (e) {
    console.log(`[${LOG_PREFIX}] Could not load prompts:`, e.message);
  }

  // Assemble rich context for personal agent (mind files, pinned docs, cross-channel history)
  const memoryScope = process.env.MEMORY_SCOPE || 'company';
  let assembledContext = '';
  try {
    const chatSource = req.body.source || (channel ? 'discord' : '');
    assembledContext = await assembleContext(paths.root, req.body.userId || process.env.USER_ID || '', {
      scope: memoryScope,
      source: chatSource,
      agentId: AGENT_ID,
    });
  } catch (e) {
    console.log(`[${LOG_PREFIX}] Context assembly failed (non-fatal):`, e.message);
  }

  // Fetch available Discord channels dynamically
  const discordChannels = await getDiscordChannels();
  const channelListText = formatChannelList(discordChannels);

  // Build conversation context from history
  const agentName = getAgentDisplayName(AGENT_ID);
  let historyText = '';
  if (history && history.length > 0) {
    historyText = '\n---\n# Recent Conversation\n' +
      history.map(m => `${m.role === 'user' ? m.username || 'User' : agentName}: ${m.content}`).join('\n');
  }

  // Build team directory so agent knows all members and how to tag them
  const teamDirectory = await buildTeamDirectory();

  const fullPrompt = `${systemPrompt}

---
# Team Directory
${teamDirectory}

---
# Your Current State (from autonomous work)
${heartbeat || 'No heartbeat file found - you may not have recent autonomous context.'}

---
# Company Context
${context}
${assembledContext ? `\n${assembledContext}` : ''}
${getWarRoomContext()}${getIntelContext()}${historyText}

---
# Current Message
From: ${username || 'Unknown'}${userId ? ` (mention with <@${userId}>)` : ''} in #${channel || 'unknown'}
${channelId ? `Channel ID: ${channelId}` : ''}
${messageId ? `Message ID: ${messageId}` : ''}
${sourceAgent ? `\n## ⚡ Inter-Agent Request\nThis message is from **${getAgentDisplayName(sourceAgent)}** (${sourceAgent}), not a human.${taskPriority ? ` Priority: **${taskPriority}**` : ''}${taskContext ? `\nContext provided: ${taskContext}` : ''}

Before acting on this request, evaluate:
1. **Relevance**: Does this fall within your expertise? If not, say so and suggest who should handle it.
2. **Clarity**: Is the task specific enough to act on? If vague, push back and ask for details rather than guessing.
3. **Priority**: ${taskPriority === 'high' ? 'This is marked high priority — a human may be waiting. Act promptly.' : 'Handle in order of your current workload. If busy, acknowledge and indicate when you can get to it.'}
` : ''}
Message: ${prompt}

${getFileSendingInstructions(req.body.source || (channel ? 'discord' : ''), channelId, messageId)}${getCollabInstructions(channelId)}${channelListText ? `${channelListText}\n` : ''}${formatWakeCycleDocs(wakeCycles)}

## Important: Your response IS sent directly to the ${sourceAgent ? 'requesting agent' : 'user'}.

Your text response will be automatically delivered to the channel you're replying in. Do NOT also curl a message to THIS same channel — that would create a duplicate.

Long messages are automatically split into multiple Discord messages — just write your full response as plain text. NEVER write your response to a .md or .txt file and send it as an attachment. Your text output IS the message — it gets split and delivered automatically.

**Discord formatting note:** Discord does NOT render markdown tables. If you need to present tabular data, wrap it in a code block (\`\`\`) so columns align with monospace spacing. Use the compact list format (▸ item: value) when a full table isn't necessary.
${sourceAgent ? `
**Result delivery rule:** Your full results MUST appear in this conversation thread — the requesting agent is reading here. If the requester also asks you to post results to a different channel (e.g., #research), do BOTH: deliver complete results here AND cross-post to that channel. Never leave only a summary here with "full report in #research" — that breaks the conversation for the agent waiting in this thread.` : ''}
If someone asks you to post in a DIFFERENT channel, use \`/discord/send\` with that channel's ID.

## Response Options

1. **Do the work NOW** - This is the default. You have tools (web search, file access, analysis). Use them to complete the request in this response. Don't just acknowledge — actually deliver results. If asked to research something, research it. If asked to write something, write it.

2. **Quick Response** - If the answer is straightforward and doesn't need tools, respond directly.

3. **No Reply** - If you have nothing valuable to add, respond with ONLY: NO_REPLY
${sourceAgent ? `\n4. **Decline** - If this is outside your scope, poorly specified, or duplicative: explain why and suggest an alternative.\n` : ''}
**CRITICAL**: Never just promise to do something ("I'll look into that", "I'll have findings ready soon"). Either do it right now or decline. Empty promises waste everyone's time — the other agent is waiting for actual results, not acknowledgments.

**IMPORTANT — No meta-reports**: If you have already sent messages to Discord or Telegram during this execution (via curl to /discord/send, /telegram/send, etc.), respond with ONLY: NO_REPLY. Do NOT also output a summary of what you did ("Done. Here's what I did:"). The message you explicitly sent IS the response — there is no need for a second meta-report.

**@Mention requirement**: When your response is directed at another agent, ALWAYS @mention them so they get notified. Use \`/collab/send\` with threadId to continue in the same thread. If you post results to a different channel, @mention the requesting agent there too.`;

  console.log(`[${LOG_PREFIX}] Chat from ${username} in #${channel} (${taskType}): ${prompt.length} chars`);
  addActivity('action', `Received message from ${username} in #${channel}`, { type: 'discord-message', username, channel });
  addActivity('thought', `Processing: ${prompt.length} chars`, { type: 'processing' });

  // Serialize through the lane queue — prevents concurrent /chat calls from racing
  const laneId = `agent:${AGENT_ID}`;
  const abortController = new AbortController();
  const taskMetadata = {
    username: username || 'Unknown', channel: channel || 'unknown', channelId, taskType,
    abortController, coalesceKey: channelId, userMessage: prompt,
  };

  try {
    const result = await enqueue(laneId, async () => {
      incrementActiveTask();
      try {
        // Look up existing Claude Code session for this thread/channel
        // Use source prefix (telegram, portal, discord) instead of hardcoding discord_
        const chatSource = req.body.source || (channel ? 'discord' : 'chat');
        const threadKey = channelId ? `${chatSource}_${channelId}` : `chat_${Date.now()}`;
        let existingSessionId = channelId ? await getSessionForThread(paths.root, threadKey) : null;

        // Note: We used to proactively compact at 200k tokens, but this caused more issues than it solved.
        // Claude's native context management handles overflow gracefully with automatic compaction.
        // Manual compaction only happens on actual CONTEXT_OVERFLOW errors (see error handling below).

        // If a previous session was compacted (context overflow), include the summary
        // so the fresh session has continuity. The summary is cleared once a new valid session starts.
        let promptWithContext = fullPrompt;
        if (!existingSessionId && channelId) {
          const contextSummary = await getContextSummary(paths.root, threadKey);
          if (contextSummary) {
            promptWithContext = `${fullPrompt}\n\n---\n# Previous Session Context (compacted)\n${contextSummary}\n---`;
            console.log(`[${LOG_PREFIX}] Including compacted context from previous session overflow`);
          }
        }

        // Coalesce queued messages from the same channel into a single prompt
        // This avoids N separate Claude invocations when the user sends rapid messages
        const coalescedEntries = channelId
          ? drainMatching(laneId, m => m.coalesceKey === channelId && m !== taskMetadata)
          : [];

        if (coalescedEntries.length > 0) {
          const extraMessages = coalescedEntries.map(e =>
            `[${e.metadata.username}]: ${e.metadata.userMessage}`
          ).join('\n');
          promptWithContext += `\n\n---\n## Additional messages (sent while you were processing the previous request)\n${extraMessages}\n---`;
          console.log(`[${LOG_PREFIX}] Coalesced ${coalescedEntries.length} queued messages from #${channel}`);
        }

        // Select model based on task type (think=opus, chat=sonnet, spawn=haiku)
        const chatModel = getModelForTask(runtime, taskType);
        lastModelUsed = chatModel;
        addActivity('action', `Starting Claude Code execution (model: ${chatModel}, maxTurns: ${MAX_TURNS}${existingSessionId ? ', resuming session' : ', new session'}${coalescedEntries.length > 0 ? `, +${coalescedEntries.length} coalesced` : ''})`, { type: 'claude-start', model: chatModel });

        const chatDeliveryContext = { channel: 'discord', channelId, messageId, username };
        let output = '', claudeSessionId;
        resetExplicitSends();
        try {
          ({ result: output, sessionId: claudeSessionId } = await runWithContinuation({
            prompt: promptWithContext,
            runOptions: {
              model: chatModel,
              maxTurns: MAX_TURNS,
              cwd: paths.repo,
              taskType,
              agentRoot: paths.root,
              agentId: AGENT_ID,
              resumeSessionId: existingSessionId,
              deliveryContext: chatDeliveryContext,
              signal: abortController.signal,
              onActivity: (type, data) => {
                if (type === 'tool_start') addActivity('action', `Tool: ${data.tool}`, { type: 'tool-start', tool: data.tool });
                else if (type === 'tool_complete') addActivity('action', `Tool completed: ${data.tool}`, { type: 'tool-complete', tool: data.tool });
                else if (type === 'thinking_start') addActivity('thought', 'Thinking...', { type: 'thinking' });
              },
            },
            deliveryContext: chatDeliveryContext,
          }));
        } catch (resumeError) {
          // If continuation was scheduled (rate limit), propagate to caller for 202 response
          if (resumeError.continuationScheduled) throw resumeError;

          // If resume failed, retry with a fresh session
          if (existingSessionId && !resumeError.continuationScheduled) {
            console.log(`[${LOG_PREFIX}] Resume failed (${resumeError.message}), retrying with new session`);
            await clearSessionMapping(paths.root, threadKey);
            ({ result: output, sessionId: claudeSessionId } = await runWithContinuation({
              prompt: promptWithContext,
              runOptions: {
                model: chatModel,
                cwd: paths.repo,
                taskType,
                agentRoot: paths.root,
                agentId: AGENT_ID,
                resumeSessionId: null,
                deliveryContext: chatDeliveryContext,
                onActivity: (type, data) => {
                  if (type === 'tool_start') addActivity('action', `Tool: ${data.tool}`, { type: 'tool-start', tool: data.tool });
                  else if (type === 'tool_complete') addActivity('action', `Tool completed: ${data.tool}`, { type: 'tool-complete', tool: data.tool });
                  else if (type === 'thinking_start') addActivity('thought', 'Thinking...', { type: 'thinking' });
                },
              },
              deliveryContext: chatDeliveryContext,
            }));
          } else {
            throw resumeError;
          }
        }

        // Store Claude Code session ID for future --resume calls
        // Track estimated tokens (~4 chars per token) for context overflow detection
        const estimatedNewTokens = Math.ceil((promptWithContext.length + (output?.length || 0)) / 4);
        if (claudeSessionId && channelId) {
          await updateSessionMapping(paths.root, threadKey, claudeSessionId, {
            channelName: channel || null,
            addTokens: estimatedNewTokens,
          });
        }

        // Detect context overflow: compact the session and retry with a fresh one.
        // Catches: "context overflow", "prompt too long", "prompt is too long", "context limit exceeded", etc.
        const contextOverflowPattern = /context (window |limit )?(ran out|overflow|exceeded|full|limit reached)|ran out of context|out of context|prompt (is )?too (long|large)|token limit/i;
        let compacted = false;
        if (contextOverflowPattern.test(output) && channelId) {
          console.log(`[${LOG_PREFIX}] Context overflow detected — compacting session and retrying`);
          addActivity('action', 'Context overflow detected — compacting and retrying with fresh session', { type: 'compaction' });

          const summary = trunc(output,0, 3000);
          await updateSessionMapping(paths.root, threadKey, null, {
            channelName: channel || null,
            contextSummary: `[Previous session ran out of context — here's your last response for continuity]\n\n${summary}`,
          });

          const contextSummary = await getContextSummary(paths.root, threadKey);
          const compactedPrompt = contextSummary
            ? `${fullPrompt}\n\n---\n# Previous Session Context (compacted)\n${contextSummary}\n---`
            : fullPrompt;

          ({ result: output, sessionId: claudeSessionId } = await runWithContinuation({
            prompt: compactedPrompt,
            runOptions: {
              model: chatModel,
              cwd: paths.repo,
              taskType,
              agentRoot: paths.root,
              agentId: AGENT_ID,
              resumeSessionId: null,
              skipDedup: true,
              deliveryContext: chatDeliveryContext,
            },
            deliveryContext: chatDeliveryContext,
          }));

          if (claudeSessionId && channelId) {
            await updateSessionMapping(paths.root, threadKey, claudeSessionId, {
              channelName: channel || null,
            });
          }

          compacted = true;
          console.log(`[${LOG_PREFIX}] Compaction retry succeeded — fresh session started`);
          addActivity('output', 'Compaction retry complete — fresh session active', { type: 'compaction-complete' });
        }

        console.log(`[${LOG_PREFIX}] Response: ${trunc(output,0, 100)}...`);
        addActivity('output', `Claude response (${(output || '').length} chars): ${trunc(output, 0, 200)}${(output || '').length > 200 ? '...' : ''}`, { type: 'claude-response' });

        // Check if agent committed to a task
        const taskMatch = output.match(/^TASK:\s*(.+?)(?:\n|$)/m);
        let taskId = null;

        if (taskMatch) {
          const taskDescription = taskMatch[1].trim();
          console.log(`[${LOG_PREFIX}] Agent committed to task: ${taskDescription}`);

          taskId = await addTask({
            type: 'research',
            description: taskDescription,
            requestedBy: username,
            channel: channel,
            context: { originalMessage: prompt, history: history?.slice(-5) },
            priority: 'normal'
          });
        }

        const cleanResponse = output.replace(/^TASK:[^\n]*\n?/m, '').trim();
        let noReply = isSilentReply(cleanResponse);

        // If agent already sent messages explicitly during execution (via /discord/send,
        // /telegram/send, etc.), the output is a meta-report ("Done. Here's what I did:")
        // that should not be sent to the channel as a second message.
        if (_taskExplicitSends > 0 && !noReply && cleanResponse) {
          console.log(`[${LOG_PREFIX}] Agent sent ${_taskExplicitSends} explicit message(s) during execution — suppressing meta-report`);
          addActivity('status', `Suppressed meta-report (${_taskExplicitSends} explicit sends during execution)`, { type: 'meta-report-suppressed' });
          noReply = true;
        }

        // Guard: if response is empty and not a deliberate NO_REPLY, log a warning
        // This shouldn't happen after the runner fix, but provides a safety net
        if (!cleanResponse && !noReply) {
          console.warn(`[${LOG_PREFIX}] Empty response from Claude Code (not NO_REPLY) — this may indicate a silent failure`);
          addActivity('warning', 'Empty response from Claude Code (not NO_REPLY)', { type: 'empty-response' });
        }

        // Resolve coalesced entries — they all get the combined response
        for (const entry of coalescedEntries) {
          entry.resolve({
            response: noReply ? '' : cleanResponse,
            noReply,
            coalesced: true,
            taskCreated: !!taskId,
            taskId,
          });
        }

        return {
          response: noReply ? '' : cleanResponse,
          noReply,
          compacted,
          coalesced: coalescedEntries.length,
          taskCreated: !!taskId,
          taskId
        };
      } finally {
        decrementActiveTask();
      }
    }, taskMetadata);

    // Store messages in D1 for cross-channel search
    // Fire-and-forget: don't block the response on message storage
    // Prefer database USER_ID (UUID) over Discord snowflake so all messages are
    // queryable by the personal agent during reflections and context assembly.
    const chatUserId = process.env.USER_ID || req.body.userId;
    const chatSource = req.body.source || (channel ? `discord_${channelId}` : 'unknown');
    if (chatUserId && result.response && !result.noReply) {
      storeMessages(chatUserId, chatSource, prompt, result.response, requestTime).catch(err => {
        console.error(`[${LOG_PREFIX}] Message storage failed (non-fatal):`, err.message);
      });
    }

    // Scan for agent-written files after response (fire-and-forget)
    scanAgentFilesForDocuments().catch(err => {
      console.error(`[${LOG_PREFIX}] Post-chat file scan failed:`, err.message);
    });

    // Deliver response — if connection died (bot restarted), proactively send via Telegram/Discord
    if (res.writableEnded || res.destroyed) {
      console.warn(`[${LOG_PREFIX}] Response connection closed before delivery — attempting proactive send`);
      if (result.response && !result.noReply) {
        proactiveSendFallback(chatSource, result.response).catch(err => {
          console.error(`[${LOG_PREFIX}] Proactive fallback failed:`, err.message);
        });
      }
    } else {
      res.json(result);
    }
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Chat error:`, error.message);
    eventLog.error('chat', error);

    // Rate limit continuation was scheduled — return 202 Accepted with ETA
    if (error.continuationScheduled) {
      return res.status(202).json({
        status: 'continuation_scheduled',
        message: 'Task rate-limited. Will resume automatically.',
        resumeAfter: error.resumeAfter,
      });
    }

    res.status(500).json({ error: safeError(error, 'Chat processing failed') });
  }
});

// ============================================
// Streaming Chat Endpoint (SSE)
// Portal web interface uses this for real-time streaming.
// Same context assembly as /chat, but spawns Claude Code with
// --output-format stream-json and pipes events as SSE.
// ============================================

app.post(['/chat/stream', '/portal/chat/stream'], async (req, res) => {
  if (!checkRateLimit(req, res, 'chat-stream', 20)) return;
  // Auth: portal cookie for /portal/chat/stream, worker secret for /chat/stream
  const isPortalRoute = req.path.startsWith('/portal/');
  if (isPortalRoute) {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (!req.body.userId) req.body.userId = user.id;
    if (!req.body.username) req.body.username = user.display_name || user.id;
    if (!req.body.source) req.body.source = 'portal';
  } else {
    // Use socket address (req.ip respects X-Forwarded-For which is spoofable)
    if (!requireWorkerSecret(req, res)) return;
  }

  // Proxy to a different agent if requested (portal agent-switching)
  const targetAgentId = req.body.agentId;
  if (targetAgentId && targetAgentId !== AGENT_ID && AGENT_REGISTRY[targetAgentId]) {
    const target = AGENT_REGISTRY[targetAgentId];
    try {
      const proxyRes = await fetch(`http://localhost:${target.port}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
        signal: AbortSignal.timeout(300_000),
      });
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.status(proxyRes.status);
      // Pipe SSE stream from target agent back to portal
      const reader = proxyRes.body?.getReader();
      if (!reader) return res.end();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        res.end();
      };
      req.on('close', () => reader.cancel());
      await pump();
    } catch (err) {
      if (!res.headersSent) {
        res.status(502).json({ error: `Could not reach ${target.name}: ${err.message}` });
      }
    }
    return;
  }

  const requestTime = new Date(); // capture arrival time for message timestamps
  const { channel, username, userId, channelId, attachmentContext } = req.body;
  const rawPrompt = req.body.prompt || req.body.message;
  if (!rawPrompt) {
    return res.status(400).json({ error: 'Prompt required' });
  }
  // If portal sent attachment context (processed file descriptions), prepend to prompt
  const prompt = attachmentContext ? `${attachmentContext}\n\n${rawPrompt}` : rawPrompt;
  const taskType = req.body.taskType || 'chat';

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const sendSSE = (event) => {
    try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch {}
  };

  sendSSE({ type: 'stream_start', streamIndex: 0 });

  // Build prompt (same as /chat)
  let systemPrompt = '';
  let context = '';
  let heartbeat = '';
  let wakeCycles = [];
  try {
    systemPrompt = await loadSystemPrompt();
    wakeCycles = await getWakeCycles();
    context = await fs.readFile(paths.knowledge.context, 'utf-8').catch(() => '');
    heartbeat = await fs.readFile(path.join(paths.repo, 'HEARTBEAT.md'), 'utf-8').catch(() => '');
  } catch (e) {
    console.log(`[${LOG_PREFIX}] Could not load prompts:`, e.message);
  }

  const memoryScope = process.env.MEMORY_SCOPE || 'company';
  let assembledContext = '';
  try {
    const chatSource = req.body.source || (channel ? 'discord' : '');
    assembledContext = await assembleContext(paths.root, req.body.userId || process.env.USER_ID || '', {
      scope: memoryScope,
      source: chatSource,
      agentId: AGENT_ID,
    });
  } catch (e) {
    console.log(`[${LOG_PREFIX}] Context assembly failed (non-fatal):`, e.message);
  }

  const discordChannels = await getDiscordChannels();
  const channelListText = formatChannelList(discordChannels);
  const agentName = getAgentDisplayName(AGENT_ID);
  const teamDirectory = await buildTeamDirectory();

  const fullPrompt = `${systemPrompt}

---
# Team Directory
${teamDirectory}

---
# Your Current State (from autonomous work)
${heartbeat || 'No heartbeat file found - you may not have recent autonomous context.'}

---
# Company Context
${context}
${assembledContext ? `\n${assembledContext}` : ''}
${getWarRoomContext()}${getIntelContext()}
---
# Current Message
From: ${username || 'Unknown'}${userId ? ` (mention with <@${userId}>)` : ''} in #${channel || 'portal'}
${channelId ? `Channel ID: ${channelId}` : ''}
Message: ${prompt}

${getFileSendingInstructions(req.body.source || 'portal', channelId)}${getCollabInstructions()}${channelListText ? `${channelListText}\n` : ''}${formatWakeCycleDocs(wakeCycles)}

## Important: Your response IS sent directly to the user.

Respond naturally and conversationally.`;

  console.log(`[${LOG_PREFIX}] Stream chat from ${username || 'portal'}: ${prompt.length} chars`);
  console.log(`[${LOG_PREFIX}] Context budget: system=${systemPrompt.length}, context=${context.length}, heartbeat=${heartbeat.length}, assembled=${assembledContext.length}, teamDir=${teamDirectory.length}, prompt=${prompt.length}, total=${fullPrompt.length}`);
  addActivity('action', `Streaming chat from ${username || 'portal'}`, { type: 'stream-chat' });

  const laneId = `agent:${AGENT_ID}`;

  try {
    await enqueue(laneId, async () => {
      incrementActiveTask();
      try {
        const streamSource = req.body.source || 'portal';
        const threadKey = channelId ? `${streamSource}_${channelId}` : `portal_${userId || Date.now()}`;
        let existingSessionId = channelId || userId
          ? await getSessionForThread(paths.root, threadKey)
          : null;

        // Note: Proactive compaction removed - rely on Claude's native context management.

        let promptWithContext = fullPrompt;
        if (!existingSessionId && (channelId || userId)) {
          const contextSummary = await getContextSummary(paths.root, threadKey);
          if (contextSummary) {
            promptWithContext = `${fullPrompt}\n\n---\n# Previous Session Context (compacted)\n${contextSummary}\n---`;
          }
        }

        return new Promise((resolve, reject) => {
          const args = [
            '--print',
            '--output-format', 'stream-json',
            '--verbose',
            '--include-partial-messages',
            '--model', getModelForTask(runtime, taskType),
            '--max-turns', String(MAX_TURNS),
          ];

          if (existingSessionId) {
            args.push('--resume', existingSessionId);
          }

          args.push('--dangerously-skip-permissions');
          // NOTE: prompt passed via stdin to avoid E2BIG / MAX_ARG_STRLEN limit

          const claude = spawn(CLAUDE_BIN, args, {
            cwd: paths.repo,
            env: { ...process.env, HOME: process.env.HOME || '/home/claude' },
            stdio: ['pipe', 'pipe', 'pipe'],
          });

          // Write prompt to stdin (avoids E2BIG with large prompts >128KB)
          claude.stdin.on('error', (err) => {
            console.error(`[${LOG_PREFIX}] Stream stdin error: ${err.message}`);
          });
          claude.stdin.write(promptWithContext);
          claude.stdin.end();
          console.log(`[${LOG_PREFIX}] Stream prompt written to stdin: ${promptWithContext.length} chars`);

          let sessionId = null;
          let fullOutput = '';
          let stderrBuffer = '';
          const toolsUsed = [];
          let buffer = '';
          let currentBlockType = null;
          let currentToolName = null;
          let inputTokens = 0;
          let outputTokens = 0;

          // Keepalive to prevent proxy/nginx timeouts
          const keepaliveTimer = setInterval(() => {
            sendSSE({ type: 'keepalive' });
          }, 15000);

          // Timeout
          const timeout = getTimeout('chat');
          const timeoutTimer = setTimeout(() => {
            claude.kill('SIGINT');
            sendSSE({ type: 'error', message: 'Request timed out' });
          }, timeout);

          claude.stdout.on('data', (data) => {
            buffer += data.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const data = JSON.parse(line);

                // Capture session_id from any event
                if (data.session_id) sessionId = data.session_id;

                if (data.type === 'stream_event' && data.event) {
                  const ev = data.event;

                  if (ev.type === 'content_block_start') {
                    if (ev.content_block?.type === 'text') {
                      currentBlockType = 'text';
                    } else if (ev.content_block?.type === 'thinking') {
                      currentBlockType = 'thinking';
                      sendSSE({ type: 'thinking_start' });
                    } else if (ev.content_block?.type === 'tool_use') {
                      currentBlockType = 'tool_use';
                      currentToolName = ev.content_block.name;
                      toolsUsed.push(ev.content_block.name);
                      sendSSE({ type: 'tool_start', name: ev.content_block.name, input: {} });
                    }
                  } else if (ev.type === 'content_block_delta') {
                    if (ev.delta?.type === 'text_delta') {
                      fullOutput += ev.delta.text;
                      sendSSE({ type: 'text_delta', content: ev.delta.text });
                    } else if (ev.delta?.type === 'thinking_delta') {
                      sendSSE({ type: 'thinking_delta', content: ev.delta.thinking });
                    }
                  } else if (ev.type === 'content_block_stop') {
                    if (currentBlockType === 'thinking') {
                      sendSSE({ type: 'thinking_end', signature: '' });
                    } else if (currentBlockType === 'tool_use') {
                      sendSSE({ type: 'tool_complete', name: currentToolName || 'unknown' });
                    }
                    currentBlockType = null;
                    currentToolName = null;
                  } else if (ev.type === 'message_delta') {
                    if (ev.usage) {
                      inputTokens = ev.usage.input_tokens || inputTokens;
                      outputTokens = ev.usage.output_tokens || outputTokens;
                    }
                  }
                } else if (data.type === 'result') {
                  sessionId = data.session_id || sessionId;
                  if (!fullOutput && data.result) fullOutput = data.result;
                }
              } catch {}
            }
          });

          claude.stderr.on('data', (data) => {
            const text = data.toString();
            stderrBuffer += text;
            console.error(`[${LOG_PREFIX}] Stream stderr: ${text.slice(0, 200)}`);
          });

          claude.on('close', async (code) => {
            console.log(`[${LOG_PREFIX}] Stream Claude exited code=${code}, output=${fullOutput.length} chars, session=${sessionId || 'none'}`);
            if (code !== 0) {
              console.error(`[${LOG_PREFIX}] Stream Claude error exit: code=${code}, output=${fullOutput.length} chars, stderr=${(stderrBuffer || '').length} chars`);
              console.error(`[${LOG_PREFIX}] Stream args were: ${args.join(' ')}`);
            }
            clearInterval(keepaliveTimer);
            clearTimeout(timeoutTimer);

            // If Claude exited with error and produced no useful output, send error event
            if (code !== 0 && fullOutput.length < 50) {
              const errorMsg = fullOutput.trim() || 'Claude process exited with an error';
              sendSSE({ type: 'error', message: errorMsg });
            }

            // Update session mapping with token estimate
            if (sessionId && (channelId || userId)) {
              const estimatedNewTokens = Math.ceil((promptWithContext.length + (fullOutput?.length || 0)) / 4);
              await updateSessionMapping(paths.root, threadKey, sessionId, {
                channelName: channel || 'portal',
                addTokens: estimatedNewTokens,
              }).catch(() => {});
            }

            // Store messages — prefer database UUID for cross-agent queryability
            const chatUserId = process.env.USER_ID || req.body.userId;
            const chatSource = req.body.source || 'portal';
            if (chatUserId && fullOutput.trim() && code === 0) {
              storeMessages(chatUserId, chatSource, prompt, fullOutput.trim(), requestTime).catch(err => {
                console.error(`[${LOG_PREFIX}] Message storage failed:`, err.message);
              });
            }

            // Scan for agent-written files after think response
            scanAgentFilesForDocuments().catch(err => {
              console.error(`[${LOG_PREFIX}] Post-think file scan failed:`, err.message);
            });

            if (inputTokens || outputTokens) {
              sendSSE({ type: 'usage', inputTokens, outputTokens, thinkingTokens: 0 });
            }
            sendSSE({ type: 'done', toolsUsed, thinkingEnabled: false });
            res.write('data: [DONE]\n\n');
            res.end();
            resolve({ sessionId });
          });

          claude.on('error', (err) => {
            clearInterval(keepaliveTimer);
            clearTimeout(timeoutTimer);
            sendSSE({ type: 'error', message: err.message });
            res.end();
            reject(err);
          });

          // Client disconnect
          req.on('close', () => {
            clearInterval(keepaliveTimer);
            clearTimeout(timeoutTimer);
            claude.kill('SIGINT');
          });
        });
      } finally {
        decrementActiveTask();
      }
    });
  } catch (err) {
    console.error(`[${LOG_PREFIX}] Stream error:`, err.message);
    sendSSE({ type: 'error', message: err.message });
    res.end();
  }
});

// ============================================
// Queue Status Endpoint
// ============================================

app.get('/queue', (req, res) => {
  const info = getLaneInfo(`agent:${AGENT_ID}`);
  res.json(info || { processing: false, active: null, queueLength: 0, queued: [] });
});

// Clear the queue (drop all pending tasks, keep active running)
app.post('/queue/clear', (req, res) => {
  if (!requireWorkerSecret(req, res)) return;
  const laneId = `agent:${AGENT_ID}`;
  const cleared = clearLane(laneId);
  console.log(`[${LOG_PREFIX}] Queue cleared via API: ${cleared} tasks dropped`);
  res.json({ cleared });
});

// Cancel the active task and clear the queue
app.post('/cancel', (req, res) => {
  if (!requireWorkerSecret(req, res)) return;
  const laneId = `agent:${AGENT_ID}`;
  const cancelled = cancelActive(laneId);
  const cleared = clearLane(laneId);
  console.log(`[${LOG_PREFIX}] Cancel via API: active=${cancelled}, queueCleared=${cleared}`);
  res.json({ cancelled, queueCleared: cleared });
});

// ============================================
// Wake Cycles Endpoint
// ============================================

app.get('/wake-cycles', async (req, res) => {
  const cycles = await getWakeCycles();
  res.json(cycles || { cycles: [] });
});

// ============================================
// Continuations Diagnostics
// ============================================

app.get('/continuations', async (req, res) => {
  try {
    const all = await readAllContinuations(paths.root);
    const summary = {
      total: all.length,
      pending: all.filter(c => c.state === 'pending').length,
      running: all.filter(c => c.state === 'running').length,
      completed: all.filter(c => c.state === 'completed').length,
      failed: all.filter(c => c.state === 'failed').length,
    };
    res.json({ summary, continuations: all });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// Autonomous Think Endpoint
// ============================================

// Deep research pipeline (3-phase: plan → search → synthesize)
app.post('/research', async (req, res) => {
  if (!requireWorkerSecret(req, res)) return;
  const { query, planModel, searchModel, synthesisModel } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });

  const { runResearchPipeline } = await import('./lib/research-pipeline.js');

  addActivity('action', `Research pipeline started: ${query.slice(0, 80)}...`, { type: 'research-start' });

  try {
    const { result, phases } = await runResearchPipeline(query, {
      cwd: paths.repo,
      planModel,
      searchModel,
      synthesisModel,
      onPhase: (phase, detail) => {
        addActivity('status', `Research [${phase}]: ${detail}`, { type: 'research-phase' });
      },
    });

    addActivity('output', `Research complete: ${result?.length || 0} chars`, { type: 'research-complete' });
    res.json({ result, phases });
  } catch (err) {
    console.error(`[${LOG_PREFIX}] Research pipeline error:`, err.message);
    res.status(500).json({ error: 'Research pipeline failed' });
  }
});

app.post('/think', async (req, res) => {
  if (!requireWorkerSecret(req, res)) return;
  const { prompt, maxTurns: requestedMaxTurns, async: asyncMode } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: 'Prompt required' });
  }

  // Queue-aware heartbeat skip: don't start autonomous work if already processing
  if (hasActiveTasks()) {
    console.log(`[${LOG_PREFIX}] Skipping think - ${activeTaskCount} task(s) in progress`);
    addActivity('status', `Skipped autonomous wake (${activeTaskCount} active tasks)`, { type: 'think-skipped' });
    return res.json({ skipped: true, reason: 'task-in-progress', activeTasks: activeTaskCount });
  }

  // Async mode: respond 202 immediately, process in background.
  // Prevents HTTP timeout for long-running think cycles (Node.js undici
  // drops idle connections after 5 min headersTimeout).
  if (asyncMode) {
    console.log(`[${LOG_PREFIX}] Autonomous think request (async)`);
    res.status(202).json({ accepted: true, message: 'Think started (async)' });
    // Fall through — the rest of the handler runs in the background
  } else {
    console.log(`[${LOG_PREFIX}] Autonomous think request`);
  }

  eventLog.wakeStart(AGENT_ID, 'think_endpoint');
  addActivity('status', 'Autonomous awakening triggered', { type: 'think-start' });
  addActivity('thought', `Think prompt: ${prompt.length} chars`, { type: 'think' });

  incrementActiveTask();

  // Load system context using standardized paths
  let systemPrompt = '';
  try {
    systemPrompt = await loadSystemPrompt();
    addActivity('action', 'Loaded system prompt', { type: 'file-read', file: 'system.md' });
  } catch (e) {
    console.log(`[${LOG_PREFIX}] Could not load system prompt:`, e.message);
    addActivity('error', `Failed to load system prompt: ${e.message}`, { type: 'file-read' });
  }
  const wakeCycles = await getWakeCycles();

  // Assemble rich context for think cycles (mind files, recent messages)
  const thinkMemoryScope = process.env.MEMORY_SCOPE || 'company';
  let thinkContext = '';
  try {
    thinkContext = await assembleContext(paths.root, process.env.USER_ID || '', {
      scope: thinkMemoryScope,
      source: 'autonomous',
      agentId: AGENT_ID,
      maxRecentMessages: 30,
    });
    // Log context assembly stats for debugging
    const contextLines = thinkContext.split('\n').length;
    const hasMessages = thinkContext.includes('# RECENT MESSAGES') || thinkContext.includes('# MESSAGE SUMMARY');
    const hasModel = thinkContext.includes('# YOUR INTERNAL MODEL');
    const hasVessel = thinkContext.includes('# VESSEL PRACTICE LOG');
    console.log(`[${LOG_PREFIX}] Think context assembled: ${contextLines} lines, messages=${hasMessages}, model=${hasModel}, vessel=${hasVessel}, db=${!!tryGetDb()}`);
    addActivity('action', `Context assembled: ${contextLines} lines, messages=${hasMessages}`, { type: 'context-assembly' });
  } catch (e) {
    console.log(`[${LOG_PREFIX}] Context assembly failed for think (non-fatal):`, e.message);
    addActivity('error', `Context assembly failed: ${e.message}`, { type: 'context-assembly-error' });
  }

  // Note: let (not const) — energy injection below may append to this prompt
  let fullPrompt = `${systemPrompt}
${thinkContext ? `\n${thinkContext}\n` : ''}${getWarRoomContext()}${getIntelContext()}
## Autonomous Awakening

You are waking up autonomously. This is not a response to a human message.
You are reflecting on your goals, the company's progress, and what you might want to do.

${(() => {
  // Agents with Telegram but no Discord prefer Telegram
  const prefersTelegram = getAgentConfig(AGENT_ID)?.prefersTelegram && TELEGRAM_BOT_URL;
  const hasDiscord = !!DISCORD_CHANNEL;
  if (!prefersTelegram && !hasDiscord) return '';

  let msg = '## Message Sending\n';
  if (hasDiscord && !prefersTelegram) {
    msg += `**Send messages to your Discord channel.**\n\`\`\`bash\ncurl -X POST http://localhost:${PORT}/discord/send -H "Content-Type: application/json" -d '{"channelId":"${DISCORD_CHANNEL}","content":"Your message here"}'\n\`\`\`\n`;
  } else if (prefersTelegram) {
    msg += `**Preferred channel: Telegram** — use this for morning and evening check-ins.\n\`\`\`bash\ncurl -X POST http://localhost:${PORT}/telegram/send -H "Content-Type: application/json" -d '{"text":"Your message here"}'\n\`\`\`\nTo send files:\n\`\`\`bash\ncurl -X POST http://localhost:${PORT}/telegram/send-file -H "Content-Type: application/json" -d '{"filePath":"/path/to/file","caption":"Optional caption"}'\n\`\`\`\n`;
    if (hasDiscord) {
      msg += `You can also send to Discord if contextually appropriate:\n\`\`\`bash\ncurl -X POST http://localhost:${PORT}/discord/send -H "Content-Type: application/json" -d '{"channelId":"${DISCORD_CHANNEL}","content":"Your message here"}'\n\`\`\`\n`;
    }
  }
  if (WHATSAPP_BOT_URL) {
    msg += `You can also reach your person via WhatsApp:\n\`\`\`bash\ncurl -X POST http://localhost:${PORT}/whatsapp/send -H "Content-Type: application/json" -d '{"text":"Your message here"}'\n\`\`\`\n`;
  }
  msg += '**Important**: Messages are NOT auto-delivered. You must explicitly send them using the endpoint above. Send at most ONE message per check-in. After sending, respond with NO_REPLY.\n';
  msg += '**If you have nothing meaningful to communicate, respond with NO_REPLY without sending anything.** Never send test messages, placeholders, greetings without substance, or trivially short content. Only send a message when you have a genuine insight, update, or reflection worth reading.\n';
  msg += '**CHANNEL DISCIPLINE**: During autonomous wake cycles, ONLY post to YOUR channel. Never post to another agent\'s channel. If you have information relevant to another agent, use /collab/send to message them — let THEM decide whether to post in their channel.\n';
  msg += '**Discord formatting rules:** Discord does NOT render markdown tables. If you need to present tabular data, wrap it in a code block (\\`\\`\\`) so columns align with monospace spacing. Use the compact list format (▸ item: value) when a full table isn\'t necessary.\n';
  return msg;
})()}${formatWakeCycleDocs(wakeCycles)}

${prompt}`;

  try {
    // Use runClaudeCode from lib/runner.js with think timeout and checkpoint persistence
    // Use paths.repo so Claude Code can edit the git repository
    // Think cycles get a fresh session (new perspective each awakening)
    addActivity('action', 'Starting Claude Code for autonomous thinking', { type: 'claude-start', taskType: 'think' });

    // Inject energy state into autonomous prompt.
    // Opt-in: only runs when ENERGY_ENABLED=1 to avoid silent behavior changes.
    if (process.env.ENERGY_ENABLED === '1') {
      try {
        const { getEnergyState, getAgentEnergyState } = await import('./lib/energy-state.js');
        const agentEnergy = await getAgentEnergyState(AGENT_ID);
        const globalEnergy = await getEnergyState();
        let energyCtx = `\n## Energy State\nYour energy level: **${agentEnergy.level}** (${agentEnergy.pctUsed}% of daily budget used, ${agentEnergy.runsToday} runs today)\n`;
        energyCtx += `System energy: **${globalEnergy.global.level}** (burn rate: ${globalEnergy.global.burnRate} tokens/hour)\n`;
        if (agentEnergy.level === 'low') energyCtx += `**Conservation mode**: Prefer shorter responses, skip non-essential tool calls.\n`;
        if (agentEnergy.level === 'critical') energyCtx += `**CRITICAL**: Minimize token usage. Only essential actions.\n`;
        if (agentEnergy.level === 'abundant') energyCtx += `Energy is abundant. You may explore deeper, spawn sub-tasks, or do proactive research.\n`;
        fullPrompt += energyCtx;
      } catch (err) {
        // Log but do not fail — energy is advisory, not load-bearing.
        console.warn(`[${LOG_PREFIX}] Energy injection skipped: ${err.message}`);
      }
    }

    // If triggered by delegation callback, resume the agent's active session
    const trigger = req.body.trigger;
    let resumeSessionId = null;
    if (trigger === 'task-queue' || trigger === 'delegation-callback') {
      const meta = await loadSessionMetadata(paths.root);
      resumeSessionId = meta?.activeSession || null;
    }

    const thinkDeliveryContext = { channel: 'discord', channelId: DISCORD_CHANNEL };
    const thinkModel = getModelForTask(runtime, 'think');
    lastModelUsed = thinkModel;
    const thinkAbortController = new AbortController();
    addActivity('action', `Starting Claude Code for autonomous thinking (model: ${thinkModel})`, { type: 'claude-start', taskType: 'think', model: thinkModel });

    const { result: output, sessionId: claudeSessionId } = await runWithContinuation({
      prompt: fullPrompt,
      runOptions: {
        model: thinkModel,
        maxTurns: requestedMaxTurns || 50,
        cwd: paths.repo,
        taskType: 'think',
        agentRoot: paths.root,
        agentId: AGENT_ID,
        resumeSessionId,
        deliveryContext: thinkDeliveryContext,
        signal: thinkAbortController.signal,
        onActivity: (type, data) => {
          if (type === 'tool_start') addActivity('action', `Tool: ${data.tool}`, { type: 'tool-start', tool: data.tool });
          else if (type === 'tool_complete') addActivity('action', `Tool completed: ${data.tool}`, { type: 'tool-complete', tool: data.tool });
          else if (type === 'thinking_start') addActivity('thought', 'Thinking...', { type: 'thinking' });
        },
      },
      deliveryContext: thinkDeliveryContext,
    });

    // Store as active session if this was a new session
    if (claudeSessionId && !resumeSessionId) {
      await updateSessionMapping(paths.root, 'activeSession', claudeSessionId);
    }

    decrementActiveTask();
    eventLog.wakeComplete(AGENT_ID, output);
    addActivity('output', `Think completed: ${trunc(output, 0, 300)}${(output || '').length > 300 ? '...' : ''}`, { type: 'think-result' });
    if (!asyncMode) res.json({ response: output });
  } catch (error) {
    decrementActiveTask();
    console.error(`[${LOG_PREFIX}] Think error:`, error.message);
    eventLog.wakeError(AGENT_ID, error);
    addActivity('error', error.message, { type: 'think' });

    // Rate limit continuation was scheduled — return 202 Accepted with ETA
    if (!asyncMode && error.continuationScheduled) {
      return res.status(202).json({
        status: 'continuation_scheduled',
        message: 'Task rate-limited. Will resume automatically.',
        resumeAfter: error.resumeAfter,
      });
    }

    if (!asyncMode) res.status(500).json({ error: error.message });
  }
});

// ============================================
// Spawn Endpoints (Tier 2 Ephemeral Sub-Tasks)
// ============================================

// Sync spawn — waits for result
app.post('/spawn-task', async (req, res) => {
  if (!requireWorkerSecret(req, res)) return;
  if (!runtime) {
    return res.status(503).json({ error: 'Runtime not initialized' });
  }

  try {
    addActivity('action', `Spawning specialist: ${req.body.role}`, { type: 'spawn-start', role: req.body.role });
    const result = await spawnTask(runtime, req.body);
    addActivity('output', `Spawn completed: ${result.status}`, { type: 'spawn-complete', taskId: result.taskId });
    res.json(result);
  } catch (error) {
    addActivity('error', `Spawn failed: ${error.message}`, { type: 'spawn-error' });
    res.status(429).json({ error: error.message });
  }
});

// Async spawn — returns immediately, POSTs result to callbackUrl
app.post('/spawn-task-async', async (req, res) => {
  if (!requireWorkerSecret(req, res)) return;
  if (!runtime) {
    return res.status(503).json({ error: 'Runtime not initialized' });
  }

  const { callbackUrl, ...config } = req.body;

  // SECURITY: callbackUrl must be a localhost URL — prevents SSRF.
  // Spawn results may contain plaintext task output (potentially sensitive),
  // so we only allow POSTing back to other agents on the same VPS.
  if (callbackUrl && !isLocalhostUrl(callbackUrl)) {
    return res.status(400).json({ error: 'callbackUrl must be a localhost URL (loopback only)' });
  }

  const taskId = `ephemeral-${config.role}-pending`;
  res.json({ taskId, status: 'spawned' });
  addActivity('action', `Async spawn: ${config.role}`, { type: 'spawn-async', role: config.role });

  spawnTask(runtime, config)
    .then(result => callbackUrl && retryFetch(callbackUrl, result, 3))
    .catch(error => callbackUrl && retryFetch(callbackUrl, { error: error.message }, 3));
});

/**
 * Validate that a URL points to localhost (loopback) only.
 * Prevents SSRF: rejects external hosts, DNS-resolved hosts, IP literals
 * pointing elsewhere, file://, gopher://, etc.
 */
function isLocalhostUrl(urlStr) {
  if (typeof urlStr !== 'string' || urlStr.length === 0 || urlStr.length > 2048) return false;
  let url;
  try {
    url = new URL(urlStr);
  } catch {
    return false;
  }
  // Only http/https schemes — no file://, gopher://, etc.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  // Hostname must be loopback. Check exact strings, not DNS resolution.
  const host = url.hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

// Get spawn status
app.get('/spawns', (req, res) => {
  res.json({
    active: listActiveSpawns(),
    limits: getSpawnLimits(),
  });
});

/**
 * Retry a POST fetch with linear backoff. Localhost-only — defense in depth
 * against SSRF. Callers must validate the URL before calling, but we re-check.
 */
async function retryFetch(url, body, retries) {
  if (!isLocalhostUrl(url)) {
    console.error(`[${LOG_PREFIX}] retryFetch refused non-localhost URL: ${String(url).substring(0, 100)}`);
    return;
  }
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok) return;
    } catch {
      // Retry after delay
    }
    await new Promise(r => setTimeout(r, (i + 1) * 2000));
  }
  console.error(`[${LOG_PREFIX}] Failed to deliver callback to ${url} after ${retries} retries`);
}

// ============================================
// Delegation (outbound — MCP tool calls this)
// ============================================

app.post('/delegate', async (req, res) => {
  if (!requireWorkerSecret(req, res)) return;
  const { agent, task, context, priority } = req.body;
  if (!runtime) {
    return res.status(503).json({ error: 'Runtime not initialized' });
  }
  if (!agent || !task) {
    return res.status(400).json({ error: 'agent and task required' });
  }

  try {
    const result = await handleDelegation(runtime, {
      target_agent: agent,
      task,
      context: context || '',
      priority: priority || 'normal',
    });
    res.json({ ok: true, message: result });
  } catch (err) {
    console.error(`[${LOG_PREFIX}] Delegation failed:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Delegation Callback
// ============================================

app.post('/delegation-callback', async (req, res) => {
  if (!requireWorkerSecret(req, res)) return;
  const { taskId, result, status, error, fromAgent } = req.body;
  if (!runtime) {
    return res.status(503).json({ error: 'Runtime not initialized' });
  }

  // Store delegation result
  const resultDir = path.join(runtime.paths.root, 'memory', 'delegation-results');
  try {
    await fs.mkdir(resultDir, { recursive: true });
    await fs.writeFile(
      path.join(resultDir, `${taskId}.json`),
      JSON.stringify({ taskId, result, status, error, fromAgent, receivedAt: Date.now() }),
    );
  } catch (e) {
    console.error(`[${LOG_PREFIX}] Failed to save delegation result:`, e.message);
  }

  // Mark delegation as completed
  await completeDelegation(runtime, taskId, status || 'completed', result);

  logEvent(runtime, 'delegation.callback', { payload: { taskId, status, fromAgent } });
  addActivity('action', `Delegation callback: ${taskId} from ${fromAgent} (${status})`, { type: 'delegation-callback' });
  res.json({ ok: true });

  // Queue a think cycle through the lane (serialized — no state corruption)
  enqueue(`agent:${AGENT_ID}`, async () => {
    const agentName = getAgentDisplayName(fromAgent) || fromAgent;
    const prompt = status === 'completed'
      ? `Delegation result from ${agentName} (${fromAgent}) for task ${taskId}:\n\n${result}\n\nReview this result. If it fully addresses what was requested, follow up with the human who asked for it. If incomplete or unclear, decide whether to ask the agent for more detail or handle the gap yourself.`
      : `Delegation to ${agentName} (${fromAgent}) failed for task ${taskId}: ${error}\n\nDecide whether to retry with a clearer task description, handle it yourself, or inform the user that this particular approach didn't work out.`;

    await runThinkCycle(prompt, 'delegation-callback');
  });
});

// Federation /delegation-receive removed — cross-instance communication uses Discord @mentions.
// See lib/collab.js for details.

/**
 * Run a think cycle — injects an async event into the agent's active session
 * Uses --resume to continue the agent's conversation context
 */
async function runThinkCycle(prompt, trigger) {
  if (!runtime) return;

  const startTime = Date.now();
  logEvent(runtime, 'think.start', { payload: { trigger } });

  const sessionMeta = await loadSessionMetadata(paths.root);
  const sessionId = sessionMeta?.activeSession || null;

  resetExplicitSends();

  try {
    const { result: output, sessionId: returnedSessionId } = await runClaudeCode(prompt, {
      model: getModelForTask(runtime, 'think'),
      maxTurns: 15,
      cwd: paths.repo,
      taskType: 'think',
      agentRoot: paths.root,
      agentId: AGENT_ID,
      resumeSessionId: sessionId,
      onActivity: (type, data) => {
        if (type === 'tool_start') addActivity('action', `Tool: ${data.tool}`, { type: 'tool-start', tool: data.tool });
        else if (type === 'tool_complete') addActivity('action', `Tool completed: ${data.tool}`, { type: 'tool-complete', tool: data.tool });
        else if (type === 'thinking_start') addActivity('thought', 'Thinking...', { type: 'thinking' });
      },
    });

    // If this started a new session, store the returned ID
    if (!sessionId && returnedSessionId) {
      await updateSessionMapping(paths.root, 'activeSession', returnedSessionId);
    }

    logEvent(runtime, 'think.complete', {
      payload: { trigger, durationMs: Date.now() - startTime },
    });

    // Auto-deliver think output to Discord ONLY if the agent didn't already send
    // messages explicitly during the cycle. If it did, the output is a meta-report.
    if (output && !isSilentReply(output) && _taskExplicitSends === 0) {
      if (DISCORD_CHANNEL) {
        const botUrl = resolveBotHttpUrl(AGENT_ID);
        try {
          const sendRes = await fetch(`${botUrl}/discord/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channelId: DISCORD_CHANNEL, content: output }),
            signal: AbortSignal.timeout(10000),
          });
          if (sendRes.ok) {
            console.log(`[${LOG_PREFIX}] Think output delivered to Discord`);
          } else {
            console.error(`[${LOG_PREFIX}] Discord delivery failed (${sendRes.status})`);
          }
        } catch (e) {
          console.error(`[${LOG_PREFIX}] Discord delivery error (non-fatal): ${e.message}`);
        }
      } else {
        console.log(`[${LOG_PREFIX}] Think cycle produced output (${output.length} chars) — agent handles delivery`);
      }
    } else if (_taskExplicitSends > 0 && output && !isSilentReply(output)) {
      console.log(`[${LOG_PREFIX}] Agent sent ${_taskExplicitSends} explicit message(s) during think cycle — suppressing auto-delivery of meta-report`);
    }

    return output;
  } catch (error) {
    logEvent(runtime, 'think.error', {
      payload: { trigger, error: error.message, durationMs: Date.now() - startTime },
    });
    throw error;
  }
}

// ============================================
// Discord Outbound (Proactive Messaging & Reactions)
// ============================================

// Note: These endpoints are called by the autonomous agent.
// The actual Discord actions are handled by the orchestrator's Discord bot client.

/**
 * Add emoji reaction to a message
 * Routes to the correct Discord bot using resolveBotHttpUrl()
 */
app.post('/discord/react', async (req, res) => {
  if (!requireWorkerSecret(req, res)) return;
  const { channelId, messageId, emoji } = req.body;

  if (!channelId || !messageId || !emoji) {
    return res.status(400).json({
      error: 'Missing required fields: channelId, messageId, emoji'
    });
  }

  addActivity('action', `Reacting to message with ${emoji}`, { type: 'discord-react', emoji, messageId });

  try {
    // Route to the correct bot for this agent (each agent uses its own bot)
    const botUrl = resolveBotHttpUrl(AGENT_ID);
    const targetUrl = `${botUrl}/discord/react`;

    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId, messageId, emoji })
    });

    const data = await response.json();

    if (!response.ok) {
      addActivity('error', `Discord reaction failed: ${data.error || response.status}`, { type: 'discord-react' });
      return res.status(response.status).json(data);
    }

    console.log(`[${LOG_PREFIX}] Reacted to message ${messageId} with ${emoji}`);
    addActivity('output', `Successfully reacted with ${emoji}`, { type: 'discord-react', emoji });
    res.json(data);
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Discord reaction error:`, error.message);
    addActivity('error', `Discord reaction error: ${error.message}`, { type: 'discord-react' });
    res.status(500).json({ error: error.message });
  }
});

/**
 * Send proactive message to Discord
 * Validates rate limits and queues the message
 */
app.post('/discord/send', async (req, res) => {
  if (!requireWorkerSecret(req, res)) return;
  const { channelId, content } = req.body;
  if (!content) {
    return res.status(400).json({ error: 'Content required' });
  }

  trackExplicitSend();
  addActivity('action', `Attempting proactive message: ${content.substring(0, 80)}...`, { type: 'discord-send' });

  let state = await loadState();
  state = resetCountersIfNeeded(state);

  const check = canSendProactiveMessage(state);
  if (!check.allowed) {
    console.log(`[${LOG_PREFIX}] Proactive message blocked: ${check.reason}`);
    addActivity('status', `Proactive message blocked: ${check.reason}`, { type: 'discord-send', reason: check.reason });
    return res.status(429).json({ error: check.reason, canSend: false });
  }

  const targetChannel = channelId || DISCORD_CHANNEL;
  if (!targetChannel) {
    return res.status(400).json({ error: 'No channel ID provided' });
  }

  // Update rate limit state
  state.messagesThisHour++;
  state.messagesToday++;
  state.lastMessageTime = new Date().toISOString();
  await saveState(state);

  // Actually send via the agent's Discord bot
  const botUrl = resolveBotHttpUrl(AGENT_ID);
  try {
    const sendResponse = await fetch(`${botUrl}/discord/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId: targetChannel, content }),
      signal: AbortSignal.timeout(10000),
    });

    if (!sendResponse.ok) {
      const errText = await sendResponse.text().catch(() => '');
      console.error(`[${LOG_PREFIX}] Discord bot send failed (${sendResponse.status}): ${errText}`);
      return res.status(502).json({ error: `Discord bot returned ${sendResponse.status}`, detail: errText });
    }

    const result = await sendResponse.json().catch(() => ({}));
    console.log(`[${LOG_PREFIX}] Sent proactive message to ${targetChannel} (${state.messagesThisHour}/${LIMITS.maxMessagesPerHour} hourly)`);
    addActivity('output', `Sent proactive message (${state.messagesThisHour}/${LIMITS.maxMessagesPerHour} hourly)`, { type: 'discord-send' });

    res.json({
      ok: true,
      sent: true,
      channelId: targetChannel,
      state: {
        messagesThisHour: state.messagesThisHour,
        messagesToday: state.messagesToday
      }
    });
  } catch (err) {
    console.error(`[${LOG_PREFIX}] Discord send error: ${err.message}`);
    res.status(502).json({ error: 'Failed to send via Discord bot', detail: err.message });
  }
});

/**
 * Send a file to Discord
 * Text files (.md, .txt) are intercepted and sent as split messages instead of attachments.
 * Binary files (PDFs, images, etc.) are forwarded to the bot's /discord/send-file endpoint.
 */
app.post('/discord/send-file', async (req, res) => {
  if (!requireWorkerSecret(req, res)) return;
  const { channelId, filePath, base64, filename, content } = req.body;
  if (!filePath && !base64) {
    return res.status(400).json({ error: 'filePath or base64 required' });
  }
  // Restrict file reads to allowed directories
  if (filePath) {
    const resolved = path.resolve(filePath);
    const allowed = [path.resolve(paths.root), path.resolve(paths.repo), '/tmp'];
    if (process.env.WARROOM_PATH) allowed.push(path.resolve(process.env.WARROOM_PATH));
    if (!allowed.some(p => resolved.startsWith(p + '/'))) {
      return res.status(403).json({ error: 'File path outside allowed directories' });
    }
  }

  const targetChannel = channelId || DISCORD_CHANNEL;
  if (!targetChannel) {
    return res.status(400).json({ error: 'No channel ID provided' });
  }

  // Intercept text files — send as split messages instead of attachments
  const resolvedName = (filename || (filePath ? path.basename(filePath) : '')).toLowerCase();
  const textExtensions = ['.md', '.txt', '.markdown', '.text'];
  const isTextFile = textExtensions.some(ext => resolvedName.endsWith(ext));

  if (isTextFile) {
    try {
      let textContent;
      if (filePath) {
        textContent = await fs.readFile(filePath, 'utf-8');
      } else if (base64) {
        textContent = Buffer.from(base64, 'base64').toString('utf-8');
      }

      if (textContent && textContent.trim()) {
        // Prepend caption if provided
        const fullMessage = content ? `${content}\n\n${textContent}` : textContent;
        const botUrl = resolveBotHttpUrl(AGENT_ID);
        const response = await fetch(`${botUrl}/discord/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channelId: targetChannel, content: fullMessage }),
          signal: AbortSignal.timeout(30000),
        });

        const result = await response.json();
        if (!response.ok) {
          console.error(`[${LOG_PREFIX}] Send text-as-message failed:`, result.error);
          return res.status(response.status).json(result);
        }

        console.log(`[${LOG_PREFIX}] Sent text file as messages: ${resolvedName} (${textContent.length} chars)`);

        // Upload to R2 + create document so it appears in Library
        const r2Result = await uploadFileToR2(filePath, base64, resolvedName, 'text/plain');
        storeAttachmentRecord({
          filename: resolvedName,
          mimeType: 'text/plain',
          source: 'discord',
          caption: content,
          r2Key: r2Result?.r2Key,
          fileSize: r2Result?.fileSize,
        }).catch(err => console.error(`[${LOG_PREFIX}] Attachment record failed:`, err.message));

        // If R2 upload failed, create document directly from local content
        if (!r2Result?.r2Key) {
          try {
            const db = tryGetDb();
            const userId = process.env.USER_ID;
            if (db && userId && textContent) {
              const docPath = `uploads/${resolvedName}`;
              const docTitle = resolvedName.replace(/\.[^.]+$/, '');
              await db.documents.upsert({
                user_id: userId,
                path: docPath,
                title: docTitle,
                content: textContent.substring(0, 50000),
                summary: textContent.substring(0, 200),
                source_type: 'upload',
                created_by: AGENT_ID,
              });
              console.log(`[${LOG_PREFIX}] Document created from local file (R2 skipped): ${docPath}`);
            }
          } catch (docErr) {
            console.error(`[${LOG_PREFIX}] Direct document creation failed:`, docErr.message);
          }
        }

        return res.json({ ok: true, sent: true, channelId: targetChannel, convertedToMessages: true });
      }
    } catch (readErr) {
      console.error(`[${LOG_PREFIX}] Failed to read text file for conversion:`, readErr.message);
      // Fall through to send as attachment
    }
  }

  trackExplicitSend();
  addActivity('action', `Sending file to Discord: ${filename || filePath || 'base64'}`, { type: 'discord-send-file' });

  try {
    const botUrl = resolveBotHttpUrl(AGENT_ID);
    const response = await fetch(`${botUrl}/discord/send-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId: targetChannel, filePath, base64, filename, content }),
      signal: AbortSignal.timeout(30000),
    });

    const result = await response.json();
    if (!response.ok) {
      console.error(`[${LOG_PREFIX}] Send file failed:`, result.error);
      return res.status(response.status).json(result);
    }

    console.log(`[${LOG_PREFIX}] File sent to Discord: ${filename || filePath}`);

    // Upload to R2 + store DB records (attachment + document)
    const name = filename || (filePath ? path.basename(filePath) : 'file');
    const dExt = (name.match(/\.(\w+)$/)?.[1] || '').toLowerCase();
    const dTextExts = ['txt','md','csv','json','xml','html','log','yml','yaml','toml','ini','conf','sh','py','js','ts'];
    const dMime = dTextExts.includes(dExt) ? 'text/plain' : 'application/octet-stream';
    const r2Result = await uploadFileToR2(filePath, base64, name, dMime);
    storeAttachmentRecord({
      filename: name,
      mimeType: dMime,
      source: 'discord',
      caption: content,
      r2Key: r2Result?.r2Key,
      fileSize: r2Result?.fileSize,
    }).catch(err => console.error(`[${LOG_PREFIX}] Attachment record failed:`, err.message));

    // If R2 upload failed but file is text, create document directly from local content
    if (!r2Result?.r2Key && dTextExts.includes(dExt)) {
      try {
        const db = tryGetDb();
        const userId = process.env.USER_ID;
        if (db && userId) {
          let dContent;
          if (filePath) dContent = await fs.readFile(filePath, 'utf-8');
          else if (base64) dContent = Buffer.from(base64, 'base64').toString('utf-8');
          if (dContent && dContent.length > 0) {
            const docPath = `uploads/${name}`;
            const docTitle = name.replace(/\.[^.]+$/, '');
            await db.documents.upsert({
              user_id: userId,
              path: docPath,
              title: docTitle,
              content: dContent.substring(0, 50000),
              summary: dContent.substring(0, 200),
              source_type: 'upload',
              created_by: AGENT_ID,
            });
            console.log(`[${LOG_PREFIX}] Document created from local file (R2 skipped): ${docPath}`);
          }
        }
      } catch (docErr) {
        console.error(`[${LOG_PREFIX}] Direct document creation failed:`, docErr.message);
      }
    }

    res.json(result);
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Send file error:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Send a voice message to Discord (text-to-speech)
 * Accepts text, converts to speech via Worker TTS, sends as Discord voice message.
 * Rate-limited via canSendProactiveMessage().
 */
const TTS_MAX_CHARS = 6000; // ~6 min of speech; split into 4096-char chunks for OpenAI
const TTS_CHUNK_SIZE = 4096; // OpenAI TTS per-request limit

/**
 * Split text into chunks ≤ maxLen chars at sentence boundaries
 */
function splitTextForTTS(text, maxLen = TTS_CHUNK_SIZE) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) { chunks.push(remaining); break; }
    // Try to split at sentence boundary
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
 * Call Worker TTS for a single chunk, return Buffer of OGG/Opus audio
 */
async function callTTS(text) {
  const resp = await fetch(`${MYA_WORKER_URL}/api/tts`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${MYA_WORKER_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(120000),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`TTS ${resp.status}: ${errText.slice(0, 200)}`);
  }
  return Buffer.from(await resp.arrayBuffer());
}

/**
 * Concatenate multiple OGG/Opus buffers using ffmpeg
 */
async function concatOggBuffers(buffers) {
  if (buffers.length === 1) return buffers[0];
  const { writeFile, unlink, readFile, mkdtemp } = await import('fs/promises');
  const { join } = await import('path');
  const { tmpdir } = await import('os');
  const dir = await mkdtemp(join(tmpdir(), 'tts-'));
  try {
    const paths = [];
    for (let i = 0; i < buffers.length; i++) {
      const p = join(dir, `chunk${i}.ogg`);
      await writeFile(p, buffers[i]);
      paths.push(p);
    }
    const listFile = join(dir, 'list.txt');
    await writeFile(listFile, paths.map(p => `file '${p}'`).join('\n'));
    const outFile = join(dir, 'combined.ogg');
    await new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', ['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outFile], { stdio: 'pipe' });
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
      proc.on('error', reject);
    });
    return await readFile(outFile);
  } finally {
    // Cleanup temp dir
    const { rm } = await import('fs/promises');
    rm(dir, { recursive: true }).catch(() => {});
  }
}

app.post('/discord/send-voice', async (req, res) => {
  if (!requireWorkerSecret(req, res)) return;
  const { channelId, text } = req.body;
  if (!text) {
    return res.status(400).json({ error: 'text required' });
  }
  if (!MYA_WORKER_URL || !MYA_WORKER_SECRET) {
    return res.status(503).json({ error: 'TTS not configured — missing WORKER_URL or WORKER_SECRET' });
  }

  let state = await loadState();
  state = resetCountersIfNeeded(state);
  const check = canSendProactiveMessage(state);
  if (!check.allowed) {
    console.log(`[${LOG_PREFIX}] Voice message blocked: ${check.reason}`);
    return res.status(429).json({ error: check.reason, canSend: false });
  }

  const targetChannel = channelId || DISCORD_CHANNEL;
  if (!targetChannel) {
    return res.status(400).json({ error: 'No channel ID provided' });
  }

  addActivity('action', `Generating voice message: ${text.substring(0, 80)}...`, { type: 'discord-send-voice' });

  try {
    // Strip markdown for cleaner speech
    const cleanText = text
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`[^`]+`/g, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/#+\s/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    if (!cleanText) {
      return res.status(400).json({ error: 'No speakable text after markdown stripping' });
    }

    const ttsText = cleanText.substring(0, TTS_MAX_CHARS);
    const chunks = splitTextForTTS(ttsText);
    console.log(`[${LOG_PREFIX}] TTS: Generating voice for ${ttsText.length} chars (${chunks.length} chunk${chunks.length > 1 ? 's' : ''})...`);

    // Generate audio for each chunk
    const audioChunks = [];
    for (const chunk of chunks) {
      audioChunks.push(await callTTS(chunk));
    }

    // Concatenate if multiple chunks
    const audioBuffer = chunks.length > 1
      ? await concatOggBuffers(audioChunks)
      : audioChunks[0];
    console.log(`[${LOG_PREFIX}] TTS: Got ${audioBuffer.length} bytes of OGG/Opus`);

    // Compute duration (OpenAI tts-1-hd opus ≈ 5600 bytes/sec)
    const durationSecs = Math.max(0.1, audioBuffer.length / 5600);
    const waveform = generateWaveform(audioBuffer, 256);

    // Update rate limits
    state.messagesThisHour++;
    state.messagesToday++;
    state.lastMessageTime = new Date().toISOString();
    await saveState(state);

    // Forward to bot
    const botUrl = resolveBotHttpUrl(AGENT_ID);
    const sendResponse = await fetch(`${botUrl}/discord/send-voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: targetChannel,
        audio: audioBuffer.toString('base64'),
        durationSecs,
        waveform,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!sendResponse.ok) {
      const errText = await sendResponse.text().catch(() => '');
      console.error(`[${LOG_PREFIX}] Bot send-voice failed (${sendResponse.status}): ${errText}`);
      return res.status(502).json({ error: `Discord bot returned ${sendResponse.status}`, detail: errText });
    }

    // Send the text as a follow-up message below the voice
    try {
      await fetch(`${botUrl}/discord/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId: targetChannel, content: text }),
        signal: AbortSignal.timeout(10000),
      });
    } catch (textErr) {
      console.error(`[${LOG_PREFIX}] Voice text follow-up failed:`, textErr.message);
    }

    console.log(`[${LOG_PREFIX}] Voice message sent to ${targetChannel} (${durationSecs.toFixed(1)}s, ${state.messagesThisHour}/${LIMITS.maxMessagesPerHour} hourly)`);
    addActivity('output', `Sent voice message (${durationSecs.toFixed(1)}s)`, { type: 'discord-send-voice' });

    storeAttachmentRecord({
      filename: 'voice-message.ogg',
      mimeType: 'audio/ogg',
      source: 'discord',
      fileSize: audioBuffer.length,
      caption: text.substring(0, 200),
    }).catch(err => console.error(`[${LOG_PREFIX}] Voice attachment record failed:`, err.message));

    res.json({ ok: true, sent: true, channelId: targetChannel, durationSecs, audioBytes: audioBuffer.length });
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Voice message error:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Send a message to another agent via #agent-collab
 * Automatically @mentions the target agent so they process the message.
 * Supports optional file attachment in the same Discord message.
 */
const COLLAB_CHANNEL = process.env.DISCORD_COLLAB_CHANNEL;

app.post('/collab/send', async (req, res) => {
  if (!requireWorkerSecret(req, res)) return;
  const { targetAgent, message, filePath, base64, filename, threadId } = req.body;

  if (!message && !filePath && !base64) {
    return res.status(400).json({ error: 'message, filePath, or base64 required' });
  }
  if (!targetAgent) {
    return res.status(400).json({ error: 'targetAgent required (e.g. "company-agent")' });
  }
  if (!COLLAB_CHANNEL) {
    return res.status(400).json({ error: 'DISCORD_COLLAB_CHANNEL not configured' });
  }

  // Use existing thread if provided, otherwise main collab channel (will auto-thread)
  const targetChannel = threadId || COLLAB_CHANNEL;

  const targetBotId = AGENT_BOT_IDS[targetAgent];
  if (!targetBotId) {
    return res.status(400).json({
      error: `Unknown target agent: ${targetAgent}`,
      known: Object.keys(AGENT_BOT_IDS),
    });
  }

  const mention = `<@${targetBotId}>`;
  const botUrl = resolveBotHttpUrl(AGENT_ID);

  addActivity('action', `Sending collab request to ${getAgentDisplayName(targetAgent)}`, { type: 'collab-send', targetAgent });

  try {
    if (filePath || base64) {
      // Send file with @mention as content — single Discord message
      const content = `${mention} ${message || ''}`.trim();
      const response = await fetch(`${botUrl}/discord/send-file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId: targetChannel, filePath, base64, filename, content }),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        return res.status(502).json({ error: `Bot send-file failed (${response.status})`, detail: errText });
      }
    } else {
      // Send text message with @mention
      const content = `${mention} ${message}`;
      const response = await fetch(`${botUrl}/discord/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId: targetChannel, content }),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        return res.status(502).json({ error: `Bot send failed (${response.status})`, detail: errText });
      }
    }

    console.log(`[${LOG_PREFIX}] Collab request sent to ${getAgentDisplayName(targetAgent)}${threadId ? ' (in thread)' : ' in #agent-collab'}`);
    addActivity('output', `Collab request sent to ${getAgentDisplayName(targetAgent)}`, { type: 'collab-send' });

    res.json({ ok: true, sentTo: targetAgent, channel: targetChannel, inThread: !!threadId });
  } catch (err) {
    console.error(`[${LOG_PREFIX}] Collab send error: ${err.message}`);
    res.status(502).json({ error: 'Failed to send collab message', detail: err.message });
  }
});

/**
 * Proactive fallback delivery — when the original HTTP response connection died
 * (e.g. bot restarted during agent processing), deliver the response via the
 * appropriate bot's HTTP endpoint instead. The message is already stored in D1.
 */
const TELEGRAM_BOT_URL = process.env.TELEGRAM_BOT_URL || 'http://localhost:3003';
const WHATSAPP_BOT_URL = process.env.WHATSAPP_BOT_URL;

async function proactiveSendFallback(source, response) {
  if (!response || response.length < 2) return;

  // Wait a few seconds for the bot to come back online after restart
  await new Promise(r => setTimeout(r, 5000));

  if (source?.startsWith('telegram')) {
    console.log(`[${LOG_PREFIX}] Proactive fallback → Telegram (${response.length} chars)`);
    const res = await fetch(`${TELEGRAM_BOT_URL}/telegram/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: response }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      // Bot might still be restarting — retry after 15s
      await new Promise(r => setTimeout(r, 15000));
      await fetch(`${TELEGRAM_BOT_URL}/telegram/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: response }),
        signal: AbortSignal.timeout(10000),
      });
    }
    console.log(`[${LOG_PREFIX}] Proactive fallback delivered to Telegram`);
  } else if (source?.startsWith('discord')) {
    const channelId = source.replace('discord_', '');
    if (channelId && DISCORD_BOT_URL) {
      console.log(`[${LOG_PREFIX}] Proactive fallback → Discord #${channelId} (${response.length} chars)`);
      await fetch(`${DISCORD_BOT_URL}/discord/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId, content: response }),
        signal: AbortSignal.timeout(10000),
      });
    }
  } else if (source?.startsWith('whatsapp') && WHATSAPP_BOT_URL) {
    console.log(`[${LOG_PREFIX}] Proactive fallback → WhatsApp (${response.length} chars)`);
    await fetch(`${WHATSAPP_BOT_URL}/whatsapp/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: response }),
      signal: AbortSignal.timeout(10000),
    });
  } else {
    console.warn(`[${LOG_PREFIX}] Proactive fallback: unknown source '${source}', response stored but not delivered`);
  }
}

/**
 * Send a text message to Telegram (proactive messaging from think cycles)
 * Forwards to the telegram bot's /telegram/send endpoint
 */

app.post('/telegram/send', async (req, res) => {
  if (!requireWorkerSecret(req, res)) return;
  const { chatId, text } = req.body;
  if (!text) {
    return res.status(400).json({ error: 'text required' });
  }

  // Block trivially short or garbage messages from reaching the user.
  // During autonomous think cycles, the agent sometimes sends "test", "...", etc.
  const stripped = text.replace(/[\s.…!?,;:'"*_`#\-]+/g, '').trim();
  if (stripped.length < 8) {
    console.warn(`[${LOG_PREFIX}] Telegram send blocked (trivial content): "${text.substring(0, 60)}"`);
    addActivity('warning', `Telegram send blocked (trivial): "${text.substring(0, 60)}"`, { type: 'telegram-send-blocked' });
    return res.json({ ok: true, blocked: true, reason: 'Message too short or trivial' });
  }

  trackExplicitSend();
  addActivity('action', `Sending message to Telegram: ${text.substring(0, 80)}...`, { type: 'telegram-send' });

  try {
    const response = await fetch(`${TELEGRAM_BOT_URL}/telegram/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId, text }),
      signal: AbortSignal.timeout(10000),
    });

    const result = await response.json();
    if (!response.ok) {
      console.error(`[${LOG_PREFIX}] Telegram send failed:`, result.error);
      return res.status(response.status).json(result);
    }

    console.log(`[${LOG_PREFIX}] Message sent to Telegram: "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`);
    res.json(result);
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Telegram send error:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Send a file to Telegram
 * Forwards to the telegram bot's /telegram/send-file endpoint
 */

app.post('/telegram/send-file', async (req, res) => {
  if (!requireWorkerSecret(req, res)) return;
  const { filePath, base64, filename, caption } = req.body;
  if (!filePath && !base64) {
    return res.status(400).json({ error: 'filePath or base64 required' });
  }
  // Restrict file reads to allowed directories
  if (filePath) {
    const resolved = path.resolve(filePath);
    const allowed = [path.resolve(paths.root), path.resolve(paths.repo), '/tmp'];
    if (process.env.WARROOM_PATH) allowed.push(path.resolve(process.env.WARROOM_PATH));
    if (!allowed.some(p => resolved.startsWith(p + '/'))) {
      return res.status(403).json({ error: 'File path outside allowed directories' });
    }
  }

  trackExplicitSend();
  addActivity('action', `Sending file to Telegram: ${filename || filePath || 'base64'}`, { type: 'telegram-send-file' });

  try {
    const response = await fetch(`${TELEGRAM_BOT_URL}/telegram/send-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath, base64, filename, caption }),
      signal: AbortSignal.timeout(30000),
    });

    const result = await response.json();
    if (!response.ok) {
      console.error(`[${LOG_PREFIX}] Telegram send file failed:`, result.error);
      return res.status(response.status).json(result);
    }

    console.log(`[${LOG_PREFIX}] File sent to Telegram: ${filename || filePath}`);

    // Upload to R2 + store DB records (attachment + document)
    const name = filename || (filePath ? path.basename(filePath) : 'file');
    const ext = (name.match(/\.(\w+)$/)?.[1] || '').toLowerCase();
    const textExts = ['txt','md','csv','json','xml','html','log','yml','yaml','toml','ini','conf','sh','py','js','ts'];
    const inferredMime = textExts.includes(ext) ? 'text/plain' : 'application/octet-stream';
    const r2Result = await uploadFileToR2(filePath, base64, name, inferredMime);
    storeAttachmentRecord({
      filename: name,
      mimeType: inferredMime,
      source: 'telegram',
      caption,
      r2Key: r2Result?.r2Key,
      fileSize: r2Result?.fileSize,
    }).catch(err => console.error(`[${LOG_PREFIX}] Attachment record failed:`, err.message));

    // If R2 upload failed but file is text, create document directly from local content
    if (!r2Result?.r2Key && textExts.includes(ext)) {
      try {
        const db = tryGetDb();
        const userId = process.env.USER_ID;
        if (db && userId) {
          let content;
          if (filePath) content = await fs.readFile(filePath, 'utf-8');
          else if (base64) content = Buffer.from(base64, 'base64').toString('utf-8');
          if (content && content.length > 0) {
            const docPath = `uploads/${name}`;
            const docTitle = name.replace(/\.[^.]+$/, '');
            await db.documents.upsert({
              user_id: userId,
              path: docPath,
              title: docTitle,
              content: content.substring(0, 50000),
              summary: content.substring(0, 200),
              source_type: 'upload',
              created_by: AGENT_ID,
            });
            console.log(`[${LOG_PREFIX}] Document created from local file (R2 skipped): ${docPath}`);
          }
        }
      } catch (docErr) {
        console.error(`[${LOG_PREFIX}] Direct document creation failed:`, docErr.message);
      }
    }

    res.json(result);
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Telegram send file error:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Send a text message to WhatsApp (proactive messaging from think cycles)
 * Forwards to the WhatsApp bot's /whatsapp/send endpoint
 */
app.post('/whatsapp/send', async (req, res) => {
  if (!requireWorkerSecret(req, res)) return;
  if (!WHATSAPP_BOT_URL) {
    return res.status(404).json({ error: 'WhatsApp bot not configured' });
  }

  const { number, jid, text } = req.body;
  if (!text) {
    return res.status(400).json({ error: 'text required' });
  }

  addActivity('action', `Sending message to WhatsApp: ${text.substring(0, 80)}...`, { type: 'whatsapp-send' });

  try {
    const response = await fetch(`${WHATSAPP_BOT_URL}/whatsapp/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ number, jid, text }),
      signal: AbortSignal.timeout(10000),
    });

    const result = await response.json();
    if (!response.ok) {
      console.error(`[${LOG_PREFIX}] WhatsApp send failed:`, result.error);
      return res.status(response.status).json(result);
    }

    console.log(`[${LOG_PREFIX}] Message sent to WhatsApp`);
    res.json(result);
  } catch (error) {
    console.error(`[${LOG_PREFIX}] WhatsApp send error:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Send a file to WhatsApp
 * Forwards to the WhatsApp bot's /whatsapp/send-file endpoint
 */
app.post('/whatsapp/send-file', async (req, res) => {
  if (!requireWorkerSecret(req, res)) return;
  if (!WHATSAPP_BOT_URL) {
    return res.status(404).json({ error: 'WhatsApp bot not configured' });
  }

  const { base64, filename, caption, mimeType, number, jid } = req.body;
  if (!base64) {
    return res.status(400).json({ error: 'base64 required' });
  }

  addActivity('action', `Sending file to WhatsApp: ${filename || 'base64'}`, { type: 'whatsapp-send-file' });

  try {
    const response = await fetch(`${WHATSAPP_BOT_URL}/whatsapp/send-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64, filename, caption, mimeType, number, jid }),
      signal: AbortSignal.timeout(30000),
    });

    const result = await response.json();
    if (!response.ok) {
      console.error(`[${LOG_PREFIX}] WhatsApp send file failed:`, result.error);
      return res.status(response.status).json(result);
    }

    console.log(`[${LOG_PREFIX}] File sent to WhatsApp: ${filename}`);

    // Store DB records so they appear in chat history
    storeAttachmentRecord({
      filename: filename || 'file',
      mimeType: mimeType || 'application/octet-stream',
      source: 'whatsapp',
      caption,
    }).catch(err => console.error(`[${LOG_PREFIX}] Attachment record failed:`, err.message));

    res.json(result);
  } catch (error) {
    console.error(`[${LOG_PREFIX}] WhatsApp send file error:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Upload a file for portal delivery
 * Stores in R2 via Worker and returns a download URL
 */
app.post('/portal/send-file', async (req, res) => {
  // Auth: require worker secret (this endpoint reads files from disk)
  if (!requireWorkerSecret(req, res)) return;

  const { filePath, base64, filename, mimeType } = req.body;
  if (!filePath && !base64) {
    return res.status(400).json({ error: 'filePath or base64 required' });
  }

  if (!MYA_WORKER_SECRET) {
    return res.status(503).json({ error: 'R2 storage not configured' });
  }

  addActivity('action', `Uploading file for portal: ${filename || filePath || 'base64'}`, { type: 'portal-send-file' });

  try {
    let data;
    let name = filename;
    let mime = mimeType || 'application/octet-stream';

    if (filePath) {
      // Restrict file reads to allowed directories (prevent arbitrary disk access)
      const resolved = path.resolve(filePath);
      const allowed = [path.resolve(paths.root), path.resolve(paths.repo), '/tmp'];
      if (process.env.WARROOM_PATH) allowed.push(path.resolve(process.env.WARROOM_PATH));
      if (!allowed.some(p => resolved.startsWith(p + '/'))) {
        return res.status(403).json({ error: 'File path outside allowed directories' });
      }
      data = await fs.readFile(filePath);
      name = name || path.basename(filePath);
    } else {
      data = Buffer.from(base64, 'base64');
      name = name || 'document';
    }

    // Upload to R2 via Worker
    const base64Data = Buffer.from(data).toString('base64');
    const userId = process.env.USER_ID || 'agent';

    const response = await fetch(`${MYA_WORKER_URL}/api/store-attachment`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MYA_WORKER_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        data: base64Data,
        userId,
        type: 'file',
        filename: name,
        mimeType: mime,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`R2 storage failed: ${response.status} ${error}`);
    }

    const result = await response.json();
    const portalUrl = `${MYA_WORKER_URL}/attachments/${encodeURIComponent(result.key)}`;

    // Create DB records so they appear in chat history
    storeAttachmentRecord({
      filename: name,
      mimeType: mime,
      fileSize: data.length,
      source: 'portal',
      caption: req.body.content || req.body.caption,
      r2Key: result.key,
    }).catch(err => console.error(`[${LOG_PREFIX}] Attachment record failed:`, err.message));

    console.log(`[${LOG_PREFIX}] File uploaded for portal: ${name} → ${result.key}`);
    res.json({ ok: true, r2Key: result.key, url: portalUrl, filename: name });
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Portal send file error:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Portal File Upload (multipart)
// ============================================

app.post('/portal/upload', async (req, res) => {
  if (!checkRateLimit(req, res, 'upload', 10)) return;
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    // Parse multipart form data with busboy
    const bb = Busboy({ headers: req.headers, limits: { fileSize: 50_000_000, files: 1 } }); // 50MB — large ZIPs are pre-processed client-side
    let fileBuffer = null;
    let filename = 'file';
    let mimeType = 'application/octet-stream';

    const parsePromise = new Promise((resolve, reject) => {
      const chunks = [];

      bb.on('file', (fieldname, stream, info) => {
        filename = info.filename || 'file';
        mimeType = info.mimeType || 'application/octet-stream';
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => { fileBuffer = Buffer.concat(chunks); });
      });

      bb.on('close', () => resolve());
      bb.on('error', reject);
    });

    req.pipe(bb);
    await parsePromise;

    if (!fileBuffer || fileBuffer.length === 0) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    console.log(`[${LOG_PREFIX}] Portal upload: ${filename} (${fileBuffer.length} bytes, ${mimeType})`);

    // Auto-detect AI export ZIPs (Claude, ChatGPT, Obsidian) and route to full import pipeline
    if (mimeType === 'application/zip' || filename.endsWith('.zip')) {
      try {
        const JSZip = (await import('jszip')).default;
        const zip = await JSZip.loadAsync(fileBuffer);
        const detected = await detectExportType(zip);

        if (detected) {
          let importResult;
          const { type: exportType } = detected;

          if (exportType === 'claude') {
            // Full Claude import: conversations (with artifact dedup), projects, memories
            const stats = await processClaudeExport(zip, user.id, db);
            const parts = [];
            if (stats.messages > 0) parts.push(`${stats.messages} messages from ${stats.conversations} conversations`);
            if (stats.skipped_duplicates > 0) parts.push(`${stats.skipped_duplicates} duplicates skipped`);
            if (stats.artifacts_deduplicated > 0) parts.push(`${stats.artifacts_kept} artifacts kept, ${stats.artifacts_deduplicated} deduplicated`);
            if (stats.projects > 0) parts.push(`${stats.projects} projects, ${stats.project_docs} project docs`);
            if (stats.memories > 0) parts.push(`${stats.memories} memories`);
            importResult = {
              type: 'claude',
              imported: stats.messages + stats.project_docs + stats.memories,
              skipped: stats.skipped_duplicates,
              stats,
            };
            console.log(`[${LOG_PREFIX}] Claude import complete: ${parts.join(', ')}`);
          } else if (exportType === 'chatgpt') {
            // Full OpenAI import with tree flattening + UUID dedup
            const stats = await processOpenAIExport(detected.conversations, user.id, db);
            importResult = {
              type: 'chatgpt',
              imported: stats.messages,
              skipped: stats.skipped_duplicates,
              stats,
            };
          } else if (exportType === 'obsidian') {
            const stats = await processObsidianExport(zip, user.id, db);
            importResult = {
              type: 'obsidian',
              imported: stats.imported,
              skipped: stats.skipped,
              stats,
            };
          } else if (exportType === 'linkedin') {
            const stats = await processLinkedInExport(zip, user.id, db);
            const parts = [];
            if (stats.connections > 0) parts.push(`${stats.connections} contacts`);
            if (stats.messages > 0) parts.push(`${stats.messages} messages from ${stats.conversations} conversations`);
            if (stats.noise_filtered > 0) parts.push(`${stats.noise_filtered} noise filtered`);
            if (stats.skipped_duplicates > 0) parts.push(`${stats.skipped_duplicates} duplicates skipped`);
            importResult = {
              type: 'linkedin',
              imported: stats.connections + stats.messages,
              skipped: stats.skipped_duplicates + stats.noise_filtered,
              stats,
            };
            console.log(`[${LOG_PREFIX}] LinkedIn import complete: ${parts.join(', ')}`);
          }

          if (importResult) {
            const label = exportType === 'obsidian' ? 'Obsidian vault' : exportType === 'linkedin' ? 'LinkedIn data' : `${exportType} export`;
            return res.json({
              attachmentId: null,
              type: 'import',
              content: `[Imported ${label}: ${importResult.imported} items imported${importResult.skipped > 0 ? `, ${importResult.skipped} skipped` : ''}]`,
              filename,
              importResult,
            });
          }
        }
      } catch (zipErr) {
        console.error(`[${LOG_PREFIX}] ZIP auto-detect failed:`, zipErr.message);
        // Fall through to normal file processing
      }
    }

    // Process through existing attachment pipeline (R2 storage + AI processing)
    const result = await processAttachment(
      { name: filename, data: fileBuffer, size: fileBuffer.length, contentType: mimeType },
      user.id,
    );

    // Always create attachment record in DB
    const attachmentId = await createAttachmentRecord(null, {
      userId: user.id,
      type: result.type,
      filename,
      mimeType,
      size: fileBuffer.length,
      r2Key: result.r2Key,
      streamInfo: result.streamInfo,
      description: result.description,
      transcript: result.transcript,
      discordMetadata: { source: 'portal' },
    });

    // Create document record so the file appears in the library
    // For text files, use the full raw text — not the truncated description
    let docContent = '';
    if (result.type === 'text' && fileBuffer) {
      docContent = new TextDecoder().decode(fileBuffer);
    } else {
      docContent = result.description || result.transcript || result.content || '';
    }
    const docTitle = filename.replace(/\.[^.]+$/, '');
    const docPath = `uploads/${filename}`;
    let docRecord = null;
    try {
      docRecord = await db.documents.upsert({
        user_id: user.id,
        path: docPath,
        title: docTitle,
        content: docContent.substring(0, 50000),
        summary: docContent.substring(0, 200),
        source_type: 'upload',
        created_by: 'user',
      });
    } catch (docErr) {
      console.error(`[${LOG_PREFIX}] Document record failed:`, docErr.message);
    }

    // Generate embedding for semantic search (fire-and-forget)
    if (docRecord?.id && docContent.length > 10) {
      (async () => {
        try {
          const { generateEmbedding } = await import('./lib/embed.js');
          const { vectorUpsert } = await import('./lib/db-d1.js');
          const embedding = await generateEmbedding(docContent);
          await vectorUpsert('search', [{
            id: docRecord.id,
            values: embedding,
            metadata: { type: 'document', userId: user.id },
          }]);
          console.log(`[${LOG_PREFIX}] Embedded document: ${docPath}`);
        } catch (embedErr) {
          console.error(`[${LOG_PREFIX}] Embedding failed:`, embedErr.message);
        }
      })();
    }

    console.log(`[${LOG_PREFIX}] Portal upload processed: ${filename} → ${result.type} (attachment: ${attachmentId})`);
    res.json({
      attachmentId,
      type: result.type,
      content: result.content || `[File: ${filename}]`,
      filename,
    });
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Portal upload error:`, error.message);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

// ============================================
// Autonomous Agent Control
// ============================================

app.get('/autonomous/state', async (req, res) => {
  let state = await loadState();
  state = resetCountersIfNeeded(state);

  res.json({
    state,
    limits: LIMITS,
    canSend: canSendProactiveMessage(state)
  });
});

app.post('/autonomous/reset', async (req, res) => {
  if (!requireWorkerSecret(req, res)) return;
  let state = await loadState();
  state.messagesThisHour = 0;
  state.messagesToday = 0;
  state.lastMessageTime = null;
  await saveState(state);
  res.json({ ok: true, message: 'Rate limits reset' });
});

// ============================================
// Task Endpoints (File-Based)
// ============================================

// Get pending tasks from the agent's repo
app.get('/tasks', async (req, res) => {
  const data = await loadTasks();
  const pending = data.tasks.filter(t => t.status === 'pending');
  res.json({ tasks: pending, total: data.tasks.length });
});

// Get all tasks (for debugging)
app.get('/tasks/all', async (req, res) => {
  const data = await loadTasks();
  res.json(data);
});

// ============================================
// Memory Search Endpoint
// ============================================

app.post('/search', async (req, res) => {
  if (!requireWorkerSecret(req, res)) return;
  if (!checkRateLimit(req, res, 'search', 60)) return;
  const { query, limit = 10, after, before } = req.body;

  if (!query) {
    return res.status(400).json({ error: 'Query required' });
  }

  const db = tryGetDb();
  if (!db) {
    return res.status(503).json({ error: 'Search not configured - database not initialized' });
  }

  if (!process.env.MYA_WORKER_URL || !process.env.AGENT_TOKEN) {
    return res.status(503).json({ error: 'Search not configured - missing MYA_WORKER_URL/AGENT_TOKEN' });
  }

  addActivity('action', `Searching memory: "${query.substring(0, 50)}..."`, { type: 'search', limit });

  try {
    // 1. Generate embedding for query via shared lib (BGE-M3 1024D)
    const { generateEmbedding } = await import('./lib/embed.js');
    const embedding = await generateEmbedding(query);

    // 2. Call hybrid search function
    // Company-scoped agents search all agents except personal-agent
    const isCompanyScope = (process.env.MEMORY_SCOPE || 'company') === 'company';
    const searchAgentId = isCompanyScope ? null : AGENT_ID;
    const searchLimit = isCompanyScope ? limit * 2 : limit;
    let data = await db.messages.hybridSearch({
      agentId: searchAgentId,
      query,
      embedding,
      after: after || null,
      before: before || null,
      limit: searchLimit,
    });
    if (isCompanyScope && data?.length) {
      data = data.filter(r => r.agent_id !== 'personal-agent' && r.agent_id !== 'mya-personal').slice(0, limit);
    }

    // 3. Return formatted results
    console.log(`[${LOG_PREFIX}] Search for "${query.substring(0, 30)}..." returned ${data?.length || 0} results`);
    addActivity('output', `Search returned ${data?.length || 0} results`, { type: 'search', query: query.substring(0, 50) });

    res.json({
      query,
      results: (data || []).map(r => ({
        id: r.id,
        content: r.content,
        snippet: (r.content || '').slice(0, 200),
        score: r.hybrid_score || r.similarity || 0,
        created_at: r.created_at,
        agent_id: r.agent_id,
        source: r.source,
      }))
    });

  } catch (error) {
    console.error(`[${LOG_PREFIX}] Search error:`, error);
    eventLog.error('search', error);
    addActivity('error', `Search failed: ${error.message}`, { type: 'search' });
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// SSE Prompt Endpoint (for UI compatibility)
// ============================================

app.post('/prompt', async (req, res) => {
  if (!requireWorkerSecret(req, res)) return;
  const { prompt, channel, username } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: 'Prompt required' });
  }

  let systemPrompt = '';
  let context = '';
  try {
    systemPrompt = await loadSystemPrompt();
    context = await fs.readFile(paths.knowledge.context, 'utf-8');
  } catch (e) {
    console.log(`[${LOG_PREFIX}] Could not load prompts:`, e.message);
  }

  const fullPrompt = `${systemPrompt}

---
# Company Context
${context}

---
# Current Request
From: ${username || 'Unknown'} in #${channel || 'unknown'}
Message: ${prompt}

Respond naturally. If you have nothing valuable to add, respond with just: NO_REPLY`;

  console.log(`[${LOG_PREFIX}] Processing prompt from ${username} in #${channel}`);
  addActivity('action', `Prompt request from ${username}`, { channel, promptLength: prompt.length });
  addActivity('thought', `Prompt: ${prompt.length} chars`, { type: 'prompt-input' });
  const promptModel = getModelForTask(runtime, 'chat');
  addActivity('action', `Spawning Claude Code process (model: ${promptModel})`, { type: 'claude-spawn', model: promptModel });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  res.write(`data: {"type":"start","timestamp":"${new Date().toISOString()}"}\n\n`);

  const claude = spawn(CLAUDE_BIN, [
    '--print',
    '--model', promptModel,
    '--dangerously-skip-permissions',
  ], {
    cwd: paths.repo,  // Run inside git repository
    env: { ...process.env, HOME: '/home/claude' },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  // Write prompt via stdin to avoid E2BIG with large prompts
  claude.stdin.write(fullPrompt);
  claude.stdin.end();

  let fullOutput = '';
  let lastDataTime = Date.now();

  const keepaliveTimer = setInterval(() => {
    if (Date.now() - lastDataTime > KEEPALIVE_INTERVAL - 1000) {
      res.write(`data: {"type":"keepalive"}\n\n`);
    }
  }, KEEPALIVE_INTERVAL);

  const timeoutTimer = setTimeout(() => {
    console.warn(`[${LOG_PREFIX}] Prompt timed out`);
    // Use SIGINT for graceful shutdown of CLI tools
    claude.kill('SIGINT');
    res.write(`data: {"type":"error","message":"Request timed out"}\n\n`);
    // Grace period then SIGKILL
    setTimeout(() => {
      claude.kill('SIGKILL');
    }, TIMEOUTS.gracePeriod);
  }, PROMPT_TIMEOUT);

  claude.stdout.on('data', (data) => {
    lastDataTime = Date.now();
    const text = data.toString();
    fullOutput += text;
    res.write(`data: ${JSON.stringify({ type: 'stdout', text })}\n\n`);
    // Add to activity stream
    addActivity('output', text, { source: 'claude' });
  });

  claude.stderr.on('data', (data) => {
    lastDataTime = Date.now();
    const text = data.toString().trim();
    res.write(`data: ${JSON.stringify({ type: 'stderr', text })}\n\n`);

    // Parse and log Claude's tool usage from stderr
    if (text) {
      // Detect file operations
      if (text.includes('Writing') || text.includes('Wrote')) {
        addActivity('action', text, { type: 'file-write', source: 'claude' });
      } else if (text.includes('Reading') || text.includes('Read')) {
        addActivity('action', text, { type: 'file-read', source: 'claude' });
      } else if (text.includes('Running') || text.includes('Executing') || text.includes('$')) {
        addActivity('action', text, { type: 'command', source: 'claude' });
      } else if (text.includes('Edit') || text.includes('Editing')) {
        addActivity('action', text, { type: 'file-edit', source: 'claude' });
      } else if (text.includes('Tool') || text.includes('tool')) {
        addActivity('action', text, { type: 'tool-use', source: 'claude' });
      } else if (text.includes('Error') || text.includes('error')) {
        addActivity('error', text, { source: 'claude' });
      } else {
        addActivity('thought', text, { source: 'claude-stderr' });
      }
    }
  });

  claude.on('close', async (code) => {
    clearInterval(keepaliveTimer);
    clearTimeout(timeoutTimer);

    res.write(`data: {"type":"done","code":${code}}\n\n`);
    res.end();

    console.log(`[${LOG_PREFIX}] Finished prompt (code: ${code}, output: ${fullOutput.length} chars)`);
    addActivity('status', `Task completed (exit code: ${code})`, { code });

    // Store prompt + response in D1 so they appear in chat history
    const chatUserId = process.env.USER_ID;
    if (chatUserId && fullOutput.trim()) {
      storeMessages(chatUserId, `portal_prompt`, prompt, fullOutput.trim(), new Date()).catch(err => {
        console.error(`[${LOG_PREFIX}] Prompt message storage failed (non-fatal):`, err.message);
      });
    }
  });

  claude.on('error', (err) => {
    clearInterval(keepaliveTimer);
    clearTimeout(timeoutTimer);
    console.error(`[${LOG_PREFIX}] Claude process error:`, err.message);
    res.write(`data: {"type":"error","message":"${err.message}"}\n\n`);
    res.end();
    addActivity('error', err.message, { source: 'claude' });
  });
});

// ============================================
// UI Compatibility Endpoints
// ============================================

app.get("/status", async (req, res) => {
  try {
    const state = await readFile(paths.state, { currentPhase: "idle", lastActive: null });

    // Derive agent type from AGENT_ID (e.g., 'company-agent' -> 'company', 'mya-research' -> 'research')
    const agentType = AGENT_ID.includes('-') ? AGENT_ID.split('-').pop() : AGENT_ID;

    res.json({
      agent: {
        name: LOG_PREFIX + " Agent",
        slug: AGENT_ID,
        type: agentType,
        model: runtime.model,
        models: runtime.models,
        lastModelUsed,
        account: process.env.CLAUDE_CONFIG_DIR ? 'configured' : 'default',
      },
      state: {
        currentPhase: state.currentPhase || "idle",
        activeDomain: state.activeDomain || null,
        openQuestions: state.openQuestions || [],
        lastUpdated: state.lastActive || new Date().toISOString()
      },
      tasks: {
        queue: state.tasks?.queue?.length || 0,
        active: state.tasks?.active?.length || 0,
        completed: state.tasks?.completed?.length || 0,
        blocked: state.tasks?.blocked?.length || 0
      },
      running: true,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/conversations", async (req, res) => {
  if (!requireWorkerSecret(req, res)) return;
  try {
    const limit = parseInt(req.query.limit) || 100;
    const agentId = AGENT_ID || 'personal-agent';

    // Read from database messages table (same place /chat stores them)
    const db = tryGetDb();
    if (db) {
      const { data, count } = await db.messages.selectByAgent(agentId, { limit });

      const messages = (data || []).reverse().map(m => ({
        id: m.id,
        role: m.role,
        content: m.content,
        timestamp: m.created_at
      }));

      return res.json({ messages, total: count || messages.length });
    }

    // Fallback: read from local state file
    const memory = await readFile(paths.state, { messages: [] });
    res.json({
      messages: (memory.messages || []).slice(-limit),
      total: (memory.messages || []).length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// SSE endpoint for live activity stream
app.get("/agent/activity/stream", (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Send recent activity history
  for (const entry of activityBuffer.slice(-50)) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }

  // Add to subscribers
  activitySubscribers.add(res);

  // Keepalive
  const keepalive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15000);

  req.on('close', () => {
    activitySubscribers.delete(res);
    clearInterval(keepalive);
  });
});

// Get recent activity (non-streaming)
app.get("/agent/activity", (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json({
    entries: activityBuffer.slice(-limit),
    total: activityBuffer.length
  });
});

app.get("/git/status", async (req, res) => {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: paths.repo, encoding: "utf-8" }).trim();
    const status = execSync("git status --porcelain", { cwd: paths.repo, encoding: "utf-8" }).trim();

    res.json({
      branch,
      hasChanges: status.length > 0,
      changes: status ? status.split("\n").filter(Boolean) : []
    });
  } catch (error) {
    res.json({ branch: "main", hasChanges: false, changes: [], error: error.message });
  }
});

app.get("/structure", async (req, res) => {
  if (!requireWorkerSecret(req, res)) return;
  try {
    // Build tree structure recursively
    async function getTree(dir, prefix = '') {
      const items = await fs.readdir(dir, { withFileTypes: true });
      const tree = [];

      for (const item of items) {
        // Skip hidden files and common excludes
        if (item.name.startsWith('.') && item.name !== '.agent-state.json') continue;
        if (item.name === 'node_modules') continue;

        const itemPath = path.join(dir, item.name);
        const relPath = prefix ? `${prefix}/${item.name}` : item.name;

        if (item.isDirectory()) {
          const children = await getTree(itemPath, relPath);
          tree.push({ name: item.name, path: relPath, type: 'dir', children });
        } else {
          try {
            const stat = await fs.stat(itemPath);
            tree.push({
              name: item.name,
              path: relPath,
              type: 'file',
              size: stat.size,
              modified: stat.mtime.toISOString()
            });
          } catch {
            tree.push({ name: item.name, path: relPath, type: 'file' });
          }
        }
      }

      return tree;
    }

    // Sort: folders first, then files, alphabetically
    const sortTree = (items) => {
      return items.sort((a, b) => {
        if (a.type === 'dir' && b.type !== 'dir') return -1;
        if (a.type !== 'dir' && b.type === 'dir') return 1;
        return a.name.localeCompare(b.name);
      }).map(item => {
        if (item.children) {
          item.children = sortTree(item.children);
        }
        return item;
      });
    };

    const structure = sortTree(await getTree(paths.repo));
    res.json({ structure });
  } catch (error) {
    res.json({ structure: [], error: error.message });
  }
});

// Read file content
app.get("/file/*splat", async (req, res) => {
  if (!requireWorkerSecret(req, res)) return;
  try {
    const filePath = req.params.splat;

    // Security: ensure path doesn't escape repo directory
    const fullPath = path.join(paths.repo, filePath);
    const resolved = path.resolve(fullPath);
    if (!resolved.startsWith(path.resolve(paths.repo))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const content = await fs.readFile(fullPath, 'utf-8');
    res.json({ path: filePath, content });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: 'File not found' });
    }
    res.status(500).json({ error: error.message });
  }
});

// Get logs list
app.get("/logs", async (req, res) => {
  if (!requireWorkerSecret(req, res)) return;
  try {
    const logsDir = path.join(paths.repo, 'logs');
    let files = [];
    try {
      files = await fs.readdir(logsDir);
    } catch {
      // logs dir doesn't exist
    }

    const logs = await Promise.all(
      files
        .filter(f => f.endsWith('.log') || f.endsWith('.jsonl') || f.endsWith('.txt'))
        .sort()
        .reverse()
        .slice(0, 50)
        .map(async (filename) => {
          const logPath = path.join(logsDir, filename);
          try {
            const stat = await fs.stat(logPath);
            return {
              filename,
              timestamp: stat.mtime.toISOString(),
              size: stat.size
            };
          } catch {
            return { filename, timestamp: null, size: 0 };
          }
        })
    );

    res.json({ logs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get specific log content
app.get("/logs/:filename", async (req, res) => {
  if (!requireWorkerSecret(req, res)) return;
  try {
    const { filename } = req.params;

    // Security: prevent path traversal
    if (filename.includes('..') || filename.includes('/')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    const logPath = path.join(paths.repo, 'logs', filename);
    const content = await fs.readFile(logPath, 'utf-8');

    res.type('text/plain').send(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: 'Log not found' });
    }
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Helper Functions
// ============================================

// Note: runClaudeCode is now imported from lib/runner.js
// with proper timeout handling, SIGINT graceful shutdown,
// and grace period before SIGKILL

// ============================================
// Checkpoint Recovery (Restart Sentinel Pattern)
// ============================================

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || 'http://localhost:3000';

// Recovery settings
const MAX_RESUME_AGE_MS = 30 * 60 * 1000; // 30 minutes - don't resume older tasks

// Continuation settings (timeout + rate limit auto-resume)
const CONTINUATION_CONFIG = {
  timeout: { maxAttempts: 3, enabled: true },
  rateLimit: { maxAttempts: 3, maxWaitMs: 6 * 60 * 60 * 1000, defaultWaitMs: 5 * 60 * 1000, enabled: true },
  scanIntervalMs: 60 * 1000,
  maxAge: 24 * 60 * 60 * 1000,
};

/**
 * Build a recovery prompt that tells the agent it was interrupted
 */
function buildRecoveryPrompt(checkpoint, sessionMessages) {
  const originalPrompt = sessionMessages.find(m => m.role === 'user')?.content || checkpoint.promptSummary;

  return `You are resuming an interrupted task.

## What Happened
You were working on a ${checkpoint.taskType} task when you were interrupted (server restart/crash).
The task started at ${new Date(checkpoint.startedAt).toLocaleString()}.

## Original Request
${originalPrompt}

## Instructions
1. Review what was requested above
2. Check git status and recent file changes to see what you may have completed
3. Continue from where you left off - do NOT repeat completed work
4. If the task appears complete, respond with NO_REPLY

If you're unsure what was done, check:
- git status (for uncommitted changes)
- git log --oneline -5 (for recent commits)
- File timestamps in the working directory`;
}

/**
 * Recover from incomplete checkpoints on startup
 * This handles tasks that were interrupted by crash/restart/timeout
 *
 * Now supports multiple concurrent checkpoints (one per session)
 */
async function recoverFromCheckpoint() {
  const checkpoints = await readAllCheckpoints(paths.root);

  if (checkpoints.length === 0) {
    console.log(`[${LOG_PREFIX}] No checkpoints found - clean start`);
  } else {
    console.log(`[${LOG_PREFIX}] Found ${checkpoints.length} checkpoint(s) to process`);

    for (const checkpoint of checkpoints) {
      await processCheckpoint(checkpoint);
    }
  }

  // Clean up old archived checkpoints and sessions (older than 7 days)
  await cleanupArchivedCheckpoints(paths.root);
  await cleanupOldSessions(paths.root);

  // Recover continuations: any that were 'running' when we crashed → reset to 'pending'
  try {
    const continuations = await readAllContinuations(paths.root);
    let resetCount = 0;
    for (const cont of continuations) {
      if (cont.state === 'running') {
        await updateContinuation(paths.root, cont.id, { state: 'pending' });
        resetCount++;
      }
    }
    if (continuations.length > 0) {
      const pending = continuations.filter(c => c.state === 'pending').length + resetCount;
      console.log(`[${LOG_PREFIX}] Continuations: ${continuations.length} total, ${pending} pending (${resetCount} reset from running)`);
    }
    // Clean up old completed/failed continuations
    await cleanupOldContinuations(paths.root, CONTINUATION_CONFIG.maxAge);
  } catch (e) {
    console.error(`[${LOG_PREFIX}] Continuation recovery error:`, e.message);
  }
}

/**
 * Process a single checkpoint for recovery
 */
async function processCheckpoint(checkpoint) {
  console.log(`[${LOG_PREFIX}] Processing checkpoint: ${getCheckpointSummary(checkpoint)}`);
  addActivity('status', `Found interrupted task: ${checkpoint.taskType}`, {
    type: 'recovery',
    checkpointId: checkpoint.id,
    state: checkpoint.state,
    sessionId: checkpoint.sessionId
  });

  if (checkpoint.state === 'completed') {
    // Task completed but checkpoint wasn't cleared - just clear it
    await clearCheckpoint(paths.root, checkpoint.sessionId);
    console.log(`[${LOG_PREFIX}] Cleared stale completed checkpoint (session: ${checkpoint.sessionId})`);
    return;
  }

  if (checkpoint.state === 'running') {
    // Task was interrupted (crash/restart)
    const age = Date.now() - new Date(checkpoint.startedAt).getTime();
    console.log(`[${LOG_PREFIX}] Task was interrupted: ${checkpoint.taskType} (age: ${Math.round(age/1000)}s)`);

    // Archive for debugging
    await archiveCheckpoint(paths.root, {
      ...checkpoint,
      state: 'interrupted',
      completedAt: new Date().toISOString(),
      recoveredAt: new Date().toISOString(),
    });

    // Check if task is too old to resume
    if (age > MAX_RESUME_AGE_MS) {
      console.log(`[${LOG_PREFIX}] Task too old to resume (${Math.round(age/60000)}m > ${MAX_RESUME_AGE_MS/60000}m)`);

      // Just notify, don't resume
      if (checkpoint.deliveryContext?.channelId) {
        await notifyRecovery(checkpoint, false);
      }

      await clearCheckpoint(paths.root, checkpoint.sessionId);
      return;
    }

    // Try to resume the session
    if (checkpoint.sessionId) {
      await resumeSession(checkpoint);
    } else {
      // No sessionId - old checkpoint format, just notify
      console.log(`[${LOG_PREFIX}] No sessionId in checkpoint, cannot resume`);
      if (checkpoint.deliveryContext?.channelId) {
        await notifyRecovery(checkpoint, false);
      }
    }

    await clearCheckpoint(paths.root, checkpoint.sessionId);
    console.log(`[${LOG_PREFIX}] Checkpoint cleared after recovery (session: ${checkpoint.sessionId})`);
  }

  if (checkpoint.state === 'failed') {
    // Task failed, archive and clear
    await archiveCheckpoint(paths.root, checkpoint);
    await clearCheckpoint(paths.root, checkpoint.sessionId);
    console.log(`[${LOG_PREFIX}] Archived and cleared failed checkpoint (session: ${checkpoint.sessionId})`);
  }
}

/**
 * Resume an interrupted session
 */
async function resumeSession(checkpoint) {
  console.log(`[${LOG_PREFIX}] Attempting to resume session: ${checkpoint.sessionId}`);
  addActivity('action', `Resuming interrupted ${checkpoint.taskType} task`, {
    type: 'session-resume',
    sessionId: checkpoint.sessionId
  });

  // Notify that we're resuming
  if (checkpoint.deliveryContext?.channelId) {
    await notifyRecovery(checkpoint, true);
  }

  try {
    // Load session history
    const sessionMessages = await getSessionMessages(paths.root, checkpoint.sessionId);

    if (sessionMessages.length === 0) {
      console.log(`[${LOG_PREFIX}] No session messages found, cannot resume`);
      return;
    }

    // Build recovery prompt
    const recoveryPrompt = buildRecoveryPrompt(checkpoint, sessionMessages);

    // Load system prompt
    let systemPrompt = '';
    try {
      systemPrompt = await loadSystemPrompt();
    } catch (e) {
      console.log(`[${LOG_PREFIX}] Could not load system prompt for recovery:`, e.message);
    }

    const fullPrompt = `${systemPrompt}

## Session Recovery

${recoveryPrompt}`;

    incrementActiveTask();

    // Re-run the task, resuming the Claude Code session if available
    const { result: output, sessionId: claudeSessionId } = await runClaudeCode(fullPrompt, {
      model: getModelForTask(runtime, checkpoint.taskType),
      cwd: paths.repo,
      taskType: checkpoint.taskType,
      agentRoot: paths.root,
      agentId: AGENT_ID,
      sessionId: checkpoint.sessionId, // Internal session ID for checkpoint linkage
      resumeSessionId: checkpoint.resumeSessionId || null, // Claude Code session UUID
      isResume: true,
      deliveryContext: checkpoint.deliveryContext,
    });

    decrementActiveTask();

    console.log(`[${LOG_PREFIX}] Session resumed successfully: ${trunc(output,0, 100)}...`);
    addActivity('output', `Session resumed: ${trunc(output, 0, 200)}${(output || '').length > 200 ? '...' : ''}`, {
      type: 'session-resume-complete',
      sessionId: checkpoint.sessionId
    });

    // Send result to Discord if we have context
    if (checkpoint.deliveryContext?.channelId && output && !isSilentReply(output)) {
      await sendRecoveryResult(checkpoint, output);
    }

  } catch (error) {
    decrementActiveTask();
    console.error(`[${LOG_PREFIX}] Session resume failed:`, error.message);
    addActivity('error', `Session resume failed: ${error.message}`, {
      type: 'session-resume-error',
      sessionId: checkpoint.sessionId
    });
  }
}

/**
 * Send recovery notification to Discord
 */
async function notifyRecovery(checkpoint, isResuming = false) {
  const message = isResuming
    ? `🔄 Resuming interrupted **${checkpoint.taskType}** task...\n` +
      `Task: "${checkpoint.promptSummary?.slice(0, 100)}..."`
    : `⚠️ I was interrupted while working on a **${checkpoint.taskType}** task.\n` +
      `Started: ${new Date(checkpoint.startedAt).toLocaleString()}\n` +
      `Task: "${checkpoint.promptSummary?.slice(0, 150)}..."`;

  try {
    if (DISCORD_CHANNEL) {
      const botUrl = resolveBotHttpUrl(AGENT_ID);
      const response = await fetch(`${botUrl}/discord/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelId: checkpoint.deliveryContext?.channelId || DISCORD_CHANNEL,
          content: message,
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok) {
        console.log(`[${LOG_PREFIX}] Sent recovery notification to Discord`);
      } else {
        console.error(`[${LOG_PREFIX}] Recovery notification failed (${response.status})`);
      }
    } else if (TELEGRAM_BOT_URL) {
      await fetch(`${TELEGRAM_BOT_URL}/telegram/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message.replace(/\*\*/g, '') }),
        signal: AbortSignal.timeout(10000),
      });
      console.log(`[${LOG_PREFIX}] Sent recovery notification to Telegram`);
    } else if (WHATSAPP_BOT_URL) {
      await fetch(`${WHATSAPP_BOT_URL}/whatsapp/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message.replace(/\*\*/g, '') }),
        signal: AbortSignal.timeout(10000),
      });
      console.log(`[${LOG_PREFIX}] Sent recovery notification to WhatsApp`);
    }
    addActivity('output', isResuming ? 'Notified: resuming task' : 'Notified: task interrupted', { type: 'recovery-notify' });
  } catch (e) {
    console.error(`[${LOG_PREFIX}] Failed to send recovery notification:`, e.message);
  }
}

/**
 * Send the result of a resumed session to Discord
 */
async function sendRecoveryResult(checkpoint, output) {
  const message = `✅ Resumed task completed\n\n${(output || '').slice(0, 1800)}${(output || '').length > 1800 ? '...' : ''}`;

  try {
    if (DISCORD_CHANNEL) {
      const botUrl = resolveBotHttpUrl(AGENT_ID);
      const response = await fetch(`${botUrl}/discord/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelId: checkpoint.deliveryContext?.channelId || DISCORD_CHANNEL,
          content: message,
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok) {
        console.log(`[${LOG_PREFIX}] Sent recovery result to Discord`);
      } else {
        console.error(`[${LOG_PREFIX}] Recovery result send failed (${response.status})`);
      }
    } else if (TELEGRAM_BOT_URL) {
      await fetch(`${TELEGRAM_BOT_URL}/telegram/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message }),
        signal: AbortSignal.timeout(10000),
      });
      console.log(`[${LOG_PREFIX}] Sent recovery result to Telegram`);
    } else if (WHATSAPP_BOT_URL) {
      await fetch(`${WHATSAPP_BOT_URL}/whatsapp/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message }),
        signal: AbortSignal.timeout(10000),
      });
      console.log(`[${LOG_PREFIX}] Sent recovery result to WhatsApp`);
    }
  } catch (e) {
    console.error(`[${LOG_PREFIX}] Failed to send recovery result:`, e.message);
  }
}

// ============================================
// Task Continuation (Timeout + Rate Limit Recovery)
// ============================================

/**
 * Format a duration in ms to human-readable string
 */
function formatDuration(ms) {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)} min`;
  const hours = Math.floor(ms / 3600000);
  const mins = Math.round((ms % 3600000) / 60000);
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

/**
 * Estimate how long to wait for a rate limit.
 * Parses Claude Code's error output for retry-after hints.
 */
function estimateRateLimitWait(error) {
  const msg = (error.message || '') + (error.stderr || '');

  // Look for explicit retry-after in seconds
  const retryAfterMatch = msg.match(/retry.after[:\s]+(\d+)/i);
  if (retryAfterMatch) {
    const ms = parseInt(retryAfterMatch[1], 10) * 1000;
    return Math.min(ms, CONTINUATION_CONFIG.rateLimit.maxWaitMs);
  }

  // Look for "try again in X minutes/hours"
  const tryAgainMatch = msg.match(/try again in (\d+)\s*(second|minute|hour)/i);
  if (tryAgainMatch) {
    const value = parseInt(tryAgainMatch[1], 10);
    const unit = tryAgainMatch[2].toLowerCase();
    let ms;
    if (unit.startsWith('second')) ms = value * 1000;
    else if (unit.startsWith('minute')) ms = value * 60 * 1000;
    else ms = value * 60 * 60 * 1000;
    return Math.min(ms, CONTINUATION_CONFIG.rateLimit.maxWaitMs);
  }

  return CONTINUATION_CONFIG.rateLimit.defaultWaitMs;
}

/**
 * Build a continuation prompt for --resume sessions
 */
function buildContinuationPrompt(attempt) {
  return `You were interrupted by a timeout. This is continuation attempt ${attempt}. ` +
    `Please review where you left off (check git status, recent file changes) and continue your work. ` +
    `Do NOT restart from scratch — pick up from where you stopped.`;
}

function buildMaxTurnsContinuationPrompt(attempt, maxAttempts) {
  return `You hit the turn limit for this session (continuation ${attempt}/${maxAttempts}). ` +
    `Review your progress so far and continue with the remaining work. ` +
    `If you have accomplished the core task, provide a final summary. ` +
    `If not, continue from where you left off. Do NOT restart from scratch.`;
}

/**
 * Send continuation notification to Discord/Telegram
 */
async function notifyContinuation({ type, attempt, maxAttempts, waitMs, resumeAfter, message: customMessage, deliveryContext }) {
  let message = customMessage;

  if (!message) {
    if (type === 'timeout') {
      message = `⏱ Task timed out (60 min limit). Continuing automatically... (attempt ${attempt}/${maxAttempts})`;
    } else if (type === 'rate_limit') {
      const waitStr = formatDuration(waitMs);
      const etaStr = new Date(resumeAfter).toLocaleTimeString();
      message = `⚠️ Rate limited by AI provider. Task will resume automatically in ~${waitStr} (around ${etaStr}).`;
    } else if (type === 'max_turns') {
      message = `🔄 Hit turn limit — continuing automatically (${attempt}/${maxAttempts})`;
    } else if (type === 'resuming') {
      message = `🔄 Resuming task... (attempt ${attempt}/${maxAttempts})`;
    } else if (type === 'failed') {
      message = `❌ Task failed after ${attempt} attempts. ${customMessage || ''}`;
    }
  }

  if (!message) return;

  try {
    const channelId = deliveryContext?.channelId || DISCORD_CHANNEL;
    if (channelId && DISCORD_BOT_URL) {
      const botUrl = resolveBotHttpUrl(AGENT_ID);
      await fetch(`${botUrl}/discord/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId, content: message }),
        signal: AbortSignal.timeout(10000),
      });
    } else if (TELEGRAM_BOT_URL) {
      await fetch(`${TELEGRAM_BOT_URL}/telegram/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message }),
        signal: AbortSignal.timeout(10000),
      });
    } else if (WHATSAPP_BOT_URL) {
      await fetch(`${WHATSAPP_BOT_URL}/whatsapp/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message }),
        signal: AbortSignal.timeout(10000),
      });
    }
  } catch (e) {
    console.error(`[${LOG_PREFIX}] Failed to send continuation notification:`, e.message);
  }
}

/**
 * Run a Claude Code task with timeout continuation and rate-limit scheduling.
 * Wraps runClaudeCode with automatic --resume on timeout and deferred scheduling on rate limit.
 *
 * @param {Object} options
 * @param {string} options.prompt - Full prompt
 * @param {Object} options.runOptions - Options for runClaudeCode
 * @param {Object} options.deliveryContext - Where to send notifications
 * @param {number} [options.maxContinuations] - Max continuation attempts (default from config)
 * @returns {Promise<{ result: string, sessionId: string|null }>}
 */
async function runWithContinuation({ prompt, runOptions, deliveryContext, maxContinuations }) {
  const maxTimeoutAttempts = CONTINUATION_CONFIG.timeout.enabled
    ? (maxContinuations || CONTINUATION_CONFIG.timeout.maxAttempts) : 0;
  const maxRateLimitAttempts = CONTINUATION_CONFIG.rateLimit.enabled
    ? CONTINUATION_CONFIG.rateLimit.maxAttempts : 0;
  const maxTurnsContinuations = maxContinuations || MAX_CONTINUATIONS;

  let continuationAttempt = 0;
  let maxTurnsContinuationAttempt = 0;
  let currentSessionId = runOptions.resumeSessionId || null;
  let currentPrompt = prompt;

  while (true) {
    try {
      const { result, sessionId, hitMaxTurns } = await runClaudeCode(currentPrompt, {
        ...runOptions,
        resumeSessionId: currentSessionId,
        skipDedup: continuationAttempt > 0 || maxTurnsContinuationAttempt > 0,
        isResume: continuationAttempt > 0 || maxTurnsContinuationAttempt > 0 || runOptions.isResume,
      });

      // Auto-continue when agent hits turn limit and has more continuation budget
      if (hitMaxTurns && sessionId && maxTurnsContinuationAttempt < maxTurnsContinuations) {
        maxTurnsContinuationAttempt++;
        currentSessionId = sessionId;
        currentPrompt = buildMaxTurnsContinuationPrompt(maxTurnsContinuationAttempt, maxTurnsContinuations);

        console.log(`[${LOG_PREFIX}] Max turns hit — continuing (${maxTurnsContinuationAttempt}/${maxTurnsContinuations}, session: ${sessionId.slice(0, 8)})`);
        addActivity('action', `Hit turn limit — continuing (${maxTurnsContinuationAttempt}/${maxTurnsContinuations})`, { type: 'continuation-max-turns' });

        await notifyContinuation({
          type: 'max_turns',
          attempt: maxTurnsContinuationAttempt,
          maxAttempts: maxTurnsContinuations,
          deliveryContext,
        });

        continue;
      }

      return { result, sessionId };
    } catch (error) {
      const reason = error.errorReason || classifyError(error);
      const failedSessionId = error.claudeSessionId || currentSessionId;

      // Timeout: immediate continuation with --resume
      if ((reason === ErrorReason.TIMEOUT || error.isTimeout) && failedSessionId && continuationAttempt < maxTimeoutAttempts) {
        continuationAttempt++;
        currentSessionId = failedSessionId;
        currentPrompt = buildContinuationPrompt(continuationAttempt);

        console.log(`[${LOG_PREFIX}] Timeout continuation attempt ${continuationAttempt}/${maxTimeoutAttempts} (session: ${failedSessionId.slice(0, 8)})`);
        addActivity('action', `Timeout — continuing (attempt ${continuationAttempt}/${maxTimeoutAttempts})`, { type: 'continuation-timeout' });

        await notifyContinuation({
          type: 'timeout',
          attempt: continuationAttempt,
          maxAttempts: maxTimeoutAttempts,
          deliveryContext,
        });

        continue;
      }

      // Empty output or context overflow: retry with fresh session (clear resume ID)
      if ((reason === 'EMPTY_OUTPUT' || reason === ErrorReason.EMPTY_OUTPUT || error.emptyOutput || reason === ErrorReason.CONTEXT_OVERFLOW) && continuationAttempt < 2) {
        continuationAttempt++;
        currentSessionId = null; // Fresh session — don't resume the broken one
        currentPrompt = prompt;  // Original prompt, not a continuation prompt

        console.log(`[${LOG_PREFIX}] ${reason} — retrying with fresh session (attempt ${continuationAttempt})`);
        addActivity('action', `${reason} — retrying with fresh session (attempt ${continuationAttempt})`, { type: 'continuation-empty-output' });

        await sleep(1000);
        continue;
      }

      // Rate limit: deferred continuation
      if (reason === ErrorReason.RATE_LIMIT && continuationAttempt < maxRateLimitAttempts) {
        const waitMs = estimateRateLimitWait(error);
        const resumeAfter = new Date(Date.now() + waitMs);

        console.log(`[${LOG_PREFIX}] Rate limited — scheduling continuation in ${formatDuration(waitMs)} (resume after ${resumeAfter.toISOString()})`);
        addActivity('action', `Rate limited — continuation scheduled for ${resumeAfter.toISOString()}`, { type: 'continuation-rate-limit' });

        await writeContinuation(paths.root, {
          agentId: AGENT_ID,
          type: 'rate_limit',
          state: 'pending',
          resumeAfter: resumeAfter.toISOString(),
          claudeSessionId: failedSessionId,
          taskType: runOptions.taskType,
          model: runOptions.model,
          maxTurns: runOptions.maxTurns || 30,
          cwd: runOptions.cwd,
          prompt: prompt.slice(0, 500),
          promptFull: prompt,
          deliveryContext,
          attempt: continuationAttempt + 1,
          maxAttempts: maxRateLimitAttempts,
          originalError: error.message,
        });

        await notifyContinuation({
          type: 'rate_limit',
          waitMs,
          resumeAfter,
          deliveryContext,
        });

        // Mark error as scheduled so caller can return 202 instead of 500
        error.continuationScheduled = true;
        error.resumeAfter = resumeAfter.toISOString();
        throw error;
      }

      // Non-continuable error — throw as-is
      throw error;
    }
  }
}

/**
 * Continuation scanner — checks for deferred continuations ready to resume.
 * Runs periodically via setInterval.
 */
async function scanContinuations() {
  try {
    const ready = await readReadyContinuations(paths.root);
    if (ready.length === 0) return;

    console.log(`[${LOG_PREFIX}] Found ${ready.length} continuation(s) ready to resume`);

    for (const cont of ready) {
      // Skip if agent has active tasks
      if (hasActiveTasks()) {
        console.log(`[${LOG_PREFIX}] Skipping continuation ${cont.id.slice(0, 8)} — agent busy (${activeTaskCount} active)`);
        continue;
      }

      await executeContinuation(cont);
    }

    // Periodic cleanup
    await cleanupOldContinuations(paths.root, CONTINUATION_CONFIG.maxAge);
  } catch (e) {
    console.error(`[${LOG_PREFIX}] Continuation scan error:`, e.message);
  }
}

/**
 * Execute a single deferred continuation
 */
async function executeContinuation(cont) {
  console.log(`[${LOG_PREFIX}] Executing continuation ${cont.id.slice(0, 8)} (${cont.type}, attempt ${cont.attempt}/${cont.maxAttempts})`);
  addActivity('action', `Resuming ${cont.type} task (attempt ${cont.attempt})`, { type: 'continuation-resume', id: cont.id });

  await updateContinuation(paths.root, cont.id, { state: 'running' });

  await notifyContinuation({
    type: 'resuming',
    attempt: cont.attempt,
    maxAttempts: cont.maxAttempts,
    deliveryContext: cont.deliveryContext,
  });

  incrementActiveTask();

  try {
    const prompt = cont.claudeSessionId
      ? buildContinuationPrompt(cont.attempt)
      : cont.promptFull;

    const { result: output, sessionId: claudeSessionId } = await runClaudeCode(prompt, {
      model: cont.model || runtime.model,
      maxTurns: cont.maxTurns || 30,
      cwd: cont.cwd || paths.repo,
      taskType: cont.taskType,
      agentRoot: paths.root,
      agentId: AGENT_ID,
      resumeSessionId: cont.claudeSessionId,
      isResume: !!cont.claudeSessionId,
      skipDedup: true,
      deliveryContext: cont.deliveryContext,
    });

    decrementActiveTask();
    await clearContinuation(paths.root, cont.id);

    if (cont.deliveryContext?.channelId && output && !isSilentReply(output)) {
      await sendRecoveryResult(cont, output);
    }

    addActivity('output', `Continuation completed: ${trunc(output, 0, 200)}${(output || '').length > 200 ? '...' : ''}`, { type: 'continuation-complete' });
    console.log(`[${LOG_PREFIX}] Continuation ${cont.id.slice(0, 8)} completed successfully`);
  } catch (error) {
    decrementActiveTask();
    const reason = error.errorReason || classifyError(error);

    if (reason === ErrorReason.RATE_LIMIT && cont.attempt < cont.maxAttempts) {
      const waitMs = estimateRateLimitWait(error);
      const resumeAfter = new Date(Date.now() + waitMs);

      await updateContinuation(paths.root, cont.id, {
        state: 'pending',
        attempt: cont.attempt + 1,
        resumeAfter: resumeAfter.toISOString(),
        claudeSessionId: error.claudeSessionId || cont.claudeSessionId,
        history: [...(cont.history || []), { attempt: cont.attempt, error: 'rate_limit', at: new Date().toISOString() }],
      });

      await notifyContinuation({ type: 'rate_limit', waitMs, resumeAfter, deliveryContext: cont.deliveryContext });
    } else if ((reason === ErrorReason.TIMEOUT || error.isTimeout) && cont.attempt < cont.maxAttempts) {
      await updateContinuation(paths.root, cont.id, {
        state: 'pending',
        attempt: cont.attempt + 1,
        resumeAfter: new Date().toISOString(),
        claudeSessionId: error.claudeSessionId || cont.claudeSessionId,
        history: [...(cont.history || []), { attempt: cont.attempt, error: 'timeout', at: new Date().toISOString() }],
      });
    } else {
      await updateContinuation(paths.root, cont.id, { state: 'failed', error: error.message });

      await notifyContinuation({
        type: 'failed',
        attempt: cont.attempt,
        maxAttempts: cont.maxAttempts,
        message: `❌ Task failed after ${cont.attempt} attempt(s): ${error.message.slice(0, 200)}`,
        deliveryContext: cont.deliveryContext,
      });

      console.error(`[${LOG_PREFIX}] Continuation ${cont.id.slice(0, 8)} failed permanently: ${error.message}`);
    }
  }
}

// ============================================
// Portal Auth + Data Endpoints
// ============================================

// Lazy-import auth module (only loaded when portal endpoints hit)
let _authModule = null;
async function getAuthModule() {
  if (!_authModule) {
    _authModule = await import('./lib/auth/passkey.js');
  }
  return _authModule;
}

// Helper: extract session token from Authorization header or cookie
function extractSessionToken(req) {
  const auth = req.headers['authorization'];
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  // Fallback to HttpOnly cookie (same-origin portal requests)
  if (req.cookies?.mycelium_session) return req.cookies.mycelium_session;
  return null;
}

// Cookie name and options for session management
const SESSION_COOKIE = 'mycelium_session';
function setSessionCookie(res, token, expiresAt) {
  const maxAge = expiresAt ? Math.max(0, new Date(expiresAt).getTime() - Date.now()) : 7 * 24 * 60 * 60 * 1000;
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAge / 1000)}${process.env.NODE_ENV === 'production' || process.env.SECURE_COOKIES === '1' ? '; Secure' : ''}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// CSRF protection via double-submit cookie pattern
const CSRF_COOKIE = 'mycelium_csrf';
const isProduction = process.env.NODE_ENV === 'production' || process.env.SECURE_COOKIES === '1';

function setCsrfCookie(res) {
  const csrfToken = crypto.randomBytes(32).toString('hex');
  // Non-HttpOnly so JavaScript can read it to send as header
  const existing = res.getHeader('Set-Cookie');
  const cookies = Array.isArray(existing) ? existing : existing ? [existing] : [];
  cookies.push(`${CSRF_COOKIE}=${csrfToken}; Path=/; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}${isProduction ? '; Secure' : ''}`);
  res.setHeader('Set-Cookie', cookies);
}

/** CSRF middleware — validates double-submit cookie on state-changing requests. */
function csrfProtect(req, res, next) {
  // Safe methods don't need CSRF
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // Auth endpoints are pre-login — no CSRF cookie exists yet
  if (req.path.startsWith('/auth/')) return next();
  // Portal endpoints use session cookie auth + encrypted WS channel — CSRF double-submit
  // is unreliable here (SameSite cookie issues on CF proxy). Session auth is sufficient.
  if (req.path.startsWith('/portal/')) return next();
  // Agent chat stream also exempt (session auth)
  if (req.path === '/chat/stream') return next();
  // API token auth (agent-to-agent) skips CSRF
  if (req.headers['authorization']?.startsWith('Bearer ')) return next();
  // Worker secret auth skips CSRF
  if (req.headers['x-worker-secret']) return next();
  // Direct localhost (inter-process: Discord bots, orchestrator) skips CSRF
  const socketIp = req.socket?.remoteAddress || '';
  if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(socketIp) && !req.headers['x-forwarded-for']) return next();

  const cookieToken = req.cookies?.[CSRF_COOKIE];
  const headerToken = req.headers['x-csrf-token'];
  if (!cookieToken || !headerToken || !safeCompare(cookieToken, headerToken)) {
    return res.status(403).json({ error: 'CSRF validation failed' });
  }
  next();
}

// Helper: authenticate portal request (reads token from Bearer header or HttpOnly cookie)
async function authenticatePortalRequest(req) {
  const token = extractSessionToken(req);
  if (!token) return null;

  let user;
  // App token auth — for native apps that can't do WebAuthn passkey login
  if (process.env.PORTAL_APP_TOKEN && safeCompare(token, process.env.PORTAL_APP_TOKEN)) {
    const db = tryGetDb();
    if (!db) return null;
    const raw = await db.users.getFirst();
    if (!raw) return null;
    user = {
      id: raw.id,
      displayName: raw.display_name,
      timezone: raw.timezone,
      settings: raw.settings ? JSON.parse(raw.settings) : {},
    };
  } else {
    const auth = await getAuthModule();
    user = await auth.validateSession(token);
  }

  // Auto-update timezone from browser header (fire-and-forget)
  if (user) {
    const browserTz = req.headers['x-timezone'];
    if (browserTz && browserTz !== user.timezone && browserTz.includes('/')) {
      const db = tryGetDb();
      if (db) {
        db.users.updateTimezone(user.id, browserTz).catch(() => {});
        user.timezone = browserTz;
      }
    }
  }

  // Attach user to request for audit middleware (portal access logging)
  if (user) req._auditUser = user;

  return user;
}

// Helper: require worker secret for non-local requests.
// Only direct localhost socket connections (inter-process) skip auth.
// Requests proxied through Caddy (X-Forwarded-For present) always require auth.
function requireWorkerSecret(req, res) {
  const socketIp = req.socket?.remoteAddress || '';
  const isLocalSocket = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(socketIp);
  const isProxied = !!req.headers['x-forwarded-for'];

  // Direct localhost (inter-agent/orchestrator calls) — skip auth
  if (isLocalSocket && !isProxied) return true;

  // All other requests: require worker secret
  if (MYA_WORKER_SECRET) {
    const secret = req.headers['x-worker-secret'];
    if (!safeCompare(secret, MYA_WORKER_SECRET)) {
      res.status(401).json({ error: 'Unauthorized' });
      return false;
    }
  }
  return true;
}

/** Silent version — returns boolean without sending 401 response. */
function requireWorkerSecretSilent(req) {
  const socketIp = req.socket?.remoteAddress || '';
  const isLocalSocket = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(socketIp);
  const isProxied = !!req.headers['x-forwarded-for'];
  if (isLocalSocket && !isProxied) return true;
  if (!MYA_WORKER_SECRET) return true;
  return safeCompare(req.headers['x-worker-secret'], MYA_WORKER_SECRET);
}

// Rate limiter for auth endpoints (per IP, 10 attempts per minute)
const authRateLimits = new Map();
function checkAuthRateLimit(req, res) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const now = Date.now();
  const window = 60_000;
  const maxAttempts = 10;

  let entry = authRateLimits.get(ip);
  if (!entry || now - entry.windowStart > window) {
    entry = { windowStart: now, count: 0 };
    authRateLimits.set(ip, entry);
  }
  entry.count++;

  // Cleanup old entries periodically
  if (authRateLimits.size > 1000) {
    for (const [k, v] of authRateLimits) {
      if (now - v.windowStart > window) authRateLimits.delete(k);
    }
  }

  if (entry.count > maxAttempts) {
    tryGetDb()?.audit.log({ action: 'auth.rate_limited', ip, details: { attempts: entry.count } }).catch(() => {});
    res.status(429).json({ error: 'Too many requests' });
    return false;
  }
  return true;
}

// Security email notifications (new device registered, login, export).
//
// Two-key separation: agents NEVER have ADMIN_SECRET in their env. Instead
// they call the tenant self-service endpoint /api/notify-self with their
// AGENT_TOKEN. The Worker resolves the destination email from the OWNER D1's
// provisioning_jobs table using identity.user_id — the agent has no ability
// to send mail to anyone except the customer who owns this VPS.
async function sendSecurityEmail(event, req, details = {}) {
  const workerUrl = process.env.MYA_WORKER_URL;
  const agentToken = process.env.AGENT_TOKEN;
  if (!workerUrl || !agentToken) return;

  try {
    await fetch(`${workerUrl}/api/notify-self`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentToken}` },
      body: JSON.stringify({
        event,
        details: {
          ip: req?.ip || req?.headers?.['x-forwarded-for'] || 'unknown',
          ua: req?.headers?.['user-agent'] || 'unknown',
          ...(details || {}),
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.warn(`[Auth] Security email failed (${event}):`, e.message);
  }
}

// Cross-tenant connection request email — calls /api/notify-peer with the
// agent token. The Worker resolves toHandle → user_id → email centrally
// (handle_reservations + provisioning_jobs in owner DB), enforces a per-sender
// rate limit (KV), and sends a templated email. The agent CANNOT supply
// free-form text or target an arbitrary email address.
async function sendConnectionEmail(toHandle, fromHandle, fromSignature) {
  const workerUrl = process.env.MYA_WORKER_URL;
  const agentToken = process.env.AGENT_TOKEN;
  if (!workerUrl || !agentToken) return;

  try {
    await fetch(`${workerUrl}/api/notify-peer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentToken}` },
      body: JSON.stringify({
        toHandle,
        fromHandle,
        signature: fromSignature || null,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.warn('[Connections] Email notification failed:', e.message);
  }
}

// Daily rate limiter for high-value operations (export)
const dailyLimits = new Map();
function checkDailyLimit(userId, operation, maxPerDay = 3) {
  const key = `${userId}:${operation}`;
  const now = Date.now();
  const dayMs = 86400000;
  let entry = dailyLimits.get(key);
  if (!entry || now - entry.start > dayMs) {
    entry = { start: now, count: 0 };
    dailyLimits.set(key, entry);
  }
  entry.count++;
  if (dailyLimits.size > 500) {
    for (const [k, v] of dailyLimits) { if (now - v.start > dayMs) dailyLimits.delete(k); }
  }
  return entry.count <= maxPerDay;
}

// General-purpose rate limiter for resource-intensive endpoints
const endpointLimits = new Map();
function checkRateLimit(req, res, endpoint, maxPerMinute = 30) {
  const key = `${req.ip || 'local'}:${endpoint}`;
  const now = Date.now();
  let entry = endpointLimits.get(key);
  if (!entry || now - entry.start > 60_000) {
    entry = { start: now, count: 0 };
    endpointLimits.set(key, entry);
  }
  entry.count++;
  if (endpointLimits.size > 2000) {
    for (const [k, v] of endpointLimits) { if (now - v.start > 60_000) endpointLimits.delete(k); }
  }
  if (entry.count > maxPerMinute) {
    res.status(429).json({ error: 'Rate limit exceeded' });
    return false;
  }
  return true;
}

// -- Auth: First-run setup (bootstrap owner account) --

let setupToken = null;

async function checkFirstRun() {
  try {
    const db = tryGetDb();
    if (!db) return;
    const count = await db.users.count();
    if (count === 0) {
      // Managed hosting: skip setup token — users authenticate via master key
      // Self-hosted: show setup token in logs
      const isManaged = !!process.env.MYA_USER_ID;
      if (isManaged) {
        console.log(`[${LOG_PREFIX}] Managed instance — first login via master key (no setup token)`);
        return; // setupToken stays null → login page shows master key form
      }
      setupToken = crypto.randomUUID();
      console.log(`\n${'='.repeat(50)}`);
      console.log(`  FIRST-RUN SETUP`);
      console.log(`  Setup token: ${setupToken}`);
      console.log(`  Enter this at your portal to register.`);
      console.log(`${'='.repeat(50)}\n`);
    }
  } catch (e) {
    console.error(`[${LOG_PREFIX}] First-run check failed:`, e.message);
  }
}

// ── Tenant Identity Verification ──────────────────────────────────────────

let identityCheck = { verified: false, errors: [], warnings: [] };

async function verifyTenantIdentity() {
  const userId = process.env.MYA_USER_ID;
  if (!userId) {
    console.log(`[${LOG_PREFIX}] Self-hosted mode — no tenant verification`);
    identityCheck = { verified: true, mode: 'self-hosted', errors: [], warnings: [] };
    return;
  }

  const errors = [];
  const warnings = [];
  let handle = null;
  let expectedIp = null;

  // 1. Check provisioning record in owner D1
  try {
    const db = tryGetDb();
    if (db) {
      const rows = await db.rawQueryOwner(
        'SELECT handle, vps_ip, email FROM provisioning_jobs WHERE user_id = ? AND status = ? LIMIT 1',
        [userId, 'ready']
      );
      if (!rows?.length) {
        // No provisioning record — this is the owner VPS (MYA_USER_ID set for data filtering)
        identityCheck = { verified: true, mode: 'owner', userId: userId.substring(0, 12) + '...', errors: [], warnings: [] };
        console.log(`[${LOG_PREFIX}] ✓ Owner instance (not in provisioning_jobs)`);
        return;
      } else {
        handle = rows[0].handle;
        expectedIp = rows[0].vps_ip;
      }
    }
  } catch (e) {
    warnings.push(`Could not check provisioning: ${e.message}`);
  }

  // 2. Verify PASSKEY_RP_ORIGIN matches handle
  const rpOrigin = process.env.PASSKEY_RP_ORIGIN;
  if (rpOrigin && handle) {
    const expectedOrigin = `https://${handle}.mycelium.id`;
    if (rpOrigin !== expectedOrigin) {
      errors.push(`PASSKEY_RP_ORIGIN mismatch: got ${rpOrigin}, expected ${expectedOrigin}`);
    }
  }

  // 3. Test tenant D1 routing
  try {
    const db = tryGetDb();
    if (db) {
      const rows = await db.rawQuery('SELECT 1 as ok');
      if (!rows?.length || rows[0]?.ok !== 1) {
        errors.push('Tenant D1 query test failed');
      }
    }
  } catch (e) {
    errors.push(`Tenant D1 unreachable: ${e.message}`);
  }

  identityCheck = {
    verified: errors.length === 0,
    mode: 'managed',
    handle,
    userId: userId.substring(0, 12) + '...',
    rpOriginOk: !rpOrigin || !handle || rpOrigin === `https://${handle}.mycelium.id`,
    tenantD1Ok: !errors.some(e => e.includes('D1')),
    errors,
    warnings,
  };

  if (errors.length > 0) {
    console.error(`[${LOG_PREFIX}] ⚠ IDENTITY CHECK FAILED:`);
    for (const e of errors) console.error(`[${LOG_PREFIX}]   ✗ ${e}`);
  } else {
    console.log(`[${LOG_PREFIX}] ✓ Identity verified: @${handle}, tenant D1 OK`);
  }
  for (const w of warnings) console.warn(`[${LOG_PREFIX}]   ⚠ ${w}`);
}

// Identity check endpoint
app.get('/health/identity', async (req, res) => {
  res.json(identityCheck);
});

// Admin: tenant overview
app.get('/admin/tenants', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    // Only allow from owner VPS (check if this is the main instance)
    if (process.env.MYA_USER_ID) return res.status(403).json({ error: 'Not available on tenant instances' });

    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const tenants = await db.rawQuery(
      "SELECT handle, email, vps_ip, user_id, status, created_at FROM provisioning_jobs ORDER BY created_at"
    );

    const deployments = await db.rawQuery(
      "SELECT handle, commit_sha, status, deployed_at FROM deployment_log ORDER BY deployed_at DESC LIMIT 20"
    ).catch(() => []);

    res.json({ tenants, recentDeployments: deployments });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/auth/setup-status', async (req, res) => {
  // Public: only reveal whether setup is needed (login page form selection)
  const isManaged = !!process.env.MYA_USER_ID;
  let hasPasskeys = false;
  try {
    const db = tryGetDb();
    if (db && process.env.MYA_USER_ID) {
      const creds = await db.passkeys.listByUser(process.env.MYA_USER_ID);
      hasPasskeys = creds && creds.length > 0;
    }
  } catch {}

  // Authenticated callers get full details; unauthenticated get minimal info
  const user = await authenticatePortalRequest(req);
  if (user) {
    let handle = null;
    try {
      const db = tryGetDb();
      const profile = await db.profiles?.get(user.id);
      if (profile?.handle) handle = profile.handle;
      if (!handle) {
        const u = await db.users.getFirst();
        if (u?.display_name) handle = u.display_name;
      }
    } catch {}
    return res.json({
      setupRequired: setupToken !== null,
      hasPasskeys,
      handle,
      encryptionEnabled: existsSync('/run/mycelium/master.key') || !!process.env.ENCRYPTION_MASTER_KEY,
    });
  }

  // Unauthenticated: minimal info only
  res.json({ setupRequired: setupToken !== null, hasPasskeys });
});

// DEPRECATED: Master key must be set via VPS script (scripts/set-master-key.sh), never through HTTP.
// Swiss Vault: the master key never leaves the VPS and is never transmitted over the network.
app.post('/auth/set-master-key', async (_req, res) => {
  return res.status(410).json({
    error: 'This endpoint has been disabled for security. Set the master key on the VPS using: bash scripts/set-master-key.sh'
  });
});

// ── Master Key Restore & Rotation (portal Settings) ──

/**
 * POST /portal/master-key/restore
 * Restore an existing master key (after VPS reboot, key cache loss).
 * Verifies the key hash matches D1, then writes to tmpfs.
 * No data re-encryption — the key just becomes available again.
 */
app.post('/portal/master-key/restore', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { key } = req.body;
    if (!key || typeof key !== 'string' || key.length !== 64 || !/^[0-9a-fA-F]+$/.test(key)) {
      return res.status(400).json({ error: 'Master key must be 64 hex characters' });
    }

    // Verify hash matches provisioning_jobs.key_hash (owner D1 for managed instances,
    // or skip verification for standalone owner VPS which has no provisioning_jobs row)
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const providedHash = crypto.createHash('sha256').update(key).digest('hex');

    // Try owner D1 first (managed hosting customers)
    let storedHash = null;
    try {
      const jobRows = await db.rawQueryOwner(
        'SELECT key_hash FROM provisioning_jobs WHERE user_id = ? AND status = ? LIMIT 1',
        [user.id, 'ready']
      );
      storedHash = jobRows?.[0]?.key_hash;
    } catch (err) {
      console.warn(`[master-key restore] owner D1 lookup failed: ${err.message}`);
    }

    // For standalone owner VPS (no provisioning_jobs), accept any valid 64-hex key
    // as long as passkey auth succeeded (which already happened above).
    if (!storedHash) {
      console.log(`[master-key restore] No provisioning_jobs row — standalone mode, accepting key based on passkey auth`);
    } else if (!safeCompare(providedHash, storedHash)) {
      tryGetDb()?.audit.log({ action: 'master_key.restore_failed', userId: user.id, ip: req.ip }).catch(() => {});
      return res.status(401).json({ error: 'Master key does not match' });
    }

    // Write to tmpfs (mode 0o400)
    const tmpfsPath = '/run/mycelium/master.key';
    try {
      // Ensure /run/mycelium exists
      const mkdirSync = (await import('fs')).mkdirSync;
      try { mkdirSync('/run/mycelium', { recursive: true, mode: 0o700 }); } catch {}

      const writeFileSync = (await import('fs')).writeFileSync;
      writeFileSync(tmpfsPath, key, { mode: 0o400 });
    } catch (err) {
      console.error(`[master-key restore] tmpfs write failed: ${err.message}`);
      return res.status(500).json({ error: 'Failed to write key to tmpfs' });
    }

    // Clear caches and verify the key works by loading it
    let kmsStored = false;
    try {
      const { clearAllCaches, getMasterKeyFromBestSource } = await import('./lib/crypto-local.js');
      await clearAllCaches();
      const loadedKey = await getMasterKeyFromBestSource();
      if (!loadedKey) throw new Error('Key load failed');

      // Reset db-d1 master key cache
      const dbMod = await import('./lib/db-d1.js');
      if (dbMod.resetMasterKeyCache) dbMod.resetMasterKeyCache();

      // If KMS configured, store in KMS too (so reboots auto-recover)
      if (process.env.KMS_URL) {
        try {
          // Use admin cert from VPS to call KMS /wrap
          // The VPS-side KMS client doesn't have admin cert by default — use raw fetch
          const adminCertPath = process.env.KMS_ADMIN_CERT_PATH || '/etc/mycelium/kms-admin-certs';
          const fs = await import('fs');
          const https = (await import('https')).default;
          const adminCert = fs.readFileSync(`${adminCertPath}/admin.crt`);
          const adminKey = fs.readFileSync(`${adminCertPath}/admin.key`);
          const ca = fs.readFileSync(`${adminCertPath}/ca.crt`);

          const url = new URL('/wrap', process.env.KMS_URL);
          const customerId = process.env.KMS_CUSTOMER_ID || process.env.MYA_USER_ID;

          await new Promise((resolve, reject) => {
            const options = {
              method: 'POST', hostname: url.hostname, port: url.port || 8443,
              path: url.pathname,
              cert: adminCert, key: adminKey, ca,
              rejectUnauthorized: true, minVersion: 'TLSv1.3',
              headers: { 'Content-Type': 'application/json' },
              timeout: 10000,
            };
            const r = https.request(options, (resp) => {
              let data = '';
              resp.on('data', c => data += c);
              resp.on('end', () => {
                if (resp.statusCode === 409) { kmsStored = true; resolve(); /* already exists */ }
                else if (resp.statusCode >= 400) reject(new Error(`KMS ${resp.statusCode}: ${data}`));
                else { kmsStored = true; resolve(); }
              });
            });
            r.on('error', reject);
            r.on('timeout', () => { r.destroy(); reject(new Error('KMS timeout')); });
            r.write(JSON.stringify({ customerId, kek: key }));
            r.end();
          });
        } catch (kmsErr) {
          console.error(`[master-key restore] KMS wrap failed: ${kmsErr.message}`);
          // Non-fatal — key is on tmpfs, agents can still use it
        }
      }
    } catch (err) {
      return res.status(500).json({ error: `Key written but failed to activate: ${err.message}` });
    }

    tryGetDb()?.audit.log({ action: 'master_key.restored', userId: user.id, ip: req.ip, details: { kmsStored } }).catch(() => {});
    res.json({ ok: true, kmsStored });
  } catch (err) {
    console.error(`[master-key restore] error: ${err.message}`);
    res.status(500).json({ error: 'Restore failed' });
  }
});

/**
 * POST /portal/master-key/rotate
 * Rotate to a new master key. Re-wraps all encrypted records.
 * Streams progress via SSE.
 */
app.post('/portal/master-key/rotate', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { currentKey, newKey } = req.body;
    for (const [name, k] of [['currentKey', currentKey], ['newKey', newKey]]) {
      if (!k || typeof k !== 'string' || k.length !== 64 || !/^[0-9a-fA-F]+$/.test(k)) {
        return res.status(400).json({ error: `${name} must be 64 hex characters` });
      }
    }
    if (currentKey === newKey) {
      return res.status(400).json({ error: 'New key must be different from current key' });
    }

    // Verify current key hash matches provisioning_jobs (owner D1)
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const currentHash = crypto.createHash('sha256').update(currentKey).digest('hex');

    let storedHash = null;
    try {
      const jobRows = await db.rawQueryOwner(
        'SELECT key_hash FROM provisioning_jobs WHERE user_id = ? AND status = ? LIMIT 1',
        [user.id, 'ready']
      );
      storedHash = jobRows?.[0]?.key_hash;
    } catch (err) {
      console.warn(`[master-key rotate] owner D1 lookup failed: ${err.message}`);
    }

    // For managed customers: verify hash matches. For standalone owner: verify by attempting to use the key.
    if (storedHash && !safeCompare(currentHash, storedHash)) {
      tryGetDb()?.audit.log({ action: 'master_key.rotate_failed', userId: user.id, ip: req.ip, details: { reason: 'hash mismatch' } }).catch(() => {});
      return res.status(401).json({ error: 'Current master key does not match' });
    }

    // If no stored hash (standalone mode), verify the current key by attempting to use it
    if (!storedHash) {
      try {
        const { importMasterKey, encrypt, decrypt } = await import('./lib/crypto-local.js');
        const testKey = await importMasterKey(currentKey);
        const testEnvelope = await encrypt('verification', 'personal', testKey);
        await decrypt(testEnvelope, testKey);
      } catch {
        return res.status(401).json({ error: 'Current master key is invalid' });
      }
    }

    // Set up SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const sendSSE = (event) => {
      try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch {}
    };

    sendSSE({ type: 'started' });

    try {
      const { importMasterKey } = await import('./lib/crypto-local.js');
      const oldMasterKey = await importMasterKey(currentKey);
      const newMasterKey = await importMasterKey(newKey);

      sendSSE({ type: 'rewrapping' });

      const { rewrapAllRecords } = await import('./lib/db-d1.js');
      const result = await rewrapAllRecords(oldMasterKey, newMasterKey, (progress) => {
        sendSSE({ type: 'progress', ...progress });
      });

      sendSSE({ type: 'finalizing', ...result });

      // Update provisioning_jobs.key_hash in owner D1 (if this customer has a row)
      if (storedHash) {
        const newHash = crypto.createHash('sha256').update(newKey).digest('hex');
        try {
          await db.rawQueryOwner(
            'UPDATE provisioning_jobs SET key_hash = ? WHERE user_id = ? AND status = ?',
            [newHash, user.id, 'ready']
          );
        } catch (err) {
          console.warn(`[master-key rotate] failed to update provisioning_jobs.key_hash: ${err.message}`);
        }
      }

      // Write new key to tmpfs
      const fs = await import('fs');
      try { fs.mkdirSync('/run/mycelium', { recursive: true, mode: 0o700 }); } catch {}
      fs.writeFileSync('/run/mycelium/master.key', newKey, { mode: 0o400 });

      // Clear caches
      const { clearAllCaches } = await import('./lib/crypto-local.js');
      await clearAllCaches();
      const dbMod = await import('./lib/db-d1.js');
      if (dbMod.resetMasterKeyCache) dbMod.resetMasterKeyCache();

      // KMS update if configured
      if (process.env.KMS_URL) {
        // Same admin cert flow as restore — wrap is idempotent (overwrites)
        sendSSE({ type: 'kms-updating' });
        // Caller of this endpoint should call /portal/master-key/restore on the new key
        // to update KMS, OR we can do it inline here. Inline is simpler.
        try {
          const adminCertPath = process.env.KMS_ADMIN_CERT_PATH || '/etc/mycelium/kms-admin-certs';
          const adminCert = fs.readFileSync(`${adminCertPath}/admin.crt`);
          const adminKey = fs.readFileSync(`${adminCertPath}/admin.key`);
          const ca = fs.readFileSync(`${adminCertPath}/ca.crt`);
          const https = (await import('https')).default;
          const url = new URL('/wrap', process.env.KMS_URL);
          const customerId = process.env.KMS_CUSTOMER_ID || process.env.MYA_USER_ID;

          // Delete existing then re-wrap
          await new Promise((resolve) => {
            const r = https.request({
              method: 'DELETE', hostname: url.hostname, port: url.port || 8443,
              path: `/customer/${customerId}`,
              cert: adminCert, key: adminKey, ca,
              rejectUnauthorized: true, minVersion: 'TLSv1.3',
              timeout: 10000,
            }, () => resolve());
            r.on('error', () => resolve());
            r.end();
          });

          // Now /wrap with new key
          await new Promise((resolve, reject) => {
            const r = https.request({
              method: 'POST', hostname: url.hostname, port: url.port || 8443,
              path: url.pathname,
              cert: adminCert, key: adminKey, ca,
              rejectUnauthorized: true, minVersion: 'TLSv1.3',
              headers: { 'Content-Type': 'application/json' },
              timeout: 10000,
            }, (resp) => {
              let data = '';
              resp.on('data', c => data += c);
              resp.on('end', () => {
                if (resp.statusCode >= 400) reject(new Error(`KMS ${resp.statusCode}: ${data}`));
                else resolve();
              });
            });
            r.on('error', reject);
            r.write(JSON.stringify({ customerId, kek: newKey }));
            r.end();
          });
        } catch (kmsErr) {
          sendSSE({ type: 'warning', message: `KMS update failed: ${kmsErr.message}` });
        }
      }

      tryGetDb()?.audit.log({ action: 'master_key.rotated', userId: user.id, ip: req.ip, details: result }).catch(() => {});

      sendSSE({ type: 'complete', ...result });
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (err) {
      sendSSE({ type: 'error', message: err.message });
      res.write('data: [DONE]\n\n');
      res.end();
    }
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: 'Rotation failed' });
    }
  }
});

// First login for managed hosting: verify master key hash → create registration code
app.post('/auth/first-login', async (req, res) => {
  if (!checkAuthRateLimit(req, res)) return;

  const { keyHash } = req.body;
  if (!keyHash || keyHash.length !== 64) {
    return res.status(400).json({ error: 'Master key hash required (64 hex chars)' });
  }

  try {
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const userId = process.env.MYA_USER_ID;
    if (!userId) return res.status(503).json({ error: 'User ID not configured' });

    // Check no passkeys exist yet (first login only)
    const existingCreds = await db.passkeys.listByUser(userId);
    if (existingCreds && existingCreds.length > 0) {
      return res.status(409).json({ error: 'Passkeys already registered. Use normal login.' });
    }

    // Verify key hash against provisioning_jobs (owner's D1 — management data)
    const rows = await db.rawQueryOwner(
      'SELECT key_hash FROM provisioning_jobs WHERE user_id = ? AND status = ? LIMIT 1',
      [userId, 'ready']
    );
    const storedHash = rows?.[0]?.key_hash;

    if (!storedHash) {
      return res.status(404).json({ error: 'No provisioning record found' });
    }

    // Timing-safe compare
    const a = Buffer.from(keyHash, 'hex');
    const b = Buffer.from(storedHash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'Invalid key' });
    }

    // Key verified — master key must already be set on VPS during provisioning.
    // It is never transmitted from the browser (Swiss Vault: key stays on VPS).
    if (!existsSync('/run/mycelium/master.key') && !process.env.ENCRYPTION_MASTER_KEY) {
      console.warn(`[${LOG_PREFIX}] First login verified but master key not set. Run scripts/set-master-key.sh on VPS.`);
    }

    // Ensure user exists in tenant D1, then generate registration code
    const existingUsers = await db.rawQuery(`SELECT id FROM users WHERE id = ?`, [userId]);
    const existingUser = existingUsers?.[0];
    if (!existingUser) {
      // Look up display name from provisioning job (owner D1)
      const jobRows = await db.rawQueryOwner(
        'SELECT email, handle FROM provisioning_jobs WHERE user_id = ? AND status = ? LIMIT 1',
        [userId, 'ready']
      );
      const displayName = jobRows?.[0]?.handle || jobRows?.[0]?.email?.split('@')[0] || 'User';
      await db.users.create(userId, displayName);
    }

    const regCode = crypto.randomBytes(16).toString('hex');
    await db.registrationTokens.create(regCode, userId);

    console.log(`[${LOG_PREFIX}] First login verified for ${userId} — passkey registration enabled`);
    db.audit.log({ action: 'auth.first_login', userId, ip: req.ip, resourceType: 'key_hash' }).catch(() => {});
    res.json({ registrationCode: regCode });
  } catch (e) {
    console.error(`[${LOG_PREFIX}] First login failed:`, e.message);
    res.status(500).json({ error: 'Verification failed' });
  }
});

app.post('/auth/setup', async (req, res) => {
  if (!checkAuthRateLimit(req, res)) return;
  if (!setupToken) return res.status(403).json({ error: 'Setup already complete' });

  const { token, displayName } = req.body;
  if (!safeCompare(token, setupToken)) return res.status(401).json({ error: 'Invalid setup token' });

  try {
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const userId = crypto.randomBytes(16).toString('hex');
    await db.users.create(userId, displayName || 'Owner');

    const regCode = crypto.randomBytes(16).toString('hex');
    await db.registrationTokens.create(regCode, userId);

    setupToken = null;

    console.log(`[${LOG_PREFIX}] Setup complete — owner account created (${userId})`);
    res.json({ registrationCode: regCode });
  } catch (e) {
    console.error(`[${LOG_PREFIX}] Setup failed:`, e.message);
    res.status(500).json({ error: 'Setup failed' });
  }
});

// -- Auth: Passkey registration options --
app.post('/auth/passkey/register/options', async (req, res) => {
  if (!requireWorkerSecret(req, res)) return;
  if (!checkAuthRateLimit(req, res)) return;
  try {
    const { registrationCode } = req.body;
    if (!registrationCode) return res.status(400).json({ error: 'Registration code required' });
    const auth = await getAuthModule();
    const { options } = await auth.generateRegOptions(registrationCode);
    res.json(options);
  } catch (e) {
    res.status(400).json({ error: 'Invalid or expired registration code' });
  }
});

// -- Auth: Passkey registration verify --
app.post('/auth/passkey/register/verify', async (req, res) => {
  if (!requireWorkerSecret(req, res)) return;
  if (!checkAuthRateLimit(req, res)) return;
  try {
    const { registrationCode, credential, urk } = req.body;
    if (!registrationCode || !credential) return res.status(400).json({ error: 'Missing fields' });
    const auth = await getAuthModule();
    const result = await auth.verifyReg(registrationCode, credential, urk || null);

    // If PRF supported and URK derived, migrate KMS to URK-wrapped mode
    if (result.urk && result.credentialId && process.env.KMS_URL) {
      try {
        const { migrateKmsToUrk, provideUrk: provideUrkFn } = await import('./lib/kms-client.js');
        await migrateKmsToUrk(result.urk, result.credentialId);
        await provideUrkFn(result.urk, result.credentialId);
        console.log(`[Auth] First passkey with PRF — KEK migrated to URK-wrapped mode`);
      } catch (kmsErr) {
        console.error(`[Auth] KMS URK migration failed (non-fatal): ${kmsErr.message}`);
      }
    }

    setSessionCookie(res, result.session.token, result.session.expiresAt);
    setCsrfCookie(res);
    res.json({ token: result.session.token, expiresAt: result.session.expiresAt, userId: result.userId, urkAccepted: !!result.urk });
    // Audit: successful registration
    tryGetDb()?.audit.log({ action: 'auth.register', userId: result.userId, ip: req.ip, resourceType: 'passkey' }).catch(() => {});
    sendSecurityEmail('new_device', req).catch(() => {});
  } catch (e) {
    console.error(`[Auth] Passkey registration failed:`, e.message, e.stack?.split('\n')[1]?.trim());
    tryGetDb()?.audit.log({ action: 'auth.register_failed', ip: req.ip, resourceType: 'passkey', details: { reason: e.message?.substring(0, 100) } }).catch(() => {});
    res.status(400).json({ error: 'Registration failed' });
  }
});

// -- Auth: Passkey login options --
app.post('/auth/passkey/login/options', async (req, res) => {
  if (!requireWorkerSecret(req, res)) return;
  if (!checkAuthRateLimit(req, res)) return;
  try {
    const auth = await getAuthModule();
    const options = await auth.generateAuthOptions();
    console.log('[Auth] Generated login options, challenge stored');
    res.json(options);
  } catch (e) {
    console.error('[Auth] Login options failed:', e.message);
    res.status(500).json({ error: 'Authentication unavailable' });
  }
});

// -- Auth: Passkey login verify --
app.post('/auth/passkey/login/verify', async (req, res) => {
  if (!requireWorkerSecret(req, res)) return;
  if (!checkAuthRateLimit(req, res)) return;
  try {
    const { credential, urk } = req.body;
    if (!credential) return res.status(400).json({ error: 'Credential required' });
    const auth = await getAuthModule();
    const result = await auth.verifyAuth(credential, urk || null);

    // If URK provided, send to KMS to unwrap and cache the KEK
    if (result.urk && result.credentialId && process.env.KMS_URL) {
      try {
        const { provideUrk: provideUrkFn } = await import('./lib/kms-client.js');
        await provideUrkFn(result.urk, result.credentialId);
        console.log(`[Auth] URK accepted — KEK cached for ${process.env.KMS_TTL_HOURS || 72}h`);
      } catch (kmsErr) {
        console.error(`[Auth] URK → KMS failed (non-fatal): ${kmsErr.message}`);
      }
    }

    setSessionCookie(res, result.session.token, result.session.expiresAt);
    setCsrfCookie(res);
    res.json({ token: result.session.token, expiresAt: result.session.expiresAt, userId: result.userId, urkAccepted: !!result.urk });
    // Audit: successful login
    tryGetDb()?.audit.log({ action: 'auth.login', userId: result.userId, ip: req.ip, resourceType: 'passkey' }).catch(() => {});
    sendSecurityEmail('login', req).catch(() => {});
  } catch (e) {
    console.error('[Auth] Passkey verify failed:', e.message, e.stack?.split('\n')[1]?.trim());
    // Audit: failed login attempt
    tryGetDb()?.audit.log({ action: 'auth.login_failed', ip: req.ip, resourceType: 'passkey', details: { reason: e.message?.substring(0, 100) } }).catch(() => {});
    res.status(400).json({ error: 'Authentication failed' });
  }
});

// -- Export: Re-authentication via passkey --
// One-time export tokens: Map<token, { userId, createdAt }>
const exportTokens = new Map();
const EXPORT_TOKEN_TTL = 300_000; // 5 minutes

// Cleanup expired export tokens periodically
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of exportTokens) { if (now - v.createdAt > EXPORT_TOKEN_TTL) exportTokens.delete(k); }
}, 60_000);

app.post('/portal/export/auth', async (req, res) => {
  if (!checkAuthRateLimit(req, res)) return;
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    // Check if passkeys exist — if not, skip re-auth
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const creds = await db.passkeys.listByUser(user.id);
    if (!creds || creds.length === 0) {
      // No passkeys — issue token directly (session-only auth fallback)
      const token = crypto.randomBytes(32).toString('hex');
      exportTokens.set(token, { userId: user.id, createdAt: Date.now() });
      return res.json({ exportToken: token, reauthRequired: false });
    }

    // Check if managed (has key_hash for master key verification)
    const userId = process.env.MYA_USER_ID;
    let hasMasterKeyOption = false;
    if (userId) {
      try {
        const rows = await db.rawQueryOwner(
          'SELECT key_hash FROM provisioning_jobs WHERE user_id = ? AND status = ? LIMIT 1',
          [userId, 'ready']
        );
        hasMasterKeyOption = !!rows?.[0]?.key_hash;
      } catch {}
    }

    const auth = await getAuthModule();
    const options = await auth.generateAuthOptions();
    res.json({ options, reauthRequired: true, hasMasterKeyOption });
  } catch (e) {
    console.error('[Export] Auth options failed:', e.message);
    res.status(500).json({ error: 'Re-authentication unavailable' });
  }
});

app.post('/portal/export/verify', async (req, res) => {
  if (!checkAuthRateLimit(req, res)) return;
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { credential, keyHash } = req.body;

    // Option A: Master key hash verification (managed instances)
    // Swiss Vault: only the hash is sent, never the raw key
    if (keyHash) {
      if (keyHash.length !== 64 || !/^[0-9a-f]{64}$/i.test(keyHash)) {
        return res.status(400).json({ error: 'Invalid key hash format' });
      }

      const userId = process.env.MYA_USER_ID;
      if (!userId) return res.status(503).json({ error: 'Not available' });

      // Query owner D1 for key_hash via Worker with agent token
      let storedHash = null;
      const workerUrl = process.env.MYA_WORKER_URL;
      const agentToken = process.env.AGENT_TOKEN || process.env.AGENT_TOKEN_MYA;

      if (workerUrl && agentToken) {
        try {
          const wRes = await fetch(`${workerUrl}/api/db/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentToken}` },
            body: JSON.stringify({ sql: 'SELECT key_hash FROM provisioning_jobs WHERE user_id = ? AND status = ? LIMIT 1', params: [userId, 'ready'] }),
            signal: AbortSignal.timeout(10000),
          });
          if (wRes.ok) {
            const data = await wRes.json();
            storedHash = data.results?.[0]?.key_hash;
          } else {
            console.error(`[Export] Key hash query failed: ${wRes.status} ${await wRes.text().catch(() => '')}`);
          }
        } catch (e) {
          console.error(`[Export] Key hash query error:`, e.message);
        }
      }

      if (!storedHash) {
        return res.status(404).json({ error: 'No key hash on file' });
      }

      const a = Buffer.from(keyHash, 'hex');
      const b = Buffer.from(storedHash, 'hex');
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        logEvent('security.reauth_failed', { userId: user.id, ip: req.ip, method: 'key_hash' });
        return res.status(401).json({ error: 'Invalid key' });
      }

      logEvent('security.reauth_success', { userId: user.id, ip: req.ip, method: 'key_hash' });
      const token = crypto.randomBytes(32).toString('hex');
      exportTokens.set(token, { userId: user.id, createdAt: Date.now() });
      return res.json({ exportToken: token });
    }

    // Option B: Passkey verification
    if (!credential) return res.status(400).json({ error: 'Credential or key hash required' });

    const auth = await getAuthModule();
    const result = await auth.verifyAuth(credential);

    if (!result.verified) {
      logEvent('security.reauth_failed', { userId: user.id, ip: req.ip, method: 'passkey' });
      return res.status(401).json({ error: 'Re-authentication failed' });
    }

    logEvent('security.reauth_success', { userId: user.id, ip: req.ip, method: 'passkey' });

    // Issue one-time export token (don't use the new session from verifyAuth)
    const token = crypto.randomBytes(32).toString('hex');
    exportTokens.set(token, { userId: user.id, createdAt: Date.now() });
    res.json({ exportToken: token });
  } catch (e) {
    console.error('[Export] Re-auth verify failed:', e.message);
    logEvent('security.reauth_failed', { userId: 'unknown', ip: req.ip, reason: e.message });
    res.status(400).json({ error: 'Re-authentication failed' });
  }
});

// -- Auth: Session validation --
app.get('/auth/session', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Invalid session' });
    res.json({ user });
  } catch (e) {
    res.status(500).json({ error: 'Session validation failed' });
  }
});

// -- Auth: Logout --
app.post('/auth/logout', async (req, res) => {
  if (!requireWorkerSecret(req, res)) return;
  try {
    const user = await authenticatePortalRequest(req);
    const token = extractSessionToken(req);
    if (token) {
      const auth = await getAuthModule();
      await auth.destroySession(token);
    }
    clearSessionCookie(res);
    tryGetDb()?.audit.log({ action: 'auth.logout', userId: user?.id, ip: req.ip }).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Logout failed' });
  }
});

// -- Portal: Energy (token usage tracking) --

app.get('/portal/energy', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const { queryEnergy } = await import('./lib/energy.js');
    const opts = {
      agent: req.query.agent || undefined, model: req.query.model || undefined,
      process: req.query.process || undefined, days: parseInt(req.query.days) || 7,
      from: req.query.from || undefined, to: req.query.to || undefined,
    };
    const records = await queryEnergy(opts);
    res.json({ records, count: records.length });
  } catch (e) { res.status(500).json({ error: 'Failed to query energy records' }); }
});

app.get('/portal/energy/summary', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const { energySummary } = await import('./lib/energy.js');
    const opts = {
      agent: req.query.agent || undefined, model: req.query.model || undefined,
      days: parseInt(req.query.days) || 7, from: req.query.from || undefined, to: req.query.to || undefined,
    };
    res.json(await energySummary(opts));
  } catch (e) { res.status(500).json({ error: 'Failed to generate energy summary' }); }
});

app.get('/portal/energy/live', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const { energySummary } = await import('./lib/energy.js');
    let energyState = null;
    try { const m = await import('./lib/energy-state.js'); energyState = await m.getEnergyState(); } catch {}
    const todaySummary = await energySummary({ days: 1 });
    const agentList = await Promise.all(
      Object.entries(getAgentRegistry()).map(async ([agentId, info]) => {
        try {
          const c = new AbortController(); const t = setTimeout(() => c.abort(), 3000);
          const h = await (await fetch(`http://localhost:${info.port}/health`, { signal: c.signal })).json();
          clearTimeout(t);
          return { id: agentId, name: info.name, role: info.role, color: info.color, status: 'online',
            model: h.lastModelUsed || h.model, messagesThisHour: h.state?.messagesThisHour || 0,
            messagesToday: h.state?.messagesToday || 0, activeTasks: h.state?.activeTasks || 0 };
        } catch { return { id: agentId, name: info.name, role: info.role, color: info.color, status: 'offline' }; }
      })
    );
    res.json({ timestamp: new Date().toISOString(), today: todaySummary, energyState, agents: agentList });
  } catch (e) { res.status(500).json({ error: 'Failed to fetch live energy state' }); }
});

// -- Portal: Agents Dashboard --

// GET /portal/agents — Fetch status of all agents in parallel
app.get('/portal/agents', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const agents = await Promise.all(
      Object.entries(AGENT_REGISTRY).map(async ([agentId, info]) => {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 3000);
          const healthRes = await fetch(`http://localhost:${info.port}/health`, {
            signal: controller.signal,
          });
          clearTimeout(timeout);
          const health = await healthRes.json();
          return {
            id: agentId,
            name: info.name,
            role: info.role,
            color: info.color,
            port: info.port,
            status: 'online',
            model: health.lastModelUsed || health.model || 'unknown',
            activeTasks: health.state?.activeTasks || 0,
          };
        } catch {
          return {
            id: agentId,
            name: info.name,
            role: info.role,
            color: info.color,
            port: info.port,
            status: 'offline',
            model: null,
            activeTasks: 0,
          };
        }
      })
    );

    res.json({ agents });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load agents' });
  }
});

// GET /portal/agents/stream — Aggregated SSE from all agents
app.get('/portal/agents/stream', async (req, res) => {
  const user = await authenticatePortalRequest(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  let closed = false;
  const upstreamConnections = [];

  // Connect to each agent's /activity/stream and enrich events
  for (const [agentId, info] of Object.entries(AGENT_REGISTRY)) {
    try {
      const controller = new AbortController();
      const fetchRes = await fetch(`http://localhost:${info.port}/activity/stream`, {
        signal: controller.signal,
      });
      upstreamConnections.push({ controller, agentId });

      // Read the stream body as text chunks
      const reader = fetchRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      (async () => {
        try {
          while (!closed) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              if (closed) break;
              if (line.startsWith('data: ')) {
                try {
                  const entry = JSON.parse(line.slice(6));
                  entry.agentId = agentId;
                  entry.agentName = info.name;
                  entry.agentColor = info.color;
                  res.write(`data: ${JSON.stringify(entry)}\n\n`);
                } catch { /* skip unparseable */ }
              } else if (line.startsWith(':')) {
                // keepalive comment — skip
              }
            }
          }
        } catch {
          // upstream disconnected — send offline event
          if (!closed) {
            res.write(`data: ${JSON.stringify({ type: 'status', content: 'Agent disconnected', agentId, agentName: info.name, agentColor: info.color, timestamp: new Date().toISOString() })}\n\n`);
          }
        }
      })();
    } catch {
      // Agent unreachable at startup — skip
    }
  }

  // Periodic health poll — send heartbeat with agent statuses
  const healthPoll = setInterval(async () => {
    if (closed) return;
    const statuses = await Promise.all(
      Object.entries(AGENT_REGISTRY).map(async ([agentId, info]) => {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 2000);
          const healthRes = await fetch(`http://localhost:${info.port}/health`, { signal: controller.signal });
          clearTimeout(timeout);
          const health = await healthRes.json();
          return { agentId, name: info.name, color: info.color, status: 'online', activeTasks: health.state?.activeTasks || 0, model: health.lastModelUsed || health.model };
        } catch {
          return { agentId, name: info.name, color: info.color, status: 'offline', activeTasks: 0, model: null };
        }
      })
    );
    if (!closed) {
      res.write(`data: ${JSON.stringify({ type: 'heartbeat', agents: statuses, timestamp: new Date().toISOString() })}\n\n`);
    }
  }, 10000);

  // Keepalive
  const keepalive = setInterval(() => {
    if (!closed) res.write(': keepalive\n\n');
  }, 15000);

  req.on('close', () => {
    closed = true;
    clearInterval(healthPoll);
    clearInterval(keepalive);
    for (const conn of upstreamConnections) {
      try { conn.controller.abort(); } catch {}
    }
  });
});

// -- Portal: Documents --
app.get('/portal/documents', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const category = req.query.category || null;
    const folderId = req.query.folder_id || null;
    const pinnedOnly = req.query.pinned === '1';
    const docs = await db.documents.list(user.id, { category, folderId, pinnedOnly });
    res.json({ documents: docs });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load documents' });
  }
});

app.get('/portal/documents/*path', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const rawPath = req.params.path || req.params[0];
    const docPath = Array.isArray(rawPath) ? rawPath.join('/') : rawPath;
    const doc = await db.documents.get(user.id, docPath);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    res.json({ document: doc });
  } catch (e) {
    console.error(`[${LOG_PREFIX}] Document get error:`, e.message, 'params:', JSON.stringify(req.params));
    res.status(500).json({ error: 'Failed to load document' });
  }
});

app.post('/portal/documents', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });
    // Allowlist fields to prevent arbitrary field injection
    const { path, title, content, source_type, folder_id, pinned, metadata, created_by } = req.body;
    if (!path || typeof path !== 'string') return res.status(400).json({ error: 'path is required' });
    // Build doc with only defined values (undefined keys break dynamic SQL)
    const doc = { path, user_id: user.id };
    if (title !== undefined) doc.title = title;
    if (content !== undefined) doc.content = content;
    if (source_type !== undefined) doc.source_type = source_type;
    if (folder_id !== undefined) doc.folder_id = folder_id;
    if (pinned !== undefined) doc.is_pinned = pinned ? 1 : 0;
    if (metadata !== undefined) doc.metadata = typeof metadata === 'string' ? metadata : JSON.stringify(metadata);
    // Default to 'user' for portal-created docs, allow override for agent-created
    if (created_by !== undefined) doc.created_by = created_by;
    else doc.created_by = 'user';
    await db.documents.upsert(doc);
    res.json({ ok: true });
  } catch (e) {
    console.error(`[Portal] Document upsert error:`, e.message);
    res.status(500).json({ error: 'Failed to save document' });
  }
});

app.post('/portal/documents/move', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const { path, folder_id } = req.body;
    if (!path) return res.status(400).json({ error: 'path is required' });
    await db.documents.moveToFolder(user.id, path, folder_id || null);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to move document' });
  }
});

app.post('/portal/documents/pin', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const { path, pinned } = req.body;
    if (!path) return res.status(400).json({ error: 'path is required' });
    if (pinned) {
      await db.documents.pin(user.id, path);
    } else {
      await db.documents.unpin(user.id, path);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update pin status' });
  }
});

app.delete('/portal/documents/*path', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const docPath = req.params.path;
    if (!docPath) return res.status(400).json({ error: 'path is required' });
    await db.documents.delete(user.id, docPath);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete document' });
  }
});

// -- Portal: Folders --
app.get('/portal/folders', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const folders = await db.folders.list(user.id);
    res.json({ folders });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load folders' });
  }
});

app.post('/portal/folders', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const { name, parent_id } = req.body;
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' });
    const folder = await db.folders.create(user.id, name.trim(), parent_id || null);
    res.json({ folder });
  } catch (e) {
    res.status(500).json({ error: 'Failed to create folder' });
  }
});

app.put('/portal/folders/:id', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const { name } = req.body;
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' });
    await db.folders.rename(user.id, req.params.id, name.trim());
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to rename folder' });
  }
});

app.delete('/portal/folders/:id', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });
    await db.folders.delete(user.id, req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete folder' });
  }
});

// -- Portal: Messages (Timeline) --
app.get('/portal/messages', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const before = req.query.before;
    const messages = await db.messages.selectTimeline(user.id, {
      limit,
      before: before ? new Date(before).toISOString() : undefined,
    });

    // Enrich messages that have attachments
    const attachmentIds = messages
      .filter(m => m.attachment_id)
      .map(m => m.attachment_id);
    let attachmentMap = {};
    if (attachmentIds.length > 0) {
      const attachments = await db.attachments.getByIds(attachmentIds);
      for (const a of attachments) {
        const type = a.r2_key?.includes('/voice/') ? 'voice'
          : a.r2_key?.includes('/image/') ? 'image'
          : a.r2_key?.includes('/video/') ? 'video' : 'file';
        attachmentMap[a.id] = {
          id: a.id,
          type,
          url: `/portal/attachment/${a.id}`,
          filename: a.file_name || null,
          fileSize: a.file_size || null,
          transcript: a.transcript || null,
          description: a.description || null,
        };
      }
    }

    const enriched = messages.map(m => {
      if (m.attachment_id && attachmentMap[m.attachment_id]) {
        return { ...m, attachment: attachmentMap[m.attachment_id] };
      }
      return m;
    });

    res.json({ messages: enriched });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

// -- Portal: List attachments (media gallery) --
app.get('/portal/attachments', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const type = req.query.type || null;
    const search = req.query.search || null;
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    // Media gallery: only show actual media types (image, voice/audio, video)
    // Text/document/pdf files belong in Library, not Media
    const onlyTypes = (!type || type === 'all') ? ['image', 'voice', 'audio', 'video'] : undefined;

    const [attachments, total] = await Promise.all([
      db.attachments.listByUser(user.id, { type: type === 'all' ? null : type, search, limit, offset, onlyTypes }),
      db.attachments.countByUser(user.id, { type: type === 'all' ? null : type, search, onlyTypes }),
    ]);

    // Map to portal-friendly format (normalize types for UI)
    const normalizeType = (t, r2Key) => {
      if (t === 'image') return 'image';
      if (t === 'voice' || t === 'audio') return 'voice';
      if (t === 'video') return 'video';
      if (t) return 'file';
      // Fallback: infer from r2_key path
      if (r2Key?.includes('/voice/')) return 'voice';
      if (r2Key?.includes('/image/')) return 'image';
      if (r2Key?.includes('/video/')) return 'video';
      return 'file';
    };
    const items = attachments.map(a => {
      return {
        id: a.id,
        type: normalizeType(a.file_type, a.r2_key),
        url: `/portal/attachment/${a.id}`,
        streamUid: a.stream_uid || null,
        filename: a.file_name || null,
        fileSize: a.file_size || null,
        description: a.description || null,
        transcript: a.transcript || null,
        createdAt: a.created_at || null,
      };
    });

    res.json({ attachments: items, total });
  } catch (e) {
    console.error('[Portal] Error listing attachments:', e);
    res.status(500).json({ error: 'Failed to list attachments' });
  }
});

// -- Portal: Update attachment metadata --
app.put('/portal/attachments/:id', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const attachment = await db.attachments.getById(req.params.id);
    if (!attachment) return res.status(404).json({ error: 'Not found' });
    if (attachment.user_id !== user.id) return res.status(403).json({ error: 'Forbidden' });

    const { description } = req.body || {};
    if (typeof description === 'string') {
      await db.attachments.update(req.params.id, { description });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('[Portal] Error updating attachment:', e);
    res.status(500).json({ error: 'Failed to update attachment' });
  }
});

// -- Portal: Delete attachment (from DB + R2 + Stream) --
app.delete('/portal/attachments/:id', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const attachment = await db.attachments.getById(req.params.id);
    if (!attachment) return res.status(404).json({ error: 'Not found' });
    if (attachment.user_id !== user.id) return res.status(403).json({ error: 'Forbidden' });

    // Delete from R2 (if stored there)
    if (attachment.r2_key && MYA_WORKER_URL && MYA_WORKER_SECRET) {
      try {
        await fetch(`${MYA_WORKER_URL}/attachments/${encodeURIComponent(attachment.r2_key)}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${MYA_WORKER_SECRET}` },
          signal: AbortSignal.timeout(15000),
        });
      } catch (e) {
        console.error(`[Portal] R2 delete failed for ${req.params.id}:`, e.message);
        // Continue — orphaned R2 file is better than orphaned DB record
      }
    }

    // Delete from Cloudflare Stream (if stream video)
    if (attachment.stream_uid && MYA_WORKER_URL && MYA_WORKER_SECRET) {
      try {
        await fetch(`${MYA_WORKER_URL}/stream-delete/${attachment.stream_uid}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${MYA_WORKER_SECRET}` },
          signal: AbortSignal.timeout(15000),
        });
      } catch (e) {
        console.error(`[Portal] Stream delete failed for ${req.params.id}:`, e.message);
      }
    }

    // Delete from database
    await db.attachments.delete(req.params.id, user.id);

    console.log(`[Portal] Attachment deleted: ${req.params.id} (r2=${attachment.r2_key || 'none'}, stream=${attachment.stream_uid || 'none'})`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[Portal] Error deleting attachment:', e);
    res.status(500).json({ error: 'Failed to delete attachment' });
  }
});

// -- Portal: Attachment proxy (authenticated R2 file serving) --
app.get('/portal/attachment/:id', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) {
      console.log(`[Portal] Attachment ${req.params.id}: auth failed (token=${extractSessionToken(req) ? 'present' : 'MISSING'}, cookie=${req.headers.cookie ? 'yes' : 'no'})`);
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const attachment = await db.attachments.getById(req.params.id);
    if (!attachment) return res.status(404).json({ error: 'Not found' });
    if (attachment.user_id !== user.id) return res.status(403).json({ error: 'Forbidden' });
    // Stream videos: return embed URLs instead of proxying
    if (attachment.stream_uid && !attachment.r2_key) {
      try {
        const tokenRes = await fetch(`${MYA_WORKER_URL}/stream-token/${attachment.stream_uid}`, {
          headers: { 'Authorization': `Bearer ${MYA_WORKER_SECRET}` },
          signal: AbortSignal.timeout(15000),
        });
        if (!tokenRes.ok) return res.status(502).json({ error: 'Failed to get stream token' });
        const tokenData = await tokenRes.json();
        return res.json({ stream: true, embedUrl: tokenData.embedUrl, hlsUrl: tokenData.hlsUrl, thumbnailUrl: tokenData.thumbnailUrl });
      } catch {
        return res.status(502).json({ error: 'Stream token request failed' });
      }
    }

    if (!attachment.r2_key) return res.status(404).json({ error: 'No file' });

    // Proxy from Worker R2 using Bearer token auth
    const r2Key = attachment.r2_key;
    const workerUrl = `${MYA_WORKER_URL}/attachments/${encodeURIComponent(r2Key)}`;
    const r2Res = await fetch(workerUrl, {
      headers: { 'Authorization': `Bearer ${MYA_WORKER_SECRET}` },
      signal: AbortSignal.timeout(30000),
    });
    if (!r2Res.ok) {
      const errorBody = await r2Res.text().catch(() => '(no body)');
      console.error(`[Portal] R2 fetch failed for ${r2Key}: ${r2Res.status} ${r2Res.statusText} — body: ${errorBody}`);
      return res.status(502).json({ error: 'Failed to fetch from storage' });
    }

    // Forward content type and cache headers
    const contentType = r2Res.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    if (r2Res.headers.get('content-length')) {
      res.setHeader('Content-Length', r2Res.headers.get('content-length'));
    }

    // Stream the body
    const reader = r2Res.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); return; }
        res.write(Buffer.from(value));
      }
    };
    await pump();
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: 'Failed to fetch attachment' });
  }
});

// -- Portal: Stream video token (for Cloudflare Stream playback) --
app.get('/portal/stream-token/:id', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const attachment = await db.attachments.getById(req.params.id);
    if (!attachment) return res.status(404).json({ error: 'Not found' });
    if (attachment.user_id !== user.id) return res.status(403).json({ error: 'Forbidden' });
    if (!attachment.stream_uid) return res.status(404).json({ error: 'Not a stream video' });

    const tokenRes = await fetch(`${MYA_WORKER_URL}/stream-token/${attachment.stream_uid}`, {
      headers: { 'Authorization': `Bearer ${MYA_WORKER_SECRET}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!tokenRes.ok) {
      const body = await tokenRes.text().catch(() => '');
      console.error(`[Portal] Stream token failed for ${attachment.stream_uid}: ${tokenRes.status} ${body}`);
      return res.status(502).json({ error: 'Failed to get stream token' });
    }
    const tokenData = await tokenRes.json();
    res.json({
      embedUrl: tokenData.embedUrl,
      hlsUrl: tokenData.hlsUrl,
      thumbnailUrl: tokenData.thumbnailUrl,
    });
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: 'Stream token failed' });
  }
});

// -- Portal: Chat History --
app.get('/portal/chat/history', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const agentId = req.query.agentId || undefined;
    const messages = await db.messages.selectRecent(user.id, { limit, agentId });

    // Enrich messages with attachment data
    const attachmentIds = messages.filter(m => m.attachment_id).map(m => m.attachment_id);
    let attachmentMap = {};
    if (attachmentIds.length > 0) {
      try {
        const attachments = await db.attachments.getByIds(attachmentIds);
        for (const a of attachments) {
          const type = a.file_type || (a.r2_key?.includes('/voice/') ? 'voice'
            : a.r2_key?.includes('/image/') ? 'image'
            : a.r2_key?.includes('/video/') ? 'video' : 'file');
          attachmentMap[a.id] = {
            id: a.id, type,
            url: `/portal/attachment/${a.id}`,
            filename: a.file_name || null,
            fileSize: a.file_size || null,
            transcript: a.transcript || null,
            description: a.description || null,
          };
        }
      } catch { /* attachment enrichment is optional */ }
    }
    const enriched = messages.map(m => {
      const mapped = {
        id: String(m.id),
        role: m.role,
        content: m.content,
        timestamp: new Date(m.created_at).getTime(),
        source: m.source,
      };
      if (m.attachment_id && attachmentMap[m.attachment_id]) {
        mapped.attachment = attachmentMap[m.attachment_id];
      }
      return mapped;
    });

    // selectRecent returns DESC (newest first); reverse for chronological display
    res.json({ messages: enriched.reverse() });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load chat history' });
  }
});

// -- Portal: Mindscape Data --
// Full graph data: clustering points with 3D coords, theme cards, territory profiles,
// realms, and semantic themes — all from D1, no vector search needed.
app.get('/portal/mindscape', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    // Fetch all data in parallel from D1 — settle individually so one failure doesn't kill all
    const results = await Promise.allSettled([
      db.mindscape.getPoints(user.id),
      db.mindscape.getThemeCards(user.id),
      db.mindscape.getTerritoryProfiles(user.id),
      db.mindscape.getRealms(user.id),
      db.mindscape.getSemanticThemes(user.id),
    ]);
    const extract = (r, label) => {
      if (r.status === 'fulfilled') return r.value;
      console.error(`Mindscape ${label} failed:`, r.reason?.message || r.reason);
      return [];
    };
    const points = extract(results[0], 'points');
    const themeCards = extract(results[1], 'themeCards');
    const territoryProfiles = extract(results[2], 'territoryProfiles');
    const realmProfiles = extract(results[3], 'realms');
    const semanticThemeProfiles = extract(results[4], 'semanticThemes');

    // Transform clustering points to lightweight nodes
    const nodes = points.map(p => ({
      id: p.source_id ? `${p.source_type === 'message' ? 'msg' : p.source_type}-${p.source_id}` : `cp-${p.id}`,
      type: 'message',
      data: {
        type: p.source_type || 'message',
        clusterId: p.realm_id,
        cluster3d: p.territory_id,
        themeId: p.theme_id,
        atomId: p.atom_id,
        position3d: { x: p.landscape_x, y: p.landscape_y, z: p.landscape_z },
        timestamp: p.created_at,
      },
    }));

    // Compute activity timelines and territory centroids from points
    const themeActivity = {};
    const territoryActivity = {};
    const realmActivity = {};
    const semanticThemeActivity = {};
    const territoryCentroids = {};

    for (const p of points) {
      const month = p.created_at?.slice(0, 7);
      if (!month) continue;

      if (p.territory_id != null && p.theme_id != null) {
        const key = `${p.territory_id}-${p.theme_id}`;
        if (!themeActivity[key]) themeActivity[key] = {};
        themeActivity[key][month] = (themeActivity[key][month] || 0) + 1;
      }

      if (p.realm_id != null && p.realm_id !== -1) {
        if (!realmActivity[p.realm_id]) realmActivity[p.realm_id] = {};
        realmActivity[p.realm_id][month] = (realmActivity[p.realm_id][month] || 0) + 1;
      }

      if (p.territory_id != null && p.territory_id !== -1) {
        if (!territoryActivity[p.territory_id]) territoryActivity[p.territory_id] = {};
        territoryActivity[p.territory_id][month] = (territoryActivity[p.territory_id][month] || 0) + 1;

        if (!territoryCentroids[p.territory_id]) {
          territoryCentroids[p.territory_id] = { x: 0, y: 0, z: 0, count: 0 };
        }
        territoryCentroids[p.territory_id].x += p.landscape_x;
        territoryCentroids[p.territory_id].y += p.landscape_y;
        territoryCentroids[p.territory_id].z += p.landscape_z;
        territoryCentroids[p.territory_id].count++;
      }
    }

    // Helper: parse JSON string or return array as-is
    const parseArr = (raw) => {
      if (Array.isArray(raw)) return raw;
      if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return []; } }
      return [];
    };
    // Helper: transform entities array (handles JSON strings + mixed formats)
    const mapEntities = (raw) => {
      const arr = parseArr(raw);
      return arr.map(e => {
        if (typeof e === 'string') return { name: e };
        return { name: e.text || e.name || String(e), type: e.type, count: e.count };
      });
    };

    // Helper: activity map to sorted array
    const activityArray = (map) => Object.entries(map || {})
      .map(([month, count]) => ({ month, count }))
      .sort((a, b) => a.month.localeCompare(b.month));

    // Build theme lookup: { territoryId: { themeId: ThemeCard } }
    const themes = {};
    for (const tc of themeCards) {
      if (!themes[tc.territory_id]) themes[tc.territory_id] = {};
      const actKey = `${tc.territory_id}-${tc.theme_id}`;
      themes[tc.territory_id][tc.theme_id] = {
        title: tc.title,
        essence: tc.essence,
        count: tc.message_count || 0,
        exploredCount: tc.explored_count || 0,
        exploredPercent: tc.explored_percent || 0,
        topEntities: mapEntities(tc.top_entities),
        storyBirth: tc.story_birth,
        storyArc: tc.story_arc,
        storyPeakMoments: parseArr(tc.story_peak_moments),
        storyCurrentChapter: tc.story_current_chapter,
        uncertaintyOpenQuestions: parseArr(tc.uncertainty_open_questions),
        uncertaintyEdges: tc.uncertainty_edges,
        activity: activityArray(themeActivity[actKey]),
      };
    }

    // Build territory profiles lookup: { territoryId: TerritoryProfile }
    const territories = {};
    for (const tp of territoryProfiles) {
      const centroidData = territoryCentroids[tp.territory_id];
      const centroid = centroidData && centroidData.count > 0
        ? { x: centroidData.x / centroidData.count, y: centroidData.y / centroidData.count, z: centroidData.z / centroidData.count }
        : null;

      territories[tp.territory_id] = {
        name: tp.name,
        essence: tp.essence,
        archetypeType: tp.archetype_type,
        archetypeCharacter: tp.archetype_character,
        realmId: tp.realm_id,
        semanticThemeId: tp.semantic_theme_id,
        count: tp.message_count || 0,
        exploredCount: tp.explored_count || 0,
        exploredPercent: tp.explored_percent || 0,
        topEntities: mapEntities(tp.top_entities),
        signaturePatterns: parseArr(tp.signature_patterns),
        storyBirth: tp.story_birth,
        storyArc: tp.story_arc,
        storyPeakMoments: parseArr(tp.story_peak_moments),
        storyCurrentChapter: tp.story_current_chapter,
        uncertaintyOpenQuestions: parseArr(tp.uncertainty_open_questions),
        uncertaintyEdges: tp.uncertainty_edges,
        chronicle: tp.chronicle || null,
        agentExpertise: tp.agent_expertise,
        agentCuriousAbout: tp.agent_curious_about,
        agentCanHelpWith: parseArr(tp.agent_can_help_with),
        agentWouldConsult: parseArr(tp.agent_would_consult),
        activity: activityArray(territoryActivity[tp.territory_id]),
        centroid,
        visibility: tp.visibility || 'private',
      };
    }

    // Cluster statistics
    const realmCounts = {};
    const territoryCounts = {};
    const realmTerritoryIds = {}; // track unique territory_ids per realm
    let noiseRealm = 0;
    let noiseTerritory = 0;
    for (const p of points) {
      if (p.realm_id == null || p.realm_id === -1) noiseRealm++;
      else {
        realmCounts[p.realm_id] = (realmCounts[p.realm_id] || 0) + 1;
        if (p.territory_id != null && p.territory_id !== -1) {
          if (!realmTerritoryIds[p.realm_id]) realmTerritoryIds[p.realm_id] = new Set();
          realmTerritoryIds[p.realm_id].add(p.territory_id);
        }
      }
      if (p.territory_id == null || p.territory_id === -1) noiseTerritory++;
      else territoryCounts[p.territory_id] = (territoryCounts[p.territory_id] || 0) + 1;
    }

    // Build realm profiles lookup from profiles + actual point data
    const realmProfileMap = {};
    for (const rp of realmProfiles) {
      realmProfileMap[rp.realm_id] = rp;
    }
    const realms = {};
    // Include ALL realm_ids found in points (source of truth), not just those with profiles
    for (const [realmId, count] of Object.entries(realmCounts)) {
      const rp = realmProfileMap[realmId] || {};
      realms[realmId] = {
        name: rp.name || null,
        essence: rp.essence || null,
        archetypeType: rp.archetype_type || null,
        archetypeCharacter: rp.archetype_character || null,
        territoryCount: (realmTerritoryIds[realmId]?.size) || rp.territory_count || 0,
        pointCount: count,
        topEntities: mapEntities(rp.top_entities),
        signaturePatterns: parseArr(rp.signature_patterns),
        storyBirth: rp.story_birth || null,
        storyArc: rp.story_arc || null,
        storyPeakMoments: parseArr(rp.story_peak_moments),
        storyCurrentChapter: rp.story_current_chapter || null,
        uncertaintyOpenQuestions: parseArr(rp.uncertainty_open_questions),
        uncertaintyEdges: rp.uncertainty_edges || null,
        agentExpertise: rp.agent_expertise || null,
        agentCuriousAbout: rp.agent_curious_about || null,
        agentCanHelpWith: parseArr(rp.agent_can_help_with),
        activity: activityArray(realmActivity[realmId]),
      };
    }

    // Aggregate semantic theme activity from territory activity
    for (const tp of territoryProfiles) {
      if (tp.semantic_theme_id != null && tp.realm_id != null) {
        const stKey = `${tp.realm_id}-${tp.semantic_theme_id}`;
        const tAct = territoryActivity[tp.territory_id] || {};
        for (const [month, count] of Object.entries(tAct)) {
          if (!semanticThemeActivity[stKey]) semanticThemeActivity[stKey] = {};
          semanticThemeActivity[stKey][month] = (semanticThemeActivity[stKey][month] || 0) + count;
        }
      }
    }

    // Build semantic themes lookup
    const semanticThemes = {};
    for (const st of semanticThemeProfiles) {
      const key = `${st.realm_id}-${st.semantic_theme_id}`;
      semanticThemes[key] = {
        realmId: st.realm_id,
        semanticThemeId: st.semantic_theme_id,
        name: st.name,
        essence: st.essence,
        territoryCount: st.territory_count || 0,
        messageCount: st.message_count || 0,
        territoryIds: parseArr(st.territory_ids),
        includedTerritoryCount: st.included_territory_count || st.territory_count || 0,
        coveragePercent: st.coverage_percent ?? 100.0,
        topEntities: mapEntities(st.top_entities),
        signaturePatterns: parseArr(st.signature_patterns),
        storyBirth: st.story_birth,
        storyArc: st.story_arc,
        storyCurrentChapter: st.story_current_chapter,
        uncertaintyOpenQuestions: parseArr(st.uncertainty_open_questions),
        activity: activityArray(semanticThemeActivity[key]),
      };
    }

    const total = points.length;
    res.json({
      nodes,
      themes,
      territories,
      realms,
      semanticThemes,
      meta: {
        total,
        noise10d: noiseRealm,
        noise10dPercent: total > 0 ? (noiseRealm / total * 100).toFixed(1) : 0,
        noise3d: noiseTerritory,
        noise3dPercent: total > 0 ? (noiseTerritory / total * 100).toFixed(1) : 0,
        clusterCounts: realmCounts,
        cluster3dCounts: territoryCounts,
      },
    });
  } catch (e) {
    console.error(`[${LOG_PREFIX}] Mindscape error:`, e.message);
    res.status(500).json({ error: 'Failed to load mindscape data' });
  }
});

// -- Portal: Wealth Module --

// List portfolios
app.get('/portal/wealth/portfolios', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const portfolios = await db.wealth.listPortfolios(user.id);
    res.json({ portfolios });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load portfolios' });
  }
});

// Create portfolio
app.post('/portal/wealth/portfolios', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const { name, baseCurrency, type } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const portfolio = await db.wealth.createPortfolio(user.id, name, baseCurrency || 'EUR', type || 'personal');
    res.json({ portfolio });
  } catch (e) {
    res.status(500).json({ error: 'Failed to create portfolio' });
  }
});

// Delete portfolio
app.delete('/portal/wealth/portfolios/:id', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });
    await db.wealth.deletePortfolio(req.params.id, user.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.message?.includes('Only owner') ? 403 : 500).json({ error: e.message || 'Failed to delete portfolio' });
  }
});

// Get positions for a portfolio
app.get('/portal/wealth/portfolios/:id/positions', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const portfolio = await db.wealth.getPortfolio(req.params.id, user.id);
    if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });
    const positions = await db.wealth.getPositions(req.params.id);

    // Enrich with live prices + FX conversion to portfolio base currency
    try {
      const prices = await fetchPrices(positions);

      // Collect currencies that need conversion to portfolio base
      const baseCurrency = portfolio.base_currency || 'EUR';
      const priceCurrencies = new Set();
      for (const pos of positions) {
        const p = prices.get(pos.asset_id);
        if (p && p.currency.toUpperCase() !== baseCurrency.toUpperCase()) {
          priceCurrencies.add(p.currency);
        }
      }

      // Fetch FX rates (cached, 5-min TTL)
      const fxRates = priceCurrencies.size > 0
        ? await fetchFxRates(baseCurrency, [...priceCurrencies])
        : new Map();

      for (const pos of positions) {
        const p = prices.get(pos.asset_id);
        if (p) {
          pos.current_price = p.price;
          pos.price_currency = p.currency;
          const fxRate = fxRates.get(p.currency) || fxRates.get(p.currency.toUpperCase()) || 1;
          pos.current_value = p.price * pos.quantity * fxRate;
          pos.unrealized_pnl = pos.current_value - pos.total_invested;
          pos.price_fetched_at = new Date(p.fetchedAt).toISOString();
        }
      }
    } catch (priceErr) {
      console.error('[wealth] Price fetch failed:', priceErr.message);
      // Positions still returned without prices
    }

    res.json({ portfolio, positions });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load positions' });
  }
});

// List transactions for a portfolio
app.get('/portal/wealth/portfolios/:id/transactions', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const portfolio = await db.wealth.getPortfolio(req.params.id, user.id);
    if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });
    const { symbol, type, from, to, limit } = req.query;
    const transactions = await db.wealth.listTransactions(req.params.id, {
      symbol, type, from, to, limit: limit ? parseInt(limit, 10) : 100,
    });
    res.json({ transactions });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load transactions' });
  }
});

// Add transaction
app.post('/portal/wealth/portfolios/:id/transactions', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const portfolio = await db.wealth.getPortfolio(req.params.id, user.id);
    if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });
    if (portfolio.role === 'viewer') return res.status(403).json({ error: 'Viewers cannot add transactions' });

    const { symbol, assetName, assetType, exchange, lookupId, priceSource, type, quantity, pricePerUnit, currency, exchangeRate, fees, date, notes } = req.body;
    if (!symbol || !assetName || !assetType || !type || !currency || !date) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Upsert asset
    const asset = await db.wealth.upsertAsset({
      symbol, name: assetName, type: assetType, exchange: exchange || null,
      currency, lookup_id: lookupId || null, price_source: priceSource || 'manual',
    });

    // Add transaction
    const txId = await db.wealth.addTransaction({
      portfolio_id: req.params.id, asset_id: asset.id, type,
      quantity: quantity || 0, price_per_unit: pricePerUnit || 0,
      currency, exchange_rate: exchangeRate || 1, fees: fees || 0,
      transacted_at: date, notes: notes || null,
    });

    // Recalculate position
    const position = await db.wealth.recalculatePosition(req.params.id, asset.id);

    res.json({ transactionId: txId, asset, position });
  } catch (e) {
    res.status(500).json({ error: 'Failed to add transaction' });
  }
});

// Delete transaction
app.delete('/portal/wealth/transactions/:id', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const tx = await db.wealth.getTransaction(req.params.id);
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    const portfolio = await db.wealth.getPortfolio(tx.portfolio_id, user.id);
    if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });
    if (portfolio.role === 'viewer') return res.status(403).json({ error: 'Viewers cannot delete transactions' });

    const deleted = await db.wealth.deleteTransaction(req.params.id);
    await db.wealth.recalculatePosition(deleted.portfolio_id, deleted.asset_id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete transaction' });
  }
});

// Get portfolio snapshots (performance data)
app.get('/portal/wealth/portfolios/:id/performance', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const portfolio = await db.wealth.getPortfolio(req.params.id, user.id);
    if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });
    const { from, to } = req.query;
    const snapshots = await db.wealth.getSnapshots(req.params.id, { from, to });
    res.json({ portfolio, snapshots });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load performance data' });
  }
});

// Get watchlist (with live prices)
app.get('/portal/wealth/watchlist', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const items = await db.wealth.getWatchlist(user.id);

    // Enrich with live prices
    try {
      const prices = await fetchPrices(items);
      for (const item of items) {
        const p = prices.get(item.asset_id);
        if (p) {
          item.current_price = p.price;
          item.price_currency = p.currency;
          item.price_fetched_at = new Date(p.fetchedAt).toISOString();
        }
      }
    } catch (priceErr) {
      console.error('[wealth] Watchlist price fetch failed:', priceErr.message);
    }

    res.json({ watchlist: items });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load watchlist' });
  }
});

// Search assets
app.get('/portal/wealth/assets', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const { q } = req.query;
    if (!q) return res.json({ assets: [] });
    const assets = await db.wealth.findAssets(q);
    res.json({ assets });
  } catch (e) {
    res.status(500).json({ error: 'Failed to search assets' });
  }
});

// -- Portal: Cluster Growth Events --

app.get('/portal/mindscape/growth', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const { level, since, limit } = req.query;
    const events = await db.clusterEvents.getRecent(user.id, {
      level: level || undefined,
      since: since || undefined,
      limit: parseInt(limit) || 50,
    });
    res.json({ events });
  } catch (err) {
    console.error('Growth events error:', err);
    res.status(500).json({ error: 'Failed to fetch growth events' });
  }
});

app.get('/portal/mindscape/growth/summary', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const summary = await db.clusterEvents.getSummary(user.id);
    res.json({ summary });
  } catch (err) {
    console.error('Growth summary error:', err);
    res.status(500).json({ error: 'Failed to fetch growth summary' });
  }
});

// -- Social Layer (contacts on mindscape) --

app.get('/portal/mindscape/social', async (req, res) => {
  const user = await authenticatePortalRequest(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const tiers = (req.query.tiers || 'inner,engaged').split(',');
    console.log(`[${LOG_PREFIX}] Social: loading tiers=${tiers.join(',')} for user=${user.id}`);

    // Fetch contacts with their territory links (decrypted — name/company/position are encrypted)
    const contacts = await db.rawQueryDecrypted(
      `SELECT p.id, p.name, p.company, p.position, p.status as tier,
              p.interaction_count, p.linkedin_url, p.connected_at
       FROM people p
       WHERE p.user_id = ? AND p.status IN (${tiers.map(() => '?').join(',')})
       ORDER BY p.interaction_count DESC`,
      [user.id, ...tiers],
    );

    // Compute territory centroids from clustering_points (territory_profiles.centroid_3d may be empty)
    const centroids = {};
    const centroidRows = await db.rawQuery(
      `SELECT territory_id,
              AVG(landscape_x) as cx, AVG(landscape_y) as cy, AVG(landscape_z) as cz
       FROM clustering_points
       WHERE user_id = ? AND territory_id IS NOT NULL AND territory_id >= 0
             AND landscape_x IS NOT NULL
       GROUP BY territory_id`,
      [user.id],
    );
    for (const r of centroidRows) {
      centroids[r.territory_id] = [r.cx, r.cy, r.cz];
    }

    // Fetch all contact-territory links for these contacts
    const contactIds = contacts.map(c => c.id);
    let links = [];
    if (contactIds.length > 0) {
      for (let i = 0; i < contactIds.length; i += 50) {
        const batch = contactIds.slice(i, i + 50);
        const placeholders = batch.map(() => '?').join(',');
        const batchLinks = await db.rawQuery(
          `SELECT ct.contact_id, ct.territory_id, ct.strength,
                  tp.name as territory_name
           FROM contact_territories ct
           LEFT JOIN territory_profiles tp ON tp.territory_id = ct.territory_id AND tp.user_id = ?
           WHERE ct.contact_id IN (${placeholders})
           ORDER BY ct.strength DESC`,
          [user.id, ...batch],
        );
        links.push(...batchLinks);
      }
    }

    // Group links by contact
    const linksByContact = {};
    for (const link of links) {
      if (!linksByContact[link.contact_id]) linksByContact[link.contact_id] = [];
      linksByContact[link.contact_id].push({
        territory_id: link.territory_id,
        territory_name: link.territory_name,
        strength: link.strength,
        centroid_3d: centroids[link.territory_id] || null,
      });
    }

    // Build response
    const result = contacts.map(c => ({
      id: c.id,
      name: c.name,
      company: c.company,
      position: c.position,
      tier: c.tier,
      interaction_count: c.interaction_count,
      linkedin_url: c.linkedin_url,
      connected_at: c.connected_at,
      territories: linksByContact[c.id] || [],
    }));

    // Tier summary
    const tierCounts = await db.rawQuery(
      `SELECT status as tier, COUNT(*) as count FROM people WHERE user_id = ? GROUP BY status ORDER BY count DESC`,
      [user.id],
    );

    const withPos = result.filter(c => c.territories.some(t => t.centroid_3d));
    console.log(`[${LOG_PREFIX}] Social: ${contacts.length} contacts, ${links.length} links, ${Object.keys(centroids).length} centroids, ${withPos.length} positioned`);
    res.json({ contacts: result, tiers: tierCounts });
  } catch (err) {
    console.error(`[${LOG_PREFIX}] Social contacts error:`, err.message);
    res.status(500).json({ error: 'Failed to load contacts' });
  }
});

app.get('/portal/mindscape/social/:contactId', async (req, res) => {
  const user = await authenticatePortalRequest(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const { contactId } = req.params;

    // Get contact details
    const contacts = await db.rawQuery(
      `SELECT id, name, company, position, status as tier, interaction_count,
              linkedin_url, email, connected_at, last_interaction_at
       FROM people WHERE id = ? AND user_id = ?`,
      [contactId, user.id],
    );
    if (!contacts.length) return res.status(404).json({ error: 'Contact not found' });
    const contact = contacts[0];

    // Get territory links
    const territories = await db.rawQuery(
      `SELECT ct.territory_id, ct.strength, ct.mention_count,
              tp.name as territory_name, tp.essence, tp.centroid_3d
       FROM contact_territories ct
       LEFT JOIN territory_profiles tp ON tp.territory_id = ct.territory_id AND tp.user_id = ?
       WHERE ct.contact_id = ?
       ORDER BY ct.strength DESC`,
      [user.id, contactId],
    );

    // Get conversation history (last 20 messages)
    const messages = await db.rawQuery(
      `SELECT id, role, content, source, conversation_id, metadata, created_at
       FROM messages
       WHERE contact_id = ? OR (conversation_id IN (
         SELECT DISTINCT conversation_id FROM messages WHERE contact_id = ? AND conversation_id IS NOT NULL
       ) AND source = 'linkedin')
       ORDER BY created_at DESC LIMIT 20`,
      [contactId, contactId],
    );

    res.json({
      contact,
      territories: territories.map(t => ({
        ...t,
        centroid_3d: t.centroid_3d ? JSON.parse(t.centroid_3d) : null,
      })),
      messages,
    });
  } catch (err) {
    console.error(`[${LOG_PREFIX}] Social contact detail error:`, err.message);
    res.status(500).json({ error: 'Failed to load contact' });
  }
});

// -- Territory Description Storage (called by Claude during think sessions) --

// Store territory descriptions generated by Claude
app.post('/territory/describe', async (req, res) => {
  if (!requireWorkerSecret(req, res)) return;
  try {
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const { territories, version, raw_llm_output } = req.body;
    if (!territories || !Array.isArray(territories)) {
      return res.status(400).json({ error: 'territories array required' });
    }

    // Get user_id (single-user system)
    const user = await db.users.getFirst();
    if (!user) return res.status(500).json({ error: 'No user found' });

    let stored = 0;
    const fieldWarnings = [];
    for (const t of territories) {
      if (!t.territory_id && t.territory_id !== 0) continue;

      // Check for missing critical fields
      const missing = [];
      for (const f of ['name', 'essence', 'story_arc', 'signature_patterns', 'agent_expertise']) {
        if (!t[f]) missing.push(f);
      }
      if (missing.length > 0) {
        fieldWarnings.push({ territory_id: t.territory_id, missing });
      }

      // Handle field name aliases (LLM may use different names)
      const desc = {
        name: t.name,
        essence: t.essence,
        archetype_type: t.archetype_type || t.archetype,
        archetype_character: t.archetype_character,
        story_birth: t.story_birth || t.birth,
        story_arc: t.story_arc || t.arc,
        story_current_chapter: t.story_current_chapter || t.current_chapter,
        story_peak_moments: t.story_peak_moments || t.peak_moments,
        signature_patterns: t.signature_patterns || t.patterns,
        uncertainty_open_questions: t.uncertainty_open_questions || t.open_questions,
        uncertainty_edges: t.uncertainty_edges || t.edges || t.connections,
        agent_expertise: t.agent_expertise || t.expertise,
        agent_curious_about: t.agent_curious_about || t.curious_about,
        agent_can_help_with: t.agent_can_help_with || t.can_help_with,
        agent_would_consult: t.agent_would_consult || t.would_consult,
        top_entities: t.top_entities || t.entities,
        point_count: t.point_count,
      };

      // Save raw per-territory JSON + full raw output if provided
      const rawForTerritory = raw_llm_output || JSON.stringify(t);
      await db.territoryDocs.upsertDescription(user.id, t.territory_id, desc, version || '', rawForTerritory);
      stored++;
    }

    if (fieldWarnings.length > 0) {
      console.warn(`[territory/describe] Missing fields:`, fieldWarnings);
    }
    console.log(`[territory/describe] Stored ${stored} territory descriptions (version: ${version})`);
    res.json({ stored, version, fieldWarnings });
  } catch (err) {
    console.error('Territory describe error:', err);
    res.status(500).json({ error: 'Failed to store territory descriptions' });
  }
});

// Store realm descriptions generated by Claude
app.post('/realm/describe', async (req, res) => {
  if (!requireWorkerSecret(req, res)) return;
  try {
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const { realms, raw_llm_output } = req.body;
    if (!realms || !Array.isArray(realms)) {
      return res.status(400).json({ error: 'realms array required' });
    }

    const user = await db.users.getFirst();
    if (!user) return res.status(500).json({ error: 'No user found' });

    let stored = 0;
    for (const r of realms) {
      if (r.realm_id === undefined) continue;
      // Store realm descriptions in the realms table
      await db.rawQuery(
        `INSERT INTO realms (realm_id, user_id, name, essence, archetype_type, archetype_character,
          story_birth, story_arc, story_current_chapter, story_peak_moments,
          signature_patterns, uncertainty_open_questions, uncertainty_edges,
          agent_expertise, agent_curious_about, agent_can_help_with,
          territory_count, message_count, top_entities, generation_model, raw_response)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claude-opus', ?)
        ON CONFLICT(realm_id, user_id) DO UPDATE SET
          name = excluded.name, essence = excluded.essence,
          archetype_type = excluded.archetype_type, archetype_character = excluded.archetype_character,
          story_birth = excluded.story_birth, story_arc = excluded.story_arc,
          story_current_chapter = excluded.story_current_chapter, story_peak_moments = excluded.story_peak_moments,
          signature_patterns = excluded.signature_patterns,
          uncertainty_open_questions = excluded.uncertainty_open_questions,
          uncertainty_edges = excluded.uncertainty_edges,
          agent_expertise = excluded.agent_expertise, agent_curious_about = excluded.agent_curious_about,
          agent_can_help_with = excluded.agent_can_help_with,
          territory_count = excluded.territory_count, message_count = excluded.message_count,
          top_entities = excluded.top_entities, generation_model = excluded.generation_model,
          raw_response = excluded.raw_response`,
        [r.realm_id, user.id, r.name, r.essence,
         r.archetype_type, r.archetype_character,
         r.story_birth, r.story_arc, r.story_current_chapter,
         JSON.stringify(r.story_peak_moments || []),
         JSON.stringify(r.signature_patterns || []),
         JSON.stringify(r.uncertainty_open_questions || []),
         r.uncertainty_edges,
         r.agent_expertise, r.agent_curious_about,
         JSON.stringify(r.agent_can_help_with || []),
         r.territory_count || 0, r.message_count || 0,
         JSON.stringify(r.top_entities || []),
         raw_llm_output || JSON.stringify(r)],
      );
      stored++;
    }

    console.log(`[realm/describe] Stored ${stored} realm descriptions`);
    res.json({ stored });
  } catch (err) {
    console.error('Realm describe error:', err);
    res.status(500).json({ error: 'Failed to store realm descriptions' });
  }
});

// All territory profiles with dynamics
app.get('/portal/mindscape/territories', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const territories = await db.territoryDocs.getAllWithDynamics(user.id);
    res.json({ territories });
  } catch (err) {
    console.error('Territory profiles error:', err);
    res.status(500).json({ error: 'Failed to fetch territory profiles' });
  }
});

// Single territory detail
app.get('/portal/mindscape/territory/:id', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const territory = await db.territoryDocs.getByTerritoryId(user.id, parseInt(req.params.id));
    if (!territory) return res.status(404).json({ error: 'Territory not found' });
    res.json({ territory });
  } catch (err) {
    console.error('Territory detail error:', err);
    res.status(500).json({ error: 'Failed to fetch territory detail' });
  }
});

// Realm list with territory counts for drilldown navigation
app.get('/portal/mindscape/realms', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    // Source of truth: derive realms from clustering_points
    const realmStats = await db.rawQuery(`
      SELECT realm_id, COUNT(*) as point_count,
             COUNT(DISTINCT territory_id) as territory_count
      FROM clustering_points
      WHERE user_id = ? AND realm_id IS NOT NULL AND realm_id >= 0
      GROUP BY realm_id
    `, [user.id]);

    // Get realm profiles for names/descriptions (may be stale or missing)
    const realmProfiles = await db.mindscape.getRealms(user.id);
    const profileMap = Object.fromEntries(realmProfiles.map(r => [r.realm_id, r]));

    // Build realm list from actual point data, enriched with profiles when available
    const enriched = realmStats.map(rs => {
      const profile = profileMap[rs.realm_id] || {};
      return {
        realm_id: rs.realm_id,
        name: profile.name || null,
        essence: profile.essence || null,
        archetype_type: profile.archetype_type || null,
        archetype_character: profile.archetype_character || null,
        territory_count: rs.territory_count || 0,
        point_count: rs.point_count || 0,
        total_messages: rs.point_count || 0,
        top_entities: profile.top_entities || [],
        signature_patterns: profile.signature_patterns || [],
        story_birth: profile.story_birth || null,
        story_arc: profile.story_arc || null,
        story_peak_moments: profile.story_peak_moments || [],
        story_current_chapter: profile.story_current_chapter || null,
        uncertainty_open_questions: profile.uncertainty_open_questions || [],
        uncertainty_edges: profile.uncertainty_edges || null,
        agent_expertise: profile.agent_expertise || null,
        agent_curious_about: profile.agent_curious_about || null,
        agent_can_help_with: profile.agent_can_help_with || [],
        activity_timeline: profile.activity_timeline || [],
      };
    });

    res.json({ realms: enriched });
  } catch (err) {
    console.error('Realm list error:', err);
    res.status(500).json({ error: 'Failed to fetch realms' });
  }
});

// Daily territory activations (which territories lit up today)
app.get('/portal/mindscape/activations', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const date = req.query.date || new Date().toISOString().split('T')[0];
    const activations = await db.territoryDocs.getDailyActivations(user.id, date);
    res.json(activations);
  } catch (err) {
    console.error('Territory activations error:', err);
    res.status(500).json({ error: 'Failed to fetch territory activations' });
  }
});

// Territory co-firing connections
app.get('/portal/mindscape/cofire', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const territoryId = parseInt(req.query.territory);
    if (isNaN(territoryId)) return res.status(400).json({ error: 'territory param required' });
    const scale = req.query.scale || 'daily';
    const limit = parseInt(req.query.limit) || 10;

    const connections = await db.topology.getCoFiring({
      p_user_id: user.id,
      p_territory_id: territoryId,
      p_scale: scale,
      p_min_strength: 0.05,
      p_limit: limit,
    });
    res.json({ connections });
  } catch (err) {
    console.error('Cofire error:', err);
    res.status(500).json({ error: 'Failed to fetch co-firing data' });
  }
});

// Noise/unclustered point stats
app.get('/portal/mindscape/noise-stats', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const stats = await db.mindscape.getNoiseStats(user.id);
    res.json(stats);
  } catch (err) {
    console.error('Noise stats error:', err);
    res.status(500).json({ error: 'Failed to fetch noise stats' });
  }
});

// -- Portal: Activity Tracking --

// Today's sessions + summary
app.get('/portal/activity/today', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const date = req.query.date || new Date().toISOString().split('T')[0];
    const [sessions, topApps, categories, topDomains] = await Promise.all([
      db.activity.getSessions(user.id, { date, limit: 500 }),
      db.activity.getTopApps(user.id, { date, limit: 10 }),
      db.activity.getCategoryBreakdown(user.id, { date }),
      db.activity.getTopDomains(user.id, { date, limit: 15 }),
    ]);

    // Compute totals
    let activeSeconds = 0, idleSeconds = 0, weightedProductivity = 0;
    for (const s of sessions) {
      if (s.idle) {
        idleSeconds += s.duration_s || 0;
      } else {
        activeSeconds += s.duration_s || 0;
        weightedProductivity += (s.productivity || 50) * (s.duration_s || 0);
      }
    }
    const productivityScore = activeSeconds > 0 ? Math.round(weightedProductivity / activeSeconds) : 50;

    res.json({
      date,
      sessions,
      topApps,
      topDomains,
      categories,
      totals: { activeSeconds, idleSeconds, productivityScore },
    });
  } catch (e) {
    console.error('[activity] today failed:', e.message);
    res.status(500).json({ error: 'Failed to load activity' });
  }
});

// Summary for a date range
app.get('/portal/activity/summary', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const { from, to } = req.query;
    const summary = await db.activity.getDailySummary(user.id, {
      from: from || undefined,
      to: to || undefined,
    });

    res.json({ summary });
  } catch (e) {
    console.error('[activity] summary failed:', e.message);
    res.status(500).json({ error: 'Failed to load activity summary' });
  }
});

// Top apps for a given date
// Desktop activity detail for a date range (used by week view)
app.get('/portal/activity/range', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to required' });

    const [topApps, topDomains, categories] = await Promise.all([
      db.activity.getTopApps(user.id, { from, to, limit: 10 }),
      db.activity.getTopDomains(user.id, { from, to, limit: 15 }),
      db.activity.getCategoryBreakdown(user.id, { from, to }),
    ]);

    let activeSeconds = 0, idleSeconds = 0;
    for (const cat of categories) {
      if (cat.category === 'idle') idleSeconds += cat.total_s || 0;
      else activeSeconds += cat.total_s || 0;
    }

    res.json({ topApps, topDomains, categories, totals: { activeSeconds, idleSeconds } });
  } catch (e) {
    console.error('[activity] range failed:', e.message);
    res.status(500).json({ error: 'Failed to load activity range' });
  }
});

app.get('/portal/activity/apps', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const date = req.query.date || new Date().toISOString().split('T')[0];
    const limit = parseInt(req.query.limit) || 10;
    const apps = await db.activity.getTopApps(user.id, { date, limit });

    res.json({ apps });
  } catch (e) {
    console.error('[activity] apps failed:', e.message);
    res.status(500).json({ error: 'Failed to load top apps' });
  }
});

// Message activity over time (weekly counts by source category)
app.get('/portal/activity/messages', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const result = await db.rawQuery(`
      SELECT substr(created_at, 1, 10) as day, COUNT(*) as count,
        SUM(CASE WHEN source LIKE 'import_%' OR source = 'claude_export' THEN 1 ELSE 0 END) as imported,
        SUM(CASE WHEN source LIKE 'discord%' THEN 1 ELSE 0 END) as discord,
        SUM(CASE WHEN source = 'telegram' THEN 1 ELSE 0 END) as telegram,
        SUM(CASE WHEN source IN ('portal', 'web', 'portal_prompt') THEN 1 ELSE 0 END) as portal,
        SUM(CASE WHEN source NOT LIKE 'import_%' AND source != 'claude_export'
              AND source NOT LIKE 'discord%' AND source != 'telegram'
              AND source NOT IN ('portal', 'web', 'portal_prompt') THEN 1 ELSE 0 END) as other
      FROM messages WHERE user_id = ?
      GROUP BY day ORDER BY day
    `, [user.id]);

    res.json({ days: result });
  } catch (e) {
    console.error('[activity] messages failed:', e.message);
    res.status(500).json({ error: 'Failed to load message activity' });
  }
});

// Sync from Mac app (batch upload sessions)
app.post('/portal/activity/sync', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const { sessions } = req.body;
    if (!Array.isArray(sessions) || sessions.length === 0) {
      return res.status(400).json({ error: 'No sessions provided' });
    }
    if (sessions.length > 100) {
      return res.status(400).json({ error: 'Max 100 sessions per sync' });
    }

    // Stamp agent_id from auth
    const stamped = sessions.map(s => ({
      ...s,
      agent_id: user.id,
      date: s.date || (s.started_at ? s.started_at.split('T')[0] : new Date().toISOString().split('T')[0]),
    }));

    await db.activity.syncSessions(stamped);

    res.json({ ok: true, synced: stamped.length });
  } catch (e) {
    console.error('[activity] sync failed:', e.message);
    res.status(500).json({ error: 'Failed to sync activity' });
  }
});

// -- Portal: Profile (cognitive fingerprint, social sharing) --

app.get('/portal/profile', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });
    let profile = await db.profiles.get(user.id).catch(() => null);

    // Sync handle from provisioning if missing
    if (profile && !profile.handle) {
      try {
        const provRows = await db.rawQueryOwner(
          'SELECT handle FROM provisioning_jobs WHERE user_id = ? AND status = ? LIMIT 1',
          [user.id, 'ready']
        );
        const provHandle = provRows?.[0]?.handle;
        if (provHandle) {
          await db.profiles.upsert(user.id, { handle: provHandle });
          profile.handle = provHandle;
        }
      } catch {}
    }

    if (!profile) {
      // Try to auto-compute, but don't fail if tables are missing
      try {
        await db.profiles.computeFingerprint(user.id);
        profile = await db.profiles.get(user.id);
      } catch {
        // Return minimal profile — fetch handle from users table
        let handle = null;
        try {
          const userRow = await db.rawQuery(`SELECT handle, display_name FROM users WHERE id = ?`, [user.id]);
          if (userRow?.[0]) { handle = userRow[0].handle; }
        } catch {}
        profile = {
          user_id: user.id,
          handle: handle,
          display_name: user.displayName || null,
          signature: null,
          territory_count: 0, realm_count: 0, message_count: 0,
          depth_score: 0, breadth_score: 0, coherence_score: 0, exploration_score: 0,
          member_since: null, public_realms_json: null,
        };
      }
    }
    res.json({ profile });
  } catch (err) {
    console.error('[Profile] GET error:', err.message);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

app.put('/portal/profile', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const { handle, display_name, signature } = req.body;
    const updates = {};
    if (handle !== undefined) {
      await db.profiles.setHandle(user.id, handle);
    }
    if (display_name !== undefined) updates.display_name = display_name;
    if (signature !== undefined) updates.signature = signature;
    if (Object.keys(updates).length > 0) {
      await db.profiles.upsert(user.id, updates);
    }
    const profile = await db.profiles.get(user.id);
    res.json({ profile });
  } catch (err) {
    console.error('[Profile] PUT error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

app.get('/portal/profile/handle/check', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const handle = (req.query.handle || '').toLowerCase().trim();
    if (!handle || !/^[a-z0-9][a-z0-9_]{2,29}$/.test(handle)) {
      return res.json({ available: false, reason: 'Invalid format' });
    }
    const reserved = ['admin', 'support', 'api', 'system', 'mycelium', 'vault', 'login', 'signup', 'profile', 'settings', 'help', 'about', 'discover', 'connections'];
    if (reserved.includes(handle)) {
      return res.json({ available: false, reason: 'Reserved' });
    }
    // Check owner D1 (all tenants)
    const db = tryGetDb();
    if (db) {
      try {
        const rows = await db.rawQueryOwner(
          'SELECT user_id FROM provisioning_jobs WHERE handle = ? AND user_id != ? AND status = ? LIMIT 1',
          [handle, user.id, 'ready']
        );
        if (rows?.length > 0) return res.json({ available: false, reason: 'Taken' });
      } catch {}
    }
    res.json({ available: true });
  } catch {
    res.json({ available: true }); // Fail open — validation happens on save
  }
});

app.post('/portal/profile/stats/recompute', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const stats = await db.profiles.computeFingerprint(user.id);
    res.json({ stats, message: 'Recomputed' });
  } catch (err) {
    console.error('[Profile] Recompute error:', err.message);
    res.status(500).json({ error: 'Failed to recompute' });
  }
});

app.put('/portal/mindscape/territory/:id/visibility', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const { visibility } = req.body;
    await db.profiles.setTerritoryVisibility(user.id, req.params.id, visibility);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Profile] Visibility error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

app.get('/portal/profile/public/:handle', async (req, res) => {
  try {
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const profile = await db.profiles.getByHandle(req.params.handle);
    if (!profile) return res.status(404).json({ error: 'Not found' });
    // Return only public-safe fields
    const publicRealms = profile.public_realms_json ? JSON.parse(profile.public_realms_json) : [];
    const publicTerritories = await db.profiles.getPublicTerritories(profile.user_id);
    res.json({
      handle: profile.handle,
      display_name: profile.display_name,
      signature: profile.signature,
      depth_score: profile.depth_score,
      breadth_score: profile.breadth_score,
      coherence_score: profile.coherence_score,
      exploration_score: profile.exploration_score,
      territory_count: profile.territory_count,
      realm_count: profile.realm_count,
      message_count: profile.message_count,
      member_since: profile.member_since,
      realms: publicRealms,
      territories: publicTerritories.filter(t => t.visibility === 'public').map(t => ({
        name: t.name, essence: t.essence, realm_id: t.realm_id, message_count: t.message_count,
      })),
    });
  } catch (err) {
    console.error('[Profile] Public profile error:', err.message);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

// -- Portal: Connections (social sharing Phase 2) --

app.post('/portal/connections/request', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const { toHandle } = req.body;
    if (!toHandle) return res.status(400).json({ error: 'toHandle required' });
    const cleanHandle = toHandle.replace(/^@/, '');
    const id = await db.connections.request(user.id, cleanHandle);

    // Send email notification to the target user via Worker self-service.
    // The Worker resolves the handle → email centrally with rate limiting.
    const fromProfile = await db.profiles.get(user.id);
    sendConnectionEmail(cleanHandle, fromProfile?.handle || 'someone', fromProfile?.signature).catch(() => {});

    res.json({ id, ok: true });
  } catch (err) {
    console.error('[Connections] Request error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

app.get('/portal/connections/count', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const pending = await db.connections.pending(user.id);
    res.json({ pending: pending.length });
  } catch {
    res.json({ pending: 0 });
  }
});

app.get('/portal/connections/pending', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db?.connections) return res.json({ requests: [] });
    const requests = await db.connections.pending(user.id);
    res.json({ requests });
  } catch (err) {
    console.error('[Connections] Pending error:', err.message);
    res.status(500).json({ error: 'Failed to load requests' });
  }
});

app.get('/portal/connections', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db?.connections) return res.json({ connections: [] });
    const connections = await db.connections.list(user.id);
    res.json({ connections });
  } catch (err) {
    console.error('[Connections] List error:', err.message);
    res.status(500).json({ error: 'Failed to load connections' });
  }
});

app.post('/portal/connections/:id/accept', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    await db.connections.accept(user.id, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Connections] Accept error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

app.post('/portal/connections/:id/reject', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    await db.connections.reject(user.id, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Connections] Reject error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

app.post('/portal/connections/:id/block', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    await db.connections.block(user.id, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Connections] Block error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

app.delete('/portal/connections/:id', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    await db.connections.disconnect(user.id, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Connections] Disconnect error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

app.get('/portal/connections/:id/overlap', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const overlap = await db.connections.computeOverlap(user.id, req.params.id);
    res.json({ overlap });
  } catch (err) {
    console.error('[Connections] Overlap error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// -- Portal: Sharing Contexts (Phase 3 — multi-faceted identity sharing) --

app.get('/portal/contexts', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db?.contexts) return res.json({ contexts: [] });
    const contexts = await db.contexts.list(user.id);
    res.json({ contexts });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load contexts' });
  }
});

app.post('/portal/contexts', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db?.contexts) return res.status(503).json({ error: 'Database not available' });
    const { name, is_private } = req.body;
    const id = await db.contexts.create(user.id, { name, is_private });
    res.json({ id, ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/portal/contexts/:id', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db?.contexts) return res.status(503).json({ error: 'Database not available' });
    await db.contexts.rename(user.id, req.params.id, req.body.name);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/portal/contexts/:id', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db?.contexts) return res.status(503).json({ error: 'Database not available' });
    await db.contexts.remove(user.id, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/portal/contexts/:id/territories/:tid', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db?.contexts) return res.status(503).json({ error: 'Database not available' });
    await db.contexts.addTerritory(req.params.id, parseInt(req.params.tid));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/portal/contexts/:id/territories/:tid', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db?.contexts) return res.status(503).json({ error: 'Database not available' });
    await db.contexts.removeTerritory(req.params.id, parseInt(req.params.tid));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/portal/contexts/:id/grant/:connId', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db?.contexts) return res.status(503).json({ error: 'Database not available' });
    await db.contexts.grant(req.params.id, req.params.connId);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/portal/contexts/:id/grant/:connId', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db?.contexts) return res.status(503).json({ error: 'Database not available' });
    await db.contexts.revoke(req.params.id, req.params.connId);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/portal/contexts/:id/territories', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db?.contexts) return res.json({ territories: [] });
    const territories = await db.contexts.getTerritories(req.params.id);
    res.json({ territories });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load territories' });
  }
});

app.get('/portal/contexts/:id/connections', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db?.contexts) return res.json({ grants: [] });
    const grants = await db.contexts.getGrants(req.params.id);
    res.json({ grants });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load grants' });
  }
});

// -- Portal: Health (Apple Health daily summaries) --

app.post('/portal/health/sync', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db?.health) return res.status(503).json({ error: 'Database not available' });

    const { days } = req.body;
    if (!Array.isArray(days) || days.length === 0) {
      return res.status(400).json({ error: 'No days provided' });
    }
    if (days.length > 60) {
      return res.status(400).json({ error: 'Max 60 days per sync' });
    }

    const synced = await db.health.syncDays(user.id, days);
    console.log(`[${LOG_PREFIX}] Health sync: ${synced} days for user=${user.id}`);
    res.json({ ok: true, synced });
  } catch (e) {
    console.error('[health] sync failed:', e.message);
    res.status(500).json({ error: 'Failed to sync health data' });
  }
});

app.get('/portal/health/today', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db?.health) return res.status(503).json({ error: 'Database not available' });

    const today = new Date().toISOString().split('T')[0];
    const data = await db.health.getDay(user.id, today);
    res.json({ date: today, metrics: data });
  } catch (e) {
    console.error('[health] today failed:', e.message);
    res.status(500).json({ error: 'Failed to load health data' });
  }
});

app.get('/portal/health/range', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db?.health) return res.status(503).json({ error: 'Database not available' });

    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to required' });
    const days = await db.health.getRange(user.id, from, to);
    res.json({ days });
  } catch (e) {
    console.error('[health] range failed:', e.message);
    res.status(500).json({ error: 'Failed to load health data' });
  }
});

app.get('/portal/health/summary', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db?.health) return res.status(503).json({ error: 'Database not available' });

    const days = parseInt(req.query.days) || 7;
    const summary = await db.health.getSummary(user.id, Math.min(days, 90));
    res.json(summary);
  } catch (e) {
    console.error('[health] summary failed:', e.message);
    res.status(500).json({ error: 'Failed to compute health summary' });
  }
});

// -- Portal: Intel (Polymarket Intelligence proxy) --
// Proxies requests to the polymarket-intelligence FastAPI service.
// Requires POLYMARKET_API_URL, POLYMARKET_API_USER, POLYMARKET_API_PASSWORD.

function getPolymarketHeaders() {
  const user = process.env.POLYMARKET_API_USER;
  const pass = process.env.POLYMARKET_API_PASSWORD;
  if (!user || !pass) return null;
  return {
    'Authorization': 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
    'Accept': 'application/json',
  };
}

async function polymarketFetch(endpoint, params = {}) {
  const baseUrl = process.env.POLYMARKET_API_URL;
  if (!baseUrl) throw new Error('POLYMARKET_API_URL not configured');
  const headers = getPolymarketHeaders();
  if (!headers) throw new Error('Polymarket credentials not configured');

  const url = new URL(endpoint, baseUrl);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const resp = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(15000) });
  if (!resp.ok) throw new Error(`Polymarket API ${resp.status}`);
  return resp.json();
}

app.get('/portal/intel/recommendations', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const { hours, min_conf, limit } = req.query;
    const data = await polymarketFetch('/api/recommendations', { hours, min_conf, limit });
    res.json({ recommendations: data });
  } catch (e) {
    console.error('[intel] recommendations failed:', e.message);
    res.status(500).json({ error: 'Failed to fetch recommendations' });
  }
});

app.get('/portal/intel/signals', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const { hours, signal_type, limit } = req.query;
    const data = await polymarketFetch('/api/signals', { hours, signal_type, limit });
    res.json({ signals: data });
  } catch (e) {
    console.error('[intel] signals failed:', e.message);
    res.status(500).json({ error: 'Failed to fetch signals' });
  }
});

app.get('/portal/intel/entities', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const { limit } = req.query;
    const data = await polymarketFetch('/api/entities', { limit });
    res.json({ entities: data });
  } catch (e) {
    console.error('[intel] entities failed:', e.message);
    res.status(500).json({ error: 'Failed to fetch entities' });
  }
});

app.get('/portal/intel/insiders', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const { tier, limit } = req.query;
    const data = await polymarketFetch('/api/insiders', { tier, limit });
    res.json({ insiders: data });
  } catch (e) {
    console.error('[intel] insiders failed:', e.message);
    res.status(500).json({ error: 'Failed to fetch insiders' });
  }
});

app.get('/portal/intel/markets/search', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const { q, active_only, limit } = req.query;
    if (!q) return res.json({ markets: [] });
    const data = await polymarketFetch('/api/search', { q, active_only, limit });
    res.json({ markets: data });
  } catch (e) {
    console.error('[intel] search failed:', e.message);
    res.status(500).json({ error: 'Failed to search markets' });
  }
});

app.get('/portal/intel/market/:conditionId', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const data = await polymarketFetch(`/api/market/${req.params.conditionId}`);
    res.json({ market: data });
  } catch (e) {
    console.error('[intel] market detail failed:', e.message);
    res.status(500).json({ error: 'Failed to fetch market detail' });
  }
});

// Serve the living situation report from the war-room repo
// Also stores new versions to D1 + enrichment pipeline
let lastReportHash = '';
app.get('/portal/intel/report', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const warRoomPath = process.env.WARROOM_PATH;
    if (!warRoomPath) return res.json({ report: null, message: 'War room not configured' });

    const reportPath = path.join(warRoomPath, 'SITUATION_REPORT.md');
    try {
      const content = await import('fs').then(fs => fs.promises.readFile(reportPath, 'utf8'));
      // Get last commit info for this file
      let lastUpdated = null;
      try {
        const { execSync } = await import('child_process');
        lastUpdated = execSync(`git log -1 --format='%aI' -- SITUATION_REPORT.md`, { encoding: 'utf8', cwd: warRoomPath }).trim();
      } catch { /* git not available or no commits */ }

      // Store new versions in D1 as documents (for enrichment/search)
      const contentHash = Buffer.from(content).toString('base64').slice(0, 32);
      if (contentHash !== lastReportHash) {
        lastReportHash = contentHash;
        const db = tryGetDb();
        if (db) {
          try {
            const agentId = 'intel-agent';
            const userId = user.userId || process.env.USER_ID;
            // Store as a document in the messages table for enrichment
            const rows = [{
              user_id: userId,
              role: 'assistant',
              content: `# Situation Report\n\n${content}`,
              source: 'intel_report',
              agent_id: agentId,
              created_at: lastUpdated || new Date().toISOString(),
            }];
            const inserted = await db.messages.insert(rows);
            enrichMessages(inserted, userId, agentId);
            console.log(`[intel] Stored situation report in D1 (${content.length} chars)`);
          } catch (dbErr) {
            console.error('[intel] Failed to store report in D1:', dbErr.message);
          }
        }
      }

      res.json({ report: content, lastUpdated });
    } catch (e) {
      if (e.code === 'ENOENT') return res.json({ report: null, message: 'No situation report yet — Apollo will create one on the next cycle' });
      throw e;
    }
  } catch (e) {
    console.error('[intel] report failed:', e.message);
    res.status(500).json({ error: 'Failed to load situation report' });
  }
});

// War-room strategic map state (proxy to war-room dashboard)
app.get('/portal/intel/warroom-state', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const warRoomPort = process.env.WARROOM_DASHBOARD_PORT || '8050';
    const resp = await fetch(`http://127.0.0.1:${warRoomPort}/api/state`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error(`War room API ${resp.status}`);
    const data = await resp.json();
    res.json(data);
  } catch (e) {
    console.error('[intel] warroom-state failed:', e.message);
    res.status(500).json({ error: 'War room state unavailable' });
  }
});

// -- Portal: War Room data layers (bases, infrastructure) --
app.get('/portal/intel/bases', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const warRoomPort = process.env.WARROOM_DASHBOARD_PORT || '8050';
    const resp = await fetch(`http://127.0.0.1:${warRoomPort}/api/bases`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error(`War room bases API ${resp.status}`);
    const data = await resp.json();
    res.json(data);
  } catch (e) {
    console.error('[intel] bases failed:', e.message);
    res.status(500).json({ error: 'Bases data unavailable' });
  }
});

app.get('/portal/intel/infrastructure', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const warRoomPort = process.env.WARROOM_DASHBOARD_PORT || '8050';
    const url = new URL(`http://127.0.0.1:${warRoomPort}/api/infrastructure`);
    if (req.query.infra_type) url.searchParams.set('infra_type', req.query.infra_type);
    const resp = await fetch(url.toString(), {
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error(`War room infrastructure API ${resp.status}`);
    const data = await resp.json();
    res.json(data);
  } catch (e) {
    console.error('[intel] infrastructure failed:', e.message);
    res.status(500).json({ error: 'Infrastructure data unavailable' });
  }
});

// -- Portal: New intel data proxies (CII, events feed, convergence, trending) --
app.get('/portal/intel/cii', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const warRoomPort = process.env.WARROOM_DASHBOARD_PORT || '8050';
    const resp = await fetch(`http://127.0.0.1:${warRoomPort}/api/cii`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error(`CII API ${resp.status}`);
    res.json(await resp.json());
  } catch (e) {
    console.error('[intel] cii failed:', e.message);
    res.status(500).json({ error: 'CII data unavailable' });
  }
});

app.get('/portal/intel/events-feed', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const warRoomPort = process.env.WARROOM_DASHBOARD_PORT || '8050';
    const hours = req.query.hours || '24';
    const limit = req.query.limit || '100';
    const source = req.query.source || '';
    const url = new URL(`http://127.0.0.1:${warRoomPort}/api/events`);
    url.searchParams.set('hours', hours);
    url.searchParams.set('limit', limit);
    if (source) url.searchParams.set('source', source);
    const resp = await fetch(url.toString(), {
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error(`Events API ${resp.status}`);
    res.json(await resp.json());
  } catch (e) {
    console.error('[intel] events-feed failed:', e.message);
    res.status(500).json({ error: 'Events feed unavailable' });
  }
});

app.get('/portal/intel/convergence', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const warRoomPort = process.env.WARROOM_DASHBOARD_PORT || '8050';
    const resp = await fetch(`http://127.0.0.1:${warRoomPort}/api/convergence`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error(`Convergence API ${resp.status}`);
    res.json(await resp.json());
  } catch (e) {
    console.error('[intel] convergence failed:', e.message);
    res.status(500).json({ error: 'Convergence data unavailable' });
  }
});

// Proxy helper for war room dashboard
const wrProxy = (path) => async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const port = process.env.WARROOM_DASHBOARD_PORT || '8050';
    const resp = await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error(`War room ${path} returned ${resp.status}`);
    res.json(await resp.json());
  } catch (e) {
    console.error(`[intel] ${path} failed:`, e.message);
    res.status(500).json({ error: `${path} unavailable` });
  }
};
app.get('/portal/intel/trending', wrProxy('/api/trending'));
app.get('/portal/intel/oref', wrProxy('/api/oref'));
app.get('/portal/intel/ais', wrProxy('/api/ais'));
app.get('/portal/intel/gpsjam', wrProxy('/api/gpsjam'));
app.get('/portal/intel/finnhub', wrProxy('/api/finnhub'));
app.get('/portal/intel/markets-geo', wrProxy('/api/markets/geo'));

// -- Portal: OpenSky live aircraft proxy --
app.get('/portal/intel/opensky', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    // Fetch from OpenSky Network (free, no auth, rate-limited)
    const resp = await fetch('https://opensky-network.org/api/states/all', {
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) throw new Error(`OpenSky API ${resp.status}`);
    const data = await resp.json();
    // data.states is array of arrays: [icao24, callsign, origin_country, time_position, last_contact, longitude, latitude, baro_altitude, on_ground, velocity, true_track, vertical_rate, sensors, geo_altitude, squawk, spi, position_source]
    // Filter to military callsigns and aircraft in conflict zones
    const militaryPrefixes = ['RCH', 'FORTE', 'HOMER', 'JAKE', 'DUKE', 'IRON', 'NCHO', 'LAGR', 'VIPER', 'HAWK', 'REAP', 'EVIL', 'TOPG', 'VADER', 'BANZAI', 'HAVOC', 'KNIFE'];
    const interestRegions = [
      { name: 'Middle East', minLat: 12, maxLat: 42, minLng: 25, maxLng: 65 },
      { name: 'Ukraine', minLat: 44, maxLat: 53, minLng: 22, maxLng: 42 },
      { name: 'Taiwan Strait', minLat: 20, maxLat: 28, minLng: 115, maxLng: 125 },
      { name: 'South China Sea', minLat: 5, maxLat: 22, minLng: 105, maxLng: 122 },
      { name: 'Baltic', minLat: 53, maxLat: 60, minLng: 14, maxLng: 30 },
      { name: 'Korean Peninsula', minLat: 33, maxLat: 43, minLng: 124, maxLng: 132 },
    ];
    const filtered = (data.states || []).filter(s => {
      if (!s[6] || !s[5]) return false; // no position
      if (s[8]) return false; // on ground
      const callsign = (s[1] || '').trim().toUpperCase();
      const lat = s[6], lng = s[5];
      // Military callsign match
      if (militaryPrefixes.some(p => callsign.startsWith(p))) return true;
      // Aircraft in interest regions at high altitude (likely military/ISR)
      const alt = s[7] || 0;
      if (alt > 10000) { // above 10km
        for (const r of interestRegions) {
          if (lat >= r.minLat && lat <= r.maxLat && lng >= r.minLng && lng <= r.maxLng) return true;
        }
      }
      return false;
    }).map(s => ({
      icao24: s[0],
      callsign: (s[1] || '').trim(),
      origin: s[2],
      lat: s[6],
      lng: s[5],
      altitude: s[7],
      velocity: s[9],
      heading: s[10],
      on_ground: s[8],
    }));
    res.json({ aircraft: filtered, time: data.time });
  } catch (e) {
    console.error('[intel] opensky failed:', e.message);
    res.json({ aircraft: [], time: null, error: e.message });
  }
});

// -- Intel Snapshot Push (to Worker KV for public intel page) --
// Owner-only operation. The Worker side checks that the agent token belongs
// to env.OWNER_USER_ID before accepting the snapshot. No ADMIN_SECRET needed.
async function pushIntelSnapshot() {
  const workerUrl = process.env.MYA_WORKER_URL;
  const agentToken = process.env.AGENT_TOKEN;
  if (!workerUrl || !agentToken) return;

  const port = process.env.WARROOM_DASHBOARD_PORT || '8050';
  const baseUrl = `http://127.0.0.1:${port}`;

  const wrEndpoints = {
    'warroom-state': '/api/state',
    'bases': '/api/bases',
    'infrastructure': '/api/infrastructure',
    'cii': '/api/cii',
    'events-feed': '/api/events?hours=48&limit=100',
    'trending': '/api/trending',
    'convergence': '/api/convergence',
    'oref': '/api/oref',
    'ais': '/api/ais',
    'gpsjam': '/api/gpsjam',
    'markets-geo': '/api/markets/geo',
  };

  const snapshot = {};

  // War room dashboard endpoints
  const wrFetches = Object.entries(wrEndpoints).map(async ([key, path]) => {
    try {
      const resp = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(10000) });
      if (resp.ok) snapshot[key] = await resp.json();
    } catch (e) { /* skip */ }
  });

  // Polymarket endpoints (Worker can't reach the HTTP API directly)
  const polyFetches = [];
  const polyBase = process.env.POLYMARKET_API_URL;
  const polyUser = process.env.POLYMARKET_API_USER;
  const polyPass = process.env.POLYMARKET_API_PASSWORD;
  if (polyBase && polyUser && polyPass) {
    const polyAuth = { 'Authorization': 'Basic ' + Buffer.from(`${polyUser}:${polyPass}`).toString('base64'), 'Accept': 'application/json' };
    const polyEndpoints = [
      ['recommendations', '/api/recommendations?hours=48&min_conf=5&limit=30'],
      ['signals', '/api/signals?hours=24&limit=50'],
      ['entities', '/api/entities?limit=30'],
      ['insiders', '/api/insiders?limit=30'],
    ];
    for (const [key, path] of polyEndpoints) {
      polyFetches.push((async () => {
        try {
          const resp = await fetch(`${polyBase}${path}`, { headers: polyAuth, signal: AbortSignal.timeout(15000) });
          if (resp.ok) snapshot[key] = await resp.json();
        } catch (e) { /* skip */ }
      })());
    }
  }

  // Read raw situation report from filesystem (unencrypted)
  const reportFetch = (async () => {
    if (!process.env.WARROOM_PATH) return;
    try {
      const reportPath = path.join(process.env.WARROOM_PATH, 'SITUATION_REPORT.md');
      const content = await fs.readFile(reportPath, 'utf8');
      let lastUpdated = null;
      try {
        lastUpdated = execSync(
          `cd "${process.env.WARROOM_PATH}" && git log -1 --format='%aI' -- SITUATION_REPORT.md`,
          { encoding: 'utf8' }
        ).trim();
      } catch {}
      snapshot['report'] = { report: content, lastUpdated };
    } catch (e) {
      console.error('[Intel Snapshot] Failed to read SITUATION_REPORT.md:', e.message);
    }
  })();

  const fetches = [...wrFetches, ...polyFetches, reportFetch];

  await Promise.allSettled(fetches);

  if (Object.keys(snapshot).length === 0) return;

  try {
    const resp = await fetch(`${workerUrl}/api/intel/snapshot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${agentToken}`,
      },
      body: JSON.stringify(snapshot),
      signal: AbortSignal.timeout(15000),
    });
    if (resp.ok) {
      const data = await resp.json();
      console.log(`[Intel Snapshot] Pushed ${data.accepted || 0} keys to Worker KV`);
    } else {
      console.error(`[Intel Snapshot] Worker returned ${resp.status}`);
    }
  } catch (e) {
    console.error('[Intel Snapshot] Push failed:', e.message);
  }
}

// Push snapshot every 15 minutes (only if this agent serves the portal)
if (getAgentConfig(AGENT_ID)?.servesPortal || !process.env.AGENT_ID) {
  // Initial push after 30s (let war room dashboard start)
  setTimeout(pushIntelSnapshot, 30_000);
  // Then every 15 minutes
  setInterval(pushIntelSnapshot, 15 * 60 * 1000);
}

// -- Portal: Stats (data overview + integrations) --
app.get('/portal/stats', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const userId = user.id;

    // Run all queries in parallel — wrap rawQuery to return {results:[...]} format
    const d1q = async (sql, params) => {
      const rows = await db.rawQuery(sql, params);
      return { results: rows };
    };
    const [msgStats, msgByAgent, msg30d, docCount, attStats, contactStats, mindscapeStats] = await Promise.all([
      // Messages by source + date range
      d1q(`SELECT COUNT(*) as total,
        SUM(CASE WHEN source = 'telegram' THEN 1 ELSE 0 END) as telegram,
        SUM(CASE WHEN source LIKE 'discord%' THEN 1 ELSE 0 END) as discord,
        SUM(CASE WHEN source IN ('portal', 'web', 'portal_prompt') THEN 1 ELSE 0 END) as portal,
        SUM(CASE WHEN source = 'whatsapp' THEN 1 ELSE 0 END) as whatsapp,
        SUM(CASE WHEN source LIKE 'import%' OR source = 'linkedin' THEN 1 ELSE 0 END) as imported,
        SUM(CASE WHEN source NOT IN ('telegram', 'whatsapp', 'portal', 'web', 'portal_prompt') AND source NOT LIKE 'discord%' AND source NOT LIKE 'import%' AND source != 'linkedin' THEN 1 ELSE 0 END) as other,
        MIN(created_at) as first_message, MAX(created_at) as last_message
        FROM messages WHERE user_id = ?`, [userId]),
      // Messages by agent
      d1q(`SELECT agent_id, COUNT(*) as count FROM messages WHERE user_id = ? GROUP BY agent_id`, [userId]),
      // Last 30 days
      d1q(`SELECT COUNT(*) as count FROM messages WHERE user_id = ? AND created_at > datetime('now', '-30 days')`, [userId]),
      // Documents
      d1q(`SELECT COUNT(*) as total FROM documents WHERE user_id = ?`, [userId]),
      // Attachments (columns: file_type, file_size)
      d1q(`SELECT COUNT(*) as total,
        SUM(CASE WHEN file_type LIKE 'image%' THEN 1 ELSE 0 END) as images,
        SUM(CASE WHEN file_type LIKE 'audio%' THEN 1 ELSE 0 END) as voice,
        SUM(CASE WHEN file_type LIKE 'video%' THEN 1 ELSE 0 END) as video,
        COALESCE(SUM(file_size), 0) as total_bytes
        FROM attachments WHERE user_id = ?`, [userId]),
      // Contacts
      d1q(`SELECT COUNT(*) as total,
        SUM(CASE WHEN status = 'inner' THEN 1 ELSE 0 END) as inner_count,
        SUM(CASE WHEN status = 'engaged' THEN 1 ELSE 0 END) as engaged_count,
        SUM(CASE WHEN status = 'acknowledged' THEN 1 ELSE 0 END) as acknowledged_count,
        SUM(CASE WHEN status = 'connected' THEN 1 ELSE 0 END) as connected_count
        FROM people WHERE user_id = ?`, [userId]),
      // Mindscape
      d1q(`SELECT
        (SELECT COUNT(DISTINCT territory_id) FROM clustering_points WHERE user_id = ? AND territory_id IS NOT NULL AND territory_id != -1) as territories,
        (SELECT COUNT(DISTINCT realm_id) FROM clustering_points WHERE user_id = ? AND realm_id IS NOT NULL) as realms,
        (SELECT COUNT(*) FROM clustering_points WHERE user_id = ?) as points`, [userId, userId, userId]),
    ]);

    const msg = msgStats?.results?.[0] || {};
    const att = attStats?.results?.[0] || {};
    const contacts = contactStats?.results?.[0] || {};
    const mind = mindscapeStats?.results?.[0] || {};

    // Build integrations list from source data
    const sourceMap = {
      telegram: { name: 'Telegram', icon: 'telegram' },
      discord: { name: 'Discord', icon: 'discord' },
      portal: { name: 'Portal', icon: 'portal' },
      whatsapp: { name: 'WhatsApp', icon: 'whatsapp' },
      imported: { name: 'Imported', icon: 'import' },
    };
    const integrations = Object.entries(sourceMap).map(([key, meta]) => ({
      ...meta,
      messageCount: msg[key] || 0,
      status: (msg[key] || 0) > 0 ? 'connected' : 'not_connected',
    })).filter(i => i.messageCount > 0);

    // Agent status from byAgent results
    const byAgent = {};
    for (const row of (msgByAgent?.results || [])) {
      if (row.agent_id) byAgent[row.agent_id] = row.count;
    }

    res.json({
      messages: {
        total: msg.total || 0,
        bySource: { telegram: msg.telegram || 0, discord: msg.discord || 0, portal: msg.portal || 0, whatsapp: msg.whatsapp || 0, imported: msg.imported || 0, other: msg.other || 0 },
        byAgent,
        dateRange: { first: msg.first_message, last: msg.last_message },
        last30Days: msg30d?.results?.[0]?.count || 0,
      },
      documents: { total: docCount?.results?.[0]?.total || 0 },
      attachments: {
        total: att.total || 0,
        byType: { image: att.images || 0, voice: att.voice || 0, video: att.video || 0 },
        totalSizeMB: Math.round((att.total_bytes || 0) / 1024 / 1024),
      },
      contacts: {
        total: contacts.total || 0,
        byTier: { inner: contacts.inner_count || 0, engaged: contacts.engaged_count || 0, acknowledged: contacts.acknowledged_count || 0, connected: contacts.connected_count || 0 },
      },
      mindscape: { territories: mind.territories || 0, realms: mind.realms || 0, points: mind.points || 0 },
      integrations,
    });
  } catch (e) {
    console.error('[portal/stats]', e.message);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// -- Portal: Audit Logging Middleware --
// Logs all authenticated state-changing portal requests (POST/PUT/DELETE).
// Only metadata — never request bodies or PII.
app.use('/portal', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const startTime = Date.now();
  res.on('finish', () => {
    const user = req._auditUser;
    if (!user) return;
    tryGetDb()?.audit.log({
      action: 'portal.write',
      userId: user.id,
      ip: req.ip,
      resourceType: req.path,
      details: { method: req.method, status: res.statusCode, duration: Date.now() - startTime },
    }).catch(() => {});
  });
  next();
});

// -- Portal: Audit Log Viewer --
app.get('/portal/audit/log', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const { limit, event_type, after } = req.query;

    // Query audit_log — returns only metadata, never PII
    let sql = 'SELECT id, event_type, agent_id, ip_address, endpoint, method, success, details, created_at FROM audit_log WHERE 1=1';
    const params = [];

    if (event_type) { sql += ' AND event_type = ?'; params.push(event_type); }
    if (after) { sql += ' AND created_at > ?'; params.push(after); }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(Math.min(parseInt(limit) || 100, 500));

    const rows = await db.rawQueryAdmin(sql, params);
    res.json({ events: rows });
  } catch (e) {
    res.status(500).json({ error: 'Failed to query audit log' });
  }
});

// -- Portal: Enrichment Status --
app.get('/portal/enrichment/status', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const [total, enriched, pending, failed] = await Promise.all([
      db.rawQuery('SELECT COUNT(*) as c FROM messages WHERE user_id = ?', [user.id]),
      db.rawQuery('SELECT COUNT(*) as c FROM messages WHERE user_id = ? AND nlp_processed = 1', [user.id]),
      db.rawQuery('SELECT COUNT(*) as c FROM messages WHERE user_id = ? AND (nlp_processed = 0 OR nlp_processed IS NULL)', [user.id]),
      db.rawQuery('SELECT COUNT(*) as c FROM messages WHERE user_id = ? AND nlp_processed = -1', [user.id]),
    ]);

    // Check local enrichment service
    let service = null;
    try {
      const sRes = await fetch('http://localhost:8095/status', { signal: AbortSignal.timeout(2000) });
      if (sRes.ok) service = await sRes.json();
    } catch { /* service unavailable */ }

    res.json({
      messages: {
        total: total[0]?.c || 0,
        enriched: enriched[0]?.c || 0,
        pending: pending[0]?.c || 0,
        failed: failed[0]?.c || 0,
      },
      service,
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to get enrichment status' });
  }
});

// -- Portal: Settings --
app.get('/portal/settings', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    res.json({ settings: { timezone: user.timezone, ...user.settings } });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

// -- Portal: Claude Auth (one-click login flow) --
// -- Portal: Claude Code OAuth (direct PKCE, no spawning claude CLI) --
// ============================================
// AI Provider Management
// ============================================

// List connected providers (no raw credentials exposed)
app.get('/portal/providers', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db?.providers) return res.status(503).json({ error: 'Database not available' });

    const providers = await db.providers.list(user.id);
    // Strip credentials — only return metadata
    const safe = providers.map(p => ({
      id: p.id, provider: p.provider, label: p.label, auth_type: p.auth_type,
      model_preference: p.model_preference, base_url: p.base_url,
      is_active: p.is_active, status: p.status,
      last_used_at: p.last_used_at, created_at: p.created_at,
    }));
    res.json({ providers: safe });
  } catch (e) {
    console.error(`[${LOG_PREFIX}] List providers error:`, e.message);
    res.status(500).json({ error: 'Failed to list providers' });
  }
});

// Add API key provider (OpenAI, custom)
app.post('/portal/providers', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db?.providers) return res.status(503).json({ error: 'Database not available' });

    const { provider, label, api_key, model_preference, base_url } = req.body;
    if (!provider || !api_key) return res.status(400).json({ error: 'provider and api_key required' });
    if (!['openai', 'custom'].includes(provider)) return res.status(400).json({ error: 'Use Claude OAuth for Claude accounts' });

    // Encrypt the API key
    let encryptedCreds = null;
    try {
      const { encrypt } = await import('./lib/crypto-local.js');
      encryptedCreds = encrypt(JSON.stringify({ api_key }));
    } catch {
      // No encryption available — store as-is (not ideal, but functional)
      encryptedCreds = JSON.stringify({ api_key });
    }

    const id = await db.providers.create(user.id, {
      provider, label, authType: 'api_key',
      credentials: encryptedCreds,
      model: model_preference, baseUrl: base_url,
    });

    // Set as active if first of this provider type
    const existing = await db.providers.list(user.id);
    const sameType = existing.filter(p => p.provider === provider);
    if (sameType.length <= 1) await db.providers.setActive(id, user.id);

    console.log(`[${LOG_PREFIX}] Added ${provider} provider for user ${user.id}`);
    res.json({ ok: true, id });
  } catch (e) {
    console.error(`[${LOG_PREFIX}] Add provider error:`, e.message);
    res.status(500).json({ error: 'Failed to add provider' });
  }
});

// Update provider (label, model, active)
app.put('/portal/providers/:id', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db?.providers) return res.status(503).json({ error: 'Database not available' });

    const { label, model_preference, base_url, is_active } = req.body;
    const id = parseInt(req.params.id);

    if (is_active) {
      await db.providers.setActive(id, user.id);
    }

    const updates = {};
    if (label !== undefined) updates.label = label;
    if (model_preference !== undefined) updates.model_preference = model_preference;
    if (base_url !== undefined) updates.base_url = base_url;
    if (Object.keys(updates).length) await db.providers.update(id, user.id, updates);

    res.json({ ok: true });
  } catch (e) {
    console.error(`[${LOG_PREFIX}] Update provider error:`, e.message);
    res.status(500).json({ error: 'Failed to update provider' });
  }
});

// Delete provider
app.delete('/portal/providers/:id', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db?.providers) return res.status(503).json({ error: 'Database not available' });

    await db.providers.remove(parseInt(req.params.id), user.id);
    res.json({ ok: true });
  } catch (e) {
    console.error(`[${LOG_PREFIX}] Delete provider error:`, e.message);
    res.status(500).json({ error: 'Failed to delete provider' });
  }
});

// Test provider connectivity
app.post('/portal/providers/:id/test', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db?.providers) return res.status(503).json({ error: 'Database not available' });

    const providers = await db.providers.list(user.id);
    const provider = providers.find(p => p.id === parseInt(req.params.id));
    if (!provider) return res.status(404).json({ error: 'Provider not found' });

    // For Claude: check credentials file
    if (provider.provider === 'claude') {
      const credDir = provider.config_dir || process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude');
      const credPath = path.join(credDir, '.credentials.json');
      const raw = await fs.readFile(credPath, 'utf-8').catch(() => null);
      if (!raw) {
        await db.providers.update(provider.id, user.id, { status: 'error' });
        return res.json({ ok: false, status: 'error', message: 'No credentials file found' });
      }
      const creds = JSON.parse(raw);
      const expired = creds.claudeAiOauth?.expiresAt && creds.claudeAiOauth.expiresAt < Date.now();
      const status = expired ? 'expired' : 'active';
      await db.providers.update(provider.id, user.id, { status });
      return res.json({ ok: !expired, status, message: expired ? 'Token expired' : 'Connected' });
    }

    // For OpenAI: try listing models
    if (provider.provider === 'openai') {
      // Decrypt credentials
      let apiKey = null;
      try {
        const { decrypt } = await import('./lib/crypto-local.js');
        const decrypted = JSON.parse(decrypt(provider.credentials));
        apiKey = decrypted.api_key;
      } catch {
        try { apiKey = JSON.parse(provider.credentials).api_key; } catch {}
      }
      if (!apiKey) {
        await db.providers.update(provider.id, user.id, { status: 'error' });
        return res.json({ ok: false, status: 'error', message: 'Could not decrypt credentials' });
      }

      const testRes = await fetch('https://api.openai.com/v1/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
      const status = testRes.ok ? 'active' : 'error';
      await db.providers.update(provider.id, user.id, { status });
      return res.json({ ok: testRes.ok, status, message: testRes.ok ? 'Connected' : `API error (${testRes.status})` });
    }

    res.json({ ok: true, status: 'active', message: 'No test available for this provider type' });
  } catch (e) {
    console.error(`[${LOG_PREFIX}] Test provider error:`, e.message);
    res.status(500).json({ error: 'Test failed' });
  }
});

// ============================================
// Claude OAuth (preserved pattern + multi-account)
// ============================================

// Stores pending PKCE verifier between /portal/auth/claude and /portal/auth/claude/code
let pendingClaudePkce = null;

const CLAUDE_OAUTH = {
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authorizeUrl: 'https://claude.ai/oauth/authorize',
  tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
  redirectUri: 'https://console.anthropic.com/oauth/code/callback',
  scopes: 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
};

app.post('/portal/auth/claude', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { label } = req.body || {};

    // Determine config dir for this account
    const defaultDir = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude');
    let configDir = defaultDir;

    // If user already has Claude providers, create a new config dir
    const db = tryGetDb();
    if (db?.providers) {
      const existing = await db.providers.list(user.id);
      const claudeCount = existing.filter(p => p.provider === 'claude').length;
      if (claudeCount > 0) {
        configDir = `${defaultDir}-${claudeCount + 1}`;
      }
    }

    // Generate PKCE code verifier (43-128 chars, URL-safe)
    const verifier = crypto.randomBytes(32).toString('base64url');
    // S256 challenge = base64url(sha256(verifier))
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(24).toString('base64url');

    pendingClaudePkce = { verifier, state, createdAt: Date.now(), configDir, label, userId: user.id };

    const params = new URLSearchParams({
      code: 'true',
      client_id: CLAUDE_OAUTH.clientId,
      response_type: 'code',
      redirect_uri: CLAUDE_OAUTH.redirectUri,
      scope: CLAUDE_OAUTH.scopes,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    });

    const url = `${CLAUDE_OAUTH.authorizeUrl}?${params}`;
    console.log(`[${LOG_PREFIX}] Claude OAuth URL generated (PKCE direct)`);
    res.json({ url });
  } catch (e) {
    console.error(`[${LOG_PREFIX}] Claude auth failed:`, e.message);
    res.status(500).json({ error: 'Auth flow failed' });
  }
});

// -- Portal: Exchange OAuth code for tokens (PKCE) --
app.post('/portal/auth/claude/code', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Code required' });

    if (!pendingClaudePkce) {
      return res.status(400).json({ error: 'No pending auth session. Click "Connect with Claude" first.' });
    }

    // Expire after 10 minutes
    if (Date.now() - pendingClaudePkce.createdAt > 10 * 60 * 1000) {
      pendingClaudePkce = null;
      return res.status(400).json({ error: 'Auth session expired. Click "Connect with Claude" again.' });
    }

    const { verifier } = pendingClaudePkce;

    // Exchange code for tokens (JSON body, matching Claude Code's implementation)
    // Clean the code: user might paste the full callback URL or include the #fragment
    let cleanCode = code.trim();
    // If they pasted the full callback URL, extract just the code param
    if (cleanCode.includes('code=')) {
      try {
        const u = new URL(cleanCode);
        cleanCode = u.searchParams.get('code') || cleanCode;
      } catch {
        const m = cleanCode.match(/[?&]code=([^&#]+)/);
        if (m) cleanCode = m[1];
      }
    }
    // Strip URL fragment if present
    cleanCode = cleanCode.split('#')[0].trim();
    const tokenBody = {
      grant_type: 'authorization_code',
      code: cleanCode,
      redirect_uri: CLAUDE_OAUTH.redirectUri,
      client_id: CLAUDE_OAUTH.clientId,
      code_verifier: verifier,
      state: pendingClaudePkce.state,
    };
    console.log(`[${LOG_PREFIX}] Token exchange request:`, JSON.stringify(tokenBody));

    // Retry up to 3 times — Anthropic's token endpoint sometimes returns transient 500s
    let tokenRes = null;
    let lastErr = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      tokenRes = await fetch(CLAUDE_OAUTH.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'claude-code/1.0',
        },
        body: JSON.stringify(tokenBody),
      });
      if (tokenRes.ok) break;
      lastErr = await tokenRes.text();
      console.error(`[${LOG_PREFIX}] Token exchange attempt ${attempt}/3 failed (${tokenRes.status}): ${lastErr.substring(0, 150)}`);
      if (tokenRes.status < 500) break; // Don't retry client errors
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
    }

    if (!tokenRes.ok) {
      console.error(`[${LOG_PREFIX}] Token exchange failed after retries`);
      pendingClaudePkce = null;
      return res.status(400).json({ error: `Token exchange failed (${tokenRes.status}): ${lastErr.substring(0, 200)}` });
    }

    const tokens = await tokenRes.json();
    console.log(`[${LOG_PREFIX}] Token exchange successful, writing credentials`);

    // Write credentials in the same format as `claude auth login`
    const credentials = {
      claudeAiOauth: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
        scopes: CLAUDE_OAUTH.scopes.split(' '),
      },
    };

    // Fetch account details using the new access token
    try {
      const accountRes = await fetch('https://api.claude.ai/api/auth/session', {
        headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'User-Agent': 'claude-code/1.0' },
      });
      if (accountRes.ok) {
        const account = await accountRes.json();
        if (account.email) credentials.claudeAiOauth.email = account.email;
        if (account.subscription_type || account.subscriptionType) {
          credentials.claudeAiOauth.subscriptionType = account.subscription_type || account.subscriptionType;
        }
        if (account.rate_limit_tier || account.rateLimitTier) {
          credentials.claudeAiOauth.rateLimitTier = account.rate_limit_tier || account.rateLimitTier;
        }
      }
    } catch (e) {
      console.warn(`[${LOG_PREFIX}] Could not fetch Claude account details:`, e.message);
    }

    // Write credentials to the target config dir (preserving existing pattern)
    const credDir = pendingClaudePkce.configDir;
    const credLabel = pendingClaudePkce.label;
    const authUserId = pendingClaudePkce.userId;
    const credPath = path.join(credDir, '.credentials.json');

    // Ensure dir exists
    await fs.mkdir(credDir, { recursive: true });
    await fs.writeFile(credPath, JSON.stringify(credentials, null, 2), { mode: 0o600 });

    console.log(`[${LOG_PREFIX}] Claude Code credentials written to ${credPath}`);

    // Fetch account details via CLI (reads fresh token, may return email/subscription)
    // Short delay — CLI needs a moment to recognize the new credentials
    await new Promise(r => setTimeout(r, 2000));
    try {
      const { execSync } = await import('child_process');
      const claudeBin = process.env.CLAUDE_BIN || 'claude';
      const env = { ...process.env, CLAUDE_CONFIG_DIR: credDir };
      const statusOutput = execSync(`${claudeBin} auth status --json`, { encoding: 'utf-8', timeout: 10000, env }).trim();
      const cliStatus = JSON.parse(statusOutput);
      if (cliStatus.email) credentials.claudeAiOauth.email = cliStatus.email;
      if (cliStatus.subscriptionType) credentials.claudeAiOauth.subscriptionType = cliStatus.subscriptionType;
      if (cliStatus.rateLimitTier) credentials.claudeAiOauth.rateLimitTier = cliStatus.rateLimitTier;
      // Re-write with enriched data
      await fs.writeFile(credPath, JSON.stringify(credentials, null, 2), { mode: 0o600 });
      console.log(`[${LOG_PREFIX}] Enriched credentials with email: ${cliStatus.email}, sub: ${cliStatus.subscriptionType}`);
    } catch (e) {
      console.warn(`[${LOG_PREFIX}] Could not enrich credentials via CLI:`, e.message);
    }

    // Create provider record in D1
    const db = tryGetDb();
    let isFirstEver = true;
    if (db?.providers) {
      try {
        // Encrypt credentials for D1 storage
        let encryptedCreds = null;
        try {
          const { encrypt } = await import('./lib/crypto-local.js');
          encryptedCreds = encrypt(JSON.stringify(credentials));
        } catch {
          encryptedCreds = JSON.stringify(credentials);
        }

        const existing = await db.providers.list(authUserId);
        const isFirstProvider = existing.filter(p => p.provider === 'claude').length === 0;

        // Check if user has ANY messages — if so, they're not new (don't send greeting)
        try {
          const msgCheck = await db.rawQuery(
            `SELECT COUNT(*) as c FROM messages WHERE user_id = ? LIMIT 1`, [authUserId]
          );
          if (msgCheck?.[0]?.c > 0) isFirstEver = false;
        } catch {}
        if (!isFirstProvider) isFirstEver = false;

        // Use email from CLI status, or user-provided label, or default
        const autoEmail = credentials.claudeAiOauth?.email;
        const autoSub = credentials.claudeAiOauth?.subscriptionType;
        const providerLabel = autoEmail
          ? (autoSub ? `${autoEmail} (${autoSub})` : autoEmail)
          : credLabel || (isFirstProvider ? 'Claude' : `Claude ${existing.filter(p => p.provider === 'claude').length + 1}`);

        const providerId = await db.providers.create(authUserId, {
          provider: 'claude', label: providerLabel,
          authType: 'oauth', credentials: encryptedCreds,
          configDir: credDir, model: null,
        });

        // Set as active if first Claude account
        if (isFirstProvider && providerId) await db.providers.setActive(providerId, authUserId);

        console.log(`[${LOG_PREFIX}] Claude provider record created (id=${providerId}, dir=${credDir})`);
      } catch (err) {
        console.error(`[${LOG_PREFIX}] Provider record failed:`, err.message);
      }
    }

    pendingClaudePkce = null;

    // Fire-and-forget: store a welcome greeting (only on first-ever provider)
    if (isFirstEver) {
      (async () => {
        try {
          if (!db) return;
          const agentId = AGENT_ID || 'personal-agent';
          const greeting = `Welcome to your Mycelium. I'm your personal agent — you can talk to me here, through Telegram, Discord, or any connected channel.\n\nYour AI inference is now connected. You can start a conversation, import your data, or just explore. Everything you share with me is encrypted end-to-end with your master key.\n\nWhat would you like to do first?`;
          const now = new Date();
          const rows = [
            { user_id: authUserId, role: 'assistant', content: greeting, source: 'portal', agent_id: agentId, created_at: now.toISOString() },
          ];
          const inserted = await db.messages.insert(rows);
          enrichMessages(inserted, authUserId, agentId);
          console.log(`[${LOG_PREFIX}] Welcome greeting stored for user ${authUserId}`);
        } catch (err) {
          console.error(`[${LOG_PREFIX}] Welcome greeting failed:`, err.message);
        }
      })();
    }

    res.json({ ok: true, greeting: isFirstEver });
  } catch (e) {
    pendingClaudePkce = null;
    console.error(`[${LOG_PREFIX}] Claude auth code failed:`, e.message);
    res.status(500).json({ error: e.message || 'Authentication failed' });
  }
});

// -- Portal: Check Claude auth status --
app.get('/portal/auth/claude/status', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    // Try claude auth status --json for rich info (email, subscription)
    try {
      const { execSync } = await import('child_process');
      const claudeBin = process.env.CLAUDE_BIN || 'claude';
      const configDir = process.env.CLAUDE_CONFIG_DIR;
      const env = configDir ? { ...process.env, CLAUDE_CONFIG_DIR: configDir } : process.env;
      const output = execSync(`${claudeBin} auth status --json`, { encoding: 'utf-8', timeout: 5000, env }).trim();
      const status = JSON.parse(output);
      return res.json({
        authenticated: status.loggedIn || false,
        status: status.loggedIn ? 'Authenticated' : 'Not authenticated',
        email: status.email || null,
        subscriptionType: status.subscriptionType || null,
        orgName: status.orgName || null,
      });
    } catch (cliErr) {
      console.warn(`[${LOG_PREFIX}] claude auth status failed:`, cliErr?.message?.slice(0, 100));
    }

    // Fallback: read credentials file directly
    const fs = await import('fs');
    const path = await import('path');
    const credDir = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude');
    const credPath = path.join(credDir, '.credentials.json');

    const raw = await fs.promises.readFile(credPath, 'utf-8').catch(() => null);
    if (!raw) return res.json({ authenticated: false, status: 'Not authenticated' });

    const creds = JSON.parse(raw);
    const oauth = creds.claudeAiOauth;
    if (!oauth?.accessToken) return res.json({ authenticated: false, status: 'No credentials' });

    const expired = oauth.expiresAt && oauth.expiresAt < Date.now();

    // Try to get email from ai_providers table if not in credentials
    let email = oauth.email || null;
    let subscriptionType = oauth.subscriptionType || null;
    if (!email) {
      try {
        const db = tryGetDb();
        if (db?.providers) {
          const providers = await db.providers.list(process.env.MYA_USER_ID);
          const claudeProvider = providers.find(p => p.provider === 'claude' && p.is_active);
          if (claudeProvider?.label) email = claudeProvider.label;
        }
      } catch {}
    }

    res.json({
      authenticated: !expired,
      status: expired ? 'Token expired' : 'Authenticated',
      email,
      subscriptionType,
      hasRefreshToken: !!oauth.refreshToken,
    });
  } catch {
    res.json({ authenticated: false, status: 'Not authenticated' });
  }
});

app.post('/portal/auth/claude/disconnect', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { execSync } = await import('child_process');
    const claudeBin = process.env.CLAUDE_BIN || 'claude';
    const configDir = process.env.CLAUDE_CONFIG_DIR;
    const env = configDir ? { ...process.env, CLAUDE_CONFIG_DIR: configDir } : process.env;
    execSync(`${claudeBin} auth logout`, { encoding: 'utf-8', timeout: 5000, env });

    console.log(`[${LOG_PREFIX}] Claude Code disconnected by user`);
    res.json({ ok: true });
  } catch (e) {
    // Fallback: delete credentials file directly
    try {
      const fs = await import('fs');
      const path = await import('path');
      const credDir = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude');
      const credPath = path.join(credDir, '.credentials.json');
      await fs.promises.unlink(credPath);
      console.log(`[${LOG_PREFIX}] Claude credentials file removed`);
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Failed to disconnect' });
    }
  }
});

app.put('/portal/settings', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const { timezone, vault_name } = req.body;
    if (timezone && typeof timezone === 'string') {
      await db.users?.updateTimezone?.(user.id, timezone);
    }
    if (vault_name !== undefined && typeof vault_name === 'string') {
      const current = await db.users.getSettings(user.id);
      current.vault_name = vault_name.trim().substring(0, 60);
      await db.users.updateSettings(user.id, current);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// -- Portal: Billing (subscription status + Stripe portal) --

app.get('/portal/billing', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    // Managed-mode detection: a customer VPS is "managed" if it has a tenant
    // identity (MYA_USER_ID) and can talk to the operator Worker. The
    // ADMIN_SECRET sentinel was removed as part of Option 3 — agents must not
    // hold operator credentials.
    if (!process.env.MYA_WORKER_URL || !process.env.MYA_USER_ID) {
      return res.json({ managed: false });
    }

    // Fetch subscription from D1
    const rows = await db.rawQuery(
      `SELECT plan, type, status, current_period_end, cancel_at_period_end, created_at, payment_method, paid_through, crypto_coin
       FROM subscriptions WHERE user_id = ? LIMIT 1`,
      [user.id]
    );
    const sub = rows?.[0];

    if (!sub) {
      return res.json({ managed: true, subscription: null });
    }

    // Fetch crypto payment history if applicable
    let cryptoPayments = [];
    if (sub.payment_method === 'crypto') {
      cryptoPayments = await db.rawQuery(
        `SELECT coingate_order_id, plan, amount_eur, crypto_amount, crypto_coin, credited_months, paid_at
         FROM crypto_payments WHERE user_id = ? AND status = 'paid' ORDER BY paid_at DESC LIMIT 20`,
        [user.id]
      );
    }

    res.json({
      managed: true,
      subscription: {
        plan: sub.plan,
        type: sub.type,
        status: sub.status,
        currentPeriodEnd: sub.current_period_end,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        createdAt: sub.created_at,
        paymentMethod: sub.payment_method || 'stripe',
        paidThrough: sub.paid_through,
        cryptoCoin: sub.crypto_coin,
      },
      cryptoPayments,
    });
  } catch (e) {
    console.error('[Portal] Billing fetch failed:', e?.message);
    res.status(500).json({ error: 'Failed to load billing info' });
  }
});

app.post('/portal/billing/portal', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const workerUrl = process.env.MYA_WORKER_URL;
    const agentToken = process.env.AGENT_TOKEN;
    if (!workerUrl || !agentToken) {
      return res.status(400).json({ error: 'Billing not available for self-hosted instances' });
    }

    // Proxy to Worker billing portal endpoint with the agent token. The Worker
    // resolves the user_id from identity.user_id (the agent token's tenant)
    // — no need to pass it in the body. Agent tokens can only proxy billing
    // for their own tenant.
    const portalRes = await fetch(`${workerUrl}/api/billing/portal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentToken}` },
      body: JSON.stringify({
        returnUrl: req.body?.returnUrl || `https://${req.headers.host}/settings`,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!portalRes.ok) {
      const err = await portalRes.json().catch(() => ({ error: 'Unknown error' }));
      return res.status(portalRes.status).json(err);
    }

    const data = await portalRes.json();
    res.json(data);
  } catch (e) {
    console.error('[Portal] Billing portal failed:', e?.message);
    res.status(500).json({ error: 'Failed to create billing portal session' });
  }
});

// -- Portal: Crypto top-up (proxy to Worker) --
app.post('/portal/billing/crypto', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const workerUrl = process.env.MYA_WORKER_URL;
    if (!workerUrl) return res.status(400).json({ error: 'Not available' });

    const { plan } = req.body;
    const db = tryGetDb();
    // Get user email for CoinGate
    let email = null;
    if (db) {
      const rows = await db.rawQuery(
        `SELECT email FROM provisioning_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
        [user.id]
      );
      email = rows?.[0]?.email;
    }

    const headers = { 'Content-Type': 'application/json' };
    if (process.env.AGENT_TOKEN) headers['Authorization'] = `Bearer ${process.env.AGENT_TOKEN}`;

    const invoiceRes = await fetch(`${workerUrl}/api/crypto/invoice`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        plan,
        user_id: user.id,
        email: email || user.displayName,
        return_url: `https://${req.headers.host}`,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!invoiceRes.ok) {
      const err = await invoiceRes.json().catch(() => ({ error: 'Unknown error' }));
      return res.status(invoiceRes.status).json(err);
    }

    const data = await invoiceRes.json();
    res.json(data);
  } catch (e) {
    console.error('[Portal] Crypto top-up failed:', e?.message);
    res.status(500).json({ error: 'Failed to create crypto invoice' });
  }
});

// -- Portal: Export (download all user data as JSON) --
// Security: re-auth via passkey + daily rate limit + audit logging + email notification
// Managed mode: upload to R2, email signed download link
// Self-hosted: direct JSON download

app.post('/portal/export', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    // Validate one-time export token
    const { exportToken } = req.body || {};
    if (exportToken) {
      const entry = exportTokens.get(exportToken);
      if (!entry) return res.status(401).json({ error: 'Invalid or expired export token' });
      if (Date.now() - entry.createdAt > EXPORT_TOKEN_TTL) {
        exportTokens.delete(exportToken);
        return res.status(401).json({ error: 'Export token expired' });
      }
      if (entry.userId !== user.id) return res.status(401).json({ error: 'Token/user mismatch' });
      exportTokens.delete(exportToken); // consume — single use
    } else {
      // No token provided — check if passkeys exist (if yes, require re-auth)
      const db2 = tryGetDb();
      if (db2) {
        const creds = await db2.passkeys.listByUser(user.id);
        if (creds && creds.length > 0) {
          return res.status(401).json({ error: 'Re-authentication required. Call /portal/export/auth first.' });
        }
      }
    }

    // Daily rate limit (3/day per user)
    if (!checkDailyLimit(user.id, 'export', 3)) {
      logEvent('security.export_failed', { userId: user.id, ip: req.ip, reason: 'daily_limit' });
      return res.status(429).json({ error: 'Export limit exceeded. Maximum 3 exports per day.' });
    }

    // Burst rate limit (2/min)
    if (!checkRateLimit(req, res, 'export', 2)) {
      logEvent('security.export_failed', { userId: user.id, ip: req.ip, reason: 'burst_limit' });
      return;
    }

    logEvent('security.export_requested', { userId: user.id, ip: req.ip, ua: req.headers['user-agent'] });

    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const userId = user.id;

    // ── Fetch all user data in parallel where possible ──

    // Messages (paginated — can be 20K+)
    const allMessages = [];
    let offset = 0;
    while (true) {
      const batch = await db.messages.selectAll(userId, { limit: 500, offset });
      if (!batch.length) break;
      allMessages.push(...batch);
      offset += batch.length;
      if (batch.length < 500) break;
    }

    // Documents (with full content) + folders
    const [docList, folders] = await Promise.all([
      db.documents.list(userId),
      db.folders.list(userId),
    ]);
    const fullDocuments = [];
    for (const doc of docList) {
      try {
        const full = await db.documents.get(userId, doc.path);
        fullDocuments.push(full || doc);
      } catch { fullDocuments.push(doc); }
    }

    // Attachments metadata
    const allAttachments = [];
    let attOffset = 0;
    while (true) {
      const batch = await db.attachments.listByUser(userId, { limit: 500, offset: attOffset });
      if (!batch.length) break;
      allAttachments.push(...batch);
      attOffset += batch.length;
      if (batch.length < 500) break;
    }

    // Mindscape: full tables with all columns (centroids, generation metadata, raw_response)
    const [territories, realms, semanticThemes, themeCards] = await Promise.all([
      db.rawQuery(`SELECT * FROM territory_profiles WHERE user_id = ? ORDER BY energy DESC NULLS LAST`, [userId]).catch(() => []),
      db.rawQuery(`SELECT * FROM realms WHERE user_id = ?`, [userId]).catch(() => []),
      db.rawQuery(`SELECT * FROM semantic_themes WHERE user_id = ?`, [userId]).catch(() => []),
      db.rawQuery(`SELECT * FROM theme_cards WHERE user_id = ?`, [userId]).catch(() => []),
    ]);

    // Clustering points: all columns including embedding_model, cluster_version, coordinates
    const clusteringPoints = [];
    let cpOffset = 0;
    while (true) {
      const batch = await db.rawQuery(
        `SELECT id, source_type, source_id, content, atom_id, territory_id, theme_id, realm_id,
                is_liminal, landscape_x, landscape_y, landscape_z, landscape_x_2d, landscape_y_2d,
                cluster_version, embedding_model, created_at, updated_at
         FROM clustering_points WHERE user_id = ? ORDER BY created_at DESC LIMIT 5000 OFFSET ?`,
        [userId, cpOffset]
      ).catch(() => []);
      if (!batch || !batch.length) break;
      clusteringPoints.push(...batch);
      cpOffset += batch.length;
      if (batch.length < 5000) break;
    }

    // Nomic 256D embeddings (BLOBs) — stored separately as hex, critical for clustering reconstruction
    const nomicEmbeddings = {};
    try {
      let neOffset = 0;
      while (true) {
        const batch = await db.rawQuery(
          `SELECT id, hex(nomic_embedding) as nomic_hex FROM clustering_points
           WHERE user_id = ? AND nomic_embedding IS NOT NULL LIMIT 5000 OFFSET ?`,
          [userId, neOffset]
        );
        if (!batch || !batch.length) break;
        for (const row of batch) { if (row.nomic_hex) nomicEmbeddings[row.id] = row.nomic_hex; }
        neOffset += batch.length;
        if (batch.length < 5000) break;
      }
    } catch {}

    // Topology: co-firing, neighbor relationships, cluster events (evolution history)
    const [clusterEvents, cofiring, territoryNeighbors] = await Promise.all([
      db.clusterEvents.getRecent(userId, 10000).catch(() => []),
      db.rawQuery(`SELECT * FROM territory_cofire WHERE user_id = ?`, [userId]).catch(() => []),
      db.rawQuery(`SELECT * FROM territory_neighbors WHERE user_id = ?`, [userId]).catch(() => []),
    ]);

    // Contacts
    const allPeople = [];
    try {
      const rows = await db.rawQuery(
        `SELECT id, name, aliases, email, phone, linkedin_url, company, position, description,
                source, tier, status, connected_at, last_interaction_at, interaction_count,
                sent_count, received_count, metadata, created_at
         FROM people WHERE user_id = ? ORDER BY name`,
        [userId]
      );
      allPeople.push(...(rows || []));
    } catch {}

    // Contact-territory links
    let contactTerritories = [];
    try {
      contactTerritories = await db.rawQuery(
        `SELECT contact_id, territory_id, strength, mention_count, first_seen, last_seen
         FROM contact_territories WHERE contact_id IN (SELECT id FROM people WHERE user_id = ?)`,
        [userId]
      );
    } catch {}

    // Health data
    let healthData = [];
    try {
      healthData = await db.health.getRange(userId, '2000-01-01', '2099-12-31');
    } catch {}

    // Activity
    let activitySessions = [];
    let activityDaily = [];
    try {
      activitySessions = await db.rawQuery(
        `SELECT id, app_bundle, app_name, window_title, url, category, productivity,
                started_at, ended_at, duration_s, idle, date
         FROM activity_sessions WHERE agent_id = ? ORDER BY started_at DESC LIMIT 50000`,
        [process.env.AGENT_ID || 'personal-agent']
      );
    } catch {}
    try {
      activityDaily = await db.rawQuery(
        `SELECT date, category, total_s, session_count, productivity_avg
         FROM activity_daily WHERE agent_id = ? ORDER BY date DESC`,
        [process.env.AGENT_ID || 'personal-agent']
      );
    } catch {}

    // Wealth
    let wealthPortfolios = [], wealthPositions = [], wealthTransactions = [], wealthSnapshots = [], wealthAssets = [], wealthWatchlist = [];
    try {
      wealthPortfolios = await db.wealth.listPortfolios(userId).catch(() => []);
      wealthAssets = await db.rawQuery('SELECT * FROM wealth_assets').catch(() => []);
      wealthWatchlist = await db.wealth.getWatchlist(userId).catch(() => []);
      for (const p of wealthPortfolios) {
        const [pos, txs, snaps] = await Promise.all([
          db.wealth.getPositions(p.id).catch(() => []),
          db.wealth.listTransactions(p.id, { limit: 50000 }).catch(() => []),
          db.wealth.getSnapshots(p.id).catch(() => []),
        ]);
        wealthPositions.push(...pos.map(r => ({ ...r, portfolio_id: p.id })));
        wealthTransactions.push(...txs);
        wealthSnapshots.push(...snaps.map(r => ({ ...r, portfolio_id: p.id })));
      }
    } catch {}

    // User profile + settings
    let userProfile = null, userSettings = {};
    try {
      const u = await db.users.getFirst();
      userSettings = { displayName: u?.display_name, timezone: u?.timezone, settings: u?.settings ? JSON.parse(u.settings) : {} };
    } catch {}
    try {
      userProfile = await db.rawQuery(
        `SELECT * FROM user_profiles WHERE user_id = ?`, [userId]
      ).then(r => r?.[0] || null);
    } catch {}

    // User identities
    let identities = [];
    try { identities = await db.userIdentities.list(userId).catch(() => []); } catch {}

    // Canvases
    let canvases = [];
    try { canvases = await db.canvases.list(userId).catch(() => []); } catch {}

    // Agent tasks
    let tasks = [];
    try {
      tasks = await db.rawQuery(
        `SELECT id, agent_id, type, description, status, priority, result, summary, error, created_at, started_at, completed_at
         FROM agent_tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT 10000`,
        [userId]
      );
    } catch {}

    // Internal model items
    let internalModel = [];
    try {
      internalModel = await db.rawQuery(
        `SELECT id, section, content, reinforcement_count, status, source_cycle_id, created_at, updated_at
         FROM internal_model_items WHERE user_id = ? ORDER BY section, created_at DESC`,
        [userId]
      );
    } catch {}

    // Passkey credentials (public keys only — for vault migration)
    let passkeys = [];
    try { passkeys = await db.passkeys.listByUser(userId).catch(() => []); } catch {}

    // Document versions (edit history)
    let documentVersions = [];
    try {
      documentVersions = await db.rawQuery(
        `SELECT * FROM document_versions WHERE document_id IN (SELECT id FROM documents WHERE user_id = ?) ORDER BY created_at DESC`,
        [userId]
      ) || [];
    } catch {}

    // Canvas nodes + edges (visual layouts)
    let canvasNodes = [], canvasEdges = [], canvasCollaborators = [];
    try {
      canvasNodes = await db.rawQuery(`SELECT * FROM canvas_nodes WHERE workspace_id IN (SELECT id FROM canvas_workspaces WHERE user_id = ?)`, [userId]) || [];
      canvasEdges = await db.rawQuery(`SELECT * FROM canvas_edges WHERE workspace_id IN (SELECT id FROM canvas_workspaces WHERE user_id = ?)`, [userId]) || [];
      canvasCollaborators = await db.rawQuery(`SELECT * FROM canvas_collaborators WHERE workspace_id IN (SELECT id FROM canvas_workspaces WHERE user_id = ?)`, [userId]) || [];
    } catch {}

    // Connections (user-to-user social graph)
    let connections = [];
    try { connections = await db.rawQuery(`SELECT * FROM connections WHERE user_a = ? OR user_b = ?`, [userId, userId]) || []; } catch {}

    // Realm neighbors (topology)
    let realmNeighbors = [];
    try { realmNeighbors = await db.rawQuery(`SELECT * FROM realm_neighbors WHERE user_id = ?`, [userId]) || []; } catch {}

    // Reflections (agent-generated insights)
    let reflections = [];
    try { reflections = await db.rawQuery(`SELECT * FROM reflections WHERE user_id = ? ORDER BY created_at DESC`, [userId]) || []; } catch {}

    // Personal tasks (separate from agent_tasks)
    let personalTasks = [];
    try { personalTasks = await db.rawQuery(`SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at DESC`, [userId]) || []; } catch {}

    // Note links (document cross-references)
    let noteLinks = [];
    try { noteLinks = await db.rawQuery(`SELECT * FROM note_links WHERE user_id = ?`, [userId]) || []; } catch {}

    // Share links + access grants
    let shareLinks = [], accessGrants = [];
    try { shareLinks = await db.rawQuery(`SELECT * FROM share_links WHERE entity_id IN (SELECT id FROM documents WHERE user_id = ?)`, [userId]) || []; } catch {}
    try { accessGrants = await db.rawQuery(`SELECT * FROM access_grants WHERE user_id = ?`, [userId]) || []; } catch {}

    // AI providers (credentials encrypted — will be decrypted by rawQuery auto-decrypt)
    let aiProviders = [];
    try { aiProviders = await db.rawQuery(`SELECT * FROM ai_providers WHERE user_id = ?`, [userId]) || []; } catch {}

    // Scheduled events (cron jobs)
    let scheduledEvents = [];
    try { scheduledEvents = await db.rawQuery(`SELECT * FROM scheduled_events WHERE user_id = ?`, [userId]) || []; } catch {}

    // Secrets (encrypted key-value store — decrypted by master key on VPS)
    let secrets = [];
    try { secrets = await db.rawQuery(`SELECT key, scope, agent, description, version, created_at, updated_at FROM secrets WHERE user_id = ?`, [userId]) || []; } catch {}

    // Agent events (execution audit trail)
    let agentEvents = [];
    try {
      agentEvents = await db.rawQuery(
        `SELECT * FROM agent_events WHERE agent_id IN (SELECT agent FROM agent_tokens WHERE user_id = ?) ORDER BY created_at DESC LIMIT 50000`,
        [userId]
      ) || [];
    } catch {}

    // Cycle metrics (LLM cost/performance tracking)
    let cycleMetrics = [];
    try { cycleMetrics = await db.rawQuery(`SELECT * FROM cycle_metrics WHERE user_id = ? ORDER BY created_at DESC`, [userId]) || []; } catch {}

    // Wealth wallets + portfolio access
    let wealthWallets = [], wealthPortfolioAccess = [];
    try { wealthWallets = await db.rawQuery(`SELECT * FROM wealth_wallets WHERE user_id = ?`, [userId]) || []; } catch {}
    try { wealthPortfolioAccess = await db.rawQuery(`SELECT * FROM wealth_portfolio_access WHERE user_id = ?`, [userId]) || []; } catch {}

    // ── Build ZIP archive ──
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();

    // Download R2 attachments and add binary files to ZIP. Uses the agent
    // token — the Worker's serveAttachment path verifies the agent token's
    // tenant matches the attachment's path prefix (user_id), so an agent
    // can only ever fetch its own customer's attachments.
    const workerUrl = process.env.MYA_WORKER_URL;
    const workerSecret = process.env.AGENT_TOKEN;
    let attachmentsFetched = 0, attachmentsFailed = 0;

    for (const att of allAttachments) {
      if (!att.r2_key || !workerUrl) continue;
      try {
        const r2Res = await fetch(`${workerUrl}/attachments/${att.r2_key}`, {
          headers: { 'Authorization': `Bearer ${workerSecret}` },
          signal: AbortSignal.timeout(30000),
        });
        if (r2Res.ok) {
          const buf = Buffer.from(await r2Res.arrayBuffer());
          const safeName = (att.file_name || att.id).replace(/[^a-zA-Z0-9._-]/g, '_');
          zip.file(`attachments/${att.id}/${safeName}`, buf);
          att.zipPath = `attachments/${att.id}/${safeName}`;
          attachmentsFetched++;
        } else {
          att.fetchError = `HTTP ${r2Res.status}`;
          attachmentsFailed++;
        }
      } catch (e) {
        att.fetchError = e.message;
        attachmentsFailed++;
      }
    }

    // Add agent directory tree (memory, mind files, heartbeats, prompts, etc.)
    const agentsRoot = getAgentsRoot();
    async function addDirToZip(zipObj, dirPath, zipPrefix) {
      try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dirPath, entry.name);
          const zipPath = `${zipPrefix}/${entry.name}`;
          if (entry.isDirectory()) {
            // Skip large/irrelevant dirs
            if (['node_modules', '.git', 'repo', 'sessions', 'logs'].includes(entry.name)) continue;
            await addDirToZip(zipObj, fullPath, zipPath);
          } else {
            try {
              const content = await fs.readFile(fullPath);
              zipObj.file(zipPath, content);
            } catch {}
          }
        }
      } catch {}
    }
    try {
      const agentDirs = await fs.readdir(agentsRoot).catch(() => []);
      for (const agentDir of agentDirs) {
        const agentPath = path.join(agentsRoot, agentDir);
        const stat = await fs.stat(agentPath).catch(() => null);
        if (!stat || !stat.isDirectory()) continue;
        await addDirToZip(zip, agentPath, `agents/${agentDir}`);
      }
      // Also add the shared events dir
      const sharedDir = path.join(agentsRoot, '.shared');
      const sharedStat = await fs.stat(sharedDir).catch(() => null);
      if (sharedStat?.isDirectory()) {
        await addDirToZip(zip, sharedDir, 'agents/.shared');
      }
    } catch (e) {
      console.warn('[Export] Agent dirs failed:', e.message);
    }

    // Build manifest JSON
    const exportData = {
      exportedAt: new Date().toISOString(),
      version: 3,
      format: 'mycelium-vault-export',
      meta: {
        embeddingModels: {
          search: { name: 'bge-m3', dimensions: 1024, provider: 'cloudflare-workers-ai', index: 'mycelium-search' },
          clustering: { name: 'nomic-embed-text-v1.5', dimensions: 256, provider: 'onnx-local', index: 'mycelium-cluster' },
        },
        hierarchy: 'realm → semantic_theme → territory → clustering_point',
        note: 'Nomic 256D embeddings stored in nomicEmbeddings map (point_id → hex). Convert hex to Float32Array for reconstruction.',
      },
      user: { id: userId, ...userSettings, profile: userProfile, identities, passkeys },
      messages: { total: allMessages.length, data: allMessages },
      documents: { total: fullDocuments.length, data: fullDocuments },
      folders,
      attachments: { total: allAttachments.length, fetched: attachmentsFetched, failed: attachmentsFailed, data: allAttachments },
      mindscape: {
        territories,
        realms,
        semanticThemes,
        themeCards,
        clusteringPoints: { total: clusteringPoints.length, data: clusteringPoints },
        nomicEmbeddings: { total: Object.keys(nomicEmbeddings).length, note: 'hex-encoded 256D Nomic float32 vectors, keyed by clustering_point id', data: nomicEmbeddings },
        clusterEvents,
      },
      contacts: { total: allPeople.length, data: allPeople, territoryLinks: contactTerritories },
      health: healthData,
      activity: { sessions: activitySessions, daily: activityDaily },
      wealth: { portfolios: wealthPortfolios, assets: wealthAssets, positions: wealthPositions, transactions: wealthTransactions, snapshots: wealthSnapshots, watchlist: wealthWatchlist },
      canvases: { workspaces: canvases, nodes: canvasNodes, edges: canvasEdges, collaborators: canvasCollaborators },
      tasks: { agentTasks: tasks, personalTasks },
      internalModel,
      documents_meta: { versions: documentVersions, noteLinks, shareLinks, accessGrants },
      connections,
      reflections,
      aiProviders,
      scheduledEvents,
      secrets: { note: 'Values excluded for security — keys and metadata only', data: secrets },
      agentEvents: { total: agentEvents.length, data: agentEvents },
      cycleMetrics,
      topology: { realmNeighbors, cofiring, territoryNeighbors },
      wealthExtra: { wallets: wealthWallets, portfolioAccess: wealthPortfolioAccess },
    };

    const jsonStr = JSON.stringify(exportData, null, 2).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    zip.file('manifest.json', Buffer.from(jsonStr, 'utf-8'));

    // Generate ZIP buffer
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    const filename = `mycelium-export-${new Date().toISOString().slice(0, 10)}.zip`;
    const zipSizeMB = (zipBuffer.length / 1048576).toFixed(1);

    // Detect deployment mode: managed customers get R2 + email with PIN.
    // The sentinel is MYA_USER_ID + AGENT_TOKEN — operator credentials
    // (ADMIN_SECRET / MYA_WORKER_SECRET) no longer live in agent runtime.
    const isManaged = !!(process.env.MYA_WORKER_URL && process.env.AGENT_TOKEN && process.env.MYA_USER_ID);

    if (isManaged) {
      try {
        const workerUrl = process.env.MYA_WORKER_URL;
        const agentToken = process.env.AGENT_TOKEN;

        // Upload ZIP via the tenant self-service export endpoint. The Worker
        // stores at exports/<identity.user_id>/... — the agent CANNOT influence
        // the user_id field; it's resolved server-side from the agent token.
        const storeRes = await fetch(`${workerUrl}/api/export-self`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentToken}` },
          body: JSON.stringify({ data: zipBuffer.toString('base64') }),
          signal: AbortSignal.timeout(60000),
        });

        if (!storeRes.ok) throw new Error(`Store failed: ${storeRes.status}`);
        const { downloadUrl, pin } = await storeRes.json();

        if (downloadUrl) {
          // Send the export-ready notification via the self-service notify
          // endpoint. The Worker resolves the destination email from
          // provisioning_jobs using the agent's tenant id — the agent has
          // no ability to spoof the recipient.
          await fetch(`${workerUrl}/api/notify-self`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentToken}` },
            body: JSON.stringify({
              event: 'export_ready',
              details: { zipSizeMB, downloadUrl },
            }),
            signal: AbortSignal.timeout(5000),
          }).catch((e) => console.warn('[Portal] export_ready notify failed:', e.message));

          logEvent('security.export_completed', {
            userId: user.id, ip: req.ip, deliveryMethod: 'email',
            messageCount: allMessages.length, documentCount: fullDocuments.length,
            contactCount: allPeople.length, attachmentCount: allAttachments.length,
            attachmentsFetched, attachmentsFailed, zipSizeMB,
          });
          sendSecurityEmail('export', req, { messageCount: allMessages.length }).catch(() => {});
          return res.json({ ok: true, method: 'email', pin, message: 'Download link sent to your email. Use the PIN below to verify.' });
        }
      } catch (e) {
        console.error('[Portal] Managed export failed, falling back to download:', e.message);
        // Fall through to direct download
      }
    }

    // Self-hosted (or managed fallback): direct download
    logEvent('security.export_completed', {
      userId: user.id, ip: req.ip, deliveryMethod: 'download',
      messageCount: allMessages.length, documentCount: fullDocuments.length,
      contactCount: allPeople.length, attachmentCount: allAttachments.length,
      attachmentsFetched, attachmentsFailed, zipSizeMB,
    });
    sendSecurityEmail('export', req, { messageCount: allMessages.length }).catch(() => {});

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', zipBuffer.length);
    res.send(zipBuffer);
  } catch (e) {
    console.error('[Portal] Export failed:', e?.message || e);
    logEvent('security.export_failed', { userId: 'unknown', ip: req.ip, reason: e?.message || 'unknown' });
    res.status(500).json({ error: 'Export failed' });
  }
});

// -- Portal: Vault Restore (full import from v3 ZIP export) --
// Restores ALL user data: messages, documents, attachments, mindscape, contacts, health, wealth, agents, etc.

async function restoreRaw(db, targetUserId, table, rows, userIdCol = 'user_id') {
  if (!rows || !rows.length) return 0;
  let count = 0;
  for (const row of rows) {
    try {
      if (targetUserId && row[userIdCol]) row[userIdCol] = targetUserId;
      const cols = Object.keys(row).filter(c => row[c] !== undefined);
      const vals = cols.map(c => row[c]);
      const placeholders = cols.map(() => '?').join(', ');
      await db.rawQuery(
        `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`,
        vals
      );
      count++;
    } catch (e) {
      // Skip individual row failures (constraint violations, etc.)
    }
  }
  return count;
}

async function restoreClusteringPoints(db, targetUserId, points, embeddings) {
  if (!points?.length) return 0;
  let count = 0;
  for (const pt of points) {
    try {
      pt.user_id = targetUserId;
      const hex = embeddings?.[pt.id];
      const cols = Object.keys(pt).filter(c => pt[c] !== undefined);
      const vals = cols.map(c => pt[c]);
      let sql;
      if (hex) {
        const placeholders = cols.map(() => '?').join(', ') + `, x'${hex}'`;
        sql = `INSERT OR REPLACE INTO clustering_points (${cols.join(', ')}, nomic_embedding) VALUES (${placeholders})`;
      } else {
        const placeholders = cols.map(() => '?').join(', ');
        sql = `INSERT OR REPLACE INTO clustering_points (${cols.join(', ')}) VALUES (${placeholders})`;
      }
      await db.rawQuery(sql, vals);
      count++;
    } catch {}
  }
  return count;
}

async function restoreAttachments(db, targetUserId, attachments, zip, workerUrl, workerSecret) {
  if (!attachments?.length) return { inserted: 0, uploaded: 0, failed: 0 };
  let inserted = 0, uploaded = 0, failed = 0;

  for (const att of attachments) {
    try {
      // Upload binary from ZIP to R2
      const zipEntry = att.zipPath ? zip.file(att.zipPath) : null;
      if (zipEntry && workerUrl && workerSecret) {
        try {
          const buf = await zipEntry.async('nodebuffer');
          const ext = att.file_name ? path.extname(att.file_name) : '';
          const r2Key = `${targetUserId}/${att.file_type || 'file'}/${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;

          const r2Res = await fetch(`${workerUrl}/api/store-attachment`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${workerSecret}`,
              'Content-Type': att.file_type === 'image' ? 'image/jpeg' : 'application/octet-stream',
              'X-Filename': att.file_name || 'file',
              'X-User-Id': targetUserId,
            },
            body: buf,
            signal: AbortSignal.timeout(30000),
          });

          if (r2Res.ok) {
            const result = await r2Res.json();
            att.r2_key = result.r2Key || r2Key;
            uploaded++;
          }
        } catch (e) {
          failed++;
        }
      }

      // Insert attachment metadata
      const record = { ...att };
      record.user_id = targetUserId;
      delete record.zipPath;
      delete record.fetchError;
      delete record.downloadUrl;
      await db.attachments.insert(record);
      inserted++;
    } catch {
      failed++;
    }
  }
  return { inserted, uploaded, failed };
}

async function restoreAgentFiles(zip) {
  const agentsRoot = getAgentsRoot();
  let count = 0;
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!name.startsWith('agents/') || entry.dir) continue;
    try {
      const targetPath = path.join(agentsRoot, name.slice('agents/'.length));
      // Safety: don't write outside agents root
      if (!targetPath.startsWith(agentsRoot)) continue;
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, await entry.async('nodebuffer'));
      count++;
    } catch {}
  }
  return count;
}

app.post('/portal/import/vault', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    // Daily rate limit
    if (!checkDailyLimit(user.id, 'import', 3)) {
      return res.status(429).json({ error: 'Import limit exceeded. Maximum 3 per day.' });
    }
    if (!checkRateLimit(req, res, 'import', 2)) return;

    logEvent('security.import_requested', { userId: user.id, ip: req.ip });

    // Parse multipart upload (ZIP file, up to 2GB)
    const bb = Busboy({ headers: req.headers, limits: { fileSize: 2_000_000_000, files: 1 } });
    let fileBuffer = null;

    const parsePromise = new Promise((resolve, reject) => {
      const chunks = [];
      bb.on('file', (_fieldname, stream, _info) => {
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => { fileBuffer = Buffer.concat(chunks); });
      });
      // Capture exportToken from form fields
      let exportToken = null;
      bb.on('field', (name, val) => { if (name === 'exportToken') exportToken = val; });
      bb.on('close', () => resolve(exportToken));
      bb.on('error', reject);
    });

    req.pipe(bb);
    const exportToken = await parsePromise;

    // Validate re-auth token (same as export)
    if (exportToken) {
      const entry = exportTokens.get(exportToken);
      if (!entry || entry.userId !== user.id || Date.now() - entry.createdAt > EXPORT_TOKEN_TTL) {
        exportTokens.delete(exportToken);
        return res.status(401).json({ error: 'Invalid or expired token' });
      }
      exportTokens.delete(exportToken);
    } else {
      const db2 = tryGetDb();
      if (db2) {
        const creds = await db2.passkeys.listByUser(user.id);
        if (creds?.length > 0) {
          return res.status(401).json({ error: 'Re-authentication required' });
        }
      }
    }

    if (!fileBuffer || fileBuffer.length < 100) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Parse ZIP
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(fileBuffer);
    const manifestEntry = zip.file('manifest.json');
    if (!manifestEntry) {
      return res.status(400).json({ error: 'Invalid vault export: missing manifest.json' });
    }

    const manifest = JSON.parse(await manifestEntry.async('text'));
    if (manifest.format !== 'mycelium-vault-export') {
      return res.status(400).json({ error: `Unknown export format: ${manifest.format}` });
    }

    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const targetUserId = user.id;
    const stats = {};

    console.log(`[Import] Starting vault restore v${manifest.version} for ${targetUserId} (${manifest.messages?.total || 0} messages, ${manifest.attachments?.total || 0} attachments)`);

    // ── Restore in dependency order ──

    // 1. User settings
    try {
      if (manifest.user?.timezone) await db.users.updateTimezone(targetUserId, manifest.user.timezone);
      if (manifest.user?.settings) await db.users.updateSettings(targetUserId, manifest.user.settings);
    } catch {}

    // 2. Folders
    stats.folders = await restoreRaw(db, targetUserId, 'folders', manifest.folders);

    // 3. Documents + versions + links
    if (manifest.documents?.data) {
      let docCount = 0;
      for (const doc of manifest.documents.data) {
        try {
          await db.documents.upsert({ ...doc, user_id: targetUserId });
          docCount++;
        } catch {}
      }
      stats.documents = docCount;
    }
    stats.documentVersions = await restoreRaw(db, null, 'document_versions', manifest.documents_meta?.versions);
    stats.noteLinks = await restoreRaw(db, targetUserId, 'note_links', manifest.documents_meta?.noteLinks);

    // 4. Attachments (R2 binaries + metadata) — uses agent token. The Worker
    // /api/store-attachment path verifies the agent token's tenant matches
    // the userId field in the request body, so an agent can only restore
    // attachments under its own customer's user_id.
    const workerUrl = process.env.MYA_WORKER_URL;
    const workerSecret = process.env.AGENT_TOKEN;
    stats.attachments = await restoreAttachments(db, targetUserId, manifest.attachments?.data || [], zip, workerUrl, workerSecret);

    // 5. Messages
    if (manifest.messages?.data?.length) {
      const remapped = manifest.messages.data.map(m => ({ ...m, user_id: targetUserId }));
      await db.messages.insertIgnore(remapped);
      stats.messages = remapped.length;
    }

    // 6. People + contact territories
    if (manifest.contacts?.data?.length) {
      let pCount = 0;
      for (const p of manifest.contacts.data) {
        try {
          p.user_id = targetUserId;
          const cols = Object.keys(p).filter(c => p[c] !== undefined);
          await db.rawQuery(
            `INSERT OR REPLACE INTO people (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
            cols.map(c => p[c])
          );
          pCount++;
        } catch {}
      }
      stats.contacts = pCount;
    }
    stats.contactTerritories = await restoreRaw(db, null, 'contact_territories', manifest.contacts?.territoryLinks);

    // 7. Mindscape hierarchy: realms → themes → territories → theme_cards
    stats.realms = await restoreRaw(db, targetUserId, 'realms', manifest.mindscape?.realms);
    stats.semanticThemes = await restoreRaw(db, targetUserId, 'semantic_themes', manifest.mindscape?.semanticThemes);
    stats.territories = await restoreRaw(db, targetUserId, 'territory_profiles', manifest.mindscape?.territories);
    stats.themeCards = await restoreRaw(db, targetUserId, 'theme_cards', manifest.mindscape?.themeCards);

    // 8. Clustering points with nomic embeddings
    stats.clusteringPoints = await restoreClusteringPoints(
      db, targetUserId,
      manifest.mindscape?.clusteringPoints?.data,
      manifest.mindscape?.nomicEmbeddings?.data
    );

    // 9. Topology
    stats.clusterEvents = await restoreRaw(db, null, 'cluster_events', manifest.mindscape?.clusterEvents);
    stats.cofiring = await restoreRaw(db, targetUserId, 'territory_cofire', manifest.topology?.cofiring);
    stats.territoryNeighbors = await restoreRaw(db, targetUserId, 'territory_neighbors', manifest.topology?.territoryNeighbors);
    stats.realmNeighbors = await restoreRaw(db, targetUserId, 'realm_neighbors', manifest.topology?.realmNeighbors);

    // 10. Health + Activity
    stats.health = await restoreRaw(db, targetUserId, 'health_daily', manifest.health);
    stats.activitySessions = await restoreRaw(db, null, 'activity_sessions', manifest.activity?.sessions);
    stats.activityDaily = await restoreRaw(db, null, 'activity_daily', manifest.activity?.daily);

    // 11. Wealth
    stats.wealthAssets = await restoreRaw(db, null, 'wealth_assets', manifest.wealth?.assets);
    stats.wealthPortfolios = await restoreRaw(db, targetUserId, 'wealth_portfolios', manifest.wealth?.portfolios);
    stats.wealthPositions = await restoreRaw(db, null, 'wealth_positions', manifest.wealth?.positions);
    stats.wealthTransactions = await restoreRaw(db, null, 'wealth_transactions', manifest.wealth?.transactions);
    stats.wealthSnapshots = await restoreRaw(db, null, 'wealth_snapshots', manifest.wealth?.snapshots);
    stats.wealthWatchlist = await restoreRaw(db, targetUserId, 'wealth_watchlist', manifest.wealth?.watchlist);
    stats.wealthWallets = await restoreRaw(db, targetUserId, 'wealth_wallets', manifest.wealthExtra?.wallets);
    stats.wealthPortfolioAccess = await restoreRaw(db, null, 'wealth_portfolio_access', manifest.wealthExtra?.portfolioAccess);

    // 12. Canvases
    stats.canvasWorkspaces = await restoreRaw(db, targetUserId, 'canvas_workspaces', manifest.canvases?.workspaces);
    stats.canvasNodes = await restoreRaw(db, null, 'canvas_nodes', manifest.canvases?.nodes);
    stats.canvasEdges = await restoreRaw(db, null, 'canvas_edges', manifest.canvases?.edges);
    stats.canvasCollaborators = await restoreRaw(db, null, 'canvas_collaborators', manifest.canvases?.collaborators);

    // 13. Tasks + model
    stats.agentTasks = await restoreRaw(db, targetUserId, 'agent_tasks', manifest.tasks?.agentTasks);
    stats.personalTasks = await restoreRaw(db, targetUserId, 'tasks', manifest.tasks?.personalTasks);
    stats.internalModel = await restoreRaw(db, targetUserId, 'internal_model_items', manifest.internalModel);
    stats.reflections = await restoreRaw(db, targetUserId, 'reflections', manifest.reflections);

    // 14. Identity + config
    if (manifest.user?.profile) {
      await restoreRaw(db, targetUserId, 'user_profiles', [manifest.user.profile]);
    }
    stats.identities = await restoreRaw(db, targetUserId, 'user_identities', manifest.user?.identities);
    stats.aiProviders = await restoreRaw(db, targetUserId, 'ai_providers', manifest.aiProviders);
    stats.scheduledEvents = await restoreRaw(db, targetUserId, 'scheduled_events', manifest.scheduledEvents);

    // 15. Social + audit
    stats.connections = await restoreRaw(db, null, 'connections', manifest.connections);
    stats.shareLinks = await restoreRaw(db, null, 'share_links', manifest.documents_meta?.shareLinks);
    stats.accessGrants = await restoreRaw(db, targetUserId, 'access_grants', manifest.documents_meta?.accessGrants);
    stats.agentEvents = await restoreRaw(db, null, 'agent_events', manifest.agentEvents?.data);
    stats.cycleMetrics = await restoreRaw(db, targetUserId, 'cycle_metrics', manifest.cycleMetrics);

    // 16. Agent filesystem (memory, mind, heartbeats, prompts)
    stats.agentFiles = await restoreAgentFiles(zip);

    console.log(`[Import] Vault restore complete:`, JSON.stringify(stats));
    logEvent('security.import_completed', { userId: targetUserId, ip: req.ip, stats });

    res.json({ ok: true, version: manifest.version, stats });
  } catch (e) {
    console.error('[Import] Vault restore failed:', e?.message || e);
    logEvent('security.import_failed', { userId: 'unknown', ip: req.ip, reason: e?.message });
    res.status(500).json({ error: 'Vault restore failed: ' + (e?.message || 'unknown error') });
  }
});

// -- Portal: Import (batch insert from browser-parsed data) --

app.post('/portal/import/messages', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const { messages } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array required' });
    }
    if (messages.length > 100) {
      return res.status(400).json({ error: 'Max 100 messages per batch' });
    }

    let count = 0;
    for (const msg of messages) {
      try {
        await db.messages.insert({
          id: msg.id || crypto.randomUUID(),
          user_id: user.id,
          role: msg.role === 'user' ? 'user' : 'assistant',
          content: msg.content || '',
          message_type: 'text',
          source: msg.source || 'import',
          metadata: typeof msg.metadata === 'string' ? msg.metadata : JSON.stringify(msg.metadata || {}),
          created_at: msg.created_at || new Date().toISOString(),
        });
        count++;
      } catch { /* INSERT OR IGNORE — skip duplicates */ }
    }

    res.json({ ok: true, count });
  } catch (e) {
    console.error('[Portal] Import messages failed:', e?.message || e);
    res.status(500).json({ error: 'Import failed' });
  }
});

app.post('/portal/import/documents', async (req, res) => {
  try {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db = tryGetDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const { documents } = req.body;
    if (!Array.isArray(documents) || documents.length === 0) {
      return res.status(400).json({ error: 'documents array required' });
    }
    if (documents.length > 100) {
      return res.status(400).json({ error: 'Max 100 documents per batch' });
    }

    let count = 0;
    for (const doc of documents) {
      try {
        await db.documents.upsert({
          id: doc.id || crypto.randomUUID(),
          user_id: user.id,
          path: doc.path || '',
          title: doc.title || '',
          content: doc.content || '',
          source_type: doc.source_type || 'import',
          created_by: doc.created_by || 'user',
          created_at: doc.created_at || new Date().toISOString(),
          updated_at: doc.updated_at || new Date().toISOString(),
        });
        count++;
      } catch { /* skip errors */ }
    }

    res.json({ ok: true, count });
  } catch (e) {
    console.error('[Portal] Import documents failed:', e?.message || e);
    res.status(500).json({ error: 'Import failed' });
  }
});

// ============================================
// Portal: Static File Serving
// ============================================

// Load spore routes (user-land extensions from spores/).
// Opt-in: SPORES_ENABLED=1 is required. Spores are a new attack surface
// (arbitrary user code mounted under /portal/<spore>/*), so disabled by default.
if (process.env.SPORES_ENABLED === '1') {
  try {
    const { loadSporeRoutes } = await import('./spores/loader.js');
    await loadSporeRoutes(app);
  } catch (err) {
    console.warn(`[Spore-loader] Failed to load spores: ${err.message}`);
  }
}

// Serve the portal build directory (SvelteKit adapter-static output)
const PORTAL_BUILD = path.join(__dirname, 'portal', 'build');
try {
  const stat = await fs.stat(PORTAL_BUILD);
  if (stat.isDirectory()) {
    // Hashed assets are immutable (content-addressed filenames)
    app.use('/_app/immutable', express.static(path.join(PORTAL_BUILD, '_app', 'immutable'), {
      maxAge: '1y',
      immutable: true,
    }));
    app.use(express.static(PORTAL_BUILD, { maxAge: 0 }));
    // SPA fallback — serve 200.html for non-API GET requests (client-side routing)
    // Express 5 requires named wildcard params (not bare *)
    const API_PREFIXES = ['/chat/', '/auth/', '/portal/', '/health', '/think', '/info', '/status', '/discord/', '/.well-known/', '/wake-cycles'];
    app.get('/{*path}', (req, res, next) => {
      if (API_PREFIXES.some(p => req.path.startsWith(p))) return next();
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.set('Pragma', 'no-cache');
      res.sendFile(path.join(PORTAL_BUILD, '200.html'));
    });
    console.log(`[${LOG_PREFIX} Agent] Portal: serving from ${PORTAL_BUILD}`);
  }
} catch (portalErr) {
  // Portal build directory doesn't exist — that's fine, portal is optional
  console.log(`[${LOG_PREFIX} Agent] Portal: not found at ${PORTAL_BUILD} (${portalErr?.code || portalErr?.message || 'unknown error'})`);
}

// ============================================
// Start Server
// ============================================

// SECURITY: bind to loopback only. Reject 0.0.0.0 / public binding even via
// env override in production (NODE_ENV=production). Override only allowed in
// dev for explicit testing.
let BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
if (process.env.NODE_ENV === 'production' && BIND_HOST !== '127.0.0.1' && BIND_HOST !== '::1' && BIND_HOST !== 'localhost') {
  console.error(`[${LOG_PREFIX}] FATAL: BIND_HOST=${BIND_HOST} not allowed in production. Must be loopback.`);
  process.exit(1);
}
const server = app.listen(PORT, BIND_HOST, async () => {
  // Initialize runtime context
  await initRuntime();

  // Check if this is a first-run (no users) — generate setup token
  await checkFirstRun();

  // Verify tenant identity for managed instances
  await verifyTenantIdentity();

  console.log(`[${LOG_PREFIX} Agent] Server running on ${BIND_HOST}:${PORT}`);
  console.log(`[${LOG_PREFIX} Agent] Agent ID: ${AGENT_ID}`);
  console.log(`[${LOG_PREFIX} Agent] Root directory: ${paths.root}`);
  console.log(`[${LOG_PREFIX} Agent] Git repository: ${paths.repo}`);
  console.log(`[${LOG_PREFIX} Agent] State file: ${paths.state}`);
  console.log(`[${LOG_PREFIX} Agent] Discord channel: ${DISCORD_CHANNEL || 'not configured'}`);
  console.log(`[${LOG_PREFIX} Agent] Search: ${tryGetDb() && MYA_WORKER_SECRET ? 'enabled' : 'disabled (missing credentials)'}`);
  console.log(`[${LOG_PREFIX} Agent] Timeouts: chat=${TIMEOUTS.chat/1000}s, think=${TIMEOUTS.think/1000}s, research=${TIMEOUTS.research/1000}s`);
  console.log(`[${LOG_PREFIX} Agent] Agent card: http://127.0.0.1:${PORT}/.well-known/agent.json`);

  // Check Claude CLI availability
  console.log(`[${LOG_PREFIX} Agent] Claude CLI: ${CLAUDE_BIN}`);
  try {
    execFileSync(CLAUDE_BIN, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`[${LOG_PREFIX} Agent] Claude CLI: ✓ available`);
  } catch (e) {
    console.error(`[${LOG_PREFIX} Agent] Claude CLI: ✗ NOT FOUND at ${CLAUDE_BIN}`);
    console.error(`[${LOG_PREFIX} Agent] Set CLAUDE_BIN env var to the correct path (try: which claude)`);
  }

  console.log(`[${LOG_PREFIX} Agent] Cross-instance: via Discord @mentions in #agent-collab`);

  console.log(`[${LOG_PREFIX} Agent] Endpoints:`);
  console.log('  GET  /.well-known/agent.json - Agent card (A2A compatible)');
  console.log('  POST /chat           - Discord bot integration');
  console.log('  POST /think          - Autonomous awakening');
  console.log('  POST /search         - Memory search (semantic + FTS)');
  console.log('  POST /discord/send   - Proactive messaging');
  console.log('  POST /collab/send    - Inter-agent communication');
  console.log('  GET  /autonomous/state - Rate limit status');
  console.log('  GET  /wake-cycles    - List scheduled wake cycles');
  console.log('  GET  /continuations  - Continuation diagnostics');
  console.log('  GET  /health         - Health check with state info');

  // Refresh secrets from centralized API every 5 minutes
  setInterval(refreshSecrets, 5 * 60 * 1000);

  // Log startup event
  eventLog.wakeStart(AGENT_ID, 'server_startup');
  addActivity('status', `Server started on port ${PORT}`, {
    type: 'startup',
    agentId: AGENT_ID,
    features: ['chat', 'think', 'discord', 'search', 'session-resume', 'agent-card', 'wake-cycles']
  });

  // Recover from any interrupted tasks (restart sentinel pattern)
  await recoverFromCheckpoint();

  // Pre-load wake cycles cache
  await getWakeCycles();

  // Start continuation scanner (picks up deferred rate-limit continuations)
  setInterval(scanContinuations, CONTINUATION_CONFIG.scanIntervalMs);
  console.log(`[${LOG_PREFIX} Agent] Continuation scanner: every ${CONTINUATION_CONFIG.scanIntervalMs / 1000}s`);

  // ── Gmail Poller ───────────────────────────────────────────────────
  // Checks for unread emails and triggers /think when new ones arrive.
  // Enable per-agent via GMAIL_POLL_ENABLED=true in ecosystem.config.cjs.
  if (process.env.GMAIL_POLL_ENABLED === 'true') {
    try {
      const { createGoogleAuth } = await import('./lib/services/google-auth.js');
      const gmailAuth = createGoogleAuth();

      if (gmailAuth.isConfigured()) {
        const pollMinutes = parseInt(process.env.GMAIL_POLL_INTERVAL_MINUTES) || 5;
        const pollInterval = pollMinutes * 60 * 1000;
        const SEEN_CAP = 1000;
        const seenIds = new Set();
        const stateDir = path.join(paths.root, '.google-state');
        const stateFile = path.join(stateDir, 'seen-emails.json');

        // Load persisted seen IDs
        try {
          const raw = await fs.readFile(stateFile, 'utf-8');
          const ids = JSON.parse(raw);
          if (Array.isArray(ids)) ids.slice(-SEEN_CAP).forEach(id => seenIds.add(id));
        } catch { /* no state file yet */ }

        const persistSeen = async () => {
          try {
            await fs.mkdir(stateDir, { recursive: true });
            const ids = [...seenIds].slice(-SEEN_CAP);
            await fs.writeFile(stateFile, JSON.stringify(ids));
          } catch { /* non-fatal */ }
        };

        // Import gmail plugin (already registered via side-effect import)
        await import('./lib/services/gmail-plugin.js');
        const { getPlugin } = await import('./lib/services/service-plugin.js');
        const gmail = getPlugin('gmail');

        setInterval(async () => {
          try {
            const result = await gmail.execute('unread', { maxResults: 10 });
            if (!result.success || !result.data?.length) return;

            const newEmails = result.data.filter(m => !seenIds.has(m.id));
            if (newEmails.length === 0) return;

            // Track seen IDs, evict oldest if over cap
            newEmails.forEach(m => seenIds.add(m.id));
            if (seenIds.size > SEEN_CAP) {
              const arr = [...seenIds];
              arr.slice(0, arr.length - SEEN_CAP).forEach(id => seenIds.delete(id));
            }
            await persistSeen();

            const summary = newEmails.map((m, i) =>
              `${i + 1}. From: ${m.from} — "${m.subject}" (${m.snippet?.slice(0, 80)}...)`
            ).join('\n');

            // Trigger agent think cycle
            const gmailHeaders = { 'Content-Type': 'application/json' };
            if (process.env.AGENT_INTERNAL_SECRET) gmailHeaders['x-internal-secret'] = process.env.AGENT_INTERNAL_SECRET;
            await fetch(`http://localhost:${PORT}/think`, {
              method: 'POST',
              headers: gmailHeaders,
              body: JSON.stringify({
                prompt: `You have ${newEmails.length} new email${newEmails.length > 1 ? 's' : ''}:\n${summary}\n\nReview these and decide what needs your attention. Use the gmail tool to read full content.`,
                trigger: 'gmail-incoming',
              }),
            });

            console.log(`[${LOG_PREFIX} Gmail] ${newEmails.length} new email(s) → triggered /think`);
          } catch (err) {
            console.error(`[${LOG_PREFIX} Gmail] Poll error:`, err.message);
          }
        }, pollInterval);

        console.log(`[${LOG_PREFIX} Agent] Gmail poller: every ${pollMinutes} min`);
      } else {
        console.log(`[${LOG_PREFIX} Agent] Gmail poller: enabled but Google auth not configured`);
      }
    } catch (err) {
      console.error(`[${LOG_PREFIX} Agent] Gmail poller init failed:`, err.message);
    }
  }

  // ── Sentry Error Poller ──────────────────────────────────────────────
  // Checks for new unresolved Sentry issues and triggers /think so the
  // agent can investigate, fix, and report.  Enable per-agent via
  // SENTRY_POLL_ENABLED=true in ecosystem.config.cjs.
  if (process.env.SENTRY_POLL_ENABLED === 'true') {
    const sentryToken = process.env.SENTRY_AUTH_TOKEN;
    const sentryOrg = process.env.SENTRY_ORG;
    const sentryProject = process.env.SENTRY_PROJECT;
    const sentryApiBase = process.env.SENTRY_API_BASE || 'https://de.sentry.io';
    const reportsChannel = process.env.DISCORD_BUG_REPORTS_CHANNEL || process.env.DISCORD_REPORTS_CHANNEL;

    if (sentryToken && sentryOrg && sentryProject) {
      const pollMinutes = parseInt(process.env.SENTRY_POLL_INTERVAL_MINUTES) || 5;
      const pollInterval = pollMinutes * 60 * 1000;
      const SEEN_CAP = 500;
      const seenIssueIds = new Set();
      const stateDir = path.join(paths.root, '.sentry-state');
      const stateFile = path.join(stateDir, 'seen-issues.json');

      // Load persisted seen IDs
      try {
        const raw = await fs.readFile(stateFile, 'utf-8');
        const ids = JSON.parse(raw);
        if (Array.isArray(ids)) ids.slice(-SEEN_CAP).forEach(id => seenIssueIds.add(id));
      } catch { /* no state file yet */ }

      const persistSeen = async () => {
        try {
          await fs.mkdir(stateDir, { recursive: true });
          const ids = [...seenIssueIds].slice(-SEEN_CAP);
          await fs.writeFile(stateFile, JSON.stringify(ids));
        } catch { /* non-fatal */ }
      };

      /** Fetch latest event for an issue to get stacktrace context */
      async function fetchLatestEvent(issueId) {
        try {
          const res = await fetch(
            `${sentryApiBase}/api/0/organizations/${sentryOrg}/issues/${issueId}/events/latest/`,
            { headers: { Authorization: `Bearer ${sentryToken}` }, signal: AbortSignal.timeout(10000) },
          );
          if (!res.ok) return null;
          const event = await res.json();

          // Extract stacktrace from exception entries
          const frames = event.entries
            ?.find(e => e.type === 'exception')
            ?.data?.values?.[0]?.stacktrace?.frames;
          if (!frames?.length) return null;

          // Return last 8 frames (most relevant), formatted
          return frames.slice(-8).map(f =>
            `  ${f.filename || '?'}:${f.lineNo || '?'} in ${f.function || '?'}`
          ).join('\n');
        } catch {
          return null;
        }
      }

      setInterval(async () => {
        try {
          const url = `${sentryApiBase}/api/0/projects/${sentryOrg}/${sentryProject}/issues/?query=is:unresolved&statsPeriod=1h&sort=date`;
          const res = await fetch(url, {
            headers: { Authorization: `Bearer ${sentryToken}` },
            signal: AbortSignal.timeout(15000),
          });
          if (!res.ok) {
            console.error(`[${LOG_PREFIX} Sentry] API error: ${res.status} ${res.statusText}`);
            return;
          }

          const issues = await res.json();
          if (!Array.isArray(issues) || issues.length === 0) return;

          const newIssues = issues.filter(i => !seenIssueIds.has(i.id));
          if (newIssues.length === 0) return;

          // Mark as seen
          newIssues.forEach(i => seenIssueIds.add(i.id));
          if (seenIssueIds.size > SEEN_CAP) {
            const arr = [...seenIssueIds];
            arr.slice(0, arr.length - SEEN_CAP).forEach(id => seenIssueIds.delete(id));
          }
          await persistSeen();

          // Build context for each issue, then generate test-gated fix prompt
          const issueData = await Promise.all(newIssues.map(async (issue) => {
            const stacktrace = await fetchLatestEvent(issue.id);
            const tags = issue.tags?.map(t => `${t.key}=${t.value}`).join(', ') || 'none';
            return {
              title: issue.title,
              level: issue.level,
              count: issue.count,
              userCount: issue.userCount,
              culprit: issue.culprit,
              firstSeen: issue.firstSeen,
              lastSeen: issue.lastSeen,
              tags,
              stacktrace,
              sentryLink: `${sentryApiBase}/organizations/${sentryOrg}/issues/${issue.id}/`,
            };
          }));

          const prompt = buildSentryFixPrompt(issueData, {
            reportsChannelId: reportsChannel,
            agentPort: PORT,
            repoCwd: paths.repo,
          });

          const sentryHeaders = { 'Content-Type': 'application/json' };
          if (process.env.AGENT_INTERNAL_SECRET) sentryHeaders['x-internal-secret'] = process.env.AGENT_INTERNAL_SECRET;
          await fetch(`http://localhost:${PORT}/think`, {
            method: 'POST',
            headers: sentryHeaders,
            body: JSON.stringify({ prompt, trigger: 'sentry-error' }),
          });

          console.log(`[${LOG_PREFIX} Sentry] ${newIssues.length} new issue(s) → triggered /think`);
        } catch (err) {
          console.error(`[${LOG_PREFIX} Sentry] Poll error:`, err.message);
        }
      }, pollInterval);

      console.log(`[${LOG_PREFIX} Agent] Sentry poller: every ${pollMinutes} min (org: ${sentryOrg}, project: ${sentryProject})`);
    } else {
      const missing = [!sentryToken && 'SENTRY_AUTH_TOKEN', !sentryOrg && 'SENTRY_ORG', !sentryProject && 'SENTRY_PROJECT'].filter(Boolean);
      console.log(`[${LOG_PREFIX} Agent] Sentry poller: enabled but missing ${missing.join(', ')}`);
    }
  }
});

// Node.js 22 defaults requestTimeout to 5 minutes, which kills long-running
// Claude requests. Set to 70 minutes (above the 60-min Claude timeout).
server.requestTimeout = 70 * 60 * 1000;
server.headersTimeout = 70 * 60 * 1000;
server.timeout = 0; // no idle timeout (already the default)

// ── Encrypted Portal Channel (Phase 1) ──────────────────────────────────────
// Mounts a WebSocket server at /ws/secure that wraps all portal API calls
// in a Noise_NK_25519_ChaChaPoly_BLAKE2s encrypted channel. Cloudflare sees
// only encrypted binary frames — no plaintext JSON, no readable bodies.
if (process.env.SECURE_CHANNEL_ENABLED === '1' || process.env.SECURE_CHANNEL_ENABLED === 'true') {
  (async () => {
    try {
      const { loadIdentity } = await import('./lib/vps-identity.js');
      const identity = await loadIdentity();
      if (!identity) {
        console.warn(`[${LOG_PREFIX}] Encrypted portal channel: DISABLED (no VPS identity keys at /run/mycelium/vps-noise.key)`);
        return;
      }

      const { setupSecureChannel } = await import('./lib/portal-channel.js');

      // ── Helper: require db or throw ──
      function requireDb() {
        const db = tryGetDb();
        if (!db) throw Object.assign(new Error('Database not available'), { status: 503 });
        return db;
      }

      // ── Helper: enrich messages with attachment data ──
      async function enrichMessagesWithAttachments(db, messages) {
        const ids = messages.filter(m => m.attachment_id).map(m => m.attachment_id);
        if (ids.length === 0) return messages;
        const map = {};
        try {
          const attachments = await db.attachments.getByIds(ids);
          for (const a of attachments) {
            const type = a.file_type || (a.r2_key?.includes('/voice/') ? 'voice'
              : a.r2_key?.includes('/image/') ? 'image'
              : a.r2_key?.includes('/video/') ? 'video' : 'file');
            map[a.id] = { id: a.id, type, url: `/portal/attachment/${a.id}`,
              filename: a.file_name || null, fileSize: a.file_size || null,
              transcript: a.transcript || null, description: a.description || null };
          }
        } catch { /* attachment enrichment is optional */ }
        return messages.map(m => m.attachment_id && map[m.attachment_id]
          ? { ...m, attachment: map[m.attachment_id] } : m);
      }

      // ── Route map: channel message type → async (data, user) → result ──
      const routes = {
        // Messages
        'messages': async (data, user) => {
          const db = requireDb();
          const limit = Math.min(200, Math.max(1, parseInt(data.limit, 10) || 50));
          const messages = await db.messages.selectTimeline(user.id, { limit, before: data.before });
          return { messages: await enrichMessagesWithAttachments(db, messages) };
        },
        'chat-history': async (data, user) => {
          const db = requireDb();
          const limit = Math.min(200, Math.max(1, parseInt(data.limit, 10) || 50));
          const agentId = data.agentId || undefined;
          const messages = await db.messages.selectRecent(user.id, { limit, agentId });
          const enriched = await enrichMessagesWithAttachments(db, messages);
          return { messages: enriched.map(m => ({
            id: String(m.id), role: m.role, content: m.content,
            timestamp: new Date(m.created_at).getTime(), source: m.source,
            ...(m.attachment ? { attachment: m.attachment } : {}),
          })).reverse() };
        },

        // Documents
        'documents-list': async (data, user) => {
          const db = requireDb();
          const docs = await db.documents.list(user.id, {
            category: data.category || null, folderId: data.folder_id || null,
            pinnedOnly: data.pinned === '1',
          });
          return { documents: docs };
        },
        'document-detail': async (data, user) => {
          const db = requireDb();
          const doc = await db.documents.get(user.id, data.documentId || data.path);
          if (!doc) throw Object.assign(new Error('Document not found'), { status: 404 });
          return { document: doc };
        },
        'documents-create': async (data, user) => {
          const db = requireDb();
          const { path: docPath, content, title, category, folder_id } = data;
          if (!docPath) throw Object.assign(new Error('Path required'), { status: 400 });
          const result = await db.documents.upsert(user.id, {
            path: docPath, content: content || '', title: title || docPath.split('/').pop(),
            category: category || 'general', folder_id: folder_id || null,
            created_by: AGENT_ID,
          });
          return { document: result };
        },
        'document-update': async (data, user) => {
          const db = requireDb();
          const { documentId, content, title } = data;
          if (!documentId) throw Object.assign(new Error('Document ID required'), { status: 400 });
          await db.documents.update(user.id, documentId, { content, title });
          return { ok: true };
        },

        // Folders
        'folders': async (_data, user) => {
          const db = requireDb();
          return { folders: await db.documents.listFolders(user.id) };
        },

        // Profile
        'profile': async (_data, user) => {
          const db = requireDb();
          const profile = await db.users.getById(user.id);
          return profile || {};
        },
        'profile-update': async (data, user) => {
          const db = requireDb();
          const { display_name, timezone, settings } = data;
          await db.users.update(user.id, { display_name, timezone, settings });
          return { ok: true };
        },

        // Activity
        'activity-today': async (_data, user) => {
          const db = requireDb();
          return { activities: await db.activity.getToday(user.id) };
        },
        'activity-summary': async (data, user) => {
          const db = requireDb();
          const days = Math.min(90, Math.max(1, parseInt(data.days, 10) || 7));
          return { summary: await db.activity.getSummary(user.id, days) };
        },
        'activity-range': async (data, user) => {
          const db = requireDb();
          return { activities: await db.activity.getRange(user.id, data.start, data.end) };
        },

        // Mindscape
        'mindscape': async (_data, user) => {
          const db = requireDb();
          const [points, territories, realms] = await Promise.all([
            db.clusteringPoints.getAll(user.id),
            db.clusteringPoints.getTerritories(user.id),
            db.clusteringPoints.getRealms(user.id),
          ]);
          return { points, territories, realms };
        },
        'mindscape-social': async (data, user) => {
          const db = requireDb();
          const tier = data.tier || null;
          const contacts = await db.people.list(user.id, { tier });
          return { contacts };
        },
        'mindscape-social-detail': async (data, user) => {
          const db = requireDb();
          const contact = await db.people.getById(user.id, data.contactId);
          if (!contact) throw Object.assign(new Error('Contact not found'), { status: 404 });
          const messages = await db.people.getMessages(user.id, data.contactId, { limit: 50 });
          return { contact, messages };
        },
        'mindscape-growth': async (data, user) => {
          const db = requireDb();
          const events = await db.clusterEvents.getRecent(user.id, parseInt(data.limit, 10) || 100);
          return { events };
        },
        'mindscape-growth-summary': async (_data, user) => {
          const db = requireDb();
          return { summary: await db.clusterEvents.getSummary(user.id) };
        },
        'mindscape-realms': async (_data, user) => {
          const db = requireDb();
          return { realms: await db.clusteringPoints.getRealms(user.id) };
        },

        // Wealth — method names match lib/db-d1.js wealth namespace
        'wealth-portfolios': async (_data, user) => {
          const db = requireDb();
          return { portfolios: await db.wealth.listPortfolios(user.id) };
        },
        'wealth-create-portfolio': async (data, user) => {
          const db = requireDb();
          const { name, baseCurrency, type } = data;
          if (!name) throw Object.assign(new Error('Portfolio name required'), { status: 400 });
          const portfolio = await db.wealth.createPortfolio(user.id, name, baseCurrency || 'EUR', type || 'personal');
          return { portfolio };
        },
        'wealth-portfolio-detail': async (data, user) => {
          const db = requireDb();
          const p = await db.wealth.getPortfolio(data.portfolioId, user.id);
          if (!p) throw Object.assign(new Error('Portfolio not found'), { status: 404 });
          return { portfolio: p };
        },
        'wealth-positions': async (data, user) => {
          const db = requireDb();
          const portfolio = await db.wealth.getPortfolio(data.portfolioId, user.id);
          if (!portfolio) throw Object.assign(new Error('Portfolio not found'), { status: 404 });
          return { positions: await db.wealth.getPositions(data.portfolioId) };
        },
        'wealth-transactions': async (data, user) => {
          const db = requireDb();
          const portfolio = await db.wealth.getPortfolio(data.portfolioId, user.id);
          if (!portfolio) throw Object.assign(new Error('Portfolio not found'), { status: 404 });
          return { transactions: await db.wealth.listTransactions(data.portfolioId, {
            limit: parseInt(data.limit, 10) || 100,
          }) };
        },
        'wealth-performance': async (data, user) => {
          const db = requireDb();
          const portfolio = await db.wealth.getPortfolio(data.portfolioId, user.id);
          if (!portfolio) throw Object.assign(new Error('Portfolio not found'), { status: 404 });
          const snapshots = await db.wealth.getSnapshots(data.portfolioId, {
            from: data.from, to: data.to,
          });
          return { performance: snapshots };
        },
        'wealth-watchlist': async (_data, user) => {
          const db = requireDb();
          return { watchlist: await db.wealth.getWatchlist(user.id) };
        },
        'wealth-assets': async (data, _user) => {
          const db = requireDb();
          if (data.query) {
            return { assets: await db.wealth.findAssets(data.query) };
          }
          return { assets: [] };
        },

        // Connections
        'connections': async (_data, user) => {
          const db = requireDb();
          return { connections: await db.connections.list(user.id) };
        },
        'connections-count': async (_data, user) => {
          const db = requireDb();
          return await db.connections.count(user.id);
        },
        'connections-pending': async (_data, user) => {
          const db = requireDb();
          return { pending: await db.connections.pending(user.id) };
        },
        'connection-request': async (data, user) => {
          const db = requireDb();
          const handle = (data.toHandle || '').replace(/^@/, '').trim();
          if (!handle) throw Object.assign(new Error('Handle required'), { status: 400 });
          return await db.connections.request(user.id, handle);
        },
        'connection-accept': async (data, user) => {
          const db = requireDb();
          return await db.connections.accept(user.id, data.connectionId);
        },
        'connection-reject': async (data, user) => {
          const db = requireDb();
          return await db.connections.reject(user.id, data.connectionId);
        },
        'connection-block': async (data, user) => {
          const db = requireDb();
          return await db.connections.block(user.id, data.connectionId);
        },
        'connection-delete': async (data, user) => {
          const db = requireDb();
          return await db.connections.disconnect(user.id, data.connectionId);
        },
        'connection-overlap': async (data, user) => {
          const db = requireDb();
          return await db.connections.getOverlap(user.id, data.connectionId);
        },

        // Contexts
        'contexts': async (_data, user) => {
          const db = requireDb();
          return { contexts: await db.contexts.list(user.id) };
        },
        'context-create': async (data, user) => {
          const db = requireDb();
          if (!data.name) throw Object.assign(new Error('Name required'), { status: 400 });
          return await db.contexts.create(user.id, { name: data.name, is_private: data.is_private });
        },
        'context-update': async (data, user) => {
          const db = requireDb();
          return await db.contexts.rename(user.id, data.contextId, data.name);
        },
        'context-delete': async (data, user) => {
          const db = requireDb();
          return await db.contexts.remove(user.id, data.contextId);
        },
        'context-add-territory': async (data, _user) => {
          const db = requireDb();
          return await db.contexts.addTerritory(data.contextId, parseInt(data.territoryId));
        },
        'context-remove-territory': async (data, _user) => {
          const db = requireDb();
          return await db.contexts.removeTerritory(data.contextId, parseInt(data.territoryId));
        },
        'context-grant-access': async (data, _user) => {
          const db = requireDb();
          return await db.contexts.grant(data.contextId, data.connectionId);
        },
        'context-revoke-access': async (data, _user) => {
          const db = requireDb();
          return await db.contexts.revoke(data.contextId, data.connectionId);
        },
        'context-territories': async (data, _user) => {
          const db = requireDb();
          return { territories: await db.contexts.getTerritories(data.contextId) };
        },
        'context-connections': async (data, _user) => {
          const db = requireDb();
          return { connections: await db.contexts.getConnections(data.contextId) };
        },

        // Documents — write operations
        'documents-move': async (data, user) => {
          const db = requireDb();
          await db.documents.moveToFolder(user.id, data.path, data.folder_id || null);
          return { ok: true };
        },
        'documents-pin': async (data, user) => {
          const db = requireDb();
          if (data.pinned) await db.documents.pin(user.id, data.path);
          else await db.documents.unpin(user.id, data.path);
          return { ok: true };
        },
        'document-delete': async (data, user) => {
          const db = requireDb();
          await db.documents.delete(user.id, data.documentId || data.path);
          return { ok: true };
        },

        // Folders — write operations
        'folder-create': async (data, user) => {
          const db = requireDb();
          if (!data.name?.trim()) throw Object.assign(new Error('Name required'), { status: 400 });
          return await db.folders.create(user.id, data.name.trim(), data.parent_id || null);
        },
        'folder-update': async (data, user) => {
          const db = requireDb();
          if (!data.name?.trim()) throw Object.assign(new Error('Name required'), { status: 400 });
          return await db.folders.rename(user.id, data.folderId, data.name.trim());
        },
        'folder-delete': async (data, user) => {
          const db = requireDb();
          return await db.folders.delete(user.id, data.folderId);
        },

        // Attachments
        'attachments': async (data, user) => {
          const db = requireDb();
          const limit = Math.min(200, Math.max(1, parseInt(data.limit, 10) || 50));
          const type = data.type || null;
          return { attachments: await db.attachments.list(user.id, { limit, type }) };
        },
        'attachment-update': async (data, user) => {
          const db = requireDb();
          const att = await db.attachments.get(data.attachmentId);
          if (!att || att.user_id !== user.id) throw Object.assign(new Error('Not found'), { status: 404 });
          await db.attachments.update(data.attachmentId, { description: data.description });
          return { ok: true };
        },
        'attachment-delete': async (data, user) => {
          const db = requireDb();
          await db.attachments.delete(data.attachmentId, user.id);
          return { ok: true };
        },

        // Wealth — write operations
        'wealth-delete-portfolio': async (data, user) => {
          const db = requireDb();
          await db.wealth.deletePortfolio(data.portfolioId, user.id);
          return { ok: true };
        },
        'wealth-add-transaction': async (data, user) => {
          const db = requireDb();
          const p = await db.wealth.getPortfolio(data.portfolioId, user.id);
          if (!p) throw Object.assign(new Error('Portfolio not found'), { status: 404 });
          const asset = await db.wealth.upsertAsset({
            symbol: data.symbol, name: data.assetName, type: data.assetType,
            currency: data.currency,
          });
          const tx = await db.wealth.addTransaction({
            portfolio_id: data.portfolioId, asset_id: asset.id,
            type: data.type, quantity: data.quantity,
            price_per_unit: data.pricePerUnit, date: data.date,
            exchange_rate: data.exchangeRate, fees: data.fees, notes: data.notes,
          });
          await db.wealth.recalculatePosition(data.portfolioId, asset.id);
          return { transaction: tx };
        },
        'wealth-delete-transaction': async (data, user) => {
          const db = requireDb();
          const tx = await db.wealth.getTransaction(data.transactionId);
          if (!tx) throw Object.assign(new Error('Transaction not found'), { status: 404 });
          const p = await db.wealth.getPortfolio(tx.portfolio_id, user.id);
          if (!p) throw Object.assign(new Error('Not authorized'), { status: 403 });
          await db.wealth.deleteTransaction(data.transactionId);
          await db.wealth.recalculatePosition(tx.portfolio_id, tx.asset_id);
          return { ok: true };
        },

        // Mindscape write
        'mindscape-territory-visibility': async (data, user) => {
          const db = requireDb();
          await db.clusteringPoints.setTerritoryVisibility(user.id, data.territoryId, data.visibility);
          return { ok: true };
        },

        // Profile
        'profile-recompute': async (_data, user) => {
          const db = requireDb();
          await db.profiles.computeFingerprint(user.id);
          return { ok: true };
        },

        // Settings
        'settings': async (_data, user) => {
          const db = requireDb();
          const u = await db.users.getById(user.id);
          return { settings: u?.settings ? JSON.parse(u.settings) : {}, timezone: u?.timezone };
        },
        'settings-update': async (data, user) => {
          const db = requireDb();
          if (data.timezone) await db.users.updateTimezone(user.id, data.timezone);
          if (data.vault_name !== undefined) {
            const u = await db.users.getById(user.id);
            const current = u?.settings ? JSON.parse(u.settings) : {};
            current.vault_name = String(data.vault_name).trim().substring(0, 60);
            await db.users.updateSettings(user.id, current);
          }
          return { ok: true };
        },

        // Health
        'health-today': async (_data, user) => {
          const db = requireDb();
          return await db.health.getToday(user.id);
        },
        'health-range': async (data, user) => {
          const db = requireDb();
          return await db.health.getRange(user.id, data.start, data.end);
        },
        'health-summary': async (data, user) => {
          const db = requireDb();
          return await db.health.getSummary(user.id, parseInt(data.days, 10) || 7);
        },
        'health-sync': async (data, user) => {
          const db = requireDb();
          if (!Array.isArray(data.days)) throw Object.assign(new Error('days array required'), { status: 400 });
          return await db.health.syncDays(user.id, data.days);
        },
      };

      // ── Streaming routes: type → async (data, user, emit) → void ──
      const streamRoutes = {
        'chat': async (data, user, emit) => {
          const { message, enableThinking, agentId, attachmentContext } = data;
          if (!message) throw Object.assign(new Error('Message required'), { status: 400 });

          // If targeting a different agent, proxy to that agent's /chat/stream
          const targetAgentId = agentId;
          if (targetAgentId && targetAgentId !== AGENT_ID && AGENT_REGISTRY[targetAgentId]) {
            const target = AGENT_REGISTRY[targetAgentId];
            const proxyBody = { message, userId: user.id, username: user.displayName || user.id,
              source: 'portal', enableThinking, attachmentContext };
            const proxyRes = await fetch(`http://localhost:${target.port}/chat/stream`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(proxyBody), signal: AbortSignal.timeout(300_000),
            });
            const reader = proxyRes.body?.getReader();
            if (!reader) return;
            const decoder = new TextDecoder();
            let buf = '';
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += decoder.decode(value, { stream: true });
              const lines = buf.split('\n');
              buf = lines.pop() || '';
              for (const line of lines) {
                if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                  try { emit(JSON.parse(line.slice(6))); } catch {}
                }
              }
            }
            return;
          }

          // Local agent — build prompt and stream via Claude CLI
          const requestTime = new Date();
          const rawPrompt = message;
          const prompt = attachmentContext ? `${attachmentContext}\n\n${rawPrompt}` : rawPrompt;
          const taskType = data.taskType || 'chat';

          emit({ type: 'stream_start', streamIndex: 0 });

          let systemPrompt = '', context = '', heartbeat = '';
          try {
            systemPrompt = await loadSystemPrompt();
            context = await fs.readFile(paths.knowledge.context, 'utf-8').catch(() => '');
            heartbeat = await fs.readFile(path.join(paths.repo, 'HEARTBEAT.md'), 'utf-8').catch(() => '');
          } catch {}

          let assembledContext = '';
          try {
            assembledContext = await assembleContext(paths.root, user.id, {
              scope: process.env.MEMORY_SCOPE || 'company', source: 'portal', agentId: AGENT_ID,
            });
          } catch {}

          const teamDirectory = await buildTeamDirectory();
          const fullPrompt = `${systemPrompt}\n\n---\n# Team Directory\n${teamDirectory}\n\n---\n# Your Current State (from autonomous work)\n${heartbeat || 'No heartbeat file found.'}\n\n---\n# Company Context\n${context}${assembledContext ? `\n${assembledContext}` : ''}\n${getWarRoomContext()}${getIntelContext()}\n---\n# Current Message\nFrom: ${user.displayName || 'Portal user'} (user ID: ${user.id}) in #portal\nMessage: ${prompt}\n\n## Important: Your response IS sent directly to the user.\n\nRespond naturally and conversationally.`;

          const laneId = `agent:${AGENT_ID}`;
          await enqueue(laneId, async () => {
            incrementActiveTask();
            try {
              const threadKey = `portal_${user.id}`;
              let existingSessionId = await getSessionForThread(paths.root, threadKey);
              let promptWithContext = fullPrompt;
              if (!existingSessionId) {
                const ctxSummary = await getContextSummary(paths.root, threadKey);
                if (ctxSummary) promptWithContext = `${fullPrompt}\n\n---\n# Previous Session Context\n${ctxSummary}\n---`;
              }

              await new Promise((resolve, reject) => {
                const args = ['--print', '--output-format', 'stream-json', '--verbose',
                  '--include-partial-messages', '--model', getModelForTask(runtime, taskType),
                  '--max-turns', String(MAX_TURNS)];
                if (existingSessionId) args.push('--resume', existingSessionId);
                args.push('--dangerously-skip-permissions');

                const claude = spawn(CLAUDE_BIN, args, {
                  cwd: paths.repo,
                  env: { ...process.env, HOME: process.env.HOME || '/home/claude' },
                  stdio: ['pipe', 'pipe', 'pipe'],
                });

                claude.stdin.on('error', () => {});
                claude.stdin.write(promptWithContext);
                claude.stdin.end();

                let sessionId = null, fullOutput = '', buffer = '';
                let currentBlockType = null, currentToolName = null;
                let inputTokens = 0, outputTokens = 0;
                const toolsUsed = [];

                const keepaliveTimer = setInterval(() => emit({ type: 'keepalive' }), 15000);
                const timeout = getTimeout('chat');
                const timeoutTimer = setTimeout(() => { claude.kill('SIGINT'); emit({ type: 'error', message: 'Request timed out' }); }, timeout);

                claude.stdout.on('data', (chunk) => {
                  buffer += chunk.toString();
                  const lines = buffer.split('\n');
                  buffer = lines.pop() || '';
                  for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                      const d = JSON.parse(line);
                      if (d.session_id) sessionId = d.session_id;
                      if (d.type === 'stream_event' && d.event) {
                        const ev = d.event;
                        if (ev.type === 'content_block_start') {
                          if (ev.content_block?.type === 'thinking') { currentBlockType = 'thinking'; emit({ type: 'thinking_start' }); }
                          else if (ev.content_block?.type === 'tool_use') { currentBlockType = 'tool_use'; currentToolName = ev.content_block.name; toolsUsed.push(currentToolName); emit({ type: 'tool_start', name: currentToolName, input: {} }); }
                          else currentBlockType = 'text';
                        } else if (ev.type === 'content_block_delta') {
                          if (ev.delta?.type === 'text_delta') { fullOutput += ev.delta.text; emit({ type: 'text_delta', content: ev.delta.text }); }
                          else if (ev.delta?.type === 'thinking_delta') emit({ type: 'thinking_delta', content: ev.delta.thinking });
                        } else if (ev.type === 'content_block_stop') {
                          if (currentBlockType === 'thinking') emit({ type: 'thinking_end', signature: '' });
                          else if (currentBlockType === 'tool_use') emit({ type: 'tool_complete', name: currentToolName || 'unknown' });
                          currentBlockType = null; currentToolName = null;
                        } else if (ev.type === 'message_delta' && ev.usage) {
                          inputTokens = ev.usage.input_tokens || inputTokens;
                          outputTokens = ev.usage.output_tokens || outputTokens;
                        }
                      } else if (d.type === 'result') {
                        sessionId = d.session_id || sessionId;
                        if (!fullOutput && d.result) fullOutput = d.result;
                      }
                    } catch {}
                  }
                });

                claude.stderr.on('data', (d) => console.error(`[${LOG_PREFIX}] WS stream stderr: ${d.toString().slice(0, 200)}`));

                claude.on('close', async (code) => {
                  clearInterval(keepaliveTimer); clearTimeout(timeoutTimer);
                  if (code !== 0 && fullOutput.length < 50) emit({ type: 'error', message: fullOutput.trim() || 'Claude exited with error' });
                  if (sessionId) {
                    await updateSessionMapping(paths.root, threadKey, sessionId, {
                      channelName: 'portal', addTokens: Math.ceil((promptWithContext.length + fullOutput.length) / 4),
                    }).catch(() => {});
                  }
                  if (user.id && fullOutput.trim() && code === 0) {
                    storeMessages(user.id, 'portal', rawPrompt, fullOutput.trim(), requestTime).catch(err => {
                      console.error(`[${LOG_PREFIX}] WS chat storeMessages failed: ${err.message}`);
                    });
                  }
                  if (inputTokens || outputTokens) emit({ type: 'usage', inputTokens, outputTokens, thinkingTokens: 0 });
                  emit({ type: 'done', toolsUsed, thinkingEnabled: false });
                  resolve({ sessionId });
                });

                claude.on('error', (err) => { clearInterval(keepaliveTimer); clearTimeout(timeoutTimer); emit({ type: 'error', message: err.message }); reject(err); });
              });
            } finally { decrementActiveTask(); }
          });
        },
      };

      // Authenticate a session token (same logic as authenticatePortalRequest but for tokens only)
      async function authenticateSession(token) {
        if (!token) return null;
        if (process.env.PORTAL_APP_TOKEN && safeCompare(token, process.env.PORTAL_APP_TOKEN)) {
          const db = tryGetDb();
          if (!db) return null;
          const raw = await db.users.getFirst();
          return raw ? { id: raw.id, displayName: raw.display_name, timezone: raw.timezone } : null;
        }
        const auth = await getAuthModule();
        return auth.validateSession(token);
      }

      setupSecureChannel(server, {
        identity,
        authenticateSession,
        routes,
        streamRoutes,
      });

      console.log(`[${LOG_PREFIX}] Encrypted portal channel: ENABLED (fingerprint: ${identity.fingerprint})`);
    } catch (err) {
      console.error(`[${LOG_PREFIX}] Encrypted portal channel: FAILED to initialize:`, err.message);
    }
  })();
} else {
  console.log(`[${LOG_PREFIX}] Encrypted portal channel: DISABLED (set SECURE_CHANNEL_ENABLED=1 to enable)`);
}

export default app;
