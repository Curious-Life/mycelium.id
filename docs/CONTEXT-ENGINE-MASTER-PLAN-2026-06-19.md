# Context Engine — master plan (the system that knows you)

**Date:** 2026-06-19 · **Status:** Full plan (research + code-verified). The unifying plan over three layers. Companions: `AGENT-REFLECTION-SYSTEM-SPEC` (the cycle prompts), `DESIGN-step3-bitemporal-claims` (the structured lifecycle).

The system knows a person through **three layers at three altitudes, each on the right model tier**, feeding one context surface:

| Layer | Altitude | Model | Produces |
|---|---|---|---|
| **1. Enrichment** | per-message/data (granular) | **LOCAL (cheap)** | category labels (domain + register), entities, tags |
| **2. Reflection** | aggregate (the whole person) | **CLOUD (configurable)** | `model.md`, reflections, weekly reviews, life-model |
| **3. Distillation** | structured stable facts | **CLOUD** | time-bound, category-bound bi-temporal claims |

Model routing is a **user choice** (default as above): a privacy-max user may run reflection on local too (accepting lower quality); a quality-max user runs cloud. `settings.models.{enrichment,reflection,distillation}`.

---

## Layer 1 — Granular enrichment (the new substrate; cheap local)

Today `extract.js` does deterministic regex tags (urls/people/money/dates/keywords) — its header already anticipates *"a model-backed pass can later replace extract() behind this same seam."* We take that seam and add a **cheap-local categorization pass** that labels every message/data item on two orthogonal axes.

### The taxonomy (the load-bearing design decision)

**Axis A — DOMAIN (what it's *about*): 7 life areas.** Simple, descriptive, intuitive for retrieval/organization, and ≤7 so a small local model classifies it reliably (research-confirmed). Proposed (for your review):

| # | Domain | Covers |
|---|---|---|
| 1 | **Work & Money** | building, business, projects, career, finances |
| 2 | **People & Relationships** | partner, family, friends, collaborators |
| 3 | **Body & Health** | physical, sleep, energy, fitness, practice, substances |
| 4 | **Meaning & Spirit** | values, spirituality, purpose, identity, beliefs |
| 5 | **Mind & Learning** | research, ideas, inquiry, curiosity, skills |
| 6 | **Craft & Creation** | writing, making, art, voice, publishing |
| 7 | **Home & Living** | place, logistics, routines, admin, environment |

**Axis B — REGISTER (the *mode of engagement*): your 4×3 Register Map** — reuse, don't reinvent. Agency (Build/Steer/Sell) · Resonance (Bond/Attune/Hold) · Inquiry (Map/Test/Dream) · Substrate (Body/Place/Store). Embedding-separable, with the Ada validation brief already written. This is the **life-balance measurement** axis.

**Axis C — TRAIT TYPE** (`claim_type`: identity/value/principle/boundary/personality) is **not** a per-message tag — it belongs to Layer 3 (a property of a *claim*, not a *message*).

> Domain = *what* · Register = *how* · Trait = *who*. Three orthogonal axes; the first two are cheap-local per-message, the third is cloud-distilled per-claim.

### How it stores & why it's powerful
`messages.domain` + `messages.register` + `messages.subregister` — **plaintext** columns (like `source`/`nlp_processed`), so SQL can `GROUP BY`. That single move unlocks:
- **Measure** — time/energy per domain over time = a literal **life-balance chart** (your register map's original purpose).
- **Cluster** — domain/register as labels validate + name the embedding clusters (realms/territories).
- **Retrieve** — "show me everything in Body & Health last month" is one query.
- **Organize** — domain views/folders in the portal.

Implementation: `enrichCategoriesOnce` — a sibling stage to `enrichNlpOnce` in the drainer (the exact seam I previously over-built as a "facet classifier," now with the *right* taxonomy and a clear purpose). Batched, fail-soft, `domain IS NULL` → free backfill. Local model, one call per ~10 messages.

---

## Layer 2 — Reflection engine (aggregate narrative; cloud)

Port the canonical cycles into V1 (per `AGENT-REFLECTION-SYSTEM-SPEC`): relationship persona (never-conclude) + the seven cycle prompts (morning/reflection/evening/triage/integration/dream/weekly), seeded into the scheduler, writing `model.md` + reflections + weekly-reviews + life-model. **The granular labels (Layer 1) feed the reflection context** — "today's domains: Work 60%, Body 30%, People 10%; register shift toward Inquiry" gives the cloud reflection a quantified ground-truth to reason over, not just raw messages.

---

## Layer 3 — Structured distillation (stable facts; cloud)

Per `DESIGN-step3`, but fed clean: the integration cycle reads the **consolidated `model.md`** and emits **time-bound, category-bound, stable** claims into `person_claims` — `claim_type` (category), `valid_from`/`valid_to` (bi-temporal, retract-don't-delete), confidence + governed lifecycle. Each claim **tagged with its domain** (Layer 1's axis), so "values in Meaning & Spirit, as of Q1 vs now" is a query. This is the queryable transformation timeline the narrative gives as story.

---

## How the layers compose into context

`getContext` (and every cycle) is assembled top-down by altitude:
1. **Who you are** — the life-model / `model.md` synthesis (Layer 2). *Lead.*
2. **Stable facts** — the structured claims, `asOf(now)`, by domain (Layer 3).
3. **Right now** — recent messages + today's **domain/register mix** (Layer 1) + phase/health.
4. **What's notable** — flagged items, open hypotheses, contradictions.

The polluted raw-`person_claims` block is **removed**; identity comes from the narrative, facts from clean distillation, granular state from the labels.

---

## Build order

1. **Layer 1 (enrichment):** `messages.{domain,register,subregister}` migration `0030` + `enrichCategoriesOnce` (local model) + the taxonomy prompt + backfill. Gate `verify:enrich-categories`. *Unlocks measurement/retrieval immediately, cheaply.*
2. **Layer 2 (reflection):** persona + seven cycle prompts + seed cycles + cloud dispatch + live `model.md` (per `AGENT-REFLECTION-SYSTEM-SPEC` Phase 1) + feed Layer-1 mix into cycle context.
3. **Layer 3 (distillation):** `0031` bi-temporal + lifecycle + the integration-cycle distillation from `model.md`, claims tagged by domain.
4. **Context:** `getContext` recomposition (narrative lead + claims + domain mix).
5. **Settings:** `settings.models.{enrichment,reflection,distillation}` (default local/cloud/cloud; user-overridable).

---

## Memory architecture — Hermes-informed (the part we were under-specifying)

Studying **NousResearch/hermes-agent** ("the agent that grows with you") surfaced the single idea our plan was missing: **bounded, prefix-cached core memory.** Hermes' exact mechanism:

- **Two deliberately tiny files**, frozen per session: `USER.md` (~1,375 chars / ~500 tok — who you are) + `MEMORY.md` (~2,200 chars / ~800 tok — environment/projects). **Total <3,600 chars (~1,300 tok) by constraint.** Loaded once at session start as a *static* block → **prefix caching** (cache-warm, cheap), updates persist to disk but only show next session.
- **Bounded forces curation:** *"when you have limited space, you only save what matters."* At **80% capacity** the agent consolidates (merge related, drop outdated, compress) — the hard cap, not a daily timer, is what keeps it sharp. ("Stale memory is the #1 cause of weird agent behavior.")
- **Memory tool = 3 ops:** `add` / `replace` (substring `old_text`) / `remove`; **no `read`** (it's auto-injected). A **save-decision tree**: corrections → preferences → environment facts → re-discoverability; skip trivia/ephemera/already-in-context.
- **Injection-scanned writes:** every memory write is scanned (block credential-exfil, backdoors, invisible Unicode) + exact-dup rejected.
- **Big store is separate:** SQLite + FTS5 `session_search` (with a cheap-model summarizer) for history — core memory is *always present*, history is *retrieved on demand*.
- **Skills = procedural memory:** repeatable workflows become YAML-front-matter skill files (progressive disclosure); a **Curator** grades/consolidates/prunes on a 7-day cycle (`use_count`/`state: active|stale|archived`/`pinned`). The agent learns *how to do things*, not just who you are.
- **Corrections are the fuel:** *"active use produces compounding improvement"* — user corrections are the primary learning signal.

### What we adopt (folds cleanly onto our three layers)
1. **Three memory tiers by size + cadence** (our biggest improvement):
   - **Core** — a *bounded, prefix-cached* "who you are" (≈800-1,300 tok), always in context. This is the right form of the `states/self` capsule I earlier dropped — Hermes-style: tiny, frozen, curated. **Distilled from `model.md` (Layer 2/3), hard-bounded.**
   - **Interiority** — `model.md` (the full consolidated narrative), read by cycles, not every turn.
   - **History** — messages + FTS (we have this).
2. **Hard bound + capacity-triggered curation** on the Core (not just the daily timer) — forces "only what matters."
3. **Injection-scanning + dedup on every mind-file write** (closes a real security gap — the reflection engine writes persistent state from message content; `prepublish-security-audit` already flags egress/SSRF). **Delicate-care, non-optional.**
4. **Explicit save-decision heuristic** in the reflection prompts (corrections > preferences > facts; skip ephemera).
5. **Procedural skills as a future layer** — the agent learns *workflows* for you (a genuine "grows with you" axis we lack). Out of scope for v1; named so it's not lost.

### Completeness gaps still open (this is a CORE feature — name them, don't gloss)
- **Cold start:** a fresh user with no history/model.md — how the engine bootstraps (Core seeded empty + grows; needs a first-run flow).
- **Taxonomy versioning:** if the 7 domains change, all `messages.domain` need re-tagging — needs a version field + re-label job.
- **Security envelope of cloud reflection:** sending the *most intimate* data to BYOK cloud is the sharpest risk; reconcile with V1's local-first stance + the flagged SSRF/egress HIGH. The Core-memory injection-scan + the user's explicit model choice are part of the answer; a full threat-model pass is owed.
- **Measurement/retrieval surfaces:** the portal views that *use* the domain labels (life-balance chart, domain filter) are named but unspecced.
- **Layer conflict rule:** if Layer-3 claims contradict Layer-2 narrative → narrative wins (it's the source); state it.
- **Cost governance:** a hard per-day cloud budget + which cycles run, beyond "off by default."

**Verdict on the question "is the spec complete?": no — it's a strong architecture + the load-bearing taxonomy decision, but a core feature like this needs the six items above specced before build.** This doc now names them.

## Open decisions for you
1. **The 7 domains** — approve / rename / re-cut the list above. *This is the one decision worth getting exactly right; everything downstream keys off it.*
2. **One axis or two at the granular layer?** Domain (intuitive, retrieval) is the minimum; adding Register (your map, measurement) doubles the value but adds a second local classification. *Recommendation: ship Domain first, add Register once its Ada separability validation lands.*
3. **Reflection model default** — cloud (quality) with a local opt-in, per your steer. Confirm the per-cycle vs global granularity.

## Verification table (read by me)
| # | Claim | Verdict | At |
|---|---|---|---|
| H1 | `extract.js` has a documented seam for a model-backed enrichment pass | TRUE | `src/enrich/extract.js:7-8` |
| H2 | The 4×3 Register Map is the user's own designed life-balance axis (embedding-separable, Ada brief) | TRUE | live `searchMindscape` (research-agent + personal-agent messages) |
| H3 | ≤7 categories is both the life-domain consensus and the cheap-local-zero-shot sweet spot | TRUE | positivepsychology/wheel-of-life + arXiv 2406.08660/2603.11991 |
| H4 | Plaintext message columns enable SQL GROUP BY (measurement/retrieval) | TRUE | `crypto-local.js:209` (allowlist) + `source`/`nlp_processed` precedent |
| H5 | Reflection cycles + structured distillation are cloud-routable agent turns | TRUE | `AGENT-REFLECTION-SYSTEM-SPEC` G4 |

## Sources
Life domains: [positivepsychology](https://positivepsychology.com/what-are-life-domains/), [Wheel of Life](https://www.goodliife.com/blog/top-wheel-of-life-categories-for-a-balanced-self-assessment/). Small-LLM zero-shot classification: [arXiv:2406.08660](https://arxiv.org/html/2406.08660v1), [BTZSC arXiv:2603.11991](https://arxiv.org/html/2603.11991). Tag taxonomy design: [NN/g Taxonomy 101](https://www.nngroup.com/articles/taxonomy-101/).
