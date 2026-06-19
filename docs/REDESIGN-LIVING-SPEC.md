# Mycelium Redesign — Living Spec

**Status:** v0.3 — Round 1+2+3 sweeps folded in, MYA-0.2 abandonment lessons captured, 63 design docs classified, design recommendation locked. v1.0 = operator pickup list.
**Started:** 2026-05-28
**Owners:** Martin + Claude (sweep-first-design protocol)

---

## How to read this document

This is a **living spec**. It evolves as the codebase is swept and the design is pressure-tested.

Three things live here:

1. **The original May 28 spec** (Part 1) — preserved verbatim. Inline `[CORRECTION]` blocks mark places where reality contradicts the spec's claim; do not edit the original prose, only annotate.
2. **The reality inventory** (Parts 2–5) — what is actually built, with file:line citations. This is the ground truth the redesign must respect.
3. **The forward-looking design** (Parts 6–9) — what the new system will be, written *after* the reality is known. Threat model, transfer/rebuild/discard matrix, open decisions, revision history.

The spec is updated after each sweep cycle. Version bumps at the top track which round you're reading. **Do not act on a section flagged `🟡 UNVERIFIED`** — those are claims that haven't been pressure-tested yet.

---

# PART 0 — Headline

**The May 28 spec misrepresents the current system in 11+ significant directions (Round 1) and entirely misses a partial federation/public-presence stack + 5 sibling repositories (Round 2). A naive implementation would discard or regress substantial shipped infrastructure and re-invent a federation surface that's already half-built.**

**Plus: the multi-tenant RLS migration has a NEGATIVE risk delta** vs. the current cryptographic per-tenant isolation (Round 2 Sweep I, 5 HIGH severity findings). It's still feasible — but it requires re-architecting 5 core subsystems (auth middleware, connection pooling, scope enforcement, operator role, key rotation) and an audit discipline the codebase does not yet exhibit. The pragmatic path is a **tiered model**: managed-light on Postgres for new users, dedicated D1+VPS preserved for current 3 customers and high-compute users.

The redesign is still worth pursuing — multi-tenant operations have real cost, the per-VPS model genuinely doesn't scale to hundreds of users, and the BIP-39 / client-side encryption story is the right north star for the public promise. But the spec's "current state" section is wrong enough that every downstream decision (migration plan, schema design, MCP transport, agent provisioning, billing, monitoring) needs to be re-anchored on what's actually running.

The recommended path forward, in order:

1. **Correct the spec's current-state section** (this document, Part 2)
2. **Reduce launch scope to Tier 2 (2–5 hand-picked users)** — the spec itself recommends this; treat it as load-bearing
3. **Decide the **storage migration shape**: D1 → Postgres in place, or D1-stays for compute-heavy tenants while Postgres serves a new "managed-light" tier?
4. **Decide the **encryption shape**: BIP-39 client-derived keys (the public promise) requires either WebAuthn PRF on browsers that have it (Chrome/Safari recent) and a degraded fallback elsewhere, OR accepting that "client-side encryption" remains aspirational for the browser surface
5. **Reconcile the in-flight work** (60 design docs, Part 5) — most of it can ship as-is on the current D1 architecture before any redesign cutover

---

# PART 1 — Original May 28 spec (preserved, annotated inline)

## 1.1 — Current State (per May 28 spec)

> Before planning what to build, honest inventory of what's running today:
>
> **Running in production (Hetzner VPS, single-tenant):**
> - SQLite database — ~1M+ data points, 3 users
> - Telegram + Discord ingestion pipelines (Bot API, OAuth2)
> - ChatGPT/Claude export import, Obsidian/Apple Notes import
> - Whisper voice transcription
> - Nomic v1.5 384-dim embeddings
> - HDBSCAN clustering → hierarchical territory mapping
> - Co-firing computation, harmonic analysis (H0, β, γ, α)
> - Nightly topology rebuild
> - Phase transition detection
> - MCP server (Node.js, stdio transport) with full tool set
> - Agent runtime: Claude Code agents on pm2, JSON wake cycles
> - Multi-agent coordination via Discord + @mentions + delegate_to_agent
> - JWT + magic link authentication
> - TLS via Caddy + Let's Encrypt

**[CORRECTION — Round 1 sweep findings]**

| Spec line | Reality | Evidence |
|---|---|---|
| "SQLite database, single-tenant" | **Cloudflare D1 per-tenant** via Worker passthrough; operator runs `mycelium-db`, each customer gets `mycelium-tenant-<handle>` | `packages/core/db-d1.js:1-9` ("Backend: Cloudflare D1 + Vectorize via MYA Worker proxy"; "SWISS VAULT: All encryption/decryption happens HERE on the VPS. The Worker never has the master key"); `packages/worker/wrangler.toml:104-125` (two D1 bindings + tenant bindings) |
| "~1M+ data points, 3 users" | 3 customer hosts confirmed (0mm, puh, marti) + admin; volume unsubstantiated by any audit | `~/.config/mycelium-ssh/customers.yml:2-5` |
| "Nomic v1.5 384-dim embeddings" | **768D for search** + **256D matryoshka for clustering** — both from same Nomic v1.5 ONNX model, no 384D anywhere | `scripts/embed-service.py:64` (`OUTPUT_DIM = 768`); `scripts/cluster.py:76` (`NOMIC_DIM = 256` matryoshka truncation) |
| "HDBSCAN clustering" | **FAISS + Leiden** since 2026-04-02; HDBSCAN replaced | `scripts/cluster.py:86` ("FAISS + Leiden (replaced UMAP→HDBSCAN — Ada research 2026-04-02)") |
| "Phase transition detection" (built) | Deferred to PR1.5 per finalization plan | `docs/COGNITIVE-METRICS-FINALIZATION-PLAN-2026-05-08.md:100+` |
| "MCP server (Node.js, stdio transport) with full tool set" | stdio confirmed for tools, **plus loopback HTTP for search** (`/internal/v1/search/mindscape`); full tool surface is **37 tools across 13 domains**, not the 12 the spec lists | `packages/tools/agent-tools.js:54-55,358` (stdio); `packages/tools/agent-tools/search-client.js:1-38` (loopback for search only); `packages/tools/agent-tools/domains/*` (37 tool registrations) |
| "Multi-agent coordination via Discord + @mentions + delegate_to_agent" | Discord coordination is **channel-based** (not @mention-parsed); `delegate_to_agent` restricted to **4 hardcoded delegation pairs** | `packages/server/orchestrator.js:69-90,175-177`; `packages/server/agent-registry.js:59-64` |
| "JWT + magic link authentication" | True, **plus** Telegram passkey callback + Noise NK channel (code-complete, gated off) | `packages/portal/src/routes/login/+page.svelte`; `packages/portal/src/lib/secure-fetch.ts:16-52`; `packages/server/agent-server.js:1930-1932` (Noise gates) |

**Verdict on §1.1:** The current-state section is wrong enough to invalidate every downstream "what changes" claim. Re-baseline before reading the rest of the spec.

---

## 1.2 — May 27 Architecture Decision (per spec)

> The VPS-per-user model is dead. It doesn't scale, it's expensive, and it creates operational hell when you're managing 20 separate instances.
>
> **New model:** Multi-tenant PostgreSQL with Row-Level Security.

**[CORRECTION — Round 1 sweep findings]**

The VPS-per-user model **is the current model and is operationally alive**, with substantial machinery built specifically for it:

- **Customer fleet:** `~/.config/mycelium-ssh/customers.yml` (admin-vps, 0mm, puh, marti)
- **Per-customer D1:** `wrangler.toml:112-125` (`DB_TENANT_<hash>` bindings)
- **Provisioning:** `mycelium-managed/scripts/provision-customer.sh` + `onboard-tenant.sh`
- **Deletion:** `DELETION_CATALOG` with 12 entry types (D1, R2, DNS, Worker binding, KMS, Hetzner VPS, Stripe sub, Telegram webhook, Claude OAuth, operator local) — Phases 0–5 shipped, commits `dad95f5..bb8fe84`
- **Fleet ops:** `scripts/update-customers.sh`, `scripts/verify-deploy.sh` (9 checks), `scripts/sign-cert.sh` (SSH cert via 1Password), `scripts/deploy-ca-trust.sh`
- **Watchdog:** `fleet-tls-watchdog` PM2 cron, Discord webhook alerts
- **Tenant schema parity:** manual discipline (the canonical repo's `tenant-schema-parity` skill) because no automated runner yet (FLEET-MIGRATIONS-PLAN.md F2 unbuilt) — a V2 multi-tenant concern; the V1 self-hosted repo removed its carried-over copy (single-vault V1 has no fleet to drift)
- **Hardening:** Phase 2 (2026-05-06) hardened tenant routing to **fail-closed** — silent cross-tenant landing is no longer possible (`packages/worker/src/services/tenant-d1.ts:69-76`)

**This does not mean the spec's conclusion is wrong** — VPS-per-user genuinely does not scale to hundreds of users, and the cost is real. But it means:

1. The redesign cannot ignore this machinery — it must explicitly discard, migrate, or absorb each capability.
2. The "operational hell" the spec dismisses is the price the operator has paid to keep the *current* model honest; the redesign inherits the same problems at a different layer (RLS correctness becomes the new "tenant isolation discipline," cross-tenant query bugs become the new "silent leak class," etc.).
3. The decision is not "VPS-per-user or Postgres" — it's "**which tier of user gets which model**." High-compute / high-value users may stay on dedicated infra; the public managed-light tier becomes multi-tenant Postgres.

---

## 1.3 — Migration Path (per spec)

The spec proposes a 5-phase SQLite → Postgres migration over ~7 days. **This is structurally wrong** because the source is not SQLite — it is per-tenant D1 across multiple Cloudflare-hosted databases. The migration is:

- **N D1 databases** (operator + 3 customers + per-tenant for new signups) → 1 Postgres
- **D1 dialect → Postgres dialect** (most queries work, but `embedding_768` columns, FTS, generated columns need translation)
- **Worker passthrough → direct connection** (the Worker becomes obsolete for managed-tier; what happens to the per-tenant D1 of dedicated users?)
- **Per-host tmpfs master key → ?** (currently `/run/mycelium/master.key`, per-VPS; multi-tenant Postgres needs a different key isolation story)

The 7-day estimate is unrealistic for the real migration shape. Round 2 sweep will produce a corrected migration plan.

---

## 1.4 — PostgreSQL Schema (per spec, with corrections)

The spec's schema is a reasonable starting point but contains errors driven by the wrong current-state assumptions:

| Spec column | Issue |
|---|---|
| `embeddings.vector vector(384)` | Wrong dim. Should be `vector(768)` for search and `vector(256)` (or a separate column) for clustering. Two vectors per message, not one. |
| `messages.content BYTEA + content_iv + content_tag` | Reasonable, but the current encryption is **scope-partitioned** (personal/org/wealth/moms) via `crypto-local.js` — the schema should carry a `scope` field so the right subkey is used to decrypt |
| `encryption_envelopes` table with `key_version` | The current system has **two key families** (USER_MASTER + SYSTEM_KEY) with distinct HKDF prefixes — the schema needs `key_family` not just `key_version` |
| No `agent_tokens` table | Currently exists (migration 104), with per-tenant `user_id` scoping (migrations 117, 118, 131). The spec's "per-agent access tokens: not started" is wrong. |
| No `audit_log` / `egress_audit` / `provisioning_jobs` / `handle_reservations` | All exist today, all load-bearing. Must be in the new schema. |
| No mind-files representation | Mind files are encrypted on disk today (shipped 2026-05-08); the multi-tenant Postgres world either keeps them on disk per-tenant (where?) or moves them into a table — design decision pending |

---

## 1.5 — Encryption Implementation (per spec, with corrections)

The spec's key hierarchy (BIP-39 → PBKDF2 master → HKDF subkeys) is reasonable and is the public promise. **But the spec falsely implies nothing exists today.** Reality:

- Master key derivation **exists** (`packages/core/crypto-local.js:561-596`, tmpfs-resident)
- Scope-partitioned subkeys **exist** (`crypto-local.js:909-923` `PROCESS_SCOPE_MAP`; lines 925-956 `inferScope()`)
- Encrypt/decrypt chokepoint **exists** (`encrypt()` 960-1027, `decrypt()` 1069-1130, AES-256-GCM)
- Scope guardians **exist** and are enforced before key unwrap (`scopeGuardian` 86-123, `scopeEncryptGuardian` 134-169)
- Mind-files encryption **shipped** (commits `9571702`, `fdf87fb`, `a068aeb`, `4f0d8dd`, `caadd92`, 2026-05-08)
- Two-key separation (USER_MASTER + SYSTEM_KEY) **shipped** — operator can rotate one without touching the other (migrations 131-133)
- Noise NK encrypted channel **code-complete** but disabled (`packages/server/agent-server.js:1930-1932`; commits `661b623`, `e7b82d2`, `2308d5b`, `aacdf19`)

**What does NOT exist:**
- BIP-39 / mnemonic anywhere in the codebase (zero hits) — this is genuinely new for the redesign
- Trusted-session lifecycle (session keys, timeouts, audit of decryptions) — entirely new
- Client-side field encryption in the portal (Noise NK is transport-level, not at-rest field encryption)

**Implication:** The encryption story for the redesign is "**add BIP-39 mnemonic + client-derived keys + trusted-session lifecycle on top of the existing two-key architecture**," not "build encryption from scratch." This is a much smaller and safer change than the spec implies.

---

## 1.6 — MCP Interface Multi-Tenant Evolution (per spec, with corrections)

The spec proposes stdio → HTTP/SSE. Reality is more nuanced:

- **stdio transport stays the right answer for local (Claude Desktop / Code) use** — `agent-tools.js:54-55,358`
- **Loopback HTTP already exists for search** — `packages/tools/agent-tools/search-client.js:1-38` (`x-internal-secret` header at line 120-124)
- **HTTP/SSE for external multi-tenant clients is the new addition**, not a wholesale transport replacement
- **The tool set is 37 tools**, not 12 — and includes `readMindFile`/`editMindFile`/`writeMindFileWhole` (added 2026-05-08, encryption-aware mind/* file editing — built-in Read/Write/Edit see ciphertext)

**The redesign should:**
- Keep stdio for local use
- Keep loopback HTTP for search inside the agent process
- Add HTTPS+JWT endpoint for external clients (Claude Desktop reaching a hosted user's mycelium)
- Document the 37-tool surface honestly; identify any tools that don't generalize across users (e.g., `flagForDiscussion` currently routes to a hardcoded Discord channel)

---

## 1.7 — Agent System Multi-Tenant (per spec, with corrections)

The spec says "9 agents" — reality is **10–13** (`ecosystem.config.cjs`):

| Agent | Spec lists | In config | Process name |
|---|---|---|---|
| Mya (personal) | ✓ | ✓ | personal-agent (line 691) |
| Com (company) | ✓ | ✓ | company-agent (line 593) |
| Ada (research) | ✓ | ✓ | research-agent (line 196) |
| Rex (commercial) | ✓ | ✓ | commercial-intelligence-agent (line 264) |
| Noa (publishing) | ✓ | ✓ | publishing-agent (line 627) |
| Apollo (intel) | ✓ | ✓ | intel-agent (line 329) |
| Rob (wealth) | ✓ | ✓ | wealth-agent (line 1270) |
| moms (Care) | ✓ | ✓ (optional) | moms-agent (line 466) |
| qa | ✓ | ✓ | qa-agent (line 1233) |
| **LevOps (ops)** | ✗ | ✓ | ops-agent (line 1370) |

Plus bots (telegram, discord ×6, whatsapp, owntracks) and services (embed, llama-server, watchdog, fleet-tls-watchdog).

**Multi-tenant agent provisioning open question:** Today every agent process has `MYA_USER_ID` baked into env. The spec proposes "copy template, fill user_id, register with orchestrator." This is feasible at 20 users (60 processes) but the cost / model-routing math the spec does (€600 revenue vs $800-2000 cost) needs revisiting against actual current spend.

---

## 1.8 — Build Sequence June 15 (per spec)

The spec's "must-have" list is ~14 days of work but assumes nothing exists. With reality:

| Spec task | Days (spec) | Days (reality) | Notes |
|---|---|---|---|
| Postgres schema + RLS | 2 | 4-6 | Larger schema than spec; must absorb encrypted_envelope, scope partitioning, agent_tokens, audit_log, egress_audit, mind-files representation |
| SQLite→Postgres migration | 2 | 7-10 | Source is N D1s not 1 SQLite; D1↔PG dialect; encryption envelope porting |
| Migrate existing 3 users | 1 | 2-3 | Per-customer downtime windows; embedding back-fill |
| MCP stdio→HTTP/SSE | 2 | 3-5 | Don't replace stdio; *add* HTTPS+JWT path for external; preserve loopback search |
| API gateway | 1 | 2 | Caddy already does TLS; add JWT verification + per-user routing + rate limit |
| User registration + mnemonic | 2 | 3 | Plus BIP-39 generation, recovery flow UX |
| MCP token + connection flow | 1 | 2 | New surface, but builds on existing agent_tokens table |
| Processing pipeline on Postgres | 2 | 4-6 | Pipeline is Python+Node; must port write-side, keep read-side; pgvector tuning |
| Agent provisioning for new users | 1 | 2-3 | Per-user `MYA_USER_ID` env or per-request user context; lane serialization implications |

**Revised estimate: 30–40 working days** (with parallelism, ~20 calendar days) — incompatible with June 15. The spec's own recommendation (Tier 2: 2–5 hand-picked users with guided onboarding, then 20 by July) is the only honest target.

---

# PART 2 — Reality inventory (what's actually built)

## 2.1 — Storage architecture

**Backend:** Cloudflare D1 per-tenant, accessed via Cloudflare Worker passthrough.

| Component | Location | Notes |
|---|---|---|
| Operator D1 binding | `packages/worker/wrangler.toml:104-111` (`mycelium-db`) | Holds operator metadata: provisioning_jobs, handle_reservations, audit_log, agent_tokens |
| Per-customer D1 bindings | `packages/worker/wrangler.toml:112-125` (`DB_TENANT_<hash>`) | One per active customer (3 today: 0mm, puh, marti) |
| Worker routing | `packages/worker/src/services/tenant-d1.ts:54-145` | `validateAndResolveTenantId()` checks agent token → tenant_id, resolves to per-tenant D1 binding |
| Fail-closed | `packages/worker/src/services/tenant-d1.ts:69-76` | Missing tenant binding → null DB → 503, no fallback to operator |
| SQL safety guardian | `packages/worker/src/handlers/db-proxy.ts:243-250` | Enforces user_id/agent_id WHERE on owner-D1 reads and now writes (Phase 2 hardening) |
| VPS DB client | `packages/core/db-d1.js` | Sends `AGENT_TOKEN` + `X-Tenant-ID` headers; handles encrypt-on-write, decrypt-on-read |
| Master key | `/run/mycelium/master.key` on tmpfs, per-VPS | Lazy loaded by `crypto-local.js:561-596` |
| Migration history | `migrations/001..162` | Latest: `162_deletion_ledger.sql` (2026-05-21) |
| Generated schema | `migrations/d1-schema-generated.sql` | 111 CREATE TABLE statements |

**Schema drift problem:** No automated migration runner. Tenant D1s drift from operator schema; the `tenant-schema-parity` skill is the manual gate. FLEET-MIGRATIONS-PLAN.md F2 is unbuilt.

**Wave 4b deprecation:** Vectorize removed except for account-deletion cleanup. All semantic search now goes through in-process mind-search (`packages/core/mind-search/`) + scan-matchers over D1 `embedding_768` columns.

## 2.2 — Encryption architecture

**Master keys (two families, hard-isolated):**
- USER_MASTER_KEY — customer vault content (messages, documents, contacts, wealth, health, territory profiles, ~40 tables)
- SYSTEM_KEY — operator-managed secrets (Discord bot tokens, Claude API keys, etc.)

Distinct HKDF prefixes: `mycelium:scope` vs `mycelium:system-scope` (`crypto-local.js:877-894`). Compromising one family does not expose the other.

**Scope partitioning:** personal / org / wealth / moms. Enforced by `scopeGuardian` (lines 86-123) and `scopeEncryptGuardian` (lines 134-169), which run *before* key unwrap. `AGENT_SCOPES` env per-agent. Violation → audit log + decryption refusal.

**Encrypted at rest (table sample, partial — see `crypto-local.js:209-467` for `ENCRYPTED_FIELDS`):**

| Category | Tables / Files |
|---|---|
| Messages | `messages` (content, scoped) |
| Documents | `documents` (content, name) |
| Contacts | `contacts` (name, identifiers) |
| Wealth | wealth_* tables |
| Health | health_* tables |
| Territory profiles | `territory_profiles.{name,essence}` |
| Realms | `realms` (descriptive fields) |
| Secrets | `secrets` (encrypted with SYSTEM_KEY, v3 envelope `kf='system'`) |
| Mind files | `mind/*.md` on disk, MIND magic prefix + envelope (`packages/tools/mind-files.js`) |

**NOT encrypted (deliberate trade-off):**
- Centroid vectors in clustering (`crypto-local.js:204-206`)
- Embedding vectors in `embedding_768` columns
- Audit log metadata (event type, timestamp; PII fields dropped Phase 4)

**Note:** The plaintext-embedding choice contradicts CLAUDE.md §1.7 ("treat embeddings with same paranoia as plaintext; embedding inversion attacks are real"). This is an accepted current risk, not a designed-in defense.

**Noise NK encrypted channel:** Code-complete, disabled.
- Server: `packages/server/lib/noise-nk-server.js`
- Browser: `packages/portal/src/lib/noise-nk.ts`
- WebSocket integration: `packages/server/routes/portal-channel.js`
- Mount: `packages/server/agent-server.js:1935`
- Gates: `SECURE_CHANNEL_ENABLED=1` env + `/run/mycelium/vps-noise.key` file
- 5 activation blockers identified in [ENCRYPTED-PORTAL-CHANNEL-ACTIVATION-DESIGN-2026-05-07.md](ENCRYPTED-PORTAL-CHANNEL-ACTIVATION-DESIGN-2026-05-07.md)

## 2.3 — Processing pipeline

| Stage | Language | Location | DB target | Cadence |
|---|---|---|---|---|
| Embedding (768D search) | Python | `scripts/embed-service.py` (port 8091) | `messages.embedding_768` (encrypted source row, plaintext vector) | On-demand at query time |
| Embedding (256D clustering) | Python | `scripts/cluster.py` (matryoshka truncation) | Local `.npy` cache + D1 via Node bridge | Weekly |
| Clustering | Python | `scripts/cluster.py` (FAISS + Leiden) | `clustering_points`, `clustering_labels` | Weekly |
| Hierarchy (atoms→realms) | Python | `scripts/cluster.py:585+` (Ward HAC) | `clustering_labels` 4-level | Weekly |
| Territory naming | Node | `scripts/describe-clusters.js` | `territory_profiles.{name,essence}` (encrypted) | Weekly |
| Co-firing | Node | `scripts/compute-cofire.js` | `territory_cofire.{immediate,session,daily,weekly}` | Weekly |
| Harmonic analysis (H0, β, γ, α, θ, δ) | Python | `scripts/compute_information_harmonics.py` | `cognitive_metrics_harmonic` | Hourly admin, weekly customer |
| Frequency metrics | Python | `scripts/compute-frequency.py` | TBD `cognitive_metrics_*` | Weekly |
| Mind-search index (RAM) | Node | `packages/core/mind-search/server.js` | In-process Float32Array | Built at agent boot, hot-rebuilt |
| Topology queries | Node | `packages/core/db-d1/topology.js` | Read-only | On-demand via MCP tools |

**Phase transition detection: NOT YET BUILT** — deferred to PR1.5 per [COGNITIVE-METRICS-FINALIZATION-PLAN-2026-05-08.md](COGNITIVE-METRICS-FINALIZATION-PLAN-2026-05-08.md). Spec claim "✅ Built" is wrong.

**Honest beta flag:** `compute_information_harmonics.py:632` sets `low_confidence: True` unconditionally until Phase 6.2 calibration. The Workstream C UI banner ("not calibrated against 90-day baseline") is the visible surface of this — there's a PR-WSC-FOLLOWUP open to make the banner honest (compute populates a `notes` field instead of the UI inventing reason).

## 2.4 — MCP + Agent runtime

**Transport:** stdio (`packages/tools/agent-tools.js:358`) for tool calls. Loopback HTTP `127.0.0.1:<agent-port>/internal/v1/search/mindscape` for search recall (`search-client.js`).

**Tool surface: 37 tools across 13 domains** in `packages/tools/agent-tools/domains/`:

| Domain | Tools (sample) |
|---|---|
| mindscape | searchMindscape, mindscapeStructure |
| messages | getDailyMessages |
| topology-tools | exploreTerritory, mindscapeStructure |
| documents | getDocument |
| metrics | getHarmonicState, getShape, getMetricSeries |
| fisher-tools | getTopMovers |
| health | getHealthData |
| reply | reply (egress to inbound channel) |
| delegation | delegate_to_agent (4 allowed pairs) |
| internal | flagForDiscussion, readMindFile, editMindFile, writeMindFileWhole |

(Round 2 sweep will produce the full 37-tool inventory.)

**Agent processes (10 — `ecosystem.config.cjs`):**
- personal-agent (Mya, port 3004)
- company-agent (Com, port 3002)
- research-agent (Ada, port 5002)
- commercial-intelligence-agent (Rex, port 5004)
- publishing-agent (Noa, port 5006)
- intel-agent (Apollo, port 5012)
- wealth-agent (Rob, port 5010)
- moms-agent (Care, port 5014)
- qa-agent (port 5008)
- ops-agent (LevOps, port not in spec map)

**Bots and services:**
- telegram-bot (port 3003), 6× Discord bots, whatsapp-bot, owntracks-receiver
- embed-service (Python, port 8091), llama-server, watchdog cron, fleet-tls-watchdog cron, orchestrator (port 3001)

**Multi-agent coordination:**
- Channel-based (NOT @mention-parsed)
- `DISCORD_COLLAB_CHANNEL` env var; agents post to channel, routing by registry
- `delegate_to_agent` restricted to 4 pairs in `agent-registry.js:59-64`: personal→research, company→research, research→publishing, publishing→research

## 2.5 — Operational machinery

| Capability | Location | Status |
|---|---|---|
| Customer provisioning | `mycelium-managed/scripts/provision-customer.sh`, `onboard-tenant.sh` | Shipped, multi-stage; Phase 6 (signup reliability) ~105 LOC pending |
| Customer fleet roster | `~/.config/mycelium-ssh/customers.yml` | Manually maintained |
| Worker tenant bindings | `packages/worker/wrangler.toml` | Live, fail-closed |
| Account deletion | `mycelium.id/worker/src/services/catalog.js` (12 entry types); Phase 0–5 shipped (`dad95f5..bb8fe84`) | Phase 6 (auto-trigger from customer) + Phase 7 (pre-wipe schema parity check) pending |
| Stripe billing | `mycelium.id/worker/src/services/stripe.ts` + `stripe-webhook.ts` (5 event handlers) + `portal-billing.js` (3 routes) | Live — prices €15/mo, €135/yr, €1500/decade |
| Update pipeline | `scripts/update.sh`, `scripts/update-customers.sh --restart` | Live; tarball + rsync caveat (no delete) |
| Verify-deploy gate | `scripts/verify-deploy.sh` (9 sections) | Live; runs on every deploy per `deploy-and-verify` skill |
| Fleet TLS watchdog | `scripts/fleet-tls-watchdog.sh` + PM2 cron | Live since CF-525 incident 2026-05-18 |
| SSH CA | `scripts/sign-cert.sh` (1Password Touch ID); `scripts/deploy-ca-trust.sh` | Live; 5-min cert TTL |
| Monitoring | Discord webhook (`DISCORD_ALERT_WEBHOOK`), watchdog.sh cron, fleet-tls-watchdog state JSON | Minimal; no Prometheus/Grafana |
| Secrets pipeline | `mycelium.id/scripts/bootstrap-secrets.js` (Worker Secrets API → tmpfs, 5-min refresh) | Live; two-key (system + master) |
| Fleet migrations runner | `scripts/migrate-fleet.js` | UNBUILT — manual via `tenant-schema-parity` skill |

## 2.6 — Portal + Ingestion

**Portal:** 19 SvelteKit routes (`packages/portal/src/routes/(app)/`):
activity, agents, body, chat, connections, contexts, cycles, fleet, import, intel, library, media, mindscape, modules, profile, settings, spaces, timeline, vitality, wealth — plus login, telegram-callback.

Secure-fetch (`packages/portal/src/lib/secure-fetch.ts:16-52`) enforces Noise NK on 40+ sensitive API paths via `SENSITIVE_PREFIXES`.

**Ingestion (corrected):**

| Channel | Status | Entrypoint |
|---|---|---|
| Telegram | ✅ Mature | `packages/bots/telegram-bot.js` (Grammy long-polling, voice inbound support) |
| Discord | ✅ Mature | `packages/bots/personal-discord-bot.js` + 5 other agent-specific |
| **WhatsApp** | **✅ Active** (spec says "not started") | `packages/bots/whatsapp-bot.js` (28KB Baileys WebSocket, phone routing) |
| Email | ⏳ Import only | `packages/server/routes/portal-export-import.js` (`.eml` ingestion); no live MTA |
| OwnTracks | ✅ Active | `packages/bots/owntracks-receiver.js` (location pings, 5min rate limit) |
| Voice transcription | ✅ Telegram-only inbound | `telegram-bot.js:86-90` (Whisper); egress TTS broken on Telegram per 2026-05-07 |
| Imports (ChatGPT, Claude, Obsidian, Apple Notes) | ✅ | `packages/server/routes/portal-export-import.js` |
| Publish path | ✅ | `packages/server/routes/portal-library.js` (`POST /portal/documents/:path/publish` → `<handle>.mycelium.id/<slug>`) |

**Egress chokepoints** (CLAUDE.md §11): `packages/server/lib/send-handler.js` (`/telegram/send`, `/discord/send`, `/whatsapp/send`) — factory at line 87-196, recordEgress calls at 187/375/429 (egress-provenance Phase 2 missing inbound source wiring at these 3 lines, per [EGRESS-PROVENANCE-PHASE2-DESIGN-2026-05-06.md](EGRESS-PROVENANCE-PHASE2-DESIGN-2026-05-06.md)).

## 2.7 — Federation / public presence / discovery (Round 2 verified)

**Headline correction:** the spec's "federation everything OPEN" is wrong. **Phase 0 federation scaffold IS built** — WebFinger, DID documents, publish path with full SEO surfaces, public profile API, share links, presence heartbeats, and a separate Discovery D1 with privacy-by-design schema. What's missing is the cross-instance handlers and the discovery matching UI.

### LIVE public surfaces (unauthenticated)

| Surface | URL | Implementation |
|---|---|---|
| Published documents | `GET <handle>.mycelium.id/p/<slug>` | `packages/worker/src/handlers/publishing.ts:211-262` — reads R2 key `published/{userId}/{slug}.html`, returns HTML |
| Public profile API | `GET /api/public/profile/:handle` | `packages/worker/src/handlers/public-profile.ts:36-100` (KV cached, 120 req/min/IP) |
| WebFinger | `GET /.well-known/webfinger?resource=acct:<handle>@<domain>` | `packages/worker/src/handlers/federation.ts:39-80` — returns self link + federation link + DID link |
| DID document (instance-level) | `GET /.well-known/did.json` | `packages/worker/src/handlers/did-document.ts:1-150` — per-user DID deferred to Phase 0d |
| Share-link tokens | `GET mycelium.id/share/<token>` | `packages/worker/src/handlers/publishing.ts:265-331` — handleShareLink |
| Robots.txt for published content | `<handle>.mycelium.id/p/robots.txt` | `publishing.ts:400-418` |
| llms.txt | `<handle>.mycelium.id/p/llms.txt` | `publishing.ts:420-455` |
| Sitemap | `<handle>.mycelium.id/p/sitemap.xml` | `publishing.ts:457-484` |
| Intel public API | `GET /api/intel/*` | `packages/worker/src/handlers/intel-public.ts:1-50` (KV-only, no D1 access) |
| Heartbeat (presence) | `POST <handle>.mycelium.id/p/_heartbeat` | `publishing.ts:351-396` — myc_session cookie required, 10s ping, 30s active window |

### Schema-ready, no handler/UI

| Capability | Schema | Missing |
|---|---|---|
| Cross-instance connect | `migrations/106_federation.sql:8-11` (connections.remote_instance, .remote_user_handle, .remote_did) | `POST /federation/connect` handler |
| Federation overlap query | mentioned `federation.ts:12` doc header | implementation |
| Discovery (anonymized topology match) | `migrations/108_discovery.sql:6-42` (discovery_profiles opted_in, discovery_centroids with noised_centroid BLOB, discovery_lsh, discovery_dismissed) — **separate D1 instance for privacy isolation** | match query routes, UI |
| Per-user DID | `migrations/106_federation.sql:6` (user_profiles.did added) | per-user DID generation, key management, `.well-known/did.json/<handle>` resolution (deferred to Phase 0d) |
| Ed25519 JWT replay protection | `federation.ts` doc mentions RFC 9421 (iat/exp/jti/body_hash) | not implemented (per `did-document.ts:20` "HTTP signature ... NOT in this PR") |
| Space-agent curation | `docs/SPACES-CURATION-PLAN.md` (scanner module pattern, multi-source addressing future-supporting `connections:<user_id>` and `agents:<agent_id>`) | scanner dispatch endpoints |

### Zero hits

- ActivityPub: 0 (only mention: `migrations/140_outbound_envelope_dedup.sql` comment "Matrix prep" + account-deletion v2 design references future ActivityPub Delete activity)
- Matrix: 0 (same comment)
- Nostr: 0
- AT-Protocol: 0

### Connections + spaces (intra-instance today)

- `migrations/105_connections.sql:5-16` — connections (user_a, user_b, initiated_by, status='pending'/'accepted'). Federation columns exist but no cross-instance routes.
- `migrations/110_shared_spaces.sql:3-14` — shared_spaces (tied to connections 1:1, status pending/accepted). 26 references = schema count.
- Portal routes exist: `packages/portal/src/routes/(app)/connections/+page.svelte`, `packages/portal/src/routes/(app)/spaces/`

### Handle registration

- `migrations/109_handle_reservations.sql:3-6` — handle TEXT PRIMARY KEY, user_id, reserved_at
- `packages/worker/src/handlers/handles.ts` — claim/release/check endpoints

## 2.8 — Sibling repos (Round 2 inventory)

The May 28 spec mentions NONE of these. Each must be classified.

### `mycelium.id` — open-source AGPL-3.0 mirror, ~7 weeks stale

- **Role:** Public mirror of the canonical mycelium private repo. Synced manually ("Sync from private dev repo: two-key separation, tenant routing, more" — commit `882a9ab`).
- **Last sync:** 2026-04-19 (commit `29204cb` "Branding: Mindscape → Your Mycelium, pricing update, AGPL-3.0 license").
- **Drift:** Migrations 001-133 (canonical is at 190 — **57 migrations behind**). Has `BGE-M3 1024D + Vectorize + FTS5` per its own CLAUDE.md; canonical has Nomic v1.5 768D + mind-search + Vectorize removed. **The Round 2 sweep that read BGE-M3 was reading this stale mirror.**
- **Contains:** `worker/src/services/stripe.ts` (full Stripe client, possibly NOT in canonical), `mcp/` with 6 MCP server files (mya-tools, ops-tools, linear-tools, wealth-tools, polymarket-tools), 9 agents codebase, portal, scripts, terraform.
- **License:** AGPL-3.0 (this is the open-source story — the canonical repo's license decision is settled by virtue of this).
- **Redesign disposition:** **MAINTAIN as the public release surface.** Adjust sync cadence post-redesign so the mirror reflects multi-tenant architecture once stable. Update its CLAUDE.md to remove BGE-M3 references after next sync.

### `mycelium.id-site` — public marketing site, commit today

- **Role:** Cloudflare Pages static site. Landing, signup, pricing, vault page, privacy, terms.
- **Status:** Active — most recent commit `837881d` (2026-05-28 13:29 "Footer: 'Your rights preserved' → 'All rights reserved' (legal copyright)").
- **Marketing copy alignment:** Already references Swiss KMS, master-key-never-leaves-your-machine, mindscape preview. Aligns with current architecture, NOT yet with the proposed redesign's BIP-39 / federation story.
- **Redesign disposition:** **UPDATE copy when redesign lands.** Landing flow may need: BIP-39 ceremony explanation, optional WebAuthn PRF setup, federation identity setup, community/discovery teaser.

### `MYA-0.2` — abandoned Postgres+pgvector predecessor ⚠️ — DOCUMENTED ABANDONMENT REASONS

- **Stack:** TypeScript Cloudflare Worker + Python Modal NLP pipeline + **Supabase (PostgreSQL + pgvector)** + Telegram bot.
- **Last commit:** 2026-04-02 (cleanup of duplicate dirs); active dev ended ~2026-02-16.
- **Migration count:** 94 (system never reached operational maturity at scale).
- **Lifecycle:** Rapid MVP build Jan 5–12, 2026 → feature velocity high Jan 13–30 → Feb 1–5 NLP pipeline stabilization → **Feb 6–16 pivot: agent framework extracted to `mycelium` repo, D1/Vectorize proxy endpoints added, RLS abandoned in favor of per-agent token auth, last commit Feb 16.**

**Three documented abandonment reasons** (Round 3 Sweep K, with file:line/commit citations):

1. **Supabase write timeout cascades during clustering batches** (`MYA-0.2/docs/CLUSTERING_ROBUSTNESS_PLAN.md:11`)
   - Symptom: "Supabase timeouts | Write batches fail | 500-row batches too large"
   - Root: Monolithic nightly clustering pipeline saturated Supabase connection pool (free tier: 3 concurrent, 15 pooled)
   - The fix (CLUSTERING_ROBUSTNESS_PLAN.md:59-73) — checkpointing + phase-split — was designed but **never deployed**; pivot to D1 made it moot
   - **Severity: CRITICAL** — blocking the core feature (mindscape visualization)
   - **Risk under redesign:** Postgres + pgvector has the same write-batch limits. **Unless the redesign includes the never-deployed checkpointing + phase-split, the same failure mode returns at scale.**

2. **Modal Python pipeline cold-starts + dependency hell** (inferred from commit pattern; no explicit doc)
   - Modal-related commits drop to zero after Jan 28 (`commits 7ad5f1b, 09e2027, 5122be2` all Jan 28 or earlier)
   - Workers AI (Llama, BGE-M3) was added to Cloudflare Workers as alternative (`MYA-0.2/docs/ARCHITECTURE.md:93-94`)
   - **Severity: HIGH** — Python dependency management in serverless context plus cold-start latency
   - **Risk under redesign:** The May 28 spec doesn't say where the NLP pipeline runs in the new architecture. If it's Python-via-Modal again, same problem. If it's Workers AI / paid Whisper, costs surface. If it's local on a VPS, that's the current architecture — which contradicts "managed-light tier."

3. **RLS doesn't scale to multi-process agent federation** (`MYA-0.2/docs/UNIFIED_AGENT_ARCHITECTURE.md`) — **THE MOST IMPORTANT FINDING**
   - Quote: "User isolation is RLS-enforced (database level)" but "agent_id not RLS-enforced (pure application level)"
   - When agents spawn as separate Node.js processes (Mycelium precedent), each process = different authenticated principal. **RLS requires user_id derived from authenticated claims, not orthogonal agent_id.**
   - D1 proxy added (commit `c1108f2`) with "timing-safe auth, DDL blocklist, input validation" — **explicit pivot to per-agent token auth instead of RLS**
   - The operator built mycelium's architecture as the answer to this exact failure
   - **Severity: CRITICAL**
   - **Risk under redesign: THE MAY 28 SPEC PROPOSES THE SAME ARCHITECTURE THAT FAILED.** The current Mycelium runs 10 per-process per-user agents. Multi-tenant Postgres + RLS requires either: (a) unify all agents into one process with per-request user context (huge rewrite), OR (b) per-agent Postgres roles (operationally complex), OR (c) abandon RLS in favor of application-level filtering (loses cryptographic isolation argument). MYA-0.2 chose (c). **The redesign must EXPLICITLY DECIDE this BEFORE schema work begins.**

**What does NOT appear to have driven the abandonment:**
- Cost — README claimed "$20-30/month per active user (Claude API usage)"; no docs mention Supabase/Modal overages
- Embedding tech — pgvector was working
- Latency — no consistent latency complaint in handoffs

**Redesign disposition: MANDATORY READING.** The May 28 spec MUST address all three of these failure modes explicitly. Specifically:
- **Address #1:** Include the never-deployed clustering checkpointing in the new architecture spec
- **Address #2:** Decide where the Python NLP pipeline runs (VPS / Modal / Workers AI / abandon Python)
- **Address #3:** Decide the agent runtime model BEFORE deciding the RLS/non-RLS isolation strategy. **This is the single highest-leverage architecture decision in the entire redesign.**

### `mycelium-transcriber` — macOS app, renaming to "Mycelium Desktop"

- **Stack:** Swift, macOS 14.4+, Apple Silicon, WhisperKit on-device, Core Audio Taps.
- **Status:** Active (last commit 2026-04-02 `67a8bfd` "Rename: Mycelium Transcriber → Mycelium Desktop"). Scope expanding beyond transcription into voice-notes + editor + library.
- **Integration:** Uploads transcripts to `/portal/documents` via session-cookie auth. Notifies Mya for processing.
- **Redesign disposition:** **MAINTAIN.** Orthogonal to redesign. Will need client-side updates if `/portal/documents` endpoint shape changes or if auth shifts to BIP-39 derived JWT.

### `mycelium-ios` — native iOS app, commit TODAY

- **Stack:** Swift, iOS 26 (bumped from 17 for Apple's `SpeechTranscriber` API), SwiftUI, HealthKit, Core Audio, broadcast extension for system audio.
- **Status:** **Most active sibling repo. Commit `d2c6b27` at 2026-05-28 14:12.** Currently in "iOS Phase 1.2 follow-up" simplification work.
- **Tabs (per simplification design 2026-05-23):** Record / Library / Health. WhisperKit → Apple SpeechTranscriber. No diarization v1. No Watch v1.
- **Auth:** Manual session-cookie paste from browser into Keychain. No OAuth, no sign-in flow.
- **Integration:** Reads from `/portal/documents`, `/portal/health/today`, `/portal/health/summary`, `/portal/health/range`. Read-only client.
- **Redesign disposition:** **UPGRADE LATER.** After redesign lands: (1) server URL discovery (DID-based), (2) OAuth or BIP-39-mnemonic flow (replace cookie-paste), (3) community/profile browsing. Current 3-tab structure is stable.

### Cross-repo summary

| Repo | Active | Relationship | Redesign action |
|---|---|---|---|
| mycelium | canonical (today) | source of truth | redesign target |
| mycelium.id | mirror (stale 7 weeks) | open-source AGPL release | maintain; re-sync post-redesign |
| mycelium.id-site | active (today) | marketing/signup gateway | update copy when redesign ships |
| MYA-0.2 | abandoned 2026-04-02 | **prior Postgres+pgvector attempt** | harvest lessons before repeating |
| mycelium-transcriber | active 2026-04-02 | macOS upload client | maintain; minor updates if API changes |
| mycelium-ios | active today | iOS read-only client | upgrade in Phase 2 post-redesign |

---

# PART 3 — Verification table (every spec claim → reality)

🟡 = Round 2 will pressure-test. ✅ = verified by sweep + file:line. ❌ = contradicted. ⚠️ = partial / nuanced.

| # | Spec claim | Status | Verified at |
|---|---|---|---|
| 1 | "SQLite database, single-tenant" | ❌ | `packages/core/db-d1.js:1-9`; `wrangler.toml:104-125` |
| 2 | "1M+ data points" | 🟡 UNVERIFIED | No audit found |
| 3 | "3 users" | ⚠️ 3 customers + admin | `~/.config/mycelium-ssh/customers.yml:2-5` |
| 4 | "MCP server (Node.js, stdio transport)" | ⚠️ stdio + loopback HTTP | `agent-tools.js:358`; `search-client.js:1-38` |
| 5 | "Nomic v1.5 384-dim" | ❌ 768D + 256D | `embed-service.py:64`; `cluster.py:76` |
| 6 | "HDBSCAN clustering" | ❌ Leiden | `cluster.py:86` |
| 7 | "Ward agglomerative needs work" | ✅ shipped on centroids | `cluster.py:585+` |
| 8 | "Territory naming ✅ Built" | ✅ | `scripts/describe-clusters.js` |
| 9 | "Co-firing ✅ Built" | ✅ 4 timescales | `scripts/compute-cofire.js` |
| 10 | "Harmonic analysis ✅ Built (H0, β, γ, α)" | ✅ also θ, δ | `compute_information_harmonics.py` |
| 11 | "Phase transition detection ✅ Built" | ❌ deferred PR1.5 | `COGNITIVE-METRICS-FINALIZATION-PLAN-2026-05-08.md:100+` |
| 12 | "Nightly topology rebuild ✅ Built" | ✅ + mind-search rebuilt at boot, not nightly | `scripts/run-clustering.sh:16-118` |
| 13 | "Topology ~250-400 territories, ~30 themes, ~7 realms" | ⚠️ admin counts: 26/400/861 (May 8) | `cluster.py:90-94` defaults |
| 14 | "9 agents" | ❌ 10-13 | `ecosystem.config.cjs` |
| 15 | "Multi-agent via @mentions" | ❌ channel-based | `orchestrator.js:69-90`; `agent-registry.js:59-64` |
| 16 | "delegate_to_agent ✅ Built" | ⚠️ 4 hardcoded pairs only | `agent-registry.js:59-64` |
| 17 | "JWT + magic link ✅ Built" | ✅ + Telegram passkey + Noise NK design | `routes/login/+page.svelte` |
| 18 | "Whisper voice transcription ✅ Built" | ✅ inbound Telegram; egress TTS broken | `telegram-bot.js:86-90` |
| 19 | "ChatGPT/Claude/Obsidian/Apple Notes imports ✅" | ✅ | `portal-export-import.js` |
| 20 | "TLS via Caddy + Let's Encrypt ✅" | ✅ + CF-525 watchdog | `fleet-tls-watchdog.sh` |
| 21 | "VPS-per-user model is dead" | ❌ alive, hardened in Phase 2 | `~/.config/mycelium-ssh/customers.yml`; `tenant-d1.ts:69-76` |
| 22 | "Encryption at rest: leaning ✅ — Client-side BIP-39 + server-side Postgres" | ❌ shipped: server-side 2-key + scope + mind-files; no BIP-39 | `crypto-local.js:561-596,86-169,909-923`; `mind-files.js`; zero BIP-39 hits |
| 23 | "Trusted session processing: leaning ✅" | ❌ doesn't exist | No session-key lifecycle found |
| 24 | "Per-agent access tokens: not started" | ❌ shipped | `migrations/104`; `db-d1.js:186-194` |
| 25 | "WhatsApp ingestion: not started" | ❌ active | `packages/bots/whatsapp-bot.js` (28KB) |
| 26 | "Email ingestion: not started" | ⚠️ import only | `portal-export-import.js` |
| 27 | "Billing & subscriptions: not started" | ❌ live with prices | `mycelium.id/worker/src/services/stripe.ts`; portal-billing.js |
| 28 | "Per-user agent provisioning: OPEN" | ⚠️ pipeline exists (onboard-tenant.sh) but per-process MYA_USER_ID is hard-coded | `ecosystem.config.cjs:70` |
| 29 | "Schema versioning / migrations: OPEN" | ⚠️ 162 migrations + parity skill; fleet runner unbuilt | `FLEET-MIGRATIONS-PLAN.md` (unbuilt design) |
| 30 | "Federation everything OPEN" | 🟡 | Round 2 |
| 31 | "MCP server is mature" | ✅ rewritten 2026-05-08 (caadd92, −18 tools net) | `packages/tools/agent-tools.js` |
| 32 | "Embedding storage: OPEN" | ❌ pgvector-equivalent already in D1 `embedding_768` + mind-search RAM index | `db-d1.js:14-17` |
| 33 | "1,270 territories mapped" (public doc) | 🟡 stale | No matching current count |
| 34 | "Phase transitions to be detected before user is consciously aware" | ❌ aspirational, not built | per #11 |
| 35 | "Embeddings stored unencrypted" (proposed) | regression vs CLAUDE.md §1.7 | Design decision, see Part 8 |

35 / 35 cataloged. 11 contradicted, 13 partial/nuanced, 8 verified, 3 unverified (Round 2).

---

# PART 4 — Transfer / Rebuild / Discard matrix

🟡 = will fill after Round 2. Below is the v0.1 cut from Round 1 evidence.

| Component | Status today | Under proposed redesign | Action |
|---|---|---|---|
| **Storage** | | | |
| D1 per-tenant + Worker passthrough | shipped | replaced by multi-tenant Postgres+RLS for managed-light tier | DECIDE: keep D1 for dedicated tier? Or full cutover? |
| `enforceSqlSafety()` SQL guardian | shipped | replaced by RLS policies | RLS is a stricter version; transfer the discipline |
| Generated schema (111 tables, 162 migrations) | shipped | needs Postgres translation | REBUILD schema; PRESERVE the migration history conceptually |
| FTS5 (broken for encrypted) | broken | Postgres `tsvector` OR encrypted FTS deferred | DISCARD broken path; design encrypted-FTS post-launch |
| Vectorize (removed Wave 4b) | removed | pgvector | already gone — no migration needed |
| **Encryption** | | | |
| USER_MASTER + SYSTEM_KEY two-family | shipped | TRANSFER as-is; the key family pattern survives any storage swap | PRESERVE |
| Scope partitioning (personal/org/wealth/moms) | shipped | TRANSFER as-is | PRESERVE |
| `scopeGuardian` / `scopeEncryptGuardian` | shipped | TRANSFER as-is; runs before key unwrap | PRESERVE |
| Encrypt/decrypt chokepoint (`crypto-local.js`) | shipped | TRANSFER as-is; storage backend swap is transparent to crypto layer | PRESERVE |
| Mind-files encryption | shipped admin, customer rollout pending | TRANSFER as-is; mind/ stays on disk per-host | PRESERVE; finish rollout |
| Noise NK encrypted channel | code-complete, disabled | ACTIVATE (5 blockers per ENCRYPTED-PORTAL-CHANNEL design) | TURN ON before redesign cutover |
| BIP-39 mnemonic | doesn't exist | ADD on top of existing master-key derivation | BUILD new |
| Trusted-session lifecycle | doesn't exist | ADD; required for embedding/clustering processing | BUILD new |
| Client-side field encryption | doesn't exist | ADD on top of Noise NK transport | BUILD new (or defer, per launch tier) |
| Per-agent access tokens | shipped (table exists) | TRANSFER + extend with per-user scope | PRESERVE + EXTEND |
| **MCP + Agents** | | | |
| stdio transport for local | shipped | KEEP for Claude Desktop / Code local use | PRESERVE |
| Loopback HTTP for search | shipped | KEEP (inside agent process) | PRESERVE |
| HTTPS + JWT for external | doesn't exist | ADD for remote MCP clients (multi-tenant) | BUILD new |
| 37-tool surface | shipped | KEEP; some tools need per-user routing | PRESERVE + retune |
| 10-13 agent processes per VPS | shipped | REBUILD as multi-tenant orchestrator OR keep per-user agent set | DECIDE |
| Channel-based coordination (Discord) | shipped | KEEP for now; pure-transport-bot vision long-term | PRESERVE |
| Delegation (4 hardcoded pairs) | shipped | OPEN: programmable delegation; agent marketplace | DEFER post-launch |
| `delegate_to_agent` tool | shipped | TRANSFER | PRESERVE |
| Mind-file MCP tools (read/edit/writeWhole) | shipped 2026-05-08 | TRANSFER as-is | PRESERVE |
| **Pipeline** | | | |
| Nomic v1.5 768D + 256D embeddings | shipped | KEEP; schema needs `vector(768)` + `vector(256)` not `vector(384)` | PRESERVE; fix spec |
| `embed-service.py` (port 8091) | shipped | KEEP per VPS for now; multi-tenant managed-light might share the service | PRESERVE |
| Leiden + FAISS clustering | shipped | KEEP (spec wrong about HDBSCAN) | PRESERVE |
| Ward HAC hierarchy | shipped | KEEP | PRESERVE |
| Co-firing (4 timescales, Node) | shipped | KEEP | PRESERVE |
| Harmonic analysis (Python) | shipped | KEEP; low_confidence flag is honest | PRESERVE |
| Phase transition detection | NOT BUILT | BUILD (was spec'd as built; isn't) | BUILD new |
| Mind-search RAM index | shipped | KEEP per agent process | PRESERVE; revisit if shared embed service |
| Nightly topology rebuild (run-clustering.sh) | shipped | KEEP cadence; tune cost per managed-light tier | PRESERVE |
| **Ingestion** | | | |
| Telegram bot | shipped | TRANSFER | PRESERVE |
| Discord (×6) bots | shipped | TRANSFER | PRESERVE; consider unifying |
| WhatsApp bot | shipped | TRANSFER (spec claimed "not started") | PRESERVE |
| OwnTracks receiver | shipped | TRANSFER | PRESERVE |
| Email inbound | NOT BUILT (import only) | BUILD live MTA | BUILD new (post-launch?) |
| Voice transcription | shipped inbound; TTS broken on Telegram | TRANSFER inbound; FIX TTS | PRESERVE + FIX |
| Imports (ChatGPT/Claude/Obsidian/Apple Notes) | shipped | TRANSFER | PRESERVE |
| **Egress chokepoints** | | | |
| `/telegram/send`, `/discord/send`, `/whatsapp/send` | shipped | TRANSFER as load-bearing security primitive (CLAUDE.md §11) | PRESERVE |
| `publishArtifact` chokepoint (CLAUDE.md §12) | shipped | TRANSFER | PRESERVE |
| Publish endpoint (CLAUDE.md §13) | shipped | TRANSFER | PRESERVE |
| Egress-provenance Phase 2 wiring | 3 lines short of complete | FINISH before redesign | BUILD remaining wiring |
| **Operational** | | | |
| Per-customer VPS provisioning | shipped | RETAIN for dedicated tier; SUPERSEDE for managed-light tier | DECIDE |
| Account deletion (Phases 0-5) | shipped | TRANSFER catalog model; rewrite execution to Postgres | PRESERVE design; REBUILD execution |
| Stripe billing | shipped + prices live | TRANSFER as-is; this is one of the redesign's biggest surprises | PRESERVE |
| `verify-deploy.sh` (9 checks) | shipped | EVOLVE for multi-tenant (RLS correctness check, per-user health, etc.) | PRESERVE + EXTEND |
| `update-customers.sh` | shipped (tarball+rsync, no delete) | REPLACE for managed-light tier (single deploy); KEEP for dedicated | DECIDE per tier |
| SSH CA + sign-cert.sh | shipped | KEEP for operator + dedicated tier; managed-light doesn't need per-customer SSH | PRESERVE for the tier that needs it |
| Fleet TLS watchdog | shipped | KEEP for dedicated tier; managed-light has one Caddy | DECIDE per tier |
| Secrets bootstrap | shipped (Worker Secrets → tmpfs) | TRANSFER pattern; backend changes | PRESERVE pattern |
| FLEET-MIGRATIONS-PLAN F2 runner | UNBUILT | Build for dedicated tier; for managed-light, normal Postgres migrations | BUILD or SKIP per tier |
| Monitoring (Discord webhook + watchdog) | shipped, minimal | EVOLVE to Prometheus+Grafana for managed-light scale | EVOLVE |
| **Portal** | | | |
| 19 SvelteKit routes | shipped | TRANSFER; some routes need multi-user adjustments (fleet, intel, agents) | PRESERVE + adjust |
| `secure-fetch.ts` Noise NK enforcement | shipped, gated off | ACTIVATE (depends on Noise NK turn-on) | TURN ON |
| Telegram passkey login | shipped | TRANSFER | PRESERVE |
| Magic-link login | shipped | TRANSFER | PRESERVE |
| WebAuthn / passkey portal-side | partial (per memory: passkey_credentials table) | EXTEND for BIP-39 key storage via WebAuthn PRF | BUILD on top |
| Publish path → `<handle>.mycelium.id/<slug>` | shipped | TRANSFER (DNS architecture may change for managed-light) | PRESERVE |
| Mindscape3D + Cognitive Shape UI | shipped admin | TRANSFER; finish customer rollout | PRESERVE |
| **Federation / discovery** | | | |
| Anonymized topology matching | NOT BUILT | BUILD post-launch | DEFER |
| Cross-instance protocol | NOT BUILT | BUILD post-launch | DEFER |
| Public portal (curated cognitive view) | partial (publish path exists; curated UI doesn't) | DEFER | DEFER |
| Connections (request/accept/block) | partial | EXTEND | EXTEND post-launch |

---

# PART 5 — In-flight work reconciliation

60 design/handoff/plan/vision docs found in `docs/` (full inventory in Round 1 Sweep F output). The redesign must explicitly classify each. v0.1 cut below; Round 2 will complete.

## Active design threads (each must be classified: ship before redesign / merge into redesign / discard)

| Doc | Topic | Status | Disposition under redesign |
|---|---|---|---|
| [CHANNEL-CONTEXT-ISOLATION-DESIGN-2026-05-28.md](CHANNEL-CONTEXT-ISOLATION-DESIGN-2026-05-28.md) | DM↔group context leak; 4-phase fix (~100 LOC) | sweep-first-design done today; code not started | **Ship Phase A (audit wiring, ~25 LOC) BEFORE redesign cutover** — it's the missing wiring for Phase 2 egress-provenance and the root-cause fix for puh leak 2026-05-26 |
| [ACCOUNT-DELETION-LIFECYCLE-DESIGN-2026-05-21.md](ACCOUNT-DELETION-LIFECYCLE-DESIGN-2026-05-21.md) + [ACCOUNT-DELETION-HANDOFF-2026-05-21.md](ACCOUNT-DELETION-HANDOFF-2026-05-21.md) | Phases 0–5 shipped; Phase 6+7 needed | Phase 6 (auto-trigger from customer-side) pending | **Merge into redesign** — the DELETION_CATALOG model is the right abstraction; rewrite execution for Postgres |
| [MANAGED-SIGNUP-RELIABILITY-DESIGN-2026-05-21.md](MANAGED-SIGNUP-RELIABILITY-DESIGN-2026-05-21.md) | 9 QA findings, Phase 1+6 LOC pending | natiii live via manual finish; F2 plaintext-email regression separate | **Ship before redesign for dedicated tier; for managed-light, the signup pipeline collapses to a single Postgres tenant creation** |
| [ENCRYPTED-PORTAL-CHANNEL-ACTIVATION-DESIGN-2026-05-07.md](ENCRYPTED-PORTAL-CHANNEL-ACTIVATION-DESIGN-2026-05-07.md) | Noise NK code-complete, 5 blockers | gated off | **Ship before redesign** — Noise NK is the transport-layer prerequisite for BIP-39 over-the-wire |
| [PURE-TRANSPORT-BOT-VISION-2026-05-20.md](PURE-TRANSPORT-BOT-VISION-2026-05-20.md) | bots become pure transports | vision, no code | **Defer** — long-term; redesign doesn't need it |
| [PER-AGENT-VOICE-DESIGN-2026-05-20.md](PER-AGENT-VOICE-DESIGN-2026-05-20.md) | per-agent voice via migration 160 + agent_customizations table | designed | **Ship before redesign** — small, isolated; survives any storage backend |
| [MOMS-VOICE-RELIABILITY-DESIGN-2026-05-20.md](MOMS-VOICE-RELIABILITY-DESIGN-2026-05-20.md) | bridge fix shipped (commit `75f55d0`); disposable code | shipped admin | **Will be deleted by PURE-TRANSPORT-BOT refactor** (per its own note); harmless under any storage |
| [MIND-FILES-ENCRYPTION-HANDOFF-2026-05-08.md](MIND-FILES-ENCRYPTION-HANDOFF-2026-05-08.md) | encrypt mind/ files; admin shipped | customer rollout pending | **Finish rollout before redesign** — the mind/ files are scoped per-host today; the multi-tenant model needs to decide where they live |
| [CADDY-CF525-HANDOFF-2026-05-18.md](CADDY-CF525-HANDOFF-2026-05-18.md) | per-customer Caddy TLS watchdog | shipped | **Discard for managed-light tier** (single Caddy); **preserve for dedicated tier** |
| [COGNITIVE-METRICS-FINALIZATION-PLAN-2026-05-08.md](COGNITIVE-METRICS-FINALIZATION-PLAN-2026-05-08.md) | D1-D7 defaults locked; Workstream C shipped admin | customer rollout pending | **Finish customer rollout before redesign**; pipeline survives storage swap |
| [TOOL-AUDIT-HANDOFF-2026-05-08.md](TOOL-AUDIT-HANDOFF-2026-05-08.md) | 36-tool surface review; findDocuments DEFERRED | open decisions | **Resolve open decisions during redesign; net-zero LOC impact** |
| [AGENT-WRITABLE-SECRETS-DESIGN-2026-05-19.md](AGENT-WRITABLE-SECRETS-DESIGN-2026-05-19.md) | 3 shapes (A/B/C) for agent secret writes | exploration | **Defer** until post-redesign |
| [ENCRYPTION-LIVE-BYPASS-TRIAGE-2026-05-08.md](ENCRYPTION-LIVE-BYPASS-TRIAGE-2026-05-08.md) | D1+D2+D3 done; D4 trip 2026-05-22; Class 1 schema pending | partial | **Ship Class 1 schema PR before redesign** — admin permanently fail-gates otherwise |
| FLEET-MIGRATIONS-PLAN.md (F2 runner) | tenant schema parity automation | UNBUILT | **Decide per tier: skip for managed-light, build for dedicated** |
| [WORKSTREAM-C-PORTAL-DESIGN-2026-05-08.md](WORKSTREAM-C-PORTAL-DESIGN-2026-05-08.md) | Cognitive Shape tab on /vitality | shipped admin | **Finish customer rollout** |

## Full classification (Round 3 Sweep L — all 63 docs)

**Distribution:** 20 SHIP-BEFORE-REDESIGN / 18 MERGE-INTO-REDESIGN / 10 PRESERVE-AS-IS / 10 DEFER-POST-LAUNCH / 5 DISCARD.

### SHIP-BEFORE-REDESIGN (20) — required live before any cutover

| Doc | Topic | Reason |
|---|---|---|
| CHANNEL-CONTEXT-ISOLATION-DESIGN-2026-05-28 | Cross-channel leak fix (4-phase) | Root cause of puh leak 2026-05-26; live production issue |
| CHANNEL-CONTEXT-HANDOFF-2026-05-28 | Companion handoff | Operator's pickup protocol |
| ACCOUNT-DELETION-PRF-BUG-DESIGN-2026-05-21 | WebAuthn PRF salt decode bug | Live QA bug blocking nati deletion (~20 LOC fix) |
| MANAGED-SIGNUP-RELIABILITY-DESIGN-2026-05-21 | 9 QA findings + Phase 6 (~105 LOC) | Required for any new dedicated-tier customer |
| ENCRYPTED-PORTAL-CHANNEL-ACTIVATION-DESIGN-2026-05-07 | Noise NK turn-on, 5 blockers | Transport prerequisite for BIP-39 over the wire |
| PER-AGENT-VOICE-DESIGN-2026-05-20 | Per-agent voice via migration 160 | Small, isolated; bundled bug fix unblocks moms |
| MIND-FILES-ENCRYPTION-DESIGN-2026-05-08 | Encrypt mind/* + snapshots | Closes CLAUDE.md §1 plaintext leakage gap |
| ATTACHMENTS-ENCRYPTION-DESIGN-2026-05-08 | D1 attachments + R2 blob encryption coverage | Three-PR plan; scanner is structural backstop |
| ENCRYPTION-LIVE-BYPASS-TRIAGE-2026-05-08 | Class 1 schema PR (wealth_* numeric types) | Admin permanently fail-gates without |
| EGRESS-PROVENANCE-HANDOFF-2026-05-06 | Phases 1–7 roadmap | Closes monologue-leak class |
| EGRESS-PROVENANCE-PHASE1-DESIGN-2026-05-06 | System-template chokepoint | Phase 1 shipped (def925b); structural |
| EGRESS-PROVENANCE-PHASE2-DESIGN-2026-05-06 | Reply MCP + inbound-context | **3 lines of wiring missing** — root cause of channel-context leak |
| EGRESS-PROVENANCE-PHASE3-DESIGN-2026-05-07 | Fallback deletion | Closes leak structurally; gates on 7d audit data |
| EGRESS-PROVENANCE-PLAN-2026-05-06 | 7-phase roadmap | Phases 0–3 are pre-launch critical |
| COMPUTE-FISHER-ERA-ADOPTION-DESIGN-2026-05-08 | era-format MAX bug fix (~15 LOC) | Blocks measurement-plane PR1 |
| FISHER-FOLLOWUPS-DESIGN-2026-05-07 | Era-format + doc fixes | Same bundle as above |
| REPLY-DEFERRAL-DESIGN-2026-05-07 | Reduce tool count 51→30 | Phase 1 shipped (caadd92); 88% reply deferral fix |
| REPLY-DEFERRAL-PHASE2-BUNDLED-DESIGN-2026-05-08 | responseNotesSection + voiceMode + voice reminder | Bundled with voice fix (~182 LOC) |
| CLEANUP-PLAN-2026-05-05 | P0 worker handler stubs + mycelium.id MCP fix | Two functional breaks remain |
| SECURITY-REMEDIATION-PLAN | npm/pip audit findings | 11 npm (2 crit), 8 intel-site (4 high), 3 Python; gates D1-D4 |

### MERGE-INTO-REDESIGN (18) — structural design that survives + integrates

| Doc | Topic | Why merges |
|---|---|---|
| ACCOUNT-DELETION-LIFECYCLE-DESIGN-2026-05-21 | DELETION_CATALOG 12 entry types | Catalog abstraction survives; execution rewrites for Postgres |
| ACCOUNT-DELETION-HANDOFF-2026-05-21 | Handoff state | Logistical; delete-related logic survives intact |
| ENCRYPTION-KEY-SAFETY-PLAN | Master key pinning + drift detection | Affects all 32 encrypted tables; survival pre-req |
| SECURE-OPERATIONS-PLAN-2026-04-25 | Swiss Vault master plan (KMS rebuild) | Supersedes encryption-key-safety; blocking for multi-tenant |
| FLEET-MIGRATIONS-PLAN | Per-tier migration strategy | Decide per tier under new architecture |
| TOOL-AUDIT-HANDOFF-2026-05-08 | findDocuments consolidation deferred | Resolve open decisions during redesign |
| MYCELIUM-REDESIGN-LIVING-SPEC-2026-05-28 | THIS DOC | Source of truth for operator decisions |
| AGENT-WRITABLE-SECRETS-DESIGN-2026-05-19 → DEFER below | (reclassified) | |
| (remaining ~10 docs: each tagged to a specific architectural decision in Part 9) | | |

### PRESERVE-AS-IS (10) — already shipped; redesign should not touch

- AGENT-RELIABILITY-HANDOFF-2026-05-07 (mind compaction PR1, 88-94% reduction shipped 4 agents)
- CLAUDE-SUBSCRIPTION-HANDOFF-2026-05-05 + PLAN (live admin)
- COGNITIVE-METRICS-SPEC-HANDOFF-2026-05-07 (spec v1.3.2 committed de259d0)
- D1-COST-CHANGE-4-DESIGN-2026-05-06 + HANDOFF (Phase 1 PR1 live)
- FLEET-CLEANUP-AND-DRIFT-HANDOFF-2026-05-07 (12 commits live, fleet-attest D1 table persists)
- MEASUREMENT-PLANE-HANDOFF + PR0.1-DESIGN + PR0.2-DESIGN (shipped through commit ad5d541)
- MIND-MODEL-COMPACTION-DESIGN-V3 + HANDOFF (shipped 2a13ecf → c447825)
- MYA-RESUME-FAILURE-DESIGN-2026-05-06 (B1 shipped b9fb7dd; C fixed by egress P3)
- OPERATIONAL-DISCIPLINE-HANDOFF-2026-05-06 (the 5-skill quartet meta-doc)
- RUNBOOK-AGENT-PROVISIONING (operational runbook in use)
- SECRETS-AND-EGRESS-HANDOFF-2026-05-07 (shipped b842c16 → 3bf65e2; leak closed)
- SESSION-HANDOFF-2026-05-05 (cleanup session summary)
- MOMS-VOICE-RELIABILITY-DESIGN-2026-05-20 (bridge fix 75f55d0; disposable)
- WORKSTREAM-C-PORTAL-DESIGN-2026-05-08 (Cognitive Shape tab shipped admin)

### DEFER-POST-LAUNCH (10) — vision/aspirational/large

- PURE-TRANSPORT-BOT-VISION-2026-05-20 (~2 weeks work, 1 week soak; not urgent)
- AGENT-WRITABLE-SECRETS-DESIGN-2026-05-19 (3 shapes; needs /sweep-first-design)
- AUTONOMOUS-CODING-DESIGN-2026-05-15 (VPS + 5-role pipeline; needs operator approval)
- MEASUREMENT-PLANE-PHASE5-DESIGN-2026-05-09 (canonical schema; 7 PRs; depends on Phase 1)
- MEASUREMENT-PLANE-PR1-DESIGN-2026-05-07 (~91 columns; Phase 6 work)
- MEASUREMENT-PLANE-PR1.5-B3-DESIGN-2026-05-08 (portal metrics endpoints; depends on PR1)
- MIND-SEARCH-UPGRADE-PLAN (Phase 0 bench harness not decided)
- MINDSCAPE-PULSES-PLAN (depends on measurement plane finalization)
- PIPELINE-COORDINATOR-PLAN (Q1-Q9 operator decisions pending)
- PUBLISHING-PLAN (federation Phase 0 already shipped; advanced features defer)
- SETTINGS-UNIFICATION-DESIGN-2026-05-06 (portal UX refactor; non-critical)
- SHARED-SPACES-PLAN (Q1-Q4 operator decisions pending)
- SPACES-CURATION-PLAN (depends on shared-spaces S1)

### DISCARD (5) — superseded or invalidated

- (5 candidates flagged for operator review; deletion is destructive so recommend over-discarding under review)
- CADDY-CF525-HANDOFF-2026-05-18 — discard for managed-light tier only; preserve for dedicated
- (Round 3 sweep L did not enumerate all 5; treat as a manual operator pass)

### Stale doc flags (>30d, may already be resolved)

- ENCRYPTION-KEY-SAFETY-PLAN.md (34d) — superseded by SECURE-OPERATIONS-PLAN; verify KMS rebuild status
- MIND-SEARCH-UPGRADE-PLAN.md (31d) — draft awaiting Phase 0 decision
- MINDSCAPE-PULSES-PLAN.md (34d) — draft; depends on measurement-plane finalization
- SHARED-SPACES-PLAN.md (34d) — Q1-Q4 pending
- PIPELINE-COORDINATOR-PLAN.md (34d) — Q1-Q9 pending
- SECURITY-REMEDIATION-PLAN.md (23d) — gates D1-D4 pending

---

# PART 6 — Open decisions (operator answers needed)

The spec listed 5; reality requires more. Numbered for tracking.

## From original spec (re-cast against reality)

1. **Launch tier** — Tier 1 (Martin only) / Tier 2 (2-5 guided) / Tier 3 (20 self-serve)?
   - Recommendation: **Tier 2.** The spec's own honest reading + Round 1 sweep evidence (24-day work scope, not 14) both point here.
2. **Key storage on client** — localStorage (insecure) / WebAuthn PRF (Chrome+Safari recent) / native keychain (mobile only)?
   - Recommendation: **WebAuthn PRF where available, localStorage with explicit "beta — keep your 24-word phrase safe, this browser store can be wiped" disclaimer otherwise.**
3. **Embedding search vs encryption** — confirm trusted-session model? Vectors plaintext, content encrypted?
   - Recommendation: **Yes for launch.** Document the limitation per CLAUDE.md §1.7. Embedding-inversion attack is real but requires sophisticated adversary; threat model for June 15 is "protect against server compromise + subpoena," not "protect against nearest-neighbor adversary."
4. **Pricing** — needed before onboarding.
   - Reality check: **Stripe is already live with €15/mo, €135/yr, €1500/decade.** Decision is "use these or change them," not "build pricing."
5. **Open-source license** — AGPL / Apache 2.0 / MIT?
   - Recommendation: **AGPL.** Strongest signal for sovereignty story; matches the public promise.

## New decisions surfaced by Round 2

19. **Repo topology going forward** — keep canonical `mycelium` (private) + AGPL `mycelium.id` mirror split, or collapse into one public AGPL repo (with private operational scripts elsewhere)?
    - Today: mirror is 7+ weeks stale; the drift creates confusion (Round 2 Sweep J read the stale mirror's BGE-M3 instead of canonical's Nomic).
    - Recommendation: **keep the split** but tighten sync cadence to monthly post-redesign-stabilization. Document the relationship in both repos' CLAUDE.md.

20. **MYA-0.2 lesson harvest** — the abandoned predecessor used **the same Postgres+pgvector stack the spec proposes**. Before committing to redesign, read MYA-0.2's git log and any handoff to understand why it was abandoned (cost? operational complexity? cold-start? Supabase tenancy?). The redesign must explicitly address those reasons.
    - Recommendation: **do this BEFORE locking the design.** It's the single highest-leverage investigation; it could either validate or invalidate the entire redesign approach.

21. **Federation Phase 0 already shipped** — WebFinger, DID (instance), publish path, share links, public profile API, Discovery DB schema. The redesign should:
    - Recognize this as a non-trivial existing asset
    - Decide what becomes Phase 0d (per-user DID) and when
    - Decide whether to ship a Discovery matching UI now (Phase 1 of federation) or defer
    - Reconcile with the spec's "OPEN" classification (revise to "Phase 0 shipped, Phase 1 in progress")

22. **Stripe `services/stripe.ts` lives in `mycelium.id` repo, not canonical** — but `stripe-webhook.ts` IS in canonical. Need to verify whether the canonical agent-server's Stripe operations call into the mirror's service file (bad — cross-repo runtime dep), are duplicated in canonical (drift risk), or have been refactored into shared `@mycelium/core`.
    - Recommendation: **audit the Stripe import chain in canonical** as a Round 3 task; pull into `@mycelium/core` if needed.

23. **100% Claude model routing today, not 80/20 open/Claude** — the spec's cost estimate assumes 80% open models. Reality: all agents use opus/sonnet/haiku fallback chains. No open-model router exists.
    - Recommendation: **before launching at the spec's cost estimate, either build a real model router OR revise the cost model to assume 100% Claude.** The math gap is significant.

24. **Whisper is Cloudflare Workers AI (paid per inference), not local whisper.cpp** — per-transcription charge previously assumed absent. Mobile transcriber repos use on-device WhisperKit; server-side Whisper goes through paid CF Workers AI.
    - Recommendation: **document this honestly in cost model.** Consider local whisper.cpp for high-volume voice use.

25. **8 agents have OPTIONAL dedicated Claude subscriptions** (`CLAUDE_CONFIG_DIR_<AGENT>`). Each = potential separate subscription. This is a tuning lever.
    - Recommendation: **document the activation policy.** Dedicated subscriptions ≈ N× subscription cost; shared ≈ 1× but with rate-limit / per-agent attribution complications.

26. **KMS_URL points to Swiss KMS server (mTLS)** — the two-tier model (tmpfs primary, KMS fallback) is the operator's defense-in-depth for the master key.
    - Recommendation: **clarify KMS_URL deployment status** (URL is filtered from env dumps for security; operator confirms whether live).
    - Possibly the **Patrik connection** — Patrik is Mycelium's cybersecurity advisor; the Swiss KMS may have come out of conversations with him. **Confirm before assuming external dependency**.

## Sustainability math (urgent)

The spec assumes:
- 20 users × €15/mo = €300/month revenue
- $800-2000/month cost (spec's estimate at 80/20 routing)

**Round 2 finding:** routing is 100% Claude today. At 3 agents × 10 calls/day × 20 users:
- Sonnet ($0.03-0.15/call): 600 calls/day × €0.09 avg ≈ **€1620/month** (low end)
- Opus ($0.15-0.75/call) mix: pushes toward **€2700-5400/month**
- Claude Code subscriptions (Pro/Max plans): different price model; could substantially reduce per-call cost but cap at message limits

**Even at Sonnet-only, 100% Claude routing at 20 users loses €1320/month against €300 revenue.** The spec's path to sustainability is:
1. Build the open-model router (effective 80% reduction in Claude spend)
2. Raise prices (€30-50/month tier)
3. Subscription-based Claude routing (Pro/Max plans for shared usage)
4. Or: limit beta to 5-10 users where the loss is sustainable from runway

**Until this is decided, the entire June 15 plan is operating on unverified economics.** Recommend: **lock pricing + routing strategy as a P0 blocker.**

## Original Round 1 decisions (re-stated)

6. **Architecture tiering** — single multi-tenant Postgres for all users, OR two tiers (managed-light Postgres + dedicated D1+VPS for high-compute users)?
   - The redesign is feasible only if this is decided. Tier 2 launch suggests starting with managed-light only and adding dedicated later.
   - **Strengthened by Round 2:** RLS pressure-test (5 HIGH findings) makes tiering even more important; the dedicated tier preserves cryptographic isolation while managed-light absorbs the RLS risk.

7. **Per-tenant agent processes vs shared agent runtime with user context** — at 20 users (60 processes) per-process per-user works; at 200 it doesn't.
   - Recommendation: **Per-tenant for Tier 2; design the user-context-switching agent runtime as a Phase 2 deliverable.**

8. **Mind-files location in multi-tenant world** — disk per-tenant (where?), or move to D1/Postgres `documents` table with the same encryption envelope?
   - Recommendation: **Move to `documents` table with `kind='mind'`.** Simpler ops, encryption parity, no fs sprawl.

9. **Existing Stripe prices** — keep €15/mo / €135/yr / €1500/decade, or revise against the $800-2000/month cost estimate (spec) at 20 users?
   - Cost estimate needs Round 2 verification against actual current spend. Likely the prices are below cost at low scale.

10. **Customer fleet under redesign** — preserve dedicated tier for current 3 customers (0mm, puh, marti) OR migrate them to managed-light Postgres?
    - Recommendation: **Preserve dedicated tier.** They are paying / load-bearing; the redesign should not destabilize them.

11. **Egress-provenance Phase 2 wiring (3 lines in send-handler.js)** — ship before redesign cutover, or defer?
    - Recommendation: **Ship before.** Root-cause fix for cross-channel leaks; tiny LOC; doesn't depend on redesign.

12. **Noise NK activation** — turn on before BIP-39 client-side encryption work, or defer?
    - Recommendation: **Turn on before.** Noise NK is the transport-layer prerequisite for any over-the-wire mnemonic / client-derived key flow.

13. **Embedding service shape** — keep per-VPS (`localhost:8091`) for dedicated tier; shared service for managed-light?
    - Open. Shared service is cheaper but adds tenant isolation surface.

14. **Phase transition detection** — ship before launch (spec promised "built"), or honest disclosure that it's deferred?
    - Recommendation: **Honest disclosure.** The honest-banner pattern (Workstream C followup) is the right precedent.

15. **WhatsApp / Email / Voice TTS** — fix-before-launch list, or defer?
    - WhatsApp is active; no fix needed.
    - Email inbound: defer post-launch.
    - Voice TTS broken on Telegram: ship per [MOMS-VOICE-RELIABILITY-DESIGN-2026-05-20.md](MOMS-VOICE-RELIABILITY-DESIGN-2026-05-20.md) or [PER-AGENT-VOICE-DESIGN-2026-05-20.md](PER-AGENT-VOICE-DESIGN-2026-05-20.md) before any user touches a voice channel.

16. **Account deletion in Postgres** — preserve DELETION_CATALOG approach with RLS-aware DELETE-by-user_id queries; how to verify zero residue when tenant data is interleaved?
    - Design challenge; Round 2 / Round 3.

17. **Schema migration discipline** — for dedicated tier, need to ship FLEET-MIGRATIONS-PLAN F2 runner; for managed-light, standard Postgres migrations. Two systems or one?
    - Recommendation: **Two.** They serve different operational contracts.

18. **Open-source what** — Mycelium *core* (storage / encryption / MCP / pipeline) per spec? Or also the operational scripts? Or the cognitive-metrics signal processing as a separate library (per "What's Next" §10)?
    - Recommendation: **Three repos.** mycelium-core (storage/crypto/MCP), mycelium-pipeline (Python signal processing), mycelium-managed (operational scripts, proprietary). AGPL the first two; keep managed proprietary.

🟡 Round 2 will add federation/discovery decisions.

---

# PART 7 — Threat model (proposed redesign vs current)

🟡 **PARTIAL — Round 3 will complete after federation sweep.**

## Current threat model (what's actually defended)

| Threat | Defense | Layer |
|---|---|---|
| Cloudflare subpoena reads user content | Worker is ciphertext passthrough; master key never leaves VPS | Storage |
| VPS host reads user content from disk | Mind files encrypted at rest (since 2026-05-08); D1 rows encrypted via crypto-local | Storage |
| Cross-tenant query leaks | Fail-closed tenant routing (Phase 2 hardening); SQL safety guardian on writes | Worker |
| Agent compromise leaks cross-scope | Scope guardians run before key unwrap; AGENT_SCOPES enforced | Crypto |
| Bot token theft → impersonation | Two-key separation (SYSTEM_KEY for secrets); tokens encrypted at rest | Crypto |
| Plaintext leaks via logging | Explicit-send chokepoints; recovery-wrapping incident (Apr 2026) drove the artifact-publish invariant | Egress |
| Ad-hoc HTTP server expose | UFW + AppArmor + CLAUDE.md §13 norm | Process |
| SSH key theft | 5-min certificates signed via 1Password Touch ID; no static keys | Access |
| Cross-channel context leak (DM → group) | INCOMPLETE — egress-provenance Phase 2 missing 3 lines; channel-context isolation design today not shipped | Egress |
| Embedding inversion | NOT DEFENDED — accepted current risk | Pipeline |

## Proposed-redesign threat model deltas

| Threat | Current defense | Proposed defense | Risk delta |
|---|---|---|---|
| Cloudflare reads user content | Worker passthrough | Postgres on Hetzner directly; no Cloudflare in the path for managed-light | Equal or better (Cloudflare not in trust path) |
| Hetzner reads Postgres on-disk | Server-side master key | Server-side master key (same model) + per-user key (new) | Better (per-user key isolates blast radius) |
| Cross-tenant row reads (RLS bypass) | Per-tenant D1 (cryptographic isolation) | RLS policies + `SET LOCAL app.current_user_id` | **WORSE** — RLS is policy-based, not cryptographic. Bug in `SET LOCAL` discipline → cross-tenant read. Mitigation: defense-in-depth via per-tenant key wrap so even if rows are read, content is unreadable |
| Embedding inversion | Not defended | Not defended; same as current | Equal |
| Trusted-session compromise | N/A (doesn't exist) | NEW: short-lived session keys, 5-min idle / 30-min max, audited | Net new defense surface |
| Mnemonic / key leaked from browser | N/A (no client key) | localStorage (weak) / WebAuthn PRF (strong) | Better defense, new attack surface |
| Forgotten 24-word phrase = permanent data loss | N/A (server-side key) | Server-recovery impossible (by design) | **Worse for UX**; better for the sovereignty promise. Requires UX investment in recovery-phrase ceremony |
| External MCP client compromise | Limited blast (local stdio) | New surface: HTTPS+JWT remote MCP; revocation pathway critical | Net new attack surface; mitigate via short-lived tokens + per-tenant rate limit |

## Two threat-model issues the spec doesn't address

1. **Postgres RLS vs cryptographic tenant isolation.** D1-per-tenant is cryptographic isolation (different bindings, separate physical databases). Postgres RLS is policy-based — one missed `SET LOCAL` is a cross-tenant read. The spec needs to acknowledge this is a *regression* in isolation strength and design compensating controls: per-user key wrap on every encrypted blob (so RLS bypass leaks ciphertext only), per-user connection pools, or extension-enforced RLS that fails closed.

2. **Trusted-session widens the plaintext-in-RAM window across users.** Today, plaintext exists only in one VPS's process memory at a time. Under multi-tenant Postgres + trusted-session, multiple users' plaintext can co-exist in the same process. Process compromise leaks across users. Mitigation: per-request process isolation (heavy), in-process per-user memory zones (medium), or accept the wider blast radius (light) with explicit threat-model disclosure.

## Round 2 — RLS pressure-test detail

Full pressure-test (Round 2 Sweep I) returned **5 HIGH / 4 MED / 1 LOW** severity findings against the proposed RLS model. **Overall verdict: NEGATIVE risk delta.** Summary table:

| # | Finding | Severity | Current code | Mitigation required |
|---|---|---|---|---|
| 1 | **SET LOCAL discipline distributed across 8+ paths** with no central enforcement. Worker `tenant-d1.ts:51-52` (header), `db-d1.js:139` (env), agent-server provisioning_jobs lookup, `mya-tools.js:43-54` (USER_ID env). | HIGH | scattered | Connection-pool middleware OWNS `SET LOCAL`; no query executes without context. Audit: assert per-query. |
| 2 | **Plaintext co-residency in process RAM** — decrypt() called 10+ times on request path; under multi-tenant, multiple users' plaintext co-exist in agent-server memory. Async spawn-task may carry plaintext across user requests. | HIGH | `crypto-local.js:756-774,965-988,871-956` | Per-request scoped buffers; clear post-response; async tasks in isolated workers with own key material. |
| 3 | **Worker passthrough → direct connection — no analog** to `validateAndResolveTenantId` under direct Postgres. | HIGH | `tenant-d1.ts:31-44,101-145` | Postgres connection middleware: after auth, spawn session with `SET LOCAL app.current_user_id`, `SET LOCAL app.scopes`. Wrap pg Client; REFUSE if SET LOCAL fails. |
| 4 | **Single master key → RLS bypass leaks all users' content.** Today, per-VPS master key + per-tenant DB is double cryptographic isolation. Under multi-tenant single-key, RLS bypass = full readable leak. | HIGH | `crypto-local.js:407-435,544-587,629-661` | Per-user master key wrap. KMS-derived per-user KEK wraps their DEK. Postgres `user_kek_encrypted` table. decrypt() loads user's KMS key before unwrap. Cache per session, NOT per process. |
| 5 | **Fail-closed missing for "user_id was never set"** — current code has fail-closed throws (`db-d1.js:880-887` REFUSE on missing key, `db-proxy.ts:178-182` 503 on missing binding); RLS equivalent needs middleware-level enforcement. | HIGH | as cited | Middleware: pre-query check `SHOW app.current_user_id` returns valid UUID; REFUSE + 403 + audit if not. Never default. |
| 6 | **Scope partitioning must flip from static env to dynamic per-request.** Today `AGENT_SCOPES` env per-process; multi-tenant requires per-request scope lookup. | MED | `db-d1.js:36-38,629-660` | Store user→scopes in Postgres `user_scopes`. Load per request from auth middleware. Pass to decrypt() dynamically. THROW if envelope scope not in request's allowed list. |
| 7 | **Operator queries need privileged role.** provisioning_jobs / handle_reservations / audit_log span tenants; today they're in separate operator D1. | MED | agent-server.js provisioning lookups | Postgres `operator` role bypasses RLS. Explicit OPERATOR_MODE env + secret check. Separate operator query path. Audit every call. |
| 8 | **Audit log RLS shape.** Today audit_log is in owner D1; under RLS, single table, but operator must read across users. | MED | `migrations/111_audit_log_rebuild.sql:7-39` | RLS: user sees own rows. Operator role bypasses. Audit reads use `operator` role only. |
| 9 | **Cross-tenant agent delegation.** `delegate_to_agent` does NOT scope delegation to same USER_ID today; multi-tenant must verify sender USER_ID == receiver USER_ID. | MED | `mcp/mya-tools.js:200-220`; `orchestrator.js:/mya/delegate` | Delegation target verifies USER_ID match. Reject cross-user. Audit failures. |
| 10 | **Mind-search RAM index sharding.** Per-user indexes (memory cost) vs shared with filter (latency) vs sharded (ops). | LOW | `packages/core/mind-search/server.js` (per-VPS today) | Tier-dependent: per-user for dedicated tier, filter-on-retrieval with metadata for managed-light. |

## Two more threat issues surfaced by Round 2

3. **Embedding inversion blast radius amplification.** Today the (plaintext) embeddings live per-tenant in D1; an RLS bypass under multi-tenant leaks ALL users' embeddings at once. The spec doesn't acknowledge this; CLAUDE.md §1.7 already flags embeddings as semantic fingerprints of plaintext, and the multi-tenant world amplifies the consequences of any bypass to N-user scale.

4. **5-minute master-key TTL pattern conflicts with long-lived Postgres connections.** Today secrets bootstrap refreshes every 5 min from Worker Secrets API and the key is on tmpfs; on rotation, the next read picks up the new key. Postgres long-lived connections cache the connection state. Rotating master key while connections are open = DEK re-wrap in-flight problem. Mitigation: connection TTL ≤ 5 min, force-close on key rotation, re-derive scope key caches per session.

---

# PART 8 — Revision history

- **v0.1 — 2026-05-28** — Initial creation. Round 1 sweeps (6 parallel Explore agents on storage, encryption, MCP/agents, pipeline, operational, portal/ingestion) folded in. Original May 28 spec preserved with inline corrections. Verification table 35/35 (11 contradicted, 13 partial, 8 verified, 3 unverified). Transfer/rebuild/discard matrix v0.1. In-flight reconciliation 15/60 docs. Open decisions list extended from 5 (original spec) to 18. Threat model v0.1 (Part 7 partial).

- **v0.2 — 2026-05-28** — Round 2 sweeps folded in:
  - **Sweep G (federation/discovery/public presence):** Part 2.7 entirely rewritten. Phase 0 federation IS shipped (WebFinger, DID instance-level, publish path + R2 backing + SEO surfaces + heartbeats, share-link tokens, public profile API, Discovery DB schema with privacy-by-design isolation). What's missing: cross-instance handlers, Discovery matching UI, per-user DID (Phase 0d), ActivityPub/Matrix/Nostr/AT-Proto entirely.
  - **Sweep H (cross-repo):** Part 2.8 new. 5 sibling repos cataloged (`mycelium.id` is open-source AGPL mirror 7 weeks stale not "public mirror of current"; `mycelium.id-site` active marketing site; `MYA-0.2` abandoned Postgres+pgvector predecessor — **the same stack the spec proposes, abandoned**; `mycelium-transcriber` macOS; `mycelium-ios` active today). License decision answered: AGPL-3.0 is locked.
  - **Sweep I (RLS pressure-test):** Part 7 expanded. 5 HIGH / 4 MED / 1 LOW severity findings. Verdict: multi-tenant RLS is feasible but requires re-architecting 5 core subsystems and audit discipline the codebase doesn't yet exhibit. Cumulative risk delta: NEGATIVE. Pushes toward tiered model (managed-light + preserved dedicated tier).
  - **Sweep J (cost reality):** Part 6 expanded with decisions 19-26 and sustainability math section. Major findings: embedding is Nomic v1.5 768D in canonical (NOT 1024D BGE-M3 — sweep J read stale mirror); Whisper is paid Cloudflare Workers AI not local whisper.cpp; model routing is 100% Claude not 80/20; €15 prices documented but at 20 users lose €1320-5100/month against €300 revenue.
  - **Repo topology disambiguation:** Canonical `mycelium` is at migration 190; mirror `mycelium.id` at 133 (7 weeks stale, last sync 2026-04-19). Federation/publish/Stripe-webhook handlers all in canonical. Stripe `services/stripe.ts` only in mirror — Round 3 needs to verify canonical's Stripe surface.
  - Verification table grew with federation rows.
  - Open decisions extended from 18 to 26.

- **v0.3 — 2026-05-28** — Round 3 sweeps folded in:
  - **Sweep K (MYA-0.2 abandonment lessons):** Part 2.8 entry rewritten with three documented abandonment reasons (Supabase write timeout cascades, Modal cold-starts/dep hell, **RLS doesn't scale to per-process multi-agent federation**). Critical: the RLS failure mode is the same architecture the May 28 spec proposes. Documented mitigation path.
  - **Sweep L (full design doc reconciliation):** Part 5 full classification table. 63 docs across 5 buckets (20 ship-before / 18 merge / 10 preserve / 10 defer / 5 discard). Stale doc flags identified.
  - **NEW Part 9: Design recommendation.** Two-tier architecture (Tier A dedicated preserved + Tier B managed-light new). B1 (shared multi-tenant agent runtime, per-request context) chosen for Tier B over B2/B3 with explicit recognition that this is the MYA-0.2 failure mode and the mitigations required. Single most important design decision identified: agent runtime model for Tier B.
  - **NEW Part 10: Implementation phasing.** Phase 0 (pre-redesign cleanup, 3-5 wk) → Phase 1 (Tier B foundation, 6-9 wk) → Phase 2 (Tier 2 launch, 2-3 wk) → Phase 3 (scale to 20, 4-8 wk) → Phase 4 (federation+native, post-launch). Total 15-25 weeks = realistic Aug-Sep 2026 launch, NOT June 15.
  - **NEW Part 11: Operator pickup list.** 18 decision points + 6 reality-answered decisions. Ordered by leverage. Recommendations included.
  - Open decisions extended from 26 to 24 active + 6 reality-confirmed.

- **v1.0 — 2026-05-28** — MEMORY.md updated with In-Progress entry pointing here; handoff section added (Part 12); spec is now the canonical artifact for the redesign work thread.

---

# PART 9 — Design recommendation

After 3 rounds of sweeps (10 Explore agents, ~9000 words of evidence, 6 self-reads), the recommended architecture is **TWO TIERS** — not a wholesale migration. Reasoning:

- **Cryptographic isolation is a real defense.** Per-tenant D1 is structurally stronger than RLS-with-trusted-session. The RLS pressure-test (5 HIGH severity findings) plus MYA-0.2's documented abandonment-by-RLS-incompatibility together say: do not throw away cryptographic per-tenant isolation lightly.
- **The current 3 customers are paying / load-bearing.** Destabilizing them to validate a new architecture would lose user trust faster than any feature can rebuild it.
- **20-user managed-light is feasible on Postgres**, IF the agent runtime is reworked to a shared multi-tenant process with per-request user context (the MYA-0.2 lesson). At that scale RLS + per-user key wrap + connection-pool middleware + trusted-session is defensible.
- **The federation Phase 0 already shipped** (WebFinger, DID, publish, share-links). Both tiers can use it. No greenfield federation work needed for Tier 2 launch.

## 9.1 Recommended architecture

### Tier A — Dedicated (preserved)

```
Per-customer Hetzner VPS (admin, 0mm, puh, marti)
├── Caddy (per-host TLS, fleet-tls-watchdog)
├── Per-customer Cloudflare D1 (mycelium-tenant-<handle>)
├── PM2: per-customer agent set (10 processes)
├── /run/mycelium/master.key tmpfs (per-VPS)
├── Worker passthrough (fail-closed tenant routing)
├── Cryptographic tenant isolation
└── update-customers.sh + verify-deploy.sh + sign-cert.sh
```

**Who:** Existing 3 customers + any future high-compute / high-value customer ("Mycelium Pro").
**Cost model:** Per-VPS amortization (~€20-50/month/VPS); customer pays €100-300/month tier.
**Migration cost:** ZERO (no change).

### Tier B — Managed-light (new)

```
Single Hetzner VPS (initial; scale-out post-Tier-3)
├── Caddy (single host, single TLS)
├── PostgreSQL 16 + pgvector
│   ├── Per-user master key wrap (so RLS bypass = ciphertext only)
│   ├── RLS policies on every content table
│   ├── Operator role bypasses RLS for fleet queries
│   └── Connection pool middleware OWNS SET LOCAL (fail-closed)
├── Shared agent runtime (Node.js, multi-tenant)
│   ├── Per-request user context (replaces per-process MYA_USER_ID)
│   ├── Per-request scoped plaintext buffers (zero across users)
│   ├── Dynamic scope partitioning (user_scopes table)
│   └── Async tasks in isolated workers with own key material
├── BIP-39 mnemonic → PBKDF2 master → HKDF scope subkeys (client-side)
├── Noise NK for over-the-wire BIP-39 (transport gate)
├── WebAuthn PRF for browser key storage (Chrome/Safari); localStorage fallback ("beta")
├── Trusted-session lifecycle (5min idle / 30min max, audited)
├── Embed service shared (Nomic v1.5 ONNX, port 8091, per-user filter)
├── Mind-search per-user index (memory) OR shared with metadata filter
├── pgvector(768) for search + pgvector(256) for clustering
└── 5-min connection TTL aligned with master-key rotation
```

**Who:** Public managed-light tier (€15/mo or revised); first 2-5 hand-picked users (Tier 2 launch), scaling to 20.
**Cost model:** Shared infra (~€100-200/month base) + per-user marginal cost (~€20-40 if model routing built, ~€80-150 if 100% Claude); pricing to cover cost.

### Federation (shared across both tiers)

- WebFinger, DID-instance, publish, share-links, public profile API — already shipped
- Per-user DID (Phase 0d) — adds for both tiers
- Cross-instance handlers (`POST /federation/connect`) — adds for both tiers
- Discovery matching UI — defer post-launch

### The single most important design decision

**Decision: How does the Tier B agent runtime handle multi-tenancy?**

Three options:

| Option | Description | Trade-off |
|---|---|---|
| **B1 — Shared process, per-request context** | One agent runtime process per agent role (10 total). Each handles ALL users by switching context per request. | Lowest cost; highest RLS/SET LOCAL discipline burden; plaintext co-residency risk |
| **B2 — Per-user process pool** | Spin up agent process per active user; tear down idle. | Higher cost; preserves per-process isolation; complex orchestration |
| **B3 — Per-user dedicated agent VPS lite** | Tiny per-user VPS (1GB RAM) with limited agent set | Most isolated; highest cost; defeats "managed-light" purpose |

**Recommendation: B1 + per-user key wrap + per-request scoped plaintext.** This is the architecture MYA-0.2 abandoned. We've identified the exact failure mode (RLS incompatibility with per-process agents) and the path through (shared multi-tenant runtime that OWNS the SET LOCAL discipline, plus per-user key wrap as defense in depth). Without this, the redesign repeats MYA-0.2.

## 9.2 What gets built new

| Component | Effort | Notes |
|---|---|---|
| Postgres schema (translated from 190 D1 migrations) | 1-2 wk | Add user-id column + RLS to every content table; add user_kek_encrypted; add user_scopes; agent_tokens preserved |
| RLS policies + operator role | 3-5 d | One policy template; per-table application; operator role bypass |
| Connection-pool middleware (owns SET LOCAL) | 1 wk | Critical security primitive; refuses query without context |
| Per-user master key wrap (KMS-derived) | 1-2 wk | Builds on existing two-key family pattern |
| BIP-39 mnemonic generation + recovery UX | 1-2 wk | New client-side path; recovery-phrase ceremony |
| WebAuthn PRF browser key storage | 1 wk | Chrome+Safari recent; localStorage fallback |
| Trusted-session lifecycle | 1-2 wk | Session keys, 5min/30min timeout, audit log |
| Shared multi-tenant agent runtime (B1) | 3-5 wk | Per-request user context; the highest-risk piece |
| Per-request scoped plaintext buffers + async isolation | 1-2 wk | Required defense for B1 |
| pgvector indexing + tuning (IVFFlat 768D + 256D) | 1 wk | Sufficient for ≤20 users; HNSW for scale-out |
| Cost router (Claude / open-model split) | 2-3 wk | Required for €15/mo sustainability |
| Federation Phase 0d (per-user DID) | 1-2 wk | Adds to both tiers |
| Stripe lifecycle for Tier B signup → tenant creation | 1 wk | Builds on existing webhook |

**Estimated: 17-30 working weeks = ~5-7 calendar months.** Not 18 days.

## 9.3 What gets preserved (zero rework)

- All encryption machinery (crypto-local.js, scope guardians, two-key family, mind-files encryption, Noise NK, agent_tokens)
- All MCP tools (37 tools across 13 domains)
- All pipeline (embed-service.py, cluster.py FAISS+Leiden, Ward HAC, compute-cofire.js, compute_information_harmonics.py, mind-search)
- All ingestion (telegram, discord, whatsapp, owntracks, imports)
- All egress chokepoints + publish path + federation Phase 0
- Stripe billing
- Account deletion DELETION_CATALOG (rewrite execution, preserve design)
- verify-deploy.sh (extend for multi-tenant)
- 19 portal routes (some adjusted for multi-user surfaces)

## 9.4 What gets discarded

- For Tier B only (Tier A keeps these): per-VPS Caddy fleet-tls-watchdog, per-customer SSH CA + sign-cert.sh, per-customer D1 bindings, update-customers.sh tarball deploy, FLEET-MIGRATIONS-PLAN F2 runner
- The May 28 spec's "stdio replacement with HTTP/SSE": rejected. Keep stdio for local; ADD HTTPS+JWT for external clients
- The May 28 spec's "everything multi-tenant Postgres": rejected. Preserve dedicated tier for existing customers
- The May 28 spec's "384-dim embeddings": rejected. Keep Nomic v1.5 768D + 256D matryoshka

# PART 10 — Implementation phasing

## Phase 0 — Pre-redesign cleanup (3-5 weeks)

Ship the **SHIP-BEFORE-REDESIGN (20 docs)** list before any redesign code starts. Order by criticality:

1. **Week 1:** ACCOUNT-DELETION-PRF-BUG (~20 LOC), CLEANUP-PLAN P0 fixes, ENCRYPTION-LIVE-BYPASS Class 1 schema PR, CHANNEL-CONTEXT-ISOLATION Phase A (3-line audit wiring fix)
2. **Week 2:** EGRESS-PROVENANCE Phase 2 wiring, ATTACHMENTS-ENCRYPTION scanner, MIND-FILES-ENCRYPTION customer rollout, COMPUTE-FISHER era-format fix
3. **Week 3:** ENCRYPTED-PORTAL-CHANNEL activation (Noise NK turn-on; 5 blockers per design), PER-AGENT-VOICE migration, MANAGED-SIGNUP-RELIABILITY Phase 6
4. **Week 4-5:** EGRESS-PROVENANCE Phase 3 (7-day audit data wait), REPLY-DEFERRAL Phase 2 bundled, SECURITY-REMEDIATION gates D1-D4

**Decision criterion to exit Phase 0:** All 20 ship-before docs landed + soaked 7 days clean. `verify-deploy.sh` passes across 4 hosts. No regression in egress_audit.

## Phase 1 — Tier B foundation (6-9 weeks)

Build the managed-light architecture in parallel with Phase 0 ship work. Start week 2 of Phase 0.

- **Weeks 1-2:** Postgres schema (translated from 190 D1 migrations); RLS policies; operator role; connection-pool middleware (the security primitive); pgvector(768) + pgvector(256) indexing
- **Weeks 3-4:** Per-user master key wrap (KMS-derived); user_scopes table; dynamic scope partitioning in crypto-local
- **Weeks 4-6:** Shared multi-tenant agent runtime (B1); per-request user context switching; per-request scoped plaintext buffers; async task isolation
- **Weeks 6-8:** BIP-39 mnemonic + recovery UX; WebAuthn PRF browser key storage; trusted-session lifecycle; Noise NK integration with BIP-39 over-the-wire
- **Week 9:** Stripe lifecycle for Tier B signup; cost router (Claude vs open-model)

**Decision criterion to exit Phase 1:** RLS + key-wrap + connection-middleware passes a deliberate cross-tenant penetration test (operator + Patrik review). Mnemonic recovery ceremony tested end-to-end. Cost router routes 80% to open-model.

## Phase 2 — Tier 2 launch (2-3 weeks)

Onboard 2-5 hand-picked users (Björn first, close collaborators after).

- **Week 1:** Onboard 2 users; observe RLS audit (zero cross-tenant queries); observe cost router (target 80%+ open-model utilization)
- **Week 2:** Onboard 3 more users; soak 7 days under real load
- **Week 3:** Triage findings; ship hotfixes; declare Tier 2 stable

**Decision criterion to exit Phase 2:** 7 days zero cross-tenant audit events. Cost per user ≤ €15/mo equivalent. No regression in dedicated tier (Tier A) operations.

## Phase 3 — Scale to 20 users (4-8 weeks)

- **Weeks 1-2:** Open self-serve signup; soft cap at 10 users; observe scaling pain points
- **Weeks 3-4:** Address scaling pain (connection pool tuning, mind-search index sharding decision, agent process count)
- **Weeks 5-8:** Open to 20; finalize pricing; publish open-source repos (mycelium-core + mycelium-pipeline AGPL-3.0; mycelium-managed proprietary)

## Phase 4 — Federation Phase 1 + native app (post-launch, undefined)

- Per-user DIDs (Phase 0d)
- Cross-instance handlers (POST /federation/connect)
- Discovery matching UI
- iOS app upgrade: server URL discovery, BIP-39 / OAuth flow, community browsing

**Total Phase 0-3: 15-25 weeks = 4-6 calendar months. Tier 2 launch (Phase 2) realistic for August-September 2026, not June 15.**

# PART 11 — Operator pickup list

The redesign is BLOCKED on the following operator decisions. Each must be answered before Phase 1 code begins. Ordered by leverage.

## Architectural decisions (must answer first)

1. **Two-tier model: accept or reject?**
   - Recommendation: **Accept.** Preserves cryptographic isolation for paying customers; absorbs RLS risk only in new managed-light tier.
   - Rejecting means choosing one architecture for all users (and accepting either: lose cryptographic isolation everywhere, OR don't scale beyond per-customer-VPS).

2. **Tier B agent runtime: B1 (shared, per-request context), B2 (per-user pool), or B3 (per-user VPS lite)?**
   - Recommendation: **B1.** Lowest cost; most aligned with managed-light economics. **But requires the highest discipline:** connection-pool middleware ownership of SET LOCAL, per-request scoped plaintext, async task isolation.
   - This is the architecture MYA-0.2 abandoned. We've documented why and how to do it differently. Without this decision, RLS choice can't be made.

3. **Tier B encryption: per-user master key wrap, or single VPS-master-key?**
   - Recommendation: **Per-user wrap.** Defense in depth against RLS bypass. Builds on existing two-key family.

4. **Phase 0 prerequisite list of 20 docs: ship all before Phase 1, or parallelize?**
   - Recommendation: **Ship all before.** Don't rebuild on broken foundations.

## Product decisions

5. **Launch tier: Tier 1 (Martin only), Tier 2 (2-5 guided), Tier 3 (20 self-serve)?**
   - Recommendation: **Tier 2.** Spec's own honest reading. June 15 unrealistic for any other.

6. **Launch date: June 15 or August-September?**
   - Recommendation: **August-September.** Phase 0 + Phase 1 = 9-14 weeks from start.

7. **Pricing: €15/mo current, or revised?**
   - Cost analysis shows €15 doesn't cover 100% Claude routing. Either build cost router (Phase 1 deliverable), raise prices, or accept loss-leading beta.

8. **Open-source license: AGPL-3.0 (already chosen)?**
   - Recommendation: **Confirm AGPL-3.0.** Already on mycelium.id repo; align canonical when ready.

9. **Open-source what: mycelium-core + mycelium-pipeline (AGPL) + mycelium-managed (proprietary), or single repo?**
   - Recommendation: **Three-way split.** Pipeline is interesting to researchers; core is the sovereignty story; managed is operationally proprietary.

## Encryption + identity decisions

10. **Key storage on client: WebAuthn PRF where available, localStorage with beta disclaimer otherwise?**
    - Recommendation: **Yes.** Document the asymmetry.

11. **Trusted session: 5 min idle / 30 min max, audited?**
    - Recommendation: **Confirm.** Add explicit audit-log entry for every session decrypt.

12. **Embedding privacy: accept plaintext vectors as known risk?**
    - Recommendation: **Yes for launch.** Document the embedding-inversion threat amplification under multi-tenant in the public threat-model.

## Operational decisions

13. **Tier A migration path for current 3 customers: preserve as-is, or eventually migrate to Tier B?**
    - Recommendation: **Preserve indefinitely.** They paid for dedicated; honor it.

14. **Per-tenant D1 schema drift (no fleet runner): build F2 runner for Tier A, or rely on `tenant-schema-parity` skill?**
    - Recommendation: **Build F2 for Tier A** (3-4 weeks). The skill is a stopgap.

15. **Stripe service file lives in stale mirror not canonical: pull into canonical `@mycelium/core` now?**
    - Recommendation: **Yes, Phase 0 task.**

16. **mycelium.id mirror sync cadence: monthly, on release, or on-demand?**
    - Recommendation: **Monthly post-redesign.**

17. **MYA-0.2 repo: archive (clean break) or retain?**
    - Recommendation: **Archive after harvesting its CLUSTERING_ROBUSTNESS_PLAN (the never-deployed checkpointing design — needed for Phase 1).**

18. **Phase 4 federation cross-instance handlers: prioritize before native app, or after?**
    - Recommendation: **After native app.** Mobile is higher-leverage for new users.

## Decisions answered by reality (re-confirming)

19. **License: AGPL-3.0** (already locked on mirror; confirm canonical adoption)
20. **Embedding model: Nomic v1.5 768D + 256D matryoshka** (canonical; correct stale spec)
21. **Clustering: Leiden + FAISS** (April 2026; correct stale spec)
22. **MCP transport: stdio for local + loopback HTTP for search + new HTTPS+JWT for external** (not pure HTTP/SSE replacement)
23. **WhatsApp ingestion: already active** (no work needed)
24. **Federation Phase 0: already shipped** (WebFinger, DID-instance, publish, share-links, public-profile API, Discovery DB schema; Phase 0d per-user DID is the next deliverable)

# Appendix A — Sweep log

**Round 1 — 2026-05-28, 6 parallel Explore agents**

| Sweep | Concern | Word output |
|---|---|---|
| A | Storage architecture reality (D1 vs SQLite, Worker role, migration count, multi-tenancy mechanism) | ~800 |
| B | Encryption + key management (master key, scopes, mind-files, Noise NK, BIP-39, trusted session, agent tokens) | ~900 |
| C | MCP surface + agent runtime (transport, full tool inventory, agent count, delegation, lane serialization) | ~1000 |
| D | Processing pipeline (embedding dim, clustering algorithm, hierarchy, harmonic, phase transitions, mind-search) | ~1000 |
| E | Operational machinery (signup, deletion, fleet, billing, monitoring, secrets) | ~1100 |
| F | Portal + ingestion + in-flight design docs (60 docs cataloged) | ~1100 |

All file:line citations preserved in agent outputs. Synthesis in Parts 2-5 above.

**Round 2 — 2026-05-28, 4 parallel Explore agents**

| Sweep | Concern | Word output | Key findings |
|---|---|---|---|
| G | Federation, discovery, public presence | ~920 | Phase 0 federation IS shipped (WebFinger, DID, publish, share-links, Discovery DB schema); Phase 1 (cross-instance handlers, Discovery UI, per-user DID) not started; zero ActivityPub/Matrix/Nostr/AT-Proto |
| H | Cross-repo inventory (5 sibling repos) | ~1450 | mycelium.id is AGPL mirror 7 weeks stale (NOT current); MYA-0.2 abandoned Postgres+pgvector predecessor (same stack spec proposes); mycelium-ios active today; AGPL-3.0 license locked |
| I | RLS pressure-test vs cryptographic isolation | ~1095 | 5 HIGH / 4 MED / 1 LOW findings; cumulative risk: NEGATIVE; needs re-architecting 5 subsystems |
| J | Cost reality + open decision evidence | ~1000 | Whisper is paid CF Workers AI (not local); routing is 100% Claude (not 80/20); €15 prices live in code; €1320-5100/month loss at 20 users; AGPL-3.0 already locked; KMS_URL = Swiss server |

**Self-read pressure-test (Round 2.5) — 2026-05-28**

- Read `~/Documents/GitHub/mycelium/scripts/embed-service.py:1-80` — confirmed Nomic v1.5 768D (canonical)
- Read `~/Documents/GitHub/mycelium.id/lib/embed.js:1-40` — confirmed BGE-M3 1024D (stale mirror)
- Read `~/Documents/GitHub/mycelium.id/CLAUDE.md` — mirror's own self-description matches BGE-M3 (provides definitive evidence the mirror is stale)
- Bash compared migrations: canonical 190 vs mirror 133 (57-migration drift)
- Bash listed handlers: federation/publishing/did/share/public-profile all in canonical; stripe.ts service file only in mirror

**Round 3 — 2026-05-28, 2 parallel Explore agents**

| Sweep | Concern | Word output | Key findings |
|---|---|---|---|
| K | MYA-0.2 abandonment lessons | ~1100 | Three documented reasons: Supabase write timeouts (CRITICAL), Modal cold-starts/dep hell (HIGH), **RLS doesn't scale to per-process agent federation (CRITICAL)** — same architecture spec proposes. Lifecycle: Jan 5 start → Feb 16 pivot to D1 → Feb 16+ frozen. CLUSTERING_ROBUSTNESS_PLAN.md:59-73 has a never-deployed checkpointing design that the redesign needs to harvest. |
| L | Full 63-doc classification | ~1200 | 20 SHIP-BEFORE-REDESIGN / 18 MERGE / 10 PRESERVE / 10 DEFER / 5 DISCARD. 6 stale docs flagged. Most critical ship-before: PRF bug, attachments encryption, channel-context isolation, egress-provenance Phase 2 (3-line fix), mind-files customer rollout, Noise NK activation. |

## Total sweep effort

| Round | Agents | Words returned | Findings |
|---|---|---|---|
| Round 1 | 6 | ~5900 | 11 spec misrepresentations; entire operational machinery surfaced |
| Round 2 | 4 | ~4465 | Federation Phase 0 shipped; 5 sibling repos; RLS NEGATIVE risk; cost reality |
| Self-reads | direct | ~200 | Embed dim disambiguated; repo topology clarified |
| Round 3 | 2 | ~2300 | MYA-0.2 RLS abandonment; full doc classification |
| **Total** | **12 agents** | **~12,800 words** | **Living spec v0.3 with full design recommendation** |
