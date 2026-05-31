#!/bin/bash
# Mycelium V1 Clustering Cycle — SLIM orchestrator.
#
# Runs ONLY the pipeline stages that are present in this repo. The canonical
# run-clustering.sh referenced 12 scripts; 7 of them (describe-chronicles,
# embed-mindscape, topology-audit, compute-vitality, compute-cognitive-
# fingerprint, compute-frequency, check-milestones) were NOT ported into V1 and
# are deliberately omitted here rather than referenced as missing files.
#
# Present stages, in dependency order:
#   1. sync     — messages w/ embedding_768 → clustering_points (256D)
#   2. cluster  — FAISS k-NN + Leiden + Ward HAC → realm/theme/territory/atom
#   3. describe — realm + territory names/essences (local Claude CLI)
#   4. cofire   — territory co-firing edges (4 timescales, time-decayed)
#   5. harmonics— information-harmonic / bigram-flow / H0-persistence metrics
#
# Single-user: no MINDSCAPE_OWNER_ID / AGENT_ID scope plumbing. Scope is always
# 'personal'. The vault is the local encrypted SQLite db; the JS stages talk to
# it in-process via src/db, the Python stages via their own d1 client (Tier 2 —
# requires the Python deps in pipeline/requirements.txt).
#
# Usage:
#   USER_MASTER=<hex> SYSTEM_KEY=<hex> MYCELIUM_DB=./data/vault.db \
#     ./pipeline/run-clustering.sh [--dry-run]

set -euo pipefail
cd "$(dirname "$0")/.."

DRY_RUN=""
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN="--dry-run"
fi

: "${USER_MASTER:?USER_MASTER (64-char hex) required}"
: "${SYSTEM_KEY:?SYSTEM_KEY (64-char hex) required}"
export MYCELIUM_DB="${MYCELIUM_DB:-./data/vault.db}"
export MYCELIUM_USER_ID="${MYCELIUM_USER_ID:-local-user}"

# Python interpreter for the clustering + harmonics stages. Prefer a local
# venv if present (pipeline/.venv), else fall back to python3 on PATH.
PYTHON="python3"
if [ -x "pipeline/.venv/bin/python3" ]; then
  PYTHON="pipeline/.venv/bin/python3"
fi

echo "════════════════════════════════════════════════"
echo "  Mycelium V1 Clustering Cycle — $(date '+%Y-%m-%d %H:%M')"
echo "  DB: ${MYCELIUM_DB}  user: ${MYCELIUM_USER_ID}"
echo "════════════════════════════════════════════════"

echo ""
echo "Step 1/5: Sync content → clustering_points"
node pipeline/sync-clustering-points.js $DRY_RUN

echo ""
echo "Step 2/5: Cluster (FAISS k-NN + Leiden + Ward HAC)"
"$PYTHON" pipeline/cluster.py $DRY_RUN

echo ""
echo "Step 3/5: Describe realms + territories"
node pipeline/describe-clusters.js $DRY_RUN

echo ""
echo "Step 4/5: Compute territory co-firing"
node pipeline/compute-cofire.js

echo ""
echo "Step 5/5: Compute information harmonics"
"$PYTHON" pipeline/compute_information_harmonics.py

echo ""
echo "════════════════════════════════════════════════"
echo "  Clustering cycle complete — $(date '+%Y-%m-%d %H:%M')"
echo "════════════════════════════════════════════════"
