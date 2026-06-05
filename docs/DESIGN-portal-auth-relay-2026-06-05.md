# Design — Authenticate the Portal/REST surface + expose it through the relay

**Date:** 2026-06-05
**Status:** Design (sweep-first: 5 parallel Explore sweeps + own-eyes verification of every
load-bearing claim). **No code yet — build after acceptance + a security review** (this diff
is security-sensitive per CLAUDE.md, so it needs explicit human approval before merge).
**Parent:** §5 ("critical path") of [`DESIGN-mobile-app-2026-06-05.md`](DESIGN-mobile-app-2026-06-05.md).
This is the gate for the entire mobile effort: the iOS Capacitor webview loads the portal
from `https://<handle>.mycelium.id`, and today that surface is **unauthenticated and
localhost-only by design**.

---

## Revision history

- **v1 (sketch, in the mobile doc §5):** "Gate `/api/v1/portal/*` behind the *same* OAuth gate
  that already guards `:4711`; generalize the measurement loopback-vs-authenticated split;
  Caddy path-routes the portal in; sensitive reads ride the Noise channel."
- **v2 (this doc — after sweeps):** three forced pivots, because the sketch assumed a shared
  auth surface and a Noise server that **do not exist on the self-hosted box**:
  1. **The auth system is on a *different process*.** better-auth + `/api/auth/*` + `/login`
     live entirely on `:4711` (`server-http.js`); `server-rest.js` (`:8787`, the portal+data)
     has **zero** connection to better-auth and only a fake "always signed in" shim. So this is
     not a middleware tweak — `server-rest` must gain a real session-validating gate backed by a
     **second better-auth instance over the shared `auth.db`**.
  2. **There is no server-side Noise channel in V1.** `ws` is not a dependency and no upgrade
     handler exists; `secure-channel.ts` is cloud-era client code that is inert here
     (`VITE_VPS_NOISE_PUB` unset → `SECURE_CHANNEL=false` → `api.ts` uses plain HTTPS).
     **Dropped from V1.** Confidentiality rests on **TLS terminating on the Mac** (the relay is
     SNI-passthrough and never sees plaintext). The Noise channel is a documented future layer.
  3. **No passkey on the box.** better-auth here enables only `emailAndPassword` (+ `jwt`,
     `mcp`). V1 mobile login = the **operator password** over TLS, with a native biometric
     *app-lock* for convenience. Real WebAuthn/passkey unlock is a follow-on (enable the
     plugin + wire the SPA's existing — currently unreachable — passkey UI).
  - **Plus a latent-vuln finding** (§Threat model V-1): the existing loopback guards on the two
    control surfaces are defeated by a reverse proxy and would leak the recovery key once
    `:8787` is exposed. The fix is part of this design.

- **v3 (2nd sweep cycle — refines v2's gate mechanism):** the session-validation step changes
  from "a *second* better-auth instance over the shared `auth.db`" to **`server-rest` forwards the
  request's `Cookie` to `:4711`'s standard better-auth `/api/auth/get-session` over loopback** (the
  codebase's canonical cross-process pattern). Why: (a) deps aren't installable in this container, so
  the in-process `auth.api.getSession` API couldn't be confirmed — but the **HTTP** endpoint is
  better-auth's documented, version-stable surface; (b) it keeps `:4711` the *single* auth authority
  and **removes the two-processes-one-SQLite concurrency risk** entirely; (c) the 2nd cycle confirmed
  `:4711` is running exactly when it's needed (Tauri starts it whenever remote is on — `main.rs:268-289`),
  and **both processes already share `MYCELIUM_DATA_DIR`** (`main.rs` portal `cmd` + `http` cmd both set
  it), so the auth authority and the gate agree on identity. When remote is *off*, `:4711` isn't up — but
  then every request is loopback and bypasses the gate, so the dependency is present exactly when required.
  Also confirmed: **Tauri already supervises both Node servers + Caddy + frpc** (`main.rs:225-338`) and
  launches Caddy with the Node-written Caddyfile, so the path-routed Caddyfile lands with **no Tauri
  change** — the v2 "process supervision spike" is effectively already solved.

## TL;DR

- **Architecture: one public host, Caddy path-routes to two local processes.** The browser
  sees a single origin `https://<handle>.mycelium.id`; Caddy (on the Mac, after TLS terminate)
  routes `/api/auth/*`, `/login`, `/mcp`, `/.well-known/*`, `/v1/*` → `:4711` and **everything
  else** (`/`, `/api/v1/portal/*`, the SPA) → `:8787`. Because the better-auth session cookie is
  **host-scoped** (no domain override), it is shared across both upstreams, and because the
  browser sees one origin there are **no CORS/cookie cross-origin problems**.
- **`server-rest` gets a fail-closed gate.** Every networked request to a vault-data path must
  carry a valid session (cookie) **or** Bearer token; loopback requests (the desktop Tauri case)
  bypass unchanged. The linchpin that makes "behind a reverse proxy" safe: a request is trusted-
  local **iff the socket peer is loopback AND there is no `X-Forwarded-For`** — Caddy always adds
  XFF on relayed traffic, and a remote attacker can add but never remove it.
- **Two control surfaces become hard-loopback + un-routed.** `/api/v1/account` (reveals the
  recovery key) and `/api/v1/remote` (sets the operator password) must (a) be 404 at the relay
  edge *and* (b) reject any request carrying XFF. Today they check loopback-IP only — a hole the
  moment `:8787` is proxied (V-1).

---

## Sweep findings (consolidated — every claim file:line, read by me)

**S1 — the `:4711` auth gate (reusable mechanism).**
`authenticate(req)` (`src/server-http.js:214-255`): parses `Authorization: Bearer`, tries
`matchStaticBearer(authHeader)` then `auth.api.getMcpSession({ request, headers, asResponse:false })`,
enforces `accessTokenExpiresAt` itself (better-auth doesn't), returns a session `{userId,…}` or
`null`. **Not exported.** `matchStaticBearer` (`src/gateway/static-bearer.js:45-57`) compares to
`MYCELIUM_MCP_BEARER` with `timingSafeEqual`, min length 24, fail-closed. better-auth handler is
mounted `app.all('/api/auth/*splat', toNodeHandler(auth))` (`server-http.js:113`). `/login`
(`server-http.js:166-182`) is a hand-built **email+password** form → `auth.api.signInEmail(...)`
→ redirect to `/api/auth/mcp/authorize` (it's the OAuth-authorize login).

**S2 — `server-rest` today.** Mount order (`src/server-rest.js`): `/api/v1/account`
(`:277`), `/api/v1/remote` (`:287`), `/auth` shim (`:291`), then the vault-guard middleware
(`:298-304`) that delegates **all** `/api/*`, `/ingest/*`, `/portal/*` to `vaultSubApp` — the
**single choke point**. The auth-shim's `/auth/session` returns `{user}` unconditionally
(`src/auth-shim.js:42`). The **only** authed surface is the measurement bridge, whose
`authenticatePortalRequest` (`server-rest.js:110-118`) returns `{id:userId}` **iff** socket peer
is loopback **and** `!req.headers['x-forwarded-for']`, else `null` → 401 (the correct pattern).
Binds `127.0.0.1:8787` (`server-rest.js:343-344`).

**S3 — the SPA client.** `api()` (`portal-app/src/lib/api.ts:35-73`): `credentials:'same-origin'`,
sends `mycelium_csrf` cookie as `X-CSRF-Token`, redirects to `/login` on 401. Root `+layout`
calls `/auth/session` and redirects to `/login` on failure. A real passkey login UI **exists**
(`routes/login/+page.svelte`, calls `/auth/passkey/login/options|verify`) but those routes are
**not served on `:8787`** (the shim intercepts), so it's currently dead. `VITE_VPS_NOISE_PUB` is
build-time (`portal-app/src/lib/vps-identity.ts:8`).

**S4 — relay + process model.** Mac-side Caddy renders a **flat single** `reverse_proxy
${upstream}` with `upstream=LOCAL_HTTP='127.0.0.1:4711'` (`src/remote/runtime.js:16,97`) — no
path matchers. `frpc type="https"` → **SNI passthrough; TLS terminates on the Mac's Caddy**
(`runtime.js:39-57`; `mycelium-managed/relay/frps.toml`). `src/index.js:129-136` dispatches
`stdio | --http(:4711) | --enrich(:8095) | --public(:8788)`; **`--rest`/portal `:8787` is a
separate entry point** (`node src/server-rest.js`). The two servers `boot()` independently — same
handler *code*, separate processes, neither mounts the other's routes.

**S5 — better-auth cookies/CORS.** `createAuth` (`src/auth.js:30-101`): `baseURL =
opts || readRemoteConfig().publicBaseUrl || localhost:4711`; `trustedOrigins:[baseURL,
claude.ai, claude.com]`; `emailAndPassword.enabled`; plugins `jwt` + `mcp` (OIDC/PKCE).
**No `advanced`/`cookies`/`session`/`domain` block** → defaults: **host-scoped, SameSite=Lax,
Secure on HTTPS**. Issues both browser session cookies (login) and RS256 JWT bearer (MCP).
`auth.db` holds the operator password hash + signing secret, chmod `0600` (`auth.js:61`).

## Threat model

What we are doing: exposing a previously localhost-only, unauthenticated, already-unlocked
cognitive vault's data API to the public internet behind a reverse proxy. This is the highest-
stakes change in the repo to date. Adversary = anyone on the internet who can resolve
`<handle>.mycelium.id`.

| ID | Threat | Mitigation |
|---|---|---|
| **V-1** *(found in sweep — latent)* | `/api/v1/account` (returns `{recoveryKey}`, `account/router.js:64`) and `/api/v1/remote/password` gate on **loopback-IP only** (`account/router.js:32-33`, `remote/router.js:43-44`), no XFF check. Behind Caddy the socket peer is loopback → **a relayed internet request reads as local** → recovery-key + operator-password reset exposed. | **Two layers (CLAUDE.md §2):** (a) Caddy edge returns **404** for `/api/v1/account*` and `/api/v1/remote*` (never routed off-box); (b) replace both routers' IP-only check with the shared `isTrustedLoopback(req)` = loopback **AND** no XFF. Fail-closed verify gate asserts a non-loopback / XFF-bearing request gets 403 on both. |
| T-2 | Unauthenticated read of vault data over the relay | Default-**deny** gate at the `server-rest` choke point: networked request to any `/api/v1/*`,`/ingest/*`,`/portal/*` without a valid session/Bearer → 401. Loopback (no-XFF) bypass only. |
| T-3 | Loopback spoofing to skip the gate | A remote client can *add* XFF (→ treated networked → must auth) but cannot *remove* the XFF Caddy injects. `:8787` stays bound to `127.0.0.1`, so only local processes reach it without XFF — the pre-existing trust boundary. |
| T-4 | CSRF on cookie-authed data writes | SameSite=Lax already blocks cross-site cookie POSTs. Defense-in-depth: gate **requires** a custom header on cookie-authed unsafe methods (the SPA already sends `X-CSRF-Token`; set the `mycelium_csrf` cookie server-side — today it's read but **never set**, S5). Bearer-authed requests are exempt (no ambient credential). |
| T-5 | Plaintext on the wire / at the relay | TLS terminates **on the Mac**; relay is SNI-passthrough (`runtime.js:39-57`). No plaintext leaves the box. (Noise channel deferred, not required.) |
| T-6 | Token/secret leakage in logs | Reuse existing discipline: never log Authorization/cookie; `matchStaticBearer` already never logs; the new gate logs only `auth=yes/no` like `server-http.js:265`. |
| T-7 | Session theft via a stolen cookie | Accepted at V1 parity with the desktop/OAuth model; SameSite=Lax + Secure + HttpOnly + short session TTL. Bearer path unchanged. |

## Target architecture

```
WebView origin = https://<handle>.mycelium.id   (one origin to the browser)
        │ TLS
   RELAY (frps, SNI passthrough — never terminates TLS)
        │ tunnel
   Mac Caddy (terminates TLS; path-routes — NEW: was flat → :4711)
   ├─ /api/auth/*  /login  /mcp  /.well-known/*  /v1/*        → 127.0.0.1:4711  (server-http)
   ├─ /api/v1/account*  /api/v1/remote*                        → 404 (never off-box)   ← V-1 layer (a)
   └─ everything else  ( / , /api/v1/portal/* , assets )       → 127.0.0.1:8787  (server-rest)
                                                                      │
                                  NEW fail-closed gate at the choke point (:298-304):
                                  loopback+no-XFF → owner (desktop) ; else require session|Bearer
                                  validated by a 2nd better-auth instance over the SHARED auth.db
```

Login UX (V1): webview → `/auth/session` 401 → SPA login screen POSTs operator email+password to
**`/api/auth/sign-in/email`** (same-origin to the browser; Caddy → `:4711`) → better-auth sets the
host-scoped session cookie → all subsequent `:8787` calls carry it. The operator password is the
one already set during remote-connect (`remote/router.js` `POST /password`). The Capacitor native
layer adds a Face-ID *app-lock*; it does not hold vault keys.

## Module shape (signatures + LOC budget, ±20%)

1. **`src/http/loopback.js`** *(new, ~25 LOC)* — single source of truth:
   `export function isTrustedLoopback(req): boolean` = socket peer ∈ {127.0.0.1, ::1,
   ::ffff:127.0.0.1} **AND** `!req.headers['x-forwarded-for']`. Replaces the three inlined copies
   (measurement bridge, account, remote).
2. **`src/server-rest.js`** *(~55 LOC)* — (a) **(v3)** no local better-auth instance; instead
   `async function resolveRequester(req): {id}|null` = `isTrustedLoopback(req)` → `{id:userId}`;
   else **forward `Cookie` to `http://127.0.0.1:${MYCELIUM_PORT||4711}/api/auth/get-session`**
   (fail-closed: non-200/empty/`:4711`-down → null) → `{id:user.id}`; else `matchStaticBearer`
   locally (env secret, shared) for the future Bearer client → `{id}`; else `null`. (Optionally
   memoize a valid session for a few seconds keyed on the cookie to avoid a round-trip per asset.)
   (c) Insert `requireVaultAuth` middleware **before** the `:298` delegation: for
   `/api/v1/*`,`/ingest/*`,`/portal/*`, if `resolveRequester(req)` is null → `401`; for unsafe
   methods on a cookie-authed request, require `X-CSRF-Token` matching the `mycelium_csrf` cookie
   → else `403`. (d) Set `mycelium_csrf` cookie on first GET if absent.
3. **`src/auth-shim.js`** *(~15 LOC)* — `/auth/session`: loopback → shim user (desktop unchanged);
   networked → `resolveRequester` → `{user}` or `401`. Keep `/setup-status`, `/logout`.
4. **`src/account/router.js`, `src/remote/router.js`** *(~4 LOC each)* — swap the IP-only check for
   `isTrustedLoopback(req)`.
5. **`src/remote/runtime.js`** *(~30 LOC)* — `renderCaddyfile` becomes path-aware: add a second
   `portalUpstream = '127.0.0.1:8787'` and emit `handle`/`handle_path` blocks per the diagram
   (incl. the `respond 404` for the two control prefixes). Preserve `/p`,`/s` → `:8788` if/when
   publish-over-relay is wanted (note only; not in scope).
6. **Process supervision** *(wiring, ~15 LOC where the app spawns Node)* — remote mode now needs
   **both** `--http` (`:4711`) and the portal (`:8787`) running. Confirm/extend whatever the
   Tauri/`materializeRemoteConfigs` path starts (today it materializes frpc+Caddy but the design
   doc must name who guarantees both Node processes are up). *Spike before building step 5.*
7. **`portal-app`** *(separate, SPA)* — a real operator-password login screen posting to
   `/api/auth/sign-in/email`; keep `SECURE_CHANNEL` off. (Its own follow-up PR.)

**Total backend budget: ~150 LOC** across 6 files + the SPA login screen.

## Edge cases — explicit decisions

- **Desktop (loopback, no XFF):** unchanged — `isTrustedLoopback` true → owner, shim still works.
- **A local process other than Caddy hitting `:8787`:** treated as owner (no XFF) — identical to
  today's trust model; `:8787` stays loopback-bound so this is local-only. Accepted.
- **Relayed request with a spoofed `X-Forwarded-For`:** treated as networked → must auth. Safe.
- **Bearer vs cookie:** gate accepts either; Bearer exempt from the CSRF-header requirement.
- **`/api/v1/account` during first-run over the relay:** disallowed — setup is a loopback/desktop
  ceremony by design; mobile is for an already-provisioned vault. The relay 404 enforces it.
- **Better-auth secret rotation invalidates sessions:** acceptable (documented "revoke all").

## Test strategy (new GO-gated verify suites)

- **`scripts/verify-portal-auth.mjs` (`verify:portal-auth`)** — boot `server-rest` with an
  in-memory better-auth (`dbPath:':memory:'`, seeded operator). Assert: (1) loopback no-XFF GET
  `/api/v1/portal/...` → 200; (2) simulated networked (set `x-forwarded-for`) **without** cookie →
  401; (3) with a valid session cookie from `sign-in/email` → 200; (4) with a valid static Bearer
  → 200; (5) cookie-authed POST without `X-CSRF-Token` → 403, with it → 200.
- **`scripts/verify-control-loopback.mjs` (`verify:control-loopback`)** — V-1 regression: GET
  `/api/v1/account` and POST `/api/v1/remote/password` with `x-forwarded-for` set → **403/404**,
  asserting the recovery key never appears in the body (extend `verify:leak`).
- **`scripts/verify-relay-portal.mjs` (`verify:relay-portal`)** — render the Caddyfile; assert the
  rendered config routes `/api/auth/*`→:4711, `/`→:8787, and `respond 404` for
  `/api/v1/account*` + `/api/v1/remote*` (static assertion, no live relay).
- Add all three to the `npm run verify` chain + `.github/workflows/verify.yml`.
- **Real-browser smoke (per `deploy-and-verify`):** the MCP-Inspector-class lesson applies —
  curl gives false greens on cookies/CORS. Verify the actual login→session→data flow in a **real
  WebKit** webview against a relayed box before declaring done.

## Implementation order (each step independently shippable + smoke)

1. **`isTrustedLoopback` + fix V-1** (steps 1, 4) + `verify:control-loopback`. *Smoke:* the new
   gate rejects an XFF-bearing request to `/api/v1/account`. **Ships a security fix on its own.**
2. **`server-rest` auth gate** (step 2-3) + `verify:portal-auth`. *Smoke:* networked request
   denied without a cookie; loopback still 200 (desktop unaffected — run `verify:portal-data`).
3. **Path-aware Caddyfile** (step 5) + `verify:relay-portal`. *Smoke:* render + assert routing.
4. **Process supervision spike + wiring** (step 6). *Smoke:* both `:4711` and `:8787` up under
   remote mode; relayed `/auth/session` returns 401 (not 404), `/login` reachable.
5. **SPA operator-password login** (step 7). *Smoke:* real-browser login→session→Library loads
   over a relayed box.

## Decision criteria to proceed to the Capacitor shell (mobile §6)

Falsifiable: proceed only when **all three new verify suites are GO**, `verify:portal-data` +
`verify:leak` still pass (no desktop regression, no plaintext leak), **and** a real-WebKit smoke
shows operator-password login → `/auth/session` 200 → an authenticated `/api/v1/portal/library`
read over an actual relayed `<handle>.mycelium.id`, with `/api/v1/account` returning 404 at the
edge in the same run.

## Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| V-1 ships unfixed / regresses | low | critical (recovery-key leak) | Step 1 first + standing `verify:control-loopback`; security review required |
| ~~`getSession` over shared `auth.db`~~ **(v3: removed)** — replaced by loopback-forward to `:4711` | — | — | No 2nd instance, no shared-SQLite writes; `:4711` is the sole authority. New residual: `:4711` reachability (below) |
| Cookie-validation mechanism unconfirmed (deps not installable in this container) | med | high | **Spike #1 on a real host:** `npm install` then verify `GET :4711/api/auth/get-session` with a cookie minted by `signInEmail` returns `{user}`; only then wire the gate. Build step 2 is blocked on this spike. |
| `:4711` down while the gate forwards to it | low | med (portal 401s) | Fail-closed by design (deny). `:4711` runs whenever remote is on (`main.rs:268`); when off, requests are loopback and bypass. Surface a clear "vault auth service unavailable" 503 vs 401. |
| Express `trust proxy` / `req.ip` surprises flip the loopback check | med | high | Don't use `req.ip`; use `socket.remoteAddress` + XFF-absence explicitly in `isTrustedLoopback`; assert in tests |
| Only `:4711` runs in remote mode; `:8787` not supervised | med | med (portal 502) | Step 4 spike resolves who supervises both before the Caddy split lands |
| App Store rejects a thin webview (mobile §8) | med | med | Handled in the mobile doc, not here |

## Open questions resolved during the sweep

- *"Reuse the same OAuth gate as :4711"* — there is no shared gate; `:4711` and `:8787` are
  separate processes with separate (and, for `:8787`, no) auth. Resolved → 2nd better-auth
  instance over shared `auth.db`.
- *"Sensitive reads ride the Noise channel"* — no server-side Noise in V1. Resolved → dropped;
  TLS-on-Mac is the boundary.
- *"Passkey/PRF works on phones (mobile §2 reuse claim)"* — not server-side-enabled in V1.
  Resolved → operator password for V1; passkey is a named follow-on.
- *"Generalize the measurement loopback split"* — yes, and it exposed V-1 (account/remote use a
  weaker IP-only check). Resolved → one shared `isTrustedLoopback`.

## Open questions deferred (named so they don't ambush a later phase)

- Enabling better-auth's **passkey plugin** + wiring the SPA's existing passkey UI (Face-ID
  *cryptographic* unlock, not just app-lock). Its own design.
- **Publish-over-relay** (`/p`,`/s` → `:8788`) coexisting with the path-routed Caddy.
- A **bundled-SPA + Bearer** mobile client (mobile doc's "mature target") — would lean on the
  Bearer branch this gate already accepts, plus runtime Noise-key pairing if Noise is ever built.
- **Multi-box / multi-handle** discovery.

## Verification table

| Assumption | Verified at (read by me) |
|---|---|
| `server-rest` (portal+data) has no per-request auth; uses an "always signed in" shim | `src/auth-shim.js:11-26,42`; `src/server-rest.js:289-304` |
| The single choke point for all vault-data routes is the `:298-304` delegation | `src/server-rest.js:297-304` |
| The measurement bridge is the only authed surface; uses loopback **+ no-XFF** | `src/server-rest.js:110-118` |
| `server-rest` binds `127.0.0.1:8787` by default | `src/server-rest.js:343-344` |
| `server-rest` has **no** better-auth import/usage today | grep over `src/server-rest.js` (createAuth/getSession/passkey → none) |
| better-auth lives on `:4711`, mounted `/api/auth/*splat` via `toNodeHandler` | `src/server-http.js:113` |
| `/login` on `:4711` is an email+password form → `signInEmail` → OAuth authorize | `src/server-http.js:166-182` |
| `authenticate`/`matchStaticBearer` Bearer gate exists on `:4711` (reusable logic) | `src/server-http.js:214-255`; `src/gateway/static-bearer.js:45-57` |
| better-auth: `emailAndPassword` only; `jwt`+`mcp` plugins; **no passkey**; no cookie/domain override | `src/auth.js:63-98` |
| `baseURL` derives from `MYCELIUM_BASE_URL`/remote config; cookie host-scoped by default | `src/auth.js:35-36,63-98` |
| Mac Caddy renders a **flat** single `reverse_proxy 127.0.0.1:4711` (no path matchers) | `src/remote/runtime.js:16,70-110,97` |
| Relay is **SNI passthrough**; TLS terminates on the Mac | `src/remote/runtime.js:39-57`; `mycelium-managed/relay/frps.toml` |
| `:4711` and `:8787` are **separate processes**; `--rest` not in the index dispatch | `src/index.js:129-136`; `src/server-rest.js:343` |
| **No server-side WebSocket/Noise channel** (`ws` absent, no upgrade handler) | `package.json` (no `ws`); grep `src/` for upgrade handler → none |
| SPA uses same-origin cookie + `mycelium_csrf`→`X-CSRF-Token`; 401→/login | `portal-app/src/lib/api.ts:35-73` |
| `mycelium_csrf` is read by the client but **never set** server-side | grep `src/` for `mycelium_csrf` → none |
| **V-1:** `/api/v1/account` returns `{recoveryKey}`; both control routers gate on loopback-IP only (no XFF) | `src/account/router.js:32-33,64`; `src/remote/router.js:43-44` |
