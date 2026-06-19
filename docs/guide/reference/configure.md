# Run & configure

Run modes, ports, and every environment variable. Mycelium is pure **Node.js (≥22)** —
no Docker required.

## Install from source

```bash
git clone https://github.com/Curious-Life/mycelium.id && cd mycelium.id
npm install --legacy-peer-deps
npm run set-keys        # generates your ONE recovery key (USER_MASTER); SYSTEM_KEY
                        # is HKDF-derived; both stored in the OS keychain
npm run verify          # full suite → a wall of "VERDICT: GO"
```

No `init-db` step — a fresh vault self-migrates on first boot.

## Run modes

One entry point (`src/index.js`), selected by flag or env var:

| Command | Starts | Port | Auth |
|---|---|---|---|
| `npm start` | **stdio MCP** — for desktop MCP clients | — (stdin/stdout) | OS keychain keys |
| `npm run start:http` | **HTTP MCP + model gateway** + `/ingest/*` + `/context` | `:4711` | OAuth 2.1 / bearer |
| `npm run portal` | **portal** web UI + REST (`/api/v1`) | `:8787` | none (loopback) |
| `npm run start:enrich` | **enrichment** service (background embed + tag) | `:8095` | — |
| `npm run public` | **public publish** server (`/p/:slug`, fail-closed) | `:8788` | none (serves only published) |

A Python **embed service** (`pipeline/embed-service.py`, `:8091`, loopback) provides
real Nomic embeddings; search **fail-softs to BM25** when it's down.

## Ports at a glance

| Port | Server | Bind |
|---|---|---|
| `:4711` | HTTP MCP + gateway + ingest | `127.0.0.1` (override with care) |
| `:8787` | Portal + REST | `127.0.0.1` only |
| `:8788` | Public publish | configurable |
| `:8095` | Enrichment | `127.0.0.1` |
| `:8091` | Embed service (Python) | `127.0.0.1` only |

## Environment variables

### Keys & vault location

| Var | Purpose |
|---|---|
| `MYCELIUM_KEY_SOURCE` | Where keys come from: `env` (default) · `keychain` · `1password` |
| `USER_MASTER_KEY` / `SYSTEM_KEY` | The two 64-hex keys (when `MYCELIUM_KEY_SOURCE=env`) |
| `MYCELIUM_OP_USER` / `MYCELIUM_OP_SYSTEM` | 1Password item refs (when source = `1password`) |
| `MYCELIUM_DATA_DIR` | Vault location. The app sets this; **you must set it** in a hand-rolled stdio config, or you'll hit an empty `./data` vault. |
| `MYCELIUM_DB` / `MYCELIUM_KCV` / `MYCELIUM_AUTH_DB` | Explicit path overrides (else under `<dataDir>/`) |

### Transport & auth

| Var | Purpose |
|---|---|
| `MYCELIUM_HTTP=1` / `--http` · `MYCELIUM_ENRICH=1` / `--enrich` · `MYCELIUM_PUBLIC=1` / `--public` | Select the transport / aux server |
| `MYCELIUM_HTTP_HOST` | Bind host for `:4711` (default `127.0.0.1`; loud warning if changed — only behind your own TLS proxy) |
| `MYCELIUM_MCP_BEARER` | Static bearer for `/mcp` + `/v1/*` (≥24 chars; auto-provisioned by the app, explicit value wins) |
| `MYCELIUM_AUTH_SECRET` | **Mandatory** for HTTP — OAuth signing secret (fail-closed) |
| `MYCELIUM_USER_PASSWORD` | The real OAuth auth gate (your sign-in password) |

### Search & debug

| Var | Purpose |
|---|---|
| `MYCELIUM_DISABLE_EMBED=1` | Force BM25-only search (skip the embed service) |
| `MYCELIUM_EMBED_URL` | Point at a different embed service |
| `MYCELIUM_DEBUG=1` | Print tool-failure stacks to **stderr only** (off by default — errors can embed user content) |
| `MYCELIUM_IMPORT_ALLOWED_ROOTS` | Extra directories the [local import routes](rest-and-ingest.md#import-from-local-sources-8787) may read from (OS path-list separated, e.g. `/a:/b`). The import allowlist is Obsidian vaults + `~/.claude/projects` by default; add a `mycelium-full-export` bundle's parent here to import it. |
| `MYCELIUM_OBSIDIAN_IMPORT_LIMIT_MB` | Request-body ceiling for the browser-mode Obsidian import (default `256`). |

### Ports

| Var | Default |
|---|---|
| `MYCELIUM_PORT` | `4711` |
| `MYCELIUM_REST_PORT` | `8787` |
| `MYCELIUM_PUBLIC_PORT` | `8788` |
| `MYCELIUM_ENRICH_PORT` | `8095` |

## Verify your setup

```bash
npm run verify         # full suite, every subsystem → VERDICT: GO
npm run verify:mcp     # stdio MCP proof in isolation → tool count + GO
npm run verify:oauth   # full OAuth dance over HTTP → tools/call
```

Every subsystem has a `scripts/verify-*.mjs` that boots real code, exercises it, and
prints a PASS/FAIL ledger with an exit code. **Tier-1** suites pass anywhere; **Tier-2**
parity (real Nomic embeddings, real clustering) needs the Python ML stack and SKIPs
cleanly elsewhere.

---

→ Connect a client: **[Connect an agent](connect.md)** · The HTTP surface:
**[REST & ingest](rest-and-ingest.md)**.
