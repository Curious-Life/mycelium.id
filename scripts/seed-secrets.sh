#!/bin/bash
# Seed secrets from VPS .env.* files into the centralized Secrets API.
# Run this ON the VPS: ./scripts/seed-secrets.sh
#
# Prerequisites:
#   - ADMIN_SECRET env var set (or passed as $1)
#   - MYA_WORKER_URL env var set
#   - jq installed

set -euo pipefail

ADMIN_SECRET="${1:-${ADMIN_SECRET:?Set ADMIN_SECRET env var or pass as first argument}}"
WORKER="${MYA_WORKER_URL:?Set MYA_WORKER_URL}"
USER_ID="${MYA_USER_ID:-system}"
ENV_DIR="${HOME}/mycelium"

SEEDED=0
FAILED=0

# Helper: seed a single secret
seed() {
  local key="$1" value="$2" scope="${3:-org}" agent="${4:-null}"

  if [ -z "$value" ]; then
    echo "  SKIP $key (empty value)"
    return
  fi

  local payload
  if [ "$agent" = "null" ]; then
    payload=$(jq -n --arg k "$key" --arg v "$value" --arg s "$scope" --arg u "$USER_ID" \
      '{key:$k, value:$v, scope:$s, user_id:$u, agent:null}')
  else
    payload=$(jq -n --arg k "$key" --arg v "$value" --arg s "$scope" --arg u "$USER_ID" --arg a "$agent" \
      '{key:$k, value:$v, scope:$s, user_id:$u, agent:$a}')
  fi

  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "${WORKER}/api/secrets" \
    -H "Authorization: Bearer ${ADMIN_SECRET}" \
    -H "Content-Type: application/json" \
    -d "$payload")

  if [ "$status" = "200" ]; then
    echo "  OK   $key (scope=$scope, agent=${agent})"
    SEEDED=$((SEEDED + 1))
  else
    echo "  FAIL $key → HTTP $status"
    FAILED=$((FAILED + 1))
  fi
}

# Helper: read value from .env file
envval() {
  local file="$1" key="$2"
  grep "^${key}=" "$file" 2>/dev/null | head -1 | cut -d'=' -f2- | sed 's/^["'"'"']//;s/["'"'"']$//'
}

echo "=== Seeding secrets to ${WORKER} ==="
echo "User ID: ${USER_ID}"
echo ""

# ── .env.database ──
echo "── .env.database ──"
FILE="${ENV_DIR}/.env.database"
if [ -f "$FILE" ]; then
  seed "SUPABASE_URL"              "$(envval "$FILE" SUPABASE_URL)" org
  seed "SUPABASE_ANON_KEY"         "$(envval "$FILE" SUPABASE_ANON_KEY)" org
  seed "SUPABASE_SERVICE_ROLE_KEY" "$(envval "$FILE" SUPABASE_SERVICE_ROLE_KEY)" org
fi

# ── .env.cloudflare ──
echo "── .env.cloudflare ──"
FILE="${ENV_DIR}/.env.cloudflare"
if [ -f "$FILE" ]; then
  seed "CLOUDFLARE_ACCOUNT_ID"   "$(envval "$FILE" CLOUDFLARE_ACCOUNT_ID)" org
  seed "CLOUDFLARE_STREAM_TOKEN" "$(envval "$FILE" CLOUDFLARE_STREAM_TOKEN)" org
  seed "MYA_WORKER_SECRET"       "$(envval "$FILE" MYA_WORKER_SECRET)" org
  seed "GITHUB_CLIENT_ID"        "$(envval "$FILE" GITHUB_CLIENT_ID)" org
  seed "GITHUB_CLIENT_SECRET"    "$(envval "$FILE" GITHUB_CLIENT_SECRET)" org
  seed "CLAUDE_API_KEY"          "$(envval "$FILE" CLAUDE_API_KEY)" org
  seed "SENTRY_AUTH_TOKEN"       "$(envval "$FILE" SENTRY_AUTH_TOKEN)" org
  seed "SENTRY_DSN"              "$(envval "$FILE" SENTRY_DSN)" org
  seed "PORTAL_APP_TOKEN"        "$(envval "$FILE" PORTAL_APP_TOKEN)" org
fi

# ── .env.discord — org-wide tokens + agent-specific bot tokens ──
echo "── .env.discord ──"
FILE="${ENV_DIR}/.env.discord"
if [ -f "$FILE" ]; then
  # Main company bot token → company-agent only
  seed "DISCORD_BOT_TOKEN"       "$(envval "$FILE" DISCORD_BOT_TOKEN)" org "company-agent"
  seed "DISCORD_CLIENT_ID"       "$(envval "$FILE" DISCORD_CLIENT_ID)" org
  seed "DISCORD_CLIENT_SECRET"   "$(envval "$FILE" DISCORD_CLIENT_SECRET)" org

  # Agent-specific bot tokens
  seed "DISCORD_MYA_BOT_TOKEN"              "$(envval "$FILE" DISCORD_MYA_BOT_TOKEN)" personal "personal-agent"
  seed "DISCORD_RESEARCH_BOT_TOKEN"         "$(envval "$FILE" DISCORD_RESEARCH_BOT_TOKEN)" org "research-agent"
  seed "DISCORD_COMMERCIAL_INTEL_BOT_TOKEN" "$(envval "$FILE" DISCORD_COMMERCIAL_INTEL_BOT_TOKEN)" org "commercial-intelligence-agent"
  seed "DISCORD_PUBLISHING_BOT_TOKEN"       "$(envval "$FILE" DISCORD_PUBLISHING_BOT_TOKEN)" org "publishing-agent"
  seed "DISCORD_WEALTH_BOT_TOKEN"           "$(envval "$FILE" DISCORD_WEALTH_BOT_TOKEN)" wealth "wealth-agent"
fi

# ── .env.agents — Telegram + personal scope ──
echo "── .env.agents ──"
FILE="${ENV_DIR}/.env.agents"
if [ -f "$FILE" ]; then
  seed "TELEGRAM_BOT_TOKEN" "$(envval "$FILE" TELEGRAM_BOT_TOKEN)" personal "personal-agent"
fi

# ── .env.crypto — Wealth/CDP keys ──
echo "── .env.crypto ──"
FILE="${ENV_DIR}/.env.crypto"
if [ -f "$FILE" ]; then
  seed "CDP_API_KEY_ID"     "$(envval "$FILE" CDP_API_KEY_ID)" wealth "wealth-agent"
  seed "CDP_API_KEY_SECRET" "$(envval "$FILE" CDP_API_KEY_SECRET)" wealth "wealth-agent"
  seed "CDP_WALLET_SECRET"  "$(envval "$FILE" CDP_WALLET_SECRET)" wealth "wealth-agent"
fi

echo ""
echo "=== Done: ${SEEDED} seeded, ${FAILED} failed ==="
