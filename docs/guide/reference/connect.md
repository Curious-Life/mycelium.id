# Connect an agent

Mycelium is two doors in one endpoint:

- **Memory (MCP)** — any MCP client (Claude Desktop, Claude Code, Cline, …) reads and
  writes your vault through the Model Context Protocol.
- **Model (gateway)** — any OpenAI-compatible harness points its model base-URL at
  Mycelium and gets sovereign, jurisdiction-gated, audited inference through your own
  provider keys.

Everything below runs **on your machine** (loopback) by default. Remote access is the
last section.

> **Model id:** when a harness asks for a model name, use **`mycelium-auto`** —
> Mycelium routes it to whichever provider you set active in Settings → Intelligence.

---

## 1. Run Mycelium

Mycelium unlocks with your hex key(s). Provide them one of two ways:

**A — macOS Keychain (recommended on a Mac):**
```bash
export MYCELIUM_KEY_SOURCE=keychain
```

**B — environment variables (portable):**
```bash
export USER_MASTER_KEY=<64-hex>      # your recovery key
export SYSTEM_KEY=<64-hex>           # stored alongside it (or HKDF-derived)
```
*(1Password also works: `MYCELIUM_KEY_SOURCE=1password` + `MYCELIUM_OP_USER` / `MYCELIUM_OP_SYSTEM`.)*

Then start the surface you need:

| Command | Starts | Port |
|---|---|---|
| `node src/index.js` (`npm start`) | **stdio MCP** — for desktop MCP clients | — |
| `npm run start:http` | **HTTP MCP + the model gateway** (OAuth-/bearer-guarded) | `:4711` |
| `npm run portal` | the **portal** web UI (loopback, no auth) | `:8787` |

The HTTP server binds **`127.0.0.1` by default**. Override only behind your own TLS
proxy with `MYCELIUM_HTTP_HOST` (you'll get a loud warning if you do). Full env
reference: **[Run & configure](configure.md)**.

---

## 2. Connect a memory client (MCP)

### Claude Desktop (stdio)

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mycelium": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/mycelium.id/src/index.js"],
      "env": {
        "MYCELIUM_KEY_SOURCE": "keychain",
        "MYCELIUM_DATA_DIR": "/Users/YOU/Library/Application Support/id.mycelium.app"
      }
    }
  }
}
```

Restart Claude Desktop — Mycelium's tools appear, and the client is oriented by the
[`getContext`](getcontext.md) preamble automatically.

> ⚠️ **`MYCELIUM_DATA_DIR` is the critical line.** Your real vault lives in the per-OS
> app-data dir. A hand-rolled config *without* it falls back to a *different, empty*
> `./data` vault — tools connect fine but see no data. This is the #1 "connected but
> empty" gotcha. *(No keychain? Replace `env` with `{ "USER_MASTER_KEY": "…",
> "SYSTEM_KEY": "…" }`.)*

### Claude Code (CLI, stdio)

```bash
claude mcp add mycelium -- node /ABSOLUTE/PATH/TO/mycelium.id/src/index.js
```

### Any HTTP MCP client (`:4711`)

Run `npm run start:http`, then point the client at **`http://127.0.0.1:4711/mcp`**.
Authenticate either way:

- **Static bearer** — the low-friction path for a local tool (see §4).
- **OAuth 2.1 + PKCE** — browser-based clients discover and authorize automatically:
  Mycelium serves `/.well-known/oauth-authorization-server` +
  `/.well-known/oauth-protected-resource`, supports Dynamic Client Registration, and
  runs the full PKCE-S256 flow. Every `/mcp` request is Bearer-guarded; no/invalid
  token → `401` + `WWW-Authenticate` pointing at the protected-resource metadata
  (RFC 9728, fail-closed).

---

## 3. Connect a harness to the model gateway (`:4711/v1`)

The gateway speaks the OpenAI `/v1` dialect. For **any** OpenAI-compatible tool, three
facts:

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

Supports real token streaming (`stream: true`) and tool calling. Set the active
provider + jurisdiction in Settings → Intelligence. Full surface, including the
sensitivity header: **[Model gateway & embeddings](gateway-and-embeddings.md)**.

To make **every turn flow into memory automatically**, see the
**[Memory bridge](memory-bridge.md)**.

---

## 4. Auth: the static bearer

Generate a token and start the server with it:

```bash
export MYCELIUM_MCP_BEARER="$(openssl rand -hex 32)"   # 64 hex chars
npm run start:http
```

Use that exact value as the **API key / Bearer** in any harness above, and on
`http://127.0.0.1:4711/mcp` for HTTP MCP clients.

**Auto-provisioned in the app.** You usually don't set this by hand: the self-hosted
app generates a **stable** bearer once and persists it (in `auth.db`), so `:4711`
always accepts one with zero setup. Retrieve it via the logged-in portal
(operator-only):

```bash
curl -s http://127.0.0.1:4711/portal/mcp-bearer    # → {"ok":true,"bearer":"…"}
```

An explicit `MYCELIUM_MCP_BEARER` env var still **wins** (for verify scripts, pinning a
known value). It's compared in constant time, length-floored (**≥24 chars**), never
logged, and works **in addition** to OAuth on `/mcp` and every `/v1/*` route.

---

## 5. Reach your box from the internet (remote)

To connect a client that isn't on your machine, Mycelium uses a **managed relay**: you
claim a handle and your clients use

```
https://<handle>.mycelium.id/mcp     ← memory (MCP)
https://<handle>.mycelium.id/v1      ← model gateway
```

Set it up in **Settings → Remote Access** (claim a handle, set an operator password).
The relay does **TLS-SNI passthrough only** — it never sees your key or your plaintext;
TLS terminates on your machine.

> **Status:** the on-box client side is built (the Settings flow materializes the
> tunnel + TLS configs). The hosted relay itself is still being stood up, so the
> `<handle>.mycelium.id` path is **not live end-to-end yet** — until it is, connect
> locally as in §2–§3.

---

## 6. Security defaults

- **Loopback by default.** `:4711` and `:8787` bind `127.0.0.1`.
- **Fail-closed auth.** No/invalid bearer or OAuth token → `401`. The gateway never
  runs on the no-auth `:8787`.
- **Jurisdiction + sensitivity.** Pick your provider's jurisdiction in Settings;
  `X-Mycelium-Sensitive: true` hard-blocks a request from US providers.
- **Hash-only egress audit.** Every cloud call is logged as a sha256 hash + length,
  never the content.
- **Local embeddings.** `/v1/embeddings` never leaves the box.

Full posture: **[Security model](security-model.md)**.
