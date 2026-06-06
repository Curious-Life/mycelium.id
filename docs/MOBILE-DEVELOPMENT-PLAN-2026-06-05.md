# Mobile — Development Plan

**Date:** 2026-06-05
**Status:** Plan (built on two sweep-first-design passes — see *Design inputs*). Sequenced, with
per-task files/LOC/verify/smoke/dependencies. **No app code yet.**
**Design inputs:**
- [`DESIGN-mobile-app-2026-06-05.md`](DESIGN-mobile-app-2026-06-05.md) — overall strategy (Capacitor, remote webview, iOS→Android).
- [`DESIGN-portal-auth-relay-2026-06-05.md`](DESIGN-portal-auth-relay-2026-06-05.md) — Phase 1 critical path (sweep-first, v3, with the V-1 vuln finding + verification table).

---

## Where it stands after two sweep cycles

The architecture is settled and most of the scary unknowns turned out to already be solved:

- **The plumbing exists.** Tauri already supervises **both** Node servers (portal `:8787` always,
  `--http :4711` when remote is on) **and** Caddy + frpc as children (`src-tauri/src/main.rs:225-338`),
  launching Caddy with the **Node-written Caddyfile**. Both processes share `MYCELIUM_DATA_DIR`. So the
  path-routed Caddyfile and the auth gate land with **no Tauri/Rust change**.
- **Auth lives on `:4711`, the portal on `:8787`** — separate processes; the portal has only a fake
  "always signed in" shim. The gate (v3) makes `server-rest` **forward the cookie to `:4711`'s
  `/api/auth/get-session`** — one auth authority, no shared-SQLite risk.
- **Onboarding is desktop-only by design.** Vault creation, recovery key, and the operator password
  are loopback-only ceremonies (`/api/v1/account/*` 403s non-loopback; operator password set via
  Settings → `RemoteAccessSection.svelte` → `/api/v1/remote/password`). **Mobile is purely a
  *log-into-an-existing-vault* client** — it never creates or recovers a vault.
- **The SPA has no email+password login** — all four existing login branches (passkey/master-key/
  telegram/setup) are **dead on self-hosted**. A new operator-password login branch is net-new SPA work.
- **No server-side Noise channel; no passkey plugin.** V1 mobile = operator password over TLS +
  native biometric *app-lock*. Confidentiality = TLS terminating on the Mac.
- **V-1 (latent vuln):** the two control surfaces gate on loopback-IP only → a reverse proxy defeats
  them → recovery-key/credential exposure the moment `:8787` is relayed. Fixed in Phase 1, step 1.

**Container limitation (honest):** this is a fresh clone with **no `node_modules`** — I can't run the
`verify:*` suites or inspect deps here. Every "verify GO" and dep-level claim below is a gate to run on
a real host (Mac with `npm install`). The cookie-validation mechanism is **Spike #1** (blocks Phase 1
step 2).

---

## Repo & licensing

**Repo: same repo.** Phase 1/2/3 are edits to existing `src/`, `src/remote/`, `portal-app/` — they
must live here. The native shell goes in a new **`mobile/`** subtree (sibling to `src-tauri/`, the
established in-repo native-shell pattern). Add a path-gated **`.github/workflows/mobile.yml`**
(`mobile/**`, macOS runner) so the iOS/Android build never entangles the Node `verify` chain.

**🚨 Licensing gate (blocks Phase 4 — App Store / TestFlight):** the repo is **AGPL-3.0**, and
distributing (A)GPL apps on Apple's App Store conflicts with Apple's ToS (VLC/GNU precedent).
**Intent: server+portal stay AGPL (open); the mobile shell ships closed-source.** Assessment (not
legal advice): **likely viable** because the remote-webview shell bundles **no** AGPL code (arm's-
length HTTP client = separate work) and Curious-Life owns the copyright. **Conditions:** the shell
must never bundle the AGPL SPA (⇒ the deferred "bundled-SPA" variant is incompatible with a
closed-source shell — a real constraint on §5.4); the shell's own deps must be permissive; `mobile/`
gets its own `LICENSE`. **Required before Phase 4:** legal sign-off + pick the shell license + add an
App-Store exception to any app-side AGPL code. Tracked in `MEMORY.md`.

---

## Build tracks (run partly in parallel)

| Track | What | Skills needed |
|---|---|---|
| **B — Backend** | Auth gate, V-1 fix, path-routed Caddy, verify gates | Node/Express, better-auth, security |
| **W — Web/SPA** | Operator-password login, mobile-responsive pass | SvelteKit |
| **N — Native** | Capacitor shell, pairing, biometric app-lock, iOS then Android | Capacitor, Xcode/Swift, Gradle |
| **O — Ops** | Real relay/DNS/acme-dns stand-up, TestFlight/Play, App Store review | infra, store accounts |

---

## Phase 1 — Authenticate + relay-expose the portal *(Track B; the gate for everything)*

Design + verification table: `DESIGN-portal-auth-relay-2026-06-05.md`. **Security-sensitive → human
review required before merge.** Each step independently shippable.

| Step | Task | Files | ~LOC | Verify gate | Smoke / blocker |
|---|---|---|---|---|---|
| **1.0** | ✅ **Spike #1 DONE (2026-06-06):** `auth.api.getSession` exists; `signInEmail`→`better-auth.session_token`; valid cookie→`{user}`, no/tampered→null (fail-closed). Both in-process + HTTP-forward viable. | — | 0 | ran in-repo (deps installed) | **1.2 unblocked.** |
| **1.1** | ✅ **DONE+VALIDATED (2026-06-06):** `isTrustedLoopback(req)` = loopback **AND** no `X-Forwarded-For`; replaced the 3 inlined copies; **fixed V-1** (account/remote routers) | `src/http/loopback.js` (new), `src/account/router.js`, `src/remote/router.js`, `src/server-rest.js` | ~40 | `verify:control-loopback` **13/13 GO** + `verify:portal-data` GO | XFF req to `/account/setup` → 403, no recovery key in body — on a real boot. Commit `701bcbc`. |
| **1.2** | ✅ **DONE+VALIDATED (2026-06-06):** `resolveRequester` (loopback→owner / static Bearer / Cookie→`:4711/api/auth/get-session`) + `createVaultAuthMiddleware` mounted first in the vault sub-app (enforces only on data paths; loopback bypass) + `mycelium_csrf` double-submit on cookie-authed writes + `/auth/session` networked-gating | `src/http/require-vault-auth.js` (new), `src/server-rest.js`, `src/auth-shim.js` | ~150 | `verify:portal-auth` **13/13 GO** + regressions GO (portal-data, control-loopback, rest) | Real-vault boot vs a stub get-session: loopback→200, networked no/bad→401, cookie/Bearer→200, CSRF on writes, SPA nav not gated. Commit `7a0d9e2`. |
| **1.3** | Path-aware `renderCaddyfile`: `/api/auth`,`/login`,`/mcp`,`/.well-known`,`/v1` → :4711; `/api/v1/account`,`/api/v1/remote` → **404**; else → :8787 | `src/remote/runtime.js` | ~30 | `verify:relay-portal` (new) | render + assert routing + the two 404s |
| **1.4** | Add 3 gates to `npm run verify` + `.github/workflows/verify.yml` | `package.json`, workflow | ~6 | full `npm run verify` GO | CI green |

**Phase-1 exit (falsifiable):** all 3 new gates GO; `verify:portal-data` + `verify:leak` still GO
(no desktop regression, no plaintext leak); and a **real-WebKit** smoke (per `deploy-and-verify` —
curl gives false CORS/cookie greens) shows operator-password login → `/auth/session` 200 →
authenticated `/api/v1/portal/library` over an actual relayed `<handle>.mycelium.id`, with
`/api/v1/account` 404 at the edge in the same run.

## Phase 2 — Operator-password login in the SPA *(Track W; parallel with 1.2+)*

| Step | Task | Files | ~LOC | Verify / smoke |
|---|---|---|---|---|
| 2.1 | Add an **email+password** login branch (operator) posting to `/api/auth/sign-in/email` (same-origin via Caddy); on success `auth.setUser`, route to `/` | `portal-app/src/routes/login/+page.svelte`, `lib/stores/auth.ts` | ~60 | real-browser: login → Library loads over relay |
| 2.2 | Make `/auth/session` failure → this login (not the dead passkey/setup branches) on networked clients; keep `SECURE_CHANNEL` off | `+layout.svelte`, `login/+page.svelte` | ~20 | 401 bounces to operator login, not a dead branch |

## Phase 3 — Mobile-responsive pass *(Track W; parallel, pure web)*

| Step | Task | Files | Verify / smoke |
|---|---|---|---|
| 3.1 | Audit + fix small-viewport layout: workspace shell, nav, the heavy screens (mindscape 3D, library, timeline) | `portal-app/src/lib/workspace/*`, `routes/(app)/*` | `npm run portal:dev` at 390px; no horizontal scroll, tap targets ≥44px |
| 3.2 | Touch affordances: pull-to-refresh, safe-area insets, momentum scroll | SPA CSS/components | visual on device-emulated WebKit |

## Phase 4 — Capacitor iOS shell *(Track N; needs Phase 1 live on a relayed box)*

| Step | Task | Files | Notes |
|---|---|---|---|
| 4.1 | New `mobile/` Capacitor project; webview `server.url` (or in-app nav) → the paired box URL; iOS target | `mobile/**`, `capacitor.config.ts` | one config → iOS + Android later |
| 4.2 | **Pairing**: tiny bundled landing — enter handle **or** scan a QR from desktop (`mycelium://pair?handle=…`); persist resolved URL in Keychain | `mobile/src/pair/*`; desktop "show pairing QR" (small Tauri add) | the *only* bundled web asset |
| 4.3 | **Biometric app-lock**: Face ID gate before revealing the webview on cold start/resume (native plugin). Note: app-lock UX only — holds no vault keys | Capacitor Biometric plugin | distinct from the server-side operator-password auth |
| 4.4 | Native niceties: status bar/splash, deep links, share-sheet → existing `/api/v1/portal/upload` import | Capacitor plugins | keeps it App-Store-real (guideline 4.2) |
| 4.5 | iOS build + **TestFlight** | Xcode, Apple dev acct (Track O) | device smoke: pair → biometric → login → Library |

## Phase 5 — Android + fast-follows

| Step | Task | Notes |
|---|---|---|
| 5.1 | Android target from the same Capacitor project; Play internal testing | build target, not a rewrite |
| 5.2 | **Push notifications** | needs a server-side notify hook + APNs/FCM — own design |
| 5.3 | **Real passkey unlock** | enable better-auth passkey plugin + wire the SPA's (currently dead) passkey UI → cryptographic Face ID unlock; own design |
| 5.4 | **Bundled-SPA + Bearer** client (the "mature target") | uses the Bearer branch the gate already accepts + runtime Noise-key pairing if Noise is ever built |

---

## Critical path & dependencies

```
Spike#1 ─▶ 1.2 ─┐
1.1 (V-1) ──────┼─▶ 1.3 ─▶ 1.4 ─▶ Phase-1 exit (relayed box, authed) ─▶ 4.x (Capacitor) ─▶ 4.5 TestFlight ─▶ 5.1 Android
2.1/2.2 (login)─┘        (Track W, parallel)
3.x responsive ──────────────────────── parallel, merges before 4.5
```

- **1.1 (V-1 fix) has no dependency** — do it first; it ships a real security fix on its own PR.
- **Spike #1 blocks 1.2.** Everything else in Phase 1 can proceed around it.
- **Tracks W and N's native scaffolding** can start before Phase 1 lands, but **4.5 (device smoke)
  needs a live relayed box** (Track O standing up relay/DNS/acme-dns — already designed in
  `REMOTE-CONNECT-*`, operator deploy).

## Spikes to run on a real host (cannot be done in this container — no deps)

1. **Cookie validation** (blocks 1.2): `signInEmail` → cookie → `GET :4711/api/auth/get-session` → `{user}`. If the HTTP endpoint differs in this better-auth version, fall back to the in-process API or a thin internal `:4711` validate route.
2. **Real-WebKit relay smoke** (Phase-1 exit): full login→session→data over an actual relayed host; curl is a false green on cookies/CORS.
3. **WebView passkey feasibility** (Phase 5.3, named early): WebAuthn-in-WKWebView/Android-WebView is historically restricted — may need ASWebAuthenticationSession / Credential Manager bridging.
4. **App Store 4.2 review** posture for a remote-webview app — the native pairing/biometric/share-import are the mitigation.

## Decision criteria between phases (falsifiable)

- **→ Phase 4 (build the shell):** Phase-1 exit met (above) on a real relayed box.
- **→ Phase 5.1 (Android):** iOS TestFlight build passes the device smoke (pair → Face ID → operator
  login → Library read) on ≥1 physical iPhone.
- **→ ship to App Store:** TestFlight smoke green + a security review of the Phase-1 diff signed off
  (per CLAUDE.md, security-sensitive) + **the licensing gate cleared** (legal sign-off on AGPL-server /
  closed-shell split + shell `LICENSE` chosen — see *Repo & licensing*).

## Risks (plan-level; per-step risks in the Phase-1 design)

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Spike #1 reveals the cookie endpoint differs | med | med (re-pick mechanism) | Two fallbacks already named; mechanism is swappable behind `resolveRequester` |
| Relay infra (DNS/acme-dns/LE) not stood up | med | high (no device smoke) | Track O is independent and already designed; start it in parallel with Phase 1 |
| App Store rejects the webview wrapper | med | med | Native pairing/biometric/share/push keep it a real app; have a PWA fallback (mobile §1) |
| Heavy screens (3D mindscape) janky on phones | med | low | Phase 3 audit; degrade the 3D scene on small viewports |
