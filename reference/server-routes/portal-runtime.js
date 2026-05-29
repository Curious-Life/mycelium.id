/**
 * Portal runtime router (Phase 10 PR 7H).
 *
 * Agent-runtime control plane — seven handlers that agents, the
 * orchestrator, and the portal use to observe and nudge runtime state:
 *
 *   GET  /autonomous/state     — current rate-limit counters + LIMITS
 *   POST /autonomous/reset     — zero the hour/day counters (worker secret)
 *   GET  /tasks                — pending tasks from the repo
 *   GET  /tasks/all            — full task store (debug)
 *   POST /search               — hybrid Vectorize search across this
 *                                agent's scope; applies company-scope
 *                                filter that excludes personal agents
 *   POST /prompt               — spawns Claude Code as a subprocess;
 *                                streams stdout/stderr via SSE. Stores
 *                                completed prompts + responses in D1.
 *   GET  /conversations        — recent messages for this agent, D1-backed
 *                                with on-disk state fallback
 *
 * The /prompt handler injects `spawn` so tests can replace it with an
 * EventEmitter. generateEmbedding in /search is pulled via dynamic
 * import() because it transitively loads onnxruntime — keeping the
 * router importable in tests without that heavyweight dep.
 *
 * Company-scope filter (`/search`): when MEMORY_SCOPE=company we fetch
 * 2× the requested limit from the hybrid index and post-filter rows
 * whose agent_id is `personal-agent` or `mya-personal`. This is an
 * org/personal data boundary enforced in userspace; the Vectorize
 * tenant-isolation layer already prevents cross-tenant leaks.
 */

import { Router } from 'express';
import { spawn } from 'child_process';
import fs from 'fs/promises';

import { getModelForTask } from '@mycelium/core/runtime.js';
import { readFile } from '@mycelium/core/paths.js';
import { log as eventLog } from '@mycelium/core/events.js';

import { getWorkerUrl, getWorkerSecret, hasWorkerSecret } from '@mycelium/core/env.js';
/**
 * @typedef {object} CreatePortalRuntimeRouterDeps
 * @property {(req: any, res: any) => boolean}     requireWorkerSecret
 * @property {() => object|null}                   tryGetDb
 * @property {(req: any, res: any, key: string, max?: number) => boolean} checkRateLimit
 * @property {object}                              runtimeState
 * @property {(type: string, msg: string, meta?: object) => void} addActivity
 * @property {object}                              paths
 * @property {() => Promise<string>}               loadSystemPrompt
 * @property {() => Promise<object>}               loadState
 * @property {(s: object) => Promise<void>}        saveState
 * @property {(s: object) => object}               resetCountersIfNeeded
 * @property {(s: object) => boolean}              canSendProactiveMessage
 * @property {() => Promise<{ tasks: any[] }>}     loadTasks
 * @property {(userId: string, source: string, userMsg: string, assistant: string, t: Date) => Promise<any>} storeMessages
 * @property {(err: any, fallback?: string) => string} safeError
 * @property {object}                              config
 *   — { LOG_PREFIX, AGENT_ID, CLAUDE_BIN, LIMITS, TIMEOUTS, PROMPT_TIMEOUT, KEEPALIVE_INTERVAL }
 * @property {object}                              [log]
 * @property {(cmd: string, args: string[], opts: object) => any} [spawnFn]
 *   — test seam (defaults to child_process.spawn)
 */

export function createPortalRuntimeRouter(deps) {
  if (!deps) throw new TypeError('createPortalRuntimeRouter: deps required');
  const {
    requireWorkerSecret, tryGetDb, checkRateLimit, runtimeState, addActivity,
    paths, loadSystemPrompt, loadState, saveState, resetCountersIfNeeded,
    canSendProactiveMessage, loadTasks, storeMessages, safeError,
    config, log, spawnFn,
  } = deps;

  for (const [name, value] of [
    ['requireWorkerSecret', requireWorkerSecret],
    ['tryGetDb', tryGetDb],
    ['checkRateLimit', checkRateLimit],
    ['addActivity', addActivity],
    ['loadSystemPrompt', loadSystemPrompt],
    ['loadState', loadState],
    ['saveState', saveState],
    ['resetCountersIfNeeded', resetCountersIfNeeded],
    ['canSendProactiveMessage', canSendProactiveMessage],
    ['loadTasks', loadTasks],
    ['storeMessages', storeMessages],
    ['safeError', safeError],
  ]) {
    if (typeof value !== 'function') {
      throw new TypeError(`createPortalRuntimeRouter: ${name} required`);
    }
  }
  if (!runtimeState) throw new TypeError('createPortalRuntimeRouter: runtimeState required');
  if (!paths)        throw new TypeError('createPortalRuntimeRouter: paths required');
  if (!config?.LOG_PREFIX) {
    throw new TypeError('createPortalRuntimeRouter: config.LOG_PREFIX required');
  }
  if (!config?.CLAUDE_BIN) {
    throw new TypeError('createPortalRuntimeRouter: config.CLAUDE_BIN required');
  }
  if (!config?.LIMITS) {
    throw new TypeError('createPortalRuntimeRouter: config.LIMITS required');
  }

  const {
    LOG_PREFIX, AGENT_ID, CLAUDE_BIN, LIMITS,
    TIMEOUTS = { gracePeriod: 5000, keepalive: 15000 },
    PROMPT_TIMEOUT = 180_000,
    KEEPALIVE_INTERVAL = TIMEOUTS.keepalive || 15000,
  } = config;

  const logger = log || console;
  const err  = logger.error ? logger.error.bind(logger) : console.error;
  const warn = logger.warn  ? logger.warn.bind(logger)  : console.warn;
  const info = logger.info  ? logger.info.bind(logger)  : console.log;

  const doSpawn = spawnFn || spawn;

  const router = Router();

  // ── Autonomous ─────────────────────────────────────────────────────

  router.get('/autonomous/state', async (_req, res) => {
    let state = await loadState();
    state = resetCountersIfNeeded(state);
    res.json({
      state,
      limits: LIMITS,
      canSend: canSendProactiveMessage(state),
    });
  });

  router.post('/autonomous/reset', async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;
    const state = await loadState();
    state.messagesThisHour = 0;
    state.messagesToday    = 0;
    state.lastMessageTime  = null;
    await saveState(state);
    res.json({ ok: true, message: 'Rate limits reset' });
  });

  // ── Tasks ──────────────────────────────────────────────────────────

  router.get('/tasks', async (_req, res) => {
    const data = await loadTasks();
    const pending = data.tasks.filter((t) => t.status === 'pending');
    res.json({ tasks: pending, total: data.tasks.length });
  });

  router.get('/tasks/all', async (_req, res) => {
    const data = await loadTasks();
    res.json(data);
  });

  // ── Memory search ──────────────────────────────────────────────────

  // POST /search removed Wave 4b 2026-05-04. The legacy hybrid path
  // (FTS5 keyword + Vectorize semantic) was broken for encrypted rows
  // (FTS5 indexed ciphertext) and Vectorize is gone. Agents recall via
  // the searchMindscape MCP tool, which routes through
  // /internal/v1/search/mindscape — no diagnostic /search route needed.

  // ── SSE prompt → Claude Code subprocess ────────────────────────────

  router.post('/prompt', async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;
    const { prompt, channel, username } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'Prompt required' });

    let systemPrompt = '';
    let context = '';
    try {
      systemPrompt = await loadSystemPrompt();
      context = await fs.readFile(paths.knowledge.context, 'utf-8');
    } catch (e) {
      info(`[${LOG_PREFIX}] Could not load prompts: ${e.message}`);
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

    info(`[${LOG_PREFIX}] Processing prompt from ${username} in #${channel}`);
    addActivity('action', `Prompt request from ${username}`, { channel, promptLength: prompt.length });
    addActivity('thought', `Prompt: ${prompt.length} chars`, { type: 'prompt-input' });

    const promptModel = getModelForTask(runtimeState.runtime(), 'chat');
    addActivity('action', `Spawning Claude Code process (model: ${promptModel})`, {
      type: 'claude-spawn',
      model: promptModel,
    });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.write(`data: {"type":"start","timestamp":"${new Date().toISOString()}"}\n\n`);

    const claude = doSpawn(CLAUDE_BIN, [
      '--print',
      '--model', promptModel,
      '--dangerously-skip-permissions',
    ], {
      cwd: paths.repo,
      env: { ...process.env, HOME: '/home/claude' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // stdin-fed prompt to avoid E2BIG on large contexts.
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
      warn(`[${LOG_PREFIX}] Prompt timed out`);
      claude.kill('SIGINT');
      res.write(`data: {"type":"error","message":"Request timed out"}\n\n`);
      // Hard-kill after grace window so a wedged child can't linger.
      setTimeout(() => { claude.kill('SIGKILL'); }, TIMEOUTS.gracePeriod);
    }, PROMPT_TIMEOUT);

    claude.stdout.on('data', (data) => {
      lastDataTime = Date.now();
      const text = data.toString();
      fullOutput += text;
      res.write(`data: ${JSON.stringify({ type: 'stdout', text })}\n\n`);
      addActivity('output', text, { source: 'claude' });
    });

    claude.stderr.on('data', (data) => {
      lastDataTime = Date.now();
      const text = data.toString().trim();
      res.write(`data: ${JSON.stringify({ type: 'stderr', text })}\n\n`);
      if (!text) return;
      // Classify stderr into activity categories so the portal can show
      // per-category streams (writes, reads, commands, tools, errors).
      if (text.includes('Writing')  || text.includes('Wrote')) {
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
    });

    claude.on('close', async (code) => {
      clearInterval(keepaliveTimer);
      clearTimeout(timeoutTimer);
      res.write(`data: {"type":"done","code":${code}}\n\n`);
      res.end();

      info(`[${LOG_PREFIX}] Finished prompt (code: ${code}, output: ${fullOutput.length} chars)`);
      addActivity('status', `Task completed (exit code: ${code})`, { code });

      // Fire-and-forget D1 persist — contract metadata captures the
      // portal-spawn-task transport so Timeline can distinguish from
      // regular /chat. Failures emit message.persist_failed via the
      // helper; never blocks.
      const chatUserId = process.env.USER_ID;
      if (chatUserId && fullOutput.trim()) {
        const taskMd = {
          origin: 'natural-reply',
          channel: 'portal-runtime',
          delivery: 'sent',
          extra: { transport: 'spawn-task', exitCode: code },
        };
        storeMessages(chatUserId, 'portal_prompt', prompt, fullOutput.trim(), new Date(), taskMd)
          .catch((e) => err(`[${LOG_PREFIX}] Prompt message storage failed (non-fatal): ${e.message}`));
      }
    });

    claude.on('error', (e) => {
      clearInterval(keepaliveTimer);
      clearTimeout(timeoutTimer);
      err(`[${LOG_PREFIX}] Claude process error: ${e.message}`);
      res.write(`data: {"type":"error","message":"Stream error"}\n\n`);
      res.end();
      addActivity('error', e.message, { source: 'claude' });
    });
  });

  // ── Conversations ──────────────────────────────────────────────────

  router.get('/conversations', async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;
    try {
      const limit = parseInt(req.query.limit, 10) || 100;
      const agentId = AGENT_ID || 'personal-agent';

      const db = tryGetDb();
      if (db) {
        const { data, count } = await db.messages.selectByAgent(agentId, { limit });
        const messages = (data || []).reverse().map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          timestamp: m.created_at,
        }));
        return res.json({ messages, total: count || messages.length });
      }

      // On-disk fallback — used by agents whose D1 hasn't been set up yet.
      const memory = await readFile(paths.state, { messages: [] });
      res.json({
        messages: (memory.messages || []).slice(-limit),
        total: (memory.messages || []).length,
      });
    } catch (e) {
      res.status(500).json({ error: safeError(e, 'Conversations fetch failed') });
    }
  });

  info(`[${LOG_PREFIX}] portal-runtime-router mounted 7 handlers`);

  return router;
}
