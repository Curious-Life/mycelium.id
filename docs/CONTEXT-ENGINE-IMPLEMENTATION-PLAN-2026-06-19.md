# Context Engine — Implementation Plan (sweep-verified, buildable)

**Date:** 2026-06-19 · **Status:** cycle-3 buildable plan. Companion to **`CONTEXT-ENGINE-SPEC-2026-06-19.md`** (the architecture). This doc is the *air-tight* layer: every load-bearing assumption verified at file:line, every pivot the sweeps forced, every buildable unit with exact files/signatures/gates, the dependency graph, the threat model, and the build order. **Read the SPEC first for the *what*; read this for the *how* and the *proof*.**

> Why this rigor: the Context Engine is a core pillar — the part that makes the product *know you and grow with you*. It writes the most intimate persistent state in the vault from message content, and routes that content to cloud. A wrong assumption here is a silent data-integrity or privacy failure, not a compile error. So we proved each load-bearing claim against live code (six parallel Explore sweeps + direct reads) before locking a single line.

---

## 0. Headline — is the design sound?

**Yes, with six forced pivots (all resolved below).** The single most load-bearing question — *can a scheduled reflection cycle actually write `model.md`?* — is **VERIFIED TRUE** by reading the code directly:

- `mcp.js:61` sets `agentRoot = process.env.MYCELIUM_AGENT_ROOT || 'data/mind'` → **always truthy** in the main process, so `writeMindFile` (`mind-files.js:106-108`) does **not** throw.
- `mcp.js:113` registers the internal-domain write tools (`updateInternalModel`, `editMindFile`, `writeMindFileWhole`) bound to that `agentRoot`.
- `server-rest.js:552-553` hands the **same `handlers`** map to `createScheduler`, which runs in-process on the vault-unlocked path (key in memory).

→ A cycle invoking `updateInternalModel`/`editMindFile` writes `data/mind/model.md` encrypted, exactly as portal-chat already does. **The prior "document-only capsule" blocker was a *separately spawned pipeline child* (`discover-claims.mjs`) with no `agentRoot` — it does NOT apply to the in-process scheduler.** This is the keystone; it holds.

The rest of the engine rides infrastructure that all exists and boots: the scheduler (`scheduler.js`), the enrichment drainer (`enrich/service.js`), the embedding+clustering pipeline (`cluster.py`), `person_claims` + the claims lifecycle (`src/claims/*`), the MCP tool surface, and the inference router. The pivots are about *wiring*, not *feasibility*.

---

## 1. Load-bearing assumption ledger (the proof)

Legend: **R** = I read the cited code myself this session · **S** = a sweep agent cited it (file:line), cross-checked against the spec. Verdict: ✅ holds · ⚠️ holds-but-forces-a-pivot · ❌ false-as-written.

| # | Assumption (the plan breaks if false) | Verdict | Verified at | By |
|---|---|---|---|---|
| **Reflection runtime (L2 / Phase 1a)** | | | | |
| A1 | Scheduler fires due `scheduled_tasks` as headless turns over the same `streamTurn` engine chat uses | ✅ | `scheduler.js:56,85-90,146-155`; `server-rest.js:552-562` | R |
| A2 | A scheduled cycle can `writeMindFile` (`model.md`) — agentRoot+key present in-process | ✅ | `mcp.js:61,73,113`; `mind-files.js:106-108`; `server-rest.js:553` | R |
| A3 | Per-cycle **custom system prompt** is supported | ⚠️ **pivot 1** | `scheduler.js:31-36,88` hardcodes `SCHEDULER_SYSTEM` | R |
| A4 | A turn is **cloud-routable** independent of the local task-router | ✅ | `run-turn.js:49` → `inference/resolve.js:76-89` (`taskModels[task]` → active provider) | S |
| A5 | `scheduled_tasks` supports recurring schedules (cron DSL, `next_run`), prompt encrypted at rest | ✅ | `migrations/0019_harness.sql:27`; `scheduler.js:97,122` | S |
| A6 | Daily token budget honored by scheduler | ✅ | `scheduler.js:113-120` (`MYCELIUM_DAILY_TOKEN_BUDGET`) | R |
| A7 | Scheduled turns are content-free in memory (no `captureMessage` unless delivered) | ✅ | `scheduler.js:131-137`; `server-rest.js:546-551` (deliver sink) | R |
| **Mind-files / skills / Core memory (Phase 1a/1c)** | | | | |
| B1 | Mind files persist to disk under `agentRoot/mind/`, AES-256-GCM at rest | ✅ | `mind-files.js:102-131`, magic `MIND`+envelope | R |
| B2 | Internal-domain write tools exist: `updateInternalModel`/`editMindFile`/`writeMindFileWhole`/`snapshotMindFile`/`readMindFile`/`flagForDiscussion` | ✅ | `tools/internal.js:38-284` | S |
| B3 | A "remove a section" op (`removeFromMind`) exists | ❌ **build it** | absent (only edit-with-empty) | S |
| B4 | `getContext` preloads `model.md` + `flagged.md` | ✅ | `tools/context.js:78-84` | S |
| B5 | A vault doc store accepts arbitrary `skills/...` paths (not a reserved prefix), encrypted | ✅ | `document-store.js:55-63` (`PATH_RESERVED_PREFIXES`, `skills/` not listed) | S |
| B6 | `skills/*` docs are mirrored to the local `mind/` fs for fast load | ❌ **D1-only** | `mind-files.js:142-147` `MIND_MIRRORS` = 4 fixed paths | S |
| B7 | Harness supports **prefix-cached / frozen** system block | ⚠️ **pivot 2** | no `cache_control` in `run-turn.js`; `feat/prompt-caching` worktree exists (`dffe564`) | S |
| B8 | A prompt-injection **scanner** (`sanitize.js`) exists for mind-file writes | ❌ **build it** | absent; only `agent/untrusted.js` fencing (`wrapUntrusted`) | S |
| **Enrichment / tagging (Phase 1b)** | | | | |
| C1 | `extract.js` documents the model-backed seam; output contract known | ✅ | `extract.js:1-16` | S |
| C2 | Drainer stage pattern (batched, fail-soft, state-flag) to mirror | ✅ | `enrich/service.js:156-183` (`enrichNlpOnce`) | S |
| C3 | Enrichment service has an **inference dep** to call an LLM | ⚠️ **pivot 3** | `createEnrichmentService(deps={messages,embed,getMasterKey})` — no router | S |
| C4 | Plaintext columns bypass encryption (queryable) — precedent `source`/`nlp_processed` | ✅ | `crypto-local.js:235-239` (messages allowlist) | S |
| C5 | `ALTER TABLE messages ADD COLUMN domain/register TEXT` is safe; `embedding_768` per-message exists | ✅ | `migrations/0001_init.sql:950` | S |
| C6 | A free **state flag** is needed (don't collide with `nlp_processed` 0→2→1) | ⚠️ **build it** | `enrich/service.js:162-180`, `messages.js:252` | S |
| C7 | Local + cloud inference callable (`localInfer`/`cloudInfer`/router); `classify` defaults local | ✅ | `inference/local.js:29-42`, `cloud.js:41-69`, `router.js:25-26,204-245` | S |
| **Clustering / compass (Phase 1b clustering + 3a)** | | | | |
| D1 | Nomic v1.5 768D + 256D matryoshka truncation in the pipeline | ✅ | `embed-service.py:71-74`; `cluster.py:72-74,461,718` | S |
| D2 | Reusable centroid (mean + L2-norm) + cosine code exists | ✅ | `cluster.py:1543-1578` (`compute_and_store_centroids_256d`), `:1625` | S |
| D3 | **Anisotropy / mean-subtraction** correction exists | ❌ **build it (Phase 3a)** | absent; only per-vector L2-norm `cluster.py:501-503`; random-pair cos ~0.58 `:1080` | S |
| D4 | Cluster naming is a separate LLM "describe" step; domain/register come from message labels, not cluster.py | ✅ | `cluster.py` (numeric ids only; `describe_input_hash`/`last_described_at` `:1075,1402`) | S |
| D5 | Pipeline reads the vault via a key in tmpfs/env; app triggers measure-only | ✅ | `pipeline/vault-bridge.js`+`local_db.py`; `jobs.js:120` (`MYCELIUM_MEASURE_ONLY`); `portal-mindscape.js:347` | S |
| **Claims / bi-temporal (Phase 2)** | | | | |
| E1 | `person_claims` exists; content/`confidence_logodds`/`decay_class`/`support` encrypted; `status`/`scope`/timestamps plaintext | ✅ | `migrations/0011_persona_claims.sql:9-34`; `crypto-local.js:347` | S |
| E2 | `confidence_logodds` encrypted → confidence filters are JS-side, not SQL | ✅ | `db/claims.js:101-109` | S |
| E3 | Claims pipeline exists: `discovery/confidence/validator/heartbeat/windows/support-path/route` | ✅ | `src/claims/*` (7 files) | S |
| E4 | `lifecycle.js`, `resolve-contradictions.js`, `db.claims.retract/asOf`, `valid_from/valid_to/superseded_by/domain` cols | ❌ **build all** | absent (current schema has none of the 4 cols) | S |
| E5 | `discover-claims.mjs` (raw-message profiler) has a single caller to deprecate safely | ✅ | `jobs.js:316` ← `claims/heartbeat.js:52` (3600s) | S |
| E6 | `getContext` injects the "polluted" raw-claims block we replace | ✅ | `tools/context.js:161-171` ("WHAT YOU'VE LEARNED ABOUT THEM") | S |
| **Cross-cutting infra** | | | | |
| F1 | A settings store exists for model routing (`settings.models.*`, `reflection.enabled`) | ⚠️ **flat keys** | `db.secrets` k/v (`internal-router.js:250-303`); `db.users.getSettings` (`server-rest.js:536`); `resolve.js:78-89` `taskModels[task]` | S |
| F2 | Cloud egress goes through IP-pinned `safeFetch`; custom `base_url` is the SSRF gap | ⚠️ **gate it** | `federation/ssrf.js:143-165`; `cloud.js:3-9,23-24` hardcoded endpoints safe, custom `baseUrl` unverified | S |
| F3 | Canonical operational cycle prompts exist + call V1 tools w/ a known rename set | ✅ | `~/Developer/mycelium/packages/core/scheduler.js:633-975`; `worker/src/prompts/shared.ts:8-55` (persona + FORBIDDEN LANGUAGE :53-55, never-conclude :48) | S |
| F4 | Migration `0030` is free | ❌ **0030 taken** | `origin/main` has `0030_territory_river_cache.sql`; 30+ worktrees contend | R |

---

## 2. Pivots the sweep forced (spec → plan)

Each is a place the SPEC's prose assumed something the code refuses. The protocol: pivot, don't conform.

**Pivot 1 — Per-cycle prompt: persona in the system layer, cycle body in `task.prompt` (no migration).**
`scheduler.js:88` hardcodes `systemExtra: SCHEDULER_SYSTEM`; there is no per-task system column. Rather than migrate `scheduled_tasks`, we:
- Compile each **skill** (`skills/cycles/<id>.md`) into a seeded `scheduled_tasks` row whose **`id = "cycle:<skillId>"`** (the PK is TEXT, we control it at seed) and whose **`prompt` = the ported cycle body**.
- Hold an in-memory **skill registry** (`id → {kind, model, tools, persona, body}`) loaded at boot from the `skills/` docs (and refreshed when a skill is edited).
- Change `buildAndRunTurn` (~10 LOC) to: parse `task.id` → `skillId` → look up the skill → set `systemExtra = persona(soul.md) + cycle.body`, `enabledTools = skill.tools`, and pass a new `inferenceTask` hint (Pivot below). Non-`cycle:` tasks keep `SCHEDULER_SYSTEM` unchanged (back-compat).
- The persona (`soul.md`) is read once and injected for **cycles** in Phase 1a; injecting it for **chat** turns (`run-turn.js:69`) is a deliberate follow-on, not in 1a's blast radius.

**Pivot 1b — Per-cycle model routing without a schema change.** `run-turn.js:49` resolves the fixed task `'harness'`. Add an optional `inferenceTask` to `runAgentTurn`/`buildAndRunTurn` (default `'harness'`); the skill's front-matter `model:` maps to an inference task name (e.g. `reflection`), resolved by `resolve.js` (`taskModels[task]` → active provider → cloud if a cloud key is set). Default for reflection/integration/dream = cloud; user-overridable via settings (F1).

**Pivot 2 — "Prefix-cached Core" decouples into "bounded Core" now + "prefix-cache" later.** No `cache_control` exists (B7), but a `feat/prompt-caching` worktree (`dffe564`) is building exactly that. Phase 1c ships the **bounded, always-loaded `self.md` Core** (the token win from *small* is real and independent). The literal prefix-cache annotation rides the prompt-caching work — we expose `self.md` as a stable leading block so it becomes cache-eligible for free when that lands. **Do not block 1c on caching.**

**Pivot 3 — Enrichment gets an inference dependency + its own state flag.** `createEnrichmentService` has no router (C3). Phase 1b injects `{ infer }` (or `{ localInfer, cloudInfer, resolveProvider }`) into the service deps and adds a `categories_processed` state flag (migration) so the new stage doesn't collide with the `nlp_processed` 0→2→1 machine (C6). Fail-soft identical to `enrichNlpOnce`: classifier down → leave NULL + mark retry, never poison the row.

**Pivot 4 — `skills/*` are D1 documents, read on demand (not mind-fs mirrored).** `MIND_MIRRORS` is a fixed 4-path map (B6). Skill files live as encrypted documents under `skills/` (allowed; B5) and the scheduler caches the compiled registry in memory — so the per-tick read is from memory, not D1. Editing a skill (via `updateDocument`) invalidates the cache. No mirror needed.

**Pivot 5 — Port the canonical prompts with the rename set applied tool-by-tool.** The canonical bodies (F3) call `mindscapeStructure`/`exploreTerritory`/`getDocument "internal/model"`/`/telegram/send`, which do **not** exist verbatim in V1 — a naive port fails. Apply the renames at seed-compile time: `mindscapeStructure`/`exploreTerritory` → `mindscape({view})`, `getDocument "internal/model"` → `readMindFile('model.md')`, `/telegram/send` → V1 egress (optional in self-host; default `deliver:none`). A unit test asserts no ported body references a non-existent tool.

**Pivot 6 — Migration numbers claimed off fresh `main` at build time.** `0030` is taken (F4) and 30+ worktrees contend. The plan **reserves** `0031` (enrich cols + `categories_processed`) and `0032` (claims bi-temporal) **as placeholders** — confirm-and-renumber against `git ls-tree origin/main migrations/` immediately before each migration lands, atomically (create the stub file first to claim the number).

---

## 3. Buildable units (per phase, exact)

Order is strict: **1a → 1b → 1c → 2 → 3a → 3b.** Each ships behind its gate to `VERDICT: GO`, full `npm run verify` green, off fresh `main`, in an **isolated worktree** (the main tree is contested — §5).

### Phase 1a — Reflection engine — ✅ BUILT 2026-06-19 (branch `feat/context-engine-1a-reflection`)
**As-built (refines the plan):** per-cycle wiring needed **no migration** — a `created_by='reflection-cycle'` marker (not custom ids / a registry) keys persona-injection + cloud routing; **6 cycles, not 7** (canonical merges dream→integration); added a general **`NO_REPLY` deliver-guard**. Files: `cycle-prompts.js` (persona + 6 ported bodies + `cycleTurnOpts`/`isNoReply`), `seed-cycles.js` (idempotent seed), edits to `scheduler.js`/`run-turn.js`/`resolve.js`/`server-rest.js`. Gate `verify:reflection-cycles` 96/0 GO; `verify:harness-{scheduler,budget,tools}`/`mcp`/`gating` GO (no regression). **Editable skills BUILT (operator ask 2026-06-19):** the persona is an editable `skills/persona/soul.md` document (scheduler resolves it per cycle with a hard fallback to the constant — a missing/unreadable doc never breaks a cycle); cycle bodies stay in their (encrypted, patchable) `scheduled_tasks.prompt`. New MCP tools `listCycles`/`getCyclePrompt`/`updateCycle`/`updatePersona` (chat-grantable `cycles` domain, default-on) let the **agent** change a cycle's instructions/schedule/on-off + the persona when the user asks; the **user** edits the persona doc directly in the Library. Files: `src/skills/store.js`, `src/tools/cycles.js`, edits to `scheduler.js`/`seed-cycles.js`/`tool-domains.js`/`mcp.js`. Deferred: persona on chat turns; a portal cycles editor (direct people-editing of cycle bodies); live-smoke (needs app rebuild + cloud key).

### Phase 1a — Reflection engine (~480 LOC, as-planned) · gate `verify:reflection-cycles`
**Create**
- `src/skills/registry.js` — load `skills/*` docs → compile to `{id, kind, schedule, model, tools, persona, body}`; in-memory cache + invalidate-on-edit. Applies the Pivot-5 rename map at compile.
- `src/skills/seed.js` — `seedDefaultSkills(userId)`: idempotent; write `skills/persona/soul.md` + 7 `skills/cycles/*.md` (ported bodies) as documents; create/refresh `scheduled_tasks` rows `id="cycle:<skillId>"` with `prompt=compiled body`, `schedule` from front-matter, `enabled_tools` from `tools`, `output_target='none'`. Behind `settings.reflection.enabled`.
- `skills/persona/soul.md` + `skills/cycles/{morning,reflection,evening,triage,integration,dream,weekly}.md` — ported near-verbatim from canonical (`shared.ts` persona + `scheduler.js:633-975` bodies) with FORBIDDEN-LANGUAGE/never-conclude intact.

**Edit**
- `src/agent/scheduler.js` — `buildAndRunTurn`: if `task.id` starts `cycle:`, resolve the skill from the registry → `systemExtra = persona + body`, `enabledTools`, `inferenceTask`. Else unchanged. Load the registry at `createScheduler`. (~15 LOC)
- `src/agent/run-turn.js` — accept optional `inferenceTask` (default `'harness'`) → `resolveInferenceConfigForTask(db, userId, inferenceTask)`. (~3 LOC)
- `src/server-rest.js` — call `seedDefaultSkills(bootUserId)` after boot, behind the setting; pass the registry into `createScheduler`.

**Gate** `verify:reflection-cycles`: seed is idempotent (2× = same rows); a fired `cycle:reflection` task runs a turn with the persona system + ported body + the renamed tools; **no ported body references a non-existent tool**; a cycle write lands in `data/mind/model.md` (decrypts back); `deliver:none` writes nothing to `messages`.

### Phase 1b — LLM tagging — ✅ BUILT 2026-06-19 (migration `0031`, gate `verify:enrich-categories` 29/0 GO)
**As-built:** one cheap **on-box** LLM call per message tags **both** axes — DOMAIN (locked 7) + REGISTER (Ada's 12→4, Template B) — returning JSON (`format:'json'`). New `enrichCategoriesOnce` drainer stage (sibling to `enrichNlpOnce`) on its own `categories_processed` flag (no collision with `nlp_processed`); fail-soft (model outage → batch stops, rows stay pending, self-heals; garbage → null labels, marked attempted). Plaintext label columns (`domain`/`register`/`subregister`/`taxonomy_version`) — GROUP-BY-able for the measurement surface; no `THREAT-MODEL.md` exists, decision rests on the established `source`/`nlp_processed` plaintext-enum precedent. Files: `categories-prompt.js` (taxonomy + prompt + lenient parser), `categories.js` (classifier over injected `infer`), `0031_message_categories.sql`, edits to `service.js`/`db/messages.js`/`drainer.js`. Migration applies idempotently; `verify:enrich`/`enrich-resilience`/`pipeline-integrity` GO (no regression). Deferred: cloud-configurable model (`settings.models.enrichment`); the existing clustering already produces territories — the label→cluster join is a Phase-3b read.

### Phase 1b — LLM tagging + clustering (~340 LOC, as-planned) · migration `0031` · gate `verify:enrich-categories`
**Migration `0031`** (claim # off fresh main): `ALTER TABLE messages ADD COLUMN domain TEXT, register TEXT, subregister TEXT, taxonomy_version TEXT, categories_processed INTEGER DEFAULT 0; CREATE INDEX idx_messages_domain ON messages(user_id, domain);` (all plaintext; mirrors `source`/`nlp_processed`).
**Create**
- `src/enrich/categories-prompt.js` — the taxonomy as injection-fenced data (Ada Templates A/B for register; the 7-domain prompt). 
- `src/enrich/categories.js` — `enrichCategoriesOnce({userId, batchSize})`: select `categories_processed=0`, classify **both** axes via the injected LLM (Ada Templates), `UPDATE messages SET domain,register,subregister,taxonomy_version, categories_processed=1`; fail-soft (`-1` + retry); mirrors `enrichNlpOnce` exactly.
**Edit**
- `src/enrich/service.js` — inject inference dep; register the new stage in the drainer loop after embed.
- `src/db/messages.js` — `selectPendingCategories` + `updateCategories`.
**Clustering**: no change to `cluster.py` — it already produces the territories; the new labels *describe/validate* clusters via SQL `GROUP BY domain` (the label→cluster join is a read, Phase 3b surface).
**Gate** `verify:enrich-categories`: stub LLM (dev-msg→Work, "burnt out"→Body/Meaning, "called Una"→People); model-down → NULL not poison; batch-of-10 → 1 call; plaintext columns are SQL-`GROUP BY`-able.

### Phase 1c — Three-tier memory (~320 LOC) · gate `verify:core-memory`
**Create**
- `src/mindfiles/sanitize.js` — injection-scan (credential-exfil / instruction-injection / invisible-Unicode) + exact-dedup; returns `{ok, reason}`. (closes B8)
- `removeFromMind` tool in `tools/internal.js` (the missing `remove` op; B3).
- Core curation in the integration cycle: when `self.md` ≥ 80% of cap → consolidate (merge/drop/compress) before adding; save-heuristic (corrections > preferences > durable facts; skip ephemera) lives in the integration skill body.
**Edit**
- `tools/internal.js` write tools (`updateInternalModel`/`editMindFile`/`writeMindFileWhole`) → call `sanitize()` before encrypt+write; reject on fail (fail-closed).
- `tools/context.js` — recompose `getContext`: lead with `self.md` Core; keep `model.md`/`flagged.md`; **remove** the raw `person_claims` block (E6) in favor of Phase-2 `asOf` claims + today's domain mix.
**Gate** `verify:core-memory`: a write with an injection payload is rejected (fail-closed, no partial write); `self.md` over cap triggers consolidation; `getContext` leads with Core and no longer emits the polluted claims block.

### Phase 2 — Bi-temporal distillation (~400 LOC) · migration `0032` · gate `verify:claims-lifecycle`
**Migration `0032`**: `person_claims ADD COLUMN valid_from TEXT, valid_to TEXT, superseded_by TEXT, domain TEXT; UPDATE … SET valid_from=created_at WHERE valid_from IS NULL; CREATE INDEX idx_claims_validity ON person_claims(user_id, valid_to, valid_from);` (all plaintext).
**Create** `src/claims/lifecycle.js` (`decideOp`, `validFrom`, `RETIRE_FLOOR`), `src/claims/resolve-contradictions.js` (cosine-band 0.50–0.90 → validate → retract chain). 
**Edit** `src/db/claims.js` — add `retract(id,{validTo,supersededBy,status})`, `asOf(userId,date)`, `validFrom` param on `upsert`, `AND valid_to IS NULL` on `listActive`. Add a **distillation step** to the integration cycle: read consolidated `model.md` → emit claim deltas (tagged `domain`) through the lifecycle. **Deprecate** the raw-message profiler safely: pre-deletion caller audit of `discover-claims.mjs` (sole caller `jobs.js:316` ← `heartbeat.js:52`); switch the heartbeat to the model.md distillation source; keep the lifecycle/validator/snapshot machinery.
**Gate** `verify:claims-lifecycle`: a genuine change *retracts* (sets `valid_to`+`superseded_by`, never overwrites); `boundary` never auto-retracts; `asOf(pastDate)` returns the then-current claim; confidence filter is JS-side.

### Phase 3a — Register compass (~250 LOC) · gate `verify:register-compass`
Build **from the accrued Phase-1b LLM labels** (the ground truth): centroids per register from labeled messages, **with mean-subtraction (anisotropy fix, D3) — non-optional**; validate (silhouette 4-class 0.35–0.55, confusion pairs, hubness <20%/centroid); only then switch the bulk path to cosine-compass (truncate `embedding_768`→256D → argmax), LLM for ambiguous (~15%, top-sim<0.45 or margin<0.05). Reuse `compute_and_store_centroids_256d` (D2) as the base. **Both coexist**: LLM = labeler/ground-truth/ambiguous-resolver; compass = cheap bulk.
**Gate** `verify:register-compass`: centroids reproduce the LLM labels at ≥ the Ada-expected accuracy on a holdout; mean-subtraction present; hubness within bound; ambiguous→LLM fallback fires.

### Phase 3b — Surfaces + settings (~250 LOC) · gate `verify:context`
Life-balance chart (`GROUP BY domain`/register over time; Ada balance formulas — proportion, 90-day baseline, NeglectScore, velocity, entropy "don't optimize for equal", transition matrix), domain/register filter on Library/streams, honest **detection→correlation→prediction** framing (present-tense, never forecast), and `settings.models.{enrichment,reflection,distillation}` over the existing settings store (F1).

**Totals:** ~2,040 LOC, **2 migrations** (`0031`,`0032` — confirm numbers at build), **zero new runtime infra**.

---

## 4. Dependency graph (what blocks what)

```
1a reflection ──┐ (writes model.md = the clean narrative source)
                ├──► 2 distillation (reads consolidated model.md) ──► 3b surfaces
1b tagging ─────┤ (LLM labels = ground truth) ──► 3a compass ──────► 3b surfaces
1c memory ──────┘ (Core + sanitize + getContext recompose)

Hard edges:
  • 2 REQUIRES 1a  — distillation reads model.md; without the reflection engine there is no clean narrative.
  • 3a REQUIRES 1b — the compass is validated against accrued LLM labels (no labels → nothing to build centroids from).
  • 1c sanitize.js BLOCKS 1a going live — cycles write persistent state from message content; the scan must exist first.
    → therefore: build sanitize.js (a 1c unit) BEFORE enabling cycles in 1a. (Sequencing note, not a phase reorder.)
  • 3b REQUIRES 2 + 3a — surfaces render claims(asOf) + balance(register).
Soft:
  • 1b, 1c can proceed in parallel with 1a once sanitize.js lands.
  • Pivot-2 prefix-cache is independent (rides feat/prompt-caching); never blocks.
```

---

## 5. Threat model & delicate-care (non-negotiable, CLAUDE.md §1-13)

| Risk | Where it bites | Mitigation (enforced at) |
|---|---|---|
| **Cloud egress of intimate data** | L2 reflection + L3 distillation send `model.md`/messages to BYOK cloud | Explicit per-tier opt-in (F1); route **all** cloud reflection through IP-pinned `safeFetch` (`ssrf.js:143-165`), incl. custom `base_url` (F2 gap — **gate before GA**); privacy-max user runs reflection local (documented lower quality). |
| **Injection via written state** | cycles write `model.md`/`self.md`/skills from message content | `sanitize.js` scan + dedup before every mind-file write, fail-closed (Phase 1c, blocks 1a go-live). |
| **Plaintext leakage** | new plaintext `domain`/`register` columns; logs | Columns carry a *label enum*, never content; never log message bodies (`scheduler.js` already CODE-only errors `:40`). Confirm `THREAT-MODEL.md` permits label-enum plaintext (it permits `source`/`status`). |
| **Claim corruption / false retraction** | bi-temporal lifecycle | Retract-don't-delete; `boundary` never auto-retracts; governed `decideOp`; narrative wins on conflict (re-distill). |
| **Runaway cloud cost** | unattended cycles | `MYCELIUM_DAILY_TOKEN_BUDGET` (`scheduler.js:113`); `reflection.enabled` off by default; user picks cycles. |
| **Embedding inversion** | compass reads 256D vectors | Treat as plaintext-equivalent (§7); compass runs in-process/pipeline with the key, never egresses vectors. |

---

## 6. Risks & open decisions

**Risks**
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Migration-number collision (30+ worktrees) | High | Med | Claim off fresh `main` + stub-file-first, immediately before merge (§2 Pivot 6). |
| Ported persona over-steers chat if injected too broadly | Med | Med | 1a injects persona for **cycles only**; chat persona is a scoped follow-on. |
| Compass under-separates (anisotropy) | Med | Med | Mean-subtraction mandatory; gate on holdout accuracy; LLM stays for ambiguous + as fallback. |
| Cloud-reflection privacy regression via custom `base_url` | Med | **High** | F2 gate: `safeFetch` on the custom-endpoint path before any cloud reflection ships. |
| `feat/prompt-caching` lands differently than assumed | Low | Low | 1c doesn't depend on it; Core is a win regardless. |

**Open decisions for the operator:**
1. ~~The 7 domains~~ **✅ LOCKED 2026-06-19 (`taxonomy_version="v1"`):** Body & Health · Work & Creativity · People & Relationships · Community & Belonging · Mind & Growth · Meaning & Spirit · Self & Inner Life. Craft merged into `Work & Creativity`; social split into intimate (`People & Relationships`) vs collective (`Community & Belonging`) for the NeglectScore signal; dropped peripheral `Home & Living` (admin→Work) for `Self & Inner Life` (inner-life *activity*, distinct from the Trait axis which carries *who-you-are* claims). Fold/route rules in SPEC §3 Axis A.
2. ~~Domain + Register both at 1b~~ **✅ both** — tagged together via the LLM (Ada Templates A/B); labels seed the compass.
3. **Reflection model default** — cloud-with-local-opt-in; per-cycle vs global (Pivot 1b supports per-cycle). *(open)*
4. **Core memory cap** (~1,000 tok). *(open)*
5. **Which cycles run by default** (cost). *(open)*

---

## 7. Build discipline (this contested tree)

- **30+ active worktrees** share this repo. Before any edit: `git worktree list`, branch off **fresh `origin/main`** into a **dedicated worktree** per phase (`git worktree add ../mycelium-id-worktrees/ctx-engine-1a feat/ctx-engine-1a`). Commit + push each unit early.
- **Each phase = its own branch + PR**, gate to `VERDICT: GO`, full `npm run verify` green (never on a subset), then `/auto-merge-on-green` (security-sensitive diffs need a human approval — Phase 1c sanitize + Phase 2 + any cloud-egress change qualify).
- **Migrations:** stub-file the number off fresh main first to claim it; renumber if a race lost.
- **No `--no-verify`, no `--force`** (CLAUDE.md §6).

---

## 8. Verification ledger (this plan)
[✓] keystone (cycle can write model.md) verified by direct read · [✓] 38 load-bearing assumptions tabled with file:line + R/S provenance · [✓] 6 forced pivots documented with rationale · [✓] per-phase buildable units with files/signatures/migrations/gates · [✓] dependency graph with hard/soft edges · [✓] threat model mapped to enforcement points · [✓] risks + open decisions concrete · [✓] migration-collision + worktree discipline named · [—] per-phase cycle-3 sub-specs (authored at each phase's build time per /sweep-first-design — this plan is the cross-phase spine).
