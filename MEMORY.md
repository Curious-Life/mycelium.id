# MEMORY — cross-session index

Quick-reference pointers for Claude Code sessions in this repo. Keep entries terse;
detail lives in the linked docs. Newest-relevant first.

## In Progress

- **§4g cascade now has an in-app UI toggle + `db.users` wired (2026-06-04, latest).** The cascade (was env-only `MYCELIUM_INFER_CASCADE`) is now a **Settings → Intelligence "Smart routing" toggle**: persisted in `users.settings` via `db.users.updateSettings`; the gateway reads it **DB-first** (`isCascadeEnabled(db,userId,env)` in `src/gateway/openai-compat.js`, exported), env is the fallback, **default off** (so v1 behavior + `verify:gateway` unchanged). Endpoint `GET/PUT /portal/providers/routing` (`portal-providers.js`; the PUT upserts the `users` row since a fresh vault has none). UI: a toggle in `IntelligenceSection.svelte` (loadRouting/setCascade). 🔧 **Wired `db.users`** into the assembled db (`src/db/index.js` — `createUsersNamespace` existed but was never assembled; `context.js:63` already optional-chained it, so this also makes getContext's timezone read live). Gates: **`verify:gateway` G11** (DB-first + env-fallback + default-off) + **`verify:providers` P12** (toggle persists) GO; portal build GO. Branch `claude/elegant-ritchie-034Ub`, PR pending (post #88).
- **AI Interface Layer — S5 (Connect-your-AI) BUILT → the S0–S8 plan is COMPLETE (2026-06-04).** Branch `claude/elegant-ritchie-034Ub`. **S5** = onboarding + docs: **`docs/CONNECT-YOUR-AI.md`** (run/keys `USER_MASTER_KEY`+`SYSTEM_KEY` or `MYCELIUM_KEY_SOURCE=keychain`; stdio MCP `node src/index.js` for Claude Desktop/Code; HTTP MCP + gateway on `:4711` via `npm run start:http`; per-harness base-URL snippets opencode/Codex/Goose/Cline/Continue; static bearer `MYCELIUM_MCP_BEARER` = `openssl rand -hex 32`; `/v1/embeddings`; the managed-relay remote path `https://<handle>.mycelium.id/{mcp,v1}` with an HONEST "relay VPS not yet live end-to-end" note; security defaults) + a **"Connect your AI"** Settings panel (`ConnectYourAISection.svelte`, mounted in `SettingsView.svelte` after Remote Access; reuses `/api/v1/remote/status`, no new backend). Portal build GO + portal regressions GO. **The entire DESIGN-ai-interface-layer Part 8 (S0–S8) is now built/merged** — only intentional deferrals remain (flip `MYCELIUM_INFER_CASCADE` default ON; streaming-for-cascade; Anthropic/local tool translation). Facts swept against live code (key vars `index.js:60`/`key-source.js:90-95`; routes `server-http.js`; remote `src/remote/router.js:191`).
- **AI Interface Layer — FAST-FOLLOWS designed + Slice A & S6-core BUILT (2026-06-04).** Branch `claude/elegant-ritchie-034Ub` off `main @ 5d5f3b3`. `/sweep-first-design` (3 cycles: 5 Explore/web agents + own-eyes reads of 8 files + odysseus research) → **[`docs/DESIGN-ai-interface-fastfollows-2026-06-04.md`](docs/DESIGN-ai-interface-fastfollows-2026-06-04.md)** plans 7 items (S4a host-parity · S4b MCP `instructions` · `/v1/embeddings` · §4g cascade · tools pass-through · true streaming · S6 recommender) with a **21-row verification table + 4 documented pivots**. **Borrowed odysseus `hwfit` (MIT, attributed)** — *computed* fit (`params×bpp + 8e-6×kv×ctx + 0.5`) over a brittle static tier table. **BUILT this session (Slice A + ALL of Slice D — S6 end-to-end):** S4a `MYCELIUM_HTTP_HOST` override+non-loopback-warn (`server-http.js` — was ALREADY loopback, so parity not a fix); S4b `MYCELIUM_INSTRUCTIONS` on the MCP `Server` (`mcp.js`, SDK 1.29 supports it); `POST /v1/embeddings` LOCAL-ONLY adapter over the Nomic embed-service (`src/gateway/embeddings.js` — never cloud, §7) + `/v1/models` advertises `nomic-embed-text-v1.5`; S6 recommender core `src/hardware/{fit,catalog,detect,recommend,ollama}.js` (NVIDIA/Apple-unified/AMD/CPU fail-soft detect via `execFile` no-shell · computed-fit ranking · HTTP-only ollama pull w/ validated names). **S6 is now end-to-end:** `src/portal-hardware.js` routes (detect / recommend / catalog-constrained streaming pull) mounted in `server-rest.js` + the "Recommended for your hardware" panel in `IntelligenceSection.svelte` (detect → ranked fit badges → one-click pull w/ progress → auto-register the local Ollama provider). Gates: **`verify:embeddings-gateway` (6) + `verify:hardware` (17) + `verify:hardware-routes` (5) GO**, portal build GO, full `npm run verify` chain GO, regressions GO (gateway/oauth/mcp/mcp-discovery/rest/portal). **Slice B (true streaming) + Slice C (cascade + tools) now BUILT too → ALL 7 FAST-FOLLOWS DONE.** B: `inferStream` on the router + `cloudStream` (OpenAI SSE/Anthropic) + `localStream` (Ollama NDJSON), gateway pipes real deltas (`verify:gateway-stream` 7 GO). C1: `resolveProviderChain` + `src/inference/cascade.js` (eu→frontier→local, sensitive drops US, local floor) behind `MYCELIUM_INFER_CASCADE` (default OFF); router got a `cloudFallbackToLocal` flag so cloud failures propagate (`verify:cascade` 6 GO). C2: `toolsPassthrough` transparent OpenAI-compatible proxy so `tool_calls` round-trip, sensitive+US→400, audited hash-only (`verify:gateway-tools` 6 GO). Full `npm run verify` chain GO. **Only open item:** flip cascade default ON after a 2-provider live smoke (operator call). Named deferrals: streaming-for-cascade, Anthropic/local tool translation. ⚠️ Still don't touch `src/remote/*`, `src/connectors/*`, `src/db/secrets.js`.
- **AI Interface Layer — S8 GATEWAY ✅ MERGED TO MAIN + a CRITICAL auth fix (2026-06-04).** ✅ **PR #79 merged → `main @ 4fabe1a`** (merge method), from branch `claude/elegant-ritchie-034Ub`. **S8** = the OpenAI-compatible outbound gateway: `POST /v1/chat/completions` + `GET /v1/models` on the Bearer-guarded `:4711` app, composing the S2/S3 seams — **`src/gateway/openai-compat.js`** (`messages[]`→prompt, active-provider route, non-streaming v1 w/ terminal-chunk shim, `tools` dropped, `X-Mycelium-Sensitive`→§4g hard-block) + **§3b static bearer** `src/gateway/static-bearer.js` (`MYCELIUM_MCP_BEARER`, fail-closed: ≥24-char floor + constant-time + never logged) wired into `authenticate()` (covers `/mcp` AND `/v1`). 🔴 **Auth-bypass fixed:** the smoke caught that `authenticate()` called `getMcpSession` **without `asResponse:false`** → truthy `{}` for *any* input → **any non-empty Bearer authenticated** on `/mcp` + `/ingest/*` + `/v1`; fixed (`asResponse:false` + fail-closed expiry check), regression-guarded by **garbage-Bearer→401 in `verify:oauth`**. Also dropped a 12-char token fragment from the `/mcp` reject-path log (§1 zero-leak). **Merge gate (all met):** CI `verify` green on head `9ed7739` + **local full `npm run verify` chain GO (59× VERDICT GO, exit 0)** + `verify:gateway` 14 checks + real-server smoke GO; operator **explicitly approved** the security-sensitive diff; PR clean+non-draft. The connectors lane advanced main to `e76eb00` (PR #80) mid-flight → **conflict was just the `package.json` verify chain**, resolved **additively** (both `verify:gateway` + `verify:connector-upsert`), merge commit `9ed7739`; `e76eb00` confirmed an ancestor of merged main (no lane regression). Also fixed a **~5% flaky `verify:managed-claim` MC2** (relay-lane test, ed25519 last-byte tamper no-op — with operator OK; ⚠️ flag relay session so they don't double-fix). **NEXT:** optional fast-follows — S6 HW recommender · S4 remainder (`MYCELIUM_HTTP_HOST` default-loopback, server `instructions`) · true token-streaming · `tools` pass-through · §4g multi-provider cascade · `/v1/embeddings`. Full as-built detail: [`docs/AI-INTERFACE-OUTBOUND-HANDOFF-2026-06-04.md`](docs/AI-INTERFACE-OUTBOUND-HANDOFF-2026-06-04.md) (MERGE PICKUP section, now closed).
- **AI Interface Layer — OUTBOUND MERGED TO MAIN (2026-06-04).** ✅ PR #64 merged → `main @ 01d4e27` (S0 encrypt creds ·
  S1 `/portal/providers` · S2 router↔store · S3a base_url widening+jurisdiction · S3b sensitive hard-block+egress audit ·
  Intelligence Settings UI). **NEXT = S8 gateway** (`/v1/chat/completions` on :4711). **HANDOFF — build S8 from here, zero
  re-discovery:** [`docs/AI-INTERFACE-OUTBOUND-HANDOFF-2026-06-04.md`](docs/AI-INTERFACE-OUTBOUND-HANDOFF-2026-06-04.md). Lane deconflicted (don't compete):
  **relay/remote-MCP** = other session (PRs #45/#46 — `src/remote/*`, `auth.js`, `server-http.js` incl. the `:4711`
  loopback bind fix `server-http.js:324`, CT-monitor, tunnel/frpc); **import-connectors + encrypted `secrets` API** =
  other session (#67/#69/#70 — `src/connectors/*`, `src/db/secrets.js`, `src/portal-{settings,connectors,import}.js`).
  **This branch owns OUTBOUND-LLM only.** ✅ **S0+S1 BUILT + verified:** `ai_providers.credentials` encrypted at rest
  (`crypto-local.js` ENCRYPTED_FIELDS `ai_providers:['credentials']`), `db.providers` wired (`src/db/index.js` + a new
  `get(id,userId)` in `src/db/providers.js`), **`src/portal-providers.js`** (`/portal/providers` CRUD + setActive + `/test`
  via new **`src/inference/probe.js`**) mounted in `server-rest.js`. Claude-subscription-OAuth DROPPED (ToS 2026-02-19);
  `/auth/{claude,openai}` stubs report not-connected. Gates: **`verify:providers-leak` + `verify:providers` GO**;
  no-regression GO on foundation/leak/mcp/rest. Cred storage = **encrypt-in-place** (NOT #69's `secrets` table — self-contained,
  avoids coupling to an unmerged PR; migrate later if wanted). ✅ **S2 BUILT** — `src/inference/resolve.js`
  `resolveInferenceConfig(db,userId)` maps the active provider → router opts (anthropic/openai), **authoritative over env**
  (returns `''` for the non-chosen vendor); `custom`/`base_url` deferred to S3; none→`{}` (env→local). Live caller
  `pipeline/describe-chronicles.js:166` resolves DB-first. `verify:resolve` GO; inference/chronicles no-regression GO.
  **RELAY MERGED TO MAIN** (`a03e9de`, PRs #45/#46) — merged into this branch (`91bac5b`); only collisions were `server-rest.js`
  (auto-merged: my providers mount + their remoteRouter coexist) + `package.json` verify chain (resolved: both gate sets). Relay
  is at `/api/v1/remote/*` — **no collision** with `/portal/providers` or a future `/v1/chat/completions`; `requireAuth()` in
  `server-http.js` is reusable for the S8 gateway. Connectors/secrets-API did NOT merge (still PR #69) → encrypt-in-place stands.
  ⚠️ Merge dragged in root debug debris (`_*.mjs` — `_reset-operator`, `_setpw`, `_decode-token`…) from a TEMP commit; left as-is
  (not my lane), flagged for cleanup on main. ✅ **S3a BUILT** — OpenAI-compatible `base_url` adapter in `src/inference/cloud.js`
  (`openaiCompatibleInfer`+`resolveChatUrl`, key-optional; covers OpenAI/OpenRouter/Together/Groq/**Regolo+Scaleway EU**/Ollama/
  LM Studio), `baseUrl`/`jurisdiction` threaded through `router.js`, `resolve.js` maps any base_url provider + tags `jurisdiction`
  via new `src/inference/presets.js` (regolo/scaleway→eu-zdr, localhost→local, unknown→us-standard fail-safe). `verify:resolve`
  extended GO; inference/chronicles no-regression GO. ✅ **S3b BUILT** — egress boundary at the router seam: `infer({…,sensitive})`
  HARD-BLOCKS sensitive content from a `us-*` provider (falls back to local; eu-zdr/local fine — §4g); `onEgress` audits EVERY
  cloud call (allowed/denied) with provider+jurisdiction+**sha256 hash+length only, never the prompt** (§4e) via new
  `src/inference/egress.js` `createEgressAuditSink(db,userId)` → general `db.audit` table (NOT the channel-shaped `egress_audit`).
  `verify:egress` GO. ✅ **"Intelligence" Settings UI BUILT** (separate brick) — `GET /portal/providers/presets` + new
  `portal-app/.../settings/IntelligenceSection.svelte` (presets grouped EU-sovereign/Local/US + jurisdiction badges,
  connect/use/test/remove), mounted in SettingsView; **portal build GO** (`npm --prefix portal-app run build` works in this env —
  install ~10s + build ~30s). **OUTBOUND LANE COMPLETE through S3 + UI.** **NEXT: S8 gateway** (`/v1/chat/completions` on :4711,
  reuse `requireAuth`; relay makes it remote-reachable; wire `createEgressAuditSink` + pass `sensitive`; v1 non-streaming) + **S6 HW
  recommender** (§4h). ⚠️ Do NOT edit `src/remote/*`, `src/connectors/*`,
  `src/db/secrets.js`. Design + Part 8 build status:
  [`docs/DESIGN-ai-interface-layer-2026-06-04.md`](docs/DESIGN-ai-interface-layer-2026-06-04.md).

- **AI Interface Layer — design spec (2026-06-04, latest).** `/sweep-first-design` (3 cycles + web research + own-eyes
  reads) designing how Mycelium connects to "other AI providers" both directions + bring-your-own-harness
  (opencode/odysseus/openclaw — all real OSS MCP+BYO-model). Spec:
  [`docs/DESIGN-ai-interface-layer-2026-06-04.md`](docs/DESIGN-ai-interface-layer-2026-06-04.md). **Reframe (pivot):** not a
  greenfield build — it's **two existing-but-disconnected membranes**. NORTH (inbound MCP server) is already generic +
  spec-compliant (`src/server-http.js` StreamableHTTP+OAuth2.1/DCR/RFC9728, no Claude-specific code) — gap is REACHABILITY
  (tunnel/relay doc-only) + ONBOARDING, not protocol. SOUTH (outbound `src/inference/*` router → Ollama/BYOK) is built but
  **DORMANT + DISCONNECTED**: router reads `process.env` not the `ai_providers` table (`src/db/providers.js`); 1 live caller
  (`pipeline/describe-chronicles.js:166`); the **provider frontend UI already exists** (`portal-app/.../SettingsView.svelte`,
  `OnboardingGuide.svelte`) but live backend never mounts `/portal/providers*` (port-source: `reference/server-routes/portal-providers.js`).
  **🚩 Two landmines (blocking):** (1) `ai_providers.credentials` is ABSENT from `ENCRYPTED_FIELDS` (`src/crypto/crypto-local.js`) →
  BYOK keys store PLAINTEXT (fix: add `ai_providers:['credentials']`, or route via encrypted `secrets` table); (2) the latent
  Claude-subscription-OAuth path (`auth_type:'oauth'`+`config_dir`) is an Anthropic **ToS violation since 2026-02-19** → drop it,
  BYOK API key only. **Plan:** S0 encrypt creds → S1 mount providers backend → S2 wire router↔creds → S3 widen via
  OpenAI-compatible `base_url` (covers OpenAI/OpenRouter/Together/Groq/**Regolo+Scaleway EU**/Ollama/LMStudio) + egress-audit
  the cloud seam → S4 North ergonomics (`MYCELIUM_HTTP_HOST` fix for the `0.0.0.0` bind at `server-http.js:278` + opt-in static
  bearer + server `instructions` preamble) → S5 onboarding docs → **S6 hardware-aware local-model recommender** (§4h: `detectHardware`
  via Tauri-Rust `sysinfo`+Node fallback + dated `models-catalog.json` + `recommendModels` under a RAM headroom budget + one-click
  `ollama pull`→`local` provider row; native "Cookbook", verified greenfield — no hw-detect/catalog code exists today). **LiteLLM =
  optional upstream only** (point Mycelium at it as one `custom` base_url); NOT embedded — egress boundary (§4e audit + §4g gate) must
  stay our code; Open WebUI/AnythingLLM skipped (Mycelium IS the UI+vault). ~1,020 LOC, no new deps (keep `fetch` adapters; Vercel AI SDK
  deferred). Operator forks: remote reachability (Tailscale-now vs relay vs stdio-only), cred storage shape, audience (self vs
  product). **Routing priority locked 2026-06-04 (§4g):** EU-sovereign ZDR (Regolo/Scaleway) → frontier (Anthropic/OpenAI/Google — also doubly-valuable as North MCP clients) → local (test tier) — **inverts shipped local-first**; `sensitive` hard-blocked from US providers (fail-closed); per-provider `jurisdiction` tag. **Remote reachability fork resolved → RELAY** (operator 2026-06-04). **Relay + Gateway now fully designed:**
  [`docs/DESIGN-relay-and-gateway-2026-06-04.md`](docs/DESIGN-relay-and-gateway-2026-06-04.md) (sweep-first, verification table). Relay = TLS-passthrough
  (TLS terminates on Mac via Caddy/ACME-DNS-01; relay = dumb SNI pipe) — **needs NO OAuth code change** (`MYCELIUM_BASE_URL` already
  drives discovery `auth.js:30-31`), just Caddy/tunnel config + `MYCELIUM_HTTP_HOST` bind fix (`server-http.js:278` binds 0.0.0.0) +
  CT-monitor; reuses the existing `<handle>.mycelium.id` publish subdomain, Caddy path-routes `/mcp,/v1,/.well-known,/api/auth`→:4711 and
  `/p,/s`→:8788. Gateway = `POST /v1/chat/completions` (Bearer-guarded, on :4711, relay-reachable) fronting the South router → harness points
  BOTH memory(MCP) + model(/v1) at Mycelium ("Mycelium IS the gateway, not LiteLLM"); **v1 NON-streaming** (router single-shot, no SSE in repo;
  streaming+tools fast-follow); can't enforce `sensitive` hard-block on opaque gateway input (jurisdiction+audit instead). New phases **S7
  (relay) + S8 (gateway)**, ~400 LOC repo + relay VPS infra. **NOT YET BUILT — design only; next = build (S0 first).** ⚠️ Branch off this branch's base; CLAUDE.md "empty packages" claim is STALE
  (full `src/` exists).

- **Context Bank Upgrade — design spec (2026-06-02, latest).** Sweep-first-design pass closing the MCP
  context-bank gaps from the design review: forget/redact, facts store, `relatedContext`, entities,
  Tier-2 gating, user salience, unified `ref` handle. **✅ ALL 5 PHASES BUILT + verified (31→27 tools — net slimmer; forget 13/13, facts 17/17, related 7/7, entities 19/19, gating 8/8, cognition 7/7, mindscape 8/8; full `verify` 37× GO). Upgrade COMPLETE; follow-ups only:**
  [`docs/CONTEXT-BANK-UPGRADE-DESIGN-2026-06-02.md`](docs/CONTEXT-BANK-UPGRADE-DESIGN-2026-06-02.md). Key
  sweep pivots: forget is NOT greenfield (builds on `documents.delete`+`afterDeleteHooks`,
  `backend.delete({ids})`, `revoked_at` tombstone); cascade is shallow (only `clustering_points` +
  `embedding_768` ref a message — aggregates self-heal per `clustering_run_id`); facts is greenfield
  (`user_profiles`≠facts store); `relatedContext`=thin reuse of `backend.query({text})`; Tier-2 gating
  needs an async readiness probe threaded into `buildDomains` (static at boot). v3 LEAN surface (net **31→~27 tools**): 4 lean verbs (remember/forget/mark/link) + reads fold into searchMindscape/getContext; 11 cognitive/topology readers consolidate→3 (cognitiveState/cognitiveHistory/mindscape, behind pre-deletion-caller-audit). Decisions locked §11 (soft-redact-only · typed facts · 'not-ready' gating · lean verbs · slim existing · all phases);
  build order = Phase 1 (forget+salience) DONE [`a200ed0`·`9cde646`·`22c1a75`] · Phase 2 (facts + `remember` + `relatedTo`/`scope:'facts'` + getContext FACTS) DONE [`2789f72`·`e8d1d83`] · Phase 3 (entities + `link` verb + NLP-promote + getContext PEOPLE + `scope:'entities'`) DONE [`4aa5f4c`·`13c96ce`] · Phase 4 (cold-start gating, mid-session flip) DONE [`1022a92`] · Phase 5 (consolidate 11 cluster/Fisher/metric/topology readers → 3: `cognitiveState`/`cognitiveHistory`/`mindscape`, via verbatim handler reuse; 35→27; behind full `/pre-deletion-caller-audit`) DONE [tools `f0c673a` · gates `73e448a`]. Rebased onto #43 (`1a8f525`). Local SQLite only — no D1/Cloudflare. Key gotchas: encrypted upserts MUST use `ON CONFLICT … DO UPDATE SET x=excluded.x` (a fresh `?` writes plaintext); can't UNIQUE an encrypted col (entity name dedup is app-layer); tool-count asserts live in 4 places (verify:mcp dynamic, forget/facts/entities ===27, verify:portal P3 floor >=25). **Follow-ups:** flip PR #42 to ready (human security review), NLP-promote auto-trigger, real-vault Tier-2 smoke. **Pickup:** [`docs/CONTEXT-BANK-UPGRADE-HANDOFF-2026-06-02.md`](docs/CONTEXT-BANK-UPGRADE-HANDOFF-2026-06-02.md).

- **Account setup + durable data + MCP review (2026-06-02).** **#36 landed on main**
  (account ceremony): the vault now lives in a **durable per-OS data dir** (`src/paths.js`,
  survives app updates; legacy `./data` non-destructively relocated; fresh vault self-migrates,
  no `init-db`); **SINGLE recovery key** — user saves only USER_MASTER, SYSTEM_KEY is
  HKDF-derived (`src/account/keystore.js`) — **amends D4+D6's "two independent keys"**; the REST
  server boots in **setup mode** (`/setup` ceremony, `/api/v1/account`, vault routes 503-guarded,
  completes boot in-process) so a new user needs no terminal; recovery key re-viewable in Settings
  + restorable by paste (KCV-verified). Docs reconciled to this reality (CLAUDE.md, V1-BUILD-SPEC
  D4/D6, ARCHITECTURE §3/§5/§6/§9). **⚠️ SUPERSEDES** the earlier "key ceremony = Tauri native /
  keys never touch HTTP" call: setup is **web-based** (server boots keyless in setup mode) and the
  recovery key DOES traverse a **localhost** HTTP response (`GET /api/v1/account/recovery-key`,
  loopback-guarded) — a deliberate, conscious relaxation of CLAUDE.md §4 for a single-user local
  vault. **PR #37 open** (MCP: opt-in `MYCELIUM_DEBUG=1` tool-failure diagnostics +
  [`docs/MCP-CONNECT-AND-TEST.md`](docs/MCP-CONNECT-AND-TEST.md)) — flags that a hand-rolled stdio
  Claude Desktop config must set `MYCELIUM_DATA_DIR` or it opens a *different, empty* vault.
  Discarded (superseded/colliding): a key-ceremony design doc (#36 built it differently) + a
  pipeline-adjacent enrichment job (other agent owns the pipeline rebuild). Branch hygiene: pruned
  the squash-merged #27–#35 branches. ⚠️ Branch off `origin/main`.

- **V1 UX build-out + bug-hunt + Mac-fixes SHIPPED TO MAIN (2026-06-02).** `main @ d3a3506`,
  `npm run verify` → **29× GO**. Merged #27 (nav/Mindscape-read/import[hardened]/Timeline/Profile/
  Settings/welcome + window-drag + import-dnd) · #28 (**Phase G** generate `src/jobs.js`; **Phase C**
  chronicles `pipeline/describe-chronicles.js`) · #29 (docs) · #30 (**profile editing** `user_profiles`
  + **MCP err.message redaction**) · #31 (**design-system channel-var accent fix** — ported from another
  agent's `reference/portal` commit) · **#34** (Mac-test session's import fixes, integrated from #32:
  **upload-404** [`chunked-upload.ts` bypassed the api.ts rewrite], **clustering-empty-DB**, original
  timestamps, Mac drag-drop, batched embeds; + `verify:import-timestamps`).
  **4 bug-hunt sweeps**: mostly false positives (ON-CONFLICT-order, jobs-race, enrichment-self-heals —
  disproven); real finds: MCP leak + profile gap. **The real Mac test caught 2 bugs Tier-1 verify
  missed (upload path, child dbPath) — verify the seam the frontend/child uses, not just the endpoint.**
  NEXT (here-doable): rest of the design-system port (/design styleguide, agent-colors), `/mindscape/
  explore` job. Deferred: Phase K, parser parity (canonical repo), distribution (LAST). Full handoff:
  [`docs/HANDOFF-2026-06-02.md`](docs/HANDOFF-2026-06-02.md). ⚠️ Branch off `origin/main` (local `main`
  is stale legacy); `reference/portal` edits ≠ live `portal-app`.

- **Complete-UX design LOCKED (2026-06-01).** Canonical portal adopted + served, no login wall,
  Library wired. The **whole experience is now designed** (4-sweep `/sweep-first-design`, security
  pivot: keys never touch HTTP): [`docs/UX-COMPLETE-DESIGN-2026-06-01.md`](docs/UX-COMPLETE-DESIGN-2026-06-01.md).
  **Operator calls:** (1) key ceremony = **Tauri native first-run** (Rust gens keys → Keychain →
  boots Node, bundled setup view); (2) **tight 6-screen nav** (Mindscape/Library/Import/Timeline/
  Profile/Settings) + disabled **"Coming later"** group. **BUILD ORDER: N→M→I→G→C→(T,P,S)→K→O**
  (N=nav trim first, frontend-only, instant coherence; K=ceremony Mac-gated last). Detailed
  M/I/G/C/O shapes in [`docs/UX-JOURNEY-BUILDOUT-DESIGN-2026-06-01.md`](docs/UX-JOURNEY-BUILDOUT-DESIGN-2026-06-01.md).
  `npm run verify` → **24× GO**. ⚠️ Branch off `origin/main` (local `main` is stale).
  **Phases N+M+I+T+P+S+O DONE** on branch `claude/ux-complete-design` — **all 6 primary-nav screens
  render real local data.** N=nav trim (`verify:nav`); M=mindscape read (`src/portal-mindscape.js`,
  `verify:portal-mindscape`); I=import (`src/ingest/import-parsers.js`+`src/portal-uploads.js`, busboy,
  jszip, `verify:import`); T/P/S/O=Timeline+Profile+Settings+first-run-welcome (`src/portal-compat.js`,
  `verify:portal-tps`). Commits: `5328329`,`f0972f7`,`2158b96`,`1cffd9b` (+design `0cd40f5`).
  **NEXT (env-gated): Phase G** (generate — `src/jobs.js` + explore/generate endpoints; job lifecycle
  verifiable vs a dry-run, real clustering is Tier-2), then **C** (chronicles, needs LLM) and **K**
  (Tauri key ceremony, Mac/Rust-gated). Full status: [`docs/UX-HANDOFF-2026-06-01.md`](docs/UX-HANDOFF-2026-06-01.md).

- **V1 build — Wave 1+2 DONE; UX pass + ingestion/uploads BUILT.** MCP server serves **31 tools**
  over stdio + HTTP/OAuth. Added getContext, captureMessage, importMessages, listTasks; folded
  metrics 8→6. **Ingestion + uploads fully built** (capture choke-point, encrypted blob store,
  /ingest/{message,import,upload} Bearer routes, migration runner, enrichment hand-off seam) —
  see [`docs/INGESTION-UPLOADS-DESIGN-2026-05-31.md`](docs/INGESTION-UPLOADS-DESIGN-2026-05-31.md).
  Pick up: [`docs/V1-BUILD-HANDOFF-2026-05-30.md`](docs/V1-BUILD-HANDOFF-2026-05-30.md) (read the
  **2026-05-31 (late)** section). Branch `claude/repo-overview-mC69M` @ `8d7a8e7`.
  Proof: `npm install --legacy-peer-deps && npm run verify` → **13× GO, EXIT 0**.
  NEXT: D7 enrichment service (:8095) skeleton. ⚠️ No autonomous wake-loop in this env (no
  ScheduleWakeup/Cron/Monitor); Tier-2 (real models/deploy/tokens) needs a networked host.

## Pre-launch

- **Readiness map (2026-06-01):** [`docs/PRE-LAUNCH-READINESS-2026-06-01.md`](docs/PRE-LAUNCH-READINESS-2026-06-01.md)
  — journeys A–G, functionality × {built/verified/Tier-2/unbuilt}, test-coverage map, ranked P0/P1/P2.
  **Core is verified (26 suites); the launch gaps are distribution (npm `private`, Tauri unbundled),
  remote deploy (Tunnel doc-only), the in-app generate-mindscape trigger (Phase G) + clustering being
  manual/Tier-2/unverified, and onboarding friction.** Reader doc: [`docs/HOW-IT-WORKS.md`](docs/HOW-IT-WORKS.md).

## Key docs

- Spec: [`docs/V1-BUILD-SPEC.md`](docs/V1-BUILD-SPEC.md) (v1.2, verification table, D1–D7)
- Plan: [`docs/V1-IMPLEMENTATION-PLAN.md`](docs/V1-IMPLEMENTATION-PLAN.md) (6 phases; Steps 1–4 done)
- Verified results: [`docs/FOUNDATION-WAVE1-RESULT.md`](docs/FOUNDATION-WAVE1-RESULT.md)
- Spikes (verified GO): `spike/oauth/RESULT.md` (R1 better-auth), `spike/crypto/RESULT.md` (D3/D4/D6)

## Standing disciplines (see CLAUDE.md)

- Verify every step with running code before building on it; never claim green without
  watching the ledger reach `VERDICT … EXIT=0`.
- Run tasks to completion; fold sweep findings in rather than pausing.
- **Skill set is V1-only (6 project skills).** Removed the canonical-only `tenant-schema-parity` (V1 has one `mycelium.db`, no fleet → cross-DB drift impossible); its migration-hygiene kernel folded into `/deploy-and-verify`, which was rewritten for V1 (verify-ledger → smoke → [✓]/[—] ledger; dropped fleet/SSH/wrangler/PM2). Remaining: sweep-first-design · deploy-and-verify · pre-deletion-caller-audit · handoff-discipline · living-docs · auto-merge-on-green.
