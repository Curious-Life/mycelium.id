# Context Engine — BUILD handoff (read first, cold)

**Date:** 2026-06-19 · **Audience:** the next instance (likely post-compaction). **This is the as-built state.** Supersedes `CONTEXT-ENGINE-HANDOFF-2026-06-19.md` (design-only, pre-build).

## TL;DR — where everything is
- **Worktree:** `/Users/altus/Documents/GitHub/mycelium-id-worktrees/ctx-engine-1a` · **branch:** `feat/context-engine-1a-reflection` (off `main` `0858e89`) · **HEAD `19461af`**. **NOT merged / pushed / deployed.** Isolated worktree (the main tree is contested).
- **PHASE 2 COMPLETE** (2a schema · 2b lifecycle · 2c-core `distill.js` · **2c-wire** `proposeClaim` tool · **2d** getContext asOf + profiler deprecation). **9 engine gates GO** — `verify:reflection-cycles · enrich-categories · mindfile-sanitize · core-context · reflection-records · claims-bitemporal · claims-lifecycle · claims-distill · claims-distill-tool` (+ `context · rest · mcp · mindscape · claims-discovery` regress GREEN). Run them first to confirm the baseline.

## ⏱ DO THIS FIRST — deploy + live-smoke the foundation, THEN Phase 3
**State:** the Context Engine is built end-to-end through L3 (the bi-temporal, anti-self-anchoring claims governance) AND wired to the agent + the briefing. Per design-rigor (verify before building on top), the next step is the REAL proof — not more code.

**Step 1 — deploy + live-smoke (the real proof).** Rebuild the app from this branch; enable reflection; let a cycle fire and watch the whole loop: the integration cycle consolidates `model.md` → distills the Core (`self.md`) → writes a day card (`recordReflection`) → clusters recent day cards → calls `proposeClaim` for a recurring tendency. Then `getContext` should surface that tendency (once it clears the distinct-day bar) under "WHAT YOU'VE NOTICED — TENDENCIES", grouped by domain. Confirm: claims now accrue ONLY from day cards (the raw-message profiler is off); a one-off tendency stays pending; a tendency seen across ≥3 distinct days promotes.
- **embed-service must be up** (:8091) for `proposeClaim`'s dedup/corroboration to work — without it a claim is still added, just without a vector (no dedup that round). Ollama (or a cloud key routed to the `reflection` task) must be up for the cycle turn itself.

**Step 2 — wire contradiction `validate` (the one deferred piece).** `proposeClaim` ships WITHOUT contradiction auto-retraction because a correct in-process `infer` must honor §4g (`sensitive → on-box`, no US egress) via `resolveProviderChain` — reusable inference-layer plumbing, not hand-rolled in a tool. It's a DROP-IN: `createClaimsDistillDomain` already accepts `infer`/`validate`; build a sensitive-aware `infer` (mirror `run-turn.js`'s `resolveInferenceConfigForTask` + `resolveProviderChain({sensitive:true})` → router with on-box fallback), pass it at the `mcp.js` registration, done. Until then nothing auto-retracts (safe; human-reviewed merge is the backstop).

**Step 3 — Phase 3.** 3a register compass (centroids from accrued 1b labels + anisotropy mean-subtraction; reuse `cluster.py compute_and_store_centroids_256d`) · 3b surfaces (life-balance chart from `domainMix` + the day-card timeline/red-threads from `db.reflections` + claim tendencies; wire `settings.models.{enrichment,distillation}` into the per-task lane — `reflection` already there). 3b is frontend → needs the live WKWebView (see the webkit-shader-verify discipline).
- **GOTCHA:** the bare worktree has no `node_modules` — it's **symlinked** to the main checkout (`ln -sfn /Users/altus/Documents/GitHub/mycelium.id/node_modules node_modules`) so native-dep gates run. `node_modules` is gitignored; the symlink is never committed.
- **Build source of truth:** `CONTEXT-ENGINE-SPEC-2026-06-19.md` (what) · `CONTEXT-ENGINE-IMPLEMENTATION-PLAN-2026-06-19.md` (how, with per-phase as-built notes) · `CONTEXT-ENGINE-PHASE2-DESIGN-2026-06-19.md` (the claims layer) · `CONTEXT-ENGINE-CORE-INTERACTION-DESIGN-2026-06-19.md` (agent↔memory, end-to-end) · `SCIENCE-phase2-bitemporal-claims-2026-06-19.md` (Ada's brief).

### Commit ledger (all on the branch, all gated `VERDICT: GO`)
| commit | what | gate |
|---|---|---|
| `e80ea30` | **1a** reflection engine — 6 cycles run headless via the scheduler w/ persona + cloud routing; `NO_REPLY` deliver-guard; `created_by='reflection-cycle'` marker (no migration) | `verify:reflection-cycles` |
| `79f0da4` | **1a+** editable skills — persona = editable `skills/persona/soul.md` doc; `updateCycle`/`updatePersona`/`listCycles`/`getCyclePrompt` tools (chat-grantable `cycles` domain) | (reflection-cycles) |
| `13b3d0a` | **1b** domain+register tagging — migration `0031`; `enrichCategoriesOnce` drainer stage; on-box LLM; fail-soft; taxonomy v1 | `verify:enrich-categories` |
| `7e41336` | **1c-A** `sanitize.js` — scan-on-write at the single `writeMindFile` chokepoint, fail-closed; blocks bidi/zero-width + live credentials + oversize; low-FP | `verify:mindfile-sanitize` |
| `fc5a723` | **1c-B/C** bounded Core (`self.md` leads getContext) + `domainMix` "TODAY'S SHAPE" + claims demoted; integration Phase 3.6 distills the Core; `removeFromMind` | `verify:core-context` |
| `69c2c19` | settings label — reflection routing shows in Settings → AI per-task lane | — |
| `d4e5e10` | **1d** reflection records — migration `0032`; per-cycle "day cards" (`recordReflection`/`listReflections`, `db.reflections`); every cycle logs one | `verify:reflection-records` |
| `35bf772` | **Phase 2 design** (Ada's science → verified code) | — |
| `006252e` | **2a** bi-temporal claims schema — migration `0033`; +6 cols (incl. `variability`/`context_primary`); `db.claims` retract/promote/asOf/recordChange/believedAsOf | `verify:claims-bitemporal` |
| `f4183e8` | **2b** AGM lifecycle + contradiction-resolve — `lifecycle.js` (decideOp/`evidenceWeight`[C]/shouldPromote+shouldRetire[A]/updateConfidence) + `resolve-contradictions.js` (cosine-band→validate→retract, source-priority) | `verify:claims-lifecycle` |
| `cd9ef40` | **2c-core** distillation orchestration — `distill.js` (identity-match→resolve→decideOp→upsert/promote/retract + recordChange; C: confidence from day-card observations) + `listForMatch` incl `pending` | `verify:claims-distill` |
| `050885a` | **2c-wire** `proposeClaim` + `listClaimsHistory` tools (`tools/claims-distill.js`) wrapping `createDistiller`; raw-Buffer vector store + SYNC similarity; registered in `mcp.js` + chat-grantable `claims-distill`; integration cycle Phase 3.8 | `verify:claims-distill-tool` |
| `19461af` | **2d** getContext reads `db.claims.asOf(now)` rendered as domain-grouped TENDENCIES; legacy raw-message profiler OFF by default (reversible via `MYCELIUM_LEGACY_CLAIM_DISCOVERY=1`) | `core-context · context · rest · claims-discovery` |

## 2026-06-19 PM session — 2c-wire + 2d landed (start here for the pivots)
Phase 2 is now COMPLETE. Two **load-bearing pivots from this very handoff's recipe**, both forced by reading the real code (the sweep-first protocol earning its keep — the original recipe would not have compiled / would have leaked):
1. **Vectors store as a raw little-endian float32 `Buffer` (`encodeVectorRaw`), decoded SYNCHRONOUSLY — NOT a wrapped-DEK envelope decrypted in `similarity`.** Why: `distill.js:26` + `resolve-contradictions.js:37` call `similarity()` **un-awaited**, so an `await decryptVector(...)` inside it was structurally impossible. The sanctioned post-"SQLCipher Stage A" vector format IS raw bytes (confidentiality = the whole-file-encrypted vault), so no master key is needed on decode. Also discovered: the legacy `discovery.js` **never stored `embedding_768` at all** (it re-embeds the pool fresh each run), so the column is NULL on the live vault — the "decrypt stored envelope" recipe rested on data that doesn't exist.
2. **Contradiction `validate` is DEFERRED, not wired.** `infer` is NOT threaded into MCP tool domains (the existing claims pipeline runs as a spawned child with its own infer). A correct in-process infer must honor §4g (`sensitive → on-box`) via `resolveProviderChain` — reusable inference plumbing that belongs in the inference layer, not a tool file. `distill.js` treats `validate` as optional (`if (… && validate)`) and skips contradiction-resolution cleanly when absent — SAFE (nothing auto-retracts; the "inferred can't override user-stated" invariant holds vacuously). Reviewer-C (confidence only from day cards) is enforced regardless. It's a one-line drop-in once the sensitive-aware infer exists (Step 2 above).

**Operator decision recorded:** the raw-message psychological profiler (`discover-claims.mjs`) is deprecated as the claims source — claims now distill from the agent's consolidated `model.md` / day cards (the designed end state per `AGENT-REFLECTION-SYSTEM-SPEC-2026-06-19.md`). It's gated OFF by default but kept fully intact + reversible (`MYCELIUM_LEGACY_CLAIM_DISCOVERY=1`); existing vault claims still surface via `asOf`, so the surface doesn't empty — it stops growing from raw chat and starts growing from day cards. Caller audit: sole runtime trigger was `server-rest.js:518` (the claims heartbeat); the child + its gate + `demo-claims.mjs` are untouched and still pass.

**Gotcha (this session):** `recordChange` stamps `new Date()` (real clock, not the injected `now`), so an `added`→`promoted` pair in the same in-memory test millisecond collides on the snapshot unique key (`…window_end…`) → DO-UPDATE collapses to the latter. Documented same-ms behavior (`claims.js:218`); a non-issue in the real nightly system (add + promote land on different cycle runs). The tool gate asserts the latest recorded change, not both.

## The arc — key insights (don't relearn these)
1. **The product:** a private AI that genuinely knows you and grows with you. Three layers (L1 enrich · L2 reflect · L3 distill) × three memory tiers (Core `self.md` / interiority `model.md` / history) + an editable skills system. All on infra V1 already has.
2. **PIVOT (load-bearing):** the system that *actually* knows the user is the **narrative reflection engine** (agent-authored `model.md` + cycles), not the structured `person_claims`. The live `model.md` (read via MCP — 372KB, ~80% of context/turn) is *excellent* — which is exactly why the **bounded Core (self.md)** exists.
3. **The keystone that made 1a safe:** a scheduled cycle CAN write `model.md` in-process — `mcp.js:61` defaults `agentRoot` to `data/mind`; the same `handlers` go to `createScheduler` (`server-rest.js:553`). The old "document-only" blocker was a *spawned pipeline child*, not the scheduler.
4. **Taxonomy v1 LOCKED (operator):** 7 DOMAINS = Body & Health · Work & Creativity · People & Relationships · Community & Belonging · Mind & Growth · Meaning & Spirit · Self & Inner Life. REGISTER = Ada's 4×3 (Agency/Resonance/Inquiry/Substrate). `Self & Inner Life` (domain) ≠ the Trait axis (claim_type). Fold rules in SPEC §3.
5. **"Structured, not a copy"** (recurs everywhere): day-cards are structured records (not a text dump); the Core is 5 sections; claim variability/context are real columns. The user pushes hard on this — honor it.
6. **Phase 2 = three sciences** (Ada): bi-temporal storage + AGM revision + Generative-Agents reflection, governed by Whole Trait Theory: **a stable claim is a DISTRIBUTION of states, never "you are X."** Most of it already exists in code (`confidence.js` = a log-odds posterior; `decay_class` = the active/stable axis; `person_claim_snapshots` = transaction-time) → **extend, not new table.**
7. **The through-lines:** provenance everywhere · distribution-not-point (reflection-not-diagnosis) · confidence-as-earned-posterior-with-a-bar (CVP gate) · never-destructively-delete (supersede + audit) · semantic-not-string · **guard the agent's self-anchoring**.

## Phase 2 — state + the 4 reviewer refinements (CRITICAL for 2b/2c)
**2a DONE** (`006252e`): schema extended; `db.claims` bi-temporal methods. **B** (structured variability/context) + **D** (per-change transaction-time `recordChange`/`believedAsOf` — the existing snapshots were periodic per-window, gappy) were settled inside 2a and gate-proven.

**The 4 reviewer refinements — ALL DONE + gate-proven** (B/D in 2a, C/A in 2b/2c):
- **C ✅ (the one not to ship without):** confidence moves ONLY on day-card observations — `evidenceWeight(agent-inferred)=0` in `lifecycle.js`; `distill.js` accrues confidence from the day-card dates in `support`, never the synthesis. Gate proves a self-restatement leaves log-odds unchanged.
- **A ✅:** `promoteLogodds()`/`retireLogodds()` env-calibratable (`MYCELIUM_CLAIM_PROMOTE_LOGODDS`≈1.27, `..._RETIRE_LOGODDS`≈-0.85); `MIN_DISTINCT_DAYS` scales by `decay_class` (identity/boundary=5, fact=3, preference/mood=2); `boundary` never auto-retires.
- **B ✅** (2a): `variability REAL` + `context_primary TEXT` structured columns + `support.contexts` JSON. **D ✅** (2a): per-change `recordChange`/`believedAsOf` (the snapshots were periodic/gappy).
- **Still to honor in 2c-wire/2d:** **source-priority** (`resolve-contradictions.js` already does user-stated > agent-inferred — wire `source:'user-stated'` when a claim comes from a user statement); deprecate `discover-claims.mjs`; **human-reviewed merge** (highest-value memory); pending excluded from getContext (CVP — `asOf`/`listActive` already enforce it).

**Remaining build (Phase 2):**
- **2b ✅ DONE** (`f4183e8`) — `src/claims/lifecycle.js` (decideOp/shouldPromote[A]/shouldRetire[A]/validFrom/**evidenceWeight[C]**/updateConfidence) + `src/claims/resolve-contradictions.js` (cosine-band 0.5–0.9 → validator → retract + source-priority). `verify:claims-lifecycle` 23/0.
- **2c-core ✅ DONE** (next commit) — `src/claims/distill.js` (the orchestration: identity-match → resolve-contradictions → decideOp → upsert/promote/retract + per-change record; C enforced — confidence accrues from day-card OBSERVATIONS, never the synthesis). Also fixed `db.claims.listForMatch` to include `pending` (corroborate, not duplicate). `verify:claims-distill` 10/0 (full loop over real db.claims).
- **2c-wire (remaining):** the `proposeClaim` + `listClaimsHistory` TOOLS wrapping `createDistiller` — inject the embed client + `createValidator({infer})` + a `similarity(rawVec, envelope)` = cosine over `decryptVector` (best-effort, null→skip, fail-safe). Register in `mcp.js` + a chat-grantable domain. Then the integration cycle **Phase 3.8** prompt: cluster recent `db.reflections` day-cards by theme-embedding → for each theme w/ ≥3 day-cards, call `proposeClaim({…, dayCardDates, source:'agent-inferred'})` phrased as a TENDENCY (variability + context), never "is X". `proposeClaim` to each cycle's enabledTools (integration esp.).
- **2d (remaining):** `getContext` asOf swap (replace `listActive` at `context.js:198-204` with `db.claims.asOf(now)` grouped by domain, rendered as tendencies w/ variability+context, pending-excluded — closes the 1c claims-block deferral) + deprecate `discover-claims.mjs` (caller audit `jobs.js:418`; point the heartbeat at the distillation path; stop spawning the raw-message profiler). Gate `verify:context` + the caller audit.

**Then Phase 3:** 3a register compass (centroids from accrued 1b labels + anisotropy fix) · 3b surfaces (life-balance chart from domainMix + the day-card timeline/red-threads + claim tendencies; wire `settings.models.{enrichment,distillation}`).

## Gotchas (dated 2026-06-19)
- **Migration numbers** (off fresh main, 30+ worktrees contend): main highest `0030`; this branch added `0031`(categories) `0032`(reflection_records) `0033`(claims-bitemporal). **Next free = `0034`.**
- **node_modules symlink** (above) — needed to run native-dep gates in the bare worktree.
- `confidence_logodds` encrypted → confidence filters are **JS-side**, not SQL.
- New claim columns (valid_from/valid_to/superseded_by/domain/variability/context_primary) are **plaintext** (queryable) — `verify:claims` confirms no cleartext leak / no phantom columns.
- Cycle bodies are **mutated at module-load** (cycle-prompts.js appends the recordReflection tail in a `for` loop) — editing the body constant won't re-seed an existing task (seed is idempotent-by-name; fresh installs only).
- **Security-sensitive** (CLAUDE.md §1-13): Phase 2 writes the highest-value memory; cloud reflection over a custom `base_url` must route through `safeFetch` before GA (known SSRF gap). Human-reviewed merge.

## Pickup protocol
1. Read this, then `CONTEXT-ENGINE-PHASE2-DESIGN-2026-06-19.md` §2a (the 4 refinements) + `confidence.js` (the posterior you build the bar on).
2. `cd` the worktree; ensure the `node_modules` symlink; `git log --oneline -10` should show `006252e` at HEAD.
3. Build **2b** (lifecycle + resolve-contradictions) — bake in **C** (`evidenceWeight(agent-inferred)=0`) and **A** (config + decay_class-scaled bar + retire floor). Gate `verify:claims-lifecycle` to GO.
4. Then 2c, 2d, Phase 3. Each: isolated edits, full gate, no-regression on `claims*`/`mcp`/`context`, human-review before any merge.
5. `npm run verify:reflection-cycles / enrich-categories / mindfile-sanitize / core-context / reflection-records / claims-bitemporal` should all be GREEN.

## Deferred / make-it-real (named, not dropped)
- **Deploy + live-smoke** the foundation (app rebuild + Ollama + cloud key; enable reflection; watch a cycle fire → distill the Core → write a day card). Turns "gated" into "proven."
- cloud-configurable **enrichment** model (`settings.models.enrichment`); persona on **chat** turns (cycle-only today); **portal editors** for the Core text + cycle bodies; doc-mirror writes (`documents.js`) gated by sanitize too; the SSRF `base_url` gate.

## Verification ledger (handoff)
[✓] all 9 commits named w/ hash + gate · [✓] arc + 7 insights recorded · [✓] taxonomy v1 locked · [✓] Phase 2 4-refinements (C the keystone) · [✓] remaining build 2b-3b · [✓] gotchas dated · [✓] pickup executable · [✓] deferred named · [✓] memory updated (persona-transformation-redesign + MEMORY.md).
