#!/bin/bash
# Mycelium V1 Clustering Cycle — SLIM orchestrator.
#
# Runs the pipeline stages present in this repo. The Fisher keystone (Step 7,
# fisher_trajectory + fisher_milestones) and the T1 topology-graph family
# (Steps 8–11: topology-audit, vitality, complexity, frequency) are NOW ported,
# so the tables they write are populated. Stages NOT ported: embed-mindscape,
# compute-cognitive-fingerprint, check-milestones (milestones come from Step 7).
# (describe-chronicles WAS ported — it runs in Step 3 below, fail-soft.)
# See docs/MEASUREMENT-LAYER-STATE-2026-06-04.md for the full as-built map.
#
# Present stages, in dependency order:
#   1. sync       — messages w/ embedding_768 → clustering_points (256D)
#   2. cluster    — spherical k-means + Ward HAC → realm/theme/territory/atom
#                   (FAISS k-NN graph = noise detection only; Leiden imported but unused)
#   3. describe   — realm + territory names/essences (local Claude CLI)
#   4. cofire     — territory co-firing edges (4 timescales, time-decayed)
#   5. neighbors  — territory SEMANTIC neighbors (centroid cosine) → territory_neighbors (gaps)
#   6. harmonics  — information-harmonic / bigram-flow / H0-persistence metrics
#   7. fisher     — information-geometry trajectory + milestones (movement pillar)
#   8. audit      — topology graph health → topology_audit_snapshots + findings
#   9. vitality   — per-territory behavioral phase → territory_vitality + profile cache
#  10. complexity — Lempel-Ziv compressibility → complexity_snapshots
#  11. frequency  — windowed coherence/entropy/compression/learning → frequency_snapshots
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
# cluster.py resolves the owner from MINDSCAPE_OWNER_ID/MYA_USER_ID (NOT
# MYCELIUM_USER_ID); map it so it works even when clustering_points is empty
# (else it falls back to "most common user in clustering_points" → none → exit 1).
export MINDSCAPE_OWNER_ID="${MINDSCAPE_OWNER_ID:-$MYCELIUM_USER_ID}"

# Python interpreter for the clustering + harmonics stages. An explicit $PYTHON
# wins (operator override + makes the deps probe below testable); otherwise prefer
# the local venv (pipeline/.venv), else fall back to python3 on PATH. NOTE: the app
# never sets PYTHON — jobs.js's child-env allowlist doesn't pass it — so the
# override path only affects manual/test runs.
if [ -z "${PYTHON:-}" ]; then
  PYTHON="python3"
  if [ -x "pipeline/.venv/bin/python3" ]; then
    PYTHON="pipeline/.venv/bin/python3"
  fi
fi

# Fail FAST + ACTIONABLE if the clustering/harmonics deps aren't installed.
# Otherwise the run churns for minutes and dies on an opaque
# "ModuleNotFoundError: No module named 'dotenv' (exit 1)" surfaced by jobs.js
# (which shows only the LAST stderr line). Probe the hard imports up front:
# module-level (numpy, dotenv, cryptography — the last pulled in unguarded by
# Stage 5's crypto_local) + the unguarded run_clustering libs (faiss, igraph,
# leidenalg, scipy, sklearn, umap). Deliberately excluded: ripser/psutil (guarded,
# degrade gracefully) and httpx (not imported). Keep this list in sync with the
# module-level imports of cluster.py / crypto_local.py / compute_information_harmonics.py.
# The actionable line is printed LAST so jobs.js surfaces it verbatim.
if ! "$PYTHON" -c "import numpy,dotenv,cryptography,faiss,igraph,leidenalg,scipy,sklearn,umap" 2>/dev/null; then
  echo "[clustering] missing Python dependencies in interpreter: $PYTHON" >&2
  echo "Generate needs the clustering dependencies — install with: bash pipeline/setup.sh  (or: ${PYTHON} -m pip install -r pipeline/requirements.txt)" >&2
  exit 3
fi

echo "════════════════════════════════════════════════"
echo "  Mycelium V1 Clustering Cycle — $(date '+%Y-%m-%d %H:%M')"
echo "  DB: ${MYCELIUM_DB}  user: ${MYCELIUM_USER_ID}"
echo "════════════════════════════════════════════════"

echo ""
echo "Step 1/11: Sync content → clustering_points"
node pipeline/sync-clustering-points.js $DRY_RUN

echo ""
echo "Step 2/11: Cluster (spherical k-means + Ward HAC; FAISS k-NN = noise only)"
"$PYTHON" pipeline/cluster.py $DRY_RUN

echo ""
echo "Step 3/11: Describe realms + territories"
node pipeline/describe-clusters.js $DRY_RUN
# Chronicle narration (story / archetype / patterns). Fail-soft: skips if no model.
node pipeline/describe-chronicles.js $DRY_RUN

echo ""
echo "Step 4/11: Compute territory co-firing"
node pipeline/compute-cofire.js

echo ""
echo "Step 5/11: Map semantic neighbors (territory gaps)"
node pipeline/compute-territory-neighbors.js

echo ""
echo "Step 6/11: Compute information harmonics"
"$PYTHON" pipeline/compute_information_harmonics.py

echo ""
echo "Step 7/11: Compute Fisher trajectory (information-geometry / movement pillar)"
# The keystone: activation distributions → Fisher-Rao geodesic trajectory +
# milestones. Reads clustering_points + territory_profiles (written by Step 2);
# uses CLUSTERING_RUN_ID as the era anchor. Skip-existing within an era.
"$PYTHON" pipeline/compute-fisher.py

# ── T1: topology-graph measurement stages ───────────────────────────────────
# All four depend on cluster.py output (territories/points written by Step 2) +
# the co-firing graph (Step 4), so they run AFTER Fisher. Vitality/complexity/
# audit are JS (in-process src/db adapter); frequency is Python (caller-encrypt
# via crypto_local, decrypts messages.content before gzip). All write encrypted
# columns at rest (see ENCRYPTED_FIELDS in src/crypto/crypto-local.js).

echo ""
echo "Step 8/11: Compute topology audit (graph health: gini / orphans / bridges / M2)"
# Read-only over the topology graph; writes topology_audit_snapshots + findings.
# Runs before vitality so vitality could consume audit signal in future (parity
# with the canonical ordering).
node pipeline/topology-audit.js

echo ""
echo "Step 9/11: Compute territory vitality (behavioral phase: sparse/active/anchor)"
# Combines coherence/energy + co-fire momentum + bridge health into a per-
# territory vitality score; caches current_vitality/current_phase on profiles.
node pipeline/compute-vitality.js

echo ""
echo "Step 10/11: Compute Lempel-Ziv complexity (compressibility of thinking)"
node pipeline/compute-complexity.js

echo ""
echo "Step 11/11: Compute frequency metrics (coherence/entropy/compression/learning)"
# Python: decrypts messages.content before gzip; caller-encrypts the metrics.
"$PYTHON" pipeline/compute-frequency.py

echo ""
echo "════════════════════════════════════════════════"
echo "  Clustering cycle complete — $(date '+%Y-%m-%d %H:%M')"
echo "════════════════════════════════════════════════"
