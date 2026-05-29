---
name: Local tagging architecture decision
description: VPS-only enrichment — Qwen2.5-3B for tagging + BGE-M3 ONNX for embedding, replacing Workers AI
type: project
---

Decision (Apr 2026): Move enrichment from Cloudflare Workers AI to VPS-local inference.

**Why:** Eliminate Cloudflare AI dependency. Workers AI is a bottleneck (~1 msg/6s rate limit, 83 hours for 50K backfill). Local inference is ~10-50x faster.

**How to apply:**

Single-model tagging: **Qwen2.5-3B-Instruct Q4_K_M** (~2.1GB file, ~2.5GB loaded)
- Handles BOTH topic tags AND entity extraction in one prompt
- Via llama-server with `--sleep-idle-seconds 300` (auto-unloads when idle)
- Grammar-constrained JSON output for reliable structured responses
- ~0.5-1.5s/message warm, 3-8s cold start
- OpenAI-compatible API — minimal code change from Workers AI

Embedding: **BGE-M3 via local ONNX** (same pattern as existing Nomic embedder)
- Replaces Workers AI `@cf/baai/bge-m3`
- ~50-100 embeddings/sec on CPU vs ~1/6s via Workers AI

Runtime: llama-server (llama.cpp) preferred over Ollama for lower overhead
- `--sleep-idle-seconds 300` for auto-unload
- Port 8090 (added to ecosystem.config.cjs)

VPS RAM: ~2.5GB peak (Qwen loaded), ~0 idle (auto-unloaded)
Quantization: Q4_K_M — quality cliff is between Q3 and Q4, sufficient for classification tasks.

Implementation order:
1. BGE-M3 local ONNX embedder (unblocks search after import)
2. llama-server + Qwen2.5-3B setup (unblocks tagging for new accounts)
3. Rewrite enrichment-daemon.js to call localhost instead of Workers AI
