# Context Engine — Handoff (read this first, cold)

**Date:** 2026-06-19 · **Audience:** the next Claude Code instance. **This supersedes `PERSONA-REDESIGN-HANDOFF-2026-06-19.md`** (that one describes a design we moved *past* — don't build it).

## TL;DR
- **Lead doc / build source of truth:** **`docs/CONTEXT-ENGINE-SPEC-2026-06-19.md`** (the *what*) + **`docs/CONTEXT-ENGINE-IMPLEMENTATION-PLAN-2026-06-19.md`** (the sweep-verified *how* — read this before building). Everything else is background.
- **Sweep-verified 2026-06-19 (6 parallel Explore sweeps + direct reads):** the **keystone holds** — a scheduled cycle CAN write `model.md` in-process (`mcp.js:61` agentRoot defaults `data/mind`; same `handlers` → `createScheduler` at `server-rest.js:553`). The old "document-only" blocker was a *spawned pipeline child*, not the scheduler. **6 forced pivots** (per-cycle prompt via `task.id="cycle:<id>"`+registry, not a migration; prefix-cache decoupled from bounded-Core; enrich needs an inference dep + `categories_processed` flag; skills are D1 docs; rename canonical tools at compile; **`0030` is taken → use `0031`/`0032`**). `sanitize.js`/`removeFromMind`/anisotropy-correction must be built. Full ledger (38 assumptions, file:line) in the plan §1.
- **State:** the whole context-engine is **DESIGN-ONLY — nothing built.** Separately, the measurement-audit consolidation (#286/#294/#292/#288) is **merged to `main` but NOT deployed** (app rebuild pending). Live MCP **hygiene available now** (fix name→Martin, prune 3 dev-claims).
- **The product being designed:** a private AI that *genuinely knows you and grows with you* — 3 layers (enrich / reflect / distill) × 3 memory tiers (Core / interiority / history) + a user-editable skills system.
- **The one decision that gates everything:** approve the taxonomy (see Decisions). Then build **foundations first** — reflection engine + **LLM tagging** + memory tiers. The register **compass is a later optimization** (operator steer: "not the first thing — get the foundations right"; it's unvalidated and needs real labels to build its centroids).

## The arc — what we learned, in order (so you don't undo it)
1. Live-tested the vault: `person_claims` is **polluted** (your Mycelium *engineering* chat filed as your identity; name shows as "Altus"). I designed a structured fix (facet classifier + bi-temporal + a claims-derived capsule).
2. **PIVOT 1 (the big one):** the system that *actually* knows Martin is **NOT `person_claims`** — it's the **narrative reflection engine** (agent-authored `model.md` + reflections + weekly-reviews + `lumensis-life-model.md`). It's *excellent*, and it lives in the **canonical repo `~/Developer/mycelium`**, barely ported to V1. (Read those agent-files via MCP `getDocument agents/personal-agent/mind/...` — they're stunning.)
3. **PIVOT 2:** **cloud for all real reasoning, local only for trivial** (operator directive) — but **model choice is configurable** (`settings.models.*`).
4. **PIVOT 3:** structured claims come **back** as a "beyond" layer — time-bound, category-bound bi-temporal — but **distilled from the consolidated `model.md` (clean), not raw chat.**
5. **PIVOT 4 (granular layer):** per-message tagging returns as **Layer 1**, with a *real* taxonomy (≤7 domains + the 4×3 register map), cheap.
6. **PIVOT 5 (Hermes):** studied NousResearch/hermes-agent → adopt **bounded prefix-cached Core memory**, **prompts-as-editable-skills**, **injection-scanned writes**, **80%-capacity consolidation**, **Curator**.
7. **Ada's research (just checked):** the research-agent already validated the 4×3 register taxonomy and delivered the implementation → **tag by centroid-compass over existing embeddings (near-free), not a per-message model call.** Folded into the spec §4-bis. *This is load-bearing — read Ada's doc.*

### Corrections I made to my OWN earlier claims (don't repeat them)
- "loop.js/lane.js are spec-only" → **WRONG.** The autonomous wake-cycle scheduler **is built + running on `main`** (`src/agent/scheduler.js`). It imports loop/lane/run-turn, and the app boots.
- "consolidation must be deterministic (SSGM)" → **reversed for the narrative layer.** The `model.md` is *supposed* to be agent-authored; safety comes from the never-conclude discipline, not determinism.
- "per-message facet classifier (local model)" → **superseded by Ada's centroid-compass** (cosine to precomputed register centroids over existing `embedding_768` — cheaper *and* validated).
- "states/self capsule from claims" → **replaced** by the Hermes-style bounded Core distilled from `model.md`.

## Ada's research (what it gives us — `agent-files/research-agent/research/register-map-research-deliverable-2026-06-10.md`)
A 6-part validated spec for the **4×3 Register Map** (Agency·Resonance·Inquiry·Substrate × 3): a 1,200-sentence benchmark w/ ambiguous border cases, expected silhouettes (4-class **0.35-0.55 good**, 12-class 0.20-0.35 blurry), confusion pairs (Build↔Map, Bond↔Attune, Dream↔Map, Steer↔Build, Body↔Attune), the **centroid-compass architecture** (centroids once → cosine at scale, ~$0.75 for 50K msgs vs $2.50/user/mo pure-LLM), **mandatory corrections** (anisotropy: subtract mean embedding; hubness; min-message thresholds), the **balance-metric formulas** (proportion, 90-day baseline, **NeglectScore** = sustained-absence > current-deviation, velocity, entropy with "don't optimize for equal", transition matrix), and dual vocabulary (technical + elemental Fire/Water/Air/Earth). **This is the validated implementation of Layer 1's register axis.**

## Connected thread — the measurement *page* & the honest prediction staircase
A parallel design exists for the user-facing measurement/insights **page** (Curious Life). The honest framing (literature-grounded) to preserve there:
- **Detection of past shifts** = validated (Fisher velocity spikes, semantic-shift detection). Show it.
- **Correlation (shift ↔ real event)** = *being learned* — the **event-anchor ("since I marked X")** is secretly the **ground-truth collection engine**.
- **Prediction of future shifts** = **descriptive present-tense only, never a forecast.** Critical-slowing-down EWS have ~33% sensitivity, are direction-blind. Say *"your recovery has been slow lately"* (true, useful), never *"a transition is coming"*. The CVP/honesty-envelope discipline (already merged) is the enforcement. (Title: name the experience — "Movement"/"Mindscape" — not "Analytics".)

## Open decisions for the operator
1. ~~**Taxonomy (the gate)**~~ **✅ LOCKED 2026-06-19 (`taxonomy_version="v1"`):** 7 domains — **Body & Health · Work & Creativity · People & Relationships · Community & Belonging · Mind & Growth · Meaning & Spirit · Self & Inner Life**. Craft merged into Work & Creativity; social split intimate(People)/collective(Community) for the NeglectScore signal; dropped peripheral Home & Living (admin→Work) for Self & Inner Life (inner-life *activity*, distinct from the Trait axis = *who-you-are* claims). **Both** Domain + Register tagged at Phase 1b via the LLM; compass is Phase-3a (from accrued labels). Fold/route rules in SPEC §3 Axis A.
2. **Reflection model default:** cloud-with-local-opt-in (confirm per-cycle vs global).
3. **Core memory cap** (~1,000 tok).
4. **Which cycles run by default** (cost — 6 daily + weekly cloud cycles).

## Gotchas (dated 2026-06-19)
- **Migrations off FRESH `main`:** local tree stale at `0027`; main has `0028`/`0029`. Spec uses `0030` (domain/register cols) + `0031` (bi-temporal). Build off fresh main.
- **`infer` is request-scoped, not a boot singleton** — but the reflection cycles don't need a new one (the discovery child + scheduler turns resolve their own model).
- **`confidence_logodds` is encrypted** → any confidence filter is JS-side, not SQL. `valid_to`/`domain`/`register`/`status` are plaintext (queryable).
- **Anisotropy correction is non-optional** for the centroid-compass (Ada) — without subtracting the mean embedding, cosine sims compress and registers blur.
- **Canonical repo:** `~/Developer/mycelium` — the operational cycle prompts are at `packages/core/scheduler.js:633-975`; they already call V1's MCP tools (3 renames only).
- **Concurrent sessions** contest the main tree — isolate a worktree before editing (`git worktree list`).
- **Live identity bug:** `getContext` reports name "Altus" (a handle); user is **Martin Balodis**.

## Pickup protocol
1. Read this, then **`CONTEXT-ENGINE-SPEC-2026-06-19.md`** fully, then **Ada's deliverable** (via MCP `getDocument`).
2. Confirm state: `git log origin/main --oneline -6` shows the 4 measurement commits; the app is the old bundle (live `cognitiveState` still shows phantom `indeterminate` milestones → not deployed).
3. Decide the taxonomy (Decision #1).
4. Optional hygiene now via MCP: `remember` name=Martin Balodis (identity fact); `forget` the dev-claims (ids in `PRERELEASE-AI-SURFACE-FINDINGS`).
5. **Build order (foundations first; compass is a later optimization):** **Phase 1** — 1a reflection engine (persona+cycles-as-skills+seed+cloud+live model.md) · 1b **LLM tagging** (register+domain via Ada Templates A/B → `messages.{register,domain}`) + existing clustering · 1c three-tier memory (bounded Core + injection-scan). **Phase 2** — bi-temporal distillation from `model.md`. **Phase 3** — 3a **register compass** (build/validate centroids *from the accumulated Phase-1b LLM labels*, then switch bulk path to cosine) · 3b surfaces (balance chart + honest prediction framing). Both LLM tagging (1b) and compass (3a) coexist. Each behind its gate to `VERDICT: GO`, off fresh `main`, isolated worktree, full `npm run verify` before merge.

## Doc inventory (ordered; ⚠️ = superseded background)
1. **`CONTEXT-ENGINE-SPEC-2026-06-19.md`** — THE build spec (read first).
2. `agent-files/research-agent/research/register-map-research-deliverable-2026-06-10.md` (Ada — via MCP) — validated register implementation.
3. `CONTEXT-ENGINE-MASTER-PLAN-2026-06-19.md` — the plan + Hermes memory section + closed gaps.
4. `AGENT-REFLECTION-SYSTEM-SPEC-2026-06-19.md` — the cycle-prompt port detail.
5. `DESIGN-step3-bitemporal-claims-2026-06-19.md` — the distillation lifecycle detail.
6. ⚠️ `PERSONA-REDESIGN-HANDOFF` + the `DESIGN-persona-*`, `DESIGN-step1/4`, `REFLECTION-ENGINE-PLAN` — background only; pivoted past.
7. `PRERELEASE-AI-SURFACE-FINDINGS-2026-06-19.md` — the live-vault test + the dev-claim ids to prune.

## Verification ledger (handoff)
[✓] lead doc named · [✓] arc + corrections recorded · [✓] Ada's research captured + folded into spec · [✓] prediction-honesty thread noted · [✓] open decisions concrete · [✓] gotchas dated · [✓] pickup protocol executable · [✓] doc inventory with superseded flags · [✓] MEMORY.md points here.
