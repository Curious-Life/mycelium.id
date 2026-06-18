# Design — fresh-clone → working app: one-command build + prereq checks (2026-06-18)

> **Status: BUILDING.** Sweep-first design (3 parallel sweeps) for the "a friend
> cloned the repo and it didn't work" class of bugs. Two distinct failures:
> (1) a fresh clone served the **old UI** (the portal split — being fixed on
> `fix/single-portal-ui` / PR #259), and (2) building the **Tauri app** is a 6+
> step manual gauntlet that **fails cryptically without Rust** (the tester's
> case). This doc covers (2) + the coherence cleanup, landing on the same branch.

## Sweep findings (consolidated, file:line)

1. **No build orchestrator.** Building the app = `cargo install tauri-cli` →
   `npm run portal:build` → `bash scripts/fetch-sidecars.sh` → `cargo tauri
   build`, documented across README (server-only quickstart), `docs/SETUP.md`,
   and `src-tauri/BUILD-MAC.md` — no single command. (Sweep A)
2. **Rust is an unchecked hard dependency.** `cargo tauri build` with no Rust →
   `cargo: command not found` (exit 127), no guidance.
   `scripts/fetch-sidecars.sh:16` → `TRIPLE="$(rustc -Vv | awk …)"` dies with
   `rustc: command not found`. No script checks `rustc`/`cargo`/`cargo-tauri`/
   Xcode-CLT and prints an install hint; only `shasum` has a fallback. (Sweep B)
3. **`build-app-bundle.sh`** assumes `node`/`npm`/`curl`/`rsync` on PATH — each
   fails bash-127 if absent; the one helpful preflight (node_modules
   completeness) runs *after* npm is already invoked. (Sweep B)
4. **`frontendDist: "../portal"`** (tauri.conf.json:7) names the legacy/placeholder
   dir. The window actually loads `http://127.0.0.1:8787` (main.rs ~:447), so
   frontendDist is unused at runtime — but it's semantically wrong and a
   server-crash fallback would show the old UI. (Sweep C)
5. **Doc drift:** `docs/ONBOARDING-LIGHTMODE-GLASS-2026-06-09.md` calls
   `portal-app/build` "old" (it's the canonical UI). (Sweep C)
6. **PR #259 (single-UI) not yet merged** — the old UI is still live on main
   until it lands. (Sweep C)

## Decisions

- **Normal users install the DMG** (no Rust, no building) — that's the primary
  path once the notarized DMG ships. The build orchestrator is for
  **contributors / source installs** (the tester's path).
- **Auto-install policy:** the orchestrator may install the lightweight,
  well-known toolchain (`cargo-tauri` via `cargo install`) automatically, and
  **offers** (prompt; `--yes`/CI auto-confirms) to install **Rust via rustup**.
  It NEVER silently installs system packages (Xcode CLT, Node) — those it
  detects and prints the exact command. Fail-closed: missing + not installable →
  clear error + exit.
- **Idempotent:** skip any step already satisfied (portal built, sidecars
  present, tauri-cli installed).

## Module shape

### `scripts/preflight.sh` — NEW (~40 LOC, sourced)
A `check_tools` helper + per-tool install hints. Sourced by `build-app.sh`,
`fetch-sidecars.sh`, and `build-app-bundle.sh` so a missing tool ALWAYS yields:
`[mycelium] FATAL — <tool> not found. Install: <command>` instead of bash-127.
Tools: `node`/`npm` (→ "Node ≥22: https://nodejs.org or brew install node@22"),
`curl`, `rsync`, `rustc`/`cargo` (→ rustup one-liner), `cargo-tauri`
(→ `cargo install tauri-cli --version ^2.0`). macOS Xcode CLT via
`xcode-select -p`.

### `scripts/build-app.sh` — NEW (~90 LOC) + `npm run build:app`
One command for a fresh clone:
1. `preflight` for node/npm/curl/rsync (hard) + Xcode CLT (macOS).
2. Rust: if `cargo` missing → with a TTY, prompt to install rustup (or `--yes`);
   else print the rustup command + exit 1.
3. `cargo-tauri`: if missing → `cargo install tauri-cli --version '^2.0' --locked`.
4. `npm install` (root) if `node_modules` absent; portal builds via the
   existing `prestart`/ensure-portal path or an explicit `npm run portal:build`.
5. `bash scripts/fetch-sidecars.sh`.
6. `cargo tauri build` (or `--dev` flag → `cargo tauri dev`).
7. Print the resulting `.app`/`.dmg` path.

### `scripts/fetch-sidecars.sh` + `scripts/build-app-bundle.sh` — preflight guards
Source `preflight.sh`; call `check_tools` at the top (rustc for fetch-sidecars;
node/npm/curl/rsync for build-app-bundle) so standalone runs also fail helpfully.

### Single source of truth (revised — supersedes the earlier "leave it" call)
The operator's directive: the portal build must point at **the one place that
works and is actively used** (`portal-app/build`); clean up every divergence.
- `src-tauri/tauri.conf.json`: `frontendDist: "../portal"` → `"../portal-app/build"`.
  `beforeBuildCommand` already builds it before `cargo tauri build` validates;
  added **`beforeDevCommand: "node scripts/ensure-portal-built.mjs"`** so raw
  `cargo tauri dev` also builds it first (frontendDist must exist for dev).
- **Deleted the `portal/` directory entirely.** The "not built" placeholder is
  now `PLACEHOLDER_HTML` inlined in `server-rest.js` (code, not a 2nd on-disk
  UI). `resolvePortal` returns `{ built, spaFallback }`; the server serves
  `portal-app/build` when built, else the inline placeholder (+ favicon from
  `portal-app/static`). The ~25 `portalMode:'legacy'` gates now get the inline
  placeholder — they test API/routes, not UI content.
- **Security preserved:** `isPortalNav` rejects data paths after collapsing
  duplicate slashes, so `//api/…` can't be answered with a 200 HTML shell that
  masks the auth gate (verify:portal-auth case I — caught + fixed in review).

### Docs
- `src-tauri/BUILD-MAC.md` + `README.md` + `docs/SETUP.md`: lead with
  `npm run build:app` as the one-command source build; keep the manual steps as
  "what it does under the hood."
- Fix the "old `portal-app/build`" wording in the onboarding doc.

## Edge cases — decisions
| Case | Decision |
|---|---|
| Rust missing, no TTY (CI/script) | print rustup command + exit 1 (don't auto-install silently in CI) |
| Rust missing, TTY | prompt Y/n to run rustup; `--yes` auto-confirms |
| cargo-tauri missing | auto-install (`cargo install`, low-risk, expected) |
| Xcode CLT missing (macOS) | detect via `xcode-select -p`; print `xcode-select --install` + exit |
| Node missing | print install hint + exit (never auto-install Node) |
| portal already built / sidecars present / tauri-cli present | skip (idempotent) |
| `--dev` | run `cargo tauri dev` instead of `build` |
| Linux/Windows | preflight works; `cargo tauri build` per-OS (out of scope here — macOS first) |

## Test strategy
- `bash -n` all new/edited scripts.
- `preflight.sh`: simulate a missing tool (`PATH=/usr/bin` minus the tool) → asserts the FATAL + install-hint message + non-zero exit.
- `build-app.sh --help`/dry parse; confirm idempotent skips with already-present artifacts.
- `fetch-sidecars.sh` with `rustc` shadowed absent → asserts the helpful error (not bash-127).
- Full `cargo tauri build` is the operator/CI smoke (already green via desktop-release).

## Implementation order
1. `scripts/preflight.sh` + guard `fetch-sidecars.sh` & `build-app-bundle.sh`.
2. `scripts/build-app.sh` + `npm run build:app`.
3. `tauri.conf.json` frontendDist.
4. Doc consolidation.
5. (separately) merge PR #259 so the old UI is gone on main.

## Verification table
| Assumption | Verified at |
|---|---|
| No build orchestrator exists | Sweep A (package.json scripts; no Makefile) |
| Rust missing → cryptic 127, unchecked | Sweep B; fetch-sidecars.sh:16 (`rustc -Vv`) |
| build-app-bundle assumes node/npm/curl/rsync | Sweep B; build-app-bundle.sh:138,89,162 |
| Tauri window loads the server, not frontendDist | Sweep C; src-tauri/src/main.rs ~:447 |
| frontendDist points at legacy `../portal` | tauri.conf.json:7 (read) |
| PR #259 not yet merged (old UI live on main) | Sweep C (git log) |
| onboarding doc calls canonical UI "old" | Sweep C; docs/ONBOARDING-LIGHTMODE-GLASS-2026-06-09.md |
