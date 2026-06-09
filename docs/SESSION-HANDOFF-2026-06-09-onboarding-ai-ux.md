# Session handoff — onboarding + AI/Intelligence UX overhaul (2026-06-09)

## TL;DR
A long UX-polish session driven by live operator feedback on a throwaway vault. **3 PRs merged to `main`**, **1 PR open** (#133, AI & Intelligence page — pending the operator's design review + merge). The real app is running on `:8787` via `cargo tauri dev`. Pick up at: **operator reviews #133 on the real app → merge → then the AI-page follow-ups** (fold in the "harness"/external-client, retire the legacy "AI Subscriptions" Claude block, delete the orphaned `IntelligenceSection.svelte`).

## Merged to `main` this session (in order)
| PR | What | Verify |
|---|---|---|
| **#130** | `feat(account)` encrypted vault backup (`.myvault`) + restore-from-backup + silent-empty-vault footgun fix | `verify:backup` GO 25/25; `verify:account`/`passphrase-lock` GO |
| **#131** | `feat(onboarding)` first-impression pass: animated Welcome (ported site **hyphal hero animation** `mycelium-engine.ts`), in-window invitation wizard (Data·Intelligence·Connect inline), ported **3D point cloud** (`MindscapeBackground.svelte`), setup polish (device-aware copy, no "Save to Keychain", no backup-prompt), no first-paint flicker, distinct titles | `portal:check` 0 |
| **#132** | `feat(onboarding)` post-import: **auto-generate** (no manual click), **floating glassy activity chip** (`MindscapeActivityChip.svelte` — non-blocking progress top-right), **neuron-like** mindscape firing (replaced the synchronized pulse), **glassy realm sidebar** + **"Spawn intelligence"** prompt + "Area N" labels | `portal:check` 0 |

`origin/main` HEAD after #132 = `0e4ef4b`.

## OPEN — PR #133 (branch `feat/ai-settings-page`, rebased on main)
**`feat(settings): redesigned AI & Intelligence page + deep-linked Connect AI`** — commit `305ce73`.
- New **`portal-app/src/lib/components/settings/AISettings.svelte`**: active-model **hero** + **Local · private** (hardware-aware Ollama recommend / one-tap Pull&use) + **Cloud · your key** (preset cards → key) + Connected list + Smart-routing toggle. Glassy, matches onboarding. Reuses `/portal/providers` + `/portal/hardware` verbatim (zero backend change).
- SettingsView **Intelligence tab now leads with `<AISettings/>`** (dropped the duplicate `IntelligenceSection` mount); **`?tab=<id>` deep-links** a tab; realm "Spawn intelligence" + onboarding "Connect AI" → `/settings?tab=intelligence`.
- Design + full sweep: **`docs/AI-SETTINGS-PAGE-DESIGN-2026-06-09.md`** (verification table). `portal:check` 0 errors.
- **Status: held for operator design review on the real app, then merge** (operator asked to "design it well" → wants to eyeball it).

## Pickup protocol — NEXT
1. **Operator reviews #133** on `:8787` (Settings → Intelligence, or click "Spawn intelligence" in a realm). Tune hero/lanes/spacing/copy as asked → merge.
2. **AI-page follow-ups** (operator floated folding these into #133 or a follow-up): (a) fold the **external-client/"harness"** (`ConnectYourAISection` + `HarnessPickerSection`, currently in the `connection` tab) into the AI page; (b) **retire the legacy "AI Subscriptions"** Claude-OAuth block (ToS-refused) in the Intelligence tab; (c) **delete the now-orphaned `IntelligenceSection.svelte`** (no importers left — pre-deletion-caller-audit); (d) rename user-facing **"harness" → "your AI app"**.
3. **Clustering-skew rebalance** (`pipeline/cluster.py:822-853` `centroids_to_groups` — Ward HAC + `fcluster maxclust`, variance-not-size-aware → one realm balloons). Wires the Generate quality-gate. Operator: after onboarding works (it does now).
4. **Delete legacy onboarding components** unmounted in #131 (`WelcomeModal`, `OnboardingGuide`, `ConnectionsChecklist`) — verify no importers first.

**Parked on operator decision:** Stripe price/timing (#12 code-ready); relay go-live (`feat/relay-go-live` branch + plan).

## Environment / how to test (READ before rebuilding)
- **Real app**: `cargo tauri dev` from repo root (warm cache ~1-2s). Runs on the REAL vault (has data → no onboarding empty-state; the new AI page + realm sidebar ARE visible). Currently running (task in this session; relaunch if down). Quit a packaged `Mycelium.app` with `osascript -e 'tell application "Mycelium" to quit'`.
- **Throwaway vault** (to test the FULL onboarding empty-state flow) — fully isolated, never touches the real key/vault:
  ```
  MYCELIUM_DATA_DIR=/tmp/myc-throwaway-vault MYCELIUM_KC_ACCOUNT=mycelium-throwaway \
  MYCELIUM_KC_USER=throwaway-user-master MYCELIUM_KC_SYSTEM=throwaway-system-key \
  MYCELIUM_REST_PORT=8799 MYCELIUM_AUTO_OLLAMA=0 node src/server-rest.js
  ```
  Then `open http://127.0.0.1:8799`. Reset: stop it, `rm -rf /tmp/myc-throwaway-vault`, `security delete-generic-password -a mycelium-throwaway -s throwaway-user-master` (+ `-system-key`).
- **⚠️ Embedder conflict**: only ONE app instance can spawn the embed service on `:8091`. Running the real app AND the throwaway at once → the second's embedding fails ("Address already in use") and generation errors at `compute-cofire.js` (NOT a product bug). **Stop one instance** to test generation on the other.
- After editing portal source, the running `tauri dev` serves `portal-app/build` — **`npm --prefix portal-app run build`** then refresh the browser/window to see changes.
- `portal:check` shows **1 persistent WARNING** (`@types/node` not in the local worktree node_modules) — harmless; CI's `npm ci` resolves it. 0 errors is the bar.
- Untracked macOS Finder duplicate junk (`* 2.svelte`, etc.) litters the tree — harmless, not committed; clean up someday.

## Discipline held: sweep-first-design (parallel Explore sweeps → design doc w/ verification table) → build → `portal:check` 0 → PR → watch-and-merge on green. Each batch browser-validated on the throwaway before merge.
