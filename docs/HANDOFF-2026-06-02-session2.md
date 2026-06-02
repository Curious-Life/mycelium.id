# Handoff — 2026-06-02 (session 2: provisioning, self-contained app, generate-UX, webview freeze)

Fresh session can pick up here. Four PRs landed on **main**; one **blocking open issue** remains
(the packaged app's webview freezes). The Generate fix itself is **verified working in a browser**.

## Landed on `main` this session
- **#44** — fresh-user provisioning: `pipeline/setup.sh` now installs clustering deps; `run-clustering.sh`
  has a fast actionable deps-probe. (`docs/DESIGN-fresh-user-provisioning-2026-06-02.md`)
- **#47** — self-contained packaged app (Tier B): `cargo tauri build` produces a **1.2 GB `Mycelium.app`**
  bundling Node + a relocatable Python + all wheels + the offline Nomic model. Verified clean-env: bundled
  node serves :8787, bundled python loads the offline model + embeds. (`docs/DESIGN-packaged-app-distribution-2026-06-02.md`,
  `scripts/build-app-bundle.sh`, `src-tauri/BUILD-MAC.md`)
- **#48** — Generate-UX fix: one shared store `portal-app/src/lib/generate.ts` handling the REAL contract
  (409 → "processing N/M" + AUTO-START when embedding done; real errors surfaced; server `totalSteps`;
  elapsed + **ETA** seeded by last-run duration via `src/generate-stats.js` + `jobs.js priorDurationMs`).
  (`docs/DESIGN-generate-ux-2026-06-02.md`)
- (#41 MCP overview merged from elsewhere.)

## ✅ Generate fix is VERIFIED (in a browser)
Via the Claude_Preview MCP pointed at the running server, clicking **Generate** rendered:
`Growing your mindscape… Starting… — step 0 of 5` + progress bar + **`3s elapsed · ~4s left`**.
So "Failed to start generation" (the unhandled 409) is fixed, and live progress + ETA work. **The portal
logic is correct.**

## 🔴 OPEN #1 — Tauri WKWebView FREEZES (the blocker)
- Symptom: the packaged app's **window freezes** ("stuck loading" / "froze again"). The app process tree then
  dies (no `~/Library/Logs/DiagnosticReports/Mycelium*.ips` crash report → the user closed the frozen window;
  `main.rs` Destroyed → kills children → :8787/:8091 go down).
- **Decisive**: the identical portal works in **Chrome** (Generate + progress + ETA all render). So it is
  **WKWebView-specific, NOT the app logic.**
- **Leading hypothesis: the mindscape "3D Map" view / THREE.js.** The mindscape page defaults to 3D Map and
  renders a `welcome-canvas` THREE.js demo background (`Mindscape3D` lazy-loaded). WebGL/THREE in a
  **transparent + NSVisualEffect vibrancy** WKWebView (`main.rs`: `.transparent(true)` + `apply_vibrancy`)
  is a known hang/crash source.
- **Investigate next:**
  1. Enable webview devtools (Tauri) / attach Safari Web Inspector to the WKWebView to see the hang.
  2. Test: does only the mindscape page freeze? Load `/setup`, `/import`, etc. — if those are fine and only
     mindscape freezes → confirms 3D.
  3. Mitigations to try: default mindscape to the **Territories (2D)** view; gate/skip the THREE.js demo
     canvas + 3D when running under Tauri (the portal already detects Tauri / sets `glass-os`); or test a
     **non-transparent** window to rule out the transparent+WebGL interaction.

## 🟠 OPEN #2 — env-key leak / precedence bug
- When launched **from a terminal**, the bundled node server reads `USER_MASTER`/`SYSTEM_KEY` from
  `process.env` (logs: `Reading master key from process.env (insecure)… source=env-deprecated hash=…`),
  inheriting them from the dev shell (or a loaded `.env`), and opens an **old 132-message vault** instead of
  the clean first-run. Unsetting them at launch (`env -u USER_MASTER -u SYSTEM_KEY …`) did NOT fully stop it
  (hash changed each launch: f516dcf4 → ae691af7) → suspect a `.env` is loaded by `src/index.js` boot.
- A **normal Finder double-click** (launchd, no shell env) would NOT have these → keychain is used. So this is
  largely a **test-harness artifact** — BUT the boot path **prefers `process.env` over
  `MYCELIUM_KEY_SOURCE=keychain`**, which is a real precedence bug. Fix: when `MYCELIUM_KEY_SOURCE=keychain`,
  do NOT let env keys override. Grep `src/` for the `env-deprecated` / dotenv loading.

## 🟠 OPEN #3 — locked REAL vault (from earlier today)
- The user's real **81 MB vault** is preserved at
  `~/Library/Application Support/id.mycelium.app.lockedrealvault-bak-20260602-182820`. Its keys were
  **overwritten during #36 account-setup testing** → not unlockable with current keychain keys. Recoverable
  ONLY if the user's original **recovery key** surfaces (1Password / a saved `mycelium-recovery-key.txt`).
  **DO NOT delete this backup.** (Root cause → OPEN #4.)

## 🟡 OPEN #4 — account-setup overwrite guard
- Account-setup silently overwrote existing Keychain keys (caused OPEN #3). Add a **warn-before-overwrite**
  guard to `src/account/*` setup.

## Machine state RIGHT NOW
- `Mycelium.app` at `src-tauri/target/release/bundle/macos/Mycelium.app` (rebuilt with #48; 1.2 GB).
  **NOT running** (it died on the freeze).
- **No active `app_data` vault** (deleted). On relaunch: terminal → env-leak old vault; double-click → keychain.
- **CLEANUP NEEDED**: a Claude_Preview MCP "server" (a `sleep` dummy) + stray `.claude/launch.json` at BOTH
  `/Users/altus/Documents/.claude/launch.json` and `~/mycelium.id/.claude/launch.json` (the latter is in the
  repo — delete so it isn't committed). Orphaned keychain test entries accumulating: `mycelium-firsttest-*`,
  `mycelium-freshtest-*`, `mycelium-fresh3-*` (harmless; can be cleaned).
- Repo on `main` @ `953ee55`, synced. Working tree: only untracked build artifacts
  (`src-tauri/icons/*`, `src-tauri/Cargo.lock`, `build-staging/`, `.build-cache/` — last two gitignored).

## Test the Generate fix WITHOUT the frozen webview
Relaunch the app (or run the node server) and open **http://127.0.0.1:8787 in a normal browser** → Generate
works end-to-end (progress + ETA). This is also the immediate user workaround until the WKWebView freeze is fixed.

## Run / build / verify
```bash
cd ~/mycelium.id && export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
MYCELIUM_KEY_SOURCE=keychain npm run verify            # 30 GO
npm --prefix portal-app run build                      # rebuild portal
cargo tauri build                                      # rebuild .app (DMG step fails harmlessly; .app is the deliverable)
# Clean relaunch (terminal): env -u USER_MASTER -u SYSTEM_KEY -u MYCELIUM_HOME MYCELIUM_KC_ACCOUNT=… MYCELIUM_KEY_SOURCE=keychain <app-binary>
```

## Follow-up priority
1. **WKWebView freeze** (OPEN #1) — unblocks the packaged app. Start with the 3D-view hypothesis.
2. **env-key precedence** (OPEN #2) + **account-setup overwrite guard** (OPEN #4).
3. DMG fix + commit `src-tauri/icons/*` + `Cargo.lock` for clean-clone builds.
4. Real-vault recovery if the key surfaces (OPEN #3).
5. Phase 2: Developer-ID notarization, Intel/Windows/Linux.
