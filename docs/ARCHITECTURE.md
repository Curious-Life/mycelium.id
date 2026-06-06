# Mycelium V1 — System Architecture (as built)

> **As-built**, not as-designed. This doc describes what the code *currently is*.
> For a narrative walkthrough of how it all fits together, see
> [`HOW-IT-WORKS.md`](HOW-IT-WORKS.md). The *plan* (what we're building + order)
> lives in [`V1-BUILD-SPEC.md`](V1-BUILD-SPEC.md); the running build journal lives
> in the `V1-BUILD-HANDOFF-*.md` files. Kept current via the `living-docs` skill.
> Status markers: ✅ built+verified · ◑ partial · ⚠️ Tier-2/gated · ⬜ planned.

## 1. What it is

A self-hosted, **single-user** MCP server — a private "cognitive vault." It
ingests a person's messages/documents, encrypts everything at rest, embeds +
enriches it locally, and serves it back to an MCP client (Claude Desktop/CLI/
mobile) through tools. No multi-tenancy, no autonomous agent loop — it's a pure
tool server (decision D5).

## 2. Process model & run modes

One Node entry point, `src/index.js`, selects a mode:

| Mode | Command | Surface |
|---|---|---|
| MCP stdio (default) | `npm start` | MCP over stdio for a local client |
| MCP Streamable HTTP | `npm run start:http` (`--http` / `MYCELIUM_HTTP=1`) | remote MCP + OAuth — **binds 127.0.0.1 only**; reached over the internet via the TLS-passthrough relay (Caddy terminates TLS on this Mac) |
| REST | `npm run rest` | REST over the shared handler map |
| Portal (UI + REST) | `npm run portal` | portal at `/` + REST `/api/v1/*`, localhost-only |
| Enrichment service | `npm run start:enrich` (`--enrich`) | the `:8095` background enricher |

**Portal UI — two coexisting.** The **canonical** SvelteKit app (`portal-app/`,
the real production UI) is served at `/` once built (`npm run portal:build` →
`portal-app/build`, a static SPA); the Node server (`src/server-rest.js`,
`resolvePortal()`) auto-detects it, serves it with SPA fallback to `200.html`,
and otherwise falls back to the single-file `portal/index.html`. Override with
`MYCELIUM_PORTAL=canonical|legacy|auto`. The canonical app's data layer
(`portal-app/src/lib/api.ts`) calls cloud `/portal/*` paths, rewritten to
`/api/v1/portal/*` and served by a **compatibility surface** (three routers,
below) that returns the exact shapes the screens expect, backed by the local db.
The primary nav is the honest V1 set (Mindscape · Library · Import · Timeline ·
Profile · Settings) + a disabled "Coming later" group; screens with no V1 data
source degrade to a graceful empty state. Best iterated visually on the Mac
(`npm run portal:dev`). See `portal-app/README.md` and
[`UX-COMPLETE-DESIGN-2026-06-01.md`](UX-COMPLETE-DESIGN-2026-06-01.md).

A **native Mac shell** (`src-tauri/`, Tauri v2) wraps the portal: it spawns the
Node server and opens a window at `http://127.0.0.1:8787` (so it shows whichever
portal the server serves — build `portal-app` to get the canonical UI). Portals
are verified by `verify:portal` (single-file) + `verify:portal-serve`
(canonical serving); the Rust shell is built on the Mac (`src-tauri/BUILD-MAC.md`).

Two **sidecar services** run as their own processes:
- **`:8091` embed-service** — Nomic v1.5 ONNX embeddings (`pipeline/embed-service.py`), ⚠️ Tier-2 (needs onnxruntime/model installed).
- **`:8095` enrichment** — embed-on-write + NLP drain (`src/enrich/server.js`). ✅

## 3. Components

| Component | Path | Status |
|---|---|---|
| Entry point / mode switch | `src/index.js` | ✅ |
| MCP server (tool registration) | `src/mcp.js` | ✅ |
| Streamable HTTP transport | `src/server-http.js` | ✅ |
| REST surface + file upload | `src/server-rest.js`, `src/api.js` (`/api/v1/upload`) | ✅ |
| Canonical portal (SvelteKit) | `portal-app/` → `npm run portal:build` (served by REST) | ✅ builds + served; core screens wired |
| Portal compat surface (`/api/v1/portal/*`) | `src/portal-compat.js` (Library/Timeline/Profile/Settings/onboarding), `src/portal-mindscape.js` (3D scene + panels), `src/portal-uploads.js` (import: multipart + chunked) | ✅ |
| Local auth-shim (no login wall) | `src/auth-shim.js` | ✅ |
| Import parsers (Claude / ChatGPT) | `src/ingest/import-parsers.js` | ✅ (Obsidian/LinkedIn ⬜) |
| Generate-mindscape trigger (clustering job) | `src/jobs.js` + `POST /api/v1/portal/mycelium/generate` | ✅ (job lifecycle; real run ⚠️ Tier-2) |
| Chronicle narration | `pipeline/describe-chronicles.js` (run-clustering stage) | ✅ (logic; real model ⚠️ Tier-2) |
| Local portal (single-file SPA) | `portal/index.html` (REST fallback) | ✅ |
| Native Mac shell (Tauri) | `src-tauri/**` | ◑ scaffold (build on Mac) |
| OAuth 2.1 + PKCE (better-auth) | `src/auth.js` | ✅ |
| D1/SQLite storage adapter | `src/adapter/d1.js` | ✅ |
| DB namespaces (per table) | `src/db/*.js` | ✅ |
| Migration runner | `src/db/migrate.js` + `migrations/000*.sql` | ✅ |
| Scope-partitioned crypto (two-key vault) | `src/crypto/crypto-local.js`, `src/crypto/keys.js`, `src/crypto/guardians/*` | ✅ |
| Master-key source (env / macOS Keychain / 1Password) | `src/crypto/key-source.js`, `scripts/set-keys.mjs` | ✅ |
| Account keystore (single recovery key; SYSTEM_KEY HKDF-derived) | `src/account/keystore.js`, `src/account/keychain-names.js` | ✅ (#36) |
| First-run ceremony + restore + re-view (setup-mode) | `src/account/router.js` (`/api/v1/account`), `portal-app/src/routes/setup/` | ✅ (#36) |
| Data location (durable per-OS dir; survives updates) | `src/paths.js` (`MYCELIUM_DATA_DIR`) | ✅ (#36) |
| Embeddings client + search adapter | `src/embed/client.js` (→ `:8091`), `src/search/embedder.js` (`createServiceEmbedder`) | ✅ (real vectors ⚠️ Tier-2) |
| Inference router (local Ollama + BYOK cloud) | `src/inference/{router,local,cloud,errors}.js` | ✅ (real models need Ollama/keys) |
| Search (BM25 + vector + RRF fusion) | `src/search/**` | ✅ |
| Topology / AnalysisEngine pipeline | `src/topology.js`, `src/topology/helpers.js`, `pipeline/` | ✅ (real run ⚠️) |
| Ingestion choke-point + uploads | `src/ingest/{capture,upload,blob-store,enqueue}.js` | ✅ |
| Enrichment service (embed + NLP) | `src/enrich/{service,server,extract}.js` | ✅ |
| MCP tools (36 across 17 domains) | `src/tools/*.js` | ✅ |
| Box identity (ed25519 from master key) | `src/identity/identity.js` | ✅ |
| Publishing: signed links + fail-closed public server | `src/publish/{links,public-server}.js` | ✅ (custom-domain; mycelium.id handle = central infra, planned) |
| Mind-files subsystem | `src/mindfiles/mind-files.js` | ✅ |

## 4. Data flow — capture → searchable

```
client/connector
   │  captureMessage / /ingest  (the single ingestion choke-point)
   ▼
src/ingest/capture.js ──► messages row (content encrypted at rest)
   │  fire-and-forget nudge (src/ingest/enqueue.js)
   ▼
:8095 enrichment service (src/enrich/server.js)
   ├─ Stage 1  drainOnce      nlp_processed 0 → 2   embed via :8091, store vector envelope
   └─ Stage 2  enrichNlpOnce  nlp_processed 2 → 1   extract entities/tags/summary (rules)
   ▼
search (BM25 + vector, RRF fusion)  +  getContext preamble (D5)
   ▼
back to the client as tool results
```

**Ingest surfaces & volume:** raw files upload to `/api/v1/upload` (raw bytes,
dependency-free) → encrypted blob → attachment → message → enrich. Bulk history
via `importMessages`. The portal **Import** screen posts AI-export archives
(Claude / ChatGPT `.zip`) to `/api/v1/portal/upload[/chunk|/complete]`
(`src/portal-uploads.js`, multipart via busboy, single-shot + chunked assembly);
they're parsed (`src/ingest/import-parsers.js`) and funneled through
`captureMessage`. The untrusted-file path is hardened (decompression-bomb cap
with streaming abort, bounded in-memory assembly, no archive-path writes, no
content leakage) — see `verify:import-security`. Limits: `MYCELIUM_API_BODY_LIMIT`
(64mb JSON), `MYCELIUM_UPLOAD_LIMIT` (256mb raw), `MYCELIUM_IMPORT_LIMIT_BYTES`
(512mb per import).

**Query embedder wiring:** `boot()` (`src/index.js`) auto-wires the query-time
embedder via `resolveDefaultEmbedder()` → `createServiceEmbedder()` (an adapter
that bridges the embed client's positional-task signature to the search
embedder's `{task}` contract, and reports `unit:true` since the embed-service
L2-normalizes). The backend fail-softs to BM25 per query when `:8091` is down.
Opt out with `MYCELIUM_DISABLE_EMBED=1`; redirect with `MYCELIUM_EMBED_URL`.

Enrichment state machine (faithful to the canonical model): **`0 unprocessed →
2 embedded → 1 enriched → -1 failed`**. The NLP pass (`src/enrich/extract.js`)
is a pure deterministic rules extractor (url/email/money/date/proper-noun/
hashtag + keyword tags) behind a seam a model-backed pass can replace.

## 5. Storage & schema

- **Engine:** better-sqlite3 with a D1-compatible adapter (`src/adapter/d1.js`),
  so the same code runs on Cloudflare D1 later.
- **Schema:** all V1 tables ported in `migrations/0001_init.sql`; `0002` adds
  `attachments.local_path` for the local blob store. Applied by `src/db/migrate.js`.
- **Blobs:** uploaded files encrypted to a local blob store (`src/ingest/blob-store.js`).
- **Location (#36):** the vault lives in a **durable per-OS data dir** (`src/paths.js` →
  `~/Library/Application Support/id.mycelium.app` on macOS, set by the Tauri shell as
  `MYCELIUM_DATA_DIR`), so app updates don't wipe history. A legacy in-repo `./data` vault is
  **non-destructively relocated** on first boot. A fresh vault **self-migrates** (no separate
  `init-db`). ⚠️ A hand-rolled stdio MCP config (`node src/index.js`) must set
  `MYCELIUM_DATA_DIR` to the same dir, else it opens a different, empty vault.

## 6. Security model

- **Single recovery key** (#36, amends D4 + D6): the user saves only `USER_MASTER`
  (64-char hex); `SYSTEM_KEY` is **HKDF-SHA256-derived** from it (`src/account/keystore.js`).
  No BIP-39. Per-key KCV still guards typos; both keys land in the Keychain so the boot/unlock
  path is unchanged. The keys are no longer independent (accepted: SYSTEM_KEY only encrypts the
  normally-empty operator `secrets` table). A lost key is unrecoverable by design — so creation
  forces a save-it gate, and the key is re-viewable in Settings / restorable by paste.
- **Key source** (`src/crypto/key-source.js`, `MYCELIUM_KEY_SOURCE`): the two hex
  keys are read at boot from `env` (default), the **macOS Keychain**, or
  **1Password** (`op`). Keychain/1Password keep keys out of shell history and
  config files (and out of the process env until unlock). Shell-injection-safe
  (`execFile` arg arrays), fail-closed, never logged. `npm run set-keys` provisions.
  KCV (above) stays as the integrity interlock regardless of source.
- **Envelope encryption:** AES-256-GCM wrapped-DEK (`src/crypto/crypto-local.js`).
  `ENCRYPTED_FIELDS` are encrypted/decrypted transparently by the adapter on
  write/read — callers handle plaintext, storage holds ciphertext.
- **Keys are memory-only** after unlock; never in env/DB/logs/HTTP.
- **Fail closed:** missing key → refuse to write; missing auth → reject.
- **Embeddings are sensitive** — stored as ciphertext envelopes, treated like plaintext.
- Full principles in [`../CLAUDE.md`](../CLAUDE.md) §"Security first".

## 7. Transports & auth

- **stdio** (local client), **Streamable HTTP** (`src/server-http.js`), and a
  **REST** surface (`src/server-rest.js`) all dispatch through one shared handler
  map, so a tool is written once.
- **OAuth 2.1 + PKCE** via better-auth (`src/auth.js`) guards the HTTP surfaces.

## 8. Ports

| Port | Service | Status |
|---|---|---|
| `:8091` | Nomic embed-service (Python) | ⚠️ Tier-2 |
| `:8095` | enrichment service (Node) | ✅ |
| HTTP/REST | configurable (MCP HTTP + REST) | ✅ |

## 9. Verification

`npm run verify` runs **29 GO-gated suites** (`scripts/verify-*.mjs`), each with
a PASS/FAIL ledger + VERDICT line: foundation, mcp, mindfiles, metrics, rest,
search, topology, embed, oauth, context, ingest, blob, enqueue, enrich,
keysource, **account** (#36 — setup/restore/recovery-key + single-key derivation;
skips cleanly with no Keychain), portal, portal-serve, portal-data,
portal-mindscape, import, import-timestamps, import-security, portal-tps, generate,
chronicles, integration, nav, inference, publish. CI
(`.github/workflows/verify.yml`) runs them on every PR. **Tier-1** suites pass
without the ML stack; **Tier-2** parity (real embeddings/clustering) is verified
on a host with onnxruntime/Ollama installed. Portal/SPA-dependent checks SKIP
cleanly when `portal-app/build` is absent (as in CI).

## 10. Built vs planned (vs the spec)

✅ **Built + verified:** D1 adapter, MCP server (stdio), HTTP + REST transports,
OAuth 2.1, two-key vault encryption, search, topology pipeline, getContext (D5),
ingestion + encrypted uploads, full enrichment pipeline (embed + NLP rules),
query embedder wiring, master-key source (env/Keychain/1Password + `set-keys`),
inference router (local Ollama + BYOK cloud, opt-in egress), 36 tools, local
portal UI (capture/search/mindscape/tasks + tools console). **Canonical portal
build-out:** tight nav + "Coming later"; Mindscape read surface (3D scene
aggregator + panels); **Claude/ChatGPT import** (single-shot + chunked, hardened);
Timeline/Profile/Settings; first-run welcome — all behind their own verify suites.

⚠️ **Built, Tier-2-gated:** real Nomic embeddings + clustering (need onnxruntime/
Ollama on the host); inference router's *cloud* path needs a BYOK key, its
*local* path needs Ollama running.

◑ **Scaffolded (build on Mac):** native Tauri shell (`src-tauri/`) — wraps the
portal into `Mycelium.app`; Rust built on the Mac per `src-tauri/BUILD-MAC.md`.

⬜ **Planned / not yet built:** agent templates, the Tauri native first-run
key-setup ceremony (designed — `UX-COMPLETE-DESIGN` §5 — Mac/Rust build pending),
profile *editing* (`PUT /portal/profile` — needs a profile store), the
`/mindscape/explore` territory-description job, Obsidian/LinkedIn import.
**Remote-connect transport is now built** (TLS-passthrough: bundled `frpc`+`caddy`,
key-on-Mac ACME via acme-dns, loopback `--http`, + the open-source `mycelium-managed/`
control-plane — see `REMOTE-CONNECT-TRANSPORT-DESIGN` + `REMOTE-CONNECT-MANAGED-DESIGN`;
standing up the live relay/DNS/acme-dns/LE infra is the operator's deploy). The control-plane
now carries the onboarding/relay-billing layer (`DESIGN-onboarding-and-relay-billing-2026-06-05`):
a `public_key`-keyed entitlement table (O3) and an **opt-in, fail-closed Turnstile bot-gate**
on `/v1/challenge` (O2, `mycelium-managed/src/turnstile.js`; secret env-only, single-side
verification — the nonce carries the proof to provision; `verify:turnstile` GO). The app's
connect widget renders Turnstile in a **cross-origin iframe** served by the control-plane
(`GET /turnstile`), so Cloudflare's script runs in the control-plane origin and never in the
vault portal — only the solved token `postMessage`s back (browser smoke pending). Billing
(O4/O5, `mycelium-managed/src/billing.js` — no SDK, REST + `node:crypto`) adds a **reserve-then-pay**
gate: an unentitled `/v1/provision` holds the handle and returns `402 {checkoutUrl}` before any
cert side-effect; a fail-closed `POST /v1/stripe/webhook` (raw-body HMAC verify) flips
`paid_until`. Opt-in (off without `MYC_STRIPE_SECRET` → free); `verify:billing` + `verify:provision` GO. (The in-app
"generate mindscape" trigger + chronicle narration are also **built** — see the
component table.) See
[`V1-BUILD-SPEC.md`](V1-BUILD-SPEC.md) §"What's left".
