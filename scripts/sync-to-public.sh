#!/usr/bin/env bash
# Sync dev repo to public repo, excluding private files.
# Usage: bash scripts/sync-to-public.sh [--dry-run]

set -euo pipefail
cd "$(dirname "$0")/.."

SRC="$(pwd)/"
DEST="/Users/sfn/Documents/GitHub/mycelium.id/"
DRY_RUN=""

[[ "${1:-}" == "--dry-run" ]] && DRY_RUN="--dry-run"

echo "==> Syncing $(basename "$SRC") → $(basename "$DEST")"
[[ -n "$DRY_RUN" ]] && echo "    (dry run — no files will be changed)"

rsync -av --delete $DRY_RUN \
  --exclude='node_modules/' \
  --exclude='.wrangler/' \
  --exclude='.git/' \
  --exclude='.env' \
  --exclude='.env.*' \
  --include='.env.example' \
  --exclude='portal/build/' \
  --exclude='portal/.svelte-kit/' \
  --exclude='sites/' \
  --exclude='agents/moms-agent.json' \
  --exclude='docs/NATI-README.md' \
  --exclude='docs/MINDSCAPE-GAPS.md' \
  --exclude='docs/BOOTSTRAP-SECRETS-PLAN.md' \
  --exclude='package-lock.json' \
  --exclude='scripts/cache/' \
  --exclude='scripts/.venv/' \
  --exclude='*.pyc' \
  --exclude='__pycache__/' \
  --exclude='mycelium-export*.zip' \
  --exclude='mycelium-export.zip' \
  --exclude='worker/wrangler.toml' \
  --exclude='scripts/provision-customer.sh' \
  --exclude='scripts/update-customers.sh' \
  --exclude='scripts/provisioning-daemon.js' \
  --exclude='scripts/verify-dns.js' \
  --exclude='scripts/generate-instance-keys.js' \
  --exclude='scripts/migrate-registry-to-d1.js' \
  --exclude='scripts/migrate-to-system-key.js' \
  --exclude='scripts/export-vault.js' \
  --exclude='infomaniak-kms/certs/*.key' \
  --exclude='infomaniak-kms/certs/*.crt' \
  --exclude='infomaniak-kms/certs/*.pem' \
  --exclude='infomaniak-kms/certs/*.srl' \
  --exclude='infomaniak-kms/certs/clients/' \
  --exclude='LICENSE' \
  --exclude='README.md' \
  --exclude='CLAUDE.md' \
  --exclude='docs/GETTING-STARTED.md' \
  --exclude='docs/mycelium-logo.svg' \
  "$SRC" "$DEST"

echo ""
echo "==> Verifying no TLS material in destination..."
KEY_FOUND=$(find "$DEST/infomaniak-kms/certs" -type f \( -name '*.key' -o -name '*.crt' -o -name '*.pem' -o -name '*.srl' \) 2>/dev/null || true)
if [[ -n "$KEY_FOUND" ]]; then
  echo "    ✗ TLS MATERIAL FOUND IN PUBLIC REPO:"
  echo "$KEY_FOUND"
  exit 1
else
  echo "    ✓ No TLS material in destination"
fi

echo ""
echo "==> Verifying no personal data..."
FOUND=$(grep -rl "Martin Balodis\|curiouslife\|martinam-balodim\|1206312513013293168\|Nati (Thailand)\|Martin (Latvia)\|martin@curiouslife" --include='*.js' --include='*.ts' --include='*.py' --include='*.cjs' "$DEST" 2>/dev/null | grep -v migrations/ | grep -v tests/personal-data || true)

if [[ -n "$FOUND" ]]; then
  echo "    ✗ PERSONAL DATA FOUND:"
  echo "$FOUND"
  exit 1
else
  echo "    ✓ No personal data found"
fi

echo ""
echo "==> Checking moms-agent excluded..."
if [[ -f "${DEST}agents/moms-agent.json" ]]; then
  echo "    ✗ moms-agent.json should NOT be in public repo"
  exit 1
else
  echo "    ✓ moms-agent.json excluded"
fi

echo ""
echo "==> Done. Review changes in $DEST then commit."
