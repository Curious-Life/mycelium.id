#!/bin/bash
# Set the master encryption key on VPS — written to tmpfs (RAM only, not disk).
#
# The key is read from stdin (never enters a bash variable, never written to
# history). Usage:
#
#   Interactive:  bash scripts/set-master-key.sh
#                 (paste 64 hex chars + Enter, input is hidden)
#
#   Pipe:         echo -n "abc...def" | bash scripts/set-master-key.sh
#
# After reboot, the tmpfs file is gone — re-run this script to restore the key.

# Disable history recording for this entire session — defense against
# crash-during-read leaking the key to ~/.bash_history
set +o history
set -euo pipefail

TMPFS_DIR="/run/mycelium"
KEY_FILE="${TMPFS_DIR}/master.key"

# Ensure tmpfs is mounted (auto-mount via /etc/fstab on boot)
if ! mountpoint -q "$TMPFS_DIR" 2>/dev/null; then
  echo "ERROR: $TMPFS_DIR is not mounted as tmpfs."
  echo "       Run server-setup.sh first, or: sudo mount $TMPFS_DIR"
  exit 1
fi

if [ -f "$KEY_FILE" ]; then
  echo "Master key already set in tmpfs ($KEY_FILE)."
  echo "To replace, delete the old file first: rm $KEY_FILE"
  exit 1
fi

# Disable terminal echo for interactive use
INTERACTIVE=0
if [ -t 0 ]; then
  INTERACTIVE=1
  echo "Paste 64-character hex master key and press Enter (input hidden):"
  stty -echo
fi

# Always restore terminal echo + clean up temp file on exit.
# Use tmpfs (/run/mycelium) for the temp file so it never touches disk.
INPUT=$(mktemp -p "$TMPFS_DIR" 2>/dev/null || mktemp)
cleanup() {
  rm -f "$INPUT" 2>/dev/null || true
  [ "$INTERACTIVE" = "1" ] && stty echo 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Read up to 65 chars from stdin (64 hex + maybe trailing newline)
umask 077
head -c 65 > "$INPUT"

# Validate: must be exactly 64 hex chars after stripping whitespace
ACTUAL_LEN=$(tr -d '[:space:]' < "$INPUT" | wc -c)
if [ "$ACTUAL_LEN" -ne 64 ]; then
  [ "$INTERACTIVE" = "1" ] && echo ""
  echo "ERROR: Expected 64 hex chars, got $ACTUAL_LEN"
  exit 1
fi

if ! tr -d '[:space:]' < "$INPUT" | grep -qE '^[0-9a-fA-F]{64}$'; then
  [ "$INTERACTIVE" = "1" ] && echo ""
  echo "ERROR: Key must be 64 hex characters (0-9, a-f)"
  exit 1
fi

# Write to tmpfs with mode 0400 (owner read-only) — no whitespace
tr -d '[:space:]' < "$INPUT" > "$KEY_FILE"
chmod 0400 "$KEY_FILE"

# Securely shred the temp file (it's on tmpfs but be paranoid)
shred -u "$INPUT" 2>/dev/null || rm -f "$INPUT"

[ "$INTERACTIVE" = "1" ] && stty echo && echo ""
echo "✓ Master key loaded into tmpfs at $KEY_FILE"
echo ""
echo "Next steps:"
echo "  1. Restart agents:  pm2 delete all && pm2 start ecosystem.config.cjs"
echo "  2. Verify health:   curl -s localhost:3004/health | jq .checks.encryption"
echo ""
echo "WARNING: This file is RAM-only and lost on reboot."
echo "         Re-run this script after any reboot to restore."
