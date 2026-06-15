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
#  12. coupling   — §4.24 cross-scale PAC/PLV/coherence + Wasserstein → enriches cognitive_metrics_harmonic
#  13. criticality— CSD early-warning + phase-lock/flickering → cognitive_metrics_criticality + cognitive_events
#  14. coherence  — semantic/discourse consecutive-pair cosine → cognitive_metrics_coherence
#  15. behavioral — diurnal pattern + session cadence (timestamps only) → cognitive_metrics_behavioral
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
echo "Step 1/16: Sync content → clustering_points"
node pipeline/sync-clustering-points.js $DRY_RUN

echo ""
echo "Step 2/16: Cluster (spherical k-means + Ward HAC; FAISS k-NN = noise only)"
"$PYTHON" pipeline/cluster.py $DRY_RUN

echo ""
echo "Step 3/16: Describe realms + territories"
# Chronicle-safe by default: PRESERVE existing narration (e.g. canonical chronicles
# inherited by dominant successors in Step 2) — describe fills gaps only, never
# rewrites a chronicle the local model would only degrade. Override with
# MYCELIUM_DESCRIBE_PRESERVE=0 to allow progressive re-narration. A fresh vault has
# no existing narration, so preserve-on still narrates everything (all gaps).
export MYCELIUM_DESCRIBE_PRESERVE="${MYCELIUM_DESCRIBE_PRESERVE:-1}"
node pipeline/describe-clusters.js $DRY_RUN
# Chronicle narration (story / archetype / patterns) is now an ASYNC BACKGROUND
# pass: the server spawns pipeline/describe-chronicles.js (startChronicleNarrationJob
# in src/jobs.js) AFTER Generate completes, with a generous per-territory timeout.
# This keeps the foreground run fast and never stalls Step 3 on slow local-LLM
# narration (the 60s default timed out on the cold model-load and cascaded).
# Set MYCELIUM_RUN_CHRONICLES=1 to run it inline (tests / CLI). Fail-soft either way.
if [ "${MYCELIUM_RUN_CHRONICLES:-}" = "1" ]; then
  node pipeline/describe-chronicles.js $DRY_RUN
fi

# Append a per-entity DYNAMICS snapshot to the entity change-log (history). Narrative
# history is hooked at the describe write sites above; this captures the trajectory of
# energy/coherence/velocity/counts that territory_profiles otherwise overwrites each
# run. Dedup-vs-latest; fail-soft (never blocks the cycle).
node pipeline/snapshot-entities.js $DRY_RUN

echo ""
echo "Step 4/16: Compute territory co-firing"
node pipeline/compute-cofire.js

echo ""
echo "Step 5/16: Map semantic neighbors (territory gaps)"
node pipeline/compute-territory-neighbors.js

echo ""
echo "Step 6/16: Compute information harmonics"
"$PYTHON" pipeline/compute_information_harmonics.py

echo ""
echo "Step 7/16: Compute Fisher trajectory (information-geometry / movement pillar)"
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
echo "Step 8/16: Compute topology audit (graph health: gini / orphans / bridges / M2)"
# Read-only over the topology graph; writes topology_audit_snapshots + findings.
# Runs before vitality so vitality could consume audit signal in future (parity
# with the canonical ordering).
node pipeline/topology-audit.js

echo ""
echo "Step 9/16: Compute territory vitality (behavioral phase: sparse/active/anchor)"
# Combines coherence/energy + co-fire momentum + bridge health into a per-
# territory vitality score; caches current_vitality/current_phase on profiles.
node pipeline/compute-vitality.js

echo ""
echo "Step 10/16: Compute Lempel-Ziv complexity (compressibility of thinking)"
node pipeline/compute-complexity.js

echo ""
echo "Step 11/16: Compute frequency metrics (coherence/entropy/compression/learning)"
# Python: decrypts messages.content before gzip; caller-encrypts the metrics.
"$PYTHON" pipeline/compute-frequency.py

# ── Compute-only families (H1/C1/coherence/behavioral) ───────────────────────
# Time-series statistics over data already in the vault (harmonic rows from
# Step 6, fisher_trajectory from Step 7, messages.embedding_768/timestamps). No
# embedder, no LLM, no new dependency. All caller-encrypt sensitive values via
# crypto_local (the JS read path auto-decrypts). cross-scale-coupling runs AFTER
# harmonics (Step 6) because it ENRICHES those rows; criticality runs AFTER
# fisher (Step 7) because it reads the trajectory series.

echo ""
echo "Step 12/16: Compute cross-scale coupling (§4.24 PAC/PLV/coherence + Wasserstein)"
"$PYTHON" pipeline/compute-cross-scale-coupling.py

echo ""
echo "Step 13/16: Compute criticality (CSD early-warning + phase-lock + flickering events)"
"$PYTHON" pipeline/compute-criticality.py

echo ""
echo "Step 14/16: Compute coherence (semantic/discourse consecutive-pair cosine)"
"$PYTHON" pipeline/compute-coherence.py

echo ""
echo "Step 15/16: Compute behavioral-temporal (diurnal pattern + session cadence)"
"$PYTHON" pipeline/compute-behavioral.py

# ── Embedding-anchor family (E1, Tier-1) ─────────────────────────────────────
# Embeds the versioned construct seed sets via the embed-service (the SAME Nomic
# service that produced messages.embedding_768), stores the mean anchor vectors
# ENCRYPTED, then computes the §4.5/4.11/4.12/4.13 cosine-proximity metrics per
# window. CVP (spec §2.3) is NOT calibrated (needs operator labels) → every row
# is cvp_status='pending' + low_confidence=1 and is NOT surfaced as validated.
echo ""
echo "Step 16/16: Compute embedding-anchor metrics (§4.5/4.11/4.12/4.13; Tier-1, CVP-pending)"
ANCHOR_EMBEDDER="${ANCHOR_EMBEDDER:-http}" "$PYTHON" pipeline/compute-anchors.py

echo ""
echo "════════════════════════════════════════════════"
echo "  Clustering cycle complete — $(date '+%Y-%m-%d %H:%M')"
echo "════════════════════════════════════════════════"
