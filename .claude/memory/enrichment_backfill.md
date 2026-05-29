---
name: Enrichment backfill issues
description: Worker-based enrichment times out at scale; 26K messages still unenriched as of March 30 2026
type: project
---

Enrichment backfill (tags + BGE-M3 embeddings) has been attempted multiple times with various approaches.

**Current state (2026-03-30):**
- 23,123 messages processed (nlp_processed=1)
- 6,752 have actual tags (many returned empty tags from short messages)
- 26,770 still unprocessed (nlp_processed=0)
- All LinkedIn messages (4,164) are unprocessed
- All ChatGPT import (18,319) mostly unprocessed

**Root cause:** Cloudflare Worker `ctx.waitUntil()` silently drops background work under load. Sync mode (`await enrichMessages()`) added but Worker CPU time limit (30s) causes timeouts when processing multiple messages.

**What works:** Single-message enrichment via curl with ADMIN_SECRET returns correctly and tags persist. The Worker CAN process 1 message at a time.

**What doesn't work:** Batch processing from VPS script — Worker returns 200 but D1 writes don't persist. Likely hitting Worker CPU/wall time limits.

**Attempted fixes:**
- Sync mode (await instead of waitUntil) — Worker still times out
- Batch size 1 — same issue
- Rate limit bumped to 3000/hour — wasn't the bottleneck
- ADMIN_SECRET for full-scope decryption — correct auth but same timeout issue

**Why:** The enrichment function does: decrypt (AES) → tag (Llama 4 Scout AI) → embed (BGE-M3 AI) → D1 UPDATE → Vectorize upsert. Two AI inference calls + crypto + DB write per message.

**How to apply:** Consider moving enrichment to VPS (direct Workers AI REST API calls + D1 HTTP API) or use Cloudflare Queues to process messages one at a time with proper acknowledgment. Another option: skip BGE-M3 embedding during backfill (tagging alone is enough for clustering sync).
