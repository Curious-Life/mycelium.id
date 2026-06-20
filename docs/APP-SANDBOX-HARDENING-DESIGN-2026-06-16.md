# App Sandbox & Shipping Hardening — Design (2026-06-16)

**Scope:** Harden mycelium's *shipping surface* — the Tauri macOS desktop app and the
native SwiftUI iOS app. This is **not** an agent-command-execution sandbox (mycelium
has no such surface — see Sweep §0). It is the OS/app-distribution security posture:
Content-Security-Policy, webview→native IPC exposure, macOS hardened-runtime +
notarization wiring, and iOS credential/ATS/local-network hardening.

**Prior art:** `openclaw/openclaw` native apps (read via GitHub API; the local checkout
was corrupt). **State of the art:** Tauri v2 security docs, Apple developer docs, OWASP.

**Status:** DESIGN LOCKED + implemented (except the credential-gated notarization run).

---

## 0. The reframe (why this is "shipping app sandbox", not "exec sandbox")

The trigger was the Claude Code Bash-tool sandbox corrupting file reads during an
unrelated `verify` failure. That is a **dev-harness** concern, not a mycelium runtime
gap. A sweep of mycelium's execution surface confirmed there is **no untrusted
code-execution path** to sandbox:

- `src/jobs.js` spawns mycelium's **own** `pipeline/*.js` / bash scripts.
- `src/crypto/key-source.js`, `src/hardware/*`, `src/embed/supervisor.js`
  all use `execFile` with **argument arrays, never a shell** — a model/device name
  can never become a command.
- The only place untrusted **input** (user documents) is parsed runs in a
  **hard-killable, resource-limited `worker_thread`** (`src/enrich/extract-document.worker.js`).

So the real, present hardening opportunity is the **shipping surface**: the desktop
webview and the iOS app. That is this design.

---

## 1. Load-bearing assumptions (Step 1 inventory)

| # | Assumption | Category |
|---|---|---|
| A1 | The Tauri webview loads an **external** origin (`http://127.0.0.1:8787`), not bundled assets. | Boundary |
| A2 | Tauri's `app.security.csp` does **not** apply to external/remote origins — only compile-time-bundled assets. | Permission |
| A3 | The portal frontend's inline scripts are first-party but **not byte-stable** across builds (SvelteKit bootstrap). | Shape |
| A4 | `withGlobalTauri: true` exposes the full Tauri JS API to the remote origin, and the **frontend depends on it** (`window.__TAURI__`). | Permission |
| A5 | macOS sign/notarize scripts (`sign-macos.sh`, `notarize-macos.sh`) already exist and are correct (inside-out, hardened runtime). | Path |
| A6 | `entitlements.plist` exists but is **not wired** into `tauri.conf.json`. | Path |
| A7 | The app embeds JIT Node/V8 + Python + unsigned native modules + port-binding sidecars → Mac App Store **App Sandbox is infeasible**. | Permission |
| A8 | iOS stores the Bearer token in **plaintext UserDefaults** alongside Keychain. | Lifecycle |
| A9 | iOS `Info.plist` has **no ATS config and no `NSLocalNetworkUsageDescription`**. | Permission |
| A10 | `server-rest.js` has a single `express()` app where a global header middleware can attach early. | Shape |

---

## 2. Sweep findings (consolidated; file:line, verified by direct read)

### macOS signing/notarization (Sweep A — verified)
- **Ad-hoc signed today**: `tauri.conf.json` `"signingIdentity": "-"`. No Developer ID.
- **`entitlements.plist` exists but was NOT wired** into `tauri.conf.json`. It carries *hardened-runtime* loosening entitlements (`allow-jit`, `allow-unsigned-executable-memory`, `allow-dyld-environment-variables`, `disable-library-validation`) — **not** App-Sandbox entitlements.
- **Sign/notarize workflow already built**: `scripts/sign-macos.sh:36,52` sign every Mach-O inside-out with `--options runtime`, app last with `--entitlements`; `--deep` is used only on `--verify` (line 56), never on `--sign` (correct — avoids clobbering nested entitlements). `scripts/notarize-macos.sh:41,42,55,56` do `notarytool submit --wait` + `stapler staple` for both `.app` and `.dmg`. Operator-gated on Developer ID + a `mycelium-notary` keychain profile.

### CSP / webview attack surface (Sweep B — verified)
- **Production CSP was null**: `tauri.conf.json` `"security": { "csp": null }`. The REST server emitted **no** CSP / security headers — only `Cache-Control: no-store` on `.html`.
- A **complete CSP + header set already exists but is DEV-ONLY** in `portal-app/src/hooks.server.ts:6-26` (runs only under the SvelteKit dev server).
- **`withGlobalTauri: true`** + capability grants `core:default` to `http://127.0.0.1:8787`. The frontend **uses** it: `Header.svelte` reads `window.__TAURI__` then calls `startDragging()`; several files use `__TAURI__`/`__TAURI_INTERNALS__` for Tauri-detection (all already fall back to `__TAURI_INTERNALS__`).
- `Header.svelte` **also** carries the drag declaratively via `data-tauri-drag-region` — but a code comment flags that the attribute may not wire up for the external-URL case, which is why the JS fallback exists.
- XSS sinks are **DOMPurify-sanitized** (12 `{@html renderMarkdown()}` sites). CSP is the second layer.
- Third-party content is already cross-origin: Turnstile is an **iframe** to `connect.mycelium.id`; fonts + map tiles (`*.basemaps.cartocdn.com`) are subresources.
- Built shell `portal-app/build/200.html` has **2 inline `<script>`** (SES polyfill + SvelteKit bootstrap — not byte-stable).

### iOS (Sweep C — verified)
- **HIGH — token in plaintext UserDefaults**: `SettingsStore.swift` wrote the token to Keychain **and** UserDefaults, and read it back as a fallback. UserDefaults is an unencrypted plist (in backups, readable on a jailbroken/extracted device).
- **Keychain accessibility too broad**: `KeychainHelper.swift` used `kSecAttrAccessibleWhenUnlocked` (syncable/backup-migratable) instead of `…WhenUnlockedThisDeviceOnly`.
- **No ATS / no `NSLocalNetworkUsageDescription`** in the real `Info.plist`s.
- Native SwiftUI, **no WKWebView**. No committed secrets.

### openclaw prior art (Sweep D — via GitHub API)
- macOS: **native Swift, App Sandbox OFF, hardened runtime ON**, `disable-library-validation` dev-gated, Team-ID audit on embedded Mach-Os, notarize+staple scripts. No CSP in native WKWebViews; CSP lives in their TS gateway HTTP layer.
- iOS: **minimal entitlements**, secrets in **Keychain** (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`) — **never UserDefaults**.
- **Copy:** Keychain `…ThisDeviceOnly`; hardened runtime + notarization. **Don't copy:** their broad `NSAllowsArbitraryLoadsInWebContent` + `developerExtrasEnabled` on.

### State of the art (Sweep E — sourced)
- **A2 confirmed**: Tauri only injects CSP for *bundled* assets → deliver CSP as an HTTP header from the local server. [v2.tauri.app/security/csp]
- `withGlobalTauri` should be **off** in prod; remote-origin IPC + `dangerousRemoteDomainIpcAccess` are a real advisory (GHSA-57fm-592m-34r7). [v2.tauri.app/security]
- **macOS**: `allow-jit` + `allow-unsigned-executable-memory` minimum for V8; `disable-library-validation` for third-party native modules/sidecars. **MAS App Sandbox infeasible.** Sign inside-out, no `--sign --deep`. [Apple forums; DoltHub; MailVault]
- **iOS**: prefer **HTTPS over Tailscale** (skip ATS cleartext exception); Keychain `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, **never UserDefaults**; `NSLocalNetworkUsageDescription` **mandatory on iOS 18+** for LAN/Tailscale. [Apple ATS/Keychain docs]

---

## 3. Threat model

**Asset:** the cognitive vault. **Trust floor:** the user's own machine, single-user.

| Threat | Vector | Mitigation |
|---|---|---|
| XSS escalates to host | imported doc/markdown → script → `window.__TAURI__` → `fs`/`process` | **CSP header** (hashed script-src, no `unsafe-inline`) + **`withGlobalTauri:false`** removes the escalation primitive. DOMPurify is the first layer. |
| Clickjacking | app framed by hostile page | `frame-ancestors 'none'` + `X-Frame-Options: DENY`. |
| Tampered .app on download | Gatekeeper warns on ad-hoc | **Developer ID + hardened runtime + notarization**. |
| iOS token theft | backup/jailbreak reads plaintext UserDefaults | **Remove UserDefaults write** + Keychain `…ThisDeviceOnly`. |
| iOS MITM | cleartext HTTP | **HTTPS over Tailscale**; WireGuard authenticates peer. |

**New attack surface added:** none — every change removes surface or is build/sign config. The only new runtime code is the read-only header middleware.

---

## 4. Decisions (locked)

- **D1 — macOS distribution = Developer ID + hardened runtime + notarization, NOT Mac App Store App Sandbox** (A7 + SOTA + openclaw).
- **D2 — CSP delivered as an HTTP response header from `server-rest.js`** (A2), script integrity via **boot-time hash extraction** of the served shell's inline scripts (A3): `script-src 'self' 'sha256-…'` — no `unsafe-inline`, no per-request rewrite, auto-adapts to rebuilds.
- **D3 — `withGlobalTauri: false` in production** (IMPLEMENTED). As-built pivot vs v1: rather than adding the `@tauri-apps/api` dependency, the drag fallback calls the core window command **through the always-injected internals bridge** — `window.__TAURI_INTERNALS__.invoke('plugin:window|start_dragging')` (gated by the already-granted `core:window:allow-start-dragging`, independent of `withGlobalTauri`). Two independent drag mechanisms remain (declarative `data-tauri-drag-region` + this invoke). Detection sites already fall back to `__TAURI_INTERNALS__`. Verified: svelte-check 0 errors, `vite build` clean. **Residual: a 30-second live WebKit drag smoke** (1-line revert to `true` if it regresses).
- **D4 — Wire `entitlements.plist` into `tauri.conf.json` (`bundle.macOS.entitlements`)** now; keep `signingIdentity: "-"` until the operator supplies a Developer ID.
- **D5 — Do NOT enable `dangerousRemoteDomainIpcAccess`.** Treat `127.0.0.1:8787` as the sole IPC-trusted origin. Third-party content stays cross-origin (already true).
- **D6 — iOS:** remove the UserDefaults token write + fallback (HIGH); Keychain → `…ThisDeviceOnly`; add `NSLocalNetworkUsageDescription`; recommend HTTPS-over-Tailscale. Lands in the **separate `mycelium-ios` repo**.
- **D7 — Isolation Pattern: DEFER.** With `withGlobalTauri:false` the IPC surface is already minimal.

---

## 5. Module shape (as-built)

- **5a. Security headers + CSP** (`src/server-rest.js`): `buildPortalCsp(shellPath)` (boot-time inline-script sha256 hashing, fail-closed to `script-src 'self'`), mounted as a global middleware right after `app.disable('x-powered-by')`. `crypto`/`fs`/`path` already imported. No HSTS on loopback HTTP.
- **5b. Tauri config** (`src-tauri/tauri.conf.json`): `bundle.macOS.entitlements: "entitlements.plist"` + `app.withGlobalTauri: false`.
- **5c. Drag** (`Header.svelte`): `window.__TAURI_INTERNALS__.invoke('plugin:window|start_dragging')`.
- **5d. iOS** (`mycelium-ios`): `SettingsStore.swift` Keychain-only + migrate/purge of the legacy UserDefaults key; `KeychainHelper.swift` `…WhenUnlockedThisDeviceOnly`; `Info.plist` `NSLocalNetworkUsageDescription`.

---

## 6. Test strategy

| Test | Asserts | File |
|---|---|---|
| `verify:app-csp` | Boots `server-rest.js`, GETs `/` + a route + a 404: every response carries a CSP with no `unsafe-inline`; rendered HTML carries `script-src 'self' 'sha256-…'` (hashes byte-match the shell) + `frame-ancestors 'none'` + the companion headers. | `scripts/verify-app-csp.mjs` |
| Live webview smoke | Real Tauri/WebKit: 0 CSP violations + window drag works + import detects Tauri. | manual |
| iOS build | Builds; token round-trips via Keychain only; `defaults read` shows no `apiToken`. | Xcode (operator) |

---

## 7. Implementation order (status)

1. ✅ **CSP + security headers** (`server-rest.js` + `verify:app-csp`). DONE — gate GO (incl. against a freshly-rebuilt shell). Residual: live-webview 0-violations smoke.
2. ✅ **Wire `entitlements.plist`** into `tauri.conf.json`. DONE (JSON valid). Operator smoke at `cargo tauri build`.
3. ✅ **`withGlobalTauri:false`** — DONE: `Header.svelte` drag via internals invoke; flag flipped. svelte-check 0 errors + `vite build` clean. Residual: live Tauri drag smoke.
4. ✅ **iOS hardening** (`mycelium-ios`) — DONE: UserDefaults write+fallback removed + migrate/purge; Keychain `…ThisDeviceOnly`; `NSLocalNetworkUsageDescription`. Verified swift `-parse` + `plutil -lint` + no other readers. Residual: Xcode build + token round-trip.
5. ⏳ **Operator: Developer ID + notarization** — `sign-macos.sh` + `notarize-macos.sh`; `spctl -a -t open` → accepted. **Credential-gated.**

---

## 8. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| CSP breaks a real page | Med | App won't render | Boot-time hashing covers all shell inline scripts; live-webview smoke catches violations; report-only fallback available. |
| `withGlobalTauri:false` breaks drag | Med | Cosmetic | `data-tauri-drag-region` + internals-invoke both work without the flag; revertible 1-liner; behind live smoke. |
| `disable-library-validation` residual | Low | Needs local write+sign | Required for embedded runtimes; all our Mach-Os signed + hardened; accepted. |
| iOS stale UserDefaults token | Low | Plaintext lingers | One-time `removeObject` on launch. |

---

## 9. Verification table (every A# read by me)

| Assumption | Verified at |
|---|---|
| A1 webview loads external `127.0.0.1:8787` | `src-tauri/src/main.rs` (`WebviewUrl::External`) |
| A2 Tauri CSP only covers bundled assets | SOTA (v2.tauri.app/security/csp) + `tauri.conf.json` `csp:null` |
| A3 shell inline scripts not byte-stable | `portal-app/build/200.html` (2 inline scripts) |
| A4 `withGlobalTauri` used by frontend | `tauri.conf.json`; `Header.svelte`; `ImportView.svelte`; `+layout.svelte` |
| A5 sign/notarize scripts correct | `scripts/sign-macos.sh:36,52,56`; `scripts/notarize-macos.sh:41,42,55,56` |
| A6 entitlements not wired | `tauri.conf.json` (no `entitlements` key originally) |
| A7 App Sandbox infeasible | `src-tauri/entitlements.plist`; `tauri.conf.json` `externalBin`; SOTA |
| A8 iOS token in plaintext UserDefaults | `mycelium-ios SettingsStore.swift` |
| A9 no ATS / no LocalNetworkUsage | `mycelium-ios .../Info.plist` (grep: absent) |
| A10 single express app, early attach point | `src/server-rest.js` (`const app = express()` + `app.disable`) |

---

## 10. Open questions

**Resolved during sweep:** CSP→HTTP-header not Tauri config (A2); can't just flip `withGlobalTauri` (A4 → staged refactor); can't hardcode the script hash (A3 → boot-time extraction).

**Deferred:** Isolation Pattern (D7); iOS cert pinning (WireGuard authenticates); Mac App Store (D1/A7); the Claude Code dev-harness sandbox flakiness (separate dev-env concern — see `node-modules-fs-corruption` memory).

---

### Revision history
- **v1 (2026-06-16)** — locked after 5 parallel sweeps + direct-read pressure test. Three pivots: CSP→HTTP-header, boot-time script hashing, `withGlobalTauri` flip staged behind a frontend refactor + live smoke.
- **v2 (2026-06-16)** — as-built: `withGlobalTauri` drag refactor uses the dependency-free `__TAURI_INTERNALS__.invoke` (no `@tauri-apps/api` dep). Items 1–4 implemented + headless-verified; notarization remains operator-gated. (Note: a mid-session filesystem-corruption event wiped the first working-tree pass; everything was re-applied on the recovered clean tree — see `node-modules-fs-corruption` memory.)
