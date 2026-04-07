#!/bin/bash
# Mycelium Clustering Cycle Orchestrator
#
# Runs the full clustering pipeline:
# 1. Sync new content → clustering_points
# 2. Run UMAP + HDBSCAN clustering
# 3. Generate cluster descriptions
#
# All scripts use MINDSCAPE_OWNER_ID for profile ownership.
# Points retain their original user_id for attribution.
#
# Usage:
#   ./scripts/run-clustering.sh
#   ./scripts/run-clustering.sh --dry-run

set -euo pipefail
cd "$(dirname "$0")/.."

# Load env (MINDSCAPE_OWNER_ID, MYA_WORKER_URL, etc.)
set -a
[ -f .env ] && source .env
set +a

if [ -z "${MINDSCAPE_OWNER_ID:-}" ]; then
  echo "ERROR: MINDSCAPE_OWNER_ID not set in .env"
  exit 1
fi

DRY_RUN=""
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN="--dry-run"
fi

echo "════════════════════════════════════════════════"
echo "  Mycelium Clustering Cycle — $(date '+%Y-%m-%d %H:%M')"
echo "  Owner: ${MINDSCAPE_OWNER_ID}"
echo "════════════════════════════════════════════════"

# Step 1: Sync new content to clustering_points
echo ""
echo "Step 1/6: Syncing content → clustering_points"
node scripts/sync-clustering-points.js $DRY_RUN

# Step 2: Run clustering pipeline (Nomic v1.5 256D embeddings, cached locally)
echo ""
echo "Step 2/6: Running Nomic embedding + UMAP + HDBSCAN clustering"
mkdir -p scripts/cache
scripts/.venv/bin/python3 scripts/cluster.py $DRY_RUN --user-id "$MINDSCAPE_OWNER_ID"

# Step 3: Generate territory chronicles (per-territory Claude calls with tracked cursors)
echo ""
echo "Step 3/6: Generating territory chronicles"
node scripts/describe-chronicles.js $DRY_RUN --limit 100

# Step 4: Embed territory profiles into Vectorize (for semantic territory search)
echo ""
echo "Step 4/6: Embedding territory profiles"
node scripts/embed-profiles.js

# Step 5: Recompute territory co-firing (topology edges with time decay)
echo ""
echo "Step 5/6: Computing territory co-firing"
node scripts/compute-cofire.js

# Step 6: Recompute cognitive fingerprint (embedding-based profile scores)
echo ""
echo "Step 6/6: Computing cognitive fingerprint"
node scripts/compute-cognitive-fingerprint.js

echo ""
echo "════════════════════════════════════════════════"
echo "  Clustering cycle complete — $(date '+%Y-%m-%d %H:%M')"
echo "════════════════════════════════════════════════"
