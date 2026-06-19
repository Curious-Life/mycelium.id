---
name: FAISS+Leiden clustering migration in progress
description: Replacing UMAP+HDBSCAN with FAISS k-NN + Leiden — implementation started, needs completion
type: project
---

Migrating clustering pipeline from UMAP→HDBSCAN to FAISS k-NN → multi-resolution Leiden.

**Why:** UMAP distortion, uncontrollable territory count (~960 vs target 200-400), dual inconsistent HDBSCAN passes, computational cost. Ada's research (2026-04-02) provides full recommendation.

**Status (2026-04-02):**
- Dependencies installed on VPS (faiss-cpu, leidenalg, python-igraph) ✓
- Plan approved with all review feedback incorporated ✓
- `cluster.py` partially modified — constants updated, helper functions added (build_knn_graph, find_resolution_for_k, enforce_nesting, detect_noise), but old run_clustering() body NOT YET fully replaced. File is in mixed state with both old and new code.
- Need to: complete run_clustering() replacement, add --fresh-start flag, dissolved territory migration, switch describe-chronicles.js to haiku

**How to apply:** Continue implementation from plan at `~/.claude/plans/fluttering-painting-lark.md`. The `cluster.py` file needs the old HDBSCAN body (lines ~594-832) replaced with the new Leiden pipeline stages. Helper functions are already written above the main function. The return signature stays the same.

**Key files:**
- `scripts/cluster.py` — main refactor target
- `scripts/requirements.txt` — already has new deps listed
- `scripts/describe-chronicles.js` — switch default model to haiku
- `migrations/101_dissolved_territories.sql` — new migration needed
