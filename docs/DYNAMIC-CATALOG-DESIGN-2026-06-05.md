# Dynamic Ollama Catalog — Design (S6 "Cookbook" v3)

**Date:** 2026-06-05
**Author:** Claude (sweep-first-design)
**Status:** Design — awaiting go-ahead on the forking decisions (§9).
**Builds on:** the v2 picker + auto-download ([LOCAL-MODEL-SETUP-DESIGN](LOCAL-MODEL-SETUP-DESIGN-2026-06-05.md), [OLLAMA-AUTODOWNLOAD-DESIGN](OLLAMA-AUTODOWNLOAD-DESIGN-2026-06-05.md)).

**Goal (user):** "Fetch the full catalog with the requirements, ranked by quality" — i.e. stop hand-maintaining 16 models; source the catalog from Ollama, attach hardware fit, rank by companion-quality.

---

## 0. Headline + the core tension

Two things we deliberately built fight a naïve "fetch it all at runtime":
1. **Companion-quality is curated.** Ollama's library/registry has **no** emotional-intelligence / warmth signal (verified: no such field anywhere). Sorting a fetched list "by quality" needs a quality we *inject*.
2. **The pull surface is a reviewed allowlist** (CLAUDE.md §3/§6). A live "anything in the library" catalog widens it to ~4,000+ models, most irrelevant (embeddings, coders, vision, NSFW-RP).

**Resolution — generate, don't live-scrape.** Build the catalog with a **refresh script** that pulls the *full* library from first-party Ollama sources, **filters to chat/companion-relevant models**, enriches each with **real sizes + params**, scores **companion-quality**, and writes a **committed `catalog.json`**. That file is simultaneously: the full(-relevant) catalog, the reviewed pull-allowlist (diffs in PRs — *more* auditable than 16 hand-typed lines), and offline-safe (bundled). Optional runtime refresh is designed but **off by default**.

This is the akazwz/frefrik + odysseus pattern (generate-then-ship), adapted: first-party Ollama sources, companion lens, our checksum-pin discipline.

### Sources (all verified first-hand this sweep)
- **Model list + capabilities + popularity + recency:** `GET ollama.com/library` (server-rendered HTML with stable `x-test-model`, `x-test-namespace`, `x-test-capability`, `x-test-pull-count`, `x-test-updated`, `x-test-tag-count`). No JSON API exists (`/v2/_catalog` → 404; `tags/list` → 404).
- **Exact per-tag size:** `registry.ollama.ai/v2/library/<model>/manifests/<tag>` → the `application/vnd.ollama.image.model` layer `size` (gemma3:12b = 8,149,180,896 B — matches the library). Auth-free.
- **Params + quant + family:** the manifest's `config` blob → `model_type:"12.2B"`, `file_type:"Q4_K_M"`, `model_family:"gemma3"`. Auth-free (follow redirect).

---

## 1. Decisions (rationale)

| Decision | Choice | Why |
|---|---|---|
| Sourcing | **Generated + committed `catalog.json`**, refreshed by a script | Robust, offline, reviewable diffs, IS the allowlist. Runtime scrape is fragile + breaks offline + widens pull surface |
| Scope | **Official `library/` namespace only**, chat-capable | Quality floor + bounded allowlist; community namespaces are the long tail of junk/NSFW |
| Breadth | Full **filtered** set (~80–150 models), not all ~4,000 | The picker already scrolls + ranks; filtering keeps it a *companion* picker, not a model dump |
| Quality | **Curated family-prior** (dominant) + log-damped popularity + recency; EQ-Bench bonus deferred | Warmth is fundamentally must-curate; objective signals only adjust |
| Excluded categories | **Hard ×0 gate** (not a penalty) | A coder/embedding model isn't "slightly worse" for companionship — it's wrong |
| Fit basis | **Real download size** from the registry (+ KV + overhead), fallback to the computed estimate | More accurate than `params×bpp`; we already fetch it |
| Runtime refresh | Designed, **OFF by default** (`MYCELIUM_CATALOG_REFRESH=1`) | Keeps the reviewed-allowlist default; opt-in currency without shipping a new build |
| Allowlist when refresh ON | pull name must be in the **active** catalog set (bundled ∪ refreshed) + regex + `library/` ns | Still bounded + fail-closed; never "pull anything" |

---

## 2. The generator — `scripts/generate-ollama-catalog.mjs` (NEW, build/refresh-time)

Network script (like `fetch-sidecars.sh`), run by a maintainer, not the user's app.

```
1. GET ollama.com/library → parse x-test-* → [{model, namespace, capabilities[], pulls, updated, tagCount}]
   keep namespace === 'library' (official)
2. FILTER OUT (name + capability heuristics, §4):
   embeddings (embed/bge/mxbai/minilm), rerankers, vision-only, coders
   (coder/code/codestral/starcoder), reasoning-trace (r1/qwq/*-thinking),
   base/uncensored/nsfw/-rp. Require a chat capability (completion).
3. For each surviving model, choose representative SIZE tags (e.g. the dense
   variants the model page lists: 1b/4b/12b/27b…), and for each:
     manifest → model-layer size (bytes) → sizeGb
     config blob → paramsB (model_type), quant (file_type), family
4. companionQuality(m) (§3); bestFor from family+size; drop ×0 (excluded) entries
5. WRITE src/hardware/catalog.json:
   { generatedAt, source:'ollama-library', version, models:[
       { name, family, paramsB, kvParamsB?, quant, sizeGb, ctx:8192,
         quality, bestFor, pulls, updated, capabilities[] } ] }
6. Print a summary (counts kept/excluded) + a TOFU-style note for review.
```

Fully injectable (fetch) so a **hermetic** test feeds fixtures. Failure → leave the existing committed `catalog.json` untouched (never ship a half-scrape).

A thin wrapper `npm run catalog:refresh` runs it; the diff is reviewed + committed.

---

## 3. Companion-quality model (the injected signal)

```
quality(m) =                       # 0..100, NOT generic capability
  excluded(m) ? 0                  # hard gate (§4)
  : round(100 * clamp(
        0.65 * familyPrior(family)        # must-curate, dominant
      + 0.15 * eqBonus(m)                 # EQ-Bench norm-elo if matched, else 0 (deferred)
      + 0.10 * recency(updated)           # 1 - monthsSince/24, clamped
      + 0.10 * popularity(pulls)          # log10(pulls)/log10(150e6), damped
    , 0, 1))
```

`familyPrior` (curated, the only true warmth signal — reviewed-in-repo):

| family | prior | rationale |
|---|---|---|
| gemma (3/4) | 0.92 | warmest; tops EQ-Bench creative writing |
| mistral-nemo | 0.82 | community warm/creative favourite |
| command-r | 0.80 | "optimised for conversation" |
| mistral-small | 0.74 | warm-ish, low-refusal |
| llama (3.x) | 0.72 | balanced, slightly assistant-coded |
| qwen (3/3.6) | 0.60 | smart but cooler/technical |
| phi | 0.48 | clinical/STEM, low warmth |
| (unknown) | 0.55 | neutral default for cold-start |

This keeps the v2 ranking behaviour (gemma leads, qwen/phi trail) while letting *any* fetched family get a sensible score. EQ-Bench JSON (`EQ-bench/eqbench3` ships gzipped leaderboard JSON) is a real *measured* bonus but needs a curated HF-name→Ollama-name alias map → **deferred** to a follow-up (§9 Q4).

---

## 4. Filtering (keep it a *companion* picker)

Pre-pull, exclude by name/capability (hard ×0):
- **embeddings:** `embed`, `nomic-embed`, `bge`, `mxbai-embed`, `snowflake-arctic-embed`, `all-minilm`
- **rerankers:** `rerank`
- **code:** `coder`, `code`, `codellama`, `codestral`, `codegemma`, `starcoder`, `deepseek-coder`
- **reasoning-trace (hurts chat):** `r1`, `deepseek-r1`, `qwq`, `marco-o1`, `*-thinking`
- **vision-only / base / NSFW-RP:** `*:base`, `dolphin`, `uncensored`, `abliterated`, `-rp`, `nsfw`, sub-1B
- require a chat/`completion` capability (from `x-test-capability`).

phi is *kept* (cold but a valid general chat model) — low prior, not excluded. deepseek-r1 *excluded* (think-traces). Documented so the line is intentional.

---

## 5. Runtime wiring (small)

- **`src/hardware/catalog.js`** → loads `catalog.json` (bundled) and re-exports `CATALOG` in the SAME shape consumers expect (adds `sizeGb`, `family`, `pulls`). Synchronous read at import (bundled file). Back-compat: keep `paramsB/quant/quality/bestFor`.
- **`src/hardware/recommend.js`** → unchanged ranking; `estimatedGb` uses `sizeGb + KV + overhead` when present, else the formula. (Better fit accuracy.)
- **`src/portal-hardware.js`** → `CATALOG_NAMES` rebuilt from the loaded catalog; pull gate unchanged (`isValidModelName && CATALOG_NAMES.has`). With refresh ON, `CATALOG_NAMES` = bundled ∪ cached-refresh.
- **Optional refresh (off by default):** `loadCatalog()` checks `<dataDir>/ollama-catalog.json` (TTL, e.g. 7d) when `MYCELIUM_CATALOG_REFRESH=1`; a fetch updates the cache; **offline / parse-fail → bundled file**. New `catalogCachePath()` in `src/paths.js`.

---

## 6. Threat model

| Surface | Mitigation |
|---|---|
| Pull allowlist widens (full catalog) | Allowlist = **committed `catalog.json`** (reviewed PR diffs) — still finite + auditable. Filtered to official `library/` chat models |
| Runtime refresh = larger/attacker-influenced list | OFF by default; when ON, pull still gated by membership + name regex + `library/` namespace; cache parse-fail → bundled floor; never "pull arbitrary" |
| Scrape fragility / markup change | Confined to the **generator** (maintainer-time). Failure leaves the last good `catalog.json`. App runtime never scrapes by default |
| Supply chain (sizes/params spoofed) | Sizes/params come from the **registry** (first-party); pull itself still hits the official registry; the Ollama runtime download stays SHA-pinned (separate, already built) |
| Junk/NSFW/code models reaching users | Multi-rule filter + official-namespace-only + chat-capability requirement |

No secrets touched; the generator logs counts only.

---

## 7. Test strategy

- **NEW `verify:catalog-gen` (hermetic):** feed the generator **fixture** library-HTML + fixture manifest/config via injected `fetch` → assert: excluded categories dropped (embed/coder/r1), family-prior applied (a gemma outranks a qwen at equal fit), required fields present, sizes parsed from the model layer, deterministic output shape. No network.
- **`verify:hardware` H4:** drop the hardcoded `N=16`; assert **structural invariants** against the loaded catalog — Band A sorted by rank desc; every item has `name/paramsB/quality/bestFor/sizeGb`; a known **anchor** (`gemma3:12b`) is present, fits a 16GB box, and outranks a same-fit qwen. (Anchors survive catalog growth.)
- **`verify:hardware-routes` HR2:** `recs.length === loadedCatalog.length` (not 16); fields + `ollamaInstalled` present; pull of a catalog member still streams; non-member still 400 (HR4 holds — allowlist intact).
- **`verify:catalog-tags`** (existing): already iterates the catalog → now validates the generated set resolves on the registry. Becomes the post-refresh gate.
- **`catalog.json` committed** → diffs are the audit trail.

---

## 8. Implementation order

1. `generate-ollama-catalog.mjs` + `verify:catalog-gen` (hermetic, fixtures) — get generation correct offline first.
2. Run it for real (`npm run catalog:refresh`) → commit `src/hardware/catalog.json`; eyeball the diff.
3. `catalog.js` loads JSON (same shape); `recommend.js` uses real `sizeGb`.
4. Re-pin `verify:hardware` H4 (invariants+anchors) + `verify:hardware-routes` HR2; run `verify:catalog-tags`.
5. (Optional, can defer) runtime refresh-with-cache + `catalogCachePath()`, default off.
6. Living-docs + handoff.

---

## 9. Verification table

| # | Load-bearing assumption | Status | Evidence |
|---|---|---|---|
| 1 | No official "list all models" API | ✅ | `/v2/_catalog`→404, `tags/list`→404 (research); ollama#5021/#7751 |
| 2 | Library HTML exposes structured model metadata | ✅ | `curl ollama.com/library` → `x-test-model/namespace/capability/pull-count/size/updated` (read myself) |
| 3 | Registry manifest gives exact per-tag size (auth-free) | ✅ | gemma3:12b model-layer = 8,149,180,896 B = library 8.1GB (read myself) |
| 4 | Config blob gives params+quant+family (auth-free) | ✅ | `model_type:"12.2B", file_type:"Q4_K_M", model_family:"gemma3"` (read myself) |
| 5 | Companion-quality is NOT in any source → must inject | ✅ | research: no EQ field; EQ-Bench only external |
| 6 | `catalog.js` consumers are few + shape-bounded | ✅ | importers = `portal-hardware.js`, `recommend.js`, `verify-catalog-tags.mjs` (sweep) |
| 7 | Pull allowlist = `CATALOG_NAMES` (must stay finite/reviewed) | ✅ | [portal-hardware.js:20,78] (sweep) |
| 8 | Data/cache dir exists for optional runtime cache | ✅ | `src/paths.js dataDir()` (sweep) |
| 9 | Verify gates hardcode N=16 → must become invariants | ✅ | verify-hardware H4 `N=16`, routes HR2 `===16` (sweep) |
| 10 | EQ-Bench data is machine-consumable but name-mismatched | ✅ | `EQ-bench/eqbench3` gzipped JSON, HF names (research) → alias map needed → deferred |

## 10. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Library markup changes break the scraper | Med | Low | Generator-only (maintainer-time); failure keeps last `catalog.json`; `x-test-*` are stable test hooks |
| Catalog grows huge / noisy | Med | Med | Official-ns + chat-only + exclusion filters; ranked + scrollable UI |
| Family-prior is subjective | Med | Low | Reviewed-in-repo; dominant but adjustable; objective signals temper it |
| Param/MoE accounting wrong for some models | Low | Low | Use real download size for fit (not param math); MoE active-params best-effort |
| Refresh-on widens pull surface | Low | Med | Off by default; membership+regex+ns gate; bundled floor |

## 11. Decisions — LOCKED by the user (2026-06-05)

1. **Sourcing → generated + committed `catalog.json`** ("most robust / best practice"). Runtime refresh stays designed but OFF/deferred (§5) — the committed file is the source of truth + allowlist.
2. **Scope → official + community.** Community namespaces ARE included (so warm finetunes — gemma-ataraxy merges, nemo magnum, OpenHermes — are eligible). ⇒ the **filter is now load-bearing**: community entries must pass the exclusion rules **and** a **minimum-popularity floor** (e.g. ≥ ~10k pulls) to keep the NSFW/junk long-tail out; namespaced names (`<ns>/<model>`) are allowed by the validator (already are) and recorded in the committed allowlist.
3. **Breadth → full filtered** (the picker scrolls + ranks).
4. **Quality → family-prior + EQ-Bench measured bonus.** Fold in `EQ-bench/eqbench3` leaderboard JSON via a curated HF→Ollama **alias/family map**; family-prior remains the base for unmatched models. (eqBonus weight per §3.)

### Community-scope hardening (new, because of decision 2)
- Exclusions extended + enforced on community too: `nsfw`, `uncensored`, `abliterated`, `-rp`, `dolphin`, `erotic`, `lewd`, plus the §4 list.
- **Min-popularity floor** for non-`library/` namespaces (official `library/` models bypass the floor).
- The committed `catalog.json` is STILL the reviewed allowlist — a community name only becomes pullable once it's in that file (PR diff review is the human gate; especially important now).
- Per-entry `namespace` + `pulls` recorded so the UI can badge community vs official.
