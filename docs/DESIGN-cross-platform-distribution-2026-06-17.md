# Design — Cross-platform distribution: a real download button for macOS / Linux / Windows (2026-06-17)

> **Status: PLAN (not built).** This is the sweep-first design that takes the
> existing macOS-arm64-only, unsigned `Mycelium.app` to **signed, downloadable
> installers for macOS (Intel + Apple Silicon), Linux, and Windows**, with a
> website "Download" button and auto-update.
>
> **Phasing (operator-confirmed 2026-06-17):** macOS (both arches) first, then
> Linux, then Windows. Builds on
> [`DESIGN-packaged-app-distribution-2026-06-02.md`](DESIGN-packaged-app-distribution-2026-06-02.md)
> (Option B — fully self-contained bundle — already chosen and built for arm64-mac).

---

## 0. The core fact this design turns on

Mycelium is **not** a normal Tauri app. A normal Tauri app is a webview + a tiny
Rust binary, trivially cross-compiled. Mycelium ships a **~1 GB fully
self-contained runtime** so the user needs *nothing* installed
([`scripts/build-app-bundle.sh`](../scripts/build-app-bundle.sh)):

| Bundled component | Portability | Evidence |
|---|---|---|
| Node v22 binary | Per-OS/arch download — trivial | `NODE_URL` pins `darwin-arm64` (build-app-bundle.sh:31) |
| Relocatable Python 3.12 **+ all wheels** | **Per-OS/arch**; some wheels build-from-source | `PBS_URL` pins `aarch64-apple-darwin` (build-app-bundle.sh:28) |
| `better_sqlite3.node` (+ SQLCipher at-rest) | **Native — recompile per OS/arch** | bundled `node_modules/.../better_sqlite3.node` |
| Nomic v1.5 ONNX model | Portable (just files) ✅ | `ensure_model()` rsyncs HF cache |
| Sidecars `frpc` + `caddy` | Linux mapped; **Windows `.exe` not** | [`fetch-sidecars.sh`](../scripts/fetch-sidecars.sh):41-46 (no `*-pc-windows-msvc` arm) |

**Therefore "make it cross-platform" ≈ "re-produce this self-contained bundle on
each OS/arch target."** That, plus signing and a CI matrix, is ~90% of the work.
The window/UI is a rounding error by comparison.

A hard corollary: **native artifacts cannot be cross-compiled reliably.** Node
binaries, python-build-standalone, native wheels (faiss, ripser, igraph…) and
`better-sqlite3` must each be assembled **on a runner of the target OS/arch.** So
the deliverable is a **CI matrix**, not a single beefier build host.

---

## 1. Where we are today (verified, file:line)

- **Tauri v2 shell** [`src-tauri/`](../src-tauri/), `productName: Mycelium`,
  `identifier: id.mycelium.app` ([tauri.conf.json](../src-tauri/tauri.conf.json)).
  `bundle.targets: ["app","dmg"]`, `signingIdentity: "-"` (ad-hoc).
- **macOS arm64 only, unsigned/ad-hoc.** Gatekeeper warns; right-click→Open to
  side-load ([BUILD-MAC.md](../src-tauri/BUILD-MAC.md):92).
- **No desktop build CI.** Only [`.github/workflows/mobile.yml`](../.github/workflows/mobile.yml)
  (config sanity) and `verify.yml` exist. `main.rs` **has never compiled in CI**
  (BUILD-MAC.md:7-11) — first real compile is on the Mac.
- **Rust shell is partly platform-aware but Windows-incomplete:**
  - Process-group reaping is unix-only; **Windows is a silent no-op**:
    `#[cfg(not(unix))] fn kill_group(_pid: u32) {}` ([main.rs:140-141](../src-tauri/src/main.rs)).
    → On Windows the spawned Node + Python (1 GB) **orphan on app exit.**
  - Bundled runtime paths assume unix layout: `home.join("python/bin/python3")`,
    bare `node` ([main.rs:225-235](../src-tauri/src/main.rs)). Windows needs
    `python\python.exe`, `node.exe`.
  - Glass vibrancy is macOS-only (`window-vibrancy`, `macOSPrivateApi`) —
    [Cargo.toml](../src-tauri/Cargo.toml):14-15. No-op elsewhere (acceptable).
- **`fetch-sidecars.sh`** already maps `x86_64-apple-darwin`,
  `x86_64/aarch64-unknown-linux-gnu` — **Linux is half-done already.** Windows
  triple is unmapped and would `exit 1` ("unsupported target triple").

---

## 2. Work breakdown by platform

### Phase 1 — macOS Intel + Apple Silicon, signed & notarized  *(closest to done)*

Smallest delta; unblocks a credible download button for the largest desktop share.

1. **Add the x86_64 bundle target to `build-app-bundle.sh`.** Today it hard-pins
   `aarch64-apple-darwin` for both Node (`NODE_URL`) and Python (`PBS_URL`).
   Parameterise on the host triple (mirror the `case "$TRIPLE"` already in
   `fetch-sidecars.sh`). Build the x64 bundle **on a `macos-13` (Intel) runner** —
   native wheels + `better-sqlite3` + relocatable Python must match the arch.
   - Decision: **two single-arch DMGs** (`_aarch64`, `_x64`) vs. one Universal2.
     Universal2 doubles bundle size (~2 GB) and still can't fatten the Python
     venv's native `.so`s — recommend **two separate DMGs**, OS-detected on the
     site.
2. **Developer-ID signing + notarization.** Needs an **Apple Developer account
   ($99/yr)** — operator-gated. The 2026-06-02 design deliberately keeps native
   libs in `app_data_dir`, not the signed bundle, so child processes carry their
   own signing context ([DESIGN-packaged-app-distribution:82-95](DESIGN-packaged-app-distribution-2026-06-02.md)).
   But the **current bundle ships Node/Python/wheels *inside*
   `Contents/Resources/app/`** (build-app-bundle.sh) — under a hardened runtime
   every Mach-O in the bundle must be signed or notarization rejects it.
   - **Decision D1 (load-bearing — verify before building):** either
     (a) `codesign --deep` every `.dylib`/`.so`/binary in the staged tree +
     hardened-runtime entitlements (slow, but bundle stays read-only & offline),
     or (b) move the heavy runtime to first-run provisioning into `app_data_dir`
     (Option A from the prior design) so the *bundle* has only the shell + one
     `.node` to sign. **Recommend (a)** to preserve the zero-prereq/offline
     property the project already shipped; spike the notarization of one bundled
     `.so` first to confirm it passes.
   - Wire `tauri.conf.json` `bundle.macOS.signingIdentity` +
     `APPLE_CERTIFICATE`/`APPLE_ID`/`APPLE_TEAM_ID` CI secrets; Tauri runs
     `notarytool` + staples automatically.

### Phase 2 — Linux (AppImage + .deb)  *(medium; sidecars already mapped)*

1. **Linux branch in `build-app-bundle.sh`** (Node `linux-x64`/`arm64`,
   python-build-standalone `*-unknown-linux-gnu`). Native wheels resolve from
   **manylinux** on PyPI for everything in
   [`requirements.txt`](../pipeline/requirements.txt) — verify each has a
   manylinux wheel (faiss-cpu ✅, scikit-learn ✅, igraph/leidenalg ✅; **ripser
   builds from source → needs `build-essential` + Cython on the runner**).
2. **Tauri Linux targets:** `appimage` (universal, recommended primary) and
   `deb`. AppImage bundles glibc-sensitively — build on the **oldest supported
   Ubuntu** runner for forward-compat. `frpc`/`caddy` Linux fetch already works.
3. No code-signing required; optionally GPG-sign the AppImage + publish a
   `.zsync` for delta updates.
4. WebKitGTK is the Linux webview — verify the portal renders (CSP already set;
   check the glass class degrades to solid).

### Phase 3 — Windows (.msi / NSIS .exe)  *(biggest lift)*

1. **Fix child-process reaping (correctness-critical).** Replace the
   `#[cfg(not(unix))]` no-op `kill_group` with a **Windows Job Object**: create a
   job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, assign the spawned Node (and it
   assigns its grandchildren), so closing the window reaps the whole 1 GB tree.
   Use the `windows`/`win32job` crate behind `#[cfg(windows)]`. **Without this,
   every launch leaks a Node+Python tree.**
2. **Windows bundle layout in `build-app-bundle.sh`:** Node `win-x64` zip,
   python-build-standalone `*-pc-windows-msvc`, `.exe` suffixes. `main.rs`
   bundled-path logic (lines 225-235) needs `#[cfg(windows)]` → `python\python.exe`,
   `node.exe`.
3. **Native wheels on Windows** — the real risk. `faiss-cpu`, `scikit-learn`,
   `onnxruntime` ship win_amd64 wheels ✅; **`ripser` + possibly `leidenalg`/
   `python-igraph` may need MSVC build tools** on the runner. Spike `pip install
   -r requirements.txt` on `windows-latest` early — this is the most likely
   schedule risk.
4. **`better-sqlite3` + SQLCipher on Windows** — confirm the SQLCipher build path
   ([`vault-bridge`](../src/) / at-rest) compiles with MSVC; SQLCipher on Windows
   historically needs explicit OpenSSL or the amalgamation. **Spike the at-rest
   open on Windows** before committing to a date.
5. **Add Windows triple to `fetch-sidecars.sh`** (`x86_64-pc-windows-msvc` →
   caddy `windows/amd64`, `frpc.exe`).
6. **Code-signing cert** (operator-gated): without it, **SmartScreen blocks the
   download**. Cheapest modern path = **Azure Trusted Signing (~$10/mo)**; legacy
   OV/EV certs $200–400/yr. Wire `tauri.conf.json` `bundle.windows.certificateThumbprint`
   / signing command.

---

## 3. CI matrix (the delivery vehicle)

New `.github/workflows/desktop-release.yml`, triggered on version tags:

| Runner | Target | Output |
|---|---|---|
| `macos-14` | aarch64-apple-darwin | `Mycelium_<v>_aarch64.dmg` (signed+notarized) |
| `macos-13` | x86_64-apple-darwin | `Mycelium_<v>_x64.dmg` (signed+notarized) |
| `ubuntu-22.04` | x86_64-unknown-linux-gnu | `.AppImage` + `.deb` |
| `windows-latest` | x86_64-pc-windows-msvc | `.msi` + NSIS `.exe` (signed) |

Each job: checkout → `fetch-sidecars.sh` → `build-app-bundle.sh` (native) →
`cargo tauri build` → sign → upload to the GitHub Release. **This also becomes
the first CI that ever compiles `main.rs`** — folds in the long-standing gap
(BUILD-MAC.md:7). Build time per runner ~15-25 min (heavy: pip wheels + LTO Rust).

---

## 4. Auto-update + the website button

1. **Tauri updater plugin** (`@tauri-apps/plugin-updater` + `tauri-plugin-updater`):
   sign updates with a Tauri update keypair (separate from OS code-signing),
   publish `latest.json` per platform alongside releases. App checks on launch.
   - Caveat: a ~1 GB full-bundle update is a heavy download every release.
     Consider splitting **app-code updates** (small, frequent) from **runtime
     updates** (Node/Python/model — rare) so most updates are MB not GB. Tracked
     follow-on, not Phase-1 blocking.
2. **Website button** (trivial once artifacts exist): UA-sniff OS/arch →
   link to the latest GitHub Release asset. Fallback "All downloads" list.
   ```
   macOS (Apple Silicon) → Mycelium_<v>_aarch64.dmg
   macOS (Intel)         → Mycelium_<v>_x64.dmg
   Linux                 → Mycelium_<v>_amd64.AppImage
   Windows               → Mycelium_<v>_x64-setup.exe
   ```

---

## 5. Decisions needed from the operator (gating)

| # | Decision | Cost / blocker |
|---|---|---|
| O1 | Apple Developer account for notarization | $99/yr — **blocks clean macOS download** |
| O2 | Windows code-signing (Azure Trusted Signing vs OV/EV cert) | ~$10/mo – $400/yr — **blocks clean Windows download** |
| O3 | macOS: two per-arch DMGs vs Universal2 | recommend two DMGs (smaller, simpler) |
| O4 | Signing approach D1: sign-in-bundle vs first-run provision | recommend sign-in-bundle (keeps offline/zero-prereq) — spike first |
| O5 | Release host: GitHub Releases vs own CDN | recommend GitHub Releases (free, updater-friendly) |
| O6 | Full-bundle vs split-update strategy | recommend split (later) — Phase-1 ships full-bundle |

---

## 6. Verification gates (per the repo's design-rigor discipline)

Before each phase builds on the next, prove the load-bearing assumption with a
**running spike**, not paper reasoning (CLAUDE.md "Design rigor"):

1. **macOS x64:** assemble the bundle on a `macos-13` runner; the clean-env smoke
   from BUILD-MAC.md §"Verify the packaged app" must pass (`:8787` bundled Node +
   `:8091` bundled Python + offline model) on Intel.
2. **Notarization (D1):** notarize one bundle containing a representative native
   `.so`/`.dylib`; confirm `spctl -a -vv` passes. If rejected → fall back to O4(b).
3. **Linux:** `pip install -r requirements.txt` on the chosen Ubuntu runner with
   only `build-essential` (catch ripser source-build); AppImage launches +
   portal renders under WebKitGTK.
4. **Windows:** (a) `pip install -r requirements.txt` on `windows-latest`;
   (b) SQLCipher at-rest open succeeds; (c) Job-Object reap verified — close the
   window, assert no orphan `node.exe`/`python.exe`.

Each gate records a verdict (table / spike RESULT) before the dependent layer
lands.

---

## 7. Honest effort estimate

| Phase | Scope | Estimate |
|---|---|---|
| 1 — macOS Intel + notarization | x64 bundle target, signing/notarization wiring, CI mac jobs | ~1 week (+ O1) |
| 2 — Linux | bundle branch, AppImage/.deb, WebKitGTK smoke, CI ubuntu job | ~1–1.5 weeks |
| 3 — Windows | Job-Object reap, win bundle layout, wheel/SQLCipher spikes, signing, CI win job | ~2–3 weeks (+ O2) |
| 4 — Auto-update + site button | updater plugin, manifest, OS-detect button | ~3–4 days |

Windows dominates the schedule because of the Job-Object reap + native-wheel /
SQLCipher unknowns — those spikes should run **first** in Phase 3 to de-risk.

---

## 8. Open follow-ons (not in scope here)

- Split full-bundle vs app-code-only updates (§4.1) to avoid 1 GB updates.
- Linux arm64 (only if there's demand).
- Auto-update delta/binary-diff (`tauri` updater supports it).
- Flatpak / winget / Homebrew-cask listings for discoverability.
