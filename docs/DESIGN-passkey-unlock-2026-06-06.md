# Design — Passkey (WebAuthn) unlock — Phase 5.3

**Date:** 2026-06-06
**Status:** Design (sweep-first: 2 cycles, 4 Explore sweeps + own-eyes pressure-tests with deps
installed). **No code yet.** Security-sensitive (auth) + a dependency change → human review before
merge. Parent: `MOBILE-DEVELOPMENT-PLAN-2026-06-05.md` Phase 5.3.

## Revision history (the sweep nearly led us astray twice — this is why we sweep)

- **v1 (plan sketch):** "enable better-auth's passkey plugin in `createAuth`." Assumed the plugin
  ships inside `better-auth`.
- **v2 (after Sweep A):** REFUTED — `better-auth@1.6.13` has **no** passkey plugin
  (`better-auth/dist/plugins/` has 32 plugins, none passkey; `@simplewebauthn/server` absent). Sweep
  proposed porting the cloud product's custom WebAuthn from `reference/`. Sweep #2 then found that path
  is **also wrong**: the reference has only the *management* routes + db + schema + PRF — the WebAuthn
  *engine* and `/auth/passkey/login|register/*` handlers are **not in `reference/`** (un-included worker
  layer), and the cloud issued **custom D1 session tokens, not better-auth**. That collides with V1: the
  auth gate (step 1.2) validates **better-auth** sessions via `:4711/api/auth/get-session`, so a custom
  passkey session cookie would not be recognized → a "logged-in" user the gate 401s.
- **v3 (after my pressure-test — LOCKED):** the official plugin is a **separate package**,
  `@better-auth/passkey@1.6.14` (Sweep A missed it by only listing the main package). It **bundles
  `@simplewebauthn/server ^13.2.3` + `browser ^13.2.2`** (deps, not peer) and integrates with
  better-auth's own session system → **passkey login mints a native better-auth session the existing
  gate already accepts.** No custom session, no dual-auth surface. Requires `better-auth ^1.6.14` (we're
  on 1.6.13 — a patch bump).

## TL;DR

- **Add the official plugin**, don't port. `npm i @better-auth/passkey` + bump `better-auth` 1.6.13→1.6.14;
  add `passkey({ rpID, rpName, origin })` to `createAuth` (`src/auth.js`). `migrateAuth` creates the
  plugin's credential table. Endpoints land at the better-auth convention `/api/auth/passkey/*` (already
  relay-routed to `:4711` by step 1.3).
- **rpID/origin = the per-box relay subdomain** (`https://<handle>.mycelium.id`), derived from the
  `baseURL` better-auth already computes (`auth.js:35-36`, set by Tauri `MYCELIUM_BASE_URL`,
  `main.rs:280`). A passkey is bound to that rpID.
- **Auth-only, no PRF.** V1 vault keys live server-side (key source on the box); passkey is purely a
  login credential — drop the cloud's PRF/URK derivation. SPA's `passkey-prf.ts` confirms PRF is optional.
- **Enrollment requires an existing session.** Flow: operator-password login (Phase 2) → "Enable Face ID"
  enrolls a passkey → subsequent logins use it; operator password stays as fallback/recovery.
- **Two gating spikes** (can't be done in this container): (1) the better-auth patch bump must not
  regress the load-bearing MCP/OAuth (`verify:oauth`/`mcp`/`mcp-discovery`); (2) **WebAuthn-in-Capacitor-WKWebView**
  feasibility on a device. Both are build/host spikes; the server+SPA work is valid for browsers/PWA
  regardless.

## Sweep findings (consolidated, file:line)

- **No plugin in `better-auth@1.6.13`**; it is `@better-auth/passkey@1.6.14`, deps bundle
  `@simplewebauthn/{server ^13.2.3,browser ^13.2.2}` + `zod`; peer `better-auth ^1.6.14` (npm metadata,
  verified by `npm view`). `better-auth/plugins/passkey` does **not** resolve at 1.6.13
  (`ERR_PACKAGE_PATH_NOT_EXPORTED`, verified).
- **SPA passkey UI is wired but dead**: `portal-app/src/routes/login/+page.svelte:382-431` (login →
  `/auth/passkey/login/{options,verify}`) + `:434-483` (register → `/auth/passkey/register/{options,verify}`),
  using `@simplewebauthn/browser ^13.2.2` (`portal-app/package.json:13`). PRF is **optional** —
  `passkey-prf.ts:96-115` strips it on mobile and the flow runs auth-only (`urk:null`). `api()` does **not**
  rewrite `/auth/*` or `/api/auth/*` (`api.ts:35-48`) — direct fetch passes through. Settings has an
  add-passkey UI at `/portal/passkeys/*` (`SettingsView.svelte:600-623`).
- **rpID source**: `baseURL = publicBaseUrl || localhost:4711` (`auth.js:35-36`); relay sets it to
  `https://<publicHost>` (`remote/config.js:69-71`, `main.rs:280`). So rpID = `<handle>.mycelium.id`.
- **Schema already present**: `passkey_credentials` (`migrations/0001_init.sql:976-983`) — but the
  better-auth plugin manages its **own** table via migration, so the legacy table + dead
  `src/db/passkeys.js` are NOT used by this design (left as-is; not wired).
- **Session authority**: V1's gate forwards the cookie to better-auth `get-session` (step 1.2). The
  official plugin issues better-auth sessions → recognized with **zero gate change**.

## Architecture (v3)

```
SPA (login)  ──/api/auth/passkey/generate-authenticate-options──▶ :4711 better-auth + @better-auth/passkey
   startAuthentication() (Face ID)                                   │ verifies, sets better-auth session cookie
   ──/api/auth/passkey/verify-authentication──────────────────────▶ │
                                                                     ▼
            session cookie ──▶ the gate (step 1.2) forwards to get-session ──▶ authorized
Enrollment (post operator-password login):
   SPA "Enable Face ID" ──/api/auth/passkey/generate-register-options──▶ (auth required)
   startRegistration() ──/api/auth/passkey/verify-registration──▶ credential stored
```

rpID/origin = `https://<handle>.mycelium.id` (relay). Operator password remains the fallback + the
enrollment gate. Keys stay server-side (no PRF).

## Threat model

| Threat | Mitigation |
|---|---|
| Passkey login bypasses the vault gate | None — the plugin mints a **better-auth** session; the existing gate validates it identically to password login. No new session path. |
| Enrollment by an unauthenticated attacker | The plugin's register endpoints require an authenticated session; enrollment only after operator-password login. |
| rpID mismatch / phishing | rpID bound to the exact box subdomain; WebAuthn origin check is intrinsic. A passkey for box A cannot be used on box B. |
| Dependency-bump regression of MCP/OAuth (load-bearing) | **Spike S1**: after the 1.6.13→1.6.14 bump, `verify:oauth` + `verify:mcp` + `verify:mcp-discovery` must stay GO before anything else. |
| Lost device / lost passkey | Operator password remains a full fallback; ≥1 passkey + password always available. Don't allow deleting the last credential (mirror reference `countByUser` guard) — but the plugin owns its table; rely on password fallback. |
| WebAuthn unavailable in the Capacitor WKWebView | **Spike S2 (device)**: if WKWebView can't do platform WebAuthn, the shell falls back to operator-password (already shipped); passkey still works in mobile Safari/PWA. Native bridging (ASWebAuthenticationSession) is a deferred option. |
| New attack surface (the plugin) | It's the official, @simplewebauthn-backed plugin; audited upstream. No custom crypto written here. |

## Module shape (±20%)

- **deps**: `@better-auth/passkey@^1.6.14`, bump `better-auth ^1.6.14`. (~2 lines `package.json`.)
- **`src/auth.js`** (~8 LOC): import `passkey` from `@better-auth/passkey`; add to `plugins`:
  `passkey({ rpID: hostFrom(baseURL), rpName: 'Mycelium', origin: baseURL })` where `hostFrom` strips
  scheme/port. localhost dev → rpID `localhost`.
- **SPA `login/+page.svelte`** (~40 LOC net): repoint the existing passkey login flow at
  `/api/auth/passkey/generate-authenticate-options` + `/verify-authentication` (keep raw
  `@simplewebauthn/browser`); drop the PRF/URK branch (auth-only). Keep the `passkey` mode but only show
  it when the user has ≥1 enrolled credential; otherwise the operator-password mode (Phase 2) leads.
- **SPA enrollment** (~30 LOC): an "Enable Face ID / add passkey" action (post-login; Settings or a
  one-time prompt) → `/api/auth/passkey/generate-register-options` + `/verify-registration`.
- **`verify:passkey`** (new): boot a real better-auth+plugin instance; assert the 4 endpoints exist,
  a register→authenticate round-trip mints a session that `get-session` validates, and an unauth
  register is rejected. (Server-side; the browser WebAuthn ceremony is stubbed with a known test
  authenticator or asserted at the options/endpoint level — full ceremony = device/Playwright, host.)
- **Total: ~90 LOC + deps + the new verify.** (Server side is tiny; the SPA rewire is the bulk.)

## Edge cases — decisions

- **No passkey enrolled yet** → operator-password login (Phase 2) is the entry; passkey mode hidden.
- **PRF** → dropped (V1 keys are server-side). `urk` never sent.
- **rpID change** (handle/relay changes) → existing passkeys invalidate; re-enroll. Password fallback covers it.
- **Desktop/loopback** → no `/login` (the shim authorizes loopback); passkey is a networked feature.
- **Legacy `passkey_credentials` table + `src/db/passkeys.js`** → left untouched; the plugin uses its own table. (A future cleanup can remove the dead file — separate `pre-deletion-caller-audit`.)

## Test strategy

- `verify:passkey` (new, in chain + CI): plugin endpoints exist; auth required for register; a
  register+authenticate round-trip (via `@simplewebauthn/server`'s test helpers or a scripted
  authenticator) yields a session valid at `get-session`; rpID derives from baseURL.
- **Regression (mandatory after the bump)**: `verify:oauth`, `verify:mcp`, `verify:mcp-discovery`,
  `verify:portal-auth`, `verify:relay-portal` all GO.
- **Host/device**: real-WebKit (mobile Safari) passkey enroll+login over a relayed box; then the
  Capacitor WKWebView feasibility (S2).

## Implementation order

0. **Spike S1** (host/in-env): `npm i @better-auth/passkey better-auth@^1.6.14`; boot better-auth with
   the plugin; confirm the 4 `/api/auth/passkey/*` routes + that a scripted register→authenticate mints
   a `get-session`-valid session; **re-run `verify:oauth`/`mcp`/`mcp-discovery`** — GO gate. *Blocks all.*
1. `src/auth.js` plugin + rpID config + `verify:passkey`. Smoke: endpoints 200; regressions GO.
2. SPA login rewire to the plugin routes (auth-only). Smoke: portal build; real-browser enroll+login.
3. SPA enrollment action. Smoke: enroll → re-login by passkey.
4. **Spike S2** (device): WebAuthn in the Capacitor WKWebView; decide direct vs ASWebAuthnSession bridge.

## Decision criteria

Proceed past step 0 only if the better-auth bump keeps `verify:oauth`/`mcp`/`mcp-discovery` GO **and**
the plugin mints a gate-valid session. Ship to the mobile shell only after S2 (or with the documented
password fallback if WKWebView can't do platform WebAuthn).

## Risks

| Risk | L | I | Mitigation |
|---|---|---|---|
| better-auth bump regresses MCP/OAuth | med | high | Spike S1 gate; it's a patch (1.6.13→.14); revert is one line |
| WKWebView can't do platform WebAuthn | med | med | Password fallback already shipped; native bridge deferred; works in Safari/PWA |
| Plugin peer-dep churn (`better-call`, `@better-auth/core`) | low | med | Lockfile; run full `npm run verify` after install |
| Dep-bump conflicts with concurrent sessions editing auth | med | low | Coordinate; the bump is isolated to `package.json` + `auth.js` |

## Open questions — resolved during sweep

- *"Enable the better-auth passkey plugin"* → it's a **separate package** `@better-auth/passkey`, not in
  `better-auth/plugins`. (Sweep A's "no plugin" was scoped to the main package only.)
- *"Port the reference WebAuthn"* → reference is incomplete (no engine/login handlers) **and** uses a
  custom session system incompatible with V1's better-auth gate. Rejected.
- *"Need PRF/URK?"* → no; V1 keys are server-side. Auth-only.
- *"Will passkey login satisfy the gate?"* → yes, the official plugin issues better-auth sessions.

## Open questions — deferred

- WKWebView WebAuthn feasibility + associated-domains / `apple-app-site-association` (device spike S2).
- Removing the dead `src/db/passkeys.js` + legacy `passkey_credentials` table (separate audit).
- Cross-device passkey sync / multiple credentials management UI polish.

## Verification table

| Assumption | Verified at (own eyes) |
|---|---|
| `better-auth@1.6.13` has no passkey plugin | `node -e import('better-auth/plugins/passkey')` → `ERR_PACKAGE_PATH_NOT_EXPORTED`; `'passkey' in better-auth/plugins` → false |
| Official plugin is `@better-auth/passkey@1.6.14`, bundles simplewebauthn server+browser ^13, peer better-auth ^1.6.14 | `npm view @better-auth/passkey@1.6.14 peerDependencies dependencies` |
| Installed better-auth is 1.6.13 (patch bump needed) | `node -e require('better-auth/package.json').version` → 1.6.13; `npm view better-auth@latest` → 1.6.14 |
| SPA passkey UI calls `/auth/passkey/login|register/*` w/ `@simplewebauthn/browser ^13`, PRF optional | Sweep B: `login/+page.svelte:382-483`; `passkey-prf.ts:96-115`; `portal-app/package.json:13` |
| `api()` doesn't rewrite `/api/auth/*` | `portal-app/src/lib/api.ts:35-48` (read) |
| rpID/origin derive from baseURL = `https://<handle>.mycelium.id` | `src/auth.js:35-36`; `src/remote/config.js:69-71`; `src-tauri/src/main.rs:280` |
| The gate validates better-auth sessions (so plugin sessions are accepted) | `src/http/require-vault-auth.js` `defaultValidateSession` (this branch) |
| `/api/auth/*` is relay-routed to :4711 | `src/remote/runtime.js` `edgeRoutes()` (this branch) + `verify:relay-portal` B3 |
| WebAuthn in Capacitor WKWebView | ⬜ NOT verified — device spike S2 (no device in-container) |
