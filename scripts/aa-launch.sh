#!/bin/bash
# Launch a Node.js process under AppArmor confinement.
# Used by ecosystem.config.cjs to run agents with restricted file access.
#
# Usage: aa-launch.sh <profile> <script> [args...]
# Example: aa-launch.sh mycelium-agent agent-server.js

PROFILE="${1:?Usage: aa-launch.sh <profile> <script> [args...]}"
shift

# If AppArmor is available, use it; otherwise run unconfined (dev/macOS)
if command -v aa-exec &>/dev/null; then
  exec aa-exec -p "$PROFILE" -- node "$@"
else
  exec node "$@"
fi
