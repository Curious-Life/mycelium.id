---
name: Mind-search wave status — admin partially deployed (backfill running 2026-05-02)
description: Authoritative deploy ledger after Waves 0–4a + 3.6 + deploy fixups. Admin has migrations applied, embed-service running, messages backfill in progress (~21h ETA on 4GB-class hardware). Customer fleet rollout NOT yet started.
type: project
originSessionId: 71b0db27-201e-42f6-b4e5-86cf389aba5e
---

## Status as of 2026-05-02

All 7 wave commits + 5 deploy-fixup commits live on `origin/main`. **Admin is mid-deploy.** Customer fleet not yet touched.

### Admin state
- ✅ Migrations 142 + 143 applied to mycelium-v2 D1 (5 `embedding_768 TEXT` columns)
- ✅ `embed-service` PM2 process running with 2GB memory limit (Nomic v1.5 768D, ~1.4GB resident, 0 restarts in current session)
- ✅ `enrichment-service` restarted to pick up Wave 2 write path (encrypted D1 vectors instead of Vectorize upserts)
- 🟡 **Backfill in progress** — 3-stage detached runner via `setsid nohup /tmp/mycelium-deploy/run-backfills.sh`. Log at `/tmp/mycelium-deploy/backfill.log`. ETA ~21h for 46k messages on this hardware.
- ⏳ **Pending after backfill**: restart `personal-agent` to trigger rehydrate (mind-search RAM is empty until then; matchMessages falls through to Vectorize on every query)
- ⏳ **Pending optional**: flip `MIND_SEARCH_SHADOW_SAMPLE=0.1` for jaccard@K telemetry during soak

### Wave inventory (all on `origin/main`)

| Wave | Commit | Summary |
|---|---|---|
| 0 | `551b865` | Dead code purge (enrichment-daemon, backfill-*, migrate-to-d1, embed.js, macOS dups) |
| 1 | `423cbf2` | BGE → Nomic embed-service (Python 768D); task contract end-to-end; PM2 rename |
| 2 | `ac57b35` | `messages.embedding_768` column; enrichment writes encrypted vectors to D1 |
| 3 | `436eedc` | matchMessages routes to mind-search via core-side registry |
| 3.5 | `95f0114` | `rehydrateFromD1()` loader populates mind-search RAM at agent boot |
| 3.6 | `7c7a1d1` | Shadow comparator wiring (off by default; `MIND_SEARCH_SHADOW_SAMPLE` env) |
| 4a | `430cf2c` | D1 vectors for territory_profiles/realms/semantic_themes/documents (4 scan-matchers); embed-mindscape replaces embed-profiles |
| fixup | `adaff6d` | Inter-batch sleep (`BACKFILL_SLEEP_MS=5000` default) — yields embed-service to live agent traffic |
| fixup | `8ece964` | mindscape backfill: drop missing `scope` column (territory_profiles/realms/semantic_themes don't have it in D1) |
| fixup | `24dde1d` | backfill-embedding-768 health check: 3× retry @ 15s timeout (was 2s, false-failed during in-flight batches) |

### Vectorize remains the read-side fallback

After all waves, the structural goal is achieved:
- **Compute**: 100% local (Nomic on-VPS)
- **Storage**: 100% encrypted in D1 (5 `embedding_768` columns)
- **Read path**: prefer scan-matcher / mind-search; fall back to Vectorize on miss/error

Vectorize fallback exists for safety during admin soak. Wave 4b (next major work) rips it out.

## What backfill is producing

Per-corpus tracking via `embedding_768 IS NOT NULL` count. Run during deploy verification:

```bash
WORKER_URL=$(grep '^WORKER_URL=' ~/mycelium/.env | cut -d= -f2-)
TOKEN=$(grep '^AGENT_TOKEN_MYA=' ~/mycelium/.env | cut -d= -f2-)
USER_ID=$(grep '^MYA_USER_ID=' ~/mycelium/.env | cut -d= -f2-)
curl -s -X POST "$WORKER_URL/api/db/query" \
  -H "Authorization: Bearer $TOKEN" -H "X-Tenant-ID: $USER_ID" \
  -d '{"sql":"SELECT '\''messages'\'' AS t,COUNT(*) FROM messages WHERE user_id=? AND embedding_768 IS NOT NULL UNION ALL SELECT '\''territory_profiles'\'',COUNT(*) FROM territory_profiles WHERE user_id=? AND embedding_768 IS NOT NULL UNION ALL SELECT '\''realms'\'',COUNT(*) FROM realms WHERE user_id=? AND embedding_768 IS NOT NULL UNION ALL SELECT '\''semantic_themes'\'',COUNT(*) FROM semantic_themes WHERE user_id=? AND embedding_768 IS NOT NULL UNION ALL SELECT '\''documents'\'',COUNT(*) FROM documents WHERE user_id=? AND embedding_768 IS NOT NULL","params":["'$USER_ID'","'$USER_ID'","'$USER_ID'","'$USER_ID'","'$USER_ID'"]}'
```

Expected eventual totals on admin:
- messages: ~46,000
- territory_profiles: ~hundreds
- realms: ~tens
- semantic_themes: ~hundreds
- documents: ~1,200

## Vectorize footprint after deploy

| Matcher | Backend after deploy + backfill | Vectorize role |
|---|---|---|
| matchMessages | mind-search (post-rehydrate) | safety fallback only |
| matchDocuments | scan-matcher | safety fallback only |
| matchTerritories | scan-matcher | safety fallback only |
| matchRealms | scan-matcher | safety fallback only |
| matchThemes | scan-matcher | safety fallback only |

Wave 4b rips fallback once admin soaks ≥1 week with `jaccard_at_k ≥ 0.5` consistently in shadow events.

## Pre-existing caveats (not Wave-related)

- 12 test failures in repo pre-date this work (Discord, Telegram, spaces plumbing, dedupe). None touch mind-search/embedder. Confirmed unrelated across all wave commits.
- `mycelium-cluster` Vectorize index is orphaned (no upserts, binding still in wrangler.toml). Safe to leave; remove in Wave 4b cleanup.
- Many migration files show as "modified" in git status — pre-existing whitespace dirt unrelated to this work.
