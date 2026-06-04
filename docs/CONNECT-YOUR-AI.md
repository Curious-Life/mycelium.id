# Connect your AI to Mycelium

Mycelium is two doors in one box:

- **Memory (MCP)** — any MCP client (Claude Desktop, Claude Code, Cline, …) can read and write your vault through the Model Context Protocol.
- **Model (the gateway)** — any agent harness (opencode, Codex, Goose, Cline, Continue, OpenHands) can point its *model* base-URL at Mycelium and get **sovereign, jurisdiction-gated, audited** inference through *your own* provider keys — memory **and** model through one endpoint.

Everything below runs **on your machine** by default (loopback only). Remote access (over the internet) is the last section.

> **Model id:** when a harness needs a model name, use **`mycelium-auto`** — Mycelium routes it to whichever provider you set active in **Settings → Intelligence**.

---

## 1. Run Mycelium

Mycelium unlocks with your two 64-character hex keys. Provide them one of two ways:

**A — macOS Keychain (recommended on a Mac):** keys live in the Keychain; nothing in your shell history.
```bash
export MYCELIUM_KEY_SOURCE=keychain
```

**B — environment variables (portable):**
```bash
export USER_MASTER_KEY=<64-hex>      # your recovery key
export SYSTEM_KEY=<64-hex>           # the system key (stored alongside it)
```
*(1Password is also supported: `MYCELIUM_KEY_SOURCE=1password` + `MYCELIUM_OP_USER` / `MYCELIUM_OP_SYSTEM`.)*

Then start the surface you need:

| Command | What it starts | Port |
|---|---|---|
| `node src/index.js` | **stdio MCP** (for desktop MCP clients) | — |
| `npm run start:http` | **HTTP MCP + the model gateway** (OAuth-/bearer-guarded) | `:4711` |
| `npm run portal` | the **Settings** web UI (loopback, no auth) | `:8787` |

The HTTP server binds **`127.0.0.1` by default**; override only behind your own TLS proxy with `MYCELIUM_HTTP_HOST` (you'll get a loud warning if you do).

---

## 2. Connect a memory client over MCP

### Claude Desktop (stdio)
Add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "mycelium": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/mycelium.id/src/index.js"],
      "env": { "MYCELIUM_KEY_SOURCE": "keychain" }
    }
  }
}
```
*(No keychain? Replace `env` with `{ "USER_MASTER_KEY": "…", "SYSTEM_KEY": "…" }`.)* Restart Claude Desktop — Mycelium's tools appear, and the client is oriented by the `getContext` preamble automatically.

### Claude Code (CLI, stdio)
```bash
claude mcp add mycelium -- node /ABSOLUTE/PATH/TO/mycelium.id/src/index.js
```

### Any HTTP MCP client (`:4711`)
Run `npm run start:http`, then point the client at **`http://127.0.0.1:4711/mcp`**. Authenticate either way:
- **OAuth 2.1** — browser-based clients discover + authorize automatically (Mycelium serves the `/.well-known/oauth-authorization-server` + `/.well-known/oauth-protected-resource` metadata and runs the full DCR + PKCE flow).
- **Static bearer** — for a local tool, the low-friction path (see §4).

---

## 3. Connect a harness to the model gateway (`:4711/v1`)

The gateway speaks the OpenAI `/v1` dialect. For **any** OpenAI-compatible tool, the three facts are:

```
base URL : http://127.0.0.1:4711/v1
API key  : <your MYCELIUM_MCP_BEARER>   (see §4)
model    : mycelium-auto
```

| Harness | Where to put it |
|---|---|
| **opencode** | a provider with `baseURL: http://127.0.0.1:4711/v1`, the bearer as the key, model `mycelium-auto` |
| **Codex** | `OPENAI_BASE_URL=http://127.0.0.1:4711/v1`, `OPENAI_API_KEY=<bearer>`, model `mycelium-auto` |
| **Goose** | an OpenAI-compatible provider, host `http://127.0.0.1:4711/v1`, token = bearer |
| **Cline / Continue** | "OpenAI Compatible" provider, base URL `http://127.0.0.1:4711/v1`, model `mycelium-auto`, key = bearer |

It supports **real token streaming** (`stream: true`) and **tool calling** (`tools` round-trip to an OpenAI-compatible provider). Set the active provider + jurisdiction in **Settings → Intelligence**. Mark a single request sensitive with the header **`X-Mycelium-Sensitive: true`** to hard-block it from US providers (it falls back to your on-box local model).

---

## 4. Auth: the static bearer (copy-paste)

Generate a token and start the server with it:
```bash
export MYCELIUM_MCP_BEARER="$(openssl rand -hex 32)"   # 64 hex chars
npm run start:http
```
Use that exact value as the **API key / Bearer** in any harness above, and on `http://127.0.0.1:4711/mcp` for HTTP MCP clients.

It's **fail-closed**: off unless `MYCELIUM_MCP_BEARER` is set, must be **≥24 chars**, compared in constant time, and never logged. It works **in addition** to OAuth, on `/mcp` and every `/v1/*` route.

---

## 5. Embeddings (`:4711/v1/embeddings`)

A harness can embed text through Mycelium's own on-box model:
```
POST http://127.0.0.1:4711/v1/embeddings
{ "model": "nomic-embed-text-v1.5", "input": "…" | ["…"] }
```
This is **local-only** — it runs the on-box Nomic model and **never** sends text to a cloud embeddings provider (embedding vectors are semantic fingerprints of your plaintext). `input` accepts a string or array; `encoding_format` may be `float` (default) or `base64`; add `X-Mycelium-Embed-Task: query` for query-time embeddings (default is `document`).

---

## 6. Reach your box from the internet (remote)

To connect a client that isn't on your machine, Mycelium uses a **managed relay**: you claim a handle and your clients use

```
https://<handle>.mycelium.id/mcp     ← memory (MCP)
https://<handle>.mycelium.id/v1      ← model gateway
```

Set it up in **Settings → Remote Access** (claim a handle, set an operator password). The relay does TLS-SNI passthrough only — it never sees your key or your plaintext; TLS terminates on your machine.

> **Status (2026-06):** the on-box client side is built (the Settings flow materializes the tunnel + TLS configs). The hosted relay service itself is still being stood up, so the `<handle>.mycelium.id` path is **not live end-to-end yet** — until it is, connect locally as in §2–§5. This page will note when remote goes live.

---

## 7. Security defaults (what protects you)

- **Loopback by default.** `:4711` and `:8787` bind `127.0.0.1`; nothing is on your LAN unless you opt in.
- **Fail-closed auth.** No/!valid bearer or OAuth token → `401`. The gateway never runs on the no-auth `:8787`.
- **Jurisdiction + sensitivity.** Pick your provider's jurisdiction in Settings; `X-Mycelium-Sensitive: true` hard-blocks a request from US providers (and the cascade drops them entirely).
- **Hash-only egress audit.** Every cloud call — including tool calls — is logged as a sha256 hash + length, **never** the content.
- **Local embeddings.** `/v1/embeddings` never leaves the box.

Your keys, your box, your rules. Mycelium is the membrane — it doesn't keep a copy.
