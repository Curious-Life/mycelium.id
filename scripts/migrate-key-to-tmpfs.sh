#!/bin/bash
# One-time migration: move ENCRYPTION_MASTER_KEY from .env to tmpfs.
#
# Usage: bash scripts/migrate-key-to-tmpfs.sh
#
# Idempotent: safe to run multiple times. Skips if already migrated.

set +o history
set -euo pipefail

ENV_FILE="${ENV_FILE:-.env}"
TMPFS_DIR="/run/mycelium"
KEY_FILE="${TMPFS_DIR}/master.key"

# Sanity checks
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found. Run from mycelium project root."
  exit 1
fi

# Check if tmpfs is mounted
if ! mountpoint -q "$TMPFS_DIR" 2>/dev/null; then
  echo "ERROR: $TMPFS_DIR is not mounted as tmpfs."
  echo "       Run sudo bash scripts/server-setup.sh first to set up tmpfs mount."
  exit 1
fi

# Check if key already in tmpfs
if [ -f "$KEY_FILE" ]; then
  echo "✓ Master key already in tmpfs ($KEY_FILE)"
  # Strip from .env if still there
  if grep -q '^ENCRYPTION_MASTER_KEY=' "$ENV_FILE" 2>/dev/null; then
    echo "  Removing duplicate from $ENV_FILE..."
    sed -i.bak '/^ENCRYPTION_MASTER_KEY=/d' "$ENV_FILE"
    shred -u "${ENV_FILE}.bak" 2>/dev/null || rm -f "${ENV_FILE}.bak"
    echo "  ✓ Removed from $ENV_FILE"
  fi
  exit 0
fi

# Extract key from .env
KEY_LINE=$(grep '^ENCRYPTION_MASTER_KEY=' "$ENV_FILE" 2>/dev/null || true)
if [ -z "$KEY_LINE" ]; then
  echo "ERROR: ENCRYPTION_MASTER_KEY not found in $ENV_FILE"
  echo "       Set it manually with: bash scripts/set-master-key.sh"
  exit 1
fi

# Pipe directly to set-master-key.sh — never enters a bash variable
# Strip the ENCRYPTION_MASTER_KEY= prefix and any quotes/whitespace
echo "$KEY_LINE" | sed 's/^ENCRYPTION_MASTER_KEY=//' | tr -d '"'"'"'[:space:]' | bash "$(dirname "$0")/set-master-key.sh"

# Verify it landed in tmpfs
if [ ! -f "$KEY_FILE" ]; then
  echo "ERROR: Migration failed — key not written to tmpfs"
  exit 1
fi

# Now strip from .env
echo "Removing ENCRYPTION_MASTER_KEY from $ENV_FILE..."
sed -i.bak '/^ENCRYPTION_MASTER_KEY=/d' "$ENV_FILE"
shred -u "${ENV_FILE}.bak" 2>/dev/null || rm -f "${ENV_FILE}.bak"

echo ""
echo "✓ Migration complete"
echo "  Master key now in: $KEY_FILE (tmpfs)"
echo "  Removed from: $ENV_FILE"
echo ""
echo "Next: pm2 delete all && pm2 start ecosystem.config.cjs"
