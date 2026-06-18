# Handoff — Pre-release feedback fixes (2026-06-18)

Read this first. Written for a fresh/compacted session continuing the public-release polish.

## TL;DR
We are preparing **mycelium.id** for public release. A tester filed **12 issues**
(6 install/build, 6 runtime/UX). This branch (`fix/prerelease-feedback`, off
`origin/main` @ `3aa434a`) is for the **8 still-unfixed items**. The task:
**thorough sweep → design doc → implement → verify → PR**. "Everything needs to
be perfect."

## The 12 feedback items — audited status (against mycelium.id, WIP-aware)

✅ **Already fixed** — do NOT redo:
- **#5 legacy-peer-deps** — on main: `.npmrc` (`legacy-peer-deps=true`) + README.
- **#8 SvelteKit portal not built by default** — **PR #259** (`prestart` auto-build + `npm run build:app`).
- **#10 CSP inline onclick** — **PR #259**: the offender was the old `portal/index.html` (deleted); SvelteKit `onclick={}` compiles to `addEventListener` (CSP-safe).
- **#12 Tauri frontendDist → legacy** — **PR #259** (`frontendDist: "../portal-app/build"` + `beforeDevCommand`).

❌ **NOT fixed — THIS BRANCH'S WORK:**
| # | Item | Finding (file evidence) |
|---|---|---|
| 1 | conda PATH troubleshooting | not in README/SETUP (only design docs). better-sqlite3-multiple-ciphers fails to build when conda is active (libtool collision). |
| 2 | `.nvmrc` pin | **no `.nvmrc`**; only `engines.node>=22` (doesn't stop Node 23 silently breaking prebuilds). |
| 3 | verify count + `verify:core` | README says **"13 verify scripts"**, actual **189**; no `verify:core` shortcut. |
| 4 | Python documented | `docs/SETUP.md` covers it; **README only lists `pipeline/` in the dir tree** — thin. |
| 6 | hono vuln | `hono` is **transitive** (via `@hono/node-server`, requires `hono ^4`), not a direct dep. Run `npm audit --omit=dev` to confirm 0 vulns; if a transitive advisory exists, pin via `overrides`. (audit not yet run — user declined a sandboxed run mid-session.) |
| 7 | `Cannot GET /` on :4711 | `src/server-http.js` has no root handler; the only catch-all (`~line 125`) is a sign-up security gate. `/` falls to Express default. Add a friendly minimal root response (e.g. "Mycelium MCP endpoint" + link), without leaking routes. |
| 9 | `remote.json` crash (no scheme) | no URL-scheme validation found. `src/index.js:93` reads `readRemoteConfig().publicHost`; `src-tauri/src/main.rs:343` blindly `format!("https://{public_host}")`. A `publicHost`/baseURL lacking/with a wrong scheme can crash or double-prefix. NEEDS: validate + normalize the scheme, fail soft. **SWEEP the exact crash path first** (find every `new URL(...)`/scheme assumption on remote.json values across src/ + main.rs). |
| 11 | WebGL fallback | `portal-app/src/lib/components/mindscape/Mindscape3D.svelte:31` uses `THREE.WebGLRenderer` with **no availability check / graceful degradation**. Add a WebGL-capability guard → show a friendly fallback (static image / message) instead of a hard crash. Also `MindscapeBackground.svelte` (WebGL). |

⚠️ Notes: #4 is partial (SETUP good, README thin). #6 needs the audit run.

**Meta-finding:** #1/#2/#3/#6 were marked "Fix: done" by the tester but are **absent
in mycelium.id** — almost certainly done in the *canonical* `Curious-Life/mycelium`
repo and never ported to this V1 codebase. So they're new work here, not regressions.

## How to do it (the user's explicit ask)
1. **Sweep first** (`/sweep-first-design`): especially #9 (the remote.json crash
   path — find every scheme assumption) and #7 (what the :4711 server should
   safely return at `/`). #11 needs a sweep of how the mindscape mounts WebGL.
2. **Design doc** `docs/DESIGN-prerelease-feedback-2026-06-18.md` with a
   verification table, then implement.
3. **Verify** each with the relevant `verify:*` gate(s) and `npm run verify` where
   touched. #7 → a server-http smoke; #9 → boot with a malformed remote.json;
   #11 → portal-app build + a WebGL-absent check.
4. Split: quick doc/config (#1 README troubleshooting, #2 `.nvmrc`, #3 README
   count + `verify:core` shortcut, #4 README python) vs code (#6 audit/overrides,
   #7 root handler, #9 remote.json validation, #11 WebGL fallback).

## Broader release state (context, NOT this branch's job)
- **macOS signed distribution:** arm64 **notarized DMG PROVEN** (CI run
  27759199347). 5 CI env-gaps fixed (locale `${STAGE}`, rsync 2.6.9 mkdir, BSD
  `sed -z`, DMG codesign for spctl) — landed via **#257 (merged)** + tag `v0.1.0`.
  **BLOCKED:** GitHub **Actions minutes/spending cap** → all new jobs fail at
  0 steps. **Operator must raise the org spending limit** to finish the 2-arch
  release. 6 GH secrets set + notarytool validated (Developer ID
  `Martins Balodis (C5TSZBNYB6)`; `.p12` in `~/mycelium-signing/`).
- **At-rest encryption:** ON by default in the packaged app (#233 merged).
  **🔴 PR #256 is CRITICAL** — "main currently corrupts vaults on encrypt"
  (migration race); review/merge before any release. #253/#237 = plaintext-backup
  purge (duplicates; consolidate). #259 = the fresh-install/portal fix (5 commits,
  gates GO, ready to merge).
- **Distribution channel:** decided = Cloudflare R2 + `downloads.mycelium.id`;
  website = `Curious-Life/mycelium.id-site` (static Pages; the "Mac app" `.dl-card`
  currently points at the PRIVATE GH releases page — repoint to R2 after the DMG ships).

## Gotchas (bit us this session)
- **Contested `main` tree** — other sessions clobber it. ALWAYS work in a worktree;
  commit+push early. (See memory `concurrent-session-collision`.)
- **Disk full** — Data volume ~92% (repo in iCloud-synced `~/Documents`); `ENOSPC`
  killed a portal build + the DMG download. Free space / move repo to `~/Developer`.
- **`verify` CI flaking** — jobs dying at **0 steps** (GitHub runner-startup, likely
  tied to the minutes cap). `main` is **unprotected** (no required checks), so a
  gate-proven change can be admin-merged when verify infra-flakes.
- macOS tools: no `timeout`/`tac`/`gtimeout`; `sed -z`/`sort -z` are GNU-only
  (BSD lacks them); old rsync 2.6.9 on CI won't mkdir nested dirs.
- `node_modules` for gate runs in a fresh worktree: symlink the main tree's
  (`ln -s /…/mycelium.id/node_modules node_modules`); remove before committing.

## Pointers
- Design docs: `DESIGN-macos-signed-distribution-2026-06-17.md`,
  `DESIGN-fresh-install-build-2026-06-18.md`, `DESIGN-cross-platform-distribution-2026-06-17.md`.
- Memory: `macos-signed-distribution-design`, `portal-fresh-install-old-ui`.
- Branch: `fix/prerelease-feedback` (this); related: `fix/single-portal-ui` (#259).
