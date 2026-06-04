# AI Interface Layer — Design

**Date:** 2026-06-04
**Status:** Design (sweep-first). 3 sweep cycles + web research + own-eyes verification. **No code yet.**
**Skill:** `/sweep-first-design`. Format follows `docs/reference/EGRESS-PROVENANCE-PHASE2-DESIGN-2026-05-06.md`.
**Scope:** How Mycelium connects to "other AI providers" — both directions — and how a user plugs in their own agent harness (opencode / odysseus / openclaw / Goose / Cline / …). Companion reads: [`MCP-OVERVIEW.md`](MCP-OVERVIEW.md), [`CONNECTORS.md`](CONNECTORS.md), [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## TL;DR — the headline

The "AI interface layer" is **two membranes around the context bank**, and the codebase is asymmetric on them:

```
                       ┌──────────────────────────────────────────┐
   any AI client  ───▶ │  NORTH membrane — INBOUND MCP server     │ ─── already generic + spec-compliant.
   (Claude, ChatGPT,   │  stdio · Streamable HTTP + OAuth 2.1     │     Gap = REACHABILITY + ONBOARDING,
    Gemini, Copilot,   │  (src/mcp.js · src/server-http.js)       │     not protocol.
    opencode, Goose…)  └──────────────────────────────────────────┘
                                     ▲   ▼
                       ┌──────────────────────────────────────────┐
                       │            THE CONTEXT BANK               │
                       │  one encrypted SQLite vault · 27 MCP tools│
                       │  ingest choke-point (captureMessage)      │
                       └──────────────────────────────────────────┘
                                     ▲   ▼
                       ┌──────────────────────────────────────────┐
   Mycelium  ────────▶ │  SOUTH membrane — OUTBOUND model gateway │ ─── built but DORMANT + DISCONNECTED.
   (enrichment,        │  inference router → Ollama / BYOK cloud   │     Credential store and the calls
    generate, narrate, │  (src/inference/* · src/db/providers.js)  │     don't touch each other. Frontend
    image-describe)    └──────────────────────────────────────────┘     UI exists; live backend missing.
```

**Three findings that reframe the work:**

1. **North is basically done at the protocol level.** `src/server-http.js` already speaks Streamable HTTP + OAuth 2.1 (PKCE, DCR, RFC 9728) with zero Claude-specific assumptions. *Any* spec-compliant MCP client connects today. What's missing is (a) **reachability** from the public internet (tunnel/relay is doc-only) and (b) **onboarding** ("paste this connector URL into ChatGPT/Claude/Gemini").

2. **South is a wiring job, not a build.** The `ai_providers` table (`src/db/providers.js`), the inference router (`src/inference/*`), and the **entire provider-management frontend** (`portal-app/.../SettingsView.svelte`, `OnboardingGuide.svelte`) all exist — but the live V1 backend never mounts the routes that connect them, and the router reads `process.env` instead of the table. The backend port-source is sitting in `reference/server-routes/portal-providers.js`.

3. **Two landmines surfaced.** (a) 🚩 `ai_providers.credentials` is **not** in `ENCRYPTED_FIELDS` (`src/crypto/crypto-local.js`) → BYOK keys would store **in plaintext**. (b) 🚩 The latent "use your Claude subscription via a Claude Code OAuth token" path (the `auth_type:'oauth'` + `config_dir` design in `providers.js`) became an **Anthropic ToS violation on 2026-02-19**. Both must be addressed before any provider key is written.

**Recommended spine:** ship the **South membrane wiring** first (it unlocks privacy-first inference (EU-sovereign + local) for enrichment/generate and is fully in our control), then the **North membrane reachability + onboarding** (it unlocks "use Mycelium as the memory for ChatGPT/Gemini/your-own-agent"). Bring-your-own-harness falls out of North (MCP client) + optional South (point the harness's model calls at our gateway).

---

## Part 0 — What "AI interface layer" means here

A precise vocabulary, because "connect to AI providers" is ambiguous and the two directions have *opposite* security postures:

| | **North membrane (inbound)** | **South membrane (outbound)** |
|---|---|---|
| Mycelium's role | **MCP server** — a tool/resource provider | **API client** — a prompt sender |
| Who initiates | The AI (Claude, ChatGPT, a harness) calls *in* | Mycelium calls *out* to a model |
| What crosses | Tool calls + the context we choose to return | A prompt (user plaintext) + the model's reply |
| Security posture | **Auth the caller**, return least-context, never leak other scopes | **Egress boundary** — plaintext leaves the box; audit + consent |
| Privacy default | Vault stays put; AI reads via tools | **Local-first** (Ollama); cloud only on opt-in |
| Built? | Protocol ✅ · reachability ❌ · onboarding ❌ | Plumbing ✅ but **disconnected** + frontend-only |

Both membranes share three things, which is why they belong in one design: **(1) the credential vault** (`ai_providers` + the encrypted `secrets` table), **(2) the egress/audit boundary**, **(3) the universal context preamble** (`getContext`). Build those shared pieces once.

---

## Part 1 — As-built reality (consolidated sweep findings, file:line)

### 1a. North — inbound MCP server (already generic)

- **One `boot()`, three transports** (`MCP-OVERVIEW.md`; `src/mcp.js:52` `buildDomains`, `:193` `createMcpServer`). 27 tools, low-level `Server` with `ListTools`/`CallTool` handlers; handlers return strings wrapped at one seam (`src/mcp.js:201-233`).
- **stdio**: `src/index.js:90-97` — `StdioServerTransport`, `server.connect(transport)`. No network, no token; security is the keychain keys.
- **Streamable HTTP + OAuth 2.1**: `src/server-http.js` — `StreamableHTTPServerTransport` **per session** keyed by `mcp-session-id` (`:142-149`), fresh `boot()` + vault per `initialize` (`:140`), Bearer-guarded (`:112-125`), `WWW-Authenticate` → RFC 9728 metadata (`:96-97`). Discovery well-knowns at root (`:62-69`); better-auth owns `/api/auth/*` with **DCR enabled + PKCE required** (`src/auth.js`, verified by `verify:oauth`).
- **No client-specific code.** No user-agent checks, no "Claude" branching in runtime paths. SDK `@modelcontextprotocol/sdk@^1.29.0` (`package.json:67`).
- **REST** (`src/server-rest.js` / `src/api.js:31-143`): `POST /api/v1/:toolName` → same handler map; **no auth, loopback only** by design.
- **Authenticated ingest** on the HTTP server: `POST /ingest/{message,upload,import}` Bearer-guarded (`src/server-http.js:208,229,254`).
- 🚩 **`src/server-http.js:278` calls `app.listen(port)` with no host arg** → binds `0.0.0.0` (all interfaces), unlike REST (`127.0.0.1`, `server-rest.js`) and public (`127.0.0.1`, `public-server.js:148`). Intended to sit behind a tunnel, but there's no `MYCELIUM_HTTP_HOST` guard. Fix in the North work.

### 1b. South — outbound provider plumbing (built, dormant, disconnected)

- **`ai_providers` table** (`migrations/0001_init.sql:119-134`; namespace `src/db/providers.js`): columns `provider` (`claude|openai|custom`), `auth_type` (`oauth|api_key`), `credentials`, `config_dir`, `base_url`, `model_preference`, `is_active`, `status`. `getActive(userId, type)` enforces one-active-per-type.
- **Inference router** (`src/inference/router.js`): task-routed (simple→local Ollama, complex→cloud-if-key-else-local, cloud-failure→local fallback). Reads **only** `process.env.ANTHROPIC_API_KEY` / `OPENAI_API_KEY` (`:53-54`). Cloud backend (`src/inference/cloud.js`) hits `api.anthropic.com/v1/messages` and `api.openai.com/v1/chat/completions` directly — **Anthropic + OpenAI only, hardcoded**.
- **Wiring status: DISCONNECTED.** Grep for `providers`/`getActive`/`ai_providers` inside `src/inference/` → **zero**. The router never reads the table. The *only* live inference caller is `pipeline/describe-chronicles.js:166` (`task:'narrate'`); `src/enrich/describe-image.js` imports `localInfer` directly. Header comment confirms: *"No internal caller yet."*
- **`ai_provider_assignments`** table + `src/db/assignments.js` (desired-state agent→provider map) — **no reconciler, no callers**. Pure infrastructure.
- **Frontend exists, backend missing.** `portal-app/src/lib/views/SettingsView.svelte` has a full **AI Providers** section (Claude OAuth + OpenAI key + Custom base_url), `OnboardingGuide.svelte` has a provider picker, `(app)/agents/+page.svelte` + `_AgentRow.svelte` exist. They call `/portal/providers*`, `/portal/auth/claude*`, `/portal/auth/openai*`. **The live `/portal/*` shim (`src/portal-compat.js`) implements none of them** — it has documents/folders/messages/profile/onboarding and a stub `GET /agents → {agents:[]}` (`:221`). So the UI currently hits 404/stub. **Port-source for the missing backend: `reference/server-routes/portal-providers.js`, `portal-auth-claude.js`, `portal-auth-openai.js`.**
- **Embeddings** are a separate, fixed provider: `src/embed/client.js` → loopback `:8091`, `pipeline/embed-service.py` hardcodes Nomic v1.5. Not part of the chat-provider story; leave as-is.

### 1c. The context bank — ingestion sources (what we "suck in")

- **Choke-point**: `captureMessage(db, msg, enqueueEnrichment)` (`src/ingest/capture.js:61`), id-dedup via `getExistingIds`+`insertIgnore`, lands `nlp_processed=0` then enqueues enrichment.
- **Import parsers** (`src/ingest/import-parsers.js`): **Claude export ✅, ChatGPT export ✅**; **Obsidian + LinkedIn detected but "not supported yet"** (`:79-80,109`). Bounds 400 MB / 1 M messages.
- **Uploads**: encrypted blob store (`MYCB` envelope, AES-256-GCM, `src/ingest/blob-store.js`), any MIME, portal + `/ingest/upload`. Vision-model image captioning on upload (`src/enrich/describe-image.js`, Ollama).
- **Messaging connectors** (Telegram/Discord/WhatsApp/Signal): **spec-only** (`docs/CONNECTORS.md`) — no `connectors/` code. Designed to POST `captureMessage`.
- **Apple Health**: `health_daily` (21 encrypted fields, `src/db/health.js`); `syncDays()` exists but **no automatic sync route** — needs a bridge.
- **No Obsidian live-sync / filesystem-watch** anywhere.
- **Enrichment** (`src/enrich/*`): embeddings (Nomic 768D) + deterministic NLP extraction (entities/tags/summary) + image description.

### 1d. Security boundary (what protects plaintext)

- **Encryption-at-rest**: `src/adapter/d1.js:36-53` auto-encrypts on write / decrypts on read at the query boundary; `ENCRYPTED_FIELDS` in `src/crypto/crypto-local.js:214-472` lists ~40 tables. 🚩 **`ai_providers` is absent** (verified by reading the list myself). There **is** an encrypted **`secrets`** table (`secrets: ['key','description']`, system-key family) — a robust, audited credential primitive (`docs/reference/AGENT-WRITABLE-SECRETS-DESIGN-2026-05-19.md`).
- **Guardians** (`src/crypto/guardians/*`): runtime, fail-closed — but they gate **scope/DEK-unwrap** on encrypt/decrypt, *not* outbound HTTP content. They do **not** see cloud egress.
- **Egress-audit** (`src/db/egress-audit.js`): append-only, **hash+length only, never plaintext** — schema present, **no callers in V1** (Phase-0 design-only).
- **Egress-provenance + explicit-send chokepoints** (`/telegram/send` etc., CLAUDE.md §11): **reference-only**, not wired in V1 `src/`.
- 🚩 **Cloud inference egress is unaudited**: `src/inference/cloud.js` just `fetch()`es the prompt to the provider — no audit row, no guardian, no consent record. Intentional ("opt-in BYOK") but it's the seam to harden as we add providers.

### 1e. Reachability + distribution

- **No tunnel/relay code** — `tunnel`/`cloudflare`/`tailscale` appear only in comments + docs (`docs/PRE-LAUNCH-READINESS-2026-06-01.md:141,178` mark it "doc-only"). Remote MCP = "run `--http` behind a tunnel you provision."
- **Public server `:8788`** = published documents only, fail-closed — **not** an MCP path.
- **Tauri** = self-contained `.app` (bundles Node + Python + model), opens a **local WebView → `127.0.0.1:8787`**; **no network-listening port**. Desktop-only.
- **Distribution infra absent**: `package.json private:true`, no npm-publish, no signing/notarization, no release CI.

### 1f. Agents / multi-tenancy

- V1 is **single user, single agent** (`agentId='personal-agent'`, `AGENT_LABELS={'personal-agent':'Assistant'}`, `src/mcp.js:35,55`). `isScoped:()=>false` (`:95`) — multi-scope plumbing exists in schema but is frozen to `'personal'`. The `agents/` frontend + assignments table are the **seed** for "many agents, per-agent provider," but there's no orchestrator. Treat multi-agent as **deferred**.

---

## Part 2 — Research synthesis (June 2026, cited)

### 2a. Who can be an MCP *client* (North compatibility matrix)

The lingua franca for a remote MCP server is **Streamable HTTP + OAuth 2.1 (PKCE + DCR)** — which V1 already speaks. Per-client (GA = generally available):

| Client | stdio | Remote (Streamable HTTP) | OAuth for remote | Status |
|---|---|---|---|---|
| Claude Desktop / Claude.ai web (Connectors) / Claude Code | ✅ | ✅ | ✅ native | GA (paid) |
| Anthropic Messages API (`mcp_servers`) | — | ✅ | Bearer you supply | Beta |
| OpenAI Responses API (`tools:[{type:"mcp"}]`) | — | ✅ any remote MCP | ✅ headers/token | **GA** |
| OpenAI Agents SDK (`HostedMCPTool`) | ✅ | ✅ | ✅ | GA |
| ChatGPT apps/connectors (Developer Mode) | — | ✅ | ✅ | Beta, **admin-gated**, Business/Ent |
| Gemini Enterprise (Vertex) / Gemini CLI | CLI ✅ | ✅ | ✅ (CLI flow buggy) | GA |
| Microsoft Copilot Studio | — | ✅ | **OAuth 2.0 only** ⚠️ may reject 2.1-only servers | GA |
| Cursor · Windsurf · Mistral Le Chat · Block **Goose** | ✅/— | ✅ | ✅ (Goose: OAuth 2.1+PKCE+DCR) | GA |
| Perplexity | — | limited | — | ⚠️ **drifting off MCP** (Mar 2026) |

Implication: **implement nothing new for protocol compatibility.** Two caveats to document: Copilot Studio is OAuth-2.0-only (offer a static-bearer or 2.0-tolerant mode), and Perplexity is deprioritizing MCP.

### 2b. MCP authorization spec state

Latest published **2025-11-25**; RC **2026-07-28** ("largest revision since launch": stateless core, Tasks, auth hardening — clients must validate `iss`). Normative base (2025-06-18): **auth is OPTIONAL overall; stdio SHOULD NOT use OAuth** (creds out-of-band via env); **HTTP SHOULD** use OAuth 2.1 — server is a **resource server** that MUST publish **RFC 9728** metadata; **RFC 8707 Resource Indicators** required to block confused-deputy; **DCR is SHOULD**, not MUST. **No spec-blessed "static API token" profile**, but because HTTP auth is *SHOULD*, a single-user server may offer a static bearer and stay spec-tolerant (no interop guarantee). → We keep full OAuth as default; add an **opt-in static-bearer mode** for single-user + 2.0-only clients.

### 2c. Outbound lingua franca + Node libraries

- **OpenAI `/v1/chat/completions` is the de-facto floor** every backend exposes (Ollama, LM Studio, OpenRouter, Together, Groq, vLLM, Regolo, Scaleway). Target it as the baseline; add `/v1/responses` opportunistically. **Anthropic is NOT natively OpenAI-shaped** (`/v1/messages`; its OpenAI-compat endpoint is a testing shim) → keep a native Anthropic adapter.
- **LiteLLM is Python-only** (sidecar proxy) — contradicts our no-extra-process, privacy-first stance. **Node-native** options: **Vercel AI SDK** (`ai` + `@ai-sdk/*`, best-maintained, native Anthropic + OpenAI-compatible base-URL + unified tool calling) or **token.js** (everything coerced to OpenAI shape, zero proxy). Recommendation in Part 4.
- **Claude subscription via OAuth token is ToS-banned** (Anthropic Consumer Terms, 2026-02-19; enforceable without notice; explicitly includes the Agent SDK). Sanctioned programmatic-on-subscription exists *only* through the official Agent SDK "Agent SDK credit" (from 2026-06-15). → **Drop `auth_type:'oauth'`/`config_dir` for Claude. BYOK API key only.**

### 2d. Bring-your-own agent harnesses (all three names are real)

| Name | What | Maker | OSS | MCP client | BYO model |
|---|---|---|---|---|---|
| **opencode** | Terminal-first coding agent (TUI/desktop/IDE) | **SST** (`sst/opencode`) | ✅ MIT | ✅ stdio + remote/SSE | ✅ Anthropic/OpenAI/Gemini/Bedrock/Groq/OpenRouter + self-hosted/local |
| **odysseus** | Self-hosted AI *workspace*; agent mode built on opencode + MCP | **PewDiePie** (`pewdiepie-archdaemon/odysseus`, launched 2026-05-31) | ✅ MIT | ✅ native + built-in servers | ✅ Ollama/llama.cpp/vLLM + OpenAI/OpenRouter |
| **openclaw** | Self-hosted personal AI assistant w/ channel connectors + memory + Gateway | `openclaw/openclaw` | ✅ | ✅ MCP subprocesses | ✅ GPT/Claude/Gemini/DeepSeek + Ollama/OpenRouter |

Plus **Goose** (Apache-2.0, full OAuth 2.1 remote MCP), **Cline**, **OpenHands**, **Aider** — all MCP + model-agnostic. ⚠️ **openclaw is heavily impersonated by scams** — pin the canonical repo only. Note: **openclaw and odysseus are direct conceptual neighbors of Mycelium** (personal AI + connectors + memory) — prior art worth tracking. **Design consequence:** every one of these consumes MCP and brings its own model, so the "bring your own harness" story is *"point your harness at Mycelium's MCP URL"* (North) — no bespoke integration per harness.

---

## Part 3 — North membrane design (serve the context bank to any AI)

**Thesis:** the protocol is done; deliver **reachability**, **auth ergonomics**, and **onboarding**. Three sub-pieces.

### 3a. Reachability — how a cloud AI reaches a vault on someone's Mac

Cloud clients (ChatGPT, Claude.ai web, Gemini Enterprise) need a **public HTTPS URL**. Local clients (Claude Desktop, Cursor, opencode, Goose) use **stdio** and need nothing. Options, in increasing sovereignty/effort:

| Option | What | Plaintext seen by 3rd party? | Effort | When |
|---|---|---|---|---|
| **A. stdio only** | Local desktop clients spawn `node src/index.js` | none | 0 (works today) | default for desktop |
| **B. Tailscale / WireGuard** | Private mesh; `--http` reachable to *your* devices | none (E2E) | low (install + 1 doc) | **recommended interim** for personal remote |
| **C. Cloudflare Tunnel / ngrok** | Public HTTPS to `:4711` | ⚠️ **CF terminates TLS** — sees plaintext | low | quick public demo only; **flag the trust cost** |
| **D. TLS-passthrough relay** | SNI-routed dumb pipe; TLS terminates on the Mac (ACME DNS-01, key born local) | **none** (relay can't read) | high (operate relay infra) | the sovereign public path (user's research corpus, 2026-06-02) |

**Recommendation:** A+B now (zero/low build, no plaintext exposure); **D is the eventual public-grade answer** and is already well-researched — but it's *infrastructure we operate*, not in-repo code, so it's a separate workstream. **Avoid C as anything but a labelled demo** — it contradicts the sovereignty promise (CF sees plaintext). In all cases, fix the bind: add `MYCELIUM_HTTP_HOST` (default `127.0.0.1`; the tunnel/relay explicitly opts into `0.0.0.0`) so `--http` isn't accidentally world-open (`src/server-http.js:278`).

### 3b. Auth ergonomics — meet every client where it is

Keep **OAuth 2.1 + DCR** (already built) as the default — it's the lingua franca and what Claude/OpenAI/Gemini/Goose expect. **Add an opt-in single-user mode:**

- **`MYCELIUM_MCP_BEARER=<token>`** — a static bearer accepted on `/mcp` *in addition to* the OAuth path. Justification: the spec makes HTTP auth a *SHOULD*; a single-user vault behind Tailscale (3a-B) or feeding a 2.0-only client (Copilot Studio) is better served by a copy-pasteable token than a full OAuth dance. **Fail-closed**: only honored when the env var is set; never a default-open path. ~40 LOC in `server-http.js`'s `authenticate()`.

### 3c. The universal context preamble (the actual product value)

The reason any AI connects is **`getContext`** — the D5 preamble (`src/tools/context.js`; `MCP-OVERVIEW.md §5`). It already returns the one-shot briefing (internal model, facts, people, recent messages, phase, body-state; sensitive excluded). For the multi-client world, add a tiny **connector manifest**:

- A short server-`instructions` string (MCP `initialize` response) telling *any* connecting model: *"Call `getContext` first; search with `searchMindscape`/`relatedTo`; write with `captureMessage`/`remember`."* This is how we make a generic ChatGPT/Gemini session behave like a Mycelium-aware one without per-client code. ~20 LOC where `createMcpServer` builds the `Server` (`src/mcp.js:193`).

### 3d. Onboarding — "Connect Mycelium to your AI"

A docs page + a Settings panel that emits, per client, the exact connector string:
- **Claude Desktop / Cursor / opencode (stdio):** the `claude_desktop_config.json` snippet (already in `MCP-OVERVIEW §7`).
- **Claude.ai web / ChatGPT / Gemini (remote):** the public URL (`https://<you>.mycelium.id/mcp` or the Tailscale name) + either "Sign in" (OAuth) or "paste this token" (static bearer).
Reuse the existing `OnboardingGuide.svelte` "AI connection" step — flip it from "connect a provider to Mycelium" (South) to *also* "connect Mycelium to your AI" (North).

---

## Part 4 — South membrane design (Mycelium calls any provider)

**Thesis:** wire the three existing-but-disconnected pieces, fix the two landmines, then widen the provider set via the OpenAI-compatible `base_url`.

### 4a. Connect the credential store to the router

Add a resolver that turns the active DB row into router config:

```js
// src/inference/resolve.js  (~60 LOC)
// Reads ai_providers.getActive() and returns {anthropicApiKey|openaiApiKey|baseUrl, model}
// for the inference router. Env vars remain a fallback (BYOK power users).
export async function resolveInferenceConfig(db, userId, { env = process.env } = {}) { … }
```

Change `createInferenceRouter` to accept a resolved config (it already takes injected keys — `router.js:39-57`), and have the one live caller (`pipeline/describe-chronicles.js:166`) resolve from the DB first, env second. **No behavior change when no provider configured** (still local Ollama) — fail-soft preserved.

### 4b. Widen providers via OpenAI-compatible `base_url`

The schema already has `base_url`. Generalize `cloud.js` from "Anthropic | OpenAI" to **"native Anthropic adapter + one OpenAI-compatible adapter that takes a `base_url`."** That single adapter covers **OpenAI, OpenRouter, Together, Groq, Regolo, Scaleway, Ollama-remote, LM Studio, vLLM, DeepInfra** — anything speaking `/v1/chat/completions`. Curated presets (label + base_url + default model) ship as a static list the UI offers; "Custom" stays the escape hatch.

```js
// src/inference/cloud.js  — refactor (~80 LOC delta)
// anthropicInfer(... /v1/messages ...)                     // native (unchanged)
// openaiCompatibleInfer({ baseUrl, apiKey, model, ... })   // generalizes openaiInfer; baseUrl defaults to api.openai.com
```

**Presets (data, not code) — ordered by the operator routing priority (§4g), each tagged with a jurisdiction:**
1. **EU-sovereign ZDR** *(`eu-zdr`)* — **Regolo.ai**, **Scaleway**, **Exoscale**, Nebius (EU). *The default workhorse — capable + privacy-preserving, no US Cloud Act exposure.*
2. **Frontier labs** *(`us`)* — **Anthropic** (native `/v1/messages`), **OpenAI**, **Google/Gemini**. *Doubly valuable: these are the same providers whose apps/APIs connect **into** Mycelium as MCP clients (North) — so each one earns its keep on both membranes.*
3. **US inference APIs** *(`us`)* — Together, Groq, Fireworks, DeepInfra, OpenRouter — non-sensitive overflow.
4. **Local runtime** *(`local`)* — **Ollama**, **LM Studio**, MLX. *A **test tier** in V1 (not yet good enough to be primary on typical hardware) + the safest path for `sensitive` content; promotes toward primary as local quality climbs.*
5. **Custom** — the `base_url` escape hatch for anything else (incl. a self-deployed model on RunPod/Lambda/Vast, which becomes a normal `eu-zdr`/`us` row once running).

### 4c. Mount the backend the frontend already calls

Port `reference/server-routes/portal-providers.js` → a live `src/portal-providers.js` router, mounted in `src/portal-compat.js` (and reachable via the OAuth-HTTP surface for remote). Routes the UI already expects:

```
GET    /portal/providers                 → providers.list (no secret material)
POST   /portal/providers                 → providers.create  (provider,label,api_key→secret,base_url,model)
PUT    /portal/providers/:id             → providers.update / setActive
DELETE /portal/providers/:id             → providers.remove
POST   /portal/providers/:id/test        → connectivity probe (1-token completion; returns ok|error category)
```

**Drop** `/portal/auth/claude*` (ToS) from the live port; keep OpenAI/custom **API-key** entry only. The `SettingsView.svelte` "Connect Claude (OAuth)" branch becomes "Paste Anthropic API key."

### 4d. Fix landmine #1 — credential encryption (blocking)

Two acceptable shapes; **recommend (i)** for minimal surface:

- **(i)** Add `ai_providers: ['credentials']` to `ENCRYPTED_FIELDS` (`src/crypto/crypto-local.js`) so the existing auto-encrypt/decrypt covers it. One line + a `verify:leak`-style test proving the on-disk column is ciphertext. (This matches the canonical repo, where `db-d1.js` *did* encrypt it — the V1 port simply dropped the entry.)
- **(ii)** Store key material in the **`secrets`** table (already encrypted, system-key family, audited) and keep `ai_providers` for non-secret metadata + a `secret_ref`. Stronger (audit + scope), more plumbing.

Either way: **no provider key is ever written until encryption is proven** (fail-closed), and `GET /portal/providers` returns **metadata only, never the key** (mirror the `secrets` "metadata-only read" rule).

### 4e. Fix landmine #2 — egress consent + audit (the boundary)

Adding more outbound providers multiplies plaintext egress. Wire the **dormant `egress-audit`** at the single cloud seam:

- In `cloudInfer` (or the resolver wrapper), call `recordEgress({ provenance:'inference', provider, model, content_hash, content_length, decision })` — **hash + length only**, never the prompt (`src/db/egress-audit.js` already enforces this).
- A per-provider **consent flag** (`ai_providers.status` or a `consented_at`): the first time a provider would receive plaintext, the user has explicitly added+activated it — that *is* the consent. Local Ollama needs none (on-box).
- **Zero-config fallback stays local** (§4g): `getActive` returning nothing → router runs on-box Ollama (needs no key), so a fresh vault works offline. Cloud egress is opt-in + **audited** + **jurisdiction-gated** (§4g). This preserves the §1-§4 posture.

### 4f. Node client library choice

Keep the **hand-rolled `fetch` adapters** (current `cloud.js`/`local.js`) for V1 — zero new dependency, full control of the egress seam, already leak-safe. Reassess **Vercel AI SDK** only if/when we need streaming + unified tool-calling across providers for an in-app agent (a later "Mycelium calls models *with* tools" feature). Document the tripwire so we don't reach for a dep prematurely.

**On LiteLLM (the local-LLM research's recommended "glue") — optional upstream, never a required middlebox.** That research puts LiteLLM as *the* gateway between agents and providers. We deliberately don't embed it, for one reason: **the egress boundary must be our code.** §4e (audit) + §4g (jurisdiction + `sensitive` hard-block) are *security controls* — if LiteLLM owned routing they'd live in its config and we'd lose the single seam that enforces "sensitive never leaves to a US provider." Mycelium's in-process South router *is* the LiteLLM-equivalent for our curated, jurisdiction-tagged scope (and LiteLLM is Python-only — a sidecar proxy). We don't fight it, though: a power user already running LiteLLM points Mycelium at it as **one `custom` provider** (`base_url: http://localhost:4000`) — they keep its 140-provider reach; we still audit + gate at our own seam (we just see one base_url). The mirror image is the deferred §5.2 item — Mycelium *becoming* the OpenAI-compatible gateway for the user's *harnesses* — so in the BYO-agent story **Mycelium is the gateway, not LiteLLM.** Same logic for Open WebUI / AnythingLLM (they're chat/RAG UIs): Mycelium *is* the UI + vault, so we reuse the converged runtime (Ollama) + our on-box embeddings and skip the UI layer.

### 4g. Routing policy & jurisdiction (operator decision, 2026-06-04)

The operator set the default routing priority, and it deliberately **inverts the codebase's shipped "local-first"** default — because local models aren't yet good enough to be primary on typical hardware (M1/16 GB ≠ Sonnet-class for ~2-3 yrs, per the compute-landscape research), while EU-sovereign ZDR gives capability *with* privacy.

**Default cascade (when a capable model is needed):** `EU-sovereign ZDR → frontier (Anthropic / OpenAI / Google) → local (test tier)`.

- **Each provider row carries a `jurisdiction` tag** (`local | eu-zdr | us-zdr | us-standard`), shown in the UI. The router prefers the lowest-exposure tier that can do the task: EU-sovereign first; frontier only for what EU-sovereign can't handle (and because those three double as North MCP clients, §4b); local as the opt-in test path.
- **Sensitivity is a hard boundary, not a knob (fail-closed default).** Content carrying the existing `sensitive` flag is **never sent to a `us-*` provider** — only `eu-zdr` or `local`. Enforced at the egress seam (§4e) alongside `recordEgress`; a blocked send **fails closed** (drops to local, or returns "can't fulfil this privately" — never silently egresses). *(Operator may relax to advisory later; default is hard-block.)*
- **Zero-config fallback stays local.** No provider configured → the router still runs on-box Ollama (no key needed). So "local-first" survives as the *fallback floor*; "EU-sovereign-first" is the *configured preference*.
- **Tracks cost/quality too.** The cascade also happens to map quality-per-privacy: EU-ZDR as the ~80% workhorse, frontier for the hard ~20%, local for the experimental edge — the same shape as the legacy cost-router intent (CLAUDE.md "Note on the cost router"); fold per-user budget in when that lands.

Net: §4e and §4g are the two halves of the egress boundary — **§4e records every egress; §4g decides whether it's allowed at all.** A new `jurisdiction` column on `ai_providers` (or a static per-preset map) + the sensitivity check is ~40 LOC at the resolver/seam; add `verify:routing` (asserts a `sensitive` payload + a `us` provider → blocked).

### 4h. Local tier + hardware-aware model recommender ("Cookbook")

Two halves: connecting local runtimes (easy) and **telling the user which model to run — the valuable part.** A native equivalent of Odysseus's Cookbook, tied to our routing + vault.

**Connecting local runtimes.** Ollama is already wired (`src/inference/local.js`, native `/api/generate`, vision via `images`). LM Studio / llama.cpp-server / vLLM / Rapid-MLX all speak OpenAI-compatible → just the §4b adapter + a loopback `base_url`. Presets: `ollama` (loopback, jurisdiction `local`, no key) + `local-openai` (LM Studio/vLLM). Embeddings stay on the existing on-box Nomic service (:8091) — the recommender covers **chat/generation** models only, never re-picks the embedder.

**The recommender:**
1. **`detectHardware()` → `{ platform, arch, chip, ramGB, gpuVramGB|null, freeDiskGB }`.** Floor via Node `os` (`totalmem`/`cpus`/`arch`/`platform`); Apple-Silicon detail via `sysctl` (`hw.memsize`, `machdep.cpu.brand_string`, `hw.model` — unified memory = the usable budget); discrete NVIDIA via `nvidia-smi` when present. Best home is the **Tauri Rust side** (`sysinfo` crate; we already ship the desktop app) exposing a command, with a Node fallback for headless/CLI. Hardware facts are non-secret → free to cross loopback. *(Verified greenfield: no `totalmem`/`sysctl`/`sysinfo`/model-catalog code exists anywhere in the repo today.)*
2. **Static, dated `models-catalog.json`** (data, not code): ~12-15 curated entries `{ id, runtime, pull, params, quant, minRamGB, contextK, role: general|coding|vision, notes }`, seeded from the compute research (Gemma 4 E4B @ ~12.5 GB = the 16 GB general pick; Phi-4-mini @ ~4.2 GB = the 8 GB pick; Qwen2.5-Coder-14B = coding; Llama 3.3 8B). 🚩 **Staleness is the real risk** (models churn monthly) → catalog ships **in-repo, dated, refreshed per release**, never phones home (air-gap-safe); if a `pull` id 404s on Ollama's registry, fall back to a known-good default. Later: read Ollama `/api/tags` to surface already-pulled models.
3. **`recommendModels(hw, catalog, { reserveGB })`** — best fit per role under a **headroom budget**: usable = `ramGB − reserve` (OS + vault process + the ~1-2 GB embed service), so a 16 GB Mac gets a model that fits *alongside* Mycelium, not one that eats all 16 GB. Returns a ranked shortlist + the fit reason (*"Gemma 4 E4B — fits your 16 GB with the vault + embedder running"*).
4. **One-click adopt** — "Download & use" → `ollama pull <id>` (stream progress) → auto-create the `ai_providers` row (`ollama`, loopback `base_url`, model, jurisdiction `local`). Wires straight into §4g (local = test tier + the `sensitive`-safe path).

**Where:** the onboarding "Connect your AI" step (§3d) + Settings → AI Providers → "Run a local model." *"We detected an M2 / 16 GB → recommended **Gemma 4 E4B**. [Download & use]."* Turns "which model?" paralysis into one click.

**LOC ~310** (detect ~60 Rust+Node · catalog data · recommend ~50 · pull+register ~80 · UI ~120, mostly exists). New phase **S6** (after S1; can land with S3). *Smoke:* on this machine `detectHardware` returns sane RAM; `recommendModels` picks a model with `minRamGB ≤ usable`; adopt creates a `local`-jurisdiction provider row.

---

## Part 5 — Bring your own agent harness

No per-harness code. The harness is just an MCP client (North) and optionally a South consumer:

1. **Harness ← Mycelium (context):** opencode / odysseus / openclaw / Goose / Cline all consume MCP. The user adds Mycelium's stdio command (local) or remote URL+token (3a/3b) to the harness's MCP config. They get `getContext`/`searchMindscape`/`captureMessage`/`remember` — the vault becomes the harness's long-term memory. **This is the whole integration.**
2. **Harness → Mycelium gateway (optional):** if a harness can point its model base-URL at an OpenAI-compatible endpoint, Mycelium *could* later expose `POST /v1/chat/completions` that fronts the South router (local-first + audited egress). **Deferred** — it turns Mycelium into an LLM gateway (LiteLLM-shaped) and needs the streaming/tool surface in 4f. Flagged, not built.
3. **Per-agent identity/keys:** the `agents/` UI + `ai_provider_assignments` table are the seed for "harness X uses provider Y, scope Z." Real multi-agent scoping is **deferred** (Part 1f) — V1 is single-scope. When it lands, the harness gets its own bearer + scope, and `assignments` drives routing.

---

## Part 6 — Threat model & security decisions

**New attack surface from this work, and the call on each:**

| Surface | Risk | Decision |
|---|---|---|
| More cloud egress paths (4b) | Plaintext to more 3rd parties | Local-first default; **opt-in per provider = consent**; **audited** (4e); EU-zero-retention presets surfaced first |
| Provider keys at rest (4d) | 🚩 plaintext keys today | **Blocking fix**: encrypt before any write; metadata-only reads |
| Static bearer (3b) | Token theft = vault read | Opt-in only; behind tunnel/relay; document rotation; never a default |
| `0.0.0.0` HTTP bind (1a) | Accidental world-open `--http` | Add `MYCELIUM_HTTP_HOST` default `127.0.0.1`; explicit opt-in to expose |
| Remote relay (3a-D) | MITM via rogue managed-domain cert | CT monitoring + CAA + own-domain escape hatch (per research corpus) — relay workstream, not this PR |
| Claude-subscription OAuth (2c) | Account ban (ToS) | **Remove the path**; BYOK API key only |
| Untrusted MCP *client* reading vault (North) | Over-broad context return | `getContext` already excludes `sensitive`; auth the caller; least-context tools |

**Invariants preserved (CLAUDE.md §1-§4, §7):** zero plaintext in logs/errors (the inference errors already redact — `errors.js`); fail-closed (no key → local, not open); master-key discipline unchanged; embeddings provider stays on-box. **Net new guarantee:** cloud egress becomes *auditable* (it isn't today).

---

## Part 7 — Module shape & LOC budget

| Unit | File(s) | LOC (±20%) | New dep? |
|---|---|---|---|
| Encrypt provider creds (landmine #1) | `src/crypto/crypto-local.js` (+1 entry) + `scripts/verify-providers-leak.mjs` | 60 | no |
| Providers backend router (port) | `src/portal-providers.js` + mount in `src/portal-compat.js` | 260 | no |
| Connectivity test | in the router (1-token completion probe) | 60 | no |
| Resolver: creds → router | `src/inference/resolve.js` + caller edit (`describe-chronicles.js`) | 90 | no |
| OpenAI-compatible adapter (widen) | `src/inference/cloud.js` refactor + presets data | 120 | no |
| Egress audit at cloud seam | `cloudInfer` + `src/db/egress-audit.js` caller | 50 | no |
| Static bearer + host bind (North) | `src/server-http.js` | 60 | no |
| Server `instructions` preamble | `src/mcp.js` | 20 | no |
| Frontend reconcile (Claude-OAuth→key; wire tests) | `portal-app/.../SettingsView.svelte` | 120 | no |
| Onboarding "connect Mycelium to your AI" | `OnboardingGuide.svelte` + `docs/CONNECT-YOUR-AI.md` | 120 (mostly docs) | no |
| **Total V1 AI-interface MVP** | | **~1,020** | **none** |

Relay (3a-D) and the OpenAI-compatible *server* endpoint (5.2) are **out of this budget** (separate workstreams).

---

## Part 8 — Implementation order (each step shippable + smoke)

1. **S0 — Encrypt provider credentials** (landmine #1). Add `ai_providers` to `ENCRYPTED_FIELDS`; `verify:providers-leak` proves on-disk ciphertext. *Smoke:* write a fake key, `sqlite3` the column, assert non-plaintext. **Blocks everything that writes a key.**
2. **S1 — Providers backend** (4c). Port the router, mount in `portal-compat`, wire the existing UI; `/test` probes connectivity. *Smoke:* add an OpenAI key in Settings → `GET /portal/providers` shows it active → `/test` returns ok. Drop Claude-OAuth branch.
3. **S2 — Wire router to creds** (4a). Resolver; `describe-chronicles` reads DB-first. *Smoke:* with a key set, a `narrate` task hits cloud; with none, stays Ollama (existing `verify:inference`).
4. **S3 — Widen providers + egress audit** (4b,4e). OpenAI-compatible adapter + presets; `recordEgress` at the seam. *Smoke:* a `custom` Regolo/Ollama-remote base_url completes; an audit row appears (hash only).
5. **S4 — North ergonomics** (3a fix, 3b, 3c). `MYCELIUM_HTTP_HOST`; opt-in static bearer; server `instructions`. *Smoke:* `--http` binds loopback by default; a `curl` with the bearer reaches `/mcp`; `initialize` returns the preamble.
6. **S5 — Onboarding + docs** (3d, 4c UI). "Connect Mycelium to your AI" panel + `docs/CONNECT-YOUR-AI.md` (stdio + remote per client). *Smoke:* follow the doc to attach Mycelium to a second MCP client end-to-end.
7. **S6 — Local tier + hardware-aware recommender** (4h). `detectHardware` (Tauri Rust + Node fallback) + dated `models-catalog.json` + `recommendModels` + one-click `ollama pull`→provider row. *Smoke:* on this machine it detects RAM and recommends a model that fits the headroom budget, then registers it as a `local` provider. (After S1; can land with S3.)

S0→S3 = South (Mycelium calls models); S4→S5 = North (models call Mycelium); S6 = the local-tier UX. Ship South first.

---

## Part 9 — Test strategy

| Test | Asserts |
|---|---|
| `verify:providers-leak` (new) | `ai_providers.credentials` is ciphertext on disk; `GET /portal/providers` never returns key material |
| `verify:providers` (new) | CRUD + `setActive` one-active-per-type + `/test` ok/err categories (mock fetch) |
| `verify:inference` (extend) | resolver picks DB provider over env; no-provider → local; cloud-fail → local fallback (existing) |
| `verify:egress-audit` (new) | `recordEgress` writes hash+length, **never** the prompt; one row per cloud call |
| `verify:mcp` (extend) | `initialize` returns the `instructions` preamble; static-bearer path accepts/refuses correctly |
| `verify:oauth` (existing) | unchanged — OAuth path still GO |
| leak sweep (`verify:leak`) | no provider key / prompt in any error string |

All wire into the `npm run verify` chain (`package.json:37`).

---

## Part 10 — Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Provider key written before encryption lands | med | **critical** | S0 first; fail-closed write guarded by the leak test |
| Frontend expects routes/shapes that drift from the port | med | med | Port the reference router verbatim; reconcile `SettingsView` call sites in S1; `/pre-deletion-caller-audit` on the Claude-OAuth removal |
| Cloud egress without consent/audit | low (post-S3) | high | Opt-in provider = consent; `recordEgress`; local-first default |
| `--http` accidentally world-open | med | high | `MYCELIUM_HTTP_HOST` default loopback (S4) |
| Relay MITM (managed domain) | low | high | Deferred to relay workstream; CT + CAA + own-domain |
| Copilot Studio / Perplexity incompatibility | low | low | Static bearer for 2.0-only; document Perplexity as unsupported |
| Reaching for a heavy LLM-SDK dep early | med | med | Hand-rolled `fetch` adapters for V1; documented tripwire (4f) |

---

## Part 11 — Open questions

**Resolved during sweep (would have bitten):**
- *"Build provider management from scratch?"* → **No** — frontend + reference backend + table all exist; it's wire-and-extend (Part 1b).
- *"Use the Claude subscription via Claude Code OAuth?"* → **No** — ToS-banned 2026-02-19 (2c). BYOK only.
- *"Is the credentials column encrypted?"* → **No** — absent from `ENCRYPTED_FIELDS`; blocking fix (4d).
- *"Do we need new MCP-protocol work for non-Claude clients?"* → **No** — transport is already generic + spec-compliant (1a, 2a).
- *"Route everything through LiteLLM?"* → **No** — Python-only sidecar; keep Node `fetch` adapters (2c, 4f).

**Deferred (named so they don't ambush a later phase):**
- TLS-passthrough relay as the sovereign public path (operate-it infrastructure; research done).
- Mycelium-as-OpenAI-gateway (`POST /v1/chat/completions` fronting the South router) — turns us into a LiteLLM-shaped gateway; needs streaming/tools.
- Real multi-agent + per-agent provider routing (`assignments` reconciler; multi-scope).
- Messaging connectors (Telegram/Discord/…) and Apple Health auto-sync — separate ingestion workstream (Part 1c).

**Operator forks (need a human call before/within implementation):**
- **Remote reachability for V1:** Tailscale-now vs. operate the relay vs. stdio-only-for-now (Part 3a).
- **Credential storage shape:** encrypt-in-place (i) vs. route through `secrets` table (ii) (Part 4d).
- **Audience:** is this for *you* (one operator) or a shippable product feature (changes onboarding polish + the static-bearer/relay tradeoffs)?

---

## Verification table

Every load-bearing assumption, verified by **reading the cited code myself** (not just a sweep's paraphrase):

| Assumption | Verified at |
|---|---|
| MCP server is generic, no Claude-specific runtime branching | `src/mcp.js:193-233` (read); `src/server-http.js:1-191` (read) |
| HTTP transport = per-session StreamableHTTP + better-auth OAuth 2.1 (DCR, PKCE, RFC 9728) | `src/server-http.js:62-167` (read) |
| 🚩 `--http` binds `0.0.0.0` (no host arg) | `src/server-http.js:278` (read) |
| Inference router reads env only; one live caller; cloud = Anthropic+OpenAI hardcoded | `src/inference/router.js:39-126` (read), `cloud.js:19-127` (read); caller `pipeline/describe-chronicles.js:166` (sweep) |
| `ai_providers` table shape (base_url, auth_type, config_dir, is_active) | `src/db/providers.js:17-111` (read); `migrations/0001_init.sql:119-134` (sweep) |
| Router ↔ table are disconnected (no `getActive` in `src/inference/`) | grep `src/inference/` → 0 matches (own grep) |
| 🚩 `ai_providers` absent from `ENCRYPTED_FIELDS`; encrypted `secrets` table exists | `src/crypto/crypto-local.js:214-472` (own grep of the table list — `secrets`,`user_identities`,`provisioning_jobs` present; `ai_providers` absent) |
| Frontend provider UI exists; live backend routes don't | `portal-app/.../SettingsView.svelte` + `OnboardingGuide.svelte` (own grep); `src/portal-compat.js:38-255` route list, no `/providers` (own grep); `src/` `providers` only in `cloud.js`+`db/providers.js` (own grep) |
| Backend port-source exists in reference | `reference/server-routes/portal-providers.js`, `portal-auth-claude.js`, `portal-auth-openai.js` (own glob) |
| Capture choke-point + id-dedup; Claude/ChatGPT parsers live, Obsidian/LinkedIn not | `src/ingest/capture.js:61` (sweep); `src/ingest/import-parsers.js:62-109` (sweep) |
| Egress-audit is hash-only + has no V1 callers; cloud egress unaudited | `src/db/egress-audit.js:1-17,124-130` (sweep); grep around `cloud.js` → no audit call (sweep) |
| Single agent / single scope in V1; assignments unused | `src/mcp.js:35,55,95` (read); `src/db/assignments.js` no callers (sweep) |
| No tunnel/relay code (doc-only); Tauri = local WebView, no net port; `private:true` | sweep E (grep tree); `package.json:4` (read) |
| MCP auth spec: HTTP auth = SHOULD; RFC 9728 MUST; no static-token profile | research 2 (modelcontextprotocol.io 2025-06-18 / 2025-11-25) |
| Claude-subscription OAuth = ToS violation (2026-02-19) | research 2 (Anthropic Consumer Terms; The Register, Gigazine) |
| opencode/odysseus/openclaw are real OSS MCP-client, BYO-model harnesses | research 1 (sst/opencode, pewdiepie-archdaemon/odysseus, openclaw/openclaw) |

---

## Revision history

- **v1 (2026-06-04)** — initial design. **Pivot during sweep:** the working assumption was "build a provider-management interface from scratch." Three cycles + own-eyes verification showed (a) the inbound MCP transport is *already* generic and spec-compliant, (b) the provider **frontend + reference backend + DB table all exist** and just need wiring, and (c) two pre-existing landmines (plaintext credentials; ToS-banned Claude-OAuth path) must be fixed first. Reframed from "build" to **"wire two existing-but-disconnected membranes, fix two landmines, widen via OpenAI-compatible base_url."**
