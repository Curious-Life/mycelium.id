#!/usr/bin/env bash
set -euo pipefail

# update.sh — Pull latest code, update deps, restart services
#
# Usage:
#   ./scripts/update.sh          # update everything
#   ./scripts/update.sh --deps   # only update dependencies (no restart)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(dirname "$SCRIPT_DIR")"

cd "$SERVER_DIR"

DEPS_ONLY=false
[[ "${1:-}" == "--deps" ]] && DEPS_ONLY=true

echo "═══════════════════════════════════════════════════════"
echo "  Mycelium Update"
echo "═══════════════════════════════════════════════════════"
echo ""

# ── Step 1: Pull latest code ──────────────────────────────
echo "→ Pulling latest code..."
git pull --ff-only
echo ""

# ── Step 2: Update npm dependencies ───────────────────────
echo "→ Updating npm dependencies..."
npm install
echo ""

# ── Step 3: Update global tools ───────────────────────────
# sudo -n = non-interactive (works over SSH without a TTY)
echo "→ Updating Claude Code CLI..."
sudo -n npm install -g @anthropic-ai/claude-code 2>/dev/null || echo "  ⚠ Could not update Claude Code (needs sudo access)"

echo "→ Updating PM2..."
sudo -n npm install -g pm2 2>/dev/null || echo "  ⚠ Could not update PM2 (needs sudo access)"
echo ""

# ── Step 4: Show what changed ─────────────────────────────
echo "→ Current versions:"
echo "  Node.js:    $(node --version)"
echo "  Claude CLI: $(claude --version 2>/dev/null || echo 'not found')"
echo "  PM2:        $(pm2 --version 2>/dev/null || echo 'not found')"
echo "  npm:        $(npm --version)"
echo ""

if [[ "$DEPS_ONLY" == true ]]; then
  echo "  ✓ Dependencies updated (--deps mode, skipping restart)"
  exit 0
fi

# ── Step 5: Restart services ──────────────────────────────
echo "→ Restarting PM2 services..."
if command -v pm2 &>/dev/null && pm2 list 2>/dev/null | grep -q 'online\|stopped'; then
  set -a && source .env 2>/dev/null && set +a
  pm2 restart ecosystem.config.cjs
  echo ""
  pm2 status
else
  echo "  ⊘ No PM2 processes running, skipping restart"
fi

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  ✓ Update complete"
echo "═══════════════════════════════════════════════════════"
