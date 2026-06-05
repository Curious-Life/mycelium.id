# Mycelium Mac App — Release Runbook & Completion Status (2026-06-05)

## Status: BUILT + VERIFIED LIVE ✅ (one operator-gated step remains: notarization)

The self-contained Tauri Mac app is complete and **proven working live this session** —
the hard parts (bundling node+python+model, runtime resolution, sidecars, launch,
serving) all work. Remaining work to a *frictionless public download* is **notarization**,
which is operator-gated (Apple Developer ID credentials).

### Verified live (read-only health of the running `Mycelium.app`)
| Check | Result |
|---|---|
| `:8787 /api/v1/account/status` | `{open:true, initialized:true, keychainAvailable:true}` — bundled **Node** + vault ✓ |
| `:8787 /` (portal) | HTTP 200, 4.3 KB — portal SPA served ✓ |
| `:8091 /health` | `{status:ok, model:nomic-v1.5, loaded:true, dim:768}` — bundled **Python + offline ONNX model** ✓ |

### Artifact (`cargo tauri build` output)
- `src-tauri/target/release/bundle/macos/Mycelium.app` — self-contained; `Contents/Resources/app/`
  has `node`, `python/bin/python3`, `hf-cache/hub` (Nomic model), `node_modules/better-sqlite3`
  (native arm64), `portal-app/build`, `src/`, `pipeline/`, `migrations/`. Sidecars `caddy`+`frpc`
  in `Contents/MacOS/`.
- `…/bundle/dmg/Mycelium_0.1.0_aarch64.dmg` (~695 MB).
- Signature: **ad-hoc** (`Signature=adhoc`, `TeamIdentifier=not set`) → Gatekeeper warns on first
  open (right-click → Open). `tauri.conf.json` `signingIdentity: "-"`, version `0.1.0`,
  identifier `id.mycelium.app`. macOS **arm64 only**.

---

## Completion checklist

- [x] Tauri shell builds (`cargo tauri build`), opens a vibrancy window → `127.0.0.1:8787`
- [x] Self-contained bundle (`scripts/build-app-bundle.sh` → `build-staging/` → `Resources/app/`):
      bundled Node 22, relocatable Python 3.12 + all wheels, Nomic v1.5 ONNX (offline), native
      better-sqlite3, portal build
- [x] Runtime resolution gated on the bundle (`src/main.rs`: `home/node`, `home/python`, `HF_HOME`,
      `HF_HUB_OFFLINE`), dev flow unchanged
- [x] Sidecars bundled + reaped (`caddy`/`frpc`; `externalBin`; pidfile + group-kill)
- [x] DMG produced
- [x] **Runs end-to-end** (live health above)
- [ ] **Notarized + hardened runtime** → operator-gated (§A) — the only blocker to a clean download
- [ ] **Rebuilt with latest code** → after PR #95 (local-model picker) + the keychain fix land (§B)
- [ ] (optional) Auto-updater, version strategy, universal/Intel build (§C — future)

---

## §A — Notarization (operator-gated; I can't do this — needs your Apple credentials)

Requires an **Apple Developer account** ($99/yr) with a *Developer ID Application* certificate in
the login keychain, and an app-specific password (or App Store Connect API key). Steps:

1. **Set signing + entitlements** in `src-tauri/tauri.conf.json`. The entitlements file is already
   authored (`src-tauri/entitlements.plist` — JIT + dyld-env + library-validation, the four this
   app needs). Just add to `tauri.conf.json`:
   ```json
   "bundle": {
     "macOS": {
       "signingIdentity": "Developer ID Application: <Your Name> (<TEAMID>)",
       "entitlements": "entitlements.plist"
     }
   }
   ```
   Sign sidecars + bundled node/python too (`cargo tauri build` does this when the identity is set;
   each runs with `--options runtime`).
2. **Build**: `cargo tauri build` (now Developer-ID-signed instead of ad-hoc).
3. **Notarize** the `.dmg`:
   ```bash
   xcrun notarytool submit "src-tauri/target/release/bundle/dmg/Mycelium_0.1.0_aarch64.dmg" \
     --apple-id "<you@apple.id>" --team-id "<TEAMID>" --password "<app-specific-pw>" --wait
   xcrun stapler staple "src-tauri/target/release/bundle/dmg/Mycelium_0.1.0_aarch64.dmg"
   ```
4. **Verify**: `spctl -a -t open --context context:primary-signature <dmg>` → "accepted",
   and `codesign --verify --deep --strict Mycelium.app`.

Tauri can automate signing in CI via env: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`.

**Why I stopped here:** there is no Developer-ID identity on this machine
(`security find-identity -v -p codesigning` → none), and notarization publishes the binary to
Apple with your credentials — not something to fake or guess.

## §B — Rebuild with latest code (after merges)

The running build predates this week's work. Before cutting a release, land and rebuild with:
- **PR #95** — local-model picker v3 (dynamic catalog + Ollama auto-start/download). NOTE: the
  picker's lazy Ollama auto-download means the bundle does **not** need to ship Ollama; first
  Pull&use fetches it. No bundle-size change.
- **Keychain dataloss fix** (currently uncommitted on the build tree).
Then `cargo tauri build` (heavy bits are cached in `.build-cache/`; only app code re-syncs) and
re-run the live health checks above + the clean-env smoke in `src-tauri/BUILD-MAC.md` §Verify.

## §C — Optional polish (future increments)

- **Auto-updater**: Tauri updater plugin + `bundle.createUpdaterArtifacts` + a signed update feed
  (needs the same Developer-ID + an update-signing keypair). Lets shipped apps self-update.
- **Universal / Intel**: bundled node/python + native wheels are arm64-only; an x86_64 / universal
  build is a separate increment (BUILD-MAC.md notes this).
- **Version strategy**: bump `tauri.conf.json` `version` per release; consider CHANGELOG.

---

## Verdict

The Mac app is **functionally complete and verified live** as a self-contained, ad-hoc-signed
arm64 build. To ship it as a clean public download, the operator runs §A (notarization) — the only
hard blocker — ideally after §B (rebuild with PR #95 + the keychain fix). §C is optional polish.
