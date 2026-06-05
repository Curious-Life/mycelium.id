# Design — Mycelium Mobile (iOS-first, Android-easy)

**Date:** 2026-06-05
**Status:** Design / thinking doc — first pass. Grounded in a codebase familiarization
sweep (file:line evidence below); **no code yet**. Build after this is accepted and
after a `/sweep-first-design` pass on the critical-path item (§5).
**Author decisions (this session):** packaging = **Capacitor wrapping the existing
SvelteKit `portal-app`**; UI delivery = **remote webview pointing at the box's own
URL** (`https://<handle>.mycelium.id`); platform order = **iOS first, Android as a
near-free follow** from the same web codebase.

---

## TL;DR

- **The phone is a thin remote *client* to the user's private box** — it does **not**
  host a server (that's the desktop Tauri shell's job: it spawns Node locally,
  `ARCHITECTURE.md:45-49`). The vault stays on the user's Mac/VPS; the phone reaches
  it over the existing **relay** (`https://<handle>.mycelium.id`, SNI-passthrough, TLS
  terminates on the Mac — `DESIGN-relay-and-gateway-2026-06-04.md`).
- **The easy 80% already exists** and is reused unchanged: the entire UI
  (`portal-app/` SvelteKit SPA, all screens under `portal-app/src/routes/(app)/`),
  passkey + PRF biometric unlock (`portal-app/src/lib/passkey-prf.ts` → Face ID /
  Android biometrics), the Noise-NK encrypted channel for sensitive endpoints
  (`portal-app/src/lib/secure-channel.ts`, pure JS, runs in a webview), and OAuth 2.1 +
  PKCE + Bearer (`src/auth.js`, `src/server-http.js`).
- **The hard 20% is a backend project, not the wrapper.** The Capacitor shell is a few
  days. The **critical path** is the repo's own deferred *"Phase 4"*: **the portal UI
  and its data API have no per-request auth and are localhost-only by design**
  (`src/server-rest.js:144-146`, `src/auth-shim.js:11-26`), and the relay does **not**
  forward them today (it forwards everything to the MCP/OAuth server on `:4711`, not the
  portal+REST server on `:8787` — `src/remote/runtime.js:16,97`). Until that surface is
  authenticated **and** exposed, the chosen "remote webview → box URL" approach has
  nothing safe to render. **Do not expose `:8787` to the relay before this lands.**

---

## 1. The decisions (and why)

| Choice | Decision | Why |
|---|---|---|
| Packaging | **Capacitor** wrapping `portal-app` | One web codebase → iOS App Store **and** Android with near-zero extra work; mature native plugins (biometrics, push, Keychain/Keystore secure storage, deep links). Best fit for "iOS first, easy Android." Tauri-mobile is younger and its passkey/push plugin story is thinner; native SwiftUI throws away the web codebase and the Android goal. |
| UI delivery | **Remote webview** → `https://<handle>.mycelium.id` | The webview's **origin *is* the box**, so same-origin cookies, CSRF double-submit (`portal-app/src/lib/api.ts:62-65`), and the per-box build-time Noise pubkey (`portal-app/src/lib/vps-identity.ts:8`) all *just work* unchanged. This sidesteps the two gotchas a *bundled* SPA would hit (cross-origin cookies + runtime Noise-key pairing). Trade-off: needs connectivity to render; less offline/native feel — acceptable for v1, revisit as a fast-follow (§7). |
| Platform order | iOS → Android | Per request. Same Capacitor project ships both; Android is a build target, not a rewrite. |

## 2. What already exists (reuse map)

| Capability the phone needs | Already built | Evidence |
|---|---|---|
| Per-box public URL, reachable anywhere | Relay (SNI passthrough, TLS on Mac) | `DESIGN-relay-and-gateway-2026-06-04.md`; `mycelium-managed/relay/` |
| All app screens | SvelteKit SPA | `portal-app/src/routes/(app)/{mindscape,library,timeline,chat,profile,settings,import,…}` |
| Biometric unlock (Face ID / Android) | WebAuthn passkey + PRF | `portal-app/src/lib/passkey-prf.ts`, `passkey-prf-callers.test.ts` |
| Encrypted transport for sensitive data | Noise-NK WebSocket channel | `portal-app/src/lib/secure-channel.ts`, `noise-nk.ts`, `secure-fetch.ts` |
| Token auth for remote callers | OAuth 2.1 + PKCE + Bearer | `src/auth.js`, `src/server-http.js:210-267` |
| Native shell precedent | Tauri v2 desktop | `src-tauri/` |

## 3. The mental-model shift

```
DESKTOP (today)                          MOBILE (this design)
┌───────────────────────┐                ┌───────────────────────┐
│ Tauri shell           │                │ Capacitor shell       │
│  └ spawns Node server │                │  └ NO server          │
│  └ webview → 127.0.0.1 │                │  └ webview → relay URL │
│      :8787 (portal)   │                │      <handle>.mycelium │
│  VAULT IS LOCAL       │                │  VAULT IS REMOTE       │
└───────────────────────┘                └───────────┬───────────┘
                                                      │ HTTPS (TLS→Mac)
                                          relay ──────┘
```

The desktop app *is* the box. The phone *talks to* the box. Everything below follows
from that one difference.

## 4. Target architecture

```
 iPhone / Android
 ┌─────────────────────────────────────────────┐
 │ Capacitor shell (native)                     │
 │  • biometric gate (Face ID) before reveal    │  ← native plugin
 │  • secure storage: handle + session          │  ← Keychain / Keystore
 │  • push notifications (fast-follow)           │
 │  • deep links: mycelium://pair?handle=…       │
 │  ┌─────────────────────────────────────────┐ │
 │  │ WebView, origin = https://<handle>.…     │ │
 │  │  = the box-served portal-app SPA          │ │
 │  │  cookies / CSRF / Noise channel unchanged │ │
 │  └─────────────────────────────────────────┘ │
 └───────────────────────┬─────────────────────┘
                          │ HTTPS  (TLS terminates on the Mac)
                  RELAY (SNI passthrough, sees only ciphertext)
                          │  reverse tunnel
 ┌────────────────────────▼─────────────────────┐
 │ USER'S MAC / VPS = THE VAULT                  │
 │  Caddy (cert on box) path-routes:             │
 │   /, /api/v1/*, /auth/*  → :8787 portal+REST  │  ← NEW exposure (§5)
 │   /mcp, /v1, /.well-known → :4711 MCP/OAuth    │  ← exists today
 └───────────────────────────────────────────────┘
```

## 5. Critical path — the portal/REST surface must be authenticated + relay-exposed

> **Now designed in full:** [`DESIGN-portal-auth-relay-2026-06-05.md`](DESIGN-portal-auth-relay-2026-06-05.md)
> (sweep-first, 5 sweeps + verification table). That pass **pivoted** this section in three ways
> and **found a latent vulnerability** the exposure would activate — read it before building:
> (1) the auth system is on a *different process* (`:4711`), so `server-rest` must gain a real
> gate backed by a 2nd better-auth instance over the shared `auth.db` — not a middleware tweak;
> (2) there is **no server-side Noise channel** in V1, so "sensitive reads ride the Noise channel"
> is dropped — TLS-on-the-Mac is the confidentiality boundary; (3) better-auth has **no passkey**
> plugin, so V1 mobile login = operator password + native biometric *app-lock* (passkey deferred).
> **V-1 (latent):** `/api/v1/account` (returns the recovery key) and `/api/v1/remote/password`
> gate on loopback-**IP** only — defeated by the reverse proxy — so they would leak the moment
> `:8787` is relay-exposed; the fix (shared `isTrustedLoopback` = loopback **and** no XFF, plus a
> Caddy 404 at the edge) is part of that design.

This is the real work and the gate for everything else. Two coupled problems:

**5a. No auth on the data surface.** `server-rest.js` (the portal + `/api/v1/portal/*`
data API, `:8787`) has **no per-request auth**. It uses `auth-shim.js`, an "always
signed in" shim that exists *because* the surface is localhost-only and the vault is
already unlocked at boot (`src/auth-shim.js:11-26`). The file is explicit:
> "there is NO auth on this surface yet (Phase 4 adds OAuth 2.1). It therefore binds to
> localhost (127.0.0.1) by default and MUST NOT be exposed to a network without an auth
> layer in front of it." — `src/server-rest.js:144-146`

Exposing it to the relay as-is = handing the open internet an unauthenticated,
already-unlocked cognitive vault. **Fail-closed (CLAUDE.md §3) forbids this.**

**5b. The relay doesn't forward it anyway.** The Mac-side Caddy does a blanket
`reverse_proxy 127.0.0.1:4711` (`src/remote/runtime.js:16,97`) — the MCP/OAuth/gateway
server (`server-http.js`), not the portal+REST server (`server-rest.js`, `:8787`). So
even setting aside auth, the screens aren't reachable.

**The fix (sketch — needs a `/sweep-first-design` pass before building):**

1. **Promote the portal/REST surface to real auth.** Replace the `authShimRouter` "always
   signed in" behavior with a session that is honored only when the request arrived
   authenticated — i.e. gate `/api/v1/portal/*`, `/auth/session`, `/ingest/*` behind the
   **same OAuth 2.1 / operator-password gate that already guards `:4711`** (`src/auth.js`,
   `src/remote/router.js` already manages an operator password as "the OAuth gate"). Keep
   the loopback shim **only** for true-loopback requests (the desktop Tauri case), and
   require a real session for anything arriving via the relay. The measurement REST bridge
   already models exactly this loopback-vs-authenticated split
   (`src/server-rest.js:99-114`) — generalize that pattern to the whole data surface.
2. **Expose the portal+REST through the relay.** Either (a) Caddy path-routes `/`,
   `/api/v1/*`, `/auth/*` → `:8787` and the MCP/OAuth paths → `:4711`
   (`renderCaddyfile` in `src/remote/runtime.js` becomes path-aware), or (b) run a single
   combined server so one upstream serves both. (a) is the smaller change and keeps the
   two process roles intact.
3. **Defense in depth (CLAUDE.md §2).** Even authenticated, sensitive reads should ride
   the Noise channel (`secure-channel.ts` already routes them — `api.ts:42-48`), and
   the relay must keep doing SNI passthrough so it never sees plaintext.

This is the bulk of the engineering. The Capacitor shell (§6) is small by comparison.

## 6. The Capacitor shell (the easy part)

- New top-level dir (proposed): `mobile/` — a Capacitor project that points its webview
  at the box URL. iOS + Android targets from one config.
- **Pairing / onboarding:** a tiny bundled landing screen (the *only* bundled web asset)
  asks for the handle or scans a **QR generated by the desktop app** (deep link
  `mycelium://pair?handle=…`); store the resolved URL in Keychain/Keystore; then point the
  webview at `https://<handle>.mycelium.id`. (Implies a small desktop-side "show pairing
  QR" affordance — a fast-follow on the Tauri app.)
- **Biometric gate:** native Face ID / fingerprint check before revealing the webview on
  cold start / resume. This is *app-lock UX*; the cryptographic unlock is still the
  server-side key source + passkey PRF — the native gate does not hold vault keys.
- **Native niceties:** status-bar/safe-area, splash, pull-to-refresh, share-sheet import
  (hand off to the existing `/api/v1/portal/upload` import path), push notifications
  (fast-follow — needs a server-side notify hook + APNs/FCM).
- **Responsiveness:** audit the SPA's screens for small-viewport layout; the workspace
  shell (`portal-app/src/lib/workspace/`) and nav likely need a mobile breakpoint pass.

> **Sequenced build plan:** [`MOBILE-DEVELOPMENT-PLAN-2026-06-05.md`](MOBILE-DEVELOPMENT-PLAN-2026-06-05.md)
> — per-task files/LOC/verify/smoke/dependencies across tracks B/W/N/O, critical path, and the
> host-only spikes. The 2nd sweep cycle confirmed Tauri already supervises both Node servers + Caddy +
> frpc (`main.rs:225-338`), so Phase 1 lands with no Rust change; onboarding stays desktop-only
> (mobile is a log-into-existing-vault client); the gate forwards the cookie to `:4711` (v3).

## 7. Phasing

| Phase | Deliverable | Notes |
|---|---|---|
| **0** | This doc accepted + `/sweep-first-design` on §5 | Verify the auth-promotion assumptions against live `src/auth.js` / better-auth session shape before touching code |
| **1 (critical path)** | Authenticate the portal/REST surface; path-route it through the relay; new `verify:portal-auth` + `verify:relay-portal` gates | The gate for everything; security-reviewed (human approval per CLAUDE.md / `auto-merge-on-green`) |
| **2** | Mobile-responsive pass on `portal-app` screens | Pure web; verifiable on the Mac via `npm run portal:dev` at phone widths |
| **3** | Capacitor shell + pairing + biometric gate (iOS) | First device build; TestFlight |
| **4** | Android target from the same project | Build target only |
| **5 (fast-follows)** | Push notifications; share-sheet import; optional **bundled-SPA + Bearer** migration for offline shell / faster cold start (the "mature target" from the delivery fork) | Each its own design |

## 8. Open questions / risks

- **better-auth session ↔ webview cookies over the relay.** Need to confirm SameSite /
  Secure / domain attributes work for the relayed subdomain in an iOS/Android WKWebView
  (cookie handling in embedded webviews has sharp edges). *Verify in a real WebKit webview
  — the deploy-and-verify skill explicitly warns curl/CLI give false greens on CORS.*
- **Passkey PRF inside a Capacitor WebView.** WebAuthn in WKWebView/Android WebView has
  historically been restricted; may need ASWebAuthenticationSession / Credential Manager
  bridging, or the native biometric gate carries app-lock while PRF unlock happens via a
  system browser hop. Spike this early — it's load-bearing for unlock UX.
- **App Store review of a "remote webview" app.** Apple scrutinizes thin web wrappers
  (guideline 4.2). The native pairing, biometric gate, push, and share-import are what make
  it a real app rather than a rejected webview — keep them in scope for v1, not deferred.
- **Multi-box / handle discovery.** v1 assumes one box per user reachable by handle. Fine
  for the self-hosted product; revisit if a user runs several vaults.

## 9. Evidence index

- Mobile is a client, not a host: `docs/ARCHITECTURE.md:12-16,45-49`
- Relay / per-box URL / TLS-on-Mac: `docs/DESIGN-relay-and-gateway-2026-06-04.md`; `mycelium-managed/relay/deploy/Caddyfile.edge`
- Relay forwards everything to `:4711` MCP/OAuth (not the portal): `src/remote/runtime.js:16,66-110`
- Portal/REST has no auth, localhost-only by design: `src/server-rest.js:144-146,340-346`; `src/auth-shim.js:11-26`
- Loopback-vs-authenticated split to generalize: `src/server-rest.js:99-114`
- Same-origin cookie + CSRF + Noise routing in the SPA client: `portal-app/src/lib/api.ts:35-73`
- Passkey PRF unlock: `portal-app/src/lib/passkey-prf.ts`
- Noise-NK encrypted channel: `portal-app/src/lib/secure-channel.ts`, `noise-nk.ts`
- Build-time per-box Noise pubkey (why remote-webview avoids runtime pairing of it): `portal-app/src/lib/vps-identity.ts:8-36`
