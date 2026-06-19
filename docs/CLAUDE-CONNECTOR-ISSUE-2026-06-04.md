# Draft GitHub issue → anthropics/claude-ai-mcp

**Title:** Custom connector fails ("Authorization with the MCP server failed", `ofid_…`) — server completes OAuth (`token → 200`) but Claude never calls `/mcp`

---

> **STATUS (2026-06-04):** Anthropic support reviewed this and **confirmed it is an Anthropic-side issue** — *"a problem on our end with the auth state synchronization between the OAuth flow and our connection handling" / "session caching issues that plague Claude.ai."* **Production workaround in place:** the same server connects fine via **Claude Desktop** (`mcp-remote` stdio bridge), which uses a different connection architecture. This doc is retained as the evidence record; the server side is fully verified and the official MCP Inspector connects (see below).

## Summary

A self-hosted remote MCP server completes the **entire** OAuth 2.1 flow with the Claude custom connector — discovery → Dynamic Client Registration → authorize → `POST /token → 200` (a valid access + refresh token is issued) — and then **Claude never sends a single request to the MCP endpoint** (`/mcp`). The connector UI shows *"Authorization with the MCP server failed. You can check your credentials and permissions. If this persists, share this reference with support: `ofid_…`"*.

The identical flow, and the identical token, work perfectly with a reference OAuth 2.1 client (it goes on to `POST /mcp (initialize) → 200` with a live MCP session). So the server and the issued token are correct; Claude obtains a valid token and abandons the flow before contacting the MCP endpoint.

## `ofid_` references

Four attempts, **two different Claude accounts**, identical outcome:

- `ofid_740086aabba50af3`
- `ofid_76e7a5182a0196f5`
- `ofid_8f5a2ad91fbd0aa3`
- `ofid_adb423c5bcdc7570`

## Server

- Connector URL: `https://relay.example.com/mcp` (self-hosted; reachable from the public internet; valid Let's Encrypt certificate).
- OAuth 2.1 + DCR + PKCE via `better-auth`; MCP Streamable HTTP transport (`@modelcontextprotocol/sdk`).

## Server-side log of Claude's requests

(User-Agent `python-httpx/0.28.1` = Claude's backend. **Both attempts were identical.**)

```
GET  /.well-known/oauth-protected-resource   → 200   discovery (RFC 9728)
POST /api/auth/mcp/register                  → 201   Dynamic Client Registration
GET  /api/auth/mcp/authorize                 → 302   → code, redirect to https://claude.ai/api/mcp/auth_callback
POST /api/auth/mcp/token                     → 200   valid access_token + refresh_token issued
        ── and then nothing. /mcp is never requested. ──
```

(One attempt also showed a duplicate `POST /token → 401` — a re-submit of the already-consumed authorization code; the other attempt had a clean single `token → 200` and still never called `/mcp`, so that 401 is not the cause.)

## Proof the server + token are correct — the official MCP Inspector connects

The **official MCP Inspector** (`@modelcontextprotocol/inspector`) connects to this exact server over OAuth + Streamable HTTP and lists all **27 tools** — verified both via the Inspector CLI and by driving the Inspector browser UI end-to-end in WebKit (discovery → DCR → login → token → connect → tools). A scripted **reference OAuth 2.1 + DCR + PKCE client**, run against the same live server, likewise completes the identical flow **and then** `POST /mcp (initialize) → 200`, returning a real MCP session:

```
{"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},
  "serverInfo":{"name":"mycelium","version":"0.1.0"}},"jsonrpc":"2.0","id":1}
```

This succeeds **both with and without** an `openid` scope. So the token Claude receives is valid and usable; only Claude declines to use it.

## Verified correct, server-side (RFC-compliant)

- RFC 9728 protected-resource metadata at **both** the root and the path-suffixed `/.well-known/oauth-protected-resource/mcp` — `200`, minimal body, CORS + `OPTIONS` preflight.
- `/mcp` (no token) → `401` with `WWW-Authenticate: Bearer error="invalid_token", …, resource_metadata="https://relay.example.com/.well-known/oauth-protected-resource/mcp"`. **No redirects** on `/mcp`.
- RFC 8414 authorization-server metadata: S256 PKCE, `registration_endpoint` (DCR), `code_challenge_methods_supported: ["S256"]`, no `openid` advertised.
- JWKS resolves. Opaque access token, validated server-side by session lookup (per MCP 2025-06-18).
- `Access-Control-Expose-Headers: WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-Id`.

## Question

Given the server issues a valid token (independently verified to produce a working MCP session), **why does the Claude custom connector abandon the flow immediately after `POST /token → 200`, without ever calling the MCP endpoint?** The server-side `ofid_` traces above should reveal Claude's post-token behavior. Happy to provide additional logs or run any requested probe.

## Environment

- Claude.ai custom connector (web UI), 2026-06-04.
- Two separate Claude accounts; same result on both.
- Server reachable from Anthropic IP range; no WAF/edge in front dropping requests (requests reach the app and are logged).
