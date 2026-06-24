# Mycelium Reference

Precise, copy-pasteable docs for connecting agents, harnesses, and scripts to a
Mycelium vault. Verified against the running server.

> **New to Mycelium?** The [Handbook](../handbook/) explains the product for humans.
> This track assumes you're wiring something to it.

## The shape of the system

Mycelium is **one `boot()` sequence behind three transports** — write a tool once,
reach it everywhere. A vault unlocks at startup (keys from the OS keychain / env /
1Password, fail-closed), then the same handler map serves:

```
                      boot()  → unlock vault (AES-256-GCM) → tool handler map
                        │
      ┌─────────────────┼──────────────────────┬───────────────────────┐
      ▼                 ▼                      ▼                       ▼
  stdio MCP        HTTP MCP + OAuth        Model gateway           REST + ingest
  (Claude Desktop) :4711  /mcp             :4711  /v1              :8787  /api/v1
  (no network)     Bearer / OAuth 2.1      OpenAI-compatible       loopback, no auth
```

## Pages

| Page | What's in it |
|---|---|
| **[Connect an agent](connect.md)** | Memory (MCP) + model (gateway) in one endpoint. Per-harness recipes, auth, remote access. |
| **[`getContext`](getcontext.md)** | The orientation preamble. **Call it first.** Shape, params, budget. |
| **[MCP tool reference](mcp-tools.md)** | Every tool, by domain — params, behavior, return shape. |
| **[Memory bridge](memory-bridge.md)** | Auto-capture every turn: the `/context` bridge, gateway capture header, native adapters. |
| **[Model gateway & embeddings](gateway-and-embeddings.md)** | `/v1/chat/completions`, `/v1/embeddings`, jurisdiction + sensitivity controls. |
| **[REST & ingest](rest-and-ingest.md)** | `POST /api/v1/:tool`, `/ingest/*`, uploads, publish. |
| **[Run & configure](configure.md)** | Run modes, ports, and every environment variable. |
| **[Security model](security-model.md)** | The guarantees you can build on, and the boundaries you must respect. |

## 30-second connect

```bash
# 1. Run the HTTP server with a static bearer (memory MCP + model gateway on :4711)
export MYCELIUM_MCP_BEARER="$(openssl rand -hex 32)"
export MYCELIUM_KEY_SOURCE=keychain      # or set USER_MASTER_KEY / SYSTEM_KEY
npm run start:http

# 2a. Memory — point any MCP client at:
#     http://127.0.0.1:4711/mcp     (Authorization: Bearer $MYCELIUM_MCP_BEARER)

# 2b. Model — point any OpenAI-compatible harness at:
#     base URL : http://127.0.0.1:4711/v1
#     API key  : $MYCELIUM_MCP_BEARER
#     model    : mycelium-auto
```

The self-hosted app **auto-provisions a stable bearer** for you — you usually don't set
it by hand. See [Connect → Auth](connect.md#4-auth-the-static-bearer).

## Ground truth

Don't trust this doc over the code. Two verifier scripts prove the wire end-to-end:

```bash
npm run verify:mcp     # boots the real server, lists tools, round-trips a tool call
npm run verify:oauth   # drives discovery → DCR → PKCE → Bearer → tools/call over HTTP
```

Re-run them after any change to `src/mcp.js`, `src/index.js`, or `src/server-http.js`.
