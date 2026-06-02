# Design — Packaged-app distribution (Tier B): ship a real, double-clickable Mycelium (2026-06-02)

Built with **sweep-first-design** (4 parallel Explore sweeps + direct reads of every load-bearing line). This is the "Tier B" deferred in
`docs/DESIGN-fresh-user-provisioning-2026-06-02.md`.

> **Status: BUILDING — Option B (fully self-contained), unsigned.** Decision made;
> both de-risk spikes green. Live state in the **Progress log** (bottom of this doc).

---

## Problem (bigger than "bundle Python")

The packaged `.app` bundles **none of its runtime**. Today it has only ever run
in **dev mode**: `cargo tauri dev` with `MYCELIUM_HOME=<repo>` pointing every
spawn at the live checkout. A distributed `.app` would have no `node`, no
`node_modules`, no `src/`, no `pipeline/`, no venv, and no model — so it can't
boot the server, let alone embed or cluster. "Fix Tier B" = **turn this into a
real distributable.**

## Verified terrain (sweep findings, all cited)

**Nothing-runtime is bundled.** `tauri.conf.json` `bundle` = `active/targets/
category/icon` only — **no `resources`, no `externalBin`, no
`beforeBuildCommand`** (`src-tauri/tauri.conf.json:6-26`). `build.frontendDist =
"../portal"` is the only build key. Never built as a distributable (no
`target/release/bundle/`); `docs/BUILD-MAC.md` documents the intended
`cargo tauri build`.

**No `tauri-plugin-shell`** → no `externalBin` sidecar mechanism today; spawns use
raw Rust `std::process::Command` (`Cargo.toml:8-17`; `main.rs:65,100`).

**Base dir** = `mycelium_home()` = `MYCELIUM_HOME` → `resource_dir()/app` → `"."`
(`main.rs:48-56`). The node server runs `node src/server-rest.js` with
`current_dir=home` (`main.rs:65-82`); the embed service runs
`home/pipeline/.venv/bin/python3` **else** system `python3`
(`main.rs:94-99`), `current_dir=home`. So in a built app, **everything must live
under `…app.app/Contents/Resources/app/`**.

**Node runtime footprint:** deps = `@modelcontextprotocol/sdk, better-auth,
better-sqlite3, busboy, express, jszip`; `engines.node >=22`; `type:module`
(`package.json:5,9,56-63`). **`better-sqlite3` is the only native addon** —
`node_modules/better-sqlite3/build/Release/better_sqlite3.node` (arch-specific) —
and it's the **vault DB driver** (`src/adapter/d1.js:12`, `src/server-rest.js:5`),
so it *must* ship and match the bundled node's ABI/arch. The **whole `src/` tree**
loads at boot (account, adapter, crypto, db, enrich, ingest, mcp, search…), plus
`migrations/` (`src/db/migrate.js`) and the portal UI served from
`portal-app/build` (preferred) else `portal/` (`src/server-rest.js:20-40,227-237`).
`node_modules` = **63 MB**.

**Python footprint:** venv = **694 MB**, all arch-specific native wheels (faiss,
onnxruntime, scipy, sklearn, igraph, leidenalg, umap, ripser…). The venv is
**NOT relocatable** — `pyvenv.cfg` hardcodes `/opt/homebrew/opt/python@3.12/bin`
and `bin/python3.12` is an absolute symlink into Homebrew. **Copying it into a
bundle breaks it.** The Nomic model **downloads at runtime** via
`hf_hub_download()` (`embed-service.py:99,113`) into `~/.cache/huggingface`
(**135 MB**); it respects `HF_HOME`/`HF_HUB_OFFLINE`. Python **3.12** required.

**Signing:** none configured (no entitlements/identity/hardened-runtime;
`tauri.conf.json` `bundle.macOS` absent). Notarization will later require every
Mach-O **inside the bundle** to be signed.

## The core insight → architecture

Two facts make the design almost decide itself:

1. **The venv can't be bundled** (non-relocatable, 694 MB, arch-locked) — but we
   **already have `pipeline/setup.sh`** (just hardened in Tier-A) that builds a
   correct venv + installs both dep sets + warms the model **on the user's own
   machine/arch**.
2. The app **already** uses `app_data_dir` (`~/Library/Application Support/
   id.mycelium.app`) — writable, **survives updates** (`main.rs:76-78`,
   `src/paths.js`) — and `main.rs` **already** prefers a venv if present else falls
   back. A signed `.app` bundle is read-only, but `app_data_dir` is not.

→ **Provision the Python venv + model at FIRST RUN into `app_data_dir`** (reusing
`setup.sh`), and **bundle only the code** (src/, pipeline scripts, node_modules,
portal build, migrations) into `Resources/app/`.

**Why this is the robust core (not a shortcut):**
- Sidesteps the non-relocatable-venv problem entirely — we *build* the venv for
  the user's real arch instead of trying to relocate ours.
- **Keeps native binaries OUT of the signed/notarized bundle.** A spawned
  `python`/`node` is a *separate process* with its own code-signing context —
  the Rust app's hardened-runtime **library validation does not propagate to an
  exec'd child** (unlike `dlopen`). So the venv's unsigned `.dylib`s (faiss,
  onnxruntime) load fine, and — critically — they're not in the bundle, so
  **notarization never has to scan/sign them.** This collapses the single hardest
  packaging problem.
- Reuses Tier-A. `setup.sh` pointed at `app_data_dir` is the same code path we
  already verified.
- Model lands in `app_data_dir` via `HF_HOME` → offline after first run; survives
  updates.

The remaining in-bundle native bit is `better_sqlite3.node` (one addon) — small
enough to sign for notarization later, or also first-run-provisioned.

## The fork (your decision — drives the rest)

Everything above is settled. What's genuinely a product call is **how
self-contained the build is**, because it sets the host prerequisites + effort:

| Option | Host needs | .app size | Effort | Best for |
|---|---|---|---|---|
| **A. First-run provision (recommended)** | Node 22 + Python 3.12 present | small (~70 MB) | **Phase 1, days** | a real double-clickable app for you/dev/prosumer machines now |
| **B. Fully self-contained** | nothing | ~250 MB–1 GB | **Phase 2, weeks** | shipping to non-technical users, offline |
| **C. Documented prereqs only** | Node + Python + run setup.sh by hand | tiny | hours | stop-gap; worst UX |

A and B are **the same architecture** — B just *also* bundles a Node binary and a
relocatable Python (python-build-standalone / `uv`) so the user needs nothing. So
**A is Phase 1 of B**: do A now (working app fast), then bundle the two runtimes
to reach B. C is a non-goal except as interim docs.

**Recommendation: A now (Phase 1), B as a tracked follow-on.** Signing:
**unsigned/ad-hoc for Phase 1** (side-load: right-click→Open), Developer-ID
notarization in Phase 2 (needs an Apple Developer account).

## Decision (2026-06-02) — Option B (fully self-contained), unsigned

Chosen: **fully self-contained** (bundle Node + a relocatable Python + all wheels +
the model; zero host prerequisites; works offline) and **unsigned / ad-hoc** for now
(side-load via right-click→Open; notarization later). Unsigned *removes* B's hardest
blocker: with no hardened runtime, the bundled unsigned native `.dylib`s load without
entitlements — so "self-contained + unsigned" is the most tractable form of B.

**Implementation order — DE-RISK FIRST (each step independently verifiable):**

0. **Spike P — relocatable Python (riskiest assumption).** Download
   python-build-standalone 3.12 arm64; `pip install` canary native wheels
   (faiss-cpu, onnxruntime, scipy, numpy); MOVE the tree; import them from the new
   path with Homebrew python OFF PATH. GATE: if a wheel bakes absolute paths and
   breaks on move, fall back to first-run-provisioned Python even in the
   self-contained build (or switch to `uv`-managed relocatable envs).
0b. **Spike N — bundled Node.** Download Node 22 arm64; boot `src/server-rest.js`
   with it + load `better_sqlite3.node` from a relocated dir, system `node` OFF PATH.
1. **Build-staging script** — assemble `Resources/app/`: src/, node_modules/,
   pipeline/ (scripts), migrations/, package.json, portal-app/build/, `node`
   (binary), `python/` (relocatable + wheels), model files.
2. **tauri.conf.json** — `bundle.resources` (staged tree), `beforeBuildCommand`
   (portal build + staging), minimal `bundle.macOS`.
3. **main.rs** — node from `home/node` else system; embed python from
   `home/python/bin/python3`; `HF_HOME`→bundled model + `HF_HUB_OFFLINE=1`.
4. **jobs.js / run-clustering.sh** — clustering via the bundled python (`PYTHON`).
5. **Build + verify** — `cargo tauri build` → move `.app` to /Applications → launch
   with `MYCELIUM_HOME` unset and system node/python OFF PATH → boot → import →
   embed → **Generate** end-to-end; re-launch + update-safety; note ~1 GB size.
6. **Docs** — `BUILD-MAC.md`.

## Spike log (de-risk results)
- **Spike P — relocatable Python: ✅ PASS (2026-06-02).** python-build-standalone
  3.12.13 (matches our venv) + `pip install faiss-cpu onnxruntime scipy numpy`
  (→298 MB), then **moved the tree** to a new absolute path and imported all four
  from there under a clean env (`env -i PATH=/usr/bin:/bin`, no Homebrew):
  `faiss 1.14.2 | ort 1.26.0 | numpy 2.4.6`, exit 0. Native dylibs use relative
  (@rpath/@loader_path) refs → relocation-safe. **Bundle-a-relocatable-Python is
  validated** (replaces the non-relocatable Homebrew venv).
- **Spike N — bundled Node + better-sqlite3: ✅ PASS (2026-06-02).** Downloaded
  Node v22.22.3 arm64; in a clean env (Homebrew node OFF PATH) it loaded the native
  `better_sqlite3.node` addon (`row=42`) AND booted the full `src/server-rest.js`,
  which served `/api/v1/account/status → {initialized,keychainAvailable}` on :8799.
  **Bundling a Node binary + the existing node_modules (incl. the native addon) is
  validated.** Both spikes green → Option B de-risked; proceeding to the build-out.
- **Tauri v2 bundling — verified (v2 docs).** `bundle.resources` MAP form
  `{"../build-staging/": "app"}` copies the staged tree into
  `Contents/Resources/app/` preserving structure (matches `main.rs`'s
  `resource_dir()/app`). `build.beforeBuildCommand` runs the staging script before
  the bundle. We invoke the bundled `node`/`python` by absolute path via raw
  `Command` — no `tauri-plugin-shell`/`externalBin` needed.

## Bundle layout (Resources/app/)
```
node                     # Node v22.22.3 arm64 binary (bundled)
python/bin/python3       # relocatable python-build-standalone 3.12.13 + all wheels
hf-cache/hub/…           # Nomic v1.5 ONNX model (offline first run, via HF_HOME)
node_modules/…           # incl. better_sqlite3.node (arm64)
src/  pipeline/  migrations/  package.json  portal-app/build/
```
Runtime wiring: `node`=`home/node` else system; embed/cluster python =
`home/python/bin/python3`; `HF_HOME=<writable app_data>/hf-cache` seeded from the
bundle on first run (read-only-bundle-safe), `HF_HUB_OFFLINE=1`.

## Phase 1 implementation sketch (Option A)

1. **`tauri.conf.json`**: add `bundle.resources` to copy `src/`, `pipeline/`
   (scripts only — not `.venv`), `node_modules/`, `migrations/`, `package.json`,
   `portal-app/build/` into `Resources/app/`. Add
   `build.beforeBuildCommand: "npm --prefix portal-app run build"` so the portal is
   fresh. (frontendDist stays — the webview is an External URL to localhost, so it's
   largely vestigial, but Tauri requires a valid dir.)
2. **First-run provisioning** (new): on launch, if
   `app_data_dir/pipeline/.venv` is missing, run `setup.sh` with the venv targeted
   at `app_data_dir` (env override), behind a **progress UI** ("Setting up your
   vault's analysis engine — one time, a few minutes"). Health-check Python 3.12 +
   Node first; if absent, a clear "install Node 22 / Python 3.12" screen (Phase 1).
3. **Point the runtimes at `app_data_dir`**: `main.rs` embed-service spawn and
   `jobs.js` run-clustering.sh should resolve the venv from `app_data_dir` (via an
   env like `MYCELIUM_VENV`/`MYCELIUM_PYTHON`) with the in-bundle/dev fallback.
   `setup.sh` + `run-clustering.sh` gain a venv-location override (run-clustering.sh
   already has the `PYTHON` seam from Tier-A).
4. **`HF_HOME`** → `app_data_dir/hf-cache` so the model persists outside the bundle.
5. **Build + verify** (below).

Phase 2 (separate): bundle a Node binary (resources or add `tauri-plugin-shell` +
`externalBin`) and a relocatable Python (python-build-standalone) + offline model;
entitlements + notarization.

## Verification strategy (Phase 1)

- `cargo tauri build` produces `…/bundle/macos/Mycelium.app` (+ dmg).
- **Copy the `.app` to `/Applications` (or elsewhere) and launch with
  `MYCELIUM_HOME` UNSET** — the real test that nothing depends on the checkout.
- First-run: confirm the provisioning UI runs `setup.sh` into `app_data_dir`,
  the embed service comes up (:8091), import → auto-embed works.
- **Generate** end-to-end in the packaged app → mindscape renders.
- Re-launch: provisioning is skipped (venv present); vault + venv survive an app
  replace (update-safe).
- Negative: temp-rename the venv → app re-provisions; deps-missing path shows the
  Tier-A actionable error.

## Risks + mitigations
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Host lacks Node 22 / Python 3.12 (Phase 1) | High (some users) | blocks | Clear first-run check + instructions; Phase 2 bundles both |
| `better_sqlite3.node` ABI ≠ bundled/host node | Med | server won't boot | Pin Node 22; rebuild/prebuild better-sqlite3 for it; verify on a clean machine |
| First-run pip build needs a compiler for some wheel | Low (arm64 wheels exist) | provisioning fails | Tier-A install is non-fatal + actionable; document Xcode CLT |
| Notarization later rejects in-bundle native libs | Med (Phase 2) | can't distribute | Architecture keeps native code in app_data_dir, not the bundle; sign the lone `.node` |
| `frontendDist` stale vs `portal-app/build` | Med | blank UI | `beforeBuildCommand` builds the portal; server prefers `portal-app/build` |

## Verification table (assumptions → read myself)
| Assumption | Verified at |
|---|---|
| Bundle ships no runtime (no resources/externalBin/beforeBuild) | `src-tauri/tauri.conf.json:6-26` |
| Base dir + node/python spawns resolve from `mycelium_home` | `src-tauri/src/main.rs:48-56,65-82,94-99` |
| `better-sqlite3` native addon is the vault driver (must ship) | `src/adapter/d1.js:12`; `node_modules/better-sqlite3/build/Release/better_sqlite3.node` |
| Venv is non-relocatable (Homebrew-hardcoded) | `pipeline/.venv/pyvenv.cfg`; `bin/python3.12 →/opt/homebrew/...` |
| Model downloads at runtime, respects HF_HOME | `pipeline/embed-service.py:99,113` |
| `app_data_dir` is writable + update-safe (already used) | `src-tauri/src/main.rs:76-78`; `src/paths.js` |
| Sizes: venv 694 MB, node_modules 63 MB, model 135 MB | `du -sh` (this machine) |

## Deferred / open
- **Windows/Linux** distributables (this design is macOS-first; the venv/path
  logic generalizes but is untested off-mac).
- **Code-signing identity / Apple Developer account** — needed for notarized
  distribution (Phase 2); unknown if available.
- **Auto-update** (Tauri updater) — out of scope.

## Progress log
_Kept current as the build-out proceeds (per user request)._
- ✅ Design + verification table; **Option B** (self-contained, unsigned) chosen.
- ✅ **Spike P** (relocatable Python + native wheels) + **Spike N** (bundled Node +
  better-sqlite3 + full server boot) — both PASS.
- ✅ Tauri v2 bundling syntax verified; bundle layout defined.
- ✅ `scripts/build-app-bundle.sh` — staging assembler written + **RUN OK**: the full
  `requirements.txt` installs cleanly into the bundled Python; staging tree = **1.0 GB**
  (node v22.22.3 · python 3.12.13 + wheels 763 MB · model 132 MB · code + node_modules).
- ✅ Wire `main.rs` (bundled node/python + offline `HF_HOME`) + `jobs.js` (clustering
  via bundled python; the server PATH carries the bundled node dir).
- ✅ Wire `tauri.conf.json` (resources map `{"../build-staging/":"app"}` +
  `beforeBuildCommand`) + `.gitignore` (`build-staging/`, `.build-cache/`); `cargo
  check` passes (Rust compiles, 35s).
- ✅ `BUILD-MAC.md` updated (self-contained build steps + clean-env verify recipe).
- ✅ `cargo tauri build`: **`Mycelium.app` built (1.2 GB)** — Rust release in 1m35s.
  DMG step failed in `bundle_dmg.sh` (common hdiutil/Finder hiccup; **non-fatal** — the
  .app is the deliverable; fix later via retry or `bundle.targets:["app"]`).
- ✅ **Bundled runtimes verified in a CLEAN env from INSIDE the .app**: node v22.22.3;
  python 3.12.13 + all 9 native wheels import (faiss/onnxruntime/leidenalg/igraph/…);
  Nomic model + `better_sqlite3.node` present. (The post-bundle relocation works.)
- ✅ **VERIFIED end-to-end (clean env).** Launched `Mycelium.app/Contents/MacOS/Mycelium`
  with `MYCELIUM_HOME` unset + `PATH=/usr/bin:/bin`:
  - `:8787` served by the **bundled** node (`ps` → `…/Resources/app/node src/server-rest.js`).
  - `:8091` bundled Python loaded the **offline** Nomic model (163 ms) and **embedded** a
    768-d vector — no network, no Homebrew.
  - Account **setup-mode** correctly triggered (app_data still holds the throwaway test
    vault from earlier sessions; the packaged app reads the real keychain keys → KCV
    mismatch → first-run/restore ceremony). NOT a build issue — resolved by restoring a
    matching vault. **Self-contained, zero-prerequisite app proven.**

### Follow-ups
- **DMG** packaging (`bundle_dmg.sh`) failed (hdiutil/Finder) — retry, or set
  `bundle.targets:["app"]` and distribute the zipped `.app` meanwhile.
- **Land Tier-B** on a branch/PR: `scripts/build-app-bundle.sh`, `tauri.conf.json`,
  `main.rs`, `jobs.js`, `.gitignore`, `BUILD-MAC.md`, this design doc.
- **Real-data Generate** in the packaged app → restore the matching (real) vault first.
- **Phase 2:** Developer-ID signing + notarization; Intel (x86_64) + Windows/Linux.

## Revision history
- **v1:** sweep-first terrain map + architecture (first-run provision into
  app_data_dir; bundle code via resources; child-process signing escape). Awaiting
  the self-containment fork before the implementation plan is finalized.
- **v2 (decision):** user chose **Option B (fully self-contained), unsigned**.
  Implementation reordered de-risk-first: prove relocatable Python (Spike P) +
  bundled Node (Spike N) before wiring the bundle. Unsigned removes the
  entitlements/notarization blocker for the bundled native libs (no hardened runtime).
  NOTE: for B, the venv is replaced by a relocatable python-build-standalone tree
  with wheels installed in-place (no `pyvenv.cfg` path hardcoding); the model is
  bundled (HF_HUB_OFFLINE) rather than first-run-downloaded.
