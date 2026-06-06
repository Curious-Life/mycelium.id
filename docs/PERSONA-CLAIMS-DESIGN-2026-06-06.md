# Persona-Claims Subsystem — Design (PersonaTree adoption + temporal claim evolution)

**Date:** 2026-06-06
**Status:** Design locked; **step 1 of 9 shipped + verified** (see Build status below)

## Build status
- **Step 1 — schema + crypto — ✅ GO (2026-06-06).** [migrations/0011_persona_claims.sql](../migrations/0011_persona_claims.sql) (person_claims + person_claim_snapshots), `ENCRYPTED_FIELDS` + `SCOPE_AWARE_TABLES` registered, **phantom `internal_model_items` columns fixed** ([crypto-local.js:304](../src/crypto/crypto-local.js) `['content','evidence','source_context']` → `['content','metadata']`). New gate `npm run verify:claims` → `VERDICT: GO EXIT=0` (11 assertions: migration applies, sensitive cols encrypted at rest, structural plaintext, no cleartext leak, adapter decrypts + numeric round-trip, scope auto-tagged, UNIQUE enforced, no phantom columns). Regression: `verify:measurement-schema`, `verify:frequency`, `verify:mindfiles` all still GO.
- **Step 2 — confidence math — ✅ GO (2026-06-06).** [src/claims/confidence.js](../src/claims/confidence.js) — pure log-odds decay (PersonaTree Eq. 3): `decayLogOdds`/`applyEvidence`/`update`/`toConfidence`/`fromConfidence`, per-class λ (`boundary:0` never fades … `mood:τ≈1wk`). [tests/claims/confidence.test.js](../tests/claims/confidence.test.js) → `node --test` 11/11 pass (σ bounds, boundary-never-fades invariant, monotonic decay, τ=1/e check, Eq.3 order, clock-skew clamp, fail-closed on unknown class).
- **Step 3 — store (DB namespace) — ✅ GO (2026-06-06).** Followed the repo's idiomatic namespace pattern instead of the design's `src/claims/store.js`: [src/db/claims.js](../src/db/claims.js) → `db.claims`, wired in [src/db/index.js](../src/db/index.js). Methods: `upsert` (encryption-safe `ON CONFLICT(id) DO UPDATE = excluded`, all-`?` VALUES), `listActive`, `getById`, `listForMatch` (incl. rejected tombstones + raw `embedding_768`), `findByHash`, `setStatus`, `writeSnapshot` (UNIQUE upsert), `readSeries` (ASC, sigmoid confidence, null gaps), `lastSnapshotWindow` (heartbeat roll-over). [tests/claims/store.test.js](../tests/claims/store.test.js) → 7/7 pass (encrypt round-trip via boot, update-in-place no-dup, tombstone no-resurrection, series ordering + honest gaps).
- **Step 4 — evidence validator — ✅ GO (2026-06-06).** [src/claims/validator.js](../src/claims/validator.js) — injected-router `createValidator({infer})`; `validate(evidence, claim)` → support/conflict/unrelated → ω; **every call `sensitive:true`** (egress hard-block), robust JSON-in-prose parse, fail-safe no-op on model error. [tests/claims/validator.test.js](../tests/claims/validator.test.js) 8/8.
- **Step 6 — support-path + router — ✅ GO (2026-06-06).** [src/claims/support-path.js](../src/claims/support-path.js) (`renderPath` depth 0/1/2, `approxTokens`, `selectUnderBudget` greedy knapsack, `renderClaimsBlock`) + [src/claims/route.js](../src/claims/route.js) (`routeLevel` event/pattern/claim → depth). [tests/claims/support-path.test.js](../tests/claims/support-path.test.js) 9/9 (budget never exceeded, claim-before-evidence order, routing cues).
- **Step 5 — discovery LOGIC — ✅ GO (2026-06-06); process glue pending.** [src/claims/discovery.js](../src/claims/discovery.js) — `discoverWindow({db, infer, validate, evidence, window, granularity})` injectable (no live model needed to test): propose (sensitive:true narrate) → parse → identity-match (content_hash + lexical similarity over decrypted text; **embedding-cosine deferred** to retrieval) → tombstone-skip → validate → log-odds update → `db.claims.upsert` + `writeSnapshot` with derived `delta_kind`. [tests/claims/discovery.test.js](../tests/claims/discovery.test.js) 7/7 (create→strengthen across windows, rejected-never-resurrected, unsupported/no-evidence/no-model are no-ops). **Consolidated: 42/42 unit tests + verify:claims GO.**
  - *Pending glue (needs Tier-3 live model to verify end-to-end):* `pipeline/discover-claims.mjs` (child entry, clone `describe-chronicles.js`), `src/claims/heartbeat.js` (REST window-roll-over trigger), `src/claims/stage.js` (Generate-stage), boot wiring in `completeBoot()`.
- **Step 5 — process glue — ✅ GO smoke (2026-06-06).** [src/claims/windows.js](../src/claims/windows.js) (calendar cadence boundaries), [src/claims/heartbeat.js](../src/claims/heartbeat.js) (zero-LLM REST trigger, single-flight, `runOnBoot`), [pipeline/discover-claims.mjs](../pipeline/discover-claims.mjs) (child entry, clone of describe-chronicles, `runDiscovery` injectable + Tier-3 fail-soft), [src/jobs.js](../src/jobs.js) (`isClusteringRunning` + `startClaimDiscoveryJob` spawner), boot-wired in [src/server-rest.js](../src/server-rest.js) `completeBoot` (gated `!injectedKeys`). [tests/claims/heartbeat.test.js](../tests/claims/heartbeat.test.js) 9/9; new `verify:claims-discovery` GO (stubbed-model end-to-end persist + real-child fail-soft exit 0); `verify:rest` still GO (server boots with new wiring).
- **Step 7a — getContext graft — ✅ GO (2026-06-06).** [src/tools/context.js](../src/tools/context.js): `## WHAT YOU'VE LEARNED ABOUT THEM` section — `db.claims.listActive` → `renderClaimsBlock` depth-0, budget scoped to the section only, `include:['claims']` opt-in. Verified in `verify:claims-discovery` D3b (discovery → getContext renders the claim); `verify:context` still GO.
- **Step 7b — `personaClaims` MCP tool — ✅ GO (2026-06-06).** [src/tools/claims.js](../src/tools/claims.js) (read-only `list` + `series`), registered in [src/mcp.js](../src/mcp.js). `verify:mcp` GO (28 tools, registers cleanly); functional smoke in `verify:claims-discovery` D3c/D3d.
- **Step 8 — portal — ✅ GO, live-rendered (2026-06-06).** Backend [src/portal-claims.js](../src/portal-claims.js) (`/claims/current` + `/claims/series`, owner-gated, decrypt-on-read), mounted in server-rest; new `verify:claims-rest` GO (200 + correct decrypted values + fail-closed on forwarded request + **no ciphertext leak**). Frontend [ClaimsView.svelte](../portal-app/src/lib/views/ClaimsView.svelte) (reuses `TimeSeries.svelte`) + route + registry; `vite build` clean; **live-rendered against a seeded vault** (desktop two-column: typed claim groups w/ confidence bars + the selected claim's confidence-over-windows chart + delta badge + day/week/month/quarter toggle) — the e1dc958 bar met.
- **Step 7c — searchMindscape routing graft — pending** (the one remaining graft; `routeLevel` is built, needs wiring into `bulkSearch` + browser MCP check).
- **Cross-cadence dedup — ✅ fixed + live-calibrated (2026-06-06).** Replaced brittle lexical-Jaccard identity-match with **semantic (embedding) matching** in [discovery.js](../src/claims/discovery.js): embed proposals + a growing match POOL (existing + claims created earlier in the run) via the embed service (`embedBatch`, task 'query' both sides), match by `cosine ≥ threshold`; lexical Jaccard remains the no-embedder fallback. Wired `embed` through `runDiscovery` → the child ([discover-claims.mjs](../pipeline/discover-claims.mjs)). **Threshold calibrated against live Nomic v1.5:** same-concept paraphrases scored 0.68–0.78, distinct concepts 0.38–0.49 → default **0.62**. Live demo re-run: the day+week duplicates now MERGE into one row each (`windows: day:new, week:strengthened`, confidence 0.60→0.80) while distinct claims stay separate — 5 claims vs 9 before. Unit tests +2 (semantic merge + no-over-merge); 53 claims tests GO. **The embedding-cosine deferral is now resolved.**
- **Step 7c — searchMindscape routing graft — ✅ GO (2026-06-06).** [src/tools/mindscape.js](../src/tools/mindscape.js): when `scope:'all'` and `routeLevel(query)` is `claim` (why/values/boundary/personality), prepend a `## Claims about you` support-path block (ranked by query overlap then confidence, budgeted); ordinary topic/event queries are untouched (no noise). Output-only change (tool list/discovery unchanged → stdio-verifiable, no browser needed). Smoke D3e/D3f in `verify:claims-discovery`; `verify:mcp` + `verify:search` still GO.
- **Step 9 — living-docs sweep + merge — pending** (all 9 steps' code now built + verified; ready for the docs sweep + PR).
- **Tally: 51 unit tests + verify:claims + verify:claims-discovery GO; getContext graft live-verified.**
- **Tier-3 live-model run — ✅ done (2026-06-06).** Installed Ollama (cask — the brew *formula* ships no `llama-server` runtime; use `--cask ollama`), pulled `llama3.1`, ran [scripts/demo-claims.mjs](../scripts/demo-claims.mjs) (seeds a coherent person across day+week windows → real router → discovery → claims). **Pipe works end-to-end.** First run surfaced prompt defects: the hard peanut-allergy boundary was missed (leaked as "principle"), and a single declined party was over-read as introversion (contradicting clear pro-social evidence). Tuned `buildProposalPrompt` (safety facts → `boundary` always; don't over-infer from one ambiguous act; weigh the whole set; fewer/stronger claims) → re-run: allergy correctly typed `boundary`, introversion misread gone, 7 cleaner claims vs 11. **Known remaining tuning items:** cross-cadence dedup (same claim in day+week → separate rows; lexical-match threshold too strict — the embedding-cosine deferral) and terse/first-person phrasing despite the "calm third-person" instruction.

### Tier-3 desktop-app debugging (2026-06-06) — claims now populate live
Built the `.app` (`cargo tauri build`), installed + launched it; the heartbeat ran discovery on the real vault but wrote **0 claims**. Root-caused in layers (hard evidence, each verified): (1) the local-inference call **timed out at 60s** (`localInfer` default) — a ~3.9k-token prompt + the heartbeat spawning **all cadences as concurrent children** (contending for the single Ollama instance) blew past it → caught → 0 claims. Fixes: **discovery timeout → 300s**, and the heartbeat now spawns **ONE child for all due cadences** (sequential, no contention). (2) Then inference succeeded but `parsed=0` intermittently — the model wrapped JSON in prose/``` fences or returned prose. Fix: **Ollama `format:"json"`** (constrains decoding to valid JSON) + parser hardened (array → object-salvage fallback for truncated/wrapped/single-object replies). (3) Earlier robustness: **`num_ctx` sized to prompt+output**, **token-budgeted evidence**, **truncation-salvage**. (4) Quality bug found: discovery profiled **assistant turns** ("Claude values accuracy…") — fixed `gatherEvidence` to `role='user'` only. **Result: 10 claims in the live app, confidence strengthening across windows (a claim reached 0.98 via week+month merge).** Added a run log at `<dataDir>/claims-discovery.log` (counts only) for observability. Remaining quality note: the test vault is technical/product chat, so claims are low-signal there — a personal-reflection vault is the real target; further proposal-prompt tuning is a follow-up.

### v1 simplification recorded during build
Claim identity-match uses **content_hash + lexical (token-Jaccard) similarity over decrypted claim text**, not embedding cosine — decrypting stored `embedding_768` envelopes for matching was avoided in v1. The `embedding_768` column is retained for the retrieval path (searchMindscape integration). Revisit if lexical matching mis-merges in practice.
**Skill:** authored under `/sweep-first-design` (5 Explore sweeps + direct code verification)
**Scope:** Adopt the portable mechanisms from *PersonaTree* (arXiv:2606.04780) and add a new capability — periodically **discover person-level claims** on a day/week/month/quarter cadence and **show how those claims change over time**.

---

## 0. Headline

One unified subsystem — **Persona-Claims** — delivers all four asks:

| Ask | Mechanism | PersonaTree origin |
|---|---|---|
| Support-path retrieval | claim → supporting evidence rendered adjacent, under a token budget | §3.6 path retrieval |
| Query-conditioned routing | classify a query to level (event / pattern / claim) and render depth | §3.6 query router |
| Log-odds confidence + type-specific decay | `confidence_logodds` updated `L_t=(L_{t-1}−L_base)e^{−λΔt}+L_base+ωE` | §3.4 |
| Evidence validator (support/conflict/unrelated) | reconcile new evidence against existing claims → the conflict detection the `contradictions` bucket never had | §3.3 |
| **NEW — periodic claim discovery + temporal evolution** | a cadence heartbeat discovers claims per window; snapshots clone `frequency_snapshots`; deltas + `TimeSeries.svelte` show change over time | (our extension, built on the §3.2 lifecycle) |

It is built on **proven, in-repo machinery** (the temporal-graphs feature, the boot-timer pattern, the local-first inference router), not new infrastructure.

---

## 1. Revision history

- **v1 (original ask):** "graft log-odds confidence + decay onto `internal_model_items.reinforcement_count` / `status`."
- **v2 (PIVOT — forced by Sweep 1 + direct read of [migrations/0001_init.sql:938](../migrations/0001_init.sql)):** `internal_model_items` is **dormant**. The agent's working memory is markdown mind-files on disk ([src/tools/internal.js](../src/tools/internal.js) writes `model.md`/`flagged.md`, never the DB row); `reinforcement_count`, `last_reinforced_at`, `source_cycle_id` are **never written by any code**; and the crypto layer declares two columns — `evidence`, `source_context` — that **do not exist** in the table ([src/crypto/crypto-local.js:304](../src/crypto/crypto-local.js)). Grafting onto these columns would graft onto dead schema. **Decision: do not revive the dead table.** Build a new first-class claims subsystem instead.
- **v3 (consolidation — forced by Sweep 3):** the new "claims over time" requirement has a near-exact template already shipped: the temporal-graphs feature (commit `e1dc958`). Reuse its `frequency_snapshots` → `compute-*.py` → `/portal/.../series` → `TimeSeries.svelte` pattern verbatim rather than inventing a time-series stack. `quarter` already exists as a period bucket ([src/portal-measurement.js:52](../src/portal-measurement.js) `PERIOD_DAYS = { week:7, month:30, quarter:90 }`).
- **v4 (architecture refinement — forced by cycle-3 sweeps A/B/C):** three corrections.
  1. **Discovery runs as a pipeline child process, not an LLM-calling REST timer.** Sweep A: `router.infer()` with local Ollama is only wired into the `/v1/chat/completions` gateway; **no MCP tool or timer calls it**, Ollama is lazy adopt-or-spawn (not auto-started), and a local call **throws** if Ollama is down ([src/inference/local.js:54-66](../src/inference/local.js)). But pipeline children *already* build a router via `resolveInferenceConfig(db, userId)` and call it ([pipeline/describe-chronicles.js](../pipeline/describe-chronicles.js)). So the heavy work clones that proven pattern; a thin REST **cadence heartbeat does zero LLM work** — it only spawns the discovery child on window roll-over (cloning [src/jobs.js](../src/jobs.js) `startClusteringJob`). This also removes the cross-process write race (one single-flight worker) and the config-bootstrap gap. **Claim discovery is Tier-3** (requires a pulled local model); absent one, it is a logged no-op (fail-open).
  2. **Migration file is `0011_persona_claims.sql`, not `0002`.** Sweep B: an idempotent runner applies *all* `migrations/*.sql` in lexical order every boot ([src/db/migrate.js](../src/db/migrate.js) `applyMigrations` ← [src/server-rest.js:205](../src/server-rest.js) `ensureVaultSchema`); migrations 0001–0010 already exist. New tables auto-create on next boot of any vault.
  3. **JS encrypted writes are turnkey + claims get an embedding.** Sweep C: registering a table in `ENCRYPTED_FIELDS` is *sufficient* — the [d1 adapter](../src/adapter/d1.js) auto-encrypts on write / decrypts on read by table name, no per-table glue. A numeric `confidence_logodds` is written as a JS number and `Number()`-coerced on read (`repr(float)` is only the Python writer's concern). `embedding_768` is already in `NEVER_AUTO_DECRYPT` ([crypto-local.js:1593](../src/crypto/crypto-local.js)) — so `person_claims` can carry a claim embedding for identity-matching and retrieval, handled exactly like `messages.embedding_768`.

---

## 2. Sweep findings (consolidated, load-bearing only)

**S1 — substrate is dead, claims are unmodeled.**
`internal_model_items` ([0001_init.sql:938-949](../migrations/0001_init.sql)): columns `section, content, reinforcement_count, status, source_cycle_id, metadata, created_at, last_reinforced_at`. No code increments `reinforcement_count`/`last_reinforced_at`; `source_cycle_id` is never set. There is **no first-class claim / trait / persona row anywhere** — only `people` (contact metadata) and documents at `people/*` paths. → we own a clean schema.

**S2 — periodic work IS possible (refutes the "pure tool server" worry).**
Boot-time `setInterval` timers exist and are the sanctioned pattern: enrich drainer @15s ([src/enrich/drainer.js:17-80](../src/enrich/drainer.js)), connector scheduler @5min, embed supervisor @1s — all started in `completeBoot()` **gated on `!injectedKeys`** ([src/server-rest.js:219-248](../src/server-rest.js)) so verify-scripts never spin them. The drainer is the exact clone target: single-flight (`running`/`pending`), `cycle()` on boot, `setInterval` + `timer.unref()`. Clustering itself is on-demand via `POST /mycelium/generate` ([src/jobs.js](../src/jobs.js)). → a new cadence heartbeat hooks `completeBoot()`; a discovery stage can also append to the Generate pipeline.

**S3 — temporal snapshot pattern is a drop-in template.**
`frequency_snapshots` ([0001_init.sql:814-835](../migrations/0001_init.sql)): `window_start, window_end, granularity DEFAULT 'week'`, encrypted metric columns, `UNIQUE(user_id, window_end, granularity)`. Written by a Python stage (`compute-frequency.py`), read by `GET /portal/frequency/series` (ASC by `window_end`), displayed by `TimeSeries.svelte` (115 LOC pure-SVG; **nulls break the line — honest gaps**). Deltas are **not pre-computed** — the frontend differences `points[i]−points[i-1]`. Encryption fields at [crypto-local.js:575-578](../src/crypto/crypto-local.js); numbers stored as `repr(float(x))` for clean Python↔JS round-trip.

**S4 — decay + model-call + security boundary all have mature precedents.**
Decay math: `exp(−Δt/τ)` with `RECENCY_TAU={recent:6h, mixed:7d, reflective:∞}` ([src/search/fusion/temporal.js](../src/search/fusion/temporal.js)). Model-call-over-plaintext: `createInferenceRouter().infer({prompt, task, sensitive})` ([src/inference/router.js:139-172](../src/inference/router.js)), used by `describe-chronicles.js` to narrate from message samples. **Security boundary (the hard one):** `infer({sensitive:true})` with a US jurisdiction → `emitEgress(prompt,"denied","sensitive_us_block")` then `runLocal()` — verified at [router.js:151-154](../src/inference/router.js). Local path POSTs only to `127.0.0.1:11434`; plaintext never logged.

**S5 — graft points are clean; nothing to fight.**
`getContext` ([src/tools/context.js:55-154](../src/tools/context.js)) builds `sections[]` and ends `return sections.join('\n\n')` — a new section slots in before the return. `searchMindscape`/`bulkSearch` ([src/tools/mindscape.js](../src/tools/mindscape.js), [src/search/index.js:132-207](../src/search/index.js)) is **flat** — no query classifier, `scope` is user-supplied. **No token-counting exists anywhere** (only char `.slice()` caps). MCP handler contract confirmed: `async (args) => string`; `db`/`embedder`/`userId` are closured at domain-factory time in [src/mcp.js](../src/mcp.js), never passed per-call — so all DB access for new tools must be wired in the domain factory.

---

## 3. Module shape

New package `src/claims/` + two tables + four grafts + portal surface.

### 3.1 Schema (new migration `migrations/0011_persona_claims.sql`, ~75 LOC SQL — next in the 0001–0010 sequence; auto-applied on boot per Sweep B)

```sql
-- Current root-level claims (PersonaTree "Root"). One row per live claim.
CREATE TABLE IF NOT EXISTS person_claims (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT 'self',   -- 'self' or people.id  (PLAINTEXT key)
  claim_type TEXT,                         -- ENCRYPTED (personality/value/principle/identity/boundary)
  content TEXT,                            -- ENCRYPTED  the claim sentence
  confidence_logodds TEXT,                 -- ENCRYPTED  REAL; JS writes a number, Number() on read
  decay_class TEXT,                        -- ENCRYPTED  boundary|identity|fact|preference|mood
  support TEXT,                            -- ENCRYPTED  JSON {messages:[id…], territories:[id…]}
  content_hash TEXT,                       -- PLAINTEXT  SHA-256 of normalized claim text (tombstone/dedup key)
  embedding_768 TEXT,                      -- NEVER_AUTO_DECRYPT vector envelope (claim identity-match + retrieval)
  status TEXT NOT NULL DEFAULT 'active',   -- PLAINTEXT  active|archived|superseded|rejected
  scope TEXT DEFAULT 'personal',           -- PLAINTEXT  (register in SCOPE_AWARE_TABLES)
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_evidence_at TEXT,                   -- PLAINTEXT time key (drives decay Δt)
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_claims_user ON person_claims(user_id, status);
CREATE INDEX IF NOT EXISTS idx_claims_hash ON person_claims(user_id, content_hash);

-- Periodic state of each claim (clone of frequency_snapshots). Drives "over time".
CREATE TABLE IF NOT EXISTS person_claim_snapshots (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  window_start TEXT NOT NULL,              -- PLAINTEXT time key
  window_end TEXT NOT NULL,                -- PLAINTEXT time key
  granularity TEXT NOT NULL DEFAULT 'week',-- PLAINTEXT  day|week|month|quarter
  confidence_logodds TEXT,                 -- ENCRYPTED
  content TEXT,                            -- ENCRYPTED  claim text as of this window
  evidence_count TEXT,                     -- ENCRYPTED
  delta_kind TEXT,                         -- ENCRYPTED  new|strengthened|weakened|contradicted|stable|retired
  computed_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, claim_id, window_end, granularity)
);
CREATE INDEX IF NOT EXISTS idx_claim_snap ON person_claim_snapshots(user_id, claim_id, granularity, window_end);
```

Crypto registration ([crypto-local.js](../src/crypto/crypto-local.js), ~14 LOC): `person_claims: ['claim_type','content','confidence_logodds','decay_class','support']` (NOT `content_hash`/`embedding_768`/`status`/`scope` — those stay queryable; `embedding_768` is already covered by `NEVER_AUTO_DECRYPT`), `person_claim_snapshots: ['confidence_logodds','content','evidence_count','delta_kind']`. Add both tables to `SCOPE_AWARE_TABLES` (they carry `scope`). **Also fix the v2 finding:** correct the phantom `internal_model_items: ['content','evidence','source_context']` → `['content','metadata']` (separate one-line cleanup, flagged below).

**Leaves = existing `messages`** (timestamped, embedded evidence; [0001_init.sql:950](../migrations/0001_init.sql)). **Mids** (PersonaTree "patterns") are **not a new table in v1** — territories serve as the optional mid layer when topology exists; v1 support paths are 2-level (claim → evidence), territory attached at depth-1 when present. A dedicated mids table is a documented deferral (§8).

### 3.2 `src/claims/store.js` (~160 LOC)
DB ops, wired in the domain factory (closure over `db`, `userId`): `upsertClaim`, `listActive`, `getClaim`, `writeSnapshot`, `readSeries(claimId, granularity)`, `lastSnapshotWindow(granularity)`. All numbers via `repr(float)` round-trip to match the Python writer convention.

### 3.3 `src/claims/confidence.js` (~90 LOC)
Pure functions, no I/O. `decayLogOdds(L_prev, dtSeconds, decayClass)` using per-class λ; `applyEvidence(L, omega)`; `toConfidence(L)=σ(L)`. λ table: `boundary:0, identity:1/(365d), fact:1/(180d), preference:1/(30d), mood:1/(7d)`. Reuses the `exp(−Δt/τ)` shape from `temporal.js` (τ=1/λ).

### 3.4 `src/claims/validator.js` (~120 LOC)
`validate(evidenceText, claim) → {relation: support|conflict|unrelated, omega}` via `router.infer({task:'classify', sensitive:true})`. `sensitive:true` is **non-negotiable** — these prompts carry the most intimate abstractions. Maps relation → ω ∈ [−1,1] → feeds `confidence.applyEvidence`. This is the conflict detection absent today ([internal.js:31](../src/tools/internal.js) `contradictions` is a manual bucket).

### 3.5 The cadence engine — split into a thin trigger (REST) + a heavy worker (pipeline child)

**Why split (v4):** the LLM work must run where model-calls already run — a pipeline child with a router built from `resolveInferenceConfig(db, userId)` (Sweep A). A REST timer calling `router.infer()` would be first-of-its-kind *and* would race the Generate job on `person_claims`. So:

- **`src/claims/heartbeat.js` (~70 LOC) — zero LLM, REST process.** Clones the drainer: single-flight `cycle()`, `setInterval(…, 3600_000)`, `timer.unref()`. Started in `completeBoot()` gated on `!injectedKeys` ([server-rest.js:221](../src/server-rest.js)). Each tick, for each cadence in `{day, week, month, quarter}`: if `now`'s window_end > `store.lastSnapshotWindow(cadence)` **and** no clustering/discovery job is in-flight ([jobs.js](../src/jobs.js) single-flight state), spawn the discovery child for that cadence. Cheap check; spawns the heavy worker only on roll-over.
- **`pipeline/discover-claims.mjs` (~200 LOC) — the worker, child process.** Clones `describe-chronicles.js`: opens the vault, builds the router (`resolveInferenceConfig`, egress-audit sink), runs `discoverWindow(cadence)`, exits. Single-flight via the same `jobs.js` controller as clustering → **no cross-process race**.
- **`discoverWindow(cadence)`** (the worker body): gather window evidence (messages in `[window_start, window_end]`, capped sample; + active territories as optional mids when topology exists) → `router.infer({task:'narrate', sensitive:true})` proposes typed claims each with supporting message ids → **identity-match** each proposal: embed it (`:8091`), SHA-256 its normalized text; match against existing `person_claims` by `content_hash` then cosine ≥ θ over the small active set (JS-side, claims are dozens not thousands). A match to a `status='rejected'` tombstone → **skip** (no resurrection). A match to an active claim → `validator.validate` → `confidence.applyEvidence`; no match → new claim → `store.upsertClaim` + `store.writeSnapshot` with `delta_kind` derived. `sensitive:true` is non-negotiable (§4).
- **`src/claims/stage.js` (~40 LOC)** — the *same* `discoverWindow` exported as a Generate stage appended to `jobs.js`, so a manual regenerate also runs discovery against fresh topology. One worker body, two entry points (heartbeat-spawn + Generate-stage); both go through the single-flight controller.
- **Tier-3 fail-open:** if no local model is pulled, `router.infer` throws → the worker logs `[claims] no local model; skipping` and exits 0. No claims is the correct state, not an error (mirrors the mindscape readiness gate).

### 3.6 `src/claims/support-path.js` (~110 LOC)
`renderPath(claim, depth)` → depth 0 (claim only) / 1 (claim + territory mid) / 2 (claim + evidence leaf snippets). `approxTokens(str)=ceil(len/4)` (no new dep in v1) and `selectUnderBudget(renderings, B)` — greedy by score/token (PersonaTree Eq.5 simplified). Used by both grafts.

### 3.7 `src/claims/route.js` (~70 LOC)
`routeLevel(query) → 'event'|'pattern'|'claim'`. v1 = cheap lexical heuristic (why/values/usually/always → claim; when/last/did → event) with an **optional** `router.infer({task:'classify', sensitive:true})` upgrade behind a flag. Returns the render depth for `support-path`.

### 3.8 Grafts
- **getContext** ([context.js:151](../src/tools/context.js)): before `return`, push a `## Claims` section — top-N active claims rendered as support paths. **The token budget applies to this section only** in v1 (do not budget the whole preamble — that would regress existing facts/people/messages behavior). `include:['claims']` opt-in; respects the existing `include` filter.
- **searchMindscape** ([mindscape.js:91](../src/tools/mindscape.js)): when `scope==='all'`, call `routeLevel(text)`; at `claim` level prepend claim support-paths (queried JS-side by cosine over the active-claims set — claims are NOT added to the ANN index in v1) and apply `selectUnderBudget` to the rendered claims block.
- **MCP tool `personaClaims`** (read-only, ~50 LOC): `list` (active claims + latest delta) and `series` (one claim over time) for the agent.
- **server-rest `completeBoot`** ([server-rest.js:226](../src/server-rest.js), ~6 LOC): `const claimsHeartbeat = startClaimHeartbeat({ db, userId: bootUserId, spawn: startDiscoveryJob })` inside the `!injectedKeys` block; `stop()` on shutdown. The heartbeat spawns the child; it never calls a model itself.

### 3.9 Portal (~70 LOC server + ~150 LOC Svelte)
- `GET /portal/claims/current` — active claims, latest confidence, `delta_kind` (decrypt-on-read, owner-gated — clone `/frequency/series` guard).
- `GET /portal/claims/series?claim_id&granularity` — clone of `/frequency/series`.
- `ClaimsView.svelte` — claims list with delta badges (new/strengthened/weakened/contradicted) + **reuse `TimeSeries.svelte`** for confidence-over-time, honest null gaps.

**Total budget: ~1,450–1,700 LOC** across 10 new files (`store`, `confidence`, `validator`, `support-path`, `route`, `heartbeat`, `stage` in `src/claims/`; `pipeline/discover-claims.mjs`; portal server + `ClaimsView.svelte`) + 4 grafts + 1 migration (±20%).

---

## 4. Threat model

- **Claims are the most sensitive data in the vault** — semantic fingerprints of values, boundaries, identity (CLAUDE.md §1, §7). Every `content`/`confidence`/`type`/`support` column is in `ENCRYPTED_FIELDS`; only structural keys (ids, window times, granularity, subject, status) are plaintext. `claim_type` and `delta_kind` are **encrypted** (a plaintext "hard_boundary" enum would leak the existence of a boundary; precedent: `topology_audit_snapshots` encrypts the categorical `m2_trend`). Filtering on those happens in JS after decrypt — graphs are small.
- **Discovery egress is fail-closed to local.** All `validator`/`discovery`/`route` model calls pass `sensitive:true` → [router.js:151-154](../src/inference/router.js) hard-blocks US egress and runs on-box. New attack surface = LLM prompts containing plaintext evidence; mitigated by the same boundary that already governs `describe-chronicles`. Egress audited hash-only via the existing sink.
- **No new network listener, no new process, no fourth cross-process pattern** — discovery runs in the existing REST process via an `unref()`'d timer (one of the three honest patterns). Verify-scripts inject keys → `!injectedKeys` gate keeps the timer off in CI.
- **Fail-closed on missing inputs:** no Ollama / no embeddings → discovery logs and skips (no claims is correct, not an error). Missing topology → claims still discovered from messages (Tier-1). A claim is never written without ≥1 supporting message id.

---

## 5. Edge cases — explicit decisions

| Case | Decision | Why |
|---|---|---|
| Window with no evidence | Write **no snapshot** (null → `TimeSeries` breaks the line) | Honest gaps, matches `frequency_snapshots` (S3) |
| Claim contradicted by new evidence | `delta_kind='contradicted'`, ω negative → confidence drops; if `σ(L)<0.15` → `status='superseded'`, kept for history | Conflict visible over time, not silently deleted |
| Boundary claim (allergy/trauma) ages | `decay_class='boundary'`, λ=0 → never decays | A safety boundary must not fade (PersonaTree §3.7; CLAUDE.md §3 fail-closed) |
| Same claim found at day **and** quarter | Separate snapshot rows per granularity; one `person_claims` row | Each cadence is its own series (S3 `UNIQUE` includes granularity) |
| Discovery overruns the hour | Single-flight `running` flag coalesces; next tick resumes | Clone of drainer single-flight (S2) |
| User has BYOK cloud key set | `sensitive:true` still forces local | Claims never egress regardless of config (§4) |
| `routeLevel` misroutes | Token budget still bounds output; flat layers still searched | Routing is additive, never removes recall |
| Verify / CI run | `injectedKeys` true → heartbeat never starts | No claim writes during gates (S2) |
| **User rejects a wrong claim** (`forget`) | `status='rejected'`, row kept as tombstone (`content_hash` + `embedding_768`); discovery matches proposals against tombstones and **skips** | Prevents resurrection every cycle (PersonaTree "dedup vs *seen*, not vs *confirmed*"); user trust |
| **No local model pulled** | Worker logs + exits 0; no claims written | Tier-3 fail-open; getContext/portal show "no claims yet" like the mindscape readiness gate (v4/Sweep A) |
| **Discovery vs Generate contention** | Heartbeat skips spawning if any clustering/discovery job is in-flight; worker is single-flight via `jobs.js` | One heavy job at a time; no resource thrash, no cross-process race on `person_claims` (v4) |
| **Ollama down mid-run** | `router.infer` throws → worker exits non-zero, partial window left unwritten; next roll-over retries | Local call has no retry/null ([local.js:54-66](../src/inference/local.js)); honest gap beats partial claim |
| getContext budget vs existing sections | Budget scopes the `## Claims` section only in v1 | Never regress facts/people/messages recall (v4) |

---

## 6. Test strategy

| Test file | Asserts |
|---|---|
| `tests/claims/confidence.test.js` | log-odds decay monotonic; boundary λ=0 invariant; σ bounds [0,1]; ω support↑ / conflict↓ |
| `tests/claims/validator.test.js` | relation→ω mapping; **every** model call carries `sensitive:true` (spy the router); unrelated → no update |
| `tests/claims/discovery.test.js` | window roll-over triggers exactly one discoverWindow per cadence; single-flight coalesces; no-evidence → no snapshot; never writes a claim with empty `support`; **proposal matching a `rejected` tombstone is skipped (no resurrection)**; matching an active claim updates it (no duplicate row); no local model → exit 0, no writes |
| `tests/claims/heartbeat.test.js` | spawns child only on window roll-over; skips when a job is in-flight; never calls a model itself (no router import) |
| `tests/claims/store.test.js` | encrypt-on-write / decrypt-on-read round-trip (incl. `repr(float)` confidence); `UNIQUE` upsert; series ASC by `window_end` |
| `tests/claims/support-path.test.js` | depth 0/1/2 rendering; `selectUnderBudget` never exceeds B; claim-before-evidence ordering |
| `tests/claims/crypto-fields.test.js` | every sensitive column present in `ENCRYPTED_FIELDS`; ciphertext never equals plaintext; **regression: `internal_model_items` no longer lists phantom columns** |
| `verify:claims` (new gate) | migration applies; boot starts timer only when `!injectedKeys`; `/portal/claims/*` owner-gated + zero ciphertext leak (mirror `verify:metrics-rest`) |

No design ships with "tests TBD" — the above are the acceptance set.

---

## 7. Implementation order (each step independently shippable + smoke)

1. **Schema + crypto** — `0011_persona_claims.sql` + `ENCRYPTED_FIELDS` + `SCOPE_AWARE_TABLES` (+ phantom-column fix). Smoke: `npm run init-db` then `sqlite3 … '.schema person_claims'` (the runner auto-applies it — Sweep B). 
2. **`confidence.js` + tests** — pure math, zero deps. Smoke: `node --test tests/claims/confidence.test.js`.
3. **`store.js` + tests** — encrypt round-trip on a temp vault. Smoke: store crypto-fields test GO.
4. **`validator.js`** — behind a unit test that stubs the router; assert `sensitive:true`. Smoke: validator test GO.
5. **`pipeline/discover-claims.mjs` + `stage.js` + `heartbeat.js`** — worker (clone `describe-chronicles.js`) + Generate stage + REST trigger wired into `completeBoot()`/`jobs.js`. Requires a pulled local model to produce output. Smoke: pull llama3.1 → seed messages → `POST /mycelium/generate` → rows in `person_claims` with non-empty `support`; with no model → logged no-op, exit 0.
6. **`support-path.js` + `route.js`** — Smoke: unit budget test GO.
7. **Grafts** — getContext `## Claims` + searchMindscape routing + `personaClaims` MCP tool. Smoke: stdio MCP `getContext {include:['claims']}` shows a support path; **re-verify remote MCP in a real WebKit browser per CLAUDE.md if `/mcp` surface changes** (it does — new tool).
8. **Portal** — `/portal/claims/*` + `ClaimsView.svelte` + `TimeSeries` reuse. Smoke: `npm run verify:claims` GO; portal build clean; live-render against a real vault (the e1dc958 bar).
9. **Living docs** — update `V1-BUILD-SPEC.md` status table + `ARCHITECTURE.md` + handoff (per `/living-docs`).

---

## 8. Decision criteria for "ship v1" + deferrals

**Ship when:** discovery writes claims with non-empty support over ≥2 windows on a real vault; `/portal/claims/series` renders a real confidence trend with honest gaps; `verify:claims` GO with zero ciphertext leak; every model call proven `sensitive:true`.

**Deferred (named so they don't ambush a later phase):**
- **Dedicated mids table** (PersonaTree full 3-level tree). v1 uses territory-as-mid. Add if 2-level support paths under-explain abstract claims (measure on KnowMe-style queries first — hard evidence before building).
- **Bottom-up consolidation** (cluster orphan leaves → promote). v1 is top-down per-window discovery (matches "discover whatever claims it can on a cadence"). 
- **Per-person claims** (`subject != 'self'`). Schema supports it (`subject` column); v1 discovers self-claims only.
- **Learned token cost / real tokenizer.** v1 uses `len/4`. Swap for `@anthropic-ai/sdk countTokens` only if the heuristic mis-budgets in practice.

---

## 9. Open questions resolved during sweep

- *"Graft confidence onto `reinforcement_count`?"* — **No.** Dead column (v2 pivot, [0001_init.sql:943](../migrations/0001_init.sql) + no writer).
- *"Is periodic discovery even feasible in a pure tool server?"* — **Yes**, via the boot-timer pattern ([drainer.js:73](../src/enrich/drainer.js), gated [server-rest.js:221](../src/server-rest.js)).
- *"Build a time-series stack?"* — **No**, clone `frequency_snapshots` + `TimeSeries.svelte` (S3).
- *"Does `quarter` need new plumbing?"* — **No**, already a period bucket ([portal-measurement.js:52](../src/portal-measurement.js)).
- *"Can discovery use the cloud for quality?"* — **No.** `sensitive:true` forces local; the boundary is verified at [router.js:151](../src/inference/router.js).

---

## 10. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Local model hallucinates a false claim | Med | High (false self-model) | Conservative promotion (≥1 support id, validator gate); low confidence → not surfaced in getContext; user sees + can `forget` |
| Discovery cost per window | Med | Med | Capped evidence sample; local-only; `cycle_metrics` tracks tokens; roll-over-gated (not every tick) |
| Plaintext in an LLM prompt egresses | Low | Critical | `sensitive:true` hard-block (tested); egress audited hash-only |
| `claim_type` plaintext leaks boundary existence | Low | Med | **Encrypted** + JS-side filter (decided §4) |
| Timer fires in CI and writes test data | Low | Low | `!injectedKeys` gate (tested) |
| Schema/crypto drift (the bug we just found) | Med | Med | `crypto-fields.test.js` asserts every sensitive column registered + no phantom columns |
| Tier-3 dependency: user has no local model → feature silently empty | Med | Low | Fail-open + explicit "no claims yet — pull a local model" copy in `ClaimsView` (mirror mindscape readiness gate); not an error |
| Duplicate claims explode the table over many runs | Med | Med | `content_hash` + cosine identity-match before insert; rejected-tombstone skip; only insert on no-match (§3.5) |

---

## 11. Verification table

| Assumption | Verified at (read directly) |
|---|---|
| `internal_model_items` columns + dormant reinforcement | [migrations/0001_init.sql:938-949](../migrations/0001_init.sql) |
| Crypto declares phantom `evidence`/`source_context` | [src/crypto/crypto-local.js:304](../src/crypto/crypto-local.js) |
| `frequency_snapshots` shape (granularity, UNIQUE, encrypted metrics) | [migrations/0001_init.sql:814-835](../migrations/0001_init.sql) + [crypto-local.js:575-578](../src/crypto/crypto-local.js) |
| Boot timers gated on `!injectedKeys` in `completeBoot` | [src/server-rest.js:219-248](../src/server-rest.js) |
| Drainer single-flight + `setInterval` + `unref` (clone target) | [src/enrich/drainer.js:36-79](../src/enrich/drainer.js) |
| `infer({sensitive:true})` hard-blocks US egress → local | [src/inference/router.js:139-172](../src/inference/router.js) |
| `quarter` is an existing period bucket | [src/portal-measurement.js:52](../src/portal-measurement.js) |
| `getContext` builds `sections[]`, returns `join('\n\n')` | [src/tools/context.js:154](../src/tools/context.js) |
| `searchMindscape` is flat, no router, `scope` user-supplied | [src/tools/mindscape.js:91](../src/tools/mindscape.js) + [src/search/index.js:132](../src/search/index.js) |
| MCP handler contract `(args)=>string`, db closured at factory | [src/mcp.js](../src/mcp.js) (domain factories) |
| No token-counting anywhere (clean addition) | swept src/ — absent (Sweep 5) |
| `messages` carry timestamp + `embedding_768` (leaves) | [migrations/0001_init.sql:950](../migrations/0001_init.sql) |
| Local `router.infer()` only wired to the gateway; not timers/MCP; Ollama lazy adopt-or-spawn; local call throws if down | [src/inference/local.js:54-66](../src/inference/local.js) + [src/hardware/ollama-daemon.js](../src/hardware/ollama-daemon.js) (Sweep A) |
| Pipeline children build a router via `resolveInferenceConfig(db, userId)` (the clone target) | [pipeline/describe-chronicles.js](../pipeline/describe-chronicles.js) (Sweep A) |
| Migration runner applies all `migrations/*.sql` every boot, idempotent; 0001–0010 exist → use 0011 | [src/db/migrate.js](../src/db/migrate.js) ← [src/server-rest.js:205](../src/server-rest.js) (Sweep B) |
| `ENCRYPTED_FIELDS` registration is sufficient for JS auto-encrypt/decrypt by table name; numeric → `Number()` on read; `embedding_768` in `NEVER_AUTO_DECRYPT` | [src/adapter/d1.js:31-52](../src/adapter/d1.js) + [src/crypto/crypto-local.js:1344-1349,1593](../src/crypto/crypto-local.js) (Sweep C) |
| Clustering spawned as a single-flight child job (heartbeat-spawn clone target) | [src/jobs.js](../src/jobs.js) (Sweep B/2) |

---

*Next: implement step 1 (schema + crypto) behind `verify:claims`. Update the three living docs in the same commit as the code per `/living-docs`.*
