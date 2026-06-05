# Dynamic Ollama Catalog (S6 v3) — Handoff (2026-06-05)

## TL;DR

The local-model catalog went from a **16-model hand-typed list** to a **~300-model catalog generated from the Ollama library**, committed as `src/hardware/catalog.json` (which is simultaneously the full catalog, the reviewed pull-allowlist, and offline-safe). Filtered to companion-relevant chat models, enriched with **real download sizes + params** from the registry, ranked by **companion-quality** (curated family-prior warmth). Design: [DYNAMIC-CATALOG-DESIGN-2026-06-05.md](DYNAMIC-CATALOG-DESIGN-2026-06-05.md).

## Why generate-then-commit (not live-fetch)

Sweep verdict: there's **no official list-all API** (`/v2/_catalog`→404); the full catalog only comes from scraping `ollama.com/library` (stable `x-test-*` attrs) + the auth-free registry manifest/config (exact size, params, quant — all verified first-hand). Live runtime scraping is fragile + breaks offline + widens the pull surface. So a **maintainer-time generator** writes a committed JSON: robust, diff-reviewable (the allowlist is auditable), offline. Decisions locked by the user: generated+committed · official **+ community** · family-prior **+ EQ-Bench** bonus.

## Files

| File | Role |
|---|---|
| `scripts/generate-ollama-catalog.mjs` **(new)** | network generator: scrape library → filter → registry-enrich (real sizes) → buildCatalog → write `catalog.json`. Retries, bounded concurrency, **completeness gate** (won't overwrite if a required anchor is missing), `MAX_MODELS`/`CONCURRENCY` envs. `npm run catalog:refresh` |
| `src/hardware/catalog-gen.js` **(new)** | PURE assembly: `parseLibrary(html)`, `buildCatalog({models,enriched,eqData})`, `parsePulls` |
| `src/hardware/catalog-meta.js` **(new)** | CURATED data: `FAMILY_PRIOR` (gemma .92 → phi .48), `familyOf`, `EXCLUDE_PATTERNS`, `MIN_COMMUNITY_PULLS`, `companionQuality`, `bestFor`, `EQ_FAMILY_ALIASES`, `parseParamsB` |
| `src/hardware/catalog.json` **(new, generated)** | the committed catalog (302 entries) = the pull-allowlist |
| `src/hardware/catalog.js` | now LOADS `catalog.json` (was a hardcoded array); same `CATALOG` shape + `sizeGb`/`family`/`namespace`/`pulls` + `CATALOG_META` |
| `src/hardware/recommend.js` | fit now uses the **real `sizeGb`** (+KV+overhead) when present; items expose `family`/`namespace`/`sizeGb` |
| `scripts/verify-catalog-gen.mjs` **(new)** + `verify:catalog-gen` | HERMETIC: parse · filter (embed/coder/r1/nsfw) · community pull-floor · warmth-rank (gemma>qwen>phi) · EQ-bonus lift · shape |
| `scripts/verify-hardware.mjs` (H4) | re-pinned to **invariants + anchors** (no fixed N; gemma3:12b anchor must fit a 16GB box & out-rank a cooler peer) |
| `scripts/verify-hardware-routes.mjs` (HR2) | `recs.length === CATALOG.length` (dynamic) |
| `scripts/verify-catalog-tags.mjs` | now validates all generated tags resolve (302/302 GO) |

## Generation result (this run)

232 library models → **172 after exclusion** → 147 enriched → **302 model:tag entries**, 112 families, sizes 0.1–1342 GB (real). 16GB-Mac top picks: gemma2:9b · gemma4:e2b · gemma3n · mistral-nemo:12b · gemma3:12b/4b · hermes3 · command-r7b — all warm companions.

## Quality model

`quality = 0` if excluded; else `round(100·(0.62·familyPrior + 0.18·eqBonus + 0.10·recency + 0.10·log-pop))`. Family-prior is the dominant, honest warmth signal (Ollama exposes no EQ). Excluded categories (embeddings, coders, reasoning-trace/r1, vision-only is NOT excluded, NSFW-RP, safety-classifiers, domain-specialists) are a hard ×0 gate. Runtime then re-ranks by **compat × quality** (Band A fits, Band B won't-fit).

## Verification ledger

- [✓] `verify:catalog-gen` GO (hermetic, no network)
- [✓] `verify:hardware` GO (H1–H9; H4 now invariant/anchor-based)
- [✓] `verify:hardware-routes` GO (HR1–HR9, dynamic length)
- [✓] `verify:catalog-tags` GO — **302/302 tags resolve** on the registry
- [✓] `verify:rest` GO · portal build clean

## Honest gaps / deferred

- **Community scope: mechanism built + tested, but the committed catalog is official-only.** The seed I tried (`vanilj/gemma-2-ataraxy-9b`) now **404s on the registry** (removed upstream). `COMMUNITY_SEED` is empty with instructions; add a registry-resolvable warm finetune (verify with `verify:catalog-tags`) to populate it. Filter + `MIN_COMMUNITY_PULLS` floor + explicit-variant handling are all in place and hermetically tested.
- **EQ-Bench bonus: pathway built + tested, live elo deferred.** The published artifact is a 26MB **raw pairwise** dump (not a ready elo table); deriving normalized scores needs Elo computation. `buildCatalog` accepts `eqData` + `EQ_FAMILY_ALIASES` map (P3d proves it lifts matched families); the generator currently passes `eqData={}` → family-prior ranking.
- **Runtime refresh (off-by-default fetch-and-cache):** designed (§5), not built. Committed file is the source of truth; refresh with `npm run catalog:refresh`.
- **Within-family quality is flat** (same prior; EQ off) → fit breaks ties. Fine; sharpens once EQ lands.
- `catalog.js` reads the JSON with `node:fs` at import — fine for Node; if ever bundled for a non-Node runtime, switch to a JSON import assertion.

## Pickup

Branch `docs/build-mac-fetch-sidecars`, uncommitted. To refresh the catalog: `npm run catalog:refresh` (network) → review the `catalog.json` diff → `npm run verify:catalog-tags` → commit. Re-pin nothing — H4/HR2 are now invariant-based and survive catalog growth.
