# Mycelium Mobile (Capacitor shell)

A **thin remote-webview client** to a self-hosted Mycelium vault. iOS-first;
Android builds from the same project. The phone does **not** run a server — it
connects to the user's own box at `https://<handle>.mycelium.id` over the relay,
where the (authenticated) portal is served. Design + plan:

- [`../docs/DESIGN-mobile-app-2026-06-05.md`](../docs/DESIGN-mobile-app-2026-06-05.md)
- [`../docs/MOBILE-DEVELOPMENT-PLAN-2026-06-05.md`](../docs/MOBILE-DEVELOPMENT-PLAN-2026-06-05.md)

## What's here (scaffold — Phase 4.1)

| File | Purpose |
|---|---|
| `capacitor.config.ts` | App id/name; `allowNavigation` scoped to `*.mycelium.id`; no hardcoded box URL |
| `www/index.html` + `www/pair.js` | The **only** bundled web asset: the pairing landing (enter handle → store → navigate to the box) + a biometric app-lock hook |
| `scripts/check-config.mjs` | Toolchain-free sanity/security gate (`npm run check`) — runs in CI |
| `LICENSE.md` | ⚠️ licensing decision placeholder — **finalize before App Store** |

## How it works

1. First launch shows the pairing screen; the user enters their handle. Only the
   handle is stored on-device (`@capacitor/preferences`) — never vault data/keys.
2. Subsequent launches gate on Face ID / fingerprint (app-lock only) then load
   `https://<handle>.mycelium.id`. From there it is the portal: operator-password
   login (Phase 2), then the authenticated vault (the server-side gate, Phase 1.2).
3. `allowNavigation: ['*.mycelium.id']` lets the webview reach the box while the
   Capacitor bridge (preferences, status bar, app-lock) stays available.

## Build (requires a host toolchain — NOT done in CI)

```bash
cd mobile
npm install
npm run check          # config/security sanity (also runs in CI)
npm run add:ios        # npx cap add ios   (macOS + Xcode)
npm run sync           # npx cap sync
npm run open:ios       # opens Xcode → run on device/simulator → TestFlight
# Android: npm run add:android && npm run open:android  (Android Studio)
```

The generated `ios/` and `android/` projects are git-ignored (regenerate with
`cap add`). Apple signing/notarization + TestFlight are operator steps.

## Status / TODO

- ◑ Scaffold only — **not yet built on a device** (no Capacitor/Xcode in CI).
- ⬜ Biometric plugin: `www/pair.js` calls `@aparajita/capacitor-biometric-auth`
  defensively (no-op if absent). Add it to `dependencies` + `cap sync` to enable.
- ⬜ QR pairing from the desktop app (`mycelium://pair?handle=…` deep link).
- ⬜ Push notifications, share-sheet import (fast-follows).
- ⚠️ **Licensing** must be resolved before TestFlight/App Store — see `LICENSE.md`.
- The end-to-end device run (pair → biometric → operator login → Library) is the
  Phase-4 device smoke; it depends on a **live relayed box** (Phase-1 exit).
