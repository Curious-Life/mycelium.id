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

## §A — Notarization (operator-gated; needs your Apple credentials)

> **SUPERSEDED 2026-06-18 → see [`docs/DESIGN-macos-signed-distribution-2026-06-17.md`](DESIGN-macos-signed-distribution-2026-06-17.md).**
> The original step-1 below was **wrong**: it claimed `cargo tauri build` signs
> "sidecars + bundled node/python too" when the identity is set. A sweep proved
> Tauri's macOS bundler signs only the main binary + frameworks + `externalBin`
> sidecars — **NOT** the ~300 nested Mach-O we stage under `Resources/app/`
> (bundled Node, the relocatable Python, every wheel `.so`/`.dylib`,
> `better_sqlite3.node`). Setting `signingIdentity` alone would FAIL notarization.
> The correct flow is a custom **inside-out** signing pass, now scripted. Original
> text kept below struck-through for history.

Requires an **Apple Developer account** ($99/yr) with a *Developer ID Application* certificate, and
an app-specific password (or App Store Connect API key).

### Correct flow (as-built)

**Local (one machine):**
```bash
# one-time: store notarization creds in the login keychain
xcrun notarytool store-credentials mycelium-notary \
  --apple-id "<you@apple.id>" --team-id "<TEAMID>" --password "<app-specific-pw>"

cargo tauri build --bundles app          # ad-hoc; do NOT set APPLE_* here
APPLE_SIGNING_IDENTITY="Developer ID Application: <Your Name> (<TEAMID>)" \
  bash scripts/notarize-macos.sh         # deep-sign inside-out → notarize app →
                                         # hdiutil DMG from stapled app → notarize DMG
```
- `scripts/sign-macos.sh` signs **every** nested Mach-O inside-out (content-detected,
  not by extension), applying `src-tauri/entitlements-child.plist` to the bundled
  `node`/`python3` (they run as their own processes → need JIT + library-validation
  exceptions on their own signatures) and hardened-runtime-only to the Go sidecars +
  libs, then seals the `.app` last. No `--deep` (Apple-discouraged).
- `scripts/notarize-macos.sh` orchestrates sign → notarize → DMG → notarize.
- `tauri.conf.json` stays `signingIdentity: "-"` — we own all signing post-build.

**CI (both arches, automated):** push a `v*` tag → `.github/workflows/desktop-release.yml`
builds, signs, notarizes, and attaches `Mycelium_<ver>_aarch64.dmg` + `_x64.dmg` to the
Release. Operator wires 6 repo secrets (listed in that workflow's header).

**Verify:** `spctl -a -t open --context context:primary-signature <dmg>` → "accepted";
`xcrun stapler validate <dmg>`; `codesign --verify --deep --strict Mycelium.app`.

<details><summary>Original (incorrect) step 1 — kept for history</summary>

> ~~Set signing + entitlements in `tauri.conf.json` … Sign sidecars + bundled
> node/python too (`cargo tauri build` does this when the identity is set).~~
> — false; Tauri does not sign nested `Resources/` Mach-O (tauri#8075).
</details>

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
