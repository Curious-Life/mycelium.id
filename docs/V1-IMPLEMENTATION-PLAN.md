# Mycelium V1 — Implementation Plan

**Target:** Self-hosted, single-user MCP server (TypeScript `src/` + Python `pipeline/`) per `docs/V1-BUILD-SPEC.md` v1.1.
**Estimate:** 18–24 working days, 6 phases. Decisions D1–D4 are locked; build around them.
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

**Goal:** A stdio MCP server that loads the 111-table schema, unlocks with a hex key (fail-closed + KCV), and serves ~36 tools with transparent envelope encrypt/decrypt.
**Exit criterion (smoke):** `node src/index.ts` over stdio answers `tools/list` with ~36 tools; a `getHealthData`-class read returns a string; writing a document then reading it round-trips through encryption; pasting a wrong hex key is rejected before any vault row is touched.

### Step 0 — R1 OAuth spike (Day 1, parallel) — **GATE**
- **Build:** A throwaway spike (not in `src/`; a scratch branch) that stands up better-auth with the `oAuthProvider()` plugin and attempts the **full MCP remote flow** against a real client: `/.well-known/oauth-authorization-server` discovery → DCR `/register` → `/authorize` + **PKCE** (`code_challenge`/`S256`) → `/token` exchange → Bearer-authenticated `/mcp` POST.
- **Test client:** `npx @modelcontextprotocol/inspector` (or Claude Desktop remote-server add) pointed at the spike URL through a local tunnel.
- **Source:** none portable — `reference/` has **no OAuth provider** (verified: all `PKCE`/`code_challenge` hits are client-side `portal-auth-{claude,openai}.js`). `reference/core/db-d1/oauth-states.js:15` gives a reusable `oauth_states` storage namespace **if hand-rolling**.
- **Go/No-Go:**
  - **GO (better-auth):** if discovery + DCR + PKCE + token all pass with an unmodified MCP client → adopt better-auth, budget Phase 4 at 2 days.
  - **NO-GO (hand-roll):** if any of {discovery doc shape, DCR auto-accept, PKCE S256 verification, Bearer on `/mcp`} fails → fall back to a hand-rolled OAuth 2.1 provider (Express routes + `oauth-states` table + `jose` for tokens), budget Phase 4 at 3–4 days.
- **Dependency:** none. **Output:** a one-paragraph decision recorded in the plan/handoff.

### Step 1 — D1 adapter + schema load (Day 1)
- **Build:** `src/adapter/d1.ts` — better-sqlite3 wrapped to D1's `prepare().bind().run()/.all()/.first()` + `batch()`/`exec()`. Plus a `d1Query(sql, params)` and `d1Batch` shim (the real injection point for the data layer).
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
- **Add (D4):** `src/crypto/kcv.ts` — on first unlock, `encrypt("mycelium-kcv-v1", "personal", key)` → persist envelope to `data/kcv.json` (or a `kcv` row). On every unlock, `decrypt(storedKcv, key)`; a GCM auth-tag failure ⇒ reject the key. **Vault stays locked on KCV failure.**
- **Smoke:** unit round-trip `decrypt(encrypt(p)) === p`; wrong-key decrypt throws; KCV rejects a truncated 63-char hex; `rewrapEnvelope(env, old, new)` then `decrypt(.., new)` returns plaintext and `decrypt(.., old)` throws.
- **Security assertions:** §1.3 fail-closed (no key ⇒ refuse), §1.4 (key only in session memory/tmpfs), §4 (KCV constant is non-secret; never log the key or plaintext).
- **Dependency:** Step 1 (KCV persistence).

### Step 3 — Port db-d1 layer + wire ~36 tool factories (Day 3)
- **Build:** port `reference/core/db-d1/*` (43 files) over the injected `d1Query`/`d1Batch`/`firstRow`/`parseJson` — SQL unchanged. Each is a `createXNamespace(deps)` factory (verified `spaces.js:15`, `messages.js:48`, `oauth-states.js:15`). Assemble the `db` namespace object that tool factories expect via `getDb()` (verified `health.js:42`).
- **Then** port `reference/mcp-tools/*` factories (`createXDomain(deps) → {tools,handlers}`, handlers `async (args)=>string`, verified `health.js:19–94`). Register their `tools` arrays into `McpServer` and route `tools/call` → `handlers[name](args)`.
- **Single-user surface (~36):** **drop** `delegation.js` (`delegate_to_agent`,`getTeamStatus` — `delegation.js:38,56`); **skip** `spaces.js` (multi-user); `internal.js` (mind-file tools) ports but defer the mind-file preload contract to Step 11.
- **Source → target:** `reference/core/db-d1/*` → `src/db/*`; `reference/mcp-tools/*` → `src/tools/*`; registry → `src/tools/index.ts`.
- **Smoke:** `db.messages.countByUser(userId)` returns a number against the loaded schema; a tool handler returns a markdown string.
- **Dependency:** Steps 1, 2.

### Step 4 — MCP server, dual transport (Day 4)
- **Build:** `src/index.ts` (stdio default, `--http` flag) + `src/server.ts` (Express, StreamableHTTP) + `src/mcp.ts` (tool registration). Use spec Components 2 samples as the skeleton.
- **Smoke:** Claude Desktop (stdio config from spec) lists ~36 tools; `tools/call getDailyMessages` returns content.
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

---

## Phase 3 — Topology (Days 10–13) *(parallel-track B continues; off the TS critical path)*

**Goal:** A working open AnalysisEngine default producing real territories/realms/harmonics into queryable D1 tables; stub fallback when Python deps absent.
**Exit criterion (smoke):** running the slim orchestrator on seeded messages populates `clustering_points`, `realms`, `territory_profiles`, `territory_cofire`, `cognitive_metrics_harmonic`; `exploreTerritory`/`mindscapeStructure` tools return real data; with Python uninstalled, `StubAnalysisEngine` engages cleanly.

### Step 12 — Port cluster.py + write a slim orchestrator (Days 10–11)
- **Build:** port `reference/pipeline/cluster.py` (FAISS k-NN + Leiden + Ward HAC; `clustering: ` prefix + 256D matryoshka, `cluster.py:77`) → `pipeline/cluster.py`.
- **[REF-WINS] — do NOT port `run-clustering.sh` verbatim.** It calls 7 scripts absent from `reference/` (verified). Write `pipeline/run-clustering.sh` covering only the **present** stages: sync points → `cluster.py` → `describe-clusters.js` → `compute-cofire.js` → harmonics. Replace `MINDSCAPE_OWNER_ID`/`AGENT_ID` scope plumbing (`run-clustering.sh:24–39`) with the single-user `personal` scope. The "sync new content → clustering_points" step (`sync-clustering-points.js`, missing) must be **written fresh** (small: select messages with `embedding_768`, decrypt 256D, insert into `clustering_points`).
- **Smoke:** `python pipeline/cluster.py --user-id <id>` populates `clustering_points` + cluster assignments.
- **Dependency:** Steps 1, 8.

### Step 13 — Port harmonics + cofire + describe-clusters (Day 12)
- **Build:** port `compute_information_harmonics.py` (H0/β/γ/α/θ/δ; keep the honesty flag), `compute-cofire.js` (4-timescale co-firing), `describe-clusters.js` (shells to **local Claude CLI** for naming — BYOK, `describe-clusters.js:74–88`; plaintext never leaves the machine).
- **Smoke:** `cognitive_metrics_harmonic` + `territory_cofire` + named `realms`/`territory_profiles` populated.
- **Dependency:** Step 12.

### Step 14 — AnalysisEngine interface + stub fallback (Day 13)
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
- Claude Desktop (stdio) + mobile (HTTPS/OAuth) both list and call the ~36 tools; encryption round-trips. **Dependency:** Phases 1–4.

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
- **NEW R7 (medium):** topology orchestrator gap — 7 `run-clustering.sh` scripts are absent; Step 12 writes a slim orchestrator + a fresh `sync-clustering-points`. Don't budget these as "ports."
- **R6:** Python install bar (onnxruntime/faiss/leidenalg) — `setup.sh` pins versions; stub is the graceful degradation.

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
