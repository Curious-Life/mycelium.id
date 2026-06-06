# Harness recipes — connect your agent to Mycelium

Pick the harness you use and copy its recipe. Every harness connects through one or both of Mycelium's **two doors**:

- **Memory (MCP)** — `http://127.0.0.1:4711/mcp` (or stdio) → your vault's tools (`getContext`, `searchMindscape`, `remember`, …).
- **Model (gateway)** — `http://127.0.0.1:4711/v1` (OpenAI-compatible) → sovereign, jurisdiction-gated inference; model id **`mycelium-auto`**.

> **Local-only today.** Everything below runs on **this machine** (loopback). Remote (`https://<handle>.mycelium.id/…`) needs the relay, which is **not live end-to-end yet** — see [CONNECT-YOUR-AI.md §6](CONNECT-YOUR-AI.md). Until then, connect locally.

> **Auth in one line.** Generate a copy-paste token once, then start the HTTP server with it:
> ```bash
> export MYCELIUM_MCP_BEARER="$(openssl rand -hex 32)"   # 64 hex chars, ≥24 required
> npm run start:http                                     # serves :4711 (MCP + gateway)
> ```
> Use that exact value as the **Bearer / API key** everywhere below. Browser-based MCP clients can use **OAuth 2.1** instead (no token needed). Full detail: [CONNECT-YOUR-AI.md §4](CONNECT-YOUR-AI.md).

---

## Mycelium-native

No harness to connect — the vault **is** the assistant. Open the portal (`npm run portal` → `:8787`) and use Mycelium directly. Choose this if you want a single, sovereign, vault-native experience and don't need an external agent's channels or coding loop.

---

## Claude Desktop / Claude Code (memory door, stdio)

The lowest-friction local path — no token, no HTTP. Add Mycelium as an stdio MCP server.

**Claude Code (CLI):**
```bash
claude mcp add mycelium -- node /ABSOLUTE/PATH/TO/mycelium.id/src/index.js
```

**Claude Desktop** — merge into `claude_desktop_config.json` (the Settings → "Connect on this Mac" card generates this with *your* real paths + keychain accounts):
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
Restart the client; Mycelium's tools appear and `getContext` orients it automatically. (HTTP MCP at `:4711/mcp` with a bearer also works — see [CONNECT-YOUR-AI.md §2](CONNECT-YOUR-AI.md).)

---

## opencode (memory + model)

[`sst/opencode`](https://github.com/sst/opencode) — the coding harness. Uses **both** doors.

**Memory (remote MCP)** — in your opencode config (`opencode.json`):
```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "mycelium": {
      "type": "remote",
      "url": "http://127.0.0.1:4711/mcp",
      "enabled": true,
      "headers": { "Authorization": "Bearer <MYCELIUM_MCP_BEARER>" },
      "oauth": false
    }
  }
}
```
(`"oauth": false` makes opencode use the static bearer instead of the OAuth/DCR flow.)

**Model (gateway)** — add an OpenAI-compatible provider with `baseURL: http://127.0.0.1:4711/v1`, the bearer as the key, model **`mycelium-auto`**. See [CONNECT-YOUR-AI.md §3](CONNECT-YOUR-AI.md).

---

## openclaw (memory door)

[`openclaw/openclaw`](https://github.com/openclaw/openclaw) — the omni-channel personal assistant.

> ⚠️ **Safety:** openclaw is heavily impersonated by scams (fake installers, fake `$CLAW`/`$CLAWD` tokens + wallet-drainers). **Trust only the `openclaw/openclaw` repo and the `openclaw.ai` domain.** openclaw never asks you to connect a crypto wallet.

**Memory (streamable-http MCP)** — register Mycelium as a remote MCP server:
```bash
openclaw mcp set mycelium '{"url":"http://127.0.0.1:4711/mcp","transport":"streamable-http","headers":{"Authorization":"Bearer <MYCELIUM_MCP_BEARER>"}}'
```
Or in the gateway config (`mcp.servers`):
```json
{ "mcp": { "servers": { "mycelium": {
  "url": "http://127.0.0.1:4711/mcp",
  "transport": "streamable-http",
  "headers": { "Authorization": "Bearer <MYCELIUM_MCP_BEARER>" }
} } } }
```
openclaw now reads/writes your vault as its long-term memory. (openclaw is model-agnostic; you can also point its model provider at `:4711/v1`.)

---

## hermes-agent (memory door)

[`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent) — the self-improving personal agent (MCP-native, model-agnostic). *(The agent, not the Hermes LLM family.)*

**Memory (HTTP MCP)** — add to `mcp_servers` in your Hermes config (YAML):
```yaml
mcp_servers:
  mycelium:
    url: "http://127.0.0.1:4711/mcp"
    headers:
      Authorization: "Bearer <MYCELIUM_MCP_BEARER>"
```
Hermes registers Mycelium's tools alongside its own. (Stdio also works — point `command`/`args` at `node …/src/index.js` like the Claude Desktop recipe.)

---

## Custom — any MCP or OpenAI-compatible client

Any spec-compliant harness connects with the same three facts:

| | value |
|---|---|
| **Memory (MCP)** | `http://127.0.0.1:4711/mcp` — OAuth 2.1 **or** `Authorization: Bearer <MYCELIUM_MCP_BEARER>` |
| **Model (base URL)** | `http://127.0.0.1:4711/v1` — API key = the bearer |
| **Model id** | `mycelium-auto` (routes to your active provider in Settings → Intelligence) |
| **Embeddings** | `POST http://127.0.0.1:4711/v1/embeddings`, model `nomic-embed-text-v1.5` (local-only) |

Goose, Cline, Continue, Codex, OpenHands, Cursor, … all fit this shape — see [CONNECT-YOUR-AI.md §3](CONNECT-YOUR-AI.md). Set the active provider + jurisdiction in **Settings → Intelligence**; mark a request sensitive with `X-Mycelium-Sensitive: true` to hard-block it from US providers.

---

*Config key names for third-party harnesses were verified against each project's current docs on 2026-06-06; if a harness has since changed its schema, its own MCP docs are authoritative. Design rationale: [DESIGN-harness-connect-2026-06-06.md](DESIGN-harness-connect-2026-06-06.md).*
