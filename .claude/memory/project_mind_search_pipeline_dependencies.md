---
name: Mind-search pipeline dependencies (handle after testing)
description: After mind-search is tested, audit what else depends on the BGE-M3 service / messages.embedding / Vectorize search index — the clustering and enrichment pipelines share that surface, things may be silently failing.
type: project
originSessionId: 71b0db27-201e-42f6-b4e5-86cf389aba5e
---
The mind-search rollout (PRs 1–12 complete, PR 3 + 10 + 13–17 pending) replaces BGE-M3 + Cloudflare Vectorize for search. But several other pipelines share the same infrastructure and need attention once mind-search is validated.

**Why:** User flagged on 2026-04-30 that "this also touches the clustering and computation/modeling pipeline, BGE-M3 was part of it perhaps or there are some other things that were failing." Defer until mind-search is tested, then audit what else needs fixing.

**How to apply:** Before any of PRs 13–17 (rollout phases that disable BGE-M3 service), do a focused sweep of:

- **Enrichment daemon** [scripts/enrichment-daemon.js](../../../../packages/core/../../scripts/enrichment-daemon.js) — calls BGE-M3 to populate `messages.embedding` (1024D BLOB) + mirrors to Vectorize `mycelium-search` index. When BGE goes away, this either switches to Nomic 768D or stops writing that column. Probably has been failing intermittently — check logs.
- **`messages.embedding` (1024D BLOB)** — written by enrichment, read by Vectorize mirror. Schedule for drop in PR 17 after `embedding_768` proven.
- **`packages/core/embed.js`** — module-level hardcoded to BGE 1024D. Used by anything that imports `generateEmbedding`. Need to grep callers and either repoint or migrate to `createBgeEmbedder`.
- **`packages/core/workers-ai-client.js`** — Cloudflare Workers AI BGE fallback. May be mis-routed per CLAUDE.md (no plaintext to network); slated for removal in PR 17.
- **Cluster.py vs. enrichment-daemon contention** — both want the embed-service simultaneously. On 4 GB VPS the model can only load once; check whether enrichment blocks while cluster.py runs.
- **Vectorize tenant isolation** for the `mycelium-cluster` index — keep working post-mind-search since clustering still needs it. Confirm no leak between owner and customer namespaces in the cluster path.

**What stays unchanged:**
- `scripts/cluster.py` (uses Nomic 256D local ONNX, not BGE)
- `scripts/link-contacts.py` (same Nomic path)
- `clustering_points.nomic_embedding` BLOB column
- `territory_profiles.centroid_256` aggregated centroids
- The `mycelium-cluster` Vectorize index for clustering visualization

**Most likely "things that were failing":**
1. Enrichment daemon hitting BGE-M3 that's flaky or unavailable on some customer VPSes
2. Workers AI fallback path being incorrectly invoked (CLAUDE.md violation)
3. Embed-service contention when cluster.py and enrichment-daemon overlap
4. Stale `messages.embedding` rows from failed enrichment that never recovered

**Sequence:** mind-search tested → owner VPS shadow comparison passes → audit pipeline dependencies → fix any silently-failing paths → resume PR 13 (owner soak) and beyond.
