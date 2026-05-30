# Mycelium V1 — Implementation Plan

**Target:** Self-hosted, single-user MCP server (TypeScript `src/` + Python `pipeline/`) per `docs/V1-BUILD-SPEC.md` v1.1.
**Estimate:** 18–24 working days, 6 phases — **+2–4 days for the D7 enrichment service (build-new, see Step 11b)**. Decisions D1–D7 are locked; build around them. D5 narrows V1 to a pure tool server (no scheduler/agent loop → `context-assembly` ships as a preamble tool, `schedule_task`/`list_my_schedules` dropped); D6 keeps two hex keys (USER_MASTER + SYSTEM_KEY); D7 adds the build-new :8095 enrichment service.
**Authoring note:** Every load-bearing claim below was re-verified against `reference/` (file:line cited). Where the spec and reference disagree, reference wins — flagged inline as **[REF-WINS]**.

> **Where the prompt/spec is wrong (verified):**
> 1. `run-clustering.sh` orchestrates **12 scripts; only 5 are present** in `reference/pipeline/` (`cluster.py`, `compute-cofire.js`, `describe-clusters.js`, `compute_information_harmonics.py`, `embed-service.py`). **Missing:** `sync-clustering-points.js`, `describe-chronicles.js`, `embed-mindscape.js`, `topology-audit.js`, `compute-vitality.js`, `compute-cognitive-fingerprint.js`, `compute-frequency.py`, `check-milestones.js` (verified by existence check). The topology phase must **write a slimmer orchestrator** around the 5 ported scripts, not port `run-clustering.sh` verbatim. **[REF-WINS]**
> 2. `compute_information_harmonics.py` exists but `run-clustering.sh` calls `compute-frequency.py` (absent) for metrics — wire harmonics in directly; don't assume the shell script's flow.
> 3. The spec narrative says envelope is `{v,s,iv,ct,dk}` — the **encrypt() code also emits `u` (v2) and `kf` (v3)** (`crypto-local.js:1024,1057`). V1 writes v1 envelopes but `decrypt()` must keep reading v2/v3 for imports.
> 4. No OAuth **provider** exists anywhere in `reference/` — all OAuth refs are client-side (consuming Claude/OpenAI). R1 is fully unverified externally; the spike is mandatory.

---

## Dependency graph / critical path

```
                 ┌─────────────────────────────────────────────┐
   Track A (TS)  │ P1 Core  → P2 Search → P4 Auth → P5 Integ.  │
                 └─────────────────────────────────────────────┘
   Track B (Py)  │ P2.embed ───────────→ P3 Topology            │  (parallel after embed)
                 └─────────────────────────────────────────────┘
   R1 SPIKE  ────► run on Day 1 in parallel; gates P4 design only

CRITICAL PATH: D1 adapter → crypto → db-d1+tools → MCP server → embed parity → mind-search rehydrate → searchMindscape → OAuth (de-risked early) → integration.
```

- **Blocks everything:** Step 1 (D1 adapter), Step 2 (crypto), Step 3 (db-d1 + d1Query).
- **Parallelizable:** Python embed-service (Step 8) and topology pipeline (Phase 3) can be ported by a second agent concurrently with the TS server (Phases 1, 4) — they share only the SQLite file + envelope contract. The **R1 OAuth spike (Step 0)** runs Day 1, parallel to Step 1, and gates only the Phase 4 design.
- **Hard ordering:** mind-search rehydrate (Step 10) needs crypto (Step 2) + embed-service (Step 8) + db-d1 messages (Step 3). Topology default engine (Step 14) needs embed-service (Step 8) + schema (Step 1).

---

## Phase 1 — Core Server + Data Layer (Days 1–5)

**Goal:** A stdio MCP server that loads the 111-table schema, unlocks with **two hex keys (USER_MASTER + SYSTEM_KEY, D6 — fail-closed + per-key KCV)**, and serves **~34 tools** with transparent envelope encrypt/decrypt.
**Exit criterion (smoke):** `node src/index.ts` over stdio answers `tools/list` with ~34 tools; a `getHealthData`-class read returns a string; writing a document then reading it round-trips through encryption; pasting a wrong hex key (either slot) is rejected before any vault row is touched.

### Step 0 — R1 OAuth spike (Day 1, parallel) — **GATE**
- **Build:** A throwaway spike (not in `src/`; a scratch branch) that stands up better-auth with the `oAuthProvider()` plugin and attempts the **full MCP remote flow** against a real client: `/.well-known/oauth-authorization-server` discovery → DCR `/register` → `/authorize` + **PKCE** (`code_challenge`/`S256`) → `/token` exchange → Bearer-authenticated `/mcp` POST.
- **Test client:** `npx @modelcontextprotocol/inspector` (or Claude Desktop remote-server add) pointed at the spike URL through a local tunnel.
- **Source:** none portable — `reference/` has **no OAuth provider** (verified: all `PKCE`/`code_challenge` hits are client-side `portal-auth-{claude,openai}.js`). `reference/core/db-d1/oauth-states.js:15` gives a reusable `oauth_states` storage namespace **if hand-rolling**.
- **Go/No-Go:**
  - **GO (better-auth):** if discovery + DCR + PKCE + token all pass with an unmodified MCP client → adopt better-auth, budget Phase 4 at 2 days.
  - **NO-GO (hand-roll):** if any of {discovery doc shape, DCR auto-accept, PKCE S256 verification, Bearer on `/mcp`} fails → fall back to a hand-rolled OAuth 2.1 provider (Express routes + `oauth-states` table + `jose` for tokens), budget Phase 4 at 3–4 days.
- **Dependency:** none. **Output:** a one-paragraph decision recorded in the plan/handoff.

### Step 1 — D1 adapter + schema load (Day 1)
- **Build:** `src/adapter/d1.ts` — better-sqlite3 wrapped to D1's `prepare().bind().run()/.all()/.first()` + `batch()`/`exec()`. Plus a `d1Query(sql, params)` and `d1Batch` shim (the real injection point for the data layer). **[REF-WINS, sweep] The whole data layer is async** (`db-d1/*` all `await d1Query(...)`, returning `{results}` + extracted via `firstRow()` — verified `users.js:21`, `documents.js:79`), but better-sqlite3 is **synchronous**. The shim must therefore present an **async signature `(sql,params)=>Promise<{results}>`** that `Promise.resolve(...)`-wraps the sync `stmt.all()/get()/run()`. This is the one mandatory impedance match; it keeps every call site unchanged.
- **Source → target:** spec Component 1 sample → `src/adapter/d1.ts`; `reference/schema/d1-schema-generated.sql` → `migrations/0001_init.sql`.
- **Smoke:** `sqlite3 data/mycelium.db < migrations/0001_init.sql && sqlite3 data/mycelium.db "SELECT count(*) FROM sqlite_master WHERE type='table';"` returns 111. A `d1.prepare('SELECT 1 AS x').first('x')` returns `1`.
- **Dependency:** none.

### Step 2 — Port crypto-local.js (Day 2) — **SECURITY CHECKPOINT C1**
- **Build:** `src/crypto/crypto-local.ts` — port `reference/encryption/crypto-local.js` **as-is**, preserving:
  - Envelope `{v,s,iv,ct,dk}` (+`u`/`kf` on read) — `crypto-local.js:1016–1026,1055–1062`.
  - `importMasterKey(hex)` + tmpfs/env hex load (`:561–671`); HKDF-SHA256 **zero salt**, info `mycelium:scope:<scope>:v1` (`:840`) and `mycelium:system-scope:<scope>:v1` (`:877`) — **do not change these strings**.
  - `scopeGuardian`/`scopeEncryptGuardian` run **before** unwrap (`:967,:1078`) — fail-closed.
  - `encrypt`/`encryptWithSystemKey`/`decrypt`/`rewrapEnvelope` (`:960,:1034,:1069,:1146`).
  - Two key families (USER_MASTER + SYSTEM_KEY).
- **Single-user collapse:** scopes → `personal` (+ `system` for `secrets`). Write **v1** envelopes only (drop the `userId`/v2 write path — `userId` is constant); keep `decrypt()`'s v2/v3 branches for imports.
- **Add (D4+D6):** `src/crypto/kcv.ts` — **two independent KCVs, one per key.** On first unlock, `encrypt("mycelium-kcv-v1","personal",USER_MASTER)` and `encryptWithSystemKey("mycelium-kcv-v1",SYSTEM_KEY)` → persist both envelopes (`data/kcv.json` / `kcv` rows). On every unlock, decrypt each with its key; **either** GCM auth-tag failure ⇒ reject. **Vault stays locked if either KCV fails or either key slot is empty (fail-closed).**
- **Smoke:** unit round-trip `decrypt(encrypt(p)) === p`; wrong-key decrypt throws; KCV rejects a truncated 63-char hex; `rewrapEnvelope(env, old, new)` then `decrypt(.., new)` returns plaintext and `decrypt(.., old)` throws.
- **Security assertions:** §1.3 fail-closed (no key ⇒ refuse), §1.4 (key only in session memory/tmpfs), §4 (KCV constant is non-secret; never log the key or plaintext).
- **Dependency:** Step 1 (KCV persistence).

### Step 3 — Port db-d1 layer + wire ~34 tool factories (Day 3)
- **Build:** port `reference/core/db-d1/*` (43 files) over the injected `d1Query`/`d1Batch`/`firstRow`/`parseJson` — SQL unchanged. Each is a `createXNamespace(deps)` factory (verified `spaces.js:15`, `messages.js:48`, `oauth-states.js:15`). Assemble the `db` namespace object that tool factories expect via `getDb()` (verified `health.js:42`).
- **Then** port `reference/mcp-tools/*` factories (`createXDomain(deps) → {tools,handlers}`, handlers `async (args)=>string`, verified `health.js:19–94`).
- **Registration contract [REF-WINS, sweep]:** `reference/` has **no `@modelcontextprotocol/sdk`** — tools are plain objects `{name, description, inputSchema}` with **JSON-Schema** `inputSchema` (`type:'object'`/`properties`/`required`, verified `documents.js:202`, `tasks.js:28`), and handlers return **raw strings**, not MCP content envelopes (verified `documents.js:409`, `health.js:89`). ⇒ **Use the low-level MCP `Server` + `ListToolsRequestSchema`/`CallToolRequestSchema` handlers, *not* `McpServer.tool()` (which wants Zod).** Pass the ported `inputSchema` JSON through unchanged; in the `tools/call` handler, route `handlers[name](args)` and **wrap the returned string into `{content:[{type:'text',text:result}]}` at that single seam.** This is the only MCP glue; the 14 tool files stay verbatim.
- **Single-user surface (~34):** **drop** `delegation.js` (`delegate_to_agent`,`getTeamStatus` — `delegation.js:38,56`); **drop `schedules.js`** (`schedule_task`,`list_my_schedules` — `schedules.js:117,134`) per **D5** — no scheduler/executor in a pure tool server; **skip** `spaces.js` (multi-user); `internal.js` (mind-file tools, incl. `flagForDiscussion`) ports but defer the mind-file preload contract to Step 11/11a.
- **Source → target:** `reference/core/db-d1/*` → `src/db/*`; `reference/mcp-tools/*` → `src/tools/*`; registry → `src/tools/index.ts`.
- **Smoke:** `db.messages.countByUser(userId)` returns a number against the loaded schema; a tool handler returns a markdown string.
- **Dependency:** Steps 1, 2.

### Step 4 — MCP server, dual transport (Day 4)
- **Build:** `src/index.ts` (stdio default, `--http` flag) + `src/server.ts` (Express, StreamableHTTP) + `src/mcp.ts` (tool registration — the low-level `Server` + request-handler seam from Step 3, doing JSON-Schema passthrough and string→`content` wrapping). Use spec Components 2 samples as the skeleton.
- **⚠️ Transport [spec CORRECTED]:** the spec's `/mcp` sample creates a **new `StreamableHTTPServerTransport` + `server.connect()` per request** — wrong for sessions. Wire the **stateful `Map<sessionId, transport>`** variant: create the transport on `initialize` with a real `sessionIdGenerator` (`randomUUID`), connect once, reuse for later requests by `mcp-session-id`, evict on `onclose`/DELETE. The OAuth `mcp-session-id` correlation (Phase 4) rides on this.
- **Smoke:** Claude Desktop (stdio config from spec) lists ~34 tools; `tools/call getDailyMessages` returns content (string wrapped as `{content:[{type:'text',…}]}`).
- **Dependency:** Step 3.

### Step 5 — REST API router (Day 5)
- **Build:** `src/api.ts` — `POST /api/v1/{toolName}` reusing the same `handlers` map.
- **Source → target:** spec Component 7 → `src/api.ts`.
- **Smoke:** `curl -XPOST localhost:3000/api/v1/getDailyMessages -d '{}'` returns the same payload as the MCP call. (Auth wired in Phase 4 — until then, localhost-only.)
- **Dependency:** Steps 3, 4.

---

## Phase 2 — Embeddings + Search (Days 6–9)

**Goal:** Local Nomic v1.5 ONNX embeddings with verified vector parity, and a working in-RAM `searchMindscape` (ANN + BM25 + RRF) rehydrated from decrypted content at boot.
**Exit criterion (smoke):** embed a fixed sample → cosine ≥ 0.999 vs reference vector; boot rehydrate logs `added > 0` (counters only, no content); `searchMindscape("...")` returns ranked, decrypted results.

### Step 8 — Port embed-service.py (Day 6) — **GATE R2** *(parallel-track B start)*
- **Build:** port `reference/pipeline/embed-service.py` → `pipeline/embed-service.py` (loopback `127.0.0.1:8091`, `POST /embed {text,task}`, `POST /batch`). Nomic v1.5 ONNX, 768D, **mandatory** prefixes `search_query: `/`search_document: ` (`embed-service.py:71–74`); model auto-downloads from HF Hub.
- **TS client:** `src/embed/client.ts` — thin fetch wrapper to `:8091`.
- **Smoke (R2 gate):** embed `"search_query: hello world"` path; assert `cosine ≥ 0.999` vs a reference vector exported from the canonical service. If it drifts, stop and reconcile quantization before trusting imports.
- **Security:** §7 — embeddings are plaintext fingerprints; service binds loopback only (§13 no public bind); never log vectors.
- **Dependency:** none (parallel to Phase 1).

### Step 9 — Port mind-search core (Day 7)
- **Build:** port the in-RAM subsystem (`reference/mind-search/` — backend/local.js tiers, ann/cosine+decode, index/bm25+inverted+tokenize, fusion/rrf+temporal, embedder.js, registry, errors). **[REF-WINS]:** this is the real `searchMindscape`, **not FTS5** — FTS5 in the schema is unused.
- **Single-user simplify:** drop the per-user filter wrapper (PORT-PRIORITY §mind-search) — the index is unconditional.
- **Source → target:** `reference/mind-search/*` → `src/search/*`.
- **Smoke:** unit-feed 3 docs + embeddings → `tier1({text})` returns RRF-merged ranked ids (port `reference/tests/mind-search/fusion`,`/index` assertions alongside).
- **Dependency:** Step 8 (embedder).

### Step 10 — Boot-time rehydrate (Day 8) — **SECURITY CHECKPOINT C2**
- **Build:** port `reference/mind-search/d1-loader.js` (`rehydrateFromD1`). Wire its deps: `db.messages.streamForRehydrate` (`messages.js:182`), `decryptVector` + `decryptContent` (from Step 2). It decrypts vector envelope first, then content, into RAM (`d1-loader.js:90–117`); `NOMIC_DIM=768` guard.
- **Source → target:** `reference/mind-search/d1-loader.js` → `src/search/rehydrate.ts`.
- **Smoke:** boot against a seeded DB → returns `{added>0, decryptVectorFailed:0}`; log line carries **counters only** (`d1-loader.js:135` — no ids/text/vectors).
- **Security:** §1.1/§4/R4 — decrypted index lives in RAM (accepted risk, single-user blast radius); **never log index contents**; rehydrate fails closed if the key is absent (no key ⇒ no decrypt ⇒ empty index, not plaintext fallback).
- **Dependency:** Steps 2, 3, 8, 9.

### Step 11 — Wire searchMindscape + mind-file preload (Day 9)
- **Build:** route `searchMindscape` tool → mind-search `tier1`; expose `/internal/v1/search/mindscape` loopback. Wire `internal.js` mind-file tools' preload contract into the session (deferred from Step 3).
- **Smoke:** Success Criterion #4 — `searchMindscape` returns ranked results with content decrypted transparently.
- **Dependency:** Steps 9, 10.

### Step 11a — context-assembly as an on-demand preamble tool (Day 9, +) — **D5**
- **Why:** D5 makes V1 a pure tool server (the client *is* the agent), so there's no server-side loop to inject preloaded context. Instead expose `assembleContext` as a **callable preamble** the client pulls at turn start.
- **Build:** port `reference/core/context-assembly.js` (`assembleContext(agentRoot, userId, {scope}) → markdown string`, `:79`) → `src/context/assemble.ts`, dropping multi-agent/multi-channel branches (single-user). Surface it as **one MCP tool `getContext` *and* an MCP resource** (e.g. `mycelium://context/preamble`) returning the same markdown. It assembles mind files (internal model, **`flagged.md`**, dream fragments), pinned docs, the master doc index, and recent messages (`:79–374`) — this is what keeps **`flagForDiscussion` viable** (the flagged items surface here).
- **Single-user simplify:** keep the TTL caches (`:34–38`) but key on the constant userId; drop the Supabase-pinned-docs path if not ported, fall back to the local doc index.
- **Smoke:** `getContext({scope:'all'})` returns markdown containing a known flagged item written via `flagForDiscussion`; resource read returns identical text.
- **Dependency:** Steps 3, 10, 11.

### Step 11b — Enrichment service (:8095) — **D7, BUILD-NEW** *(+2–4 days; parallel-track B)*
- **⚠️ Not in `reference/`.** Only the **contract** is: `reference/server-routes/portal-enrichment.js` (270 LOC — the driver router: `/enrich-all`, `/health`, loopback `notify` callback, message-state counts) and the `messages` NLP columns + work-queue index (`entities`/`relations`/`entity_summary`/`nlp_processed`/`nlp_processed_at`/`nlp_error`/`embedding_768`; `d1-schema-generated.sql:950,1832,1835`).
- **`nlp_processed` state machine [REF-WINS, verified `portal-enrichment.js:85-89`]:** the message-level states are **`0`/NULL = pending → `1` = NLP-enriched → `2` = embedded**, with **`-1` = failed** (carry `nlp_error`/`nlp_processed_at`). The transient "processing" + 60s stale-heartbeat → abandoned lives on the **job row** (the active-job record `/health` reports), *not* the message column. Build the worker to advance messages `0→1→2` and reconcile abandoned jobs back to pending.
- **⚠️ DB-interface seam [verified `portal-enrichment.js:85`]:** the router calls **`db.rawQuery(sql, params)` via `tryGetDb()`** — a *different* interface than the injected `d1Query` the `db-d1/*` tool factories use (same difference seen at `document-store.js:417`). **Decision: normalize** — expose a thin `rawQuery(sql,params)` method on the assembled `db` namespace that delegates to the same better-sqlite3 adapter as `d1Query` (one DB path, no second connection), rather than carrying two query surfaces. Then `portal-enrichment.js` ports unchanged.
- **Build:** `pipeline/enrich-service` (loopback `127.0.0.1:8095`) — a worker that pulls `nlp_processed=0`/NULL rows, runs NLP entity/tag extraction (→`1`), calls the **:8091 embed-service (D2)** for `embedding_768` (→`2`), writes results, sets `-1`+`nlp_error` on failure, and fires the loopback `notify` callback on phase transitions. Port `portal-enrichment.js` → `src/api/enrichment.ts` (over the normalized `rawQuery`) to drive/monitor it (status, trigger, progress + IDOR guard).
- **Interim (until 11b lands):** write `embedding_768` inline on message create (synchronous embed) so search works; the async NLP state machine is the follow-on.
- **Security:** §7 (embeddings = fingerprints, loopback-only, never logged), §13 (no public bind), §1.1 (encrypt entities/relations envelopes before write — they're plaintext-derived).
- **Smoke:** seed 5 messages with `nlp_processed=0` → trigger → all reach `nlp_processed=1` with non-null `embedding_768` and tags; `/status` counts reconcile; killing mid-job marks the row recoverable, not lost.
- **Dependency:** Steps 3, 8 (embed-service). Off the Phase-1 critical path.

---

## Phase 3 — Topology (Days 10–14) *(parallel-track B continues; off the TS critical path)*

**Goal:** A working open AnalysisEngine default producing real territories/realms/harmonics into queryable D1 tables; stub fallback when Python deps absent.
**Exit criterion (smoke):** running the slim orchestrator on seeded messages populates `clustering_points`, `realms`, `territory_profiles`, `territory_cofire`, `cognitive_metrics_harmonic`; `exploreTerritory`/`mindscapeStructure` tools return real data; with Python uninstalled, `StubAnalysisEngine` engages cleanly.

### Step 12 — Port cluster.py + write a slim orchestrator (Days 10–12)
- **⚠️ Budget [R7]:** this is **three deliverables, not one** — (a) port `cluster.py`, (b) rewrite a slim orchestrator around only the 5 present scripts, (c) **write `sync-clustering-points` fresh** (absent from `reference/`). Budget **3 days** for Step 12 alone; do not treat it as a single "port." Off the TS critical path, so it overlaps Phases 1/2/4 and stays inside the overall 18–24-day envelope (Phase 5 soak/buffer absorbs the slip).
- **Build:** port `reference/pipeline/cluster.py` (FAISS k-NN + Leiden + Ward HAC; `clustering: ` prefix + 256D matryoshka, `cluster.py:77`) → `pipeline/cluster.py`.
- **[REF-WINS] — do NOT port `run-clustering.sh` verbatim.** It calls 7 scripts absent from `reference/` (verified). Write `pipeline/run-clustering.sh` covering only the **present** stages: sync points → `cluster.py` → `describe-clusters.js` → `compute-cofire.js` → harmonics. Replace `MINDSCAPE_OWNER_ID`/`AGENT_ID` scope plumbing (`run-clustering.sh:24–39`) with the single-user `personal` scope. The "sync new content → clustering_points" step (`sync-clustering-points.js`, missing) must be **written fresh** (small: select messages with `embedding_768`, decrypt 256D, insert into `clustering_points`).
- **Smoke:** `python pipeline/cluster.py --user-id <id>` populates `clustering_points` + cluster assignments.
- **Dependency:** Steps 1, 8.

### Step 13 — Port harmonics + cofire + describe-clusters (Day 13)
- **Build:** port `compute_information_harmonics.py` (H0/β/γ/α/θ/δ; keep the honesty flag), `compute-cofire.js` (4-timescale co-firing), `describe-clusters.js` (shells to **local Claude CLI** for naming — BYOK, `describe-clusters.js:74–88`; plaintext never leaves the machine).
- **Smoke:** `cognitive_metrics_harmonic` + `territory_cofire` + named `realms`/`territory_profiles` populated.
- **Dependency:** Step 12.

### Step 14 — AnalysisEngine interface + stub fallback (Day 14)
- **Build:** `src/analysis/plugin.ts` (interface from spec Component 9). Default impl wraps the orchestrator + reads the produced D1 tables. `StubAnalysisEngine` (spec sample) engages when Python/pipeline deps are absent (detect via a capability probe).
- **Smoke:** with venv present → real territories; with `pipeline/` deps uninstalled → stub returns empty structure and `explore()` throws the documented "no engine" message (not a crash).
- **Dependency:** Steps 12, 13.

---

## Phase 4 — Auth + Deployment (Days 14–17)

**Goal:** Remote MCP works end-to-end (OAuth + tunnel); agent YAML + inference router shipped.
**Exit criterion (smoke):** a real MCP client completes OAuth and calls a tool over HTTPS through the tunnel; YAML filters tool availability.

### Step 15 — OAuth 2.1 + PKCE (Days 14–15)
- **Build:** implement the **Step 0 go/no-go winner**. If better-auth: `src/auth.ts` per spec. If hand-rolled: Express routes + `oauth-states` namespace (`reference/core/db-d1/oauth-states.js`) + `jose`.
- **Smoke:** the exact Step 0 flow, now wired into `/mcp` + `/api/v1/*` middleware; unauth request → 401 (§1.3 fail-closed).
- **Dependency:** Step 0 (decision), Steps 4, 5.

### Step 16 — Tunnel + agent YAML + inference router (Day 16)
- **Build:** `scripts/tunnel.sh` (Cloudflare **account** tunnel — quick tunnels lack SSE; SSE keep-alive <100s); `src/config/agents.ts` (port `reference/core/agent-config.js` YAML loader); `src/inference/{router,local,cloud}.ts` (Ollama for local inference only — **never embeddings**, D2).
- **Smoke:** YAML tool whitelist filters `tools/list`; `infer({task:'summarize'})` hits Ollama; tunnel serves `/mcp` publicly.
- **Dependency:** Steps 4, 15.

### Step 17 — Data-import re-key milestone (Day 17) — **SECURITY CHECKPOINT C3**
- **Build:** `scripts/import.ts` — operator-side, one-time. Load encrypted rows (wrangler export → sqlite3), then for each encrypted field run `rewrapEnvelope(env, oldMasterKey, newHexMasterKey)` (`crypto-local.js:1146`). `embedding_768` (TEXT = base64(Float32) inside an envelope) re-keys identically. Verify KCV post-migration.
- **[REF-WINS]:** a plain `wrangler export`+`sqlite3` load leaves data **undecryptable** under the new key — re-key is mandatory (spec Data Import correction).
- **Smoke:** import a fixture row → `decrypt(.., newKey)` succeeds; old key fails (mirrors `master-key-rotation.test.js:29–49`); imported `embedding_768` rehydrates and search finds the row.
- **Security:** §4/R5 — old key in memory only during migration, never persisted; never log plaintext/keys.
- **Dependency:** Steps 2, 10.

---

## Phase 5 — Integration + Hardening (Days 18–21)

**Goal:** All 10 Success Criteria pass; tests ported; logs clean.
**Exit criterion:** the spec's Success Criteria 1–10 all green.

### Step 18 — End-to-end connect (Day 18)
- Claude Desktop (stdio) + mobile (HTTPS/OAuth) both list and call the ~34 tools + `getContext` preamble; encryption round-trips. **Dependency:** Phases 1–4.

### Step 19 — Port the test suite (Day 19) — **SECURITY CHECKPOINT C4**
Port these PORT-tagged tests (assertions, even if rewriting the runner):

| Test | Asserts | Step it guards |
|---|---|---|
| `crypto-security.test.js` | envelope `{v,s,iv,ct,dk}` shape, GCM | Step 2 |
| `two-key-separation.test.js` | v3/system ⊥ USER_MASTER; `secrets`→SYSTEM_KEY (`:11–19`) | Step 2 |
| `master-key-rotation.test.js` | `rewrapEnvelope` old→new decrypts, old fails (`:29–55`) | Step 17 |
| `master-key-pinning.test.js` | key-loading discipline | Step 2 |
| `encryption-coverage.test.js` | 40+ tables encrypted | Steps 3, 17 |
| `mind-search/*` (25 files) | ANN+BM25+RRF behavior, rehydrate, routing | Steps 9–11 |
| `channel-authority.test.js` | inbound-source-fabrication class | Step 3 (egress) |
| `agent-config.test.js` | YAML parsing | Step 16 |

- **Dependency:** all prior.

### Step 20 — Hardening (Day 20)
- Fail-closed paths (locked vault refuses writes — §1.3), **log-redaction** (port `reference/core/log-redact.js`; assert no plaintext/keys/vectors in any log — §1.1/§4/§7), README. **Dependency:** Step 19.

### Step 21 — Soak + buffer (Day 21).

---

## Security checkpoints (CLAUDE.md §1–13 ↔ steps)

| Checkpoint | Invariant | Step |
|---|---|---|
| C1 | Fail-closed unlock; KCV rejects wrong key; key in session/tmpfs only (§1.3,§4) | Step 2 |
| C2 | Decrypt-into-RAM index never logged; no-key ⇒ empty index, not plaintext (§1.1,§7,R4) | Step 10 |
| — | Encrypt-before-write on every tool write path (§1.1,§1.3) | Step 3 |
| — | Scope guardians fire before unwrap, fail closed (§1.2,§1.3) | Step 2 (preserved) |
| — | OAuth unauth ⇒ 401, never permissive default (§1.3) | Step 15 |
| C3 | Re-key migration: old key memory-only, never persisted; KCV verify (§4,R5) | Step 17 |
| C4 | Test suite pins envelope shape + two-key separation; log-redaction (§1.1,§4,§7) | Steps 19–20 |
| — | No public port binds except the auth'd server + loopback :8091 (§13) | Steps 8,16 |

---

## Open risks carried forward

- **R1 (high):** OAuth provider unverified — Step 0 spike gates it; hand-rolled fallback budgeted.
- **R2:** embed vector parity — Step 8 gate (cosine ≥ 0.999).
- **R3:** mind-search port scope — port its 25-file test suite alongside (Step 9); brute-force-cosine fallback if RRF slips.
- **NEW R7 (medium):** topology orchestrator gap — 7 `run-clustering.sh` scripts are absent; Step 12 is **three deliverables** (cluster.py port + slim orchestrator + fresh `sync-clustering-points`), not one. **Budget 3 days for Step 12 alone** (Days 10–12); don't budget the missing scripts as "ports." Off the TS critical path, so it absorbs into the envelope.
- **R6:** Python install bar (onnxruntime/faiss/leidenalg) — `setup.sh` pins versions; stub is the graceful degradation.
- **NEW R8 (medium, D7):** enrichment service is **build-new** (Step 11b, +2–4 days) — only its contract exists in `reference/`. Risk is the NLP-tagging implementation (model choice + entity schema) and the `nlp_processed` state machine's crash-recovery. Interim inline-embed keeps search working if 11b slips.
- **Deferred (D5), not a risk:** server-side scheduler + autonomous `/chat` loop, lanes/recovery/compaction. V1 is a pure tool server; these move to **Phase 5: Extensions** (`schedule_task`/`list_my_schedules` re-enter when an executor exists).

## Thinnest-shippable-MVP cut line

Phases 1–2 + working `searchMindscape`, topology behind the **stub** (~9–11 days). This ships the *empty mindscape* the original spec described and **contradicts D1** — do it only as a deliberate staged cut, then add Phase 3 to honor D1.

## First 3 commits (start immediately)

1. **`chore: scaffold + schema`** — `package.json` (spec deps), `tsconfig.json`, `.env.example`, `src/adapter/d1.ts`, `migrations/0001_init.sql` (copy `reference/schema/d1-schema-generated.sql`). Verify: 111 tables load.
2. **`feat(crypto): port crypto-local + KCV`** — `src/crypto/crypto-local.ts` (ported), `src/crypto/kcv.ts`. Verify: round-trip + wrong-key-rejected unit tests pass.
3. **`feat(data): db-d1 layer + d1Query injection`** — `src/db/*` (ported `reference/core/db-d1/*`), `d1Query`/`firstRow`/`parseJson` wired to the adapter. Verify: `db.messages.countByUser()` runs. *(In parallel, on a scratch branch: run the Step 0 OAuth spike.)*

---

## Critical files for implementation

- `reference/encryption/crypto-local.js`
- `reference/mind-search/d1-loader.js`
- `reference/mcp-tools/health.js`
- `reference/pipeline/embed-service.py`
- `reference/pipeline/run-clustering.sh`
