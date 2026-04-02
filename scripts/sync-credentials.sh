#!/usr/bin/env bash
# sync-credentials.sh — Push fresh Claude OAuth credentials to the VPS
#
# Your VS Code Claude Code session auto-refreshes tokens in the macOS Keychain.
# This script extracts them and uploads to the server.
#
# Usage:
#   bash scripts/sync-credentials.sh          # one-shot
#   bash scripts/sync-credentials.sh --cron   # install as launchd job (every 30 min)

set -euo pipefail

SERVER="mycelium-vps"
REMOTE_PATH="/home/claude/.claude/.credentials.json"

sync_credentials() {
  CREDS=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null)
  if [[ -z "$CREDS" ]]; then
    echo "No credentials found in Keychain"
    return 1
  fi

  echo "$CREDS" | ssh "$SERVER" "cat > ${REMOTE_PATH} && chown claude:claude ${REMOTE_PATH} && chmod 600 ${REMOTE_PATH}" 2>/dev/null
  echo "$(date '+%Y-%m-%d %H:%M:%S') — Credentials synced to ${SERVER}"
}

install_cron() {
  SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/sync-credentials.sh"
  PLIST_PATH="$HOME/Library/LaunchAgents/sh.nati.mycelium-creds-sync.plist"

  cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>sh.nati.mycelium-creds-sync</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${SCRIPT_PATH}</string>
    </array>
    <key>StartInterval</key>
    <integer>1800</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/mycelium-creds-sync.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/mycelium-creds-sync.log</string>
</dict>
</plist>
EOF

  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  launchctl load "$PLIST_PATH"
  echo "Installed launchd job — syncs every 30 minutes"
  echo "Plist: $PLIST_PATH"
  echo "Logs:  /tmp/mycelium-creds-sync.log"
}

if [[ "${1:-}" == "--cron" ]]; then
  install_cron
else
  sync_credentials
fi
