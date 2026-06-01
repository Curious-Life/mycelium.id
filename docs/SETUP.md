# Mycelium V1 — Local Setup Guide (fresh Mac, Apple Silicon)

Stand up the self-hosted single-user MCP server on an M-series Mac. Every value
below was verified by running the step against the codebase. Status markers:
✅ works today · ⚠️ Tier-2 (needs the ML stack) · 🚧 built but not yet wired.

---

## 1. Prerequisites

### Node.js 22+ (required — `package.json` engines: `node >=22`)

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install node@22
node --version   # must be >= 22
```

### Xcode CLI tools (required — `better-sqlite3` compiles a native addon)

```bash
xcode-select --install
```

### Python 3.10+ (optional — only for the embed service in step 8)

```bash
brew install python@3.12
```

---

## 2. Clone and install

> The repo is **`mycelium.id`** (with a dot). HTTPS is the simplest for a fresh
> Mac; use the SSH URL only if you've registered an SSH key with GitHub.

```bash
cd ~
git clone https://github.com/Curious-Life/mycelium.id.git
# or, with SSH keys configured:  git clone git@github.com:Curious-Life/mycelium.id.git
cd mycelium.id
npm install
```

**4 dependencies:** `@modelcontextprotocol/sdk`, `better-auth`, `better-sqlite3`,
`express`. A committed `.npmrc` (`legacy-peer-deps=true`) resolves the
`better-auth` ↔ `better-sqlite3` peer tree — `npm install` works without flags.

If `better-sqlite3` fails to compile → run `xcode-select --install` (step 1).

---

## 3. Initialize the database

```bash
npm run init-db
```

Creates `data/mycelium.db`. Expected output (exact):

```
init-db: 117 tables in data/mycelium.db (2 migrations: 0001_init.sql, 0002_attachments_local_path.sql)
```

The schema *defines* 111 tables (`migrations/0001_init.sql`); the physical count
is **117** because SQLite auto-creates internal/FTS shadow tables. `0002` adds a
column (`attachments.local_path`), no new tables.

---

## 4. Generate two encryption keys

Two independent 256-bit keys (64 hex chars each):

```bash
openssl rand -hex 32   # USER_MASTER_KEY — encrypts your personal data
openssl rand -hex 32   # SYSTEM_KEY      — encrypts system/infrastructure data
```

⚠️ **Save BOTH in a password manager, and use the SAME pair everywhere** (boot in
step 5 *and* the Claude Desktop config in step 7). On first boot the server
writes `data/kcv.json` (Key Check Value) that locks the DB to these exact keys.
Any later boot with a different key → vault stays **locked** (fail-closed). Lose
the keys = lose the vault. No recovery.

---

## 5. Boot the MCP server (stdio)

```bash
USER_MASTER_KEY="<64-char-hex>" SYSTEM_KEY="<64-char-hex>" npm start
```

Expected output on **stderr** (exact):

```
[mycelium] 31 tools registered; 2 deferred (reply, services)
[mycelium] stdio MCP server connected.
```

This boot creates `data/kcv.json` if it doesn't exist. Stop with Ctrl-C — Claude
Desktop will launch the server itself (step 7).

---

## 6. Run the verification suite

```bash
npm run verify
```

**15 suites** must each print `VERDICT: GO` (exit 0): foundation, mcp, mindfiles,
metrics, rest, search, topology, embed, context, ingest, blob, enqueue, enrich,
inference, oauth. All are Tier-1 — they pass **without** Ollama/onnxruntime, so a
clean Mac with no ML stack still goes fully green.

---

## 7. Configure Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mycelium": {
      "command": "node",
      "args": ["src/index.js"],
      "cwd": "/Users/YOUR_USERNAME/mycelium.id",
      "env": {
        "USER_MASTER_KEY": "<64-char-hex>",
        "SYSTEM_KEY": "<64-char-hex>"
      }
    }
  }
}
```

Replace `YOUR_USERNAME` and use the **same two keys from step 4**. Keys in the MCP
config stay out of shell history. Restart Claude Desktop; the `mycelium` tools
appear once it connects.

---

## 8. Optional: embeddings & semantic search (⚠️ Tier-2 / 🚧 partially wired)

Read this carefully — the moving parts don't yet form end-to-end semantic search.

**a) Run the embed service** (Nomic v1.5 ONNX, 768-dim, on `:8091`):

```bash
cd pipeline
python3 -m pip install -r requirements-embed.txt
python3 embed-service.py      # first launch downloads the ONNX model
# health check:  curl http://localhost:8091/health
```

**b) Run the enrichment service** to actually *write* embeddings. The embed
service alone does nothing — embeddings are produced by the `:8095` enrichment
worker, which connects to `:8091` and embeds messages on capture:

```bash
USER_MASTER_KEY="<key>" SYSTEM_KEY="<key>" npm run start:enrich
```

**What you get today:** new messages get embedded + NLP-enriched and stored as
encrypted vectors. **What you don't get yet:** the MCP `search` tool's *query*
path is **BM25 (keyword) only** — `boot()` in `src/index.js` currently leaves the
query embedder unwired (a known TODO). So semantic *retrieval* through the server
isn't active even with `:8091` up. Without step 8 at all, search is simply
BM25-only and everything else works.

---

## 9. Optional: HTTP transport (remote access, e.g. via Tailscale)

```bash
USER_MASTER_KEY="<key>" SYSTEM_KEY="<key>" npm run start:http
```

Starts the Streamable-HTTP + OAuth 2.1 server instead of stdio. Same `boot()`,
same tool surface.

---

## Quick reference

| Action | Command |
|--------|---------|
| Install deps | `npm install` |
| Init database | `npm run init-db` |
| Start (stdio) | `npm start` |
| Start (HTTP) | `npm run start:http` |
| Start enrichment (`:8095`) | `npm run start:enrich` |
| Run all suites | `npm run verify` |
| Embed service (`:8091`) | `python3 pipeline/embed-service.py` |
| Generate a key | `openssl rand -hex 32` |

## Key files

```
mycelium.id/
├── src/
│   ├── index.js          <- entry point + boot() sequence (stdio / --http / --enrich)
│   ├── crypto/keys.js     <- two-key unlock + KCV verification (fail-closed)
│   ├── adapter/d1.js      <- the encrypting SQLite/D1 adapter (AES-256-GCM envelope)
│   ├── db/index.js        <- assembles the per-table db namespaces over the adapter
│   ├── mcp.js             <- tool registration (31 tools + 2 deferred)
│   ├── server-http.js     <- Streamable HTTP + OAuth 2.1 transport
│   ├── inference/         <- Component 6: local Ollama + BYOK cloud router
│   └── tools/             <- 17 tool-domain modules
├── migrations/
│   ├── 0001_init.sql      <- schema (111 CREATE TABLE)
│   └── 0002_attachments_local_path.sql
├── pipeline/
│   ├── embed-service.py   <- Nomic v1.5 ONNX (:8091)
│   └── requirements-embed.txt
├── scripts/
│   ├── init-db.mjs        <- database initializer
│   └── verify-*.mjs       <- the 15 verification suites
├── data/                  <- created at runtime (gitignored): mycelium.db, kcv.json
└── package.json
```

## Troubleshooting

- **"USER_MASTER_KEY and SYSTEM_KEY must be set (64-char hex each)..."** — keys
  not in the environment. Export them, or pass via the Claude Desktop MCP config.
- **"KCV failed — wrong key. Vault stays locked."** — the key pair changed after
  first boot. Either restore the original keys, or (destroys data) delete
  `data/kcv.json` + `data/mycelium.db`, re-run `npm run init-db`, and boot with
  the new keys.
- **`better-sqlite3` compile error** — `xcode-select --install`.
- **Node version error** — must be `>= 22` (`node --version`).
- **No `.env` loader** — the code reads `process.env` directly. Export keys in
  your shell, or pass them via the Claude Desktop MCP config (recommended).
