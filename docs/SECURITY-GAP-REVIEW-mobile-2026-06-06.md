# Security & Gap Review — Mobile effort (Phases 1–5.3)

**Date:** 2026-06-06 · **Branch:** `claude/lucid-faraday-4DqC9` · **PR #101**
**Scope:** the full diff vs `main` for the mobile work — the portal auth gate, the V-1
control-surface fix, relay path-routing, operator-password login, passkey (WebAuthn), the
`better-auth` bump, and the Capacitor scaffold. **This is a self-review** (the author wrote the
code); it is **not** a substitute for the independent human sign-off CLAUDE.md requires for
security-sensitive diffs — that is explicitly deferred to last, before merge.

Findings were **fixed in-line** as found (Phase-1 review + this gap pass), each with a standing
verify gate. Status: **all 13 in-repo gates GO**; remaining items are host/device or by-request.

## Method

Adversarial read of every changed security file + live pressure-tests with deps installed
(`npm install` works in-env). Each component was checked against CLAUDE.md §1–13 (fail-closed,
zero plaintext leakage, defense in depth, no cross-tenant bleed).

## Findings — FIXED

| # | Severity | Finding | Fix | Gate |
|---|---|---|---|---|
| H1 | High | Gate "is this a data path?" used a hand-rolled `req.path` string check that could diverge from Express routing (encoding / `//`) → bypass | Mounted the gate at `v.use('/api', …)` so Express matches gate + routers identically | `verify:portal-auth` I |
| H2 | High | **V-1**: `/api/v1/account` (returns the recovery key) + `/api/v1/remote` (sets operator password) gated on loopback-IP only → a reverse proxy defeats it → leak once `:8787` is relayed | Shared `isTrustedLoopback` = loopback **and** no proxy headers; **plus** Caddy 404s these at the edge (defense in depth) | `verify:control-loopback`, `verify:relay-portal` |
| H3 | High | **No brute-force protection** on the relay-exposed operator password (`/api/auth/sign-in/email`, `/login`). better-auth's per-IP limiter can't key behind Caddy (all `127.0.0.1`) and trusting XFF is spoofable | Global, un-evadable path throttle (`src/http/rate-limit.js`) 5/60s on sign-in + `/login`, 10/60s on passkey verify | `verify:auth-hardening` A1 |
| M1 | Med-High | **False logout**: the shim `/auth/logout` was a no-op → a networked user kept a valid session cookie after "logging out" | Networked logout forwards cookie + Origin to `/api/auth/sign-out` → revokes + clears | `verify:auth-hardening` B4 |
| M2 | Med | `defaultValidateSession` had no timeout → a hung `:4711` stalls every networked request | 5s `AbortController` → fail-closed (401) | `verify:portal-auth` |
| M3 | Med | Loopback trust hinged on a single header (`X-Forwarded-For`) | Broadened to `X-Forwarded-For` / `Forwarded` / `X-Real-IP` / `X-Forwarded-Host` | `verify:control-loopback` A8/A9 |

## Verified safe (checked, no change)

- **Session authority is unified.** Passkey login (the official `@better-auth/passkey`) mints a
  **native better-auth session**, so the gate accepts it via the same `get-session` forward — no
  custom/dual session surface. (Sweep-verified; this is *why* the custom port was rejected.)
- **Passkey rpID is per-box** = `<handle>.mycelium.id` (from `baseURL`), **not** the parent
  `mycelium.id` — so a credential on box A cannot authenticate to box B (cross-tenant isolation
  holds on shared relay infra). `verify:passkey` asserts `rpId === <subdomain>`.
- **`isTrustedLoopback` can't be spoofed** — keyed on the kernel-set socket peer (not `req.ip`);
  failure direction is fail-closed. A misbound `:8787` (0.0.0.0) still forces auth.
- **The gate reads headers only** — never consumes the raw upload body; CSRF compare is
  constant-time; `matchStaticBearer` is constant-time + returns false when unset (no empty-secret
  bypass).
- **The `better-auth` 1.6.13→1.6.14 bump + the passkey plugin do not regress** MCP/OAuth
  (`verify:oauth`/`mcp`/`mcp-discovery` GO with the plugin live — Spike S1).
- **Enrollment is auth-gated** (`generate-register-options` → 401 unauth); login challenge
  (`generate-authenticate-options`) is intentionally pre-auth.
- **Mobile shell**: `allowNavigation` scoped to `*.mycelium.id` (not `*`); no hardcoded URL;
  persists only the handle (no keys). `mobile/scripts/check-config.mjs` enforces these.

## Accepted risks (with rationale)

- **CSRF cookie not `Secure`** — TLS terminates on the Mac (relay is passthrough, no plaintext on
  the wire); the token is a non-secret double-submit value, `SameSite=Lax`; the real credential
  (better-auth session) stays HttpOnly+Secure.
- **Throttle self-DoS** — the global sign-in bucket means an attack also throttles the owner for
  that 60s window. Accepted for a single-user vault in exchange for un-evadable protection.
- **`@better-auth/passkey` supply-chain** — new transitive deps (`better-call`, `@better-auth/core`,
  `nanostores`, `@better-fetch/fetch`, `zod`). It's the official plugin; lockfile-pinned.

## Gaps (open — none blocking further build; several gate the *deploy*)

| Gap | Kind | Note |
|---|---|---|
| Real-WebKit relay smoke | host | login→session→data + `/api/v1/account` 404 over an actual relayed box; curl gives false greens on cookies/CORS. Phase-1 exit criterion. |
| WebAuthn-in-Capacitor-WKWebView (Spike S2) | device | If WKWebView can't do platform WebAuthn, the shell uses the (shipped) password fallback; passkey still works in Safari/PWA. |
| Full `npm run verify` after the bump | host/CI | Only the auth-relevant subset + portal build were run in-env; run the whole chain on CI/host to confirm no unrelated regression. |
| iOS/Android device build + TestFlight/Play | host | Xcode/Gradle + signing — operator steps. |
| Dead `src/db/passkeys.js` + legacy `passkey_credentials` table | cleanup | The plugin uses its own table; the legacy file is unused. Remove via a `pre-deletion-caller-audit` (separate). |
| Fast-follows not built | scope | push, QR/deep-link pairing, share-import, Android (Phase 5). |
| **Licensing** (AGPL × App Store) | legal | Must resolve before TestFlight — `mobile/LICENSE.md`, `MEMORY.md`. |
| **Human security review** | process | Deferred to last by request; required before merge. |
| Branch behind `main` | merge | Other sessions advanced `main`; a final merge-up is needed before review/merge. |

## Verdict

The relay-exposed auth surface is **fail-closed and hardened**: the vault data API is
authenticated, the recovery-key/operator-password control surfaces are fenced off in depth
(code + edge), brute force is throttled on every password path, logout truly revokes, and passkey
auth is per-box and session-unified. Six findings were fixed with standing gates; the residual
items are host/device validation, the legal licensing call, and the human review — all already
on the books. **Recommend: human security sign-off + the host relay smoke before merge.**
