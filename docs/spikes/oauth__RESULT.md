# Step 0 / R1 — OAuth spike result: **GO (better-auth)**

**Date:** 2026-05-30 · **Verdict:** GO — adopt better-auth for V1 OAuth; budget Phase 4 at 2 days.
**Versions:** `better-auth@1.6.12`, `@modelcontextprotocol/sdk@1.29.0`, Node v22.22.2.

## What was tested

A throwaway server (`server.mjs`) stands up better-auth's MCP OAuth surface; a scripted
MCP-client emulator (`probe.mjs`) drives the full remote flow and asserts the four NO-GO
conditions from the plan. Reproduce:

```bash
cd spike/oauth && npm install
node server.mjs &        # :8788
node probe.mjs           # exits 0 on GO
```

## Ledger (all PASS)

| # | NO-GO condition | Result | Evidence |
|---|---|---|---|
| 1 | discovery doc shape | ✅ | `/.well-known/oauth-authorization-server` (RFC 8414) + `/.well-known/oauth-protected-resource` (RFC 9728) both well-formed; `code_challenge_methods_supported:["S256"]`; `registration_endpoint` present |
| 2 | DCR auto-accept | ✅ | `POST …/mcp/register` → `201` + `client_id`, `token_endpoint_auth_method:"none"` (public client, no secret) |
| 3a | authorize + PKCE | ✅ | `GET …/mcp/authorize?…&code_challenge=…&code_challenge_method=S256` → `302 /callback?code=…` with an authenticated session; **no interactive consent screen** for the default prompt (single-user friendly) |
| 3b | PKCE **S256 verified** | ✅ | tampered `code_verifier` → `401 invalid_request`; correct verifier → `200` + `access_token` (codes are single-use → fresh code per attempt) |
| 4 | Bearer on `/mcp` | ✅ | no token → `401` + `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"`; valid Bearer → `200` |

## Findings that correct the spec (fold into Component 3)

1. **API name was wrong.** The spec's `oAuthProvider()` does not exist. The real surface is
   the **`mcp()` plugin** (wraps `oidcProvider` with MCP defaults) + helpers
   `withMcpAuth`, `oAuthDiscoveryMetadata`, `oAuthProtectedResourceMetadata`, all from
   `better-auth/plugins`. Mount the two well-knowns **at root**; the OAuth endpoints live
   under `…/api/auth/mcp/*` (the discovery doc advertises the real URLs, so clients self-configure).
2. **DCR client lives in the DB, consent is skipped by default.** `mcp/authorize` looks the
   client up via the adapter (so a DCR-registered client Just Works) and only shows a consent
   page when `prompt=consent`. For single-user V1 that means the flow completes without a
   consent UI — exactly what we want.
3. **PKCE can be made mandatory** via `oidcConfig.requirePKCE: true`. Keep it on.
4. **Two integration gotchas (not blockers):**
   - Express 5 / path-to-regexp v8 rejects bare `*` — use a **named splat** (`/api/auth/*splat`).
   - better-auth enforces an **`Origin` header** on auth POSTs (CSRF). Real MCP clients/browsers
     send it; only matters for scripted callers. Set `trustedOrigins` for non-localhost.
5. **Migrations run in-process** via `getMigrations(auth.options).runMigrations()`
   (`better-auth/db/migration`) — no separate CLI step needed at boot.

## Consequence for the plan

- **R1 retired.** Phase 4 budgeted at **2 days** (the GO branch), not 3–4.
- Hand-rolled OAuth fallback is **not** needed.
- Phase 4 (Step 15) should wire: `mcp()` plugin + root well-knowns + `withMcpAuth` on `/mcp`,
  with `requirePKCE:true`; single-user auto-approve after the password set in `.env`.

> This whole `spike/` dir is **throwaway evidence**, not shipped code. `node_modules/`,
> `*.db`, `*.log` are gitignored; only the source + this result are committed.
