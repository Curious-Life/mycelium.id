# Mycelium V1 — Local Setup Guide (macOS or Linux)

Stand up the self-hosted single-user MCP server on a Mac (Apple Silicon) or a
Linux home server. Every value below was verified by running the step against
the codebase. Markers: ✅ works today · ⚠️ Tier-2 (needs the ML stack).

---

## 1. Prerequisites

### Node.js 22+ (required — `package.json` engines: `node >=22`)

**macOS:**
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install node@22
```
**Linux (Debian/Ubuntu):**
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```
```bash
node --version   # must be >= 22
```

### Native build toolchain (required — `better-sqlite3` compiles a native addon)

- **macOS:** `xcode-select --install`
- **Linux:** `sudo apt-get install -y build-essential python3`

### Python 3.10+ (optional — only for the embed service in step 8)

- **macOS:** `brew install python@3.12`
- **Linux:** `sudo apt-get install -y python3 python3-venv python3-pip`

---

## 2. Clone and install

> The repo is **`mycelium.id`** (with a dot). HTTPS is simplest; use SSH only if
> you've registered an SSH key with GitHub.

```bash
cd ~
git clone https://github.com/Curious-Life/mycelium.id.git
cd mycelium.id
npm install
```

**4 dependencies:** `@modelcontextprotocol/sdk`, `better-auth`, `better-sqlite3`,
`express`. A committed `.npmrc` (`legacy-peer-deps=true`) resolves the
`better-auth` ↔ `better-sqlite3` peer tree — `npm install` works without flags.

If `better-sqlite3` fails to compile → install the build toolchain (step 1).

---

## 3. Initialize the database

```bash
npm run init-db
```

Expected output (exact):

```
init-db: 117 tables in data/mycelium.db (3 migrations: 0001_init.sql, 0002_attachments_local_path.sql, 0003_documents_publish_nonce.sql)
```

The schema *defines* 111 tables (`migrations/0001_init.sql`); the physical count
is **117** because SQLite auto-creates internal/FTS shadow tables. `0002` adds a
column (`attachments.local_path`) — no new tables.

---

## 4. Set up the two encryption keys

Mycelium uses two independent 256-bit keys (64 hex chars each): `USER_MASTER` for
your personal data, `SYSTEM_KEY` for infrastructure data. The server reads them
at boot from a **key source** you choose with `MYCELIUM_KEY_SOURCE`.

### Recommended (Mac): macOS Keychain — no keys in shell history or config

```bash
npm run set-keys            # generates both keys + stores them in the login Keychain
```

Then everything runs with `MYCELIUM_KEY_SOURCE=keychain` (steps 5/7). The keys
never touch your shell, env, or config files — boot reads them from the Keychain
on demand. Add `--show` if you also want to copy them into a password manager.

### Alternative: 1Password CLI

Store both keys as fields on a 1Password item, then point Mycelium at them
(`npm run set-keys --show` prints the exact `op` command):

```bash
export MYCELIUM_KEY_SOURCE=1password
export MYCELIUM_OP_USER="op://Private/Mycelium/user_master"
export MYCELIUM_OP_SYSTEM="op://Private/Mycelium/system_key"
```

### Alternative: plain env vars (simplest, least secure)

```bash
openssl rand -hex 32   # USER_MASTER_KEY
openssl rand -hex 32   # SYSTEM_KEY
```

⚠️ **Whichever source you pick, back BOTH keys up offline and use the SAME pair
everywhere.** On first boot the server writes `data/kcv.json` (Key Check Value)
locking the DB to these keys; any later boot with a different key → vault stays
**locked** (fail-closed). This is a safety interlock against typos/drift, not a
secret. Lose the keys = lose the vault. No recovery.

---

## 5. Boot the MCP server (stdio)

```bash
# Keychain (recommended on Mac):
MYCELIUM_KEY_SOURCE=keychain npm start

# …or with plain env vars:
USER_MASTER_KEY="<64-char-hex>" SYSTEM_KEY="<64-char-hex>" npm start
```

Expected output on **stderr** (exact):

```
[mycelium] 36 tools registered; 1 deferred (services)
[mycelium] stdio MCP server connected.
```

This boot creates `data/kcv.json` if absent. Stop with Ctrl-C — Claude Desktop
launches the server itself (step 7).

---

## 6. Run the verification suite

```bash
npm run verify
```

**15 suites** must each print `VERDICT: GO` (exit 0): foundation, mcp, mindfiles,
metrics, rest, search, topology, embed, context, ingest, blob, enqueue, enrich,
keysource, oauth. All are Tier-1 — they pass **without** Ollama/onnxruntime, so a
clean machine with no ML stack still goes fully green.

---

## 7. Configure Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
or `~/.config/Claude/claude_desktop_config.json` (Linux):

```json
{
  "mcpServers": {
    "mycelium": {
      "command": "node",
      "args": ["src/index.js"],
      "cwd": "/Users/YOUR_USERNAME/mycelium.id",
      "env": {
        "MYCELIUM_KEY_SOURCE": "keychain",
        "MYCELIUM_DATA_DIR": "/Users/YOUR_USERNAME/mycelium.id/data"
      }
    }
  }
}
```

Replace `YOUR_USERNAME`/`cwd`. With the **Keychain** (or **1Password**) source,
**no keys live in this file** — the server reads them on demand at launch. (Using
plain env vars instead? Put `USER_MASTER_KEY`/`SYSTEM_KEY` in the `env` block —
the same pair from step 4.) Restart Claude Desktop; the `mycelium` tools appear
once it connects.

> **Point at the right vault — `MYCELIUM_DATA_DIR`.** Claude Desktop launches the
> server with its own working directory, so a `cwd`-relative `./data` can resolve
> to the wrong place and the server will open a **fresh, empty** vault (the #1
> "connected but no data" gotcha). Set `MYCELIUM_DATA_DIR` to the **absolute path**
> of the `data/` directory holding your `mycelium.db` + `kcv.json` — the one
> `npm run init-db` created (here, `<repo>/data`). If your vault lives in the
> packaged Mycelium app's directory instead, point it there.

---

## 8. Optional: semantic search (⚠️ Tier-2)

The query embedder is now **wired into the server** — when the embed service is
up, the `search` tool uses 768-dim Nomic vectors; when it's down, it fail-softs
to BM25 (keyword) per query. Two processes turn it on:

**a) Embed service** (Nomic v1.5 ONNX, on `:8091`):

```bash
cd pipeline
python3 -m pip install -r requirements-embed.txt
python3 embed-service.py --serve   # NOTE: --serve is required; first launch downloads the ONNX model (~170MB)
# health check:  curl http://localhost:8091/health   → {"status":"ok","loaded":true,...}
```

**b) Enrichment service** (`:8095`) — embeds + NLP-enriches messages as they're
captured (the embed service alone stores nothing):

```bash
MYCELIUM_KEY_SOURCE=keychain npm run start:enrich   # or pass USER_MASTER_KEY/SYSTEM_KEY
```

With both running, new messages get embedded and **search retrieves
semantically**. With neither, search is BM25-only and everything else works.
Force BM25-only at any time with `MYCELIUM_DISABLE_EMBED=1`, or point at a
different embed host with `MYCELIUM_EMBED_URL`.

**c) Generate (the mindscape / topology map)** — the 5-stage clustering pipeline
(`pipeline/run-clustering.sh`) needs a heavier Python set (faiss, leidenalg, igraph,
scikit-learn, umap, scipy, cryptography…). The easiest path installs **both** the
embed and clustering deps at once:

```bash
bash pipeline/setup.sh            # venv + embed deps + clustering deps + model warmup
# or just the clustering deps into an existing venv:
pipeline/.venv/bin/python3 -m pip install -r pipeline/requirements.txt
```

These are heavy native wheels; skip them with `PIPELINE_SKIP_CLUSTER_DEPS=1 bash
pipeline/setup.sh` if you only want search. Without them, Generate fails fast with an
actionable message (embedding/search are unaffected). **Note:** this is the
dev/local-checkout workflow; a packaged `.app` does not yet bundle the pipeline
(tracked separately).

---

## 9. Optional: HTTP transport (remote access, e.g. via Tailscale)

```bash
MYCELIUM_KEY_SOURCE=keychain npm run start:http   # or pass USER_MASTER_KEY/SYSTEM_KEY
```

Starts the Streamable-HTTP + OAuth 2.1 server instead of stdio. Same `boot()`,
same tool surface, same query embedder wiring.

---

## 10. The web portal UI

Mycelium's UI is the SvelteKit app in `portal-app/`, served from the same
localhost origin as the API. **You don't build it manually** — `npm start`
(and `npm run portal`/`npm run rest`) auto-build it on first run via the
`prestart` hook, installing the portal's deps if needed:

```bash
MYCELIUM_KEY_SOURCE=keychain npm start   # first run builds the UI, then serves UI + REST at :8787
```

The first `npm start` takes ~1–2 min extra to build the UI; later runs are
instant (the build is cached). If the build is ever missing AND the auto-build
is skipped/fails, the server serves a small **"portal not built"** placeholder
that tells you to run `npm run portal:build` — it never silently serves a stale
UI. The Tauri Mac app builds the UI at bundle time, so it always ships the real
one.

To iterate on the UI with hot reload: `npm run portal:dev` (:5173). To rebuild
manually: `npm run portal:build`.

> **Note:** the canonical UI builds + is served today; wiring each screen's data
> to the local API is in progress (`portal-app/README.md`, "M2"). Until then some
> screens render empty — capture/search/library/etc. land first.

---

## Quick reference

| Action | Command |
|--------|---------|
| Install deps | `npm install` |
| Build the web portal | `npm run portal:install && npm run portal:build` |
| Start portal UI + REST | `MYCELIUM_KEY_SOURCE=keychain npm run portal` |
| Init database | `npm run init-db` |
| Set up keys (Keychain) | `npm run set-keys` |
| Start (stdio) | `MYCELIUM_KEY_SOURCE=keychain npm start` |
| Start (HTTP) | `npm run start:http` |
| Start enrichment (`:8095`) | `npm run start:enrich` |
| Run all suites | `npm run verify` |
| Embed service (`:8091`) | `python3 pipeline/embed-service.py --serve` |
| Force BM25-only | `MYCELIUM_DISABLE_EMBED=1` |
| Generate a key | `openssl rand -hex 32` |

## Key files

```
mycelium.id/
├── src/
│   ├── index.js          <- entry point + boot() (stdio / --http / --enrich); wires the query embedder
│   ├── crypto/keys.js     <- two-key unlock + KCV verification (fail-closed)
│   ├── adapter/d1.js      <- the encrypting SQLite/D1 adapter (AES-256-GCM envelope)
│   ├── db/index.js        <- assembles the per-table db namespaces over the adapter
│   ├── mcp.js             <- tool registration (36 tools + 1 deferred)
│   ├── server-http.js     <- Streamable HTTP + OAuth 2.1 transport
│   ├── embed/client.js    <- embed-service (:8091) HTTP client
│   ├── search/embedder.js <- embedder contract + service adapter (createServiceEmbedder)
│   └── tools/             <- 17 tool-domain modules
├── migrations/
│   ├── 0001_init.sql      <- schema (111 CREATE TABLE)
│   └── 0002_attachments_local_path.sql
├── pipeline/
│   ├── embed-service.py   <- Nomic v1.5 ONNX (:8091), L2-normalized vectors
│   └── requirements-embed.txt
├── scripts/
│   ├── init-db.mjs        <- database initializer
│   └── verify-*.mjs       <- the 14 verification suites
├── data/                  <- created at runtime (gitignored): mycelium.db, kcv.json
└── package.json
```

## Troubleshooting

- **"USER_MASTER_KEY and SYSTEM_KEY must be set (64-char hex each)..."** — keys
  not in the environment. Export them, or pass via the Claude Desktop MCP config.
- **"KCV failed — wrong key. Vault stays locked."** — the key pair changed after
  first boot. Restore the original keys, or (destroys data) delete
  `data/kcv.json` + `data/mycelium.db`, re-run `npm run init-db`, boot with the
  new keys.
- **`better-sqlite3` compile error** — install the build toolchain (step 1).
- **Node version error** — must be `>= 22` (`node --version`).
- **Search returns only keyword hits** — the embed service (`:8091`) isn't
  running (or nothing's been embedded yet via `:8095`). This is expected
  fail-soft behavior, not an error.
- **No `.env` loader** — the code reads `process.env` directly. Export keys or
  pass them via the Claude Desktop MCP config (recommended).
