# Design — Mycelium Relay + Mycelium-as-Gateway

**Date:** 2026-06-04
**Status:** Design (sweep-first: 3 sweeps + own-eyes verification). **No code yet — build after this is accepted.**
**Companion to** [`DESIGN-ai-interface-layer-2026-06-04.md`](DESIGN-ai-interface-layer-2026-06-04.md): this **promotes** that doc's §3a *reachability option D (relay)* and its deferred *§5.2 gateway* to full designs.
**Scope:** (A) the **Relay** — remote reachability so cloud MCP clients reach a vault on the user's Mac with TLS terminating *on the Mac*; (B) **Mycelium-as-Gateway** — an OpenAI-compatible `/v1/chat/completions` fronting the South router so the user's own agent harnesses route model calls through Mycelium.

---

## TL;DR

- **The relay is mostly infrastructure, not app code.** The OAuth server already derives every URL from `baseURL` (`src/auth.js:30-31`), so **setting `MYCELIUM_BASE_URL=https://<handle>.mycelium.id` makes OAuth work behind the relay with zero code change.** The repo work is a ~6-line bind fix + a CT-monitor + config templates + a runbook. The relay VPS + Caddy + tunnel are ops.
- **TLS terminates on the Mac, never on the relay.** The relay does **SNI passthrough** (dumb encrypted pipe). **Caddy on the Mac** holds the cert (ACME DNS-01, key born local) and **path-routes** the one subdomain to the two existing local servers: `/{mcp,v1,.well-known,api/auth}` → `:4711` (authed), `/{p,s}` → `:8788` (public docs). The `<handle>.mycelium.id` subdomain **already exists** for publishing (`src/tools/documents.js:531`) — the relay just unifies both surfaces under it.
- **The gateway turns Mycelium into the user's private LLM gateway.** `POST /v1/chat/completions` on `:4711` (Bearer-guarded, relay-reachable) maps OpenAI requests → the South router (§4g cascade: EU-sovereign → frontier → local) → audited egress. A harness (opencode/Codex/Goose) then points **both** its MCP server **and** its model base-URL at `https://<handle>.mycelium.id` — memory *and* inference through one sovereign endpoint.
- **Gateway v1 is non-streaming** (the router is single-shot; no SSE exists in the repo). `stream:true` is emulated as a single terminal chunk for client compatibility; true token-streaming is a documented fast-follow.

---

## Architecture (the whole picture)

```
                                       INTERNET
  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐
  │ Claude.ai /  │  │  ChatGPT /   │  │  Gemini /    │  │ YOUR HARNESS          │
  │ Claude Desk  │  │  Responses   │  │  Copilot     │  │ opencode/Codex/Goose  │
  │ (MCP client) │  │  (MCP client)│  │  (MCP client)│  │ (MCP client + /v1)    │
  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └────┬────────────┬─────┘
         │ MCP/HTTPS        │ MCP/HTTPS       │ MCP/HTTPS      │ MCP(memory)│ /v1(model)
         └──────────────────┴────────┬────────┴────────────────┴───────────┘
                                      ▼  https://<handle>.mycelium.id  (TLS)
                        ┌─────────────────────────────────┐
                        │      MYCELIUM RELAY (VPS)        │  SNI passthrough only:
                        │  routes <handle>.mycelium.id     │  sees encrypted bytes,
                        │  by SNI → the user's Mac.        │  NEVER the TLS key,
                        │  NEVER terminates TLS.           │  NEVER plaintext.
                        └─────────────────┬───────────────┘
                          reverse tunnel (FRP/rathole, token-auth; Mac dials out — no port-forward)
                                          ▼
 ┌──────────────────────────── USER'S MAC = THE VAULT ───────────────────────────────────┐
 │  ┌──────────────────────────────────────────────────────────────────────────────┐    │
 │  │ Caddy :443  — TLS TERMINATES HERE (ACME DNS-01; private key born on the Mac)    │    │
 │  │   path-routes one host <handle>.mycelium.id:                                    │    │
 │  │     /mcp  /v1  /.well-known/*  /api/auth/*  ─► 127.0.0.1:4711                    │    │
 │  │     /p/*  /s/*                              ─► 127.0.0.1:8788                    │    │
 │  └───────────────┬───────────────────────────────────────────┬────────────────────┘    │
 │                  ▼ 127.0.0.1:4711 (Bearer/OAuth 2.1)          ▼ 127.0.0.1:8788           │
 │  ┌───────────────────────────────────────────────┐   ┌──────────────────────────┐      │
 │  │ Node --http  (one boot(), Bearer-guarded)       │   │ public publish server    │      │
 │  │  • /mcp                → 27 MCP tools  (NORTH)   │   │  /p /s  published docs   │      │
 │  │  • /v1/chat/completions → GATEWAY      (SOUTH-out)   │  (fail-closed, no auth)  │      │
 │  └───────┬───────────────────────────┬─────────────┘   └──────────────────────────┘      │
 │   getContext/search/remember          │ messages[]→prompt→router                          │
 │          ▼ (the context bank)         ▼                                                   │
 │  ┌────────────────────┐   ┌──────────────────────────────────────────────────────────┐  │
 │  │ encrypted SQLite    │   │ SOUTH ROUTER  + §4e egress-audit + §4g jurisdiction gate  │  │
 │  │ vault (your context)│   │   EU-sovereign ZDR ─► frontier ─► local(test)            │  │
 │  └────────────────────┘   │   (Regolo/Scaleway) (Claude/GPT/Gemini) (Ollama)         │  │
 │                            └──────────────────────────────────────────────────────────┘  │
 └────────────────────────────────────────────────────────────────────────────────────────┘
```

```mermaid
flowchart TB
  subgraph NET[Internet]
    C1[Claude.ai / Desktop]:::mcp
    C2[ChatGPT / Responses]:::mcp
    C3[Gemini / Copilot]:::mcp
    H[Your harness<br/>opencode/Codex/Goose]:::mcp
  end
  R[[MYCELIUM RELAY VPS<br/>SNI passthrough — never sees TLS key or plaintext]]:::relay
  C1 & C2 & C3 -->|MCP/HTTPS| R
  H -->|MCP memory + /v1 model| R
  R -->|reverse tunnel<br/>token-auth| CADDY
  subgraph MAC[User's Mac = the vault]
    CADDY[Caddy :443<br/>TLS terminates here · ACME DNS-01<br/>path-routes one host]:::tls
    NODE[Node --http :4711 · Bearer/OAuth 2.1<br/>/mcp = 27 tools NORTH<br/>/v1/chat/completions = GATEWAY]:::node
    PUB[Public publish :8788<br/>/p /s docs]:::node
    VAULT[(encrypted SQLite vault)]:::data
    ROUTER[South router + §4e audit + §4g gate<br/>EU-sovereign ▶ frontier ▶ local]:::router
    CADDY -->|/mcp /v1 /.well-known /api/auth| NODE
    CADDY -->|/p /s| PUB
    NODE --> VAULT
    NODE -->|messages→prompt| ROUTER
  end
  classDef mcp fill:#1f2937,color:#fff; classDef relay fill:#7c3aed,color:#fff;
  classDef tls fill:#b45309,color:#fff; classDef node fill:#065f46,color:#fff;
  classDef router fill:#0e7490,color:#fff; classDef data fill:#374151,color:#fff;
```

---

## Part A — The Mycelium Relay (remote reachability)

### A.1 Why a relay, and why TLS-passthrough (the decision)

Cloud MCP clients (Claude.ai web connectors, ChatGPT, Gemini) need a **public HTTPS URL**; a Mac behind NAT can't offer one directly. The options were weighed in the companion doc §3a. The operator chose the **relay** over Tailscale/Cloudflare-Tunnel because:

- **Tailscale** only reaches *your own* devices — it can't expose the vault to a third-party cloud client (ChatGPT can't join your tailnet). Good for personal remote, not for "connect Mycelium to ChatGPT."
- **Cloudflare Tunnel terminates TLS at Cloudflare's edge** → a third party sees plaintext, which contradicts the vault's core promise (companion §3a, and the relay research corpus 2026-06-02).
- **TLS-passthrough relay** keeps plaintext exclusively on the Mac: the relay routes by **SNI** and forwards encrypted bytes; the **TLS private key is born on the Mac and never leaves**. This is the civilian "HAIPE" pattern — encrypt at the boundary, the pipe is dumb.

### A.2 How it integrates with what's built (the load-bearing findings)

| Need | Reality found | Work |
|---|---|---|
| OAuth advertises the **public** URL (discovery, `WWW-Authenticate`, `resource`, `trustedOrigins`) | **All derive from `baseURL`** (`auth.js:48,53,57`; `server-http.js:96-97,104`), and `baseURL = MYCELIUM_BASE_URL \|\| 'http://localhost:4711'` (`auth.js:30-31`) | **Set `MYCELIUM_BASE_URL=https://<handle>.mycelium.id`.** Zero code change. |
| Per-user subdomain | `<handle>.mycelium.id` **already used for publishing** (`documents.js:531`); handle is user-chosen, validated, persisted (`users.handle`, `user_profiles.handle`), env-overridable (`MYCELIUM_HANDLE`) | Reuse it. The relay routes this host by SNI. |
| One domain, two local servers | `:4711` (authed MCP+gateway) and `:8788` (public `/p`,`/s` — `public-server.js:106,120`) are **separate listeners** | **Caddy on the Mac path-routes** the single host to both. |
| Don't expose Node to the world | `server-http.js:278` `app.listen(port)` binds **`0.0.0.0`** (no host arg) | Add **`MYCELIUM_HTTP_HOST` (default `127.0.0.1`)**; Caddy is the only thing that talks to it. (≈6 LOC; already noted companion §1a.) |
| TLS / ACME / cert | **None in the repo** (verified) | Net-new: Caddy config (ACME DNS-01) on the Mac. Config, not app code. |

### A.3 Components

- **Relay VPS (we operate):** a tiny SNI router (e.g. a few lines of Caddy `layer4`, or `sniproxy`/a small Go proxy). Stateless — any relay can replace any other; future HA is DNS failover. Sees source IP + SNI + byte volume + timing only (metadata) — publish a retention policy.
- **Reverse tunnel (Mac → relay):** the Mac dials *out* (no port-forwarding/NAT config), authenticated with a per-Mac token (FRP `token`, or rathole mTLS), provisioned at onboarding. The relay accepts the encrypted stream for `<handle>.mycelium.id` only from the tunnel that authenticated for that handle.
- **Caddy on the Mac:** ACME DNS-01 (so the cert issues without inbound :80), private key on disk on the Mac; path-routes to `:4711`/`:8788`; auto-renews.
- **CT monitor (repo, small):** polls crt.sh / a CT API for `<handle>.mycelium.id`; alerts the operator if a cert it didn't request appears (the managed-domain rogue-cert mitigation). Plus set **CAA** records on `mycelium.id` (Let's Encrypt-only) and document the **own-domain escape hatch** for users who want Mycelium cryptographically excluded.

### A.4 Repo-side work (small)
- `MYCELIUM_HTTP_HOST` bind fix (`server-http.js`, `index.js`) — default loopback; explicit opt-in to expose. ~6 LOC.
- Thread `MYCELIUM_BASE_URL` through boot + surface it in the relay onboarding. ~10 LOC.
- `scripts/ct-monitor.mjs` — CT poll + alert (launchd/cron). ~80 LOC.
- `Caddyfile.template` + `frpc.toml.template` + `docs/RELAY-SETUP.md` runbook (own-domain variant included). Config + docs.
- Relay VPS provisioning is **operated infra**, out of the repo's LOC budget.

---

## Part B — Mycelium-as-Gateway

### B.1 The surface

A new, **Bearer-guarded** route on the existing `:4711` app (so it's reachable through the same relay + auth as `/mcp`):

```
POST /v1/chat/completions   (OpenAI-compatible)   → reuses requireAuth() (server-http.js:197)
GET  /v1/models             list configured providers as model ids
```

Mounted exactly like the ingest routes (`server-http.js:208`): `app.post('/v1/chat/completions', async (req,res) => { if (!await requireAuth(req,res)) return; … })`, with `ingest.db` + `ingest.userId` in scope for the provider lookup + egress audit.

### B.2 The adapter (≈120 LOC)

```js
// src/gateway/openai-compat.js
// 1. parse {model, messages[], max_tokens, stream, temperature}
// 2. flatten messages[] → a single prompt (role-tagged); system→preamble
// 3. resolve route from `model`:
//      "mycelium-auto" (default)  → §4g cascade (EU-sovereign → frontier → local)
//      "<provider-label>"          → pin to that configured ai_providers row
// 4. §4g/§4e gate: pick provider by jurisdiction; recordEgress(hash,len,provider,decision)
// 5. const text = await router.infer({ prompt, task:'complex', maxTokens })   // existing router
// 6. wrap → OpenAI ChatCompletion JSON  { choices:[{message:{role:'assistant',content:text}}], usage }
// 7. stream:true → emit ONE terminal SSE chunk (data: {delta}, data: [DONE]) — v1 compat shim
```

The router (`router.js:39-124`) and adapters (`cloud.js`/`local.js`, single-shot) are reused **unchanged**; the gateway is a thin translation layer + the egress gate.

### B.3 Why this is the payoff

A user's harness now points at **one sovereign endpoint** for both halves:
- **MCP** (memory): `https://<handle>.mycelium.id/mcp` → `getContext`/`search`/`remember`.
- **Model** (`/v1`): set the harness's OpenAI base-URL to `https://<handle>.mycelium.id/v1` → every model call is local-first/EU-sovereign, **audited**, jurisdiction-gated — without the harness needing any provider keys of its own. opencode (`options.baseURL`), Codex (`openai_base_url`), Goose, Cline, Continue, OpenHands (`LLM_BASE_URL`) all support this (companion research §6).

This is also the answer to "*don't embed LiteLLM*" (companion §4f): **Mycelium *is* the gateway.**

### B.4 Edge cases — explicit decisions
- **Streaming:** v1 non-streaming; `stream:true` → single terminal chunk (compat). True streaming needs router+adapter streaming support → fast-follow, tracked.
- **Tool-calling:** the router has no tool support → the gateway **drops `tools`/`tool_choice`** in v1 and documents it (the harness does its *own* tool loop; it only needs raw completions from us). Fast-follow if demanded.
- **`sensitive` hard-block (§4g) on the gateway:** **cannot** be enforced — gateway input is opaque harness text with no vault flag. The gateway gates by **configured jurisdiction + per-provider consent + audit**, not content classification. Documented limitation; the `sensitive` hard-block remains enforced on the North/vault side where the flag lives.
- **Not an open proxy:** Bearer-guarded; it spends the *operator's own* keys for the *operator's own* harness. For a purely-local harness, the §3b static-bearer (companion) is the low-friction token. **Never** exposed on the no-auth REST `:8787`.
- **Model routing default:** unknown/`mycelium-auto` → §4g cascade; the gateway treats all calls as cloud-capable (the harness wants a capable model), so it does **not** apply the internal "simple→local" task split (that split is for Mycelium's own enrichment).

---

## Threat model (new surface)

| Surface | Risk | Decision |
|---|---|---|
| Relay sees metadata | source IP, SNI, timing, volume | Acceptable (= any CDN/ISP); publish retention policy; own-relay option for zero-trust |
| Managed-domain rogue cert | relay operator could MITM via a cert for `<handle>.mycelium.id` | **CT monitor + CAA + own-domain escape hatch** (A.3); detectable, not silent |
| Reverse-tunnel hijack | someone claims your handle's tunnel | per-Mac token / mTLS, provisioned at onboarding; relay binds handle↔tunnel-identity |
| Gateway as open proxy | abuse of the user's provider keys / exfil | **Bearer-guard (fail-closed)**; never on no-auth :8787; it's the user's own keys |
| Gateway egress of vault data | harness pulls sensitive context via MCP, then sends it as a gateway prompt | **Honest limit:** can't classify opaque input; mitigated by jurisdiction routing + per-provider consent + **audit** (every gateway egress recorded, hash-only) |
| Node world-exposed | `:4711` binds 0.0.0.0 today | `MYCELIUM_HTTP_HOST=127.0.0.1` default; Caddy is the only client |

**Invariants preserved:** TLS plaintext only on the Mac; vault encryption-at-rest unchanged; egress audited (now incl. the gateway); fail-closed auth on both new paths.

---

## Module shape & LOC

| Unit | File(s) | LOC (±20%) |
|---|---|---|
| Bind-host fix | `src/server-http.js`, `src/index.js` | 10 |
| `MYCELIUM_BASE_URL` plumb + onboarding surface | `src/server-http.js`, portal onboarding | 20 |
| CT monitor | `scripts/ct-monitor.mjs` + launchd | 80 |
| Caddy / tunnel templates + runbook | `deploy/Caddyfile.template`, `frpc.toml.template`, `docs/RELAY-SETUP.md` | config + docs |
| Gateway route + adapter | `src/gateway/openai-compat.js`, mount in `src/server-http.js` | 150 |
| Egress audit + jurisdiction at the gateway seam | reuse §4e/§4g | 30 |
| `verify:gateway`, `verify:relay-config` | `scripts/` | 110 |
| **Repo total** | | **~400** (+ relay VPS infra, operated) |

---

## Implementation order (extends the companion's S-series)

- **S7 — Relay** (after S4's bind fix): `MYCELIUM_HTTP_HOST` default loopback; `MYCELIUM_BASE_URL` plumb; Caddyfile + tunnel templates; CT monitor; `RELAY-SETUP.md`. *Smoke:* with `MYCELIUM_BASE_URL` set, `curl https://<handle>.mycelium.id/.well-known/oauth-protected-resource` (through the relay) returns metadata advertising the public URL; `verify:oauth` still GO locally.
- **S8 — Gateway** (after S3 South widen): `/v1/chat/completions` + `/v1/models`, Bearer-guarded, adapter → router, egress-audited. *Smoke:* `curl -H "Authorization: Bearer …" …/v1/chat/completions -d '{"model":"mycelium-auto","messages":[{"role":"user","content":"hi"}]}'` returns a valid ChatCompletion; an audit row appears (hash only); `stream:true` returns a terminal chunk; point opencode's base-URL at it and complete one turn.

Order rationale: relay first (it's mostly config and unblocks *all* remote use, North + gateway); gateway second (depends on the South router wiring S2/S3).

---

## Test strategy

| Test | Asserts |
|---|---|
| `verify:relay-config` (new) | with `MYCELIUM_BASE_URL=https://x.mycelium.id`, discovery metadata + `WWW-Authenticate` advertise the public URL (not localhost); `trustedOrigins` matches |
| `verify:bind` (new/fold into existing) | default `--http` binds `127.0.0.1`; exposing requires explicit `MYCELIUM_HTTP_HOST` |
| `verify:gateway` (new) | `messages[]`→prompt mapping; OpenAI JSON envelope shape; Bearer-guard rejects no-token (401); `stream:true` terminal-chunk; **one egress-audit row per call, hash-only, never the prompt** |
| `verify:oauth` (existing) | unchanged — local OAuth still GO |
| leak sweep (`verify:leak`) | no prompt/key in any gateway error string |

---

## Open questions

**Resolved during sweep (would have bitten):**
- *"The relay needs OAuth/base-URL code changes."* → **No** — `MYCELIUM_BASE_URL` already drives every URL (`auth.js:30-31`). Relay is config + ops + a 6-line bind fix.
- *"The subdomain concept must be built."* → **No** — `<handle>.mycelium.id` already exists for publishing; the relay unifies `:4711`+`:8788` under it via Caddy path-routing.
- *"Gateway streams like OpenAI."* → **No SSE in the repo + router is single-shot** → v1 non-streaming (single-chunk shim); streaming is a fast-follow.
- *"Gateway can enforce the `sensitive` hard-block."* → **No** — opaque input has no vault flag; gate by jurisdiction + consent + audit instead.

**Deferred (named):**
- True token-streaming + tool-calling pass-through on the gateway (needs router/adapter streaming + tool plumbing).
- Relay **HA** (single relay + 60s-TTL DNS failover is enough for V1; the Mac's uptime is the real ceiling).
- `/v1/embeddings` on the gateway (the on-box Nomic service could back it) — only if a harness needs it.
- Own-relay (zero-trust) UI — power-user path; ship the managed relay + documented own-domain/own-relay escape hatch first.

---

## Verification table

Every load-bearing assumption, verified by **reading the cited code myself**:

| Assumption | Verified at |
|---|---|
| `baseURL` = `MYCELIUM_BASE_URL` else `localhost:4711`; drives `trustedOrigins`, MCP `resource` | `src/auth.js:30-31,48,53,57` (read) |
| Discovery metadata + `WWW-Authenticate` + token-validation Request all use `baseURL` | `src/server-http.js:62-69,96-97,104` (read) |
| `--http` binds `0.0.0.0` (no host arg) — needs `MYCELIUM_HTTP_HOST` | `src/server-http.js:278` (read) |
| New authed route pattern = `requireAuth()` + `app.post(...)`, `ingest.db`/`userId` in scope | `src/server-http.js:197-223` (read) |
| `<handle>.mycelium.id/p/<slug>` already the publish pattern; handle user-chosen/persisted | `src/tools/documents.js:531` (read), `public-server.js:106,120,139` (read) |
| Public server is a separate listener serving only `/p`,`/s` (fail-closed) | `src/publish/public-server.js:106,120,139` (read) |
| Router = `infer({prompt,task,maxTokens})→Promise<string>`, prompt-only, no tools | `src/inference/router.js:39-124` (read) |
| Cloud + local adapters are single-shot (`stream:false`, `res.text()`) | `src/inference/local.js:49`, `cloud.js:39-95` (read) |
| No SSE/streaming pattern exists in the repo to reuse | grep `text/event-stream`/`res.write`/`flushHeaders` → 0 (own grep) |
| Egress-audit is hash+length only, no V1 callers | `src/db/egress-audit.js:1-17,124-130` (sweep, cross-checked companion doc) |
| No TLS/ACME/cert/tunnel code exists today | sweep 2 (grep tree) + `package.json` (only `http`, no `https`/acme dep) |

---

## Revision history

- **v1 (2026-06-04)** — initial relay + gateway design. **Sweep pivots:** (1) the relay needs *no* OAuth code change — `MYCELIUM_BASE_URL` already drives discovery, so the relay collapses to config + a 6-line bind fix; (2) `<handle>.mycelium.id` already exists for publishing, so the relay **unifies** the `:4711` and `:8788` surfaces via Caddy path-routing rather than introducing a new domain scheme; (3) gateway **v1 is non-streaming** (the router is single-shot and the repo has no SSE), pivoting from the implicit "stream like OpenAI" assumption; (4) the gateway **cannot** enforce the `sensitive` hard-block on opaque harness input — documented as a jurisdiction-+-audit boundary instead.
