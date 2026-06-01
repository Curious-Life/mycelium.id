# Building the Mycelium Mac app (Tauri) — Apple Silicon

This turns the local server + portal into a real `Mycelium.app` in your dock.
The shell (`src-tauri/`) spawns the Node server (which serves the portal UI **and**
the REST API at `http://127.0.0.1:8787`) and opens a window pointed at it.

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
```

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

## 3. Build the distributable app

```bash
cargo tauri build
# →  src-tauri/target/release/bundle/macos/Mycelium.app
#    src-tauri/target/release/bundle/dmg/Mycelium_0.1.0_aarch64.dmg
```

Drag `Mycelium.app` to /Applications.

## Shipping Node *inside* the .app (so users don't need MYCELIUM_HOME)

The dev flow above points the shell at your repo via `MYCELIUM_HOME`. For a
self-contained app, bundle the Node project (and a Node runtime) as resources:

1. Add the project to `tauri.conf.json` → `bundle.resources` (e.g. map `../src`,
   `../portal`, `../migrations`, `../node_modules`, `../package.json` into `app/`).
2. `mycelium_home()` in `src/main.rs` already falls back to
   `resource_dir()/app` when `MYCELIUM_HOME` is unset.
3. For a zero-dependency app, ship a Node binary as a Tauri **sidecar** and
   invoke it instead of the system `node` (Node SEA or a pinned `node` binary).

This is the natural next increment; the dev flow (step 1) already gives you a
working native app on your Mac today.

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
