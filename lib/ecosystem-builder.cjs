/**
 * Ecosystem Builder — generates PM2 app entries from agents/*.json configs.
 *
 * Used by ecosystem.config.cjs to dynamically create process definitions.
 * Adding a new agent = creating agents/new-agent.json (no code edits).
 *
 * CommonJS module (ecosystem.config.cjs is CJS).
 */

const fs = require('fs');
const path = require('path');

const AGENTS_DIR = path.join(__dirname, '..', 'agents');
const LOG_DIR = '/var/log/mycelium';

/**
 * Load all agent configs from agents/*.json
 */
function loadAgentConfigs() {
  try {
    return fs.readdirSync(AGENTS_DIR)
      .filter(f => f.endsWith('.json') && !f.startsWith('_'))
      .map(f => {
        try {
          return JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, f), 'utf-8'));
        } catch { return null; }
      })
      .filter(c => c && c.id);
  } catch {
    return [];
  }
}

/**
 * Build PM2 agent-server entry from config
 */
function buildAgentApp(config, sharedEnv) {
  const envPrefix = config.name.toUpperCase();

  const env = {
    ...sharedEnv,
    PORT: config.port,
    AGENT_ID: config.id,
    AGENT_TIER: String(config.tier || 1),
    MEMORY_SCOPE: config.memoryScope || config.id,
    DISCORD_CHANNEL: config.discordChannelEnv ? process.env[config.discordChannelEnv] : undefined,
    DISCORD_BOT_URL: config.botPort ? `http://localhost:${config.botPort}` : undefined,
  };

  // Claude config dir override
  if (config.claudeConfigEnv && process.env[config.claudeConfigEnv]) {
    env.CLAUDE_CONFIG_DIR = process.env[config.claudeConfigEnv];
  }

  // Agent token
  if (config.agentTokenEnv && process.env[config.agentTokenEnv]) {
    env.AGENT_TOKEN = process.env[config.agentTokenEnv];
  }

  // Clean undefined values
  Object.keys(env).forEach(k => { if (env[k] === undefined) delete env[k]; });

  return {
    name: config.id,
    script: 'agent-server.js',
    cwd: path.join(__dirname, '..'),
    interpreter: 'node',
    interpreter_args: '--experimental-modules',
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    max_memory_restart: '1G',
    env,
    error_file: `${LOG_DIR}/${config.id}-error.log`,
    out_file: `${LOG_DIR}/${config.id}-out.log`,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
  };
}

/**
 * Build PM2 Discord bot entry from config (if bot configured)
 */
function buildBotApp(config) {
  if (!config.botPort) return null;

  const botScript = `${config.id}-discord-bot.js`;
  const botPath = path.join(__dirname, '..', botScript);

  // Only create entry if bot script exists
  if (!fs.existsSync(botPath)) return null;

  const envPrefix = config.name.toUpperCase();
  return {
    name: `${config.id}-discord-bot`,
    script: botScript,
    cwd: path.join(__dirname, '..'),
    interpreter: 'node',
    interpreter_args: '--experimental-modules',
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    max_memory_restart: '256M',
    env: {
      NODE_ENV: 'production',
    },
    error_file: `${LOG_DIR}/${config.id}-bot-error.log`,
    out_file: `${LOG_DIR}/${config.id}-bot-out.log`,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
  };
}

/**
 * Build PM2 scheduler entry from config (if scheduler configured)
 */
function buildSchedulerApp(config, sharedEnv) {
  if (!config.scheduler?.script) return null;

  return {
    name: `${config.id.replace('-agent', '')}-scheduler`,
    script: config.scheduler.script,
    cwd: path.join(__dirname, '..'),
    interpreter: 'node',
    interpreter_args: '--experimental-modules',
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    max_memory_restart: '256M',
    env: {
      NODE_ENV: 'production',
      AGENT_ID: config.id,
      AGENT_URL: `http://localhost:${config.port}`,
      MYA_WORKER_URL: sharedEnv.MYA_WORKER_URL,
      MYA_WORKER_SECRET: process.env.MYA_WORKER_SECRET,
      DISCORD_COLLAB_CHANNEL: sharedEnv.DISCORD_COLLAB_CHANNEL,
    },
    error_file: `${LOG_DIR}/${config.id}-scheduler-error.log`,
    out_file: `${LOG_DIR}/${config.id}-scheduler-out.log`,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
  };
}

/**
 * Build all PM2 apps from agent configs
 * @param {object} sharedEnv - SHARED_AGENT_ENV from ecosystem.config.cjs
 * @returns {Array} PM2 app entries
 */
function buildAll(sharedEnv) {
  const configs = loadAgentConfigs();
  const apps = [];

  for (const config of configs) {
    apps.push(buildAgentApp(config, sharedEnv));

    const bot = buildBotApp(config);
    if (bot) apps.push(bot);

    const scheduler = buildSchedulerApp(config, sharedEnv);
    if (scheduler) apps.push(scheduler);
  }

  return apps;
}

module.exports = { loadAgentConfigs, buildAgentApp, buildBotApp, buildSchedulerApp, buildAll };
