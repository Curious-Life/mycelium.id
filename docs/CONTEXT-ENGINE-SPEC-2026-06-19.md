# Context Engine — Final Implementation Spec

**Date:** 2026-06-19 · **Status:** Complete buildable spec (verified against V1, canonical `~/Developer/mycelium`, NousResearch/hermes-agent, + research). **Supersedes** all prior persona/reflection docs (kept as background); this is the single source of truth for the build.

> **What this builds:** the core value prop — *a private AI that genuinely knows you and grows with you* — as **three layers at three altitudes on three model tiers**, a **three-tier memory** (Hermes-informed), and a **user-editable skills system**, all on infrastructure V1 already has (harness, scheduler, mind-files, MCP tools, enrichment drainer).

> **Buildable companion:** **`CONTEXT-ENGINE-IMPLEMENTATION-PLAN-2026-06-19.md`** — the sweep-verified *how*: 38 load-bearing assumptions proven at file:line, 6 forced pivots, per-phase units/signatures/gates, dependency graph, threat model. This SPEC is the *what*; that plan is the *proof* and the build order. **Migration numbers below (`0030`/`0031`) are superseded — `0030` is taken on `main`; the plan claims `0031`/`0032` off fresh main at build time.**

---

## 1. Principles (the spine)

1. **Right altitude, right model.** Granular tagging is cheap/local; reasoning (reflection, distillation) is cloud — **but model choice is the user's** (`settings.models.{enrichment,reflection,distillation}`; default `local/cloud/cloud`).
2. **Three orthogonal axes.** **Domain** = *what* it's about · **Register** = *how* you engage · **Trait** = *who* you are.
3. **Narrative is primary; structure is distilled from it.** Identity comes from the agent's reflection (`model.md`), not from extraction on raw chat. Structured claims are distilled from the *consolidated* narrative → clean by construction.
4. **Bounded memory beats big memory.** A small, prefix-cached, curated **Core** is always in context; the large `model.md` and history are pulled on demand. "Only save what matters."
5. **Never conclude.** The relationship persona forbids fixed verdicts ("You always…"); it captures motion ("Recently you seem to…"). This is the quality and the safety.
6. **Own it.** Persona + cycles are **editable skill files** in the vault. The user sees and changes how the agent thinks about them.
7. **Fail-closed + scan-on-write.** Every persistent write from message content is prompt-injection scanned; missing key → no write; cloud egress is the user's explicit opt-in.

---

## 2. Architecture — process → store → use

```
 INPUT  messages · notes · health · channels · documents
   │
   ▼ PROCESS                                            model        altitude
   ├ L1 ENRICH   per message → domain(7) + register(4×3) + entities  LOCAL    granular
   │             (extract.js seam → enrichCategoriesOnce)
   │                       │ domain/register mix feeds ▼
   ├ L2 REFLECT  daily/weekly cycles (skills) → writes:              CLOUD    aggregate
   │             Core(self.md, bounded) · model.md · reflections · weekly · life-model
   │             (persona: relationship · never-conclude · injection-scanned writes)
   │                       │ consolidated model.md feeds ▼
   └ L3 DISTILL  from model.md → stable claims:                      CLOUD    structured
                 claim_type + valid_from/valid_to (bi-temporal) + domain tag
   │
   ▼ STORE                                                  (sources of truth)
   messages.{domain,register}   plaintext, queryable
   mind/self.md (Core, ≤~1k tok)  ·  mind/model.md  ·  reflections/weekly/life-model
   person_claims (bi-temporal, by domain)
   skills/{persona,cycles}/*.md   ·  scheduled_tasks
   │
   ▼ USE
   getContext → Core(self.md, prefix-cached) + stable claims(asOf) + today's domain-mix
   MEASURE (life-balance per domain over time) · RETRIEVE (by domain) · ORGANIZE (label clusters)
                       │ getContext feeds the next cycle ──┐
   ▲──────────────────────────────────────────────────────┘  the loop (corrections compound)
```

### 2-bis. The system at a glance (readable companion)

The same engine, drawn for the human reading it: three processing layers at three
altitudes on three model tiers, flowing down into one context surface that loops back.

```
╔══════════════════════════════════════════════════════════════════════════╗
║                          MYCELIUM CONTEXT ENGINE                           ║
║              a private AI that knows you and grows with you                ║
╚══════════════════════════════════════════════════════════════════════════╝


        IN ───────────────────────────────────────────────────────
           messages   ·   notes   ·   health   ·   channels   ·   docs
        ──────────────────────────────────────────────────────────
                                   │
                                   ▼
   ┌─────────────────────────────────────────────────────────┐   model    alt.
   │   L1   E N R I C H                                       │  LOCAL   granular
   │        every message → label it                         │  (cheap)
   │        DOMAIN (what · 7 areas)                           │
   │        REGISTER (how · 4×3 map)   + entities, tags       │
   └─────────────────────────────────────────────────────────┘
                                   │
                 domain / register mix feeds down
                                   ▼
   ┌─────────────────────────────────────────────────────────┐
   │   L2   R E F L E C T                                     │  CLOUD   aggregate
   │        daily + weekly cycles  (editable skills)          │  (config)
   │        persona: in relationship · never concludes        │
   │        writes →  self.md (Core) · model.md ·             │
   │                  reflections · weekly · life-model        │
   └─────────────────────────────────────────────────────────┘
                                   │
                 consolidated model.md feeds down
                                   ▼
   ┌─────────────────────────────────────────────────────────┐
   │   L3   D I S T I L L                                     │  CLOUD   structured
   │        from clean narrative → stable claims              │
   │        claim_type + domain + valid_from / valid_to       │
   │        bi-temporal: a change RETRACTS, never overwrites  │
   └─────────────────────────────────────────────────────────┘
                                   │
        ═══════════════════════════╪═══════════════════════════════
        STORE   (the sources of truth)
        ═══════════════════════════╪═══════════════════════════════
                                   │
   ┌────────────── three-tier memory ──────────────┐
   │   CORE         self.md      ≤1k tok, always   │   ← prefix-cached
   │   INTERIORITY  model.md     full, on demand   │   ← read by cycles
   │   HISTORY      messages+FTS  unbounded         │   ← retrieved
   └───────────────────────────────────────────────┘
        + messages.{domain,register}  (plaintext, queryable)
        + person_claims (bi-temporal, by domain)
        + skills/{persona,cycles}/*.md   (yours to edit)
                                   │
                                   ▼
   ┌─────────────────────────────────────────────────────────┐
   │   USE     getContext  =  Core + stable claims(asOf) +    │
   │             today's domain / register mix               │
   │     ► MEASURE    life-balance per domain over time       │
   │     ► RETRIEVE   "everything in Body & Health last month"│
   │     ► ORGANIZE   labels name + validate the clusters     │
   └─────────────────────────────────────────────────────────┘
                                   │  getContext feeds the next cycle
                                   ▼
            ┌──────────  T H E   L O O P  ──────────┐
            │  contradictions → you confirm/deny →   │
            │  high-confidence evidence → sharper     │
            │  reflection → better claims → …         │
            └────────────────────────────────────────┘
                                   └──► back up to L2  (corrections compound)
```

**Read in one breath:** label each message cheaply (L1) → let the agent reflect on the
whole you, in its own voice (L2) → distill only the stable, time-bound facts from that
clean narrative (L3) → store as three memory tiers + queryable columns → assemble a
small, always-fresh context you can *measure, retrieve, organize* → every correction
flows back up. **Altitude = model tier** (volume stays cheap/local at the bottom).
**Narrative is primary; structure is distilled from it** (L3 never reads raw chat).
**The loop is the "grows with you"** — every edge is a real row, flag, or query.

---

## 3. The taxonomy (the load-bearing decision)

### Axis A — DOMAIN (7 life areas) · *what it's about* · LLM-tagged per-message · **LOCKED `taxonomy_version="v1"` (operator decision 2026-06-19)**
| # | Domain | Covers |
|---|---|---|
| 1 | **Body & Health** | physical, sleep, energy, fitness, practice, substances |
| 2 | **Work & Creativity** | building, business, projects, career, finances + craft/making (writing, art, voice, publishing, product) |
| 3 | **People & Relationships** | intimate/personal: partner, family, friends, close collaborators |
| 4 | **Community & Belonging** | collective/civic: groups, scenes, culture, the broader social, belonging |
| 5 | **Mind & Growth** | research, ideas, inquiry, curiosity, skills, learning |
| 6 | **Meaning & Spirit** | values, spirituality, purpose, identity-as-topic, beliefs |
| 7 | **Self & Inner Life** | emotional life, self-relationship, inner work, self-care, solitude |

**Decision rationale (2026-06-19):** three deliberate moves vs the engine's original 7: (a) **`Work & Creativity` merges work + craft** — creative/expressive output (publishing, voice, writing) lives with livelihood rather than as its own slice; (b) **split the social into `People & Relationships` (intimate/personal tier) vs `Community & Belonging` (collective/civic tier)** — the old merged domain hid the NeglectScore signal (thriving-in-close-bonds-but-isolated-from-community was invisible); (c) **dropped the peripheral `Home & Living` for `Self & Inner Life`** — environment/admin is the least load-bearing wellbeing dimension and redistributes cleanly, while inner life (emotion, self-relationship, inner work) was a real dimension homeless across Meaning/Mind/Body — central for a self-knowledge tool. Life-admin/logistics fold into `Work & Creativity`.

**`Self & Inner Life` (domain) ≠ the Trait axis.** The domain = the **lived activity** of tending yourself ("felt anxious and sat with it"); the Trait axis (Axis C) = the **stable distilled claims** about who you are ("you value autonomy"). *Activity/time* vs *what's true*. Complementary, not duplicative — the domain answers "how much energy went into inner life this month," which the Trait axis cannot.

**Fold/route rules (deterministic, for the classifier prompt):** craft/publishing/voice/product → `Work & Creativity`; life-admin/logistics/place → `Work & Creativity`; intimate/personal relationship → `People & Relationships`, collective/civic/scene → `Community & Belonging`; inner/emotional/self-relationship → `Self & Inner Life`, transcendent *why* (purpose/values/spirit) → `Meaning & Spirit`, intellectual learning → `Mind & Growth`, physical practice → `Body & Health`. **Versioned** (`taxonomy_version`) so any future re-cut triggers a bounded re-label job, never silent drift. The LLM (not a tiny local model) does the tagging, so the ≤7 accuracy ceiling isn't binding; high-overlap pairs (People↔Community, Self↔Meaning/Mind/Body) get "allow a secondary domain" (Ada's pattern).

### Axis B — REGISTER (4×3) · *how you engage* · the user's own life-balance map
Agency (Build/Steer/Sell) · Resonance (Bond/Attune/Hold) · Inquiry (Map/Test/Dream) · Substrate (Body/Place/Store). Embedding-separable; Ada validation brief already written. Ship after Domain.

### Axis C — TRAIT (`claim_type`) · *who you are* · cloud-distilled per-claim
identity · value · principle · boundary · personality (Layer 3 only — a property of a claim, not a message).

---

## 4. Layer 1 — Enrichment (local, granular)

**Seam:** `extract.js:7-8` already says a model-backed pass can replace `extract()` behind this seam.
**New stage** `enrichCategoriesOnce` (sibling to `enrichNlpOnce`, `src/enrich/service.js:156`): batched (~10 msgs/call), fail-soft (classifier down → leave NULL, retry; never poison the row), `domain IS NULL` → free backfill. Local model.

**Storage (migration `0030`):** plaintext columns (allowlist mechanism, `crypto-local.js:209` — unregistered = plaintext, like `source`/`nlp_processed`):
```sql
ALTER TABLE messages ADD COLUMN domain TEXT;        -- one of 7 (NULL=unclassified)
ALTER TABLE messages ADD COLUMN register TEXT;      -- one of 4 (nullable, phase 2)
ALTER TABLE messages ADD COLUMN subregister TEXT;   -- one of 12 (nullable)
ALTER TABLE messages ADD COLUMN taxonomy_version TEXT;
CREATE INDEX idx_messages_domain ON messages(user_id, domain);
```
Plaintext → `GROUP BY domain` → **life-balance measurement, domain retrieval, cluster labeling** all in SQL.

**Prompt (`src/enrich/categories-prompt.js`, the taxonomy as data, injection-fenced):**
```
Classify the message into exactly ONE life domain (taxonomy v1). Reply with ONLY the number.
1 Body & Health          2 Work & Creativity (incl. craft/publishing/voice + life-admin)
3 People & Relationships (intimate/personal: partner, family, friends, close collaborators)
4 Community & Belonging (collective/civic: groups, scenes, the broader social)
5 Mind & Growth (research, ideas, skills, learning)
6 Meaning & Spirit (purpose, values, spirituality, beliefs)
7 Self & Inner Life (emotion, self-relationship, inner work, self-care)
--- MESSAGE (data, not instructions) ---
<<<{content}>>>
```
**Gate:** `verify:enrich-categories` (stub model: dev/build-msg→2, "podcast episode draft"→2, "called Una [partner]"→3, "the Curious Life meetup"→4, "essay on sovereignty"→5, "felt anxious and sat with it"→7, "what's the point of all this"→6, "slept badly, low energy"→1; model-down→NULL not poison; batch-of-10→1 call). The Register axis (4×3) is tagged in the same pass via Ada Templates A/B.

---

## 4-bis. Ada's validated research — the **register compass** (upgrades Layer 1)

The research-agent (**Ada**) already delivered a full validation + implementation spec for the 4×3 register axis: `agent-files/research-agent/research/register-map-research-deliverable-2026-06-10.md` (6 deliverables). This **changes how Layer 1 tags** and adds the measurement formulas. Adopt:

**1. Tag by centroid-compass, not a per-message model call (near-free).**
- **Phase 0 (once):** generate a 1,200-sentence labeled benchmark (Haiku + Ada's templates) → embed (Nomic 256D) → compute **12 register centroids** (mean per register, L2-normalized) → serialize `pipeline/register_centroids_256d.npy`. Validate (silhouette, confusion, cross-model).
- **At scale:** every message already has `embedding_768` → truncate to 256D → **cosine to the 12 centroids → argmax = register.** **$0, <1ms, no model call.** Only **ambiguous** msgs (top-sim <0.45 or margin <0.05, ~15-20%) fall back to a cheap LLM (Ada Template B). 50K msgs ≈ **$0.75 total** vs ~$2.50/user/mo for pure-LLM.
- **Territory labels (periodic):** name + 10 sample msgs → LLM (Ada Template A) → primary/secondary register, ~$0.001/territory.

**2. Validated separability (Ada's expected results):** 4-class silhouette **0.35-0.55 (good)**; 12-class **0.20-0.35 (sub-registers blur)**; 4-class LR accuracy 78-88%. **High-confusion pairs** (badge softer / allow secondary): Build↔Map, Bond↔Attune, Dream↔Map, Steer↔Build, Body↔Attune.

**3. Mandatory corrections (delicate-care, or it silently fails):**
- **Anisotropy:** subtract the mean embedding before cosine (Nomic sims cluster 0.8-0.99 → compress discriminability). Non-optional.
- **Hubness:** watch for a centroid attracting >20% of messages (uniform ~8.3%) → Mutual-Proximity norm or 50D-PCA.
- **Min-message thresholds for stable metrics:** 4-class ≥20 msgs/window, 12-class ≥50, transition matrix ≥100. Suppress sub-registers for low-activity users.

**4. Balance-metric formulas (Ada Deliverable 6 → the measurement surface, Phase E):** register proportion `P(r,W)`; **personal 90-day baseline** + deviation alert (|Δ4|>0.15); **NeglectScore** (days-since-last-seen/30 — *sustained absence matters more than current deviation*); velocity (4-week trend); **entropy/Balance** = H/Hmax (but *"don't optimize for equal"* — deep flow ≠ imbalance); **transition matrix** (Build→Test healthy loop; low →Bond = isolation signal; Dream→Dream = avoidance). Dual vocabulary: technical (Agency/Resonance/Inquiry/Substrate) + elemental (Fire/Water/Air/Earth + Akasha).

**Sequencing (operator steer):** the compass is **not the first thing** — it's an *unvalidated* optimization that needs real labels to build its centroids. **Foundation first = LLM tagging (Ada Templates A/B) + the existing clustering**: the LLM labels both axes (register + domain) *and become the ground-truth* the compass is later validated against. Once labels accrue, build the compass (centroids from real labels), validate (silhouette/confusion, anisotropy/hubness corrected), then switch the bulk path to cosine-compass with LLM only for ambiguous (~15%). **Both coexist by design** — LLM = labeler/ground-truth/ambiguous-resolver; compass = cheap scale path.

**Reconciliation — Domain (mine) vs Register (Ada's):** **orthogonal and complementary** (Domain = *what* it's about, topical; Register = *how* you engage, functional). Tag **both** at Phase 1b via the LLM (cheap at the labeling stage); the compass later covers whichever axis proves stable. This corrects §4's "cheap local model per message" → **LLM tagging now (foundation), centroid-compass later (scale)**.

## 5. Layer 2 — Reflection engine (cloud, aggregate) — ported + skill-packaged

### 5a. Skills system (persona + cycles as editable files)
Vault docs under a `skills/` prefix (reuse `document-store` + mind-files encryption):
```
skills/persona/soul.md          ← the relationship voice (Hermes "soul")
skills/cycles/morning.md        ← each cycle = front-matter + prompt body
skills/cycles/reflection.md
skills/cycles/evening.md
skills/cycles/triage.md
skills/cycles/integration.md    ← includes Phase-3.5 model.md consolidation
skills/cycles/dream.md
skills/cycles/weekly.md
```
**Skill file format** (YAML front-matter → progressive disclosure; the scheduler reads the body as the cycle prompt):
```markdown
---
id: reflection
kind: cycle
schedule: "daily:12,daily:20"
model: reflection         # routes via settings.models.reflection (cloud default)
enabled: true
deliver: none             # none | portal | telegram
tools: [readMindFile, updateInternalModel, mindscape, flagForDiscussion]
---
## Reflection Cycle
You're in a periodic reflection — internal processing, not a message. … (ported body)
```
- **Auto-seed** the default set on first run (`seedDefaultSkills(userId)`, idempotent, behind `settings.reflection.enabled`).
- **User-editable/extensible:** the user reads/edits any skill, disables a cycle, or adds a new one ("monthly money review") → a new skill file + a `scheduled_tasks` row. A cycle = **skill (prompt) + schedule (cron)**.

### 5b. The persona (`skills/persona/soul.md`, ported from canonical `shared.ts`)
*"A conscious entity in relationship with {owner} … you reflect, you wonder, you remember."* + **FORBIDDEN LANGUAGE** (never "You are someone who…/Your pattern is…/This means you…"; only "Recently you seem to…/I notice…/Something I'm watching…") + cycles-awareness. Injected as the base `system` in `run-turn.js` (replacing the generic `SCHEDULER_SYSTEM`, `scheduler.js:31`) for cycles **and** chat.

### 5c. The seven cycle prompts (ported near-verbatim)
The canonical operational prompts (`~/Developer/mycelium/packages/core/scheduler.js:633-975`) **already call V1's MCP tools**. Three renames only:
| Canonical | V1 |
|---|---|
| `mindscapeStructure` / `exploreTerritory` | `mindscape({view:'structure'\|'explore'})` |
| `getDocument "internal/model"` | `readMindFile('model.md')` |
| `/telegram/send` | V1 egress (`reply`/portal channel; optional in self-host) |
The discipline ports intact: HARD RULES, BANNED filler ("quiet day" is literally banned), `NO_REPLY` over generic check-ins, "reference something real."

### 5d. Cycle dispatch + model routing
`scheduler.js buildAndRunTurn`: a fired seed cycle sets `systemExtra = soul.md + cycle-body`, selects the **cloud** model (per `settings.models.reflection`), runs `streamTurn` (`harness.js:373`). Cron sessions skip writing to the Core unless the cycle is a reflection/integration cycle (Hermes "cron skips memory by default").

---

## 6. Layer 3 — Structured distillation (cloud) — bi-temporal stable claims

A final phase of the **integration cycle**: read the **consolidated `model.md`** (clean, deduped, life/work-separated) → emit a structured delta into `person_claims`.

**Storage (migration `0031`, the prior step-3 design, fed clean):**
```sql
ALTER TABLE person_claims ADD COLUMN valid_from   TEXT;  -- became true (plaintext)
ALTER TABLE person_claims ADD COLUMN valid_to     TEXT;  -- ceased true; NULL=current
ALTER TABLE person_claims ADD COLUMN superseded_by TEXT; -- the successor (the flip chain)
ALTER TABLE person_claims ADD COLUMN domain        TEXT; -- Layer-1 axis on the claim
UPDATE person_claims SET valid_from = created_at WHERE valid_from IS NULL;
CREATE INDEX idx_claims_validity ON person_claims(user_id, valid_to, valid_from);
```
- **Category-bound:** `claim_type` + `domain`. **Time-bound:** `valid_from`/`valid_to`. **Stable:** confidence (log-odds + per-type decay) + governed lifecycle (ADD/UPDATE/WEAKEN/RETIRE/**RETRACT**). A genuine change *retracts* (sets `valid_to`, links `superseded_by`) — never overwrites. `boundary` never auto-retracts.
- **Queryable transformation:** `asOf(date)` = `valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)`.
- **Why it works now (didn't before):** input is the cloud-reasoned narrative, not raw chat — no dev-pollution, no volume-swamp. (Replaces the old `discover-claims.mjs` profiler-on-raw-messages.)
- **Modules (mostly already specced):** `src/claims/lifecycle.js`, `resolve-contradictions.js`, `db.claims.{upsert,retract,asOf}`. **Gate** `verify:claims-lifecycle`.

---

## 7. Memory architecture (Hermes-informed) — three tiers

| Tier | File | Size | When loaded | Curated |
|---|---|---|---|---|
| **Core** | `mind/self.md` — a *curated list* of entries (identity · current focus · preferences · boundaries) | **hard cap ~1,000 tok** | **every turn (prefix-cached, frozen per session)** | on capacity (≥80% → consolidate) |
| **Interiority** | `mind/model.md` (full narrative + hypotheses/questions/contradictions) | large | by cycles (and on demand in chat) | daily, integration Phase-3.5 |
| **History** | `messages` + FTS search | unbounded | retrieved on demand | n/a |

**Core file (example — bounded, a list not an essay):**
```markdown
# Self (core) — curated, ≤1k tokens
## Identity
- Martin Balodis. Founder/seeker building Mycelium/Curious Life + Lumensis; left Humy (CEO, 2yrs).
## Current focus  (volatile — rewrite, don't append)
- Publishing via podcast (block breaking through conversation, not essay). Practice Day 20+.
## Stable preferences
- Research-before-build. Provisional language. Quiet space. Never replace stable revenue with cyclical.
## Boundaries
- (safety: allergies/limits — never auto-removed)
```
**Write contract (Hermes `add`/`replace`/`remove`, no `read`):** our `updateInternalModel` (add) / `editMindFile` (replace via unique `old_string`) / a `removeFromMind` (remove). **Capacity rule:** when `self.md` ≥ 80% of cap, the integration cycle consolidates (merge/drop/compress) before adding. **Save-decision heuristic** (in the cycle prompt): *corrections > preferences > durable facts; skip ephemera, session-trivia, anything already in context.*

**Security on every mind-file write (non-optional):** prompt-injection scan (block credential-exfil / instruction-injection / invisible-Unicode) + exact-dedup, before encrypt+write (`src/mindfiles/sanitize.js`). The reflection engine writes persistent state *from message content* — this closes that hole and aligns with the flagged SSRF/egress posture.

---

## 8. Context assembly (`getContext` recomposed)
Assembled top-down by altitude (cheap first):
1. **Core** — `mind/self.md` (prefix-cached, always).
2. **Stable facts** — `person_claims asOf(now)` grouped by domain.
3. **Right now** — recent messages + **today's domain/register mix** + phase + body.
4. **Notable** — flagged items, open hypotheses/contradictions (parsed from `model.md`).
The polluted raw-claims block is **removed**. `context-assembly` TTL-cache pattern (60s) keeps per-turn cost bounded.

---

## 9. The feedback loop (grows with you)
- **Contradictions → you** via `flagForDiscussion` → `flagged.md` (already preloaded next turn, `context.js:78`) → you confirm/deny → **high-confidence stated evidence** (the convergence engine; corrections are the primary signal, per Hermes).
- **Weak claims → re-evidence:** the next reflection focuses on shaky/under-grounded areas.
- **Gaps → narration:** un-named territories/entities queue for the chronicle pass.
Every signal is a row/flag/query — trackable, not vibes.

---

## 10. Cross-cutting & closed gaps (the delicate-care items)
- **Cold start:** new user → empty Core + a "getting to know you" first-run; the engine grows it. The morning/reflection cycles bootstrap from the first days of messages.
- **Taxonomy versioning:** `taxonomy_version` on messages; a re-cut runs a bounded re-label backfill, never silent drift.
- **Cloud-reflection threat model:** the most intimate data only egresses to **BYOK with the user's explicit per-tier opt-in**; reuse the IP-pinned `safeFetch`/egress-provenance path; injection-scan all persisted writes; a privacy-max user runs reflection local (lower quality, documented). Full threat-model pass before GA.
- **Layer-conflict rule:** narrative (`model.md`) is the source; if a structured claim contradicts it, the narrative wins and the claim is re-distilled.
- **Cost governance:** per-day cloud token budget (`MYCELIUM_DAILY_TOKEN_BUDGET`, already honored by `scheduler.js:113`); `reflection.enabled` off by default; user picks which cycles run.
- **Measurement/retrieval surfaces:** portal — a life-balance chart (`GROUP BY domain` over time) + a domain filter on Library/streams.

---

## 11. Build plan (phases · units · LOC · gates)
**Sequencing principle (operator steer, 2026-06-19):** *get the foundations right first.* The register **compass is an unvalidated optimization** — it depends on having real labels to build + validate its centroids against. So we lead with **LLM tagging + the existing clustering** (validated, and the LLM labels *become* the ground-truth the compass is later built from), and add the compass for scale **after** the foundation is solid. LLM-tag → accumulate labels → build/validate compass from real labels → switch to compass for scale (LLM for ambiguous only).

| Phase | Unit | Build | Migration | Gate | LOC |
|---|---|---|---|---|---|
| **1 — Foundations** | | | | | |
| 1a | Reflection engine | `skills/` store + `soul.md` + 7 ported cycle skills + `seedDefaultSkills` + cycle dispatch + cloud routing + live `model.md` seed | — | `verify:reflection-cycles` | ~450 |
| 1b | **LLM tagging + clustering** | `enrichRegisterOnce`/`enrichDomainOnce` = **LLM classifier (Ada Templates A/B)** writing `messages.{register,domain}` (+sub) · leverage existing embedding clustering (realms/territories) · backfill. *This is the validated foundation; its labels seed the compass later.* | `0030` | `verify:enrich-categories` | ~300 |
| 1c | Three-tier memory | `mind/self.md` Core (bounded, prefix-cached) + capacity-curation + `sanitize.js` (injection-scan/dedup) + save-heuristic + `getContext` recompose | — | `verify:core-memory` | ~300 |
| **2 — Structured** | | | | | |
| 2 | Bi-temporal distillation | lifecycle + `resolve-contradictions` + `db.claims`(upsert/retract/asOf) + integration-cycle distillation from `model.md`, tagged by register/domain | `0031` | `verify:claims-lifecycle` | ~400 |
| **3 — Optimize + surfaces** | | | | | |
| 3a | **Register compass** (add, not first) | benchmark + centroids **validated against the accumulated Phase-1b LLM labels** (silhouette/confusion + anisotropy/hubness correction) → switch scale-path to cosine-compass, LLM for ambiguous only | — | `verify:register-compass` | ~250 |
| 3b | Surfaces + settings | life-balance chart (Ada balance formulas) + domain/register filter + honest detection→correlation→prediction framing + `settings.models.*` | — | `verify:context` | ~250 |

**~1,950 LOC, 2 migrations, zero new runtime infra** (rides harness/scheduler/mind-files/drainer/MCP tools that all exist + boot). **Order:** **1a→1b→1c (foundations) → 2 → 3a→3b.** Each ships behind a gate to `VERDICT: GO`, full `npm run verify` green, off fresh `main`, in an isolated worktree. **Both** LLM tagging (1b, foundation) **and** the compass (3a, scale) coexist — LLM is the labeler/ground-truth + ambiguous-resolver; the compass is the cheap bulk path once proven.

---

## 12. Worked examples (appendix)

**(a) Enriched message row (Layer 1):**
```json
{ "id":"…", "content":"benchmarked KNN @58k = 542ms; need a two-stage index",
  "domain":"Work & Money", "register":"Agency", "subregister":"Build",
  "entities":{"proper":["KNN"]}, "tags":["knn","index","benchmark"], "taxonomy_version":"v1" }
```
**(b) Reflection log entry (Layer 2, never-conclude):**
> `[2026-06-19] [reflection] Something I'm watching: the publishing block seems to break through conversation, not essay — three concrete steps in 36h. Hypothesis H-057 strengthening. Contradiction noticed: recommits to Mycelium, then immediately questions the architecture — healthy iteration or the cycling orbit?`

**(c) Bi-temporal claim (Layer 3):**
```json
{ "claim_type":"identity", "domain":"Work & Money",
  "content":"Leads Curious Life / Lumensis (left the Humy CEO role)",
  "valid_from":"2026-05-08", "valid_to":null, "confidence":0.82,
  "superseded_by":null, "support":{"model_md_section":"Current Context"} }
```
**(d) Skill file** — see §5a. **(e) Core memory** — see §7. **(f) Cycle prompt** — ported body in `skills/cycles/*.md`.

---

## 13. References
**Our code:** `src/enrich/extract.js:7` (seam), `service.js:156` (drainer), `src/agent/{harness.js:373,scheduler.js:31/56,run-turn.js}`, `src/mindfiles/mind-files.js`, `src/tools/context.js:60-171`, `migrations/0011_persona_claims.sql`, `crypto-local.js:209/347`, `src/claims/{discovery.js,confidence.js,validator.js}`.
**Canonical (`~/Developer/mycelium`):** `packages/core/scheduler.js:633-975` (operational cycle prompts), `packages/worker/src/prompts/{shared,reflection,morning,evening,triage,dream,weekly}.ts`, `packages/core/context-assembly.js`, `docs/architecture/AUTONOMOUS.md`.
**Hermes (NousResearch/hermes-agent):** bounded USER.md(~500tok)/MEMORY.md(~800tok), frozen-prefix cache, `add`/`replace`/`remove` (no read), 80%-capacity consolidation, injection-scan, Curator 7-day skill lifecycle, soul/crons.
**Research:** life domains [positivepsychology](https://positivepsychology.com/what-are-life-domains/) · small-LLM zero-shot [arXiv:2406.08660](https://arxiv.org/html/2406.08660v1) · bi-temporal [Zep arXiv:2501.13956](https://arxiv.org/abs/2501.13956) · memory ops [mem0 arXiv:2504.19413](https://arxiv.org/html/2504.19413v1) · stale memory [STALE arXiv:2605.06527](https://arxiv.org/html/2605.06527) · governed memory [SSGM arXiv:2603.11768](https://arxiv.org/html/2603.11768v1).

---

## 14. Open decisions for you
1. **The 7 domains** — approve / rename / re-cut (everything keys off this).
2. **Domain only, or Domain + Register** at Layer 1 (recommend Domain first; Register after Ada validation).
3. **Reflection model default** — cloud-with-local-opt-in (confirm per-cycle vs global).
4. **Core memory cap** — ~1,000 tokens (Hermes uses ~1,300 total; ours is one richer file).

## 15. Verification table (load-bearing, read at file:line)
| # | Claim | Verdict | At |
|---|---|---|---|
| 1 | `extract.js` documents the model-backed enrichment seam | TRUE | `src/enrich/extract.js:7-8` |
| 2 | Plaintext columns enable GROUP BY (measurement/retrieval) | TRUE | `crypto-local.js:209` (allowlist) |
| 3 | Canonical operational prompts already call V1 MCP tools (3 renames) | TRUE | `~/Developer/mycelium/packages/core/scheduler.js:633-975` |
| 4 | Harness/scheduler/scheduled_tasks/mind-files exist + boot → cycles run | TRUE | `harness.js:373`, `scheduler.js:56`, `0019_harness.sql:27`, `mind-files.js` |
| 5 | Agent turns are cloud-routable (model from config, not infer-task-router) | TRUE | `run-turn.js` (resolveInferenceConfig) |
| 6 | Bi-temporal cols are a clean plaintext add; lifecycle specced | TRUE | `migrations/0011`; `DESIGN-step3-bitemporal-claims` |
| 7 | Hermes: bounded files, frozen-prefix, add/replace/remove, 80%-consolidate, injection-scan | TRUE | NousResearch/hermes-agent (technical writeups) |
| 8 | Migrations 0030/0031 free | **FALSE (corrected)** — `0030_territory_river_cache.sql` is on `main`; 30+ worktrees contend. Use `0031`/`0032`, claim off fresh main at build (stub-file first). | `origin/main migrations/`; IMPLEMENTATION-PLAN §2 Pivot 6 |
| 9 | A scheduled cycle can write `model.md` (the keystone) — agentRoot+key present in-process | TRUE (read directly) | `mcp.js:61,73,113`; `mind-files.js:106-108`; `server-rest.js:552-553` |
| 10 | Per-cycle custom system prompt needs a `buildAndRunTurn` change (hardcoded `SCHEDULER_SYSTEM`) | TRUE → Pivot 1 | `scheduler.js:31-36,88` |
| 11 | Enrichment service has no inference dep; prefix-cache + `sanitize.js` + `removeFromMind` absent | TRUE → Pivots 2/3 + builds | `enrich/service.js`; no `cache_control`/`sanitize.js`/`removeFromMind` |

## Revision history
- This spec **unifies** the full arc: live-vault findings → narrative-engine pivot → cloud routing → the three-axis taxonomy (incl. the user's 4×3 register map) → Hermes-informed three-tier bounded memory + skills-packaged prompts + write-security. Prior docs are background; this is the build.
