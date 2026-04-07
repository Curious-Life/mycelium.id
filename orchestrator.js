/**
 * Orchestrator - Main API server for multi-agent management
 * Handles agent CRUD and proxies requests to individual agent servers
 */

// SECURITY: Block --inspect in production.
if (process.execArgv.some(a => a.includes('inspect'))) {
  console.error('FATAL: --inspect detected. Node inspector is not allowed in production.');
  process.exit(1);
}

import './lib/sentry.js';
import 'dotenv/config';
import { bootstrapSecrets, refreshSecrets } from './lib/bootstrap-secrets.js';
import express from 'express';
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { initDb, getDb, tryGetDb } from './lib/db.js';
import registry from './registry.js';
import repoManager from './repo-manager.js';
import agentManager from './agent-manager.js';
import githubOAuth from './github-oauth.js';
import myaRouter from './mya-router.js';
import prReview from './pr-review.js';
import discordBot from './discord-bot.js';
import discordOAuth from './discord-oauth.js';
import discordOutbound from './discord-outbound.js';
import { Routes } from 'discord-api-types/v10';
import { startWatchdog, stopWatchdog } from './lib/watchdog.js';

// Bootstrap secrets from D1 API before any database or auth operations
await bootstrapSecrets();

// Initialize database (async — called during startup)
let dbReady = false;
async function initDatabase() {
  try {
    await initDb();
    dbReady = true;
    console.log('[Orchestrator] Database initialized');
  } catch (err) {
    console.error('[Orchestrator] Database initialization failed:', err.message);
  }
}

// Simple in-memory KV store for development (replace with real KV in production)
const kvStore = {
  _data: new Map(),
  async get(key) { return this._data.get(key) || null; },
  async put(key, value, options = {}) { this._data.set(key, value); }
};

const app = express();
const PORT = process.env.ORCHESTRATOR_PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'multi-agent-orchestrator', timestamp: new Date().toISOString() });
});

// ============================================
// System Status Endpoint
// ============================================

/**
 * System-wide health check. Polls every agent's /health endpoint (3s timeout)
 * and includes PM2 process state.
 *
 * Returns:
 *   status: 'healthy' | 'degraded' | 'critical'
 *   agents: { [slug]: { health, uptime, memory, restarts, error? } }
 *   summary: { total, healthy, unhealthy, crashLooping }
 */
app.get('/system/status', async (req, res) => {
  const agents = {};
  let healthy = 0;
  let unhealthy = 0;
  const crashLooping = [];

  for (const known of KNOWN_AGENTS) {
    const agentStatus = { slug: known.slug, name: known.name, port: known.port };

    // PM2 process info
    const pm2Info = agentManager.getAgentStatus(known.slug);
    if (pm2Info) {
      agentStatus.running = pm2Info.running;
      agentStatus.status = pm2Info.status;
      agentStatus.memory = pm2Info.memory;
      agentStatus.cpu = pm2Info.cpu;
      agentStatus.restarts = pm2Info.restarts;
      agentStatus.uptime = pm2Info.uptime
        ? Math.round((Date.now() - pm2Info.uptime) / 1000) + 's'
        : null;

      // Detect crash loops: >3 restarts in last 15 minutes
      if (pm2Info.restarts > 3 && pm2Info.uptime) {
        const uptimeMs = Date.now() - pm2Info.uptime;
        if (uptimeMs < 15 * 60 * 1000) {
          crashLooping.push(known.slug);
        }
      }
    } else {
      agentStatus.running = false;
      agentStatus.status = 'not_registered';
    }

    // HTTP health check (3s timeout)
    try {
      const healthRes = await fetch(`http://localhost:${known.port}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (healthRes.ok) {
        const data = await healthRes.json();
        agentStatus.health = 'ok';
        agentStatus.agent_status = data.status;
        healthy++;
      } else {
        agentStatus.health = 'error';
        agentStatus.error = `HTTP ${healthRes.status}`;
        unhealthy++;
      }
    } catch (err) {
      agentStatus.health = 'unreachable';
      agentStatus.error = err.message?.includes('timeout') ? 'timeout' : err.message;
      unhealthy++;
    }

    agents[known.slug] = agentStatus;
  }

  const total = KNOWN_AGENTS.length;
  let status = 'healthy';
  if (unhealthy > 0) status = 'degraded';
  if (unhealthy === total || crashLooping.length > 0) status = 'critical';

  res.json({
    status,
    timestamp: new Date().toISOString(),
    agents,
    summary: { total, healthy, unhealthy, crashLooping },
  });
});

// ============================================
// GitHub OAuth Endpoints
// ============================================

/**
 * Check GitHub connection status
 */
app.get('/auth/github/status', async (req, res) => {
  try {
    const status = await githubOAuth.isConnected();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Start GitHub OAuth flow
 */
app.get('/auth/github', (req, res) => {
  try {
    // Always use HTTPS for OAuth callback (we're behind Cloudflare)
    const redirectUri = `https://${req.get('host')}/auth/github/callback`;
    const authUrl = githubOAuth.getAuthUrl(redirectUri);
    res.redirect(authUrl);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GitHub OAuth callback
 */
app.get('/auth/github/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.redirect(`${FRONTEND_URL}/agents?error=${encodeURIComponent(error)}`);
  }

  if (!code) {
    return res.redirect(`${FRONTEND_URL}/agents?error=no_code`);
  }

  try {
    const token = await githubOAuth.exchangeCodeForToken(code);
    await githubOAuth.saveToken(token);
    res.redirect(`${FRONTEND_URL}/agents?github=connected`);
  } catch (error) {
    console.error('OAuth error:', error);
    res.redirect(`${FRONTEND_URL}/agents?error=${encodeURIComponent(error.message)}`);
  }
});

/**
 * Disconnect GitHub
 */
app.post('/auth/github/disconnect', async (req, res) => {
  try {
    await githubOAuth.disconnect();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * List user's GitHub repositories
 */
app.get('/auth/github/repos', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const repos = await githubOAuth.listRepos(page);
    res.json(repos);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Search user's GitHub repositories
 */
app.get('/auth/github/repos/search', async (req, res) => {
  try {
    const query = req.query.q || '';
    if (!query) {
      return res.status(400).json({ error: 'Query parameter q is required' });
    }
    const repos = await githubOAuth.searchRepos(query);
    res.json(repos);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Discord OAuth Endpoints (Identity Linking)
// ============================================

/**
 * Helper: Get user from session token
 */
async function getUserFromSession(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.slice(7);
  const db = tryGetDb();
  if (!db) return null;

  return await db.sessions.getByToken(token);
}

/**
 * Start Discord OAuth flow - links Discord to user's MYA account
 */
app.get('/auth/discord/link', async (req, res) => {
  try {
    const userId = await getUserFromSession(req);
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const db = tryGetDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    // Generate OAuth state
    const state = discordOAuth.generateState();
    const redirectUri = `https://${req.get('host')}/auth/discord/callback`;

    // Store state with user_id for callback
    await db.oauthStates.insert({
      user_id: userId,
      provider: 'discord',
      state: state,
      redirect_url: req.query.redirect || `${FRONTEND_URL}/portal/settings`,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString()  // 10 min
    });

    const authUrl = discordOAuth.getAuthUrl(redirectUri, state);
    res.json({ url: authUrl });
  } catch (error) {
    console.error('[Discord OAuth] Link error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Discord OAuth callback
 */
app.get('/auth/discord/callback', async (req, res) => {
  const { code, state, error: oauthError } = req.query;

  if (oauthError) {
    return res.redirect(`${FRONTEND_URL}/portal/settings?error=${encodeURIComponent(oauthError)}`);
  }

  if (!code || !state) {
    return res.redirect(`${FRONTEND_URL}/portal/settings?error=missing_params`);
  }

  const db = tryGetDb();
  if (!db) {
    return res.redirect(`${FRONTEND_URL}/portal/settings?error=database_not_configured`);
  }

  try {
    // Validate state and get user_id
    const oauthState = await db.oauthStates.validate(state, 'discord');

    if (!oauthState) {
      return res.redirect(`${FRONTEND_URL}/portal/settings?error=invalid_state`);
    }

    // Delete used state
    await db.oauthStates.delete(state);

    // Exchange code for token
    const redirectUri = `https://${req.get('host')}/auth/discord/callback`;
    const tokens = await discordOAuth.exchangeCodeForToken(code, redirectUri);

    // Get Discord user info
    const discordUser = await discordOAuth.getUser(tokens.accessToken);

    // Link Discord identity to user
    await db.userIdentities.link({
      p_user_id: oauthState.user_id,
      p_provider: 'discord',
      p_provider_id: discordUser.id,
      p_provider_username: discordUser.username,
      p_provider_avatar: discordUser.avatar,
      p_provider_data: {
        displayName: discordUser.displayName,
        discriminator: discordUser.discriminator
      }
    });

    console.log(`[Discord OAuth] Linked Discord user ${discordUser.username} to user ${oauthState.user_id}`);

    const redirectUrl = oauthState.redirect_url || `${FRONTEND_URL}/portal/settings`;
    res.redirect(`${redirectUrl}?discord=linked`);
  } catch (error) {
    console.error('[Discord OAuth] Callback error:', error);
    res.redirect(`${FRONTEND_URL}/portal/settings?error=${encodeURIComponent(error.message)}`);
  }
});

/**
 * Get user's linked identities
 */
app.get('/auth/identities', async (req, res) => {
  try {
    const userId = await getUserFromSession(req);
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const db = tryGetDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    const data = await db.userIdentities.list(userId);
    res.json({ identities: data || [] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Unlink a provider identity
 */
app.post('/auth/identities/:provider/unlink', async (req, res) => {
  try {
    const userId = await getUserFromSession(req);
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const db = tryGetDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    const { provider } = req.params;
    await db.userIdentities.unlink(userId, provider);

    console.log(`[Identity] Unlinked ${provider} from user ${userId}`);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Discord Bot Actions
// ============================================

/**
 * Send a message to a Discord channel
 * Allows the agent to send proactive messages during autonomous cycles
 */
app.post('/discord/send', async (req, res) => {
  try {
    const { channelId, content } = req.body;

    if (!channelId || !content) {
      return res.status(400).json({
        error: 'Missing required fields: channelId, content'
      });
    }

    const result = await discordOutbound.sendMessage(channelId, content);

    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }

    res.json({ success: true, messageIds: result.messageIds });
  } catch (error) {
    console.error('[Discord] Send error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Add an emoji reaction to a Discord message
 * Allows the agent to react to messages with emojis
 */
app.post('/discord/react', async (req, res) => {
  try {
    const { channelId, messageId, emoji } = req.body;

    if (!channelId || !messageId || !emoji) {
      return res.status(400).json({
        error: 'Missing required fields: channelId, messageId, emoji'
      });
    }

    const result = await discordOutbound.reactToMessage(channelId, messageId, emoji);

    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('[Discord] Reaction error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Send a voice message to a Discord channel
 * Uses client.rest.post() directly because channel.send() drops duration_secs/waveform
 */
app.post('/discord/send-voice', async (req, res) => {
  try {
    const { channelId, audio, durationSecs, waveform } = req.body;

    if (!channelId || !audio) {
      return res.status(400).json({ error: 'channelId and audio (base64) required' });
    }
    if (durationSecs === undefined || !waveform) {
      return res.status(400).json({ error: 'durationSecs and waveform required for voice messages' });
    }

    const client = discordBot.client;
    if (!client || !client.isReady()) {
      return res.status(503).json({ error: 'Discord client not ready' });
    }

    const audioBuffer = Buffer.from(audio, 'base64');
    if (audioBuffer.length > 25 * 1024 * 1024) {
      return res.status(413).json({ error: 'Audio exceeds 25MB Discord limit' });
    }

    const body = {
      content: '',
      flags: 8192,
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

    await client.rest.post(Routes.channelMessages(channelId), { body, files });

    console.log(`[Orchestrator] Sent voice message to ${channelId} (${durationSecs.toFixed(1)}s, ${audioBuffer.length} bytes)`);
    res.json({ ok: true, sent: true, channelId, durationSecs });
  } catch (error) {
    console.error('[Orchestrator] Send voice error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Agent CRUD Endpoints
// ============================================

/**
 * List all agents
 */
app.get('/agents', async (req, res) => {
  try {
    const agents = await registry.listAgents();

    // Enrich with process status
    const enriched = agents.map(agent => ({
      ...agent,
      processStatus: agentManager.getAgentStatus(agent.slug)
    }));

    res.json(enriched);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get single agent
 */
app.get('/agents/:slug', async (req, res) => {
  try {
    const agent = await registry.getAgent(req.params.slug);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    res.json({
      ...agent,
      processStatus: agentManager.getAgentStatus(agent.slug)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Create new agent
 * Body: { name, repoUrl, branch?, config? }
 */
app.post('/agents', async (req, res) => {
  try {
    const { name, repoUrl, branch, config } = req.body;

    if (!name || !repoUrl) {
      return res.status(400).json({ error: 'name and repoUrl are required' });
    }

    // Create agent record
    const agent = await registry.createAgent({ name, repoUrl, branch, config });

    // Clone repository
    console.log(`Cloning ${repoUrl} to ${agent.repoPath}...`);
    await repoManager.cloneRepo({
      repoUrl,
      targetPath: agent.repoPath,
      branch: agent.branch,
      agentName: name
    });

    // Update state
    await registry.setAgentState(agent.slug, 'idle');

    res.status(201).json(agent);
  } catch (error) {
    console.error('Create agent error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Register local agent (already exists on disk, no GitHub clone)
 * Body: { name, localPath, config? }
 */
app.post('/agents/register-local', async (req, res) => {
  try {
    const { name, localPath, config } = req.body;

    if (!name || !localPath) {
      return res.status(400).json({ error: 'name and localPath are required' });
    }

    // Verify the path exists and has agent.yaml
    const fs = await import('fs/promises');
    const path = await import('path');

    try {
      await fs.access(localPath);
      await fs.access(path.default.join(localPath, 'agent.yaml'));
    } catch {
      return res.status(400).json({ error: 'localPath must exist and contain agent.yaml' });
    }

    // Create agent record with local path as repoPath
    const agent = await registry.createAgent({
      name,
      repoUrl: `local://${localPath}`,  // Mark as local
      branch: 'local',
      config,
      repoPath: localPath  // Override repoPath to use local path directly
    });

    // Update state
    await registry.setAgentState(agent.slug, 'idle');

    console.log(`[Orchestrator] Registered local agent: ${agent.slug} at ${localPath}`);
    res.status(201).json(agent);
  } catch (error) {
    console.error('Register local agent error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Update agent
 */
app.patch('/agents/:slug', async (req, res) => {
  try {
    const agent = await registry.updateAgent(req.params.slug, req.body);
    res.json(agent);
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * Delete agent
 */
app.delete('/agents/:slug', async (req, res) => {
  try {
    const slug = req.params.slug;

    // Stop process if running
    await agentManager.stopAgent(slug);
    await agentManager.deleteAgentProcess(slug);

    // Get agent to find repo path
    const agent = await registry.getAgent(slug);
    if (agent) {
      // Delete repo
      await repoManager.deleteRepo(agent.repoPath);
    }

    // Delete from registry
    await registry.deleteAgent(slug);

    res.json({ success: true, message: `Agent ${slug} deleted` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Agent Lifecycle Endpoints
// ============================================

/**
 * Start agent process
 */
app.post('/agents/:slug/start', async (req, res) => {
  try {
    const agent = await registry.getAgent(req.params.slug);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const result = await agentManager.startAgent(agent);
    await registry.setAgentState(agent.slug, 'running');

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Stop agent process
 */
app.post('/agents/:slug/stop', async (req, res) => {
  try {
    const result = await agentManager.stopAgent(req.params.slug);
    await registry.setAgentState(req.params.slug, 'stopped');

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Restart agent process
 */
app.post('/agents/:slug/restart', async (req, res) => {
  try {
    const result = await agentManager.restartAgent(req.params.slug);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get agent PM2 logs
 */
app.get('/agents/:slug/process-logs', async (req, res) => {
  try {
    const lines = parseInt(req.query.lines) || 100;
    const logs = await agentManager.getAgentLogs(req.params.slug, lines);
    res.json({ logs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Pull latest changes for agent repo
 */
app.post('/agents/:slug/pull', async (req, res) => {
  try {
    const agent = await registry.getAgent(req.params.slug);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const result = await repoManager.pullRepo(agent.repoPath, agent.branch);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Pause agent (stops automatic cycles from running)
 */
app.post('/agents/:slug/pause', async (req, res) => {
  try {
    const agent = await registry.getAgent(req.params.slug);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    if (!agentManager.isAgentRunning(agent.slug)) {
      return res.status(503).json({ error: 'Agent is not running' });
    }

    // Call the agent's pause endpoint
    const response = await fetch(`http://localhost:${agent.port}/pause`, {
      method: 'POST'
    });
    const result = await response.json();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Resume agent (allows automatic cycles to run)
 */
app.post('/agents/:slug/resume', async (req, res) => {
  try {
    const agent = await registry.getAgent(req.params.slug);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    if (!agentManager.isAgentRunning(agent.slug)) {
      return res.status(503).json({ error: 'Agent is not running' });
    }

    // Call the agent's resume endpoint
    const response = await fetch(`http://localhost:${agent.port}/resume`, {
      method: 'POST'
    });
    const result = await response.json();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Proxy to individual agent APIs
// ============================================

/**
 * Proxy all requests to /agents/:slug/api/* to the agent's server
 */
app.use('/agents/:slug/api', async (req, res, next) => {
  try {
    const agent = await registry.getAgent(req.params.slug);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    if (!agentManager.isAgentRunning(agent.slug)) {
      return res.status(503).json({ error: 'Agent is not running' });
    }

    // For SSE endpoints, pipe directly to avoid proxy buffering issues
    const targetPath = req.originalUrl.replace(`/agents/${agent.slug}/api`, '');
    const targetUrl = `http://localhost:${agent.port}${targetPath}`;

    if (req.method === 'POST' && (targetPath === '/prompt' || targetPath.startsWith('/chat/stream'))) {
      // Direct pipe for SSE streaming
      const http = await import('http');
      const body = JSON.stringify(req.body);
      const proxyReq = http.request(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Accept': 'text/event-stream',
          ...(req.headers['x-worker-secret'] ? { 'X-Worker-Secret': req.headers['x-worker-secret'] } : {})
        }
      }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });

      proxyReq.on('error', (err) => {
        console.error('SSE proxy error:', err);
        if (!res.headersSent) {
          res.status(502).json({ error: 'Agent unavailable' });
        }
      });

      proxyReq.write(body);
      proxyReq.end();
      return;
    }

    // Create proxy for other requests
    const proxy = createProxyMiddleware({
      target: `http://localhost:${agent.port}`,
      changeOrigin: true,
      pathRewrite: {
        [`^/agents/${agent.slug}/api`]: ''
      },
      on: {
        error: (err, req, res) => {
          console.error('Proxy error:', err);
          res.status(502).json({ error: 'Agent unavailable' });
        }
      }
    });

    proxy(req, res, next);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Utility Endpoints
// ============================================

/**
 * List branches for a repo URL
 */
app.get('/branches', async (req, res) => {
  try {
    const { repoUrl } = req.query;
    if (!repoUrl) {
      return res.status(400).json({ error: 'repoUrl query parameter required' });
    }

    const branches = await repoManager.listBranches(repoUrl);
    res.json(branches);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Save PM2 process list
 */
app.post('/pm2/save', async (req, res) => {
  try {
    const result = await agentManager.savePm2List();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// MYA Multi-Agent Routing
// ============================================

/**
 * List MYA agents and their configuration
 */
app.get('/mya/agents', (req, res) => {
  try {
    const agents = Object.entries(myaRouter.MYA_AGENTS).map(([id, config]) => ({
      id,
      port: config.port,
      memoryScope: config.memoryScope,
      channels: config.channels
    }));
    res.json(agents);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Route a message to the appropriate MYA agent
 * Body: { message, telegramChatId?, discordChannelId? }
 */
app.post('/mya/route', async (req, res) => {
  try {
    const { message, telegramChatId, discordChannelId, context } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }

    // Determine which agent should handle this
    const { agentId, port } = myaRouter.routeMessage({
      telegramChatId,
      discordChannelId
    });

    console.log(`[MYA Route] ${telegramChatId || discordChannelId || 'unknown'} → ${agentId}`);

    // Forward to the appropriate agent
    const result = await myaRouter.forwardToAgent(agentId, message, context || {});

    res.json({
      agentId,
      ...result
    });
  } catch (error) {
    console.error('[MYA Route] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Submit a delegation request
 * Body: { fromAgent, toAgent, task, context?, priority? }
 */
app.post('/mya/delegate', async (req, res) => {
  try {
    const { fromAgent, toAgent, task, context, priority } = req.body;

    if (!fromAgent || !toAgent || !task) {
      return res.status(400).json({ error: 'fromAgent, toAgent, and task are required' });
    }

    // Validate delegation is allowed
    if (!myaRouter.canDelegate(fromAgent, toAgent)) {
      return res.status(403).json({
        error: `Delegation not allowed: ${fromAgent} cannot delegate to ${toAgent}`
      });
    }

    // Create delegation record
    const delegation = {
      id: crypto.randomUUID(),
      from_agent: fromAgent,
      to_agent: toAgent,
      task,
      context: context || null,
      priority: priority || 'normal',
      status: 'pending',
      created_at: new Date().toISOString()
    };

    // Process immediately (in production, this would queue)
    const result = await myaRouter.processDelegation(delegation);

    res.json(result);
  } catch (error) {
    console.error('[MYA Delegate] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Proxy to specific MYA agent by ID
 */
app.use('/mya/:agentId/api', async (req, res, next) => {
  try {
    const config = myaRouter.getAgentConfig(req.params.agentId);
    if (!config) {
      return res.status(404).json({ error: 'MYA agent not found' });
    }

    // Create proxy for this request
    const proxy = createProxyMiddleware({
      target: `http://localhost:${config.port}`,
      changeOrigin: true,
      pathRewrite: {
        [`^/mya/${req.params.agentId}/api`]: ''
      },
      on: {
        error: (err, req, res) => {
          console.error('MYA proxy error:', err);
          res.status(502).json({ error: 'MYA agent unavailable' });
        }
      }
    });

    proxy(req, res, next);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Self-Modification PR Review Endpoints
// ============================================

/**
 * List pending PR proposals
 */
app.get('/pr/pending', async (req, res) => {
  try {
    const proposals = await prReview.getPendingProposals(kvStore);
    res.json(proposals);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * List proposals awaiting human review
 */
app.get('/pr/human-review', async (req, res) => {
  try {
    const proposals = await prReview.getHumanReviewQueue(kvStore);
    res.json(proposals);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Human approves or rejects a PR
 * Body: { decision: 'approve' | 'reject', comment?: string }
 */
app.post('/pr/:prId/review', async (req, res) => {
  try {
    const { decision, comment } = req.body;
    if (!decision || !['approve', 'reject'].includes(decision)) {
      return res.status(400).json({ error: 'decision must be "approve" or "reject"' });
    }

    const result = await prReview.humanReview(req.params.prId, decision, comment, kvStore);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get PR proposal details
 */
app.get('/pr/:prId', async (req, res) => {
  try {
    const data = await kvStore.get(`pr_proposal:${req.params.prId}`);
    if (!data) {
      return res.status(404).json({ error: 'PR not found' });
    }
    res.json(JSON.parse(data));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Trigger PR review processing (normally called on interval)
 */
app.post('/pr/process', async (req, res) => {
  try {
    const pending = await prReview.getPendingProposals(kvStore);
    const results = [];

    for (const proposal of pending) {
      const review = await prReview.processPRProposal(proposal, kvStore);
      results.push({ pr_id: proposal.id, ...review });
    }

    res.json({ processed: results.length, results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Trigger merge queue processing
 */
app.post('/pr/merge', async (req, res) => {
  try {
    const merged = await prReview.processMergeQueue(kvStore, repoManager);
    res.json({ merged });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Message History Endpoints
// ============================================

/**
 * Get message history for a specific agent
 * Used by the agents UI to display conversation history
 */
app.get('/messages/:agentId', async (req, res) => {
  const db = tryGetDb();
  if (!db) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const { agentId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;

    // Build the agent_id filter (e.g., 'mya-company')
    const agentFilter = agentId.startsWith('mya-') ? agentId : `mya-${agentId}`;

    const { data, count } = await db.messages.selectByAgent(agentFilter, { offset, limit });

    // Transform messages for the UI
    const messages = (data || []).reverse().map(msg => ({
      id: msg.id,
      role: msg.role,
      content: msg.content,
      timestamp: msg.created_at,
      source: msg.metadata?.source || 'unknown',
      discordUsername: msg.metadata?.discord_username,
      discordChannel: msg.metadata?.discord_channel_name
    }));

    res.json({
      messages,
      total: count,
      limit,
      offset,
      agentId: agentFilter
    });
  } catch (error) {
    console.error('[Orchestrator] Message history error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get message count by agent
 */
app.get('/messages/stats/by-agent', async (req, res) => {
  const db = tryGetDb();
  if (!db) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const agentIds = await db.messages.listAgentIds();

    // listAgentIds returns unique IDs — for counts we still need to query
    // For now, return the list of agents (count per agent requires a separate query)
    const counts = {};
    for (const id of agentIds) {
      const { count } = await db.messages.selectByAgent(id, { limit: 0 });
      counts[id] = count || 0;
    }

    res.json({ counts });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Start Server
// ============================================

// Start delegation worker (processes queued delegations)
const delegationWorker = myaRouter.startDelegationWorker();

// Start PR review worker (processes pending proposals every 30s)
const prReviewWorker = setInterval(async () => {
  try {
    const pending = await prReview.getPendingProposals(kvStore);
    for (const proposal of pending) {
      await prReview.processPRProposal(proposal, kvStore);
    }
    // Also process merge queue
    await prReview.processMergeQueue(kvStore, repoManager);
  } catch (error) {
    console.error('[PR Worker] Error:', error);
  }
}, 30000);

// Start Discord bot
let discordClient = null;
async function startDiscord() {
  try {
    discordClient = await discordBot.startDiscordBot();
    if (discordClient) {
      console.log('[Orchestrator] Discord bot started');
    }
  } catch (error) {
    console.error('[Orchestrator] Discord bot failed to start:', error.message);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n[Orchestrator] Shutting down...');
  stopWatchdog();
  delegationWorker.stop();
  clearInterval(prReviewWorker);
  await discordBot.stopDiscordBot();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n[Orchestrator] Received SIGTERM, shutting down...');
  stopWatchdog();
  delegationWorker.stop();
  clearInterval(prReviewWorker);
  await discordBot.stopDiscordBot();
  process.exit(0);
});

// ============================================
// Auto-register known MYA agents on startup
// ============================================

const KNOWN_AGENTS = [
  { slug: 'personal-agent', name: 'Mya', port: 3004, repoPath: '/home/claude/agents/personal-agent/repo', model: 'sonnet' },
  { slug: 'company-agent', name: 'Com', port: 3002, repoPath: '/home/claude/agents/company-agent/repo', model: 'sonnet' },
  { slug: 'research-agent', name: 'Ada', port: 5002, repoPath: '/home/claude/agents/research-agent/repo', model: 'sonnet' },
  { slug: 'commercial-intelligence-agent', name: 'Rex', port: 5004, repoPath: '/home/claude/agents/commercial-intelligence-agent/repo', model: 'sonnet' },
  { slug: 'publishing-agent', name: 'Noa', port: 5006, repoPath: '/home/claude/agents/publishing-agent/repo', model: 'sonnet' },
];

async function syncKnownAgents() {
  const existing = await registry.listAgents();
  const existingSlugs = new Set(existing.map(a => a.slug));

  for (const known of KNOWN_AGENTS) {
    if (!existingSlugs.has(known.slug)) {
      // Agent not in registry — create it
      console.log(`[Registry] Auto-registering missing agent: ${known.slug} (${known.name}) on port ${known.port}`);
      const reg = await registry.listAgents(); // re-read fresh
      const regData = { agents: [...reg] };
      const now = new Date().toISOString();
      regData.agents.push({
        id: `agent-${Date.now()}-${known.slug}`,
        name: known.name,
        slug: known.slug,
        repoUrl: `local://${known.repoPath}`,
        branch: 'main',
        port: known.port,
        repoPath: known.repoPath,
        state: 'stopped',
        taskTitle: null,
        plan: [],
        execution: [],
        artifacts: [],
        escalation: null,
        config: { model: known.model, autoCommit: true },
        createdAt: now,
        lastActiveAt: now,
      });
      // Write directly via updateAgent trick — but simpler to use the low-level write
      // We'll use createAgent-style direct write by reading/writing the file
      const fs = await import('fs/promises');
      const path = await import('path');
      const AGENTS_DIR = process.env.AGENTS_DIR || '/home/claude/agents';
      const REGISTRY_FILE = path.join(AGENTS_DIR, 'registry.json');
      const data = JSON.parse(await fs.readFile(REGISTRY_FILE, 'utf-8'));
      if (!data.agents.find(a => a.slug === known.slug)) {
        data.agents.push(regData.agents[regData.agents.length - 1]);
        await fs.writeFile(REGISTRY_FILE, JSON.stringify(data, null, 2));
      }
    } else {
      // Agent exists — fix port if it's wrong
      const agent = existing.find(a => a.slug === known.slug);
      if (agent && agent.port !== known.port) {
        console.log(`[Registry] Fixing port for ${known.slug}: ${agent.port} → ${known.port}`);
        // Direct file write since updateAgent prevents port changes
        const fs = await import('fs/promises');
        const path = await import('path');
        const AGENTS_DIR = process.env.AGENTS_DIR || '/home/claude/agents';
        const REGISTRY_FILE = path.join(AGENTS_DIR, 'registry.json');
        const data = JSON.parse(await fs.readFile(REGISTRY_FILE, 'utf-8'));
        const idx = data.agents.findIndex(a => a.slug === known.slug);
        if (idx !== -1) {
          data.agents[idx].port = known.port;
          await fs.writeFile(REGISTRY_FILE, JSON.stringify(data, null, 2));
        }
      }
    }
  }

  const final = await registry.listAgents();
  console.log(`[Registry] ${final.length} agents registered: ${final.map(a => a.slug).join(', ')}`);
}

app.listen(PORT, '127.0.0.1', async () => {
  console.log(`Multi-agent orchestrator running on 127.0.0.1:${PORT}`);

  // Initialize database
  await initDatabase();

  // Ensure all known agents are in the registry with correct ports
  try {
    await syncKnownAgents();
  } catch (e) {
    console.error('[Registry] Failed to sync known agents:', e.message);
  }

  console.log(`Endpoints:`);
  console.log(`  GET  /agents           - List all agents`);
  console.log(`  POST /agents           - Create new agent`);
  console.log(`  GET  /agents/:slug     - Get agent details`);
  console.log(`  POST /agents/:slug/start - Start agent`);
  console.log(`  POST /agents/:slug/stop  - Stop agent`);
  console.log(`  *    /agents/:slug/api/* - Proxy to agent API`);
  console.log(`  GET  /mya/agents       - List MYA agents`);
  console.log(`  POST /mya/route        - Route message to MYA agent`);
  console.log(`  POST /mya/delegate     - Submit delegation request`);
  console.log(`  *    /mya/:agentId/api/* - Proxy to MYA agent`);
  console.log(`  GET  /pr/pending       - List pending PRs`);
  console.log(`  GET  /pr/human-review  - List PRs needing human review`);
  console.log(`  POST /pr/:id/review    - Human approve/reject PR`);

  // Start Discord bot after server is ready
  await startDiscord();

  // Start watchdog (system health monitor)
  startWatchdog({
    agents: KNOWN_AGENTS,
    agentManager,
    discordAlertChannelId: process.env.DISCORD_ALERTS_CHANNEL || null,
    telegramBotPort: parseInt(process.env.TELEGRAM_BOT_PORT || '3003'),
    telegramChatId: process.env.OWNER_TELEGRAM_ID || null,
    timezone: process.env.SCHEDULER_TIMEZONE || 'Europe/London',
  });
});

export default app;
