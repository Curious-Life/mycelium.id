# Design — macOS signed + notarized distribution (Intel + Apple Silicon) (2026-06-17)

> **Status: BUILT — pending operator secrets + first CI run** (branch
> `feat/macos-signed-dist`). Sweep-first design (4 parallel sweeps + direct PyPI /
> file:line verification) taking the existing **arm64-only, ad-hoc-signed**
> `Mycelium.app` to **two notarized DMGs** — `aarch64` + `x86_64` — behind a
> website Download button. Operator has an Apple Developer account.
>
> Parent plan: [`DESIGN-cross-platform-distribution-2026-06-17.md`](DESIGN-cross-platform-distribution-2026-06-17.md)
> (Phase 1). Supersedes that doc's hand-wavy "decision D1: sign-in-bundle vs
> first-run provision" with a concrete, sweep-verified signing pipeline.
>
> ### As-built status (2026-06-18, branch `feat/macos-signed-dist`)
> Reconciled against pre-existing code — commit 98ee249 already shipped most of
> the signing path. **Committed:**
> - **Step 1** — `build-app-bundle.sh` arch-parameterized (`MYC_ARCH`) + cache
>   arch-scoped + `cryptography>=42,<45` cap. *(a96315d)*
> - **Step 3** — `sign-macos.sh` already existed and was inside-out-correct; fixed
>   its one real defect (no child entitlements on `node`/`python3` → would
>   notarize but crash at launch) via new `entitlements-child.plist`. *(7bb45f5)*
> - **Step 4** — planned `make-dmg.sh` **DROPPED as redundant**: the pre-existing
>   `notarize-macos.sh` already builds the DMG via `hdiutil` from the stapled app.
> - **Step 5** — `desktop-release.yml` 2-arch CI (macos-14 + macos-13). *(8a444f6)*
>
> **Remaining:** operator wires 6 GH secrets (§9) → gates **G1** (Intel bundle
> builds) + **G3** (notarytool ACCEPTED) run in CI on the first `v*` tag; **Step
> 6** website button; **Step 2** Intel smoke folds into that CI run.

---

## Revision history

- **v1 (parent plan, 2026-06-17):** "Add x64 target; set `signingIdentity`; Tauri
  notarizes." Assumed setting the identity in `tauri.conf.json` was enough.
- **v2 (this doc) — PIVOT 1 (signing):** Sweep D proved Tauri's macOS bundler
  does **NOT** deep-sign nested `Resources/` files; it signs only the main
  binary + frameworks + `externalBin` sidecars
  ([tauri#8075](https://github.com/tauri-apps/tauri/issues/8075),
  [#12001](https://github.com/orgs/tauri-apps/discussions/12001)). Our bundle has
  **310 nested Mach-O files**. So we need a **custom inside-out codesign pass
  after `cargo tauri build`**, and Tauri's in-build auto-notarization must be
  **disabled** (it would fail on the 300 unsigned nested binaries). Signing moves
  out of Tauri's hands and into `scripts/sign-macos.sh`.
- **v2 — PIVOT 2 (Intel wheels):** Sweep C flagged `cryptography` + `onnxruntime`
  as "arm64-only on macOS" → would force source builds. Direct PyPI check
  refuted it for the **pinned** versions: `onnxruntime==1.20.1` ships
  `universal2`, `cryptography` has `universal2` through 44.x (only 49 dropped
  Intel). Fix is a one-line version cap, not a toolchain. Intel is fully
  wheel-served.

---

## 1. Sweep findings (consolidated, file:line)

### 1.1 What's in the bundle — 310 nested Mach-O (Sweep A)
The packaged app is **~1.4 GB**, `Resources/app/` carries a full self-contained
runtime ([build-app-bundle.sh:135-152](../scripts/build-app-bundle.sh)):
- **Standalone execs** (Contents/MacOS/): `mycelium` (Rust shell), `caddy` (~48 MB),
  `frpc` (~14 MB) — the latter two via `externalBin`
  ([tauri.conf.json:18](../src-tauri/tauri.conf.json)).
- **Bundled `node`** v22.22.3 (~108 MB Mach-O) at `Resources/app/node`.
- **Relocatable `python/`** (~764 MB): `python/bin/python3` + **35 `.dylib`** +
  **270 `.so`** (lib-dynload + site-packages wheels). Heaviest:
  `libonnxruntime.1.20.1.dylib` (52 MB), `libfaiss.dylib` (8.5 MB), scipy (112
  `.so`), sklearn (70).
- **Node native:** `better_sqlite3.node` (it's
  `better-sqlite3-multiple-ciphers@^11.10.0` — SQLCipher is statically linked, no
  separate dylib; [package.json:219](../package.json)) + `sqlite-vec`'s `vec0.dylib`.
- **Total: 310 `.dylib`/`.so`/`.node` + executables.** All currently **arm64**;
  **none** are universal2.
- **No** ffmpeg/ollama/sox/whisper/kokoro binaries (kokoro/whisper run as Python
  under the bundled interpreter — Sweep A + B).

### 1.2 Runtime processes — 8 long-running execs, 4 are own signing contexts (Sweep B)
Each `exec`'d binary is its **own** code-signing/entitlement context under
hardened runtime, so the bundled interpreters must themselves be signed +
entitled:
- `node` REST server :8787 ([main.rs:251](../src-tauri/src/main.rs)) and `node`
  :4711 MCP/OAuth supervisor ([main.rs:319](../src-tauri/src/main.rs)).
- `caddy` :443 ([main.rs:374](../src-tauri/src/main.rs)), `frpc`
  ([main.rs:401](../src-tauri/src/main.rs)) — release builds resolve sidecars
  **only beside the binary, never PATH** ([main.rs:107-111](../src-tauri/src/main.rs)) —
  anti-PATH-hijack gate; keep it.
- `python3` embed-service :8091 (`embed/supervisor.js:104`), transcribe :8093
  (opt-in), kokoro TTS :8094 (opt-in) — all via `MYCELIUM_PYTHON` → bundled
  `python/bin/python3`.
- `node` channel-daemon :3010 via `process.execPath` (`channels/supervisor.js:127`).
- Transient: `bash pipeline/run-clustering.sh` ([jobs.js:133](../src/jobs.js)) →
  Python stage children.

### 1.3 Entitlements — already complete (Sweep B)
[`entitlements.plist`](../src-tauri/entitlements.plist) already declares all four
hardened-runtime exceptions this architecture needs:
`com.apple.security.cs.allow-jit`, `allow-unsigned-executable-memory` (V8 JIT in
Node), `allow-dyld-environment-variables` (main.rs mutates PATH/HF_HOME for
children, [main.rs:262-271](../src-tauri/src/main.rs)),
`disable-library-validation` (Python `dlopen` of wheel `.so`). `get-task-allow`
correctly absent (dev-only). **No entitlement changes needed for the app**; child
execs (`node`, `python3`) need the *same* set applied to them individually.

### 1.4 Arch hardcoding — narrow + already half-solved (Sweep C, verified)
- [build-app-bundle.sh:28-29](../scripts/build-app-bundle.sh) `PBS_URL` pins
  `aarch64-apple-darwin`; [:31](../scripts/build-app-bundle.sh) `NODE_URL` pins
  `darwin-arm64`; [:67](../scripts/build-app-bundle.sh) the node extract path
  repeats `darwin-arm64`. **These three are the entire arch surface to
  parameterize.**
- [fetch-sidecars.sh:41-47](../scripts/fetch-sidecars.sh) **already** maps
  `x86_64-apple-darwin` → caddy/frpc amd64. Only needs the x86_64 checksums
  pinned (TOFU first run).
- `node_modules` is **rsync-copied from the host** with **no `npm rebuild`**
  ([build-app-bundle.sh:141](../scripts/build-app-bundle.sh)) → the
  `better_sqlite3.node` is **host-arch**. ⇒ x86_64 builds MUST run `npm ci` on an
  **Intel runner**; `.node` files do not cross-compile.
- `pipeline/run-clustering.sh` has **no** arch assumptions (Sweep C).
- xattrs already stripped pre-sign ([build-app-bundle.sh:160](../scripts/build-app-bundle.sh)).

### 1.5 Intel wheels — solved by pinning (verified against PyPI JSON myself)
| Dep | Pin | Intel-mac wheel (verified) |
|---|---|---|
| onnxruntime | `==1.20.1` | `macosx_13_0_universal2` ✅ (⇒ **min macOS 13.0**) |
| numpy | `==2.1.3` | `macosx_10_13_x86_64` ✅ |
| tokenizers | `==0.21.0` | `macosx_10_12_x86_64` (abi3) ✅ |
| cryptography | **cap `>=42,<45`** (e.g. `==44.0.1`) | `macosx_10_9_universal2` ✅ (49 dropped Intel) |
| faiss-cpu, scipy, scikit-learn, leidenalg, PyWavelets, ripser | (existing ranges) | x86_64 wheels exist ✅ (Sweep C) |
| python-igraph, umap-learn, persim | — | pure-Python ✅ |

**No source builds on Intel.** Only change: cap `cryptography` in
[requirements.txt](../pipeline/requirements.txt).

### 1.6 Tauri signing behavior (Sweep D — the pivot, sourced)
- Tauri macOS bundler signs **only** main binary + frameworks + `externalBin`;
  **not** nested `resources` Mach-O ([#8075](https://github.com/tauri-apps/tauri/issues/8075),
  [#12001](https://github.com/orgs/tauri-apps/discussions/12001)).
- `externalBin` signing has a known re-sign **ordering bug**
  ([#11992](https://github.com/tauri-apps/tauri/issues/11992)) → "signature
  invalid" at notarize. Mitigation: do **all** signing ourselves post-build.
- Apple requires every Mach-O signed Developer-ID + `--options runtime` +
  `--timestamp`, **inside-out**; `codesign --deep` is discouraged ("Considered
  Harmful") — sign each file individually. Outer `.app` sealed **last**.
- Tauri auto-notarizes during build **iff** `APPLE_*` creds are present → we
  **withhold creds from `cargo tauri build`** and notarize ourselves after signing.

---

## 2. The signing pipeline (PIVOT 1 — load-bearing)

```
[Intel or arm64 macOS runner]
1. npm ci                         # native better_sqlite3.node for THIS arch
2. bash scripts/fetch-sidecars.sh # caddy/frpc for host triple (+ pin checksums)
3. MYC_ARCH=<arch> bash scripts/build-app-bundle.sh   # arch-parameterized staging
4. cargo tauri build              # NO APPLE_* creds, signingIdentity:"-" (ad-hoc)
                                  #   → Mycelium.app with 310 unsigned nested Mach-O
5. bash scripts/sign-macos.sh "Developer ID Application: … (TEAMID)"
       # inside-out, depth-first:
       #   a. every .so/.dylib/.node : codesign --force --timestamp --options runtime -s ID
       #   b. node, python3          : (a) + --entitlements child-entitlements.plist
       #   c. caddy, frpc            : codesign --force --timestamp --options runtime -s ID
       #   d. Mycelium.app (OUTER)   : (a) + --entitlements entitlements.plist   [LAST]
6. bash scripts/make-dmg.sh       # hdiutil (headless-safe; NOT Tauri's Finder/AppleScript dmg)
7. codesign --force --timestamp --options runtime -s ID  Mycelium_<v>_<arch>.dmg
8. xcrun notarytool submit Mycelium_<v>_<arch>.dmg --wait   # creds here only
9. xcrun stapler staple Mycelium_<v>_<arch>.dmg
10. upload to GitHub Release as Mycelium_<v>_<arch>.dmg
```

**Why all-signing-ourselves (not Tauri's identity):** avoids the `externalBin`
re-sign ordering bug (#11992) and gives one deterministic inside-out pass. Tauri
ad-hoc-builds; we own the real signature. The outer `.app` re-seal (5d) covers
every nested signature we applied.

**Why two DMGs, not Universal2 (Decision O3):** the 310 nested Mach-O are
per-arch; a universal app would require `lipo`-ing all of them (incl. the bundled
node/python/wheels — most have no universal2 form) and ~double the 1.4 GB. Two
single-arch DMGs + website arch-detection is simpler and half the download. The
DMGs themselves stay per-arch.

---

## 3. Module shape (exact)

### 3.1 `scripts/build-app-bundle.sh` — parameterize arch (~12 lines changed)
```bash
MYC_ARCH="${MYC_ARCH:-$(uname -m)}"            # arm64 | x86_64
case "$MYC_ARCH" in
  arm64|aarch64) PBS_ARCH=aarch64; NODE_ARCH=arm64 ;;
  x86_64)        PBS_ARCH=x86_64;  NODE_ARCH=x64   ;;
  *) echo "unsupported MYC_ARCH: $MYC_ARCH" >&2; exit 1 ;;
esac
PBS_URL=".../cpython-${PY_VER}%2B${PBS_TAG}-${PBS_ARCH}-apple-darwin-install_only.tar.gz"
NODE_URL="https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-darwin-${NODE_ARCH}.tar.gz"
# line 67 extract path: node-${NODE_VER}-darwin-${NODE_ARCH}/bin/node
# .build-cache keyed per-arch:  RT="$CACHE/runtime-${MYC_ARCH}"   (avoid arm64/x64 cache collision)
```
Cache dir MUST be arch-scoped (`runtime-${MYC_ARCH}`) or an arm64 cache poisons an
Intel build.

### 3.2 `scripts/sign-macos.sh` — NEW (~80 LOC)
```bash
#!/usr/bin/env bash
set -euo pipefail
ID="$1"; APP="${2:-src-tauri/target/release/bundle/macos/Mycelium.app}"
ENT_APP="src-tauri/entitlements.plist"
ENT_CHILD="src-tauri/entitlements-child.plist"   # same 4 keys; for node/python3
# 1. collect every Mach-O (by magic, not just extension), sort deepest-first
find "$APP" -type f -print0 | while IFS= read -r -d '' f; do
  if file "$f" | grep -q 'Mach-O'; then printf '%s\t%s\n' "$(echo "$f"|awk -F/ '{print NF}')" "$f"; fi
done | sort -rn | cut -f2- > /tmp/machos.txt
# 2. sign leaves (libs) then interpreters with child entitlements
while IFS= read -r f; do
  case "$f" in
    */node|*/python3|*/caddy*|*/frpc*)
      codesign --force --timestamp --options runtime --entitlements "$ENT_CHILD" -s "$ID" "$f" ;;
    *) codesign --force --timestamp --options runtime -s "$ID" "$f" ;;
  esac
done < /tmp/machos.txt
# 3. seal the outer app LAST
codesign --force --timestamp --options runtime --entitlements "$ENT_APP" -s "$ID" "$APP"
# 4. verify
codesign --verify --deep --strict --verbose=2 "$APP"
```
- `entitlements-child.plist` = a copy of the existing 4-key
  [entitlements.plist](../src-tauri/entitlements.plist) (node needs JIT; python3
  needs library-validation-disabled to `dlopen` wheels). caddy/frpc are Go (no
  JIT) but the shared child plist is harmless.

### 3.3 `scripts/make-dmg.sh` — NEW (~25 LOC)
The `hdiutil` workaround from [BUILD-MAC.md:78-86](../src-tauri/BUILD-MAC.md)
(Tauri's `create-dmg` drives Finder via AppleScript → fails headless in CI). Stage
`.app` + `/Applications` symlink → `hdiutil create -format UDZO`.

### 3.4 `tauri.conf.json` (~2 lines)
- Keep `signingIdentity: "-"` (we sign post-build) — or drop it; do NOT add
  `APPLE_*` (keeps Tauri from auto-notarizing).
- Add `bundle.macOS.minimumSystemVersion: "13.0"` (onnxruntime universal2 floor).
- Keep `bundle.targets: ["app"]` for CI (we build the DMG ourselves); local devs
  can keep `dmg`.

### 3.5 `pipeline/requirements.txt` (~1 line)
`cryptography>=42` → `cryptography>=42,<45`.

### 3.6 `.github/workflows/desktop-release.yml` — NEW (~130 LOC, 2-job matrix)
| Runner | `MYC_ARCH` | Output |
|---|---|---|
| `macos-14` | arm64 | `Mycelium_<v>_aarch64.dmg` |
| `macos-13` | x86_64 | `Mycelium_<v>_x64.dmg` |
Each: import Developer-ID cert from `MACOS_CERT_P12_BASE64`+`MACOS_CERT_PW` into a
temp keychain → npm ci → fetch-sidecars → build-app-bundle (MYC_ARCH) → cargo tauri
build → sign-macos.sh → make-dmg.sh → sign dmg → notarytool (`APPLE_ID`+
`APPLE_APP_PW`+`APPLE_TEAM_ID`, or App Store Connect API key) → staple → upload to
the tag's Release. **Also the first CI that ever compiles `main.rs`** (closes the
gap noted [BUILD-MAC.md:7-11](../src-tauri/BUILD-MAC.md)).

### 3.7 Website Download button (separate, depends on Releases existing)
UA + arch detect (`navigator.userAgentData` / platform sniff) → link
`…/releases/latest/download/Mycelium_<v>_aarch64.dmg` (Apple Silicon) or `_x64.dmg`
(Intel), with an "All downloads" fallback. ~40 LOC in the marketing site (out of
this repo's scope; tracked).

**Total new/changed:** ~12 (bundle) + 80 (sign) + 25 (dmg) + 130 (CI) + 3 (config)
+ 1 (reqs) + new child plist (~12) ≈ **~260 LOC**, plus the website button.

---

## 4. Threat model

- **`disable-library-validation` weakens dylib-origin enforcement.** Accepted: it's
  unavoidable for a bundled Python ecosystem (`dlopen` of 270 wheel `.so`).
  Mitigated by — (a) we sign **all** 310 nested Mach-O with **our** Developer ID,
  (b) the notarized `.app` is **sealed** (outer codesign last) so swapping any
  `.dylib` breaks the seal + staple, (c) release-build sidecar resolution refuses
  PATH ([main.rs:107-111](../src-tauri/src/main.rs)).
- **`allow-jit` + `allow-unsigned-executable-memory`** are required for V8 (Node)
  and standard for Electron/Node apps; they widen RWX-memory surface in the
  *already-trusted* bundled Node. Accepted.
- **New attack surface vs today:** none at runtime — the app already spawns these
  processes. Signing/notarization strictly *raises* the integrity floor (sealed,
  Apple-stapled) over today's ad-hoc bundle.
- **CI secrets:** Developer-ID `.p12` + notarization creds live only in GitHub
  Actions secrets, imported into an ephemeral keychain per run, never in the repo
  or the artifact. The `.p12` password and app-specific password are distinct
  secrets. No vault keys are involved in the build (the build never opens a vault).
- **Supply chain:** sidecars stay SHA-256-pinned ([fetch-sidecars.sh](../scripts/fetch-sidecars.sh));
  pin the new x86_64 caddy/frpc hashes before the first Intel release ships.

---

## 5. Edge cases — explicit decisions

| Case | Decision |
|---|---|
| Universal2 vs two DMGs | **Two DMGs** (§2) — per-arch nested Mach-O make universal impractical + 2× size. |
| `cargo tauri build` re-signs main binary after our pass? | No — we sign **after** `cargo tauri build`; our outer seal is last. Tauri gets no `APPLE_*`, so no notarize race. |
| `externalBin` ordering bug (#11992) | Sidestepped — we sign caddy/frpc ourselves in the same inside-out pass, not via Tauri identity. |
| `install_name_tool` path fixups needed? | **Verify, don't assume** — python-build-standalone + pip wheels use `@loader_path`/`@rpath` (relocatable by design); the GStreamer guide needed fixups for a *different* layout. Gate: `otool -L` on `node`, `python3`, and one wheel `.dylib` must show no absolute build paths. If any do → add an `install_name_tool` step to sign-macos.sh before signing. |
| arm64 `.build-cache` reused for Intel build | Prevented — cache dir is `runtime-${MYC_ARCH}` (§3.1). |
| Min OS version | `13.0` (onnxruntime universal2 floor) — set `minimumSystemVersion`; surface on the download page. |
| kokoro/transcribe Python services opt-in | Their `.so` are still in the bundle (signed); they just aren't spawned unless enabled. No signing difference. |
| DMG vs zip for notarization | Notarize the **DMG** (one artifact, staplable, is the download). |
| Gatekeeper first-run | After staple, `spctl -a` accepts → **no right-click→Open** (the current ad-hoc caveat, [BUILD-MAC.md:92](../src-tauri/BUILD-MAC.md), goes away). |

---

## 6. Test / verification strategy (spike gates — prove before building on)

Per CLAUDE.md design-rigor: each gate is a **running** spike, recorded GO/NO-GO.

1. **G1 — Intel bundle builds + runs (de-risk arch).** On a `macos-13` runner (or
   Rosetta-Intel locally): `npm ci` → `MYC_ARCH=x86_64 build-app-bundle.sh` → clean-env
   smoke from [BUILD-MAC.md:127-137](../src-tauri/BUILD-MAC.md): `:8787` bundled Node +
   `:8091` bundled Python + offline model both 200, on Intel. Asserts the wheel pins
   resolve with **no source build**.
2. **G2 — relocation (otool).** `otool -L` on `node`, `python/bin/python3`, and
   `libonnxruntime…dylib` → no absolute repo/build paths (only `@loader_path`/`@rpath`/
   system). Decides whether sign-macos.sh needs an `install_name_tool` step.
3. **G3 — notarization ACCEPTED (proves PIVOT 1).** Sign one arm64 bundle with
   `sign-macos.sh` → `notarytool submit --wait` returns **Accepted** with **zero**
   "binary is not signed / does not have a secure timestamp" issues across all 310
   Mach-O. This is the single gate that proves the inside-out pass is complete. If
   it lists unsigned files → the Mach-O enumeration missed them (widen the `file`
   match) and re-run.
4. **G4 — clean-Mac Gatekeeper.** On a Mac that never saw the source: open the
   stapled DMG, drag to /Applications, launch → no Gatekeeper prompt; `spctl -a
   -vvv Mycelium.app` = `accepted … source=Notarized Developer ID`. Import → embed
   → Generate → mindscape works; relaunch persists the vault.

**Existing gates that must stay green:** `npm run verify` (132 gates) unaffected
(no product code changes); `verify:app-csp` (the bundle still serves CSP).

---

## 7. Implementation order (each step independently shippable + smoke)

1. **Arch-parameterize `build-app-bundle.sh` + cap cryptography.** Smoke: arm64
   bundle still builds + clean-env smoke passes (regression). *No behavior change
   on arm64.*
2. **Intel build path** (run G1). Smoke: Intel bundle clean-env smoke GO.
3. **`scripts/sign-macos.sh` + `entitlements-child.plist`** (run G2, G3). Smoke:
   notarytool **Accepted** on an arm64 bundle.
4. **`scripts/make-dmg.sh`** + sign + staple. Smoke: G4 on arm64 DMG (clean Mac).
5. **`desktop-release.yml`** 2-job matrix + secrets. Smoke: tag a pre-release →
   both DMGs land on the Release, both pass G4.
6. **Website Download button** (OS+arch detect). Smoke: each platform link
   resolves to the right asset.

Steps 1–4 are local/Mac; 5 is CI; 6 is the marketing site. Ship 1–4 before wiring
CI so the pipeline is proven by hand first.

---

## 8. Decision criteria to call macOS distribution DONE (falsifiable)

- Both `Mycelium_<v>_aarch64.dmg` and `_x64.dmg` exist on a GitHub Release built
  **entirely by CI** (no local hand-signing).
- `spctl -a -vvv` = `accepted, source=Notarized Developer ID` on **both** arches,
  each tested on a clean Mac of that arch.
- Clean-Mac launch → import → Generate → mindscape, then relaunch persists vault,
  on both arches.
- The website button serves the correct DMG per arch.

---

## 9. Operator decisions / inputs needed

| # | Item | Needed for |
|---|---|---|
| O1 | **Developer ID Application** cert exported as `.p12` (base64) + password → GH secrets `MACOS_CERT_P12_BASE64`, `MACOS_CERT_PW` | signing |
| O2 | Notarization creds: `APPLE_ID` + app-specific password + `APPLE_TEAM_ID` (or App Store Connect API key `.p8` + issuer + key-id) → GH secrets | notarize |
| O3 | Confirm **two DMGs** (recommended) vs Universal2 | bundle shape |
| O4 | Min macOS **13.0** acceptable (onnxruntime floor)? | deployment target |
| O5 | Release host = **GitHub Releases** (recommended; updater-friendly) | distribution |

---

## 10. Open questions resolved during sweep

- *"Is setting `signingIdentity` enough?"* — **No** (PIVOT 1). Tauri won't sign 300
  nested resources; custom inside-out pass required.
- *"Will Intel need source builds for cryptography/onnxruntime?"* — **No** (PIVOT
  2). Pinned versions have universal2/x86_64 wheels (verified on PyPI).
- *"Does `node_modules` cross-compile?"* — **No.** Host-arch `.node`; must `npm ci`
  on the Intel runner.
- *"Are entitlements missing?"* — **No.** All four present already; just apply the
  same set to the child `node`/`python3` execs.
- *"Does Tauri's DMG step work in CI?"* — **No** (Finder/AppleScript) → use
  `hdiutil` (already documented).

## 11. Open questions deferred (out of scope)

- Auto-update (Tauri updater + signed manifest) — and the 1 GB full-bundle vs
  split-update problem — tracked in the parent plan §4/§8.
- Linux + Windows targets — parent plan Phases 2–3.
- `install_name_tool` step — only if G2 shows absolute paths (don't pre-build it).
- Network entitlement narrowing (`network.client`/`server` scoping) — advisory,
  post-MVP (Sweep B).

---

## 12. Verification table

| # | Load-bearing assumption | Verified at (read myself) |
|---|---|---|
| 1 | Bundle carries ~300 nested Mach-O Tauri won't sign | Sweep A inventory + [build-app-bundle.sh:135-152](../scripts/build-app-bundle.sh); count cross-checked |
| 2 | Tauri signs only main+frameworks+externalBin, not nested resources | [tauri#8075](https://github.com/tauri-apps/tauri/issues/8075), [#12001](https://github.com/orgs/tauri-apps/discussions/12001) (Sweep D) |
| 3 | Inside-out sign + outer seal last + notarytool/staple is the correct pipeline | Apple codesign(1) / "deep considered harmful" + Tauri signing doc (Sweep D) |
| 4 | Entitlements already complete (4 hardened-runtime keys) | [entitlements.plist:18-25](../src-tauri/entitlements.plist) (read) |
| 5 | Child execs (node/python3) are separate signing contexts spawned at named lines | [main.rs:251,319,374,401](../src-tauri/src/main.rs); `embed/supervisor.js:104` (Sweep B) |
| 6 | Arch hardcoding is exactly 3 lines in build-app-bundle.sh | [build-app-bundle.sh:28-31,67](../scripts/build-app-bundle.sh) (read) |
| 7 | fetch-sidecars.sh already maps x86_64-apple-darwin | [fetch-sidecars.sh:41-47](../scripts/fetch-sidecars.sh) (read) |
| 8 | node_modules is host-arch, no rebuild → npm ci on Intel runner | [build-app-bundle.sh:141](../scripts/build-app-bundle.sh) (read); `better-sqlite3-multiple-ciphers` [package.json:219] |
| 9 | onnxruntime 1.20.1 has universal2 (Intel) wheel | PyPI JSON checked myself: `onnxruntime-1.20.1-cp312-…-macosx_13_0_universal2.whl` |
| 10 | numpy 2.1.3 + tokenizers 0.21.0 have x86_64 mac wheels | PyPI JSON checked myself (`macosx_10_13_x86_64`, `macosx_10_12_x86_64`) |
| 11 | cryptography needs cap <45 for Intel; 44.0.1 has universal2 | PyPI JSON checked myself (49→arm64-only; 44.0.1→`macosx_10_9_universal2`) |
| 12 | python-build-standalone tag 20260510 has x86_64-apple-darwin | Sweep C WebFetch of the release assets |
| 13 | xattrs already stripped pre-sign | [build-app-bundle.sh:154-160](../scripts/build-app-bundle.sh) (read) |
| 14 | macOS 13 GH runner = Intel, 14 = arm64 (CI matrix viable) | GitHub-hosted runner images (Sweep D / known) — **confirm in CI on first run** |
