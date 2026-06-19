# Require a passkey for web sign-in — design

**Date:** 2026-06-19
**Status:** design locked (decisions below), implementation in `feat/require-passkey-web`
**Companions:** builds on #280 (handle-not-email login + web-access hardening). Sweep evidence inline.

## Goal

For a vault exposed to the web (relay), let the operator require a **passkey** (WebAuthn — Touch ID / Face ID / security key) for sign-in, so the operator password alone is not a sufficient web credential. Opt-in, default off. Must never permanently lock the owner out.

## Sweep — load-bearing mechanics (file:line)

1. **Sessions are untaggable.** `@better-auth/passkey` `verify-authentication` mints a session via the same `internalAdapter.createSession` + `setSessionCookie` as password sign-in; the `session` row has no auth-method field, and passkeys use a dedicated `passkey` table (not an `account` row), so a session is NOT linked to how it was authenticated. → **Enforce by blocking the password LOGIN ENDPOINTS, not at request/session validation.**
2. **The desktop path never logs in.** Loopback is "always signed in" via `src/auth-shim.js` (no better-auth session); the login endpoints are exercised ONLY over the relay. → blocking password login affects web only; desktop is untouched.
3. **rpID is frozen per-boot from the mutable handle.** `src/auth.js` sets passkey `rpID = new URL(baseURL).hostname` (= `<handle>.mycelium.id`). The handle is `publicHost.split('.')[0]`, rewritten on domain change/disconnect. A WebAuthn credential is bound to its rpID, so a host change orphans every enrolled passkey. → **the policy must auto-disable on host change** (else a rename locks out web access).
4. **No-lockout fallback is structural.** Desktop loopback (`require-vault-auth.js isTrustedLoopback`) and the recovery-key flow (`src/account/router.js`, loopback-only) are independent of better-auth/passkey and always work.
5. **Connector WebAuthn is feasible.** The passkey JSON endpoints (`/api/auth/passkey/generate-authenticate-options`, `/verify-authentication`) round-trip the challenge in a signed `better-auth-passkey` cookie, so a plain (non-SPA) page can drive them with the browser WebAuthn API. `server-http.js` `/login` has no CSP today (a first-party `/login.js`, served `'self'`, is CSP-safe if the page is ever unified under the portal CSP).

## Decisions

- **D1 — Coverage: BOTH portal + connector.** Add WebAuthn to the OAuth `/login` form (a first-party `/login.js`) so MCP connectors also require the passkey. Otherwise the password stays a full credential via the connector path (false security for the portal requirement).
- **D2 — Passkey-only for web.** When enabled, web sign-in uses the passkey alone (no password step). WebAuthn is already strong multi-factor (possession + biometric/PIN) and phishing-resistant. The password is kept for bootstrap (enrolling the first passkey) and is retired from web once the policy is on.
- **D3 — Opt-in, default OFF; enableable only after ≥1 passkey is enrolled.** A new non-secret `requirePasskeyForWeb` in `remote.json`. The enforcement also gates on `passkeyEnrolled()` so the policy is INERT until a passkey exists (no bootstrap lockout).
- **D4 — Auto-disable on host change.** `writeRemoteConfig` resets `requirePasskeyForWeb=false` whenever `publicHost` changes to a different value (rpID-orphan safety).
- **D5 — No-lockout invariant.** Desktop loopback + recovery key remain the always-available escapes; the policy only governs relay sign-in endpoints.

## Enforcement points (block password sign-in when `requirePasskeyForWeb && passkeyEnrolled()`)

| Endpoint | Owner | Guard |
|---|---|---|
| `POST /api/auth/operator-login` (portal shim, #280) | ours | inline 403 `{error:'passkey_required'}` before checking the password |
| `POST /api/auth/sign-in/email` (better-auth catch-all) | better-auth | pre-middleware (mirror the sign-up block) → 403 |
| `POST /login` (OAuth connector form) | ours | inline → re-render the form passkey-only |

## UI

- **Connector `/login`:** add a "Sign in with passkey" button + first-party `/login.js` (WebAuthn driver: generate-authenticate-options → `navigator.credentials.get` → verify-authentication → navigate to the authorize URL / portal). When the policy is on, render passkey-only (hide the password field).
- **Portal SPA:** already has "Sign in with passkey." On a `passkey_required` 403 from the shim, surface "this vault requires a passkey" and the existing passkey button carries the user in. Hide the password field when required.
- **Settings:** a "Require a passkey for web sign-in" toggle, enableable only after a passkey is enrolled (`PUT /api/v1/remote/config { requirePasskeyForWeb }`).

## No-lockout proof

Enabling the policy blocks only the three relay password endpoints. The owner always retains: (a) desktop loopback access (no login), (b) the loopback-only recovery-key flow. A host change auto-disables the policy (D4). So there is no permanent-lockout path.

## Verification plan

Headless-testable (gates + smokes): config read/write + auto-disable on host change; `passkeyEnrolled` count; the three guards block password when policy on + enrolled, ALLOW when off or no passkey; `/login` renders the passkey button + serves `/login.js`; `verify:auth-hardening` stays green.
Real-device (operator smoke, like all passkey work here): the actual WebAuthn ceremony on a Mac (Touch ID) for both the portal and the connector `/login`.
