/**
 * Health & Status Routes
 *
 * Agent card, health check, info, queue, wake-cycles, continuations,
 * autonomous state, tasks.
 */

import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { getLaneInfo, clearLane, cancelActive } from '../lib/lanes.js';
import { readAllContinuations } from '../lib/continuation.js';

/**
 * @param {import('../lib/server-context.js').ServerContext} ctx
 */
export default function healthRouter(ctx) {
  const router = Router();

  // A2A-compatible agent card
  router.get('/.well-known/agent.json', async (req, res) => {
    let description = `${ctx.agentId} agent`;
    try {
      const systemPrompt = await fs.readFile(ctx.paths.prompts.system, 'utf-8');
      const firstLine = systemPrompt.split('\n').find(l => l.trim() && !l.startsWith('#'));
      if (firstLine) description = firstLine.trim().slice(0, 200);
    } catch { /* use default */ }

    let discordBotUserId = null;
    try {
      discordBotUserId = (await fs.readFile(path.join(ctx.paths.root, '.discord-bot-id'), 'utf-8')).trim();
    } catch { /* bot hasn't started yet */ }

    const runtime = ctx.getRuntime();
    res.json({
      name: ctx.agentId,
      description,
      version: '1.0.0',
      url: runtime?.publicUrl || `http://localhost:${ctx.port}`,
      instance_id: runtime?.instanceId || null,
      discordBotUserId,
      skills: [],
      capabilities: { streaming: false, delegation: true, spawning: true },
    });
  });

  // Health check
  router.get('/health', async (req, res) => {
    const state = await ctx.loadState();
    const runtime = ctx.getRuntime();
    res.json({
      status: 'ok',
      agent: ctx.agentId,
      tier: runtime?.tier || 1,
      model: runtime?.model || 'sonnet',
      models: runtime?.models || {},
      lastModelUsed: ctx.taskState.lastModelUsed,
      account: process.env.CLAUDE_CONFIG_DIR ? 'configured' : 'default',
      features: ['chat', 'think', 'discord-outbound', 'checkpoint-recovery', 'session-resume', 'wake-cycles'],
      timeouts: {
        chat: ctx.timeouts.chat / 1000 + 's',
        think: ctx.timeouts.think / 1000 + 's',
        research: ctx.timeouts.research / 1000 + 's',
      },
      state: {
        messagesThisHour: state.messagesThisHour,
        messagesToday: state.messagesToday,
        lastMessageTime: state.lastMessageTime,
        activeTasks: ctx.taskState.activeCount(),
      },
      timestamp: new Date().toISOString()
    });
  });

  // Agent info (authenticated)
  router.get('/info', async (req, res) => {
    if (!ctx.requireWorkerSecret(req, res)) return;
    try {
      const [systemPrompt, context] = await Promise.all([
        fs.readFile(ctx.paths.prompts.system, 'utf-8').catch(() => 'No system prompt'),
        fs.readFile(ctx.paths.knowledge.context, 'utf-8').catch(() => 'No context')
      ]);
      res.json({
        agent: ctx.agentId,
        directory: ctx.paths.root,
        repository: ctx.paths.repo,
        systemPrompt: systemPrompt.substring(0, 500) + '...',
        contextPreview: context.substring(0, 500) + '...'
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Queue status
  router.get('/queue', (req, res) => {
    const info = getLaneInfo(`agent:${ctx.agentId}`);
    res.json(info || { processing: false, active: null, queueLength: 0, queued: [] });
  });

  // Clear queue
  router.post('/queue/clear', (req, res) => {
    if (!ctx.requireWorkerSecret(req, res)) return;
    const cleared = clearLane(`agent:${ctx.agentId}`);
    console.log(`[${ctx.logPrefix}] Queue cleared via API: ${cleared} tasks dropped`);
    res.json({ cleared });
  });

  // Cancel active task + clear queue
  router.post('/cancel', (req, res) => {
    if (!ctx.requireWorkerSecret(req, res)) return;
    const laneId = `agent:${ctx.agentId}`;
    const cancelled = cancelActive(laneId);
    const cleared = clearLane(laneId);
    console.log(`[${ctx.logPrefix}] Cancel via API: active=${cancelled}, queueCleared=${cleared}`);
    res.json({ cancelled, queueCleared: cleared });
  });

  // Wake cycles
  router.get('/wake-cycles', async (req, res) => {
    const cycles = await ctx.getWakeCycles();
    res.json(cycles || { cycles: [] });
  });

  // Continuations diagnostics
  router.get('/continuations', async (req, res) => {
    try {
      const all = await readAllContinuations(ctx.paths.root);
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

  // Autonomous state
  router.get('/autonomous/state', async (req, res) => {
    let state = await ctx.loadState();
    state = ctx.resetCountersIfNeeded(state);
    res.json({
      state,
      limits: ctx.limits,
      canSend: ctx.canSendProactiveMessage(state)
    });
  });

  // Reset autonomous rate limits
  router.post('/autonomous/reset', async (req, res) => {
    if (!ctx.requireWorkerSecret(req, res)) return;
    let state = await ctx.loadState();
    state.messagesThisHour = 0;
    state.messagesToday = 0;
    state.lastMessageTime = null;
    await ctx.saveState(state);
    res.json({ ok: true, message: 'Rate limits reset' });
  });

  // Tasks
  router.get('/tasks', async (req, res) => {
    const data = await ctx.loadTasks();
    const pending = data.tasks.filter(t => t.status === 'pending');
    res.json({ tasks: pending, total: data.tasks.length });
  });

  router.get('/tasks/all', async (req, res) => {
    const data = await ctx.loadTasks();
    res.json(data);
  });

  return router;
}
