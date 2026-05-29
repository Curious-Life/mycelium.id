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

# AGENT_ID drives scope inference inside @mycelium/core/db-d1.js d1Query.
# Without it, inferScope() defaults to 'org' and writes to realms /
# semantic_themes / territory_profiles encrypt under the wrong scope. The
# clustering pipeline owns the user's personal cognitive model; pin to
# personal-agent. AGENT_SCOPES must match personal-agent's full scope set
# so reads of any historical-scope row decrypt cleanly (existing cipher
# rows came in via portal-describe.js with AGENT_ID=personal-agent →
# scope='personal'; we don't want post-migration reads to silently
# ScopeViolationError on them).
export AGENT_ID="${AGENT_ID:-personal-agent}"
export AGENT_SCOPES="${AGENT_SCOPES:-[\"personal\",\"org\",\"wealth\",\"moms\"]}"

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
echo "Step 1/7: Syncing content → clustering_points"
node scripts/sync-clustering-points.js $DRY_RUN

# Step 2: Run clustering pipeline (Nomic v1.5 256D embeddings, cached locally)
echo ""
echo "Step 2/7: Running Nomic embedding + UMAP + HDBSCAN clustering"
mkdir -p scripts/cache
scripts/.venv/bin/python3 scripts/cluster.py $DRY_RUN --user-id "$MINDSCAPE_OWNER_ID"

# Step 3: Generate territory chronicles (per-territory Claude calls with tracked cursors)
echo ""
echo "Step 3/8: Generating territory chronicles"
node scripts/describe-chronicles.js $DRY_RUN --limit 100

# Step 3b: Generate realm + territory names/essences (populates realms + territory_profiles)
# Without this, the portal's realm list shows unnamed realms ("Realm 0", etc.)
# and the 3D view has no human-readable labels. Uses local Claude CLI
# (same pattern as describe-chronicles) — plaintext never leaves the VPS.
echo ""
echo "Step 4/8: Generating realm + territory names"
node scripts/describe-clusters.js $DRY_RUN

# Step 4: Embed mindscape entities (territories, realms, themes) into
# the encrypted D1 embedding_768 columns for semantic search.
# (Wave 4a replaced embed-profiles.js with this; Wave 4b removed
# the Vectorize fallback entirely.)
echo ""
echo "Step 5/8: Embedding mindscape entities"
node scripts/embed-mindscape.js

# Step 5: Recompute territory co-firing (topology edges with time decay)
echo ""
echo "Step 6/9: Computing territory co-firing"
node scripts/compute-cofire.js

# Step 5.5: Run topology audit (read-only, gamma-separated)
echo ""
echo "Step 6.5/9: Running topology audit"
node scripts/topology-audit.js $DRY_RUN

# Step 6.7: Compute territory vitality scores (sparse/active/anchor)
echo ""
echo "Step 6.7/9: Computing territory vitality scores"
node scripts/compute-vitality.js $DRY_RUN

# Step 6: Recompute cognitive fingerprint (embedding-based profile scores)
echo ""
echo "Step 7/8: Computing cognitive fingerprint"
node scripts/compute-cognitive-fingerprint.js

# Step 7: Compute frequency metrics (coherence, entropy, compression, learning rate, gradient)
# Uses the venv's python3 so numpy/scipy etc are available (same as cluster.py).
echo ""
echo "Step 8/8: Computing frequency metrics"
scripts/.venv/bin/python3 scripts/compute-frequency.py --user-id "$MINDSCAPE_OWNER_ID"

# Step 8: Check growth milestones (render selfie + send if milestone crossed)
echo ""
echo "Step 9/9: Checking growth milestones"
node scripts/check-milestones.js || true

echo ""
echo "════════════════════════════════════════════════"
echo "  Clustering cycle complete — $(date '+%Y-%m-%d %H:%M')"
echo "════════════════════════════════════════════════"
