// Load .env — all secrets come from the centralized Secrets API (D1) at runtime
// via lib/bootstrap-secrets.js. Only non-secret config + bootstrap keys live here.
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

/**
 * PM2 Ecosystem Configuration for Mycelium Agent Framework
 *
 * This file manages the orchestrator and all agent processes.
 * Deploy on any Linux VPS with Node.js 22+ and Claude CLI.
 *
 * Port allocation:
 *   Orchestrator:  3000 (Discord bot), 3001 (HTTP)
 *   Agent servers:  5000 + (index * 2)       → 5002, 5004, 5006, ...
 *   Bot processes:  5000 + (index * 2) + 1   → 5003, 5005, 5007, ...
 *   Company agent:  3002 (backward compat, doesn't follow formula)
 */
const AGENT_PORT_BASE = 5000;
function agentPorts(index) {
  return {
    agent: AGENT_PORT_BASE + (index * 2),
    bot: AGENT_PORT_BASE + (index * 2) + 1,
  };
}

// Default Claude config dir (shared across agents unless overridden)
const DEFAULT_CLAUDE_CONFIG = process.env.CLAUDE_CONFIG_DIR || '/home/claude/.claude';

// SECURITY: Sensitive env vars to strip from PM2's internal env serialization.
// PM2 dumps process env to ~/.pm2/dump.pm2 — this prevents secrets from being
// captured in the dump. Master key isn't in env (lives in tmpfs) but we list
// it anyway as defense-in-depth, plus all other secrets that flow through env.
const FILTER_ENV = [
  'ENCRYPTION_MASTER_KEY',
  'ADMIN_SECRET',
  'MYA_WORKER_SECRET',
  'CLOUDFLARE_AI_TOKEN',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'HETZNER_API_TOKEN',
  'CDP_API_KEY_ID',
  'CDP_API_KEY_SECRET',
  'CDP_WALLET_SECRET',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REFRESH_TOKEN',
  'GITHUB_CLIENT_SECRET',
  'POLYMARKET_API_PASSWORD',
  'STRIPE_SECRET_KEY',
  'RESEND_API_KEY',
  'SENTRY_AUTH_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'DISCORD_BOT_TOKEN',
  'DISCORD_CLIENT_SECRET',
  'VPS_NOISE_PRIV',    // defense-in-depth: should never be in env (lives in tmpfs)
  'VPS_SIGN_PRIV',
];

// Shared env vars for all agent servers
// NOTE: Secrets (API keys, tokens, passwords) come from D1 Secrets API via bootstrap-secrets.js.
// Only non-secret config and bootstrap credentials go here.
const SHARED_AGENT_ENV = {
  NODE_ENV: 'production',
  CLAUDE_BIN: process.env.CLAUDE_BIN || '/usr/bin/claude',
  CLAUDE_CONFIG_DIR: DEFAULT_CLAUDE_CONFIG,
  ORCHESTRATOR_URL: 'http://localhost:3000',
  MYA_WORKER_URL: process.env.MYA_WORKER_URL,
  DB_BACKEND: process.env.DB_BACKEND || 'd1',
  USER_ID: process.env.MYA_USER_ID,
  DISCORD_COLLAB_CHANNEL: process.env.DISCORD_COLLAB_CHANNEL,
  SENTRY_DSN: process.env.SENTRY_DSN,
  SENTRY_ORG: process.env.SENTRY_ORG,
  SENTRY_PROJECT: process.env.SENTRY_PROJECT,
  SENTRY_API_BASE: process.env.SENTRY_API_BASE || 'https://de.sentry.io',
  GOOGLE_SERVICE_ACCOUNT_FILE: process.env.GOOGLE_SERVICE_ACCOUNT_FILE,
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  POLYMARKET_API_URL: process.env.POLYMARKET_API_URL,
  POLYMARKET_API_USER: process.env.POLYMARKET_API_USER,
  WARROOM_PATH: process.env.WARROOM_PATH,
  // Split-jurisdiction KMS (Swiss KEK server)
  KMS_URL: process.env.KMS_URL || '',
  KMS_CERT_PATH: process.env.KMS_CERT_PATH || '/etc/mycelium/kms-certs',
  KMS_TTL_HOURS: process.env.KMS_TTL_HOURS || '72',
  // Default scope: org only. Per-agent overrides below for personal/wealth/moms.
  AGENT_SCOPES: '["org"]',
};

// Apply filter_env to every app definition without modifying each one inline.
// PM2 reads filter_env at process spawn time and excludes those vars from the
// process env it captures (which then gets dumped via pm2 save).
const _withFilterEnv = (apps) => apps.map(app => ({ ...app, filter_env: FILTER_ENV }));

module.exports = {
  apps: _withFilterEnv([
    // Main Orchestrator
    {
      name: 'orchestrator',
      script: 'orchestrator.js',
      cwd: __dirname,
      interpreter: 'node',
      interpreter_args: '--experimental-modules',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        MYA_WORKER_URL: process.env.MYA_WORKER_URL,
        AGENT_TOKEN: process.env.AGENT_TOKEN_ORCHESTRATOR,
        ORCHESTRATOR_PORT: 3000,
        FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:3000',

        // GitHub OAuth (for agent repos)
        GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,

        // Discord Bot
        DISCORD_ALLOWED_SERVERS: process.env.DISCORD_ALLOWED_SERVERS,
        DISCORD_ALLOWED_USERS: process.env.DISCORD_ALLOWED_USERS,
        DISCORD_COMPANY_CHANNEL: process.env.DISCORD_COMPANY_CHANNEL,
        DISCORD_RESEARCH_CHANNEL: process.env.DISCORD_RESEARCH_CHANNEL,
        DISCORD_COMMERCIAL_INTEL_CHANNEL: process.env.DISCORD_COMMERCIAL_INTEL_CHANNEL,
        DISCORD_PUBLISHING_CHANNEL: process.env.DISCORD_PUBLISHING_CHANNEL,
        DISCORD_BUILDER_CHANNEL: process.env.DISCORD_BUILDER_CHANNEL,
        DISCORD_COLLAB_CHANNEL: process.env.DISCORD_COLLAB_CHANNEL,
        DISCORD_WEALTH_CHANNEL: process.env.DISCORD_WEALTH_CHANNEL,

        OWNER_TELEGRAM_ID: process.env.OWNER_TELEGRAM_ID,
        SCHEDULER_TIMEZONE: process.env.SCHEDULER_TIMEZONE || 'Europe/Riga',
        DISCORD_ALERTS_CHANNEL: process.env.DISCORD_ALERTS_CHANNEL,
        TELEGRAM_BOT_PORT: 3003,

        // DB abstraction (orchestrator uses lib/db.js for sessions, identities, etc.)
        DB_BACKEND: process.env.DB_BACKEND || 'd1',
        MYA_WORKER_URL: process.env.MYA_WORKER_URL,
        SENTRY_DSN: process.env.SENTRY_DSN,
      },
      error_file: '/var/log/mycelium/orchestrator-error.log',
      out_file: '/var/log/mycelium/orchestrator-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // Example: Research Agent
    // Port: 5002
    {
      name: 'research-agent',
      script: 'agent-server.js',
      cwd: __dirname,
      interpreter: 'node',
      interpreter_args: '--experimental-modules',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '1G',
      env: {
        ...SHARED_AGENT_ENV,
        PORT: 5002,
        AGENT_ID: 'research-agent',
        AGENT_TIER: '1',
        MEMORY_SCOPE: 'research',
        DISCORD_CHANNEL: process.env.DISCORD_RESEARCH_CHANNEL,
        DISCORD_BOT_URL: 'http://localhost:5003',
        // Ada: opus for chat/think, sonnet for spawned research sub-tasks
        MODEL: 'opus',
        MODEL_THINK: 'opus',
        MODEL_CHAT: 'opus',
        MODEL_SPAWN: 'opus',
        ...(process.env.CLAUDE_CONFIG_DIR_ADA ? { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR_ADA } : {}),
        ...(process.env.AGENT_TOKEN_ADA ? { AGENT_TOKEN: process.env.AGENT_TOKEN_ADA } : {}),
      },
      error_file: '/var/log/mycelium/research-error.log',
      out_file: '/var/log/mycelium/research-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // Example: Research Agent Discord Bot
    {
      name: 'research-discord-bot',
      script: 'research-discord-bot.js',
      cwd: __dirname,
      interpreter: 'node',
      interpreter_args: '--experimental-modules',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
        MYA_WORKER_URL: process.env.MYA_WORKER_URL,
        AGENT_TOKEN: process.env.AGENT_TOKEN_ADA,
        DISCORD_RESEARCH_CHANNEL: process.env.DISCORD_RESEARCH_CHANNEL,
        DISCORD_COLLAB_CHANNEL: process.env.DISCORD_COLLAB_CHANNEL,
        DISCORD_ALLOWED_SERVERS: process.env.DISCORD_ALLOWED_SERVERS,
        RESEARCH_AGENT_URL: 'http://localhost:5002',
        CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
        SENTRY_DSN: process.env.SENTRY_DSN,
      },
      error_file: '/var/log/mycelium/research-bot-error.log',
      out_file: '/var/log/mycelium/research-bot-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // Example: Commercial Intelligence Agent
    // Port: 5004
    {
      name: 'commercial-intelligence-agent',
      script: 'agent-server.js',
      cwd: __dirname,
      interpreter: 'node',
      interpreter_args: '--experimental-modules',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '1G',
      env: {
        ...SHARED_AGENT_ENV,
        PORT: 5004,
        AGENT_ID: 'commercial-intelligence-agent',
        AGENT_TIER: '1',
        MEMORY_SCOPE: 'commercial-intelligence',
        DISCORD_CHANNEL: process.env.DISCORD_COMMERCIAL_INTEL_CHANNEL,
        DISCORD_BOT_URL: 'http://localhost:5005',
        // Rex runs on Opus for deeper commercial analysis
        MODEL: 'opus',
        MODEL_THINK: 'opus',
        MODEL_CHAT: 'opus',
        ...(process.env.CLAUDE_CONFIG_DIR_REX ? { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR_REX } : {}),
        ...(process.env.AGENT_TOKEN_REX ? { AGENT_TOKEN: process.env.AGENT_TOKEN_REX } : {}),
      },
      error_file: '/var/log/mycelium/cipher-error.log',
      out_file: '/var/log/mycelium/cipher-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // Rex — Commercial Intelligence Discord Bot
    {
      name: 'commercial-intel-discord-bot',
      script: 'commercial-intel-discord-bot.js',
      cwd: __dirname,
      interpreter: 'node',
      interpreter_args: '--experimental-modules',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
        MYA_WORKER_URL: process.env.MYA_WORKER_URL,
        AGENT_TOKEN: process.env.AGENT_TOKEN_REX,
        DISCORD_COMMERCIAL_INTEL_CHANNEL: process.env.DISCORD_COMMERCIAL_INTEL_CHANNEL,
        DISCORD_COLLAB_CHANNEL: process.env.DISCORD_COLLAB_CHANNEL,
        DISCORD_ALLOWED_SERVERS: process.env.DISCORD_ALLOWED_SERVERS,
        COMMERCIAL_INTEL_AGENT_URL: process.env.COMMERCIAL_INTEL_AGENT_URL || 'http://localhost:5004',
        CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
        SENTRY_DSN: process.env.SENTRY_DSN,
      },
      error_file: '/var/log/mycelium/rex-bot-error.log',
      out_file: '/var/log/mycelium/rex-bot-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // Apollo — Intelligence Agent
    // Port: 5012
    {
      name: 'intel-agent',
      script: 'agent-server.js',
      cwd: __dirname,
      interpreter: 'node',
      interpreter_args: '--experimental-modules',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '1G',
      env: {
        ...SHARED_AGENT_ENV,
        PORT: 5012,
        AGENT_ID: 'intel-agent',
        AGENT_TIER: '1',
        MEMORY_SCOPE: 'intel',
        DISCORD_CHANNEL: process.env.DISCORD_INTEL_CHANNEL,
        DISCORD_BOT_URL: 'http://localhost:5013',
        MODEL: 'opus',
        MODEL_THINK: 'opus',
        MODEL_CHAT: 'opus',
        ...(process.env.CLAUDE_CONFIG_DIR_APOLLO ? { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR_APOLLO } : {}),
        ...(process.env.AGENT_TOKEN_APOLLO ? { AGENT_TOKEN: process.env.AGENT_TOKEN_APOLLO } : {}),
      },
      error_file: '/var/log/mycelium/intel-error.log',
      out_file: '/var/log/mycelium/intel-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // Apollo — Intelligence Discord Bot
    {
      name: 'intel-discord-bot',
      script: 'intel-discord-bot.js',
      cwd: __dirname,
      interpreter: 'node',
      interpreter_args: '--experimental-modules',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
        MYA_WORKER_URL: process.env.MYA_WORKER_URL,
        AGENT_TOKEN: process.env.AGENT_TOKEN_APOLLO,
        DISCORD_INTEL_CHANNEL: process.env.DISCORD_INTEL_CHANNEL,
        DISCORD_COLLAB_CHANNEL: process.env.DISCORD_COLLAB_CHANNEL,
        DISCORD_ALLOWED_SERVERS: process.env.DISCORD_ALLOWED_SERVERS,
        DISCORD_ALLOWED_USERS: process.env.DISCORD_ALLOWED_USERS,
        INTEL_AGENT_URL: process.env.INTEL_AGENT_URL || 'http://localhost:5012',
        APOLLO_BOT_PORT: '5013',
        CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
        SENTRY_DSN: process.env.SENTRY_DSN,
      },
      error_file: '/var/log/mycelium/apollo-bot-error.log',
      out_file: '/var/log/mycelium/apollo-bot-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // Intel Scheduler — War Room briefing cycle for Apollo
    // 4h war room briefs, morning intel summary, evening sitrep, weekly assessment
    {
      name: 'intel-scheduler',
      script: 'lib/scheduler-intel.js',
      cwd: __dirname,
      interpreter: 'node',
      interpreter_args: '--experimental-modules',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
        AGENT_URL: 'http://localhost:5012',
        SCHEDULER_TIMEZONE: process.env.SCHEDULER_TIMEZONE || 'Europe/London',
        USER_ID: process.env.MYA_USER_ID,
        MYA_WORKER_URL: process.env.MYA_WORKER_URL,
        SENTRY_DSN: process.env.SENTRY_DSN,
      },
      error_file: '/var/log/mycelium/intel-scheduler-error.log',
      out_file: '/var/log/mycelium/intel-scheduler-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // War Room Daemon — ingests RSS, Polymarket, GDELT, processes events/narratives
    {
      name: 'warroom-daemon',
      script: 'main.py',
      cwd: process.env.WARROOM_PATH || '/home/claude/repos/war-room',
      interpreter: (process.env.WARROOM_PATH || '/home/claude/repos/war-room') + '/.venv/bin/python3',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '512M',
      env: {
        POLYMARKET_INTEL_URL: process.env.POLYMARKET_INTEL_URL || process.env.POLYMARKET_API_URL,
        POLYMARKET_INTEL_USER: process.env.POLYMARKET_INTEL_USER || process.env.POLYMARKET_API_USER,
        ACLED_EMAIL: process.env.ACLED_EMAIL,
      },
      error_file: '/var/log/mycelium/warroom-daemon-error.log',
      out_file: '/var/log/mycelium/warroom-daemon-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // War Room Dashboard — FastAPI dashboard for strategic map
    // Serves /api/state, /api/events, /api/actors etc.
    {
      name: 'warroom-dashboard',
      script: '.venv/bin/uvicorn',
      args: 'dashboard.app:app --host 127.0.0.1 --port 8050',
      cwd: process.env.WARROOM_PATH || '/home/claude/repos/war-room',
      interpreter: (process.env.WARROOM_PATH || '/home/claude/repos/war-room') + '/.venv/bin/python3',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '256M',
      env: {
        POLYMARKET_INTEL_URL: process.env.POLYMARKET_INTEL_URL || process.env.POLYMARKET_API_URL,
        POLYMARKET_INTEL_USER: process.env.POLYMARKET_INTEL_USER || process.env.POLYMARKET_API_USER,
      },
      error_file: '/var/log/mycelium/warroom-dashboard-error.log',
      out_file: '/var/log/mycelium/warroom-dashboard-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // Mom's Agent — Latvian personal agent with intel relay
    // Port: 5014 (Telegram, no Discord)
    ...(process.env.MOMS_USER_ID ? [{
      name: 'moms-agent',
      script: 'agent-server.js',
      cwd: __dirname,
      interpreter: 'node',
      interpreter_args: '--experimental-modules',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '512M',
      env: {
        ...SHARED_AGENT_ENV,
        // Override inherited OWNER_TELEGRAM_ID for this agent's own Telegram user
        OWNER_TELEGRAM_ID: process.env.MOMS_TELEGRAM_ID,
        PORT: 5014,
        AGENT_ID: 'moms-agent',
        AGENT_TIER: '2',
        AGENT_SCOPES: '["moms","org"]',
        MEMORY_SCOPE: 'moms',
        DISCORD_CHANNEL: '',
        DISCORD_BOT_URL: '',
        TELEGRAM_BOT_URL: 'http://localhost:5015',
        USER_ID: process.env.MOMS_USER_ID,
        MODEL: 'opus',
        MODEL_THINK: 'opus',
        MODEL_CHAT: 'opus',
        ...(process.env.CLAUDE_CONFIG_DIR_MOM ? { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR_MOM } : {}),
        ...(process.env.AGENT_TOKEN_MOM ? { AGENT_TOKEN: process.env.AGENT_TOKEN_MOM } : {}),
      },
      error_file: '/var/log/mycelium/moms-agent-error.log',
      out_file: '/var/log/mycelium/moms-agent-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
    // Mom's Telegram Bot — bridges Telegram messages to moms-agent
    // Port: 5015
    {
      name: 'moms-telegram-bot',
      script: 'telegram-bot.js',
      cwd: __dirname,
      interpreter: 'node',
      interpreter_args: '--experimental-modules',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '256M',
      restart_delay: 10000,
      min_uptime: 60000,
      max_restarts: 5,
      kill_timeout: 8000,
      env: {
        NODE_ENV: 'production',
        AGENT_ID: 'moms-telegram-bot',
        MYA_WORKER_URL: process.env.MYA_WORKER_URL,
        AGENT_TOKEN: process.env.AGENT_TOKEN_MOM,
        OWNER_TELEGRAM_ID: process.env.MOMS_TELEGRAM_ID,
        AGENT_URL: 'http://localhost:5014',
        TELEGRAM_BOT_PORT: 5015,
        USER_ID: process.env.MOMS_USER_ID,
        // Explicit bot token — prevents bootstrap-secrets from loading Mya's token
        TELEGRAM_BOT_TOKEN_OVERRIDE: process.env.TELEGRAM_BOT_TOKEN_MOM,
        TTS_VOICE: 'shimmer',
        SENTRY_DSN: process.env.SENTRY_DSN,
      },
      error_file: '/var/log/mycelium/moms-telegram-error.log',
      out_file: '/var/log/mycelium/moms-telegram-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
    // Mom's Scheduler — polls SITUATION_REPORT.md, triggers Latvian translation
    {
      name: 'moms-scheduler',
      script: 'scheduler-mom.js',
      cwd: process.env.MOMS_AGENT_PATH || '/home/claude/repos/moms-agent',
      interpreter: 'node',
      interpreter_args: '--experimental-modules',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '128M',
      env: {
        NODE_ENV: 'production',
        AGENT_URL: 'http://localhost:5014',
        WARROOM_PATH: process.env.WARROOM_PATH,
        SCHEDULER_TIMEZONE: 'Europe/Riga',
        MOMS_TELEGRAM_CHAT_ID: process.env.MOMS_TELEGRAM_ID,
        TELEGRAM_BOT_URL: 'http://localhost:5015',
        SENTRY_DSN: process.env.SENTRY_DSN,
      },
      error_file: '/var/log/mycelium/moms-scheduler-error.log',
      out_file: '/var/log/mycelium/moms-scheduler-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    }] : []),

    // Company Agent (Com) — the main company-facing agent
    // Port: 3002 (legacy, doesn't follow formula)
    // Discord: uses the orchestrator's bot (port 3001)
    {
      name: 'company-agent',
      script: 'agent-server.js',
      cwd: __dirname,
      interpreter: 'node',
      interpreter_args: '--experimental-modules',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '1G',
      env: {
        ...SHARED_AGENT_ENV,
        PORT: 3002,
        AGENT_ID: 'company-agent',
        AGENT_TIER: '1',
        MEMORY_SCOPE: 'company',
        DISCORD_CHANNEL: process.env.DISCORD_COMPANY_CHANNEL,
        DISCORD_BOT_URL: 'http://localhost:3001',
        // Com runs on Opus — best reasoning, can spin up agent teams
        MODEL: 'opus',
        MODEL_THINK: 'opus',
        MODEL_CHAT: 'opus',
        ...(process.env.CLAUDE_CONFIG_DIR_COM ? { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR_COM } : {}),
        ...(process.env.AGENT_TOKEN_COM ? { AGENT_TOKEN: process.env.AGENT_TOKEN_COM } : {}),
        // Sentry error poller moved to qa-agent — Com delegates bug-fixing to QA
        // SENTRY_POLL_ENABLED: 'true',  // Now on qa-agent
      },
      error_file: '/var/log/mycelium/company-error.log',
      out_file: '/var/log/mycelium/company-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // Noa — Publishing Agent
    // Port: 5006
    {
      name: 'publishing-agent',
      script: 'agent-server.js',
      cwd: __dirname,
      interpreter: 'node',
      interpreter_args: '--experimental-modules',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '1G',
      env: {
        ...SHARED_AGENT_ENV,
        PORT: 5006,
        AGENT_ID: 'publishing-agent',
        AGENT_TIER: '1',
        MEMORY_SCOPE: 'publishing',
        DISCORD_CHANNEL: process.env.DISCORD_PUBLISHING_CHANNEL,
        DISCORD_BOT_URL: 'http://localhost:5007',
        // Noa runs on Opus for deeper publishing and editorial reasoning
        MODEL: 'opus',
        MODEL_THINK: 'opus',
        MODEL_CHAT: 'opus',
        ...(process.env.CLAUDE_CONFIG_DIR_NOA ? { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR_NOA } : {}),
        ...(process.env.AGENT_TOKEN_NOA ? { AGENT_TOKEN: process.env.AGENT_TOKEN_NOA } : {}),
      },
      error_file: '/var/log/mycelium/publishing-error.log',
      out_file: '/var/log/mycelium/publishing-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // Noa — Publishing Discord Bot
    {
      name: 'publishing-discord-bot',
      script: 'publishing-discord-bot.js',
      cwd: __dirname,
      interpreter: 'node',
      interpreter_args: '--experimental-modules',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
        MYA_WORKER_URL: process.env.MYA_WORKER_URL,
        AGENT_TOKEN: process.env.AGENT_TOKEN_NOA,
        DISCORD_PUBLISHING_CHANNEL: process.env.DISCORD_PUBLISHING_CHANNEL,
        DISCORD_COLLAB_CHANNEL: process.env.DISCORD_COLLAB_CHANNEL,
        DISCORD_ALLOWED_SERVERS: process.env.DISCORD_ALLOWED_SERVERS,
        PUBLISHING_AGENT_URL: 'http://localhost:5006',
        NOA_BOT_PORT: 5007,
        SENTRY_DSN: process.env.SENTRY_DSN,
      },
      error_file: '/var/log/mycelium/publishing-bot-error.log',
      out_file: '/var/log/mycelium/publishing-bot-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // Mya — Personal Agent (private, sees everything)
    // Port: 3004
    // Separate from company-agent: has full memory scope, internal model, dreams
    {
      name: 'personal-agent',
      script: 'agent-server.js',
      cwd: __dirname,
      interpreter: 'node',
      interpreter_args: '--experimental-modules',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '1G',
      env: {
        ...SHARED_AGENT_ENV,
        PORT: 3004,
        AGENT_ID: 'personal-agent',
        AGENT_TIER: '1',
        AGENT_SCOPES: '["personal","org"]',
        MEMORY_SCOPE: 'all',
        BIND_HOST: '127.0.0.1',
        USER_ID: process.env.MYA_USER_ID,
        TELEGRAM_BOT_URL: 'http://localhost:3003',
        ...(process.env.WHATSAPP_ALLOWED_NUMBERS ? { WHATSAPP_BOT_URL: 'http://localhost:5011' } : {}),
        DISCORD_BOT_URL: 'http://localhost:5009',
        MYA_WORKER_URL: process.env.MYA_WORKER_URL,
        // Mya runs on Opus for personal reasoning and depth
        MODEL: 'opus',
        MODEL_THINK: 'opus',
        MODEL_CHAT: 'opus',
        ...(process.env.CLAUDE_CONFIG_DIR_MYA ? { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR_MYA } : {}),
        ...(process.env.AGENT_TOKEN_MYA ? { AGENT_TOKEN: process.env.AGENT_TOKEN_MYA } : {}),
        // Gmail poller (checks unread, triggers /think)
        GMAIL_POLL_ENABLED: process.env.GMAIL_POLL_ENABLED || 'false',
        GMAIL_POLL_INTERVAL_MINUTES: process.env.GMAIL_POLL_INTERVAL_MINUTES || '5',
        // Passkey auth (portal served by this agent-server)
        PASSKEY_RP_ID: process.env.PASSKEY_RP_ID || 'localhost',
        PASSKEY_RP_NAME: process.env.PASSKEY_RP_NAME || 'Mycelium',
        PASSKEY_RP_ORIGIN: process.env.PASSKEY_RP_ORIGIN || 'http://localhost:3004',
      },
      error_file: '/var/log/mycelium/personal-error.log',
      out_file: '/var/log/mycelium/personal-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // Mya — Telegram Bot (personal interface)
    // Port: 3003 (HTTP API for proactive messaging)
    // Routes to personal-agent (3004), NOT company-agent (3002)
    {
      name: 'mya-telegram-bot',
      script: 'telegram-bot.js',
      cwd: __dirname,
      interpreter: 'node',
      interpreter_args: '--experimental-modules',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '512M',
      // Crash loop protection: wait 10s between restarts, must run 60s to count as healthy,
      // give up after 5 fast crashes, give 8s for graceful shutdown
      restart_delay: 10000,
      min_uptime: 60000,
      max_restarts: 5,
      kill_timeout: 8000,
      env: {
        NODE_ENV: 'production',
        AGENT_ID: 'mya-telegram-bot',
        MYA_WORKER_URL: process.env.MYA_WORKER_URL,
        AGENT_TOKEN: process.env.AGENT_TOKEN_MYA,
        OWNER_TELEGRAM_ID: process.env.OWNER_TELEGRAM_ID,
        AGENT_URL: 'http://localhost:3004',
        TELEGRAM_BOT_PORT: 3003,
        USER_ID: process.env.MYA_USER_ID,
        // Attachment processing (R2 storage, transcription, AI description)
        MYA_WORKER_URL: process.env.MYA_WORKER_URL,
        CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
        DB_BACKEND: process.env.DB_BACKEND || 'd1',
        SENTRY_DSN: process.env.SENTRY_DSN,
      },
      error_file: '/var/log/mycelium/telegram-bot-error.log',
      out_file: '/var/log/mycelium/telegram-bot-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // Mya — Discord Bot (personal agent, @mention-only)
    // Port: 5009 (HTTP API for proactive messaging)
    // No dedicated channel — responds when @mentioned in any channel
    {
      name: 'mya-discord-bot',
      script: 'personal-discord-bot.js',
      cwd: __dirname,
      interpreter: 'node',
      interpreter_args: '--experimental-modules',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
        MYA_WORKER_URL: process.env.MYA_WORKER_URL,
        AGENT_TOKEN: process.env.AGENT_TOKEN_MYA,
        DISCORD_COLLAB_CHANNEL: process.env.DISCORD_COLLAB_CHANNEL,
        DISCORD_ALLOWED_SERVERS: process.env.DISCORD_ALLOWED_SERVERS,
        PERSONAL_AGENT_URL: 'http://localhost:3004',
        MYA_CHANNEL_ID: process.env.MYA_CHANNEL_ID,
        MYA_BOT_PORT: 5009,
        SENTRY_DSN: process.env.SENTRY_DSN,
      },
      error_file: '/var/log/mycelium/mya-discord-bot-error.log',
      out_file: '/var/log/mycelium/mya-discord-bot-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // Mya — WhatsApp Bot (personal interface)
    // Port: 5011 (HTTP API for proactive messaging)
    // Routes to personal-agent (3004)
    // Only included when WHATSAPP_ALLOWED_NUMBERS is configured
    ...(process.env.WHATSAPP_ALLOWED_NUMBERS ? [{
      name: 'mya-whatsapp-bot',
      script: 'whatsapp-bot.js',
      cwd: __dirname,
      interpreter: 'node',
      interpreter_args: '--experimental-modules',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
        MYA_WORKER_URL: process.env.MYA_WORKER_URL,
        AGENT_TOKEN: process.env.AGENT_TOKEN_MYA,
        WHATSAPP_ALLOWED_NUMBERS: process.env.WHATSAPP_ALLOWED_NUMBERS,
        WHATSAPP_ROUTES: process.env.WHATSAPP_ROUTES || '',
        AGENT_URL: 'http://localhost:3004',
        WHATSAPP_BOT_PORT: 5011,
        USER_ID: process.env.MYA_USER_ID,
        // Attachment processing (R2 storage, transcription, AI description)
        MYA_WORKER_URL: process.env.MYA_WORKER_URL,
        CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
        DB_BACKEND: process.env.DB_BACKEND || 'd1',
        SENTRY_DSN: process.env.SENTRY_DSN,
      },
      error_file: '/var/log/mycelium/whatsapp-bot-error.log',
      out_file: '/var/log/mycelium/whatsapp-bot-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    }] : []),

    // Com — Scheduler (COO cycles for company agent)
    // Drives 3h COO cycles, morning briefs, EOD wraps, weekly strategic reviews
    {
      name: 'com-scheduler',
      script: 'lib/scheduler-company.js',
      cwd: __dirname,
      interpreter: 'node',
      interpreter_args: '--experimental-modules',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
        AGENT_URL: 'http://localhost:3002',
        SCHEDULER_TIMEZONE: process.env.SCHEDULER_TIMEZONE || 'Europe/London',
        USER_ID: process.env.MYA_USER_ID,
        MYA_WORKER_URL: process.env.MYA_WORKER_URL,
        SENTRY_DSN: process.env.SENTRY_DSN,
      },
      error_file: '/var/log/mycelium/com-scheduler-error.log',
      out_file: '/var/log/mycelium/com-scheduler-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // Mya — Scheduler (scheduled jobs for personal agent)
    // Drives dreams, reflections, check-ins, weekly reviews
    {
      name: 'mya-scheduler',
      script: 'lib/scheduler.js',
      cwd: __dirname,
      interpreter: 'node',
      interpreter_args: '--experimental-modules',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
        AGENT_URL: 'http://localhost:3004',
        TELEGRAM_BOT_URL: 'http://localhost:3003',
        SCHEDULER_TIMEZONE: process.env.SCHEDULER_TIMEZONE || 'Europe/Riga',
        USER_ID: process.env.MYA_USER_ID,
        MYA_WORKER_URL: process.env.MYA_WORKER_URL,
        SENTRY_DSN: process.env.SENTRY_DSN,
      },
      error_file: '/var/log/mycelium/scheduler-error.log',
      out_file: '/var/log/mycelium/scheduler-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // Portal — Mycelium web frontend (SvelteKit)
    {
      name: 'mycelium-portal',
      script: 'portal/build/index.js',
      cwd: __dirname,
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
        PORT: 5173,
        AGENT_URL: 'http://localhost:3004',
        PASSKEY_RP_ID: process.env.PASSKEY_RP_ID || 'localhost',
        PASSKEY_RP_NAME: process.env.PASSKEY_RP_NAME || 'Mycelium',
        PASSKEY_RP_ORIGIN: process.env.PASSKEY_RP_ORIGIN || 'http://localhost:5173',
      },
      error_file: '/var/log/mycelium/portal-error.log',
      out_file: '/var/log/mycelium/portal-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // Watchdog — checks all services every 5 minutes, restarts if down
    // Also checks agent git repos for stale locks and disk space
    {
      name: 'watchdog',
      script: 'scripts/watchdog.sh',
      cwd: __dirname,
      interpreter: 'bash',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      cron_restart: '*/5 * * * *',
      autorestart: false,
      env: {
        WARROOM_PATH: process.env.WARROOM_PATH,
        AGENT_REPOS_DIR: '/home/claude/agents',
        DISCORD_ALERT_WEBHOOK: process.env.DISCORD_ALERT_WEBHOOK || '',
      },
      error_file: '/var/log/mycelium/watchdog-error.log',
      out_file: '/var/log/mycelium/watchdog-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // Clustering — nightly UMAP + HDBSCAN semantic clustering cycle
    // Syncs content → clustering_points, runs clustering, generates descriptions
    {
      name: 'clustering-cron',
      script: 'scripts/run-clustering.sh',
      cwd: __dirname,
      interpreter: 'bash',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      cron_restart: '0 2 * * *',  // Run at 2am daily (before 3am integration cycle)
      autorestart: false,         // Don't auto-restart — cron handles scheduling
      env: {
        PATH: `${__dirname}/scripts/.venv/bin:${process.env.PATH}`,
      },
      error_file: '/var/log/mycelium/clustering-error.log',
      out_file: '/var/log/mycelium/clustering-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // llama-server — local LLM for message tagging (Qwen2.5-3B Q4_K_M)
    // Auto-unloads model after 5min idle (--sleep-idle-seconds 300)
    // OpenAI-compatible API on port 8090
    {
      name: 'llama-server',
      script: '/usr/local/bin/llama-server',
      args: '--model /opt/models/qwen2.5-3b-instruct-q4_k_m.gguf --port 8090 --host 127.0.0.1 --threads 2 --ctx-size 4096 --sleep-idle-seconds 300 --log-disable',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      autorestart: true,
      max_restarts: 5,
      restart_delay: 10000,
      max_memory_restart: '3G',
      error_file: '/var/log/mycelium/llama-server-error.log',
      out_file: '/var/log/mycelium/llama-server-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // BGE-M3 Embedding Service — local ONNX for 1024D search vectors
    // Auto-unloads model after 5min idle
    // HTTP API on port 8091
    {
      name: 'bge-m3-embed',
      script: 'scripts/bge-m3-embed.py',
      args: '--serve --port 8091',
      interpreter: `${__dirname}/scripts/.venv/bin/python3`,
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      autorestart: true,
      max_restarts: 5,
      restart_delay: 10000,
      max_memory_restart: '2G',
      error_file: '/var/log/mycelium/bge-m3-error.log',
      out_file: '/var/log/mycelium/bge-m3-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // Local Enrichment Service — orchestrates tagging + embedding
    // Replaces enrichment-daemon.js (no more Cloudflare Workers AI dependency)
    // HTTP API on port 8095 (receives fire-and-forget from agent-server)
    {
      name: 'enrichment-service',
      script: 'scripts/enrichment-service.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 30000,
      env: {
        ...SHARED_AGENT_ENV,
        AGENT_TOKEN: process.env.AGENT_TOKEN_ENRICHMENT,
        ENRICHMENT_PORT: 8095,
      },
      error_file: '/var/log/mycelium/enrichment-service-error.log',
      out_file: '/var/log/mycelium/enrichment-service-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // QA Agent — headless worker for self-modification and automatic bug fixing
    // Port: 5008 (no Discord bot — reports via #bug-reports)
    // Owns Sentry error polling, test verification, auto-fix pipeline
    {
      name: 'qa-agent',
      script: 'agent-server.js',
      cwd: __dirname,
      interpreter: 'node',
      interpreter_args: '--experimental-modules',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '1G',
      env: {
        ...SHARED_AGENT_ENV,
        PORT: 5008,
        AGENT_ID: 'qa-agent',
        AGENT_TIER: '1',
        MEMORY_SCOPE: 'qa',
        // No dedicated Discord channel — uses #bug-reports for output
        DISCORD_CHANNEL: process.env.DISCORD_BUG_REPORTS_CHANNEL,
        // QA doesn't have its own Discord bot — uses /discord/send to post
        DISCORD_BOT_URL: 'http://localhost:3001',
        // QA runs on Opus for deep code reasoning during auto-fixes
        MODEL: 'opus',
        MODEL_THINK: 'opus',
        MODEL_CHAT: 'opus',
        // Sentry error poller — QA auto-investigates and fixes new errors
        SENTRY_POLL_ENABLED: 'false',
        SENTRY_POLL_INTERVAL_MINUTES: '5',
        DISCORD_BUG_REPORTS_CHANNEL: process.env.DISCORD_BUG_REPORTS_CHANNEL,
        ...(process.env.AGENT_TOKEN_QA ? { AGENT_TOKEN: process.env.AGENT_TOKEN_QA } : {}),
      },
      error_file: '/var/log/mycelium/qa-error.log',
      out_file: '/var/log/mycelium/qa-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // Rob — Wealth Intelligence Agent
    // Port: 5010, Discord bot: 5011
    {
      name: 'wealth-agent',
      script: 'agent-server.js',
      cwd: __dirname,
      interpreter: 'node',
      interpreter_args: '--experimental-modules',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '1G',
      env: {
        ...SHARED_AGENT_ENV,
        ...(process.env.CLAUDE_CONFIG_DIR_ROB ? { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR_ROB } : {}),
        ...(process.env.AGENT_TOKEN_ROB ? { AGENT_TOKEN: process.env.AGENT_TOKEN_ROB } : {}),
        PORT: 5010,
        AGENT_ID: 'wealth-agent',
        AGENT_TIER: '1',
        AGENT_SCOPES: '["wealth","org"]',
        MEMORY_SCOPE: 'wealth',
        DISCORD_CHANNEL: process.env.DISCORD_WEALTH_CHANNEL,
        DISCORD_BOT_URL: 'http://localhost:5011',
        // Coinbase Developer Platform (wallet infrastructure)
        CDP_API_KEY_ID: process.env.CDP_API_KEY_ID,
        // Polymarket CLOB trading (Polygon wallet)
        // Session decomposition: standard turns per session, auto-continue on turn limit
        MAX_TURNS: 30,
        MAX_CONTINUATIONS: 3, // up to 4 × 30 = 120 effective turns for multi-step financial ops
        // Rob runs on Opus for financial reasoning depth
        MODEL: 'opus',
        MODEL_THINK: 'opus',
        MODEL_CHAT: 'opus',
      },
      error_file: '/var/log/mycelium/wealth-error.log',
      out_file: '/var/log/mycelium/wealth-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // Rob — Wealth Scheduler (morning + evening portfolio reviews, weekly report)
    {
      name: 'wealth-scheduler',
      script: 'lib/scheduler-wealth.js',
      cwd: __dirname,
      interpreter: 'node',
      interpreter_args: '--experimental-modules',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '128M',
      env: {
        NODE_ENV: 'production',
        AGENT_URL: 'http://localhost:5010',
        SCHEDULER_TIMEZONE: process.env.SCHEDULER_TIMEZONE || 'Europe/Riga',
        USER_ID: process.env.MYA_USER_ID,
        MYA_WORKER_URL: process.env.MYA_WORKER_URL,
        MYA_WORKER_AUTH: process.env.MYA_WORKER_AUTH,
        SENTRY_DSN: process.env.SENTRY_DSN,
      },
      error_file: '/var/log/mycelium/wealth-scheduler-error.log',
      out_file: '/var/log/mycelium/wealth-scheduler-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // Rob — Wealth Agent Discord Bot
    {
      name: 'wealth-discord-bot',
      script: 'wealth-agent-discord-bot.js',
      cwd: __dirname,
      interpreter: 'node',
      interpreter_args: '--experimental-modules',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
        MYA_WORKER_URL: process.env.MYA_WORKER_URL,
        AGENT_TOKEN: process.env.AGENT_TOKEN_ROB,
        DISCORD_WEALTH_CHANNEL: process.env.DISCORD_WEALTH_CHANNEL,
        DISCORD_COLLAB_CHANNEL: process.env.DISCORD_COLLAB_CHANNEL,
        DISCORD_ALLOWED_SERVERS: process.env.DISCORD_ALLOWED_SERVERS,
        WEALTH_AGENT_URL: 'http://localhost:5010',
        WEALTH_BOT_PORT: 5011,
        CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
        SENTRY_DSN: process.env.SENTRY_DSN,
      },
      error_file: '/var/log/mycelium/wealth-bot-error.log',
      out_file: '/var/log/mycelium/wealth-bot-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // LevOps — Operations Agent (document filing, invoice processing)
    // Port: 5016 (no Discord bot — reports via webhook)
    {
      name: 'ops-agent',
      script: 'agent-server.js',
      cwd: __dirname,
      interpreter: 'node',
      interpreter_args: '--experimental-modules',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '512M',
      env: {
        ...SHARED_AGENT_ENV,
        AGENT_ID: 'ops-agent',
        PORT: 5018,
        DISCORD_CHANNEL: '1489203476033441862',
        DISCORD_BOT_URL: 'http://localhost:5019',
        ...(process.env.AGENT_TOKEN_OPS ? { AGENT_TOKEN: process.env.AGENT_TOKEN_OPS } : {}),
      },
      error_file: '/var/log/mycelium/ops-agent-error.log',
      out_file: '/var/log/mycelium/ops-agent-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // LevOps — Ops Agent Discord Bot
    {
      name: 'ops-discord-bot',
      script: 'ops-discord-bot.js',
      cwd: __dirname,
      interpreter: 'node',
      interpreter_args: '--experimental-modules',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
        MYA_WORKER_URL: process.env.MYA_WORKER_URL,
        AGENT_TOKEN: process.env.AGENT_TOKEN_OPS,
        DISCORD_ADMIN_CHANNEL: '1489203476033441862',
        DISCORD_ALLOWED_SERVERS: process.env.DISCORD_ALLOWED_SERVERS,
        DISCORD_ALLOWED_USERS: process.env.DISCORD_ALLOWED_USERS,
        OPS_AGENT_URL: 'http://localhost:5018',
        OPS_BOT_PORT: 5019,
        SENTRY_DSN: process.env.SENTRY_DSN,
      },
      error_file: '/var/log/mycelium/ops-bot-error.log',
      out_file: '/var/log/mycelium/ops-bot-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // OwnTracks — Location receiver (webhook from mobile app)
    {
      name: 'owntracks-receiver',
      script: 'owntracks-receiver.js',
      cwd: __dirname,
      interpreter: 'node',
      interpreter_args: '--experimental-modules',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '128M',
      env: {
        NODE_ENV: 'production',
        MYA_WORKER_URL: process.env.MYA_WORKER_URL,
        AGENT_TOKEN: process.env.AGENT_TOKEN_ORCHESTRATOR,
        OWNTRACKS_PORT: 5020,
        OWNTRACKS_DATA_DIR: '/home/claude/data/location',
      },
      error_file: '/var/log/mycelium/owntracks-error.log',
      out_file: '/var/log/mycelium/owntracks-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // ── Provisioning daemon (managed hosting — runs from mycelium-managed repo) ──
    {
      name: 'provisioning-daemon',
      script: '../mycelium-managed/scripts/provisioning-daemon.js',
      cwd: __dirname,
      interpreter: 'node',
      interpreter_args: '--experimental-modules',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '128M',
      env: {
        NODE_ENV: 'production',
        ...SHARED_AGENT_ENV,
        AGENT_TOKEN: process.env.AGENT_TOKEN_ENRICHMENT,
        AGENT_ID: 'provisioning-daemon',
        MYCELIUM_HOME: __dirname,
      },
      error_file: '/var/log/mycelium/provisioning-error.log',
      out_file: '/var/log/mycelium/provisioning-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // Add more agents here using:
    //   ./scripts/add-agent.sh --id my-agent --name "My Agent" --port 5008 --bot-port 5009
    // Then add the PM2 entries it outputs to this file.
  ]),

  deploy: {
    production: {
      user: 'claude',
      host: process.env.DEPLOY_HOST || 'your-server.example.com',
      ref: 'origin/main',
      repo: 'git@github.com:your-org/mycelium.git',
      path: '/home/claude/mycelium',
      'pre-deploy-local': '',
      'post-deploy': 'npm install && cd portal && npm install && npm run build && cd .. && pm2 reload ecosystem.config.cjs --env production',
      'pre-setup': '',
      env: {
        NODE_ENV: 'production',
      },
    },
  },
};
