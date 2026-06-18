# Building the Mycelium Mac app (Tauri) — Apple Silicon

This turns the local server + portal into a real `Mycelium.app` in your dock.
The shell (`src-tauri/`) spawns the Node server (which serves the portal UI **and**
the REST API at `http://127.0.0.1:8787`) and opens a window pointed at it.

## TL;DR — one command

From the repo root:

```bash
npm run build:app            # builds Mycelium.app (+ dmg)
npm run build:app -- --dev   # or: run the app live (cargo tauri dev)
```

`scripts/build-app.sh` checks every prerequisite up front with an actionable
message — so a missing **Rust** no longer fails with a cryptic `cargo: command
not found`; it offers to install Rust + the Tauri CLI, builds the SvelteKit
portal, fetches the sidecars, then runs `cargo tauri build`. The numbered steps
below are what it does under the hood. (End users don't build from source — they
download the notarized DMG.)

> **Honesty note:** the Rust shell (`src/main.rs`) was authored without a Rust
> toolchain in CI, so it's verified by *building it here on the Mac*, not in the
> repo's `npm run verify`. The **portal itself is fully verified** (`npm run
> verify:portal`). If `cargo tauri dev` reports a small API mismatch on first
> run, it'll be a Tauri-v2 signature tweak in `src/main.rs` — ping me.

## 0. Prerequisites (once)

```bash
# Node app working first (see docs/SETUP.md):
npm install && npm run init-db && npm run set-keys

# Rust + Tauri CLI:
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
cargo install tauri-cli --version "^2.0"

# Tauri system deps on macOS are just the Xcode CLI tools (already installed
# for better-sqlite3). No extra Homebrew packages needed on Apple Silicon.

# Fetch the bundled sidecars (REQUIRED before any `cargo tauri build`):
bash scripts/fetch-sidecars.sh
```

`tauri.conf.json` declares `bundle.externalBin: ["binaries/frpc", "binaries/caddy"]`,
so the build **fails** (`resource path binaries/frpc-aarch64-apple-darwin doesn't exist`)
unless these are present first. `scripts/fetch-sidecars.sh` downloads them per target
triple into `src-tauri/binaries/` (which is gitignored, so a clean checkout won't have
them):
- **frpc** (FRP reverse-tunnel client) — pinned to a SHA-256 in
  `scripts/sidecar-checksums.txt` and verified on every fetch; a mismatch aborts.
- **caddy** (TLS terminator, built with the `caddy-dns/acmedns` plugin via Caddy's
  download API) — documented-TOFU (the observed hash is recorded in
  `scripts/sidecar-checksums.txt`; on-demand Caddy builds aren't byte-reproducible, so
  it isn't enforced as a hard pin — see the note there).

## 1. Dev run (fastest — see the app window immediately)

From the repo root:

```bash
cd src-tauri
MYCELIUM_HOME="$(cd .. && pwd)" MYCELIUM_KEY_SOURCE=keychain cargo tauri dev
```

A native window opens showing the portal. It spawns `node src/server-rest.js`
for you (reading keys from your Keychain) and shuts it down when you close the
window. First compile takes a few minutes; subsequent runs are fast.

## 2. Generate app icons (once, before bundling)

```bash
cargo tauri icon ../assets/mushroom.svg
# writes src-tauri/icons/* (icon.icns, 128x128.png, …) referenced by tauri.conf.json
```

## 3. Build the distributable app (self-contained — zero host prerequisites)

Run from the **repo root** (the `beforeBuildCommand` hook stages the bundled
runtimes — see below — so build from where `scripts/` resolves):

```bash
bash scripts/fetch-sidecars.sh   # REQUIRED first — see §0; skip it and the build aborts
cargo tauri build
# →  src-tauri/target/release/bundle/macos/Mycelium.app   (~1 GB; fully self-contained)
#    src-tauri/target/release/bundle/dmg/Mycelium_0.1.0_aarch64.dmg
```

> **DMG step in headless/automation sessions:** Tauri's `create-dmg` step
> (`bundle_dmg.sh`) drives Finder via AppleScript to lay out the disk image, which
> fails when there's no interactive GUI session (e.g. SSH/automation/CI). The `.app`
> itself still builds fine — the failure is only the `dmg` target. To produce a working
> DMG directly, stage the `.app` plus an `/Applications` symlink in a folder and run:
>
> ```bash
> STAGE="$(mktemp -d)"
> cp -R src-tauri/target/release/bundle/macos/Mycelium.app "$STAGE/"
> ln -s /Applications "$STAGE/Applications"
> hdiutil create -volname Mycelium -srcfolder "$STAGE" -format UDZO Mycelium_0.1.0_aarch64.dmg
> ```

Drag `Mycelium.app` to /Applications. It needs **nothing** installed — no Node, no
Python, no model download. First launch creates the encrypted vault under
`~/Library/Application Support/id.mycelium.app/` (survives app updates).

**Unsigned build:** the app is ad-hoc-signed, not notarized, so Gatekeeper warns on
first open — **right-click → Open** once to allow it. (Developer-ID notarization is a
later milestone; see `docs/DESIGN-packaged-app-distribution-2026-06-02.md`.)

## How the self-contained bundle works (implemented)

`build.beforeBuildCommand` runs **`scripts/build-app-bundle.sh`**, which assembles
`<repo>/build-staging/` (≈1 GB), and `bundle.resources` (`{"../build-staging/":"app"}`)
copies it into `Mycelium.app/Contents/Resources/app/`. `mycelium_home()` resolves to
that dir when `MYCELIUM_HOME` is unset, so every runtime path works in the bundle:

```
Resources/app/
  node                  Node v22.x arm64 binary (bundled)
  python/bin/python3    relocatable python-build-standalone 3.12 + ALL wheels
  hf-cache/hub/…        Nomic v1.5 ONNX model (offline; HF_HOME + HF_HUB_OFFLINE)
  node_modules/…        incl. the native better_sqlite3.node (arm64)
  src/ pipeline/ migrations/ package.json portal-app/build/
```

`src/main.rs` prefers `home/node` + `home/python/bin/python3`, prepends the bundle to
`PATH`, and sets `HF_HOME`→`home/hf-cache` (+ `HF_HUB_OFFLINE=1`) — all **gated on the
bundle existing**, so the dev flow (step 1) is unchanged. `src/jobs.js` forwards the
bundled python (`MYCELIUM_PYTHON`) + offline-model env to the clustering child.

Heavy runtime bits (Node, Python+wheels, model) are cached under `<repo>/.build-cache/`
and reused; only app code re-syncs per build. Both `build-staging/` and `.build-cache/`
are gitignored. **macOS arm64 only** (bundled Node/Python + native wheels are
arch-specific); Intel/Windows/Linux are future increments. Validated by Spikes P + N
(relocatable Python + bundled Node) in the design doc.

## Verify the packaged app (clean env)

The real test: the `.app` works with **no developer tools on PATH**.

```bash
# stop any dev server first (frees :8787/:8091)
pkill -f 'tauri dev'; pkill -f 'target/debug/mycelium'; pkill -f 'src/server-rest.js'
lsof -ti tcp:8787 | xargs kill 2>/dev/null; lsof -ti tcp:8091 | xargs kill 2>/dev/null

APP="src-tauri/target/release/bundle/macos/Mycelium.app/Contents/MacOS/Mycelium"
# launch with Homebrew OFF PATH + MYCELIUM_HOME unset → forces the BUNDLED runtimes
env -u MYCELIUM_HOME PATH="/usr/bin:/bin" "$APP" &
curl -fsS --retry 20 --retry-connrefused http://127.0.0.1:8787/api/v1/account/status  # bundled Node
curl -fsS --retry 40 --retry-connrefused http://127.0.0.1:8091/health                 # bundled Python + offline model
```

Then in the window: import → auto-embed → **Generate** → mindscape. Re-launch to
confirm the vault persists; replace the `.app` to confirm an update doesn't wipe it.

## Glass / see-through (macOS vibrancy)

The shell opens a **transparent** window with native **NSVisualEffectView vibrancy**
(`window-vibrancy`, `apply_vibrancy(..., HudWindow)`), and the portal adds a
`glass-os` class when it detects Tauri so its panels stay translucent and the
desktop shows through. This needs:
- `tauri` feature `macos-private-api` + `"macOSPrivateApi": true` (already set), and
- the `window-vibrancy` dep (already in `Cargo.toml`).

These Rust bits were authored without a Mac/Rust toolchain in CI — `cargo tauri dev`
on your Mac is the first real compile. If `apply_vibrancy` / `TitleBarStyle` need a
version tweak, it'll surface there. To prefer a different look, swap
`NSVisualEffectMaterial::HudWindow` for `Sidebar` or `UnderWindowBackground`.
