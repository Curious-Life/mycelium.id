# MCP Connect Fix — REVISED (root cause found) 2026-06-04

**Date:** 2026-06-04 (PM revision supersedes the AM "discovery-only" draft)
**Branch:** `feat/remote-connect-phase2` · **Live app cwd:** `/private/tmp/myc-phase2` (pid confirmed via lsof)
**Companions:** `docs/REMOTE-CONNECT-HANDOFF-2026-06-03.md`, `_oauth-probe.mjs` (reference client), this session's 7-agent sweep.
**Audience:** the next Claude Code instance. **Constraint: the operator has only a FEW Claude-connect attempts left before throttling — so we bundle EVERY validated fix into ONE shot and prove as much as possible locally first.**
**Discipline:** `/sweep-first-design` — 7 parallel research/code agents + live log forensics + read-only `auth.db` inspection.

---

## TL;DR — the standing diagnosis was WRONG; the real blocker is server-side and concrete

The MEMORY/handoff claim — *"Claude completes token then never sends the bearer; server proven functional; failure is Claude-side"* — is **disproven by the app logs**:

1. **A bearer `POST /mcp` DID reach the app and `getMcpSession` returned OK** (`/tmp/myc-branch-app.log` lines 292, 295 — the two `_oauth-probe` runs). The happy path works at the HTTP level.
2. **The dominant recent failure is `POST /api/auth/mcp/token → 500`, repeated ~22× hourly-on-the-hour** (lines 322–908), caused by **`SqliteError: FOREIGN KEY constraint failed`** on better-auth's token `INSERT`.

**Root cause (confirmed by read-only `auth.db` inspection):** the live `auth.db` has **5 orphaned `oauthAccessToken` rows whose `userId` points at a deleted user** (`orphan accessTokens=5` of 7; 5 `oauthApplication` rows vs 1 `user`). The manual `_reset-operator.mjs` / `_clean-oauth.mjs` scripts run `PRAGMA foreign_keys = OFF` then `DELETE FROM user`, so the `on delete cascade` never fired → orphans. The app runs with FKs **on**, so the **hourly token refresh** (`accessTokenExpiresIn=3600`) for a stale token does `INSERT … userId=<dead>` → **FK violation → 500 → no token → connector dies.**

### Bundled fix (ALL in one shot — each independently safe, each maps to a confirmed root cause)

| # | Fix | Why (evidence) | Confidence |
|---|---|---|---|
| **A** | **Clean `auth.db`**: delete `oauthAccessToken/oauthApplication/oauthConsent/session` rows (keep `user`, `account`, `jwks`, `mycelium_app_secret`, `mycelium_remote_secret`); verify `orphans=0`. Stop FK-OFF surgery. | THE current blocker — token 500 on orphaned FK (live DB inspection; matches issue #240 "token 500 → no token") | **HIGHEST** |
| **B** | **Suffixed PRM + minimal body + WWW-Auth→suffixed** (root + `/.well-known/oauth-protected-resource/mcp`) | RFC 9728 §3.1 + MCP 2025-11-25 make the suffixed probe mandatory; all 7 working servers do it, we don't | **HIGH** |
| **C** | **CORS on PRM** (`ACAO:*` + `OPTIONS` preflight 204) + expose `WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version` on `/mcp` | every working server returns CORS on PRM; Claude's web client fetches it cross-origin | **HIGH** (newly found) |
| **D** | **Drop `openid`** from AS-metadata `scopes_supported` → Claude won't request it → no HS256 id_token | issue #240 (HS256 id_token → token 500 for others); Claude requests only advertised scopes (Anthropic docs) | **MED** |
| **E** | **Instrument**: log every `.well-known/*` probe + `/mcp` (method, bearer?, client IP/XFF) + add Caddy access log | the ONE remaining attempt must be fully traceable; today we can't see Claude's PRM probe or edge receipt | **HIGH (diagnostic)** |
| **F** | **Verify no `/mcp` redirects** (`curl -i`) | issue #155: a cross-origin 3xx strips the `Authorization` header | verify-only |

**Ruled out (do not spend the attempt on these):** edge/nftables dropping traffic (requests reach the app; rate limit is 30/s — fine); "advertised-endpoint 404 mismatch" (Agent 7's claim — **falsified**: `/api/auth/mcp/*` requests succeed in the logs); "Claude never sends the bearer" (it did — lines 292/295).

---

## Implementation status — DONE + LOCALLY VERIFIED 2026-06-04 (working tree, uncommitted)

All edits applied to `/tmp/myc-phase2` (the tree the live app runs from):
- `src/auth.js` — `pragma('foreign_keys = ON')`; top-level `mcp({ metadata: { scopes_supported: ['profile','email','offline_access'] } })` (drops openid from AS metadata — verified the override key against `mcp/index.mjs:69`).
- `src/server-http.js` — minimal PRM at root **and** `/.well-known/oauth-protected-resource/mcp` + CORS + OPTIONS; canonical WWW-Authenticate→suffixed; `/mcp` exposes `Mcp-Session-Id`/`Mcp-Protocol-Version`/`WWW-Authenticate` + OPTIONS 204; `[myc-prm]`/`[myc-mcp]` request logging (TEMP).
- `src/remote/runtime.js` — Caddy access `log` block (edge tracing).
- `_clean-oauth-safe.mjs` (FK-ON cleanup), `scripts/verify-mcp-discovery.mjs` (+ wired into package.json + chain), `scripts/verify-oauth.mjs` (+ refresh round-trip).

**Local verification (all GO):** Tier-0 `verify:mcp-discovery` 11/11; Tier-1 `verify:oauth` full flow; `_clean-oauth-safe.mjs` on a **copy** of the live `auth.db` → orphans 5→0, user + `mycelium_remote_secret` + `mycelium_app_secret` + jwks preserved; regression `verify:remote-runtime`/`loopback`/`mcp`/`ingest` GO. NOT yet committed; restart picks up the working tree.

## Decisive evidence (this session)

### Log forensics — `/tmp/myc-branch-app.log`
- `[myc-oauth]` shows full OAuth working at times: `register → 201`, `sign-in → 200`, `authorize → 302`, `token → 200`, `jwks → 200` (lines 34–36, 283–294).
- `[myc-auth] POST /mcp — getMcpSession: OK` (lines 292, 295) — **bearer reached `/mcp`, token accepted.**
- `[myc-auth] GET /mcp — no/non-bearer header` (lines 32, 284, 286, 599, 600) — unauth probes (expected 401-trigger; or #291-style loop when discovery didn't resolve).
- **`POST /api/auth/mcp/token → 500` × ~22, hourly** (322, 351, 378, …, 908) each preceded by `SqliteError: FOREIGN KEY constraint failed` at `@better-auth/kysely-adapter … Object.create` (token `INSERT`).

### `auth.db` inspection (read-only) — `~/Library/Application Support/id.mycelium.app/auth.db`
```
tables: user, account, session, verification, jwks, oauthApplication, oauthAccessToken, oauthConsent, mycelium_app_secret, mycelium_remote_secret
counts: user=1  oauthApplication=5  oauthAccessToken=7  oauthConsent=0  session=2  account=1
orphan accessTokens = 5   (oauthAccessToken.userId with NO matching user.id)
schema: oauthAccessToken.userId  references user(id) ON DELETE CASCADE
        oauthAccessToken.clientId references oauthApplication(clientId) ON DELETE CASCADE
```
`_reset-operator.mjs` & `_clean-oauth.mjs` both `db.pragma('foreign_keys = OFF')` → `DELETE FROM user` skipped cascade → orphans.

### Environment (resolved)
- Running app `pid 63922` = `node src/index.js --http`, **cwd `/private/tmp/myc-phase2`** → our `src/*` edits execute on restart. (node_modules resolves to `~/Documents/GitHub/mycelium.id` via symlink — dependency code only.)
- `auth.db` at `~/Library/Application Support/id.mycelium.app/auth.db` (`MYCELIUM_DATA_DIR`).

---

## Sweep findings that shaped the bundle (7 agents, cited)

- **Working-server diff (Agent 1):** all of Sentry/Linear/Notion/GitHub serve the **suffixed** PRM and point the 401 `WWW-Authenticate` at it (Sentry/GitHub return **404 at root**); bodies are **minimal** (`resource`, `authorization_servers`, `bearer_methods_supported`); **all return CORS** (`ACAO:*` or echo `claude.ai`, `OPTIONS`→204). **None** advertise `openid`/signing-alg. OIDC config 404s everywhere.
- **Anthropic docs (Agent 2):** Claude probes `/.well-known/oauth-protected-resource/<mcp-path>` **first**, then root. *"The 401 status is required — Claude does not honor WWW-Authenticate on a 200."* *"Claude requests the scopes your PRM advertises in `scopes_supported`"* (→ dropping openid is sufficient to stop the id_token request). claude.ai redirect_uri = `https://claude.ai/api/mcp/auth_callback`. Outbound IPs `160.79.104.0/21`. Custom connectors are BETA; **no documented retry/throttle** — the only reset lever is *disconnect & reconnect*. `ofid_` → file a `claude-ai-mcp` issue.
- **Spec (Agent 3):** RFC 9728 §3.1 path-INSERTION confirmed; **2025-11-25 makes the suffixed probe mandatory** (root-only is noncompliant for a `/mcp` resource). `resource` param (RFC 8707) required; opaque-token audience is validated by our `getMcpSession` DB lookup. **GET `/mcp` returning 405/400 without a session is spec-compliant** (the GET SSE stream is optional). `/sse` is NOT required.
- **Resolved-issue cluster (Agent 4):** the error is a **catch-all** masking server bugs. Top confirmed causes: (1) edge/WAF dropping the authenticated POST — *ruled out for us*; (2) cross-origin redirect strips `Authorization` (#155); (3) **token endpoint returns 500 → no token (#240)** — *this is us*; (4) path-suffixed PRM 404 (#155 + better-auth #4540/#6817/#6394); (5) relative `resource_metadata` URL rejected — ours is absolute (ok).
- **Reference impl (Agent 5):** MCP TS SDK + Cloudflare workers-oauth-provider both serve suffixed PRM (or both), minimal body, `Bearer error="invalid_token", …, resource_metadata="<suffixed>"`, GET `/mcp` **400s without a session** (anti-loop), CORS `exposedHeaders: [WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-Id]`, **no `/sse`**.
- **Our `/mcp` handler (Agent 6):** **correct** — GET-without-session → 400 (right), session lifecycle sound, `req.body` passed as 3rd arg (no double-read), `server.connect` once per session. Not the blocker.
- **Our discovery surface (Agent 7):** AS metadata endpoints DO resolve under `/api/auth/mcp/*` (the "404 mismatch" is **falsified** by working logs). No `/.well-known/openid-configuration` (fine).

---

## The change — exact edits

### A. Clean `auth.db` (one-time, operator-run, app stopped)
A small script `_clean-oauth-safe.mjs` (FKs **ON**) deleting `oauthAccessToken, oauthConsent, oauthApplication, session`; keep `user, account, jwks, mycelium_app_secret, mycelium_remote_secret`. Assert `orphan accessTokens=0` after. (The endgame — merge to a self-contained app with a freshly-migrated DB + permanent handle — removes this class of problem; until then, NEVER run an FK-OFF delete of `user`.)

Defensive code fix — `src/auth.js` after `const database = new Database(dbPath);` (line 52):
```js
database.pragma('foreign_keys = ON'); // cascade on user delete; prevents orphan oauth rows
```

### B+C. `src/server-http.js` — PRM + CORS + WWW-Authenticate
Replace the root PRM route (62-69) and drop the unused import (27-30):
```js
import { oAuthDiscoveryMetadata } from 'better-auth/plugins'; // (drop oAuthProtectedResourceMetadata)
...
  app.get('/.well-known/oauth-authorization-server', toNodeHandler(oAuthDiscoveryMetadata(auth)));

  // RFC 9728 protected-resource metadata: MINIMAL body (matches Sentry/Linear/Notion/GitHub),
  // served at BOTH root and the path-suffixed `/mcp` (what Claude probes first), with CORS.
  const protectedResourceMetadata = {
    resource: `${baseURL}/mcp`,
    authorization_servers: [baseURL],
    bearer_methods_supported: ['header'],
  };
  const sendPrm = (req, res) => {
    console.error('[myc-prm]', req.method, req.path, 'ip=', req.headers['x-forwarded-for'] || req.ip); // TEMP
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Authorization, *');
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    res.json(protectedResourceMetadata);
  };
  app.options('/.well-known/oauth-protected-resource', sendPrm);
  app.options('/.well-known/oauth-protected-resource/mcp', sendPrm);
  app.get('/.well-known/oauth-protected-resource', sendPrm);
  app.get('/.well-known/oauth-protected-resource/mcp', sendPrm);
```
WWW-Authenticate (133-134) → canonical + suffixed:
```js
  const wwwAuthenticate =
    `Bearer error="invalid_token", error_description="Authentication required", ` +
    `resource_metadata="${baseURL}/.well-known/oauth-protected-resource/mcp"`;
```
On `/mcp` responses, expose the MCP headers (in `mcpHandler`, before sending): `res.set('Access-Control-Expose-Headers', 'WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-Id')` and answer `OPTIONS /mcp` with 204 + ACAO.

### D. `src/auth.js` — drop openid (73-82)
```js
        oidcConfig: {
          allowDynamicClientRegistration: true,
          requirePKCE: true,
          storeClientSecret: 'plain',
          useJWTPlugin: true,
          metadata: { scopes_supported: ['profile', 'email', 'offline_access'] },
        },
```

### E. Instrumentation
- `server-http.js`: the `[myc-prm]` log above; in `authenticate`/`mcpHandler` add client IP/XFF to the existing `[myc-auth]` lines.
- Caddyfile renderer `src/remote/runtime.js`: add an access `log` block so we can see what reaches the Mac (edge vs app).

### F. Verify no redirects (operator, post-restart)
`curl -i https://relay.example.com/mcp` → expect `401` (not 3xx). `auto_https disable_redirects` is set; confirm.

**LOC:** server-http.js ≈ +30/−9; auth.js ≈ +2; runtime.js ≈ +3; cleanup script ≈ +20; verify script ≈ +70.

---

## Threat model
- New routes return only public discovery metadata (no secrets, no vault data). `ACAO:*` only on public PRM (no cookies/credentials). ✓
- `auth.db` cleanup deletes only OAuth churn + sessions; **preserves** the operator user, the auth signing secret (`mycelium_app_secret`) and the relay/acme secrets (`mycelium_remote_secret`) → tunnel/cert survive; Claude re-registers (expected for a fresh connect). ✓
- `PRAGMA foreign_keys=ON` only tightens integrity. Fail-closed `/mcp`/`/ingest` unchanged. No vault code touched. ✓

---

## Verification — local, before spending the attempt
- **Tier-0 static `verify:mcp-discovery`** (mirror `verify:loopback` in-process boot): assert suffixed+root PRM 200 minimal body (no openid/scopes/signing-alg), `OPTIONS`→204+ACAO, `/mcp` 401 `WWW-Authenticate` → suffixed, AS metadata 200 with **no openid** in `scopes_supported`.
- **Tier-1 `_oauth-probe` on a CLEAN db**: full `register→authorize→token(200)→POST /mcp initialize(200)` AND **a refresh_token round-trip** (grant_type=refresh_token) that must return 200 — this directly reproduces & guards the FK-500 bug.
- **Tier-2 (operator)** live Claude connect, fully instrumented (below).

## Restart runbook (operator, canonical env)
1. Stop the app: `kill 63922` (or quit the branch app). Confirm `:4711`, Caddy, frpc freed.
2. Clean `auth.db` (app stopped): `node /tmp/myc-phase2/_clean-oauth-safe.mjs "$HOME/Library/Application Support/id.mycelium.app/auth.db"` → verify `orphans=0`.
3. Relaunch from `/tmp/myc-phase2` (cwd) with the same `MYCELIUM_DATA_DIR`; tail `/tmp/myc-branch-app.log`.
4. `curl -i https://relay.example.com/.well-known/oauth-protected-resource/mcp` (200 minimal), `…/mcp` (401 suffixed WWW-Auth, no redirect).
5. In Claude: **disconnect any old connector first**, then add `https://relay.example.com/mcp`. Watch for: `[myc-prm] … /oauth-protected-resource/mcp` → `register 201` → `authorize 302` → `token 200` (NOT 500) → `[myc-auth] POST /mcp getMcpSession: OK`.
> Do NOT touch the `~/mycelium.id` (main, :8787) or `~/Documents/GitHub/mycelium.id` (phase1) trees — only the `/tmp/myc-phase2` `:4711`+frpc+Caddy app.

---

## Verification table (load-bearing, this session)
| Assumption | Verified | How |
|---|---|---|
| Blocker = token 500 (FK), not Claude-side | `app.log:322-908` + tail FK stack | read log |
| 5 orphaned access tokens (userId→dead user) | `orphan accessTokens=5` | read-only sqlite |
| Orphan cause = FK-OFF delete of user | `_reset-operator.mjs:8,10` `_clean-oauth.mjs:7` `pragma foreign_keys=OFF` | read scripts |
| Bearer POST /mcp reached app, token accepted | `app.log:292,295 getMcpSession: OK` | read log |
| Live app runs `/tmp/myc-phase2` (our edits apply) | `lsof pid 63922 cwd = /private/tmp/myc-phase2` | lsof |
| We own PRM routes + WWW-Auth (no better-auth interception) | `server-http.js:62-69,133-134` | read |
| `resource` must be `${baseURL}/mcp` | `auth.js:75` | read |
| Working servers: suffixed PRM + CORS + minimal + no openid | Agent 1 curl matrix (7 servers) | sweep |
| 2025-11-25 makes suffixed probe mandatory | Agent 3 spec quotes (RFC 9728 §3.1) | sweep |
| openid drop stops id_token (Claude requests advertised scopes) | Agent 2 (Anthropic docs) | sweep |
| Edge passes traffic (not dropping) | app.log receives all OAuth + /mcp | read log |
| "endpoint 404 mismatch" falsified | `/api/auth/mcp/*` 200/201/302 in log | read log |

## Pickup protocol
1. Read this doc cold.
2. Write `_clean-oauth-safe.mjs` (FK-ON) — do **not** delete `user`.
3. Apply edits A(pragma)+B+C+D+E to `src/auth.js`, `src/server-http.js`, `src/remote/runtime.js`.
4. Write+run `verify:mcp-discovery` (Tier-0) → GO.
5. Run Tier-1 `_oauth-probe` (+refresh round-trip) on a clean DB → token & refresh 200, `/mcp` initialize 200.
6. Hand the operator the **Restart runbook**; one instrumented live attempt.
7. If still failing: read the fresh `[myc-prm]`/`[myc-auth]`/Caddy logs → they now pinpoint where Claude stops; escalate with `ofid_` + `_oauth-probe` proof only if logs show Claude misbehaving with a 2xx server.
8. Endgame: merge `feat/remote-connect-phase2`→main (self-contained app, fresh DB, permanent handle) — removes the manual-surgery DB-corruption class entirely.
