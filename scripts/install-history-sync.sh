#!/usr/bin/env bash
# Install (or remove) the Mycelium history-sync launchd agent.
#
# Sets up a periodic, paced, idempotent sync of Claude Code transcripts into the
# vault (scripts/sync-claude-history.mjs) so history stays current even when the
# live Stop hook didn't fire or :4711 was briefly down. It is the durable
# safety-net companion to the per-turn hook.
#
# Design — self-contained runtime:
#   • Copies the 3 files the sync needs (sync script + transcript parser + bridge)
#     into ~/.mycelium-bridge/runtime/ so the agent does NOT depend on this git
#     checkout's branch, the .app bundle, or node_modules being present.
#   • Supplies the app's bearer via the agent's (chmod 600) plist env, so the
#     bridge never needs to open auth.db (→ zero node_modules dependency). The
#     bearer is an API token the system already accepts via MYCELIUM_MCP_BEARER and
#     is already stored at rest in auth.db on the same disk — same trust boundary
#     on a single-user box.
#   • Gentle: ProcessType=Background + LowPriorityIO so the sync never competes with
#     the foreground app for I/O.
#
# Usage:
#   scripts/install-history-sync.sh            # install + load + run once
#   scripts/install-history-sync.sh uninstall  # stop + remove the agent
#   INTERVAL=900 scripts/install-history-sync.sh   # custom interval (seconds)
set -euo pipefail

LABEL="id.mycelium.history-sync"
UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
RUNTIME="${HOME}/.mycelium-bridge/runtime"
LOG="${HOME}/.mycelium-bridge/sync.log"
INTERVAL="${INTERVAL:-1800}"
BASE_URL="${MYCELIUM_BASE_URL:-http://127.0.0.1:4711}"
DATA_DIR="${MYCELIUM_DATA_DIR:-${HOME}/Library/Application Support/id.mycelium.app}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

unload() {
  launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || launchctl unload "${PLIST}" 2>/dev/null || true
}

if [[ "${1:-}" == "uninstall" ]]; then
  unload
  rm -f "${PLIST}"
  echo "Removed ${LABEL} (runtime + logs left at ~/.mycelium-bridge; delete manually if desired)."
  exit 0
fi

NODE_BIN="$(command -v node || true)"
[[ -z "${NODE_BIN}" ]] && { echo "ERROR: node not found on PATH." >&2; exit 1; }

# One-time bearer read from auth.db (uses this checkout's better-sqlite3).
BEARER="$(MYCELIUM_DATA_DIR="${DATA_DIR}" node -e '
  const {join}=require("path");
  const db=require("better-sqlite3")(join(process.env.MYCELIUM_DATA_DIR,"auth.db"),{readonly:true,fileMustExist:true});
  const r=db.prepare("SELECT bearer FROM mycelium_mcp_bearer WHERE id=1").get();
  process.stdout.write((r&&r.bearer)||"");
' 2>/dev/null || true)"
if [[ -z "${BEARER}" ]]; then
  echo "ERROR: could not read the app bearer from ${DATA_DIR}/auth.db." >&2
  echo "       Launch the Mycelium app once (it provisions the bearer), then re-run." >&2
  exit 1
fi

# Stage the self-contained runtime.
mkdir -p "${RUNTIME}/scripts" "${RUNTIME}/tools/memory-bridge/claude-code"
cp "${REPO_ROOT}/scripts/sync-claude-history.mjs"                       "${RUNTIME}/scripts/"
cp "${REPO_ROOT}/tools/memory-bridge/bridge.mjs"                        "${RUNTIME}/tools/memory-bridge/"
cp "${REPO_ROOT}/tools/memory-bridge/claude-code/transcript.mjs"        "${RUNTIME}/tools/memory-bridge/claude-code/"

# Write the agent. chmod 600 BEFORE writing the bearer so it's never world-readable.
mkdir -p "$(dirname "${PLIST}")"
: > "${PLIST}"; chmod 600 "${PLIST}"
cat > "${PLIST}" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${RUNTIME}/scripts/sync-claude-history.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MYCELIUM_MCP_BEARER</key><string>${BEARER}</string>
    <key>MYCELIUM_BASE_URL</key><string>${BASE_URL}</string>
  </dict>
  <key>StartInterval</key><integer>${INTERVAL}</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict>
</plist>
PLIST_EOF
chmod 600 "${PLIST}"

# (Re)load and kick once.
unload
if launchctl bootstrap "${DOMAIN}" "${PLIST}" 2>/dev/null; then :; else launchctl load -w "${PLIST}"; fi
launchctl kickstart -k "${DOMAIN}/${LABEL}" 2>/dev/null || true

echo "Installed ${LABEL}: sync every ${INTERVAL}s → ${BASE_URL}"
echo "  runtime: ${RUNTIME}"
echo "  log:     ${LOG}"
echo "  node:    ${NODE_BIN}"
echo "Tail the log:  tail -f ${LOG}"
