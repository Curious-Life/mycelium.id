#!/usr/bin/env bash
set -euo pipefail

# add-agent.sh — Provision a new Tier 1 agent in the MYA multi-agent system.
#
# Usage:
#   ./scripts/add-agent.sh --id qa-agent --name QA --port 5006 --bot-port 5007 \
#       --channel 123456789 --bot-token xyzBOTTOKEN --memory-scope qa
#
# What it does:
#   1. Creates agent directory structure via Node helper (ensureAgentStructure)
#   2. Generates a thin Discord bot config file using the unified AgentDiscordBot class
#   3. Writes a default system prompt
#   4. Appends env vars to .env
#   5. Appends PM2 entries to ecosystem.config.cjs
#   6. Optionally starts the agent via PM2
#
# Prerequisites:
#   - Node.js 22+
#   - PM2 installed globally (npm i -g pm2)
#   - Working MYA multi-agent-server setup

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(dirname "$SCRIPT_DIR")"

# ── Defaults ──────────────────────────────────────────────────────────
AGENT_ID=""
AGENT_NAME=""
PORT=""
BOT_PORT=""
CHANNEL_ID=""
BOT_TOKEN=""
MEMORY_SCOPE=""
AUTO_START=false

# ── Parse arguments ───────────────────────────────────────────────────
usage() {
  cat <<EOF
Usage: $0 [OPTIONS]

Required:
  --id <agent-id>         Agent identifier (e.g., qa-agent, writer-agent)
  --name <BotName>        Bot display name (e.g., QA, Writer)
  --port <port>           Agent server port (e.g., 5006)
  --bot-port <port>       Discord bot HTTP port (e.g., 5007)

Optional:
  --channel <id>          Discord channel ID for this agent
  --bot-token <token>     Discord bot token (or set later in .env)
  --memory-scope <scope>  Memory scope (defaults to agent-id)
  --start                 Auto-start via PM2 after provisioning
  -h, --help              Show this help message

Example:
  $0 --id qa-agent --name QA --port 5006 --bot-port 5007 --channel 123456789 --start
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --id)         AGENT_ID="$2";       shift 2 ;;
    --name)       AGENT_NAME="$2";     shift 2 ;;
    --port)       PORT="$2";           shift 2 ;;
    --bot-port)   BOT_PORT="$2";       shift 2 ;;
    --channel)    CHANNEL_ID="$2";     shift 2 ;;
    --bot-token)  BOT_TOKEN="$2";      shift 2 ;;
    --memory-scope) MEMORY_SCOPE="$2"; shift 2 ;;
    --start)      AUTO_START=true;     shift ;;
    -h|--help)    usage ;;
    *)            echo "Unknown option: $1"; usage ;;
  esac
done

# ── Validate required args ────────────────────────────────────────────
missing=()
[[ -z "$AGENT_ID" ]]   && missing+=("--id")
[[ -z "$AGENT_NAME" ]] && missing+=("--name")
[[ -z "$PORT" ]]       && missing+=("--port")
[[ -z "$BOT_PORT" ]]   && missing+=("--bot-port")

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Error: Missing required arguments: ${missing[*]}"
  echo "Run $0 --help for usage."
  exit 1
fi

[[ -z "$MEMORY_SCOPE" ]] && MEMORY_SCOPE="$AGENT_ID"

# Derive env var prefix from agent name (uppercase)
ENV_PREFIX=$(echo "$AGENT_NAME" | tr '[:lower:]' '[:upper:]')
BOT_SCRIPT="${AGENT_ID}-discord-bot.js"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  MYA Agent Provisioner                                      ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Agent ID:     $AGENT_ID"
echo "║  Bot Name:     $AGENT_NAME"
echo "║  Agent Port:   $PORT"
echo "║  Bot Port:     $BOT_PORT"
echo "║  Channel:      ${CHANNEL_ID:-<not set>}"
echo "║  Memory Scope: $MEMORY_SCOPE"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# ── Step 1: Create agent directory structure ──────────────────────────
echo "→ Step 1: Creating agent directory structure..."

node --input-type=module -e "
import { ensureAgentStructure, getAgentPaths } from '${SERVER_DIR}/lib/paths.js';
await ensureAgentStructure('${AGENT_ID}');
const paths = getAgentPaths('${AGENT_ID}');
console.log('  Agent root: ' + paths.root);
"

echo "  ✓ Directory structure created"
echo ""

# ── Step 2: Write default system prompt ───────────────────────────────
echo "→ Step 2: Writing default system prompt..."

AGENTS_ROOT="${AGENTS_ROOT:-$HOME/agents}"
PROMPT_FILE="${AGENTS_ROOT}/${AGENT_ID}/prompts/system.md"

if [[ ! -f "$PROMPT_FILE" ]]; then
  cat > "$PROMPT_FILE" <<PROMPT
# ${AGENT_NAME} Agent

You are ${AGENT_NAME}, a specialist agent in the MYA multi-agent system.

## Core Identity
- Agent ID: ${AGENT_ID}
- Role: Define your specific role and expertise here

## Guidelines
- Be direct and concise in your responses
- Use your memory files to maintain context between conversations
- When a task is outside your expertise, delegate to the appropriate agent
- Log important findings to your knowledge base

## Communication
- When responding to Discord messages, keep responses focused and actionable
- Use SILENT_REPLY when performing background work that doesn't need a user-facing response
- Use DELEGATE:agent-id when routing tasks to other agents
PROMPT
  echo "  ✓ System prompt created at: $PROMPT_FILE"
else
  echo "  ⊘ System prompt already exists, skipping"
fi
echo ""

# ── Step 3: Generate Discord bot config ───────────────────────────────
echo "→ Step 3: Generating Discord bot config..."

BOT_FILE="${SERVER_DIR}/${BOT_SCRIPT}"

if [[ ! -f "$BOT_FILE" ]]; then
  cat > "$BOT_FILE" <<BOTJS
/**
 * ${AGENT_NAME} Agent Discord Bot
 *
 * Dedicated Discord bot for the ${AGENT_ID} agent.
 * Uses the unified AgentDiscordBot class in single-agent mode.
 */

import 'dotenv/config';
import { AgentDiscordBot } from './lib/discord-bot.js';

const bot = new AgentDiscordBot({
  token: process.env.DISCORD_${ENV_PREFIX}_BOT_TOKEN,
  httpPort: parseInt(process.env.${ENV_PREFIX}_BOT_PORT || '${BOT_PORT}'),
  mode: 'single',
  botName: '${AGENT_NAME}',
  agentUrl: process.env.${ENV_PREFIX}_AGENT_URL || 'http://localhost:${PORT}',
  agentId: '${AGENT_ID}',
  channelId: process.env.DISCORD_${ENV_PREFIX}_CHANNEL,
  allowedServers: (process.env.DISCORD_ALLOWED_SERVERS || '').split(',').filter(Boolean),
});

export async function start${AGENT_NAME}Bot() {
  return bot.start();
}

export async function stop${AGENT_NAME}Bot() {
  return bot.stop();
}

export default { start${AGENT_NAME}Bot, stop${AGENT_NAME}Bot, client: bot.client };

// Auto-start if run directly
if (import.meta.url === \`file://\${process.argv[1]}\`) {
  start${AGENT_NAME}Bot().catch(console.error);
}
BOTJS
  echo "  ✓ Bot config created: ${BOT_SCRIPT}"
else
  echo "  ⊘ Bot config already exists, skipping"
fi
echo ""

# ── Step 4: Append env vars to .env ──────────────────────────────────
echo "→ Step 4: Updating .env file..."

ENV_FILE="${SERVER_DIR}/.env"

# Check if agent vars already exist
if grep -q "DISCORD_${ENV_PREFIX}_BOT_TOKEN" "$ENV_FILE" 2>/dev/null; then
  echo "  ⊘ Env vars for ${AGENT_NAME} already exist, skipping"
else
  cat >> "$ENV_FILE" <<ENV

# ${AGENT_NAME} Agent (${AGENT_ID})
DISCORD_${ENV_PREFIX}_BOT_TOKEN=${BOT_TOKEN}
DISCORD_${ENV_PREFIX}_CHANNEL=${CHANNEL_ID}
${ENV_PREFIX}_AGENT_URL=http://localhost:${PORT}
${ENV_PREFIX}_BOT_PORT=${BOT_PORT}
ENV
  echo "  ✓ Env vars appended to .env"
fi
echo ""

# ── Step 5: Show PM2 ecosystem entries ────────────────────────────────
echo "→ Step 5: PM2 ecosystem entries to add..."
echo ""
echo "  Add these entries to ecosystem.config.cjs apps array:"
echo ""
cat <<PM2ENTRY
    // ${AGENT_NAME} Agent
    {
      name: '${AGENT_ID}',
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
        PORT: ${PORT},
        AGENT_ID: '${AGENT_ID}',
        AGENT_TIER: '1',
        MEMORY_SCOPE: '${MEMORY_SCOPE}',
        DISCORD_CHANNEL: process.env.DISCORD_${ENV_PREFIX}_CHANNEL,
      },
      error_file: '/var/log/mycelium/${AGENT_ID}-error.log',
      out_file: '/var/log/mycelium/${AGENT_ID}-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // ${AGENT_NAME} Discord Bot
    {
      name: '${AGENT_ID}-discord-bot',
      script: '${BOT_SCRIPT}',
      cwd: __dirname,
      interpreter: 'node',
      interpreter_args: '--experimental-modules',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
        DISCORD_${ENV_PREFIX}_BOT_TOKEN: process.env.DISCORD_${ENV_PREFIX}_BOT_TOKEN,
        DISCORD_${ENV_PREFIX}_CHANNEL: process.env.DISCORD_${ENV_PREFIX}_CHANNEL,
        DISCORD_ALLOWED_SERVERS: process.env.DISCORD_ALLOWED_SERVERS,
        ${ENV_PREFIX}_AGENT_URL: 'http://localhost:${PORT}',
        ${ENV_PREFIX}_BOT_PORT: ${BOT_PORT},
        SUPABASE_URL: process.env.SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
        CLAUDE_API_KEY: process.env.CLAUDE_API_KEY,
      },
      error_file: '/var/log/mycelium/${AGENT_ID}-bot-error.log',
      out_file: '/var/log/mycelium/${AGENT_ID}-bot-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
PM2ENTRY
echo ""
echo "  NOTE: Ecosystem entries must be added manually to ecosystem.config.cjs"
echo "        (CJS module format makes safe automated insertion unreliable)"
echo ""

# ── Step 6: Optionally start via PM2 ─────────────────────────────────
if [[ "$AUTO_START" == true ]]; then
  echo "→ Step 6: Starting agent via PM2..."

  # Start agent server directly (bypasses ecosystem.config.cjs)
  cd "$SERVER_DIR"

  PORT=$PORT AGENT_ID=$AGENT_ID AGENT_TIER=1 MEMORY_SCOPE=$MEMORY_SCOPE \
    pm2 start agent-server.js \
      --name "$AGENT_ID" \
      --interpreter node \
      --interpreter-args "--experimental-modules" \
      -- 2>/dev/null || echo "  ⚠ Agent server start failed (may need ecosystem.config.cjs entry)"

  DISCORD_${ENV_PREFIX}_BOT_TOKEN=$BOT_TOKEN \
  DISCORD_${ENV_PREFIX}_CHANNEL=$CHANNEL_ID \
  ${ENV_PREFIX}_AGENT_URL="http://localhost:${PORT}" \
  ${ENV_PREFIX}_BOT_PORT=$BOT_PORT \
    pm2 start "$BOT_SCRIPT" \
      --name "${AGENT_ID}-discord-bot" \
      --interpreter node \
      --interpreter-args "--experimental-modules" \
      -- 2>/dev/null || echo "  ⚠ Bot start failed (may need bot token in .env)"

  echo "  ✓ PM2 processes started"
  echo ""

  # Verify
  echo "→ Verifying agent card..."
  sleep 2
  CARD=$(curl -s "http://localhost:${PORT}/.well-known/agent.json" 2>/dev/null || echo "")
  if [[ -n "$CARD" && "$CARD" != *"error"* ]]; then
    echo "  ✓ Agent card served at http://localhost:${PORT}/.well-known/agent.json"
  else
    echo "  ⚠ Agent card not yet available (agent may still be starting)"
  fi
else
  echo "→ Step 6: Skipping auto-start (use --start to enable)"
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  ✓ Agent ${AGENT_NAME} (${AGENT_ID}) provisioned!"
echo ""
echo "  Next steps:"
echo "    1. Set DISCORD_${ENV_PREFIX}_BOT_TOKEN in .env (if not provided)"
echo "    2. Add PM2 entries to ecosystem.config.cjs (shown above)"
echo "    3. Customize prompts/system.md at:"
echo "       ${AGENTS_ROOT}/${AGENT_ID}/prompts/system.md"
echo "    4. Start with: pm2 start ecosystem.config.cjs"
echo "    5. Orchestrator auto-discovers on next heartbeat cycle"
echo "═══════════════════════════════════════════════════════════════"
