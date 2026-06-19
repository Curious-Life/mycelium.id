# Session handoff — launch fixes + onboarding design (2026-06-08)

## TL;DR
Worked the launch-readiness backlog from real test feedback. **Four PRs merged to `main`**, a full launch-feedback root-cause sweep, the Chat/Connect-AI design, a clustering-skew investigation, and the **locked onboarding v2 design**. Next session: **build onboarding v2** (the flow shell + Steps 1–4, which includes Connect-AI Phase 2), then the clustering rebalance.

## Shipped this session (all on `origin/main`, verified)
| PR | Title | Verify |
|---|---|---|
| **#124** | `fix(channels)` Telegram/Discord agent replies reliably deliver (forced reply-tool on Ollama `tool_choice`) | `verify:channel-agent` OL5-8 + real Ollama 2/2 |
| **#125** | `feat(mycelium)` embed→generate auto-continue + "chronicle pending" placeholder | `verify:generate` G6 truth-table |
| **#126** | `fix(embed)` chunk long content (512→full, Nomic supports 8192) instead of truncating | real Nomic: cos 0.88, short-text parity |
| **#127** | `feat(chat)` no silent model fallback + show active provider/model + kill false "load history" | `verify:chat` C2/C8 |
| (also #123, earlier) | `feat(channels)` bundle + supervise the channel daemon (it never ran in the packaged app) | `verify:channel-supervisor` 18/18 + packaged smoke |

`origin/main` HEAD ≈ `1c514be` (Merge #127). Each PR auto-merged on green via the watch-and-merge gate.

## Key docs written (on main or pushed branches)
- `docs/LAUNCH-FEEDBACK-SWEEP-2026-06-08.md` — **master tracker**: 30 test-feedback points → 9 swept areas with file:line root causes, owners, fix scope, + the full **onboarding pages/functions inventory**. Includes operator corrections (token-limit IS real; chat no-fallback; folders inline; dedicated Connect-AI page).
- `docs/CHANNEL-DAEMON-RELIABILITY-DESIGN-2026-06-08.md` — channel daemon bundling/supervision (as-built).
- `docs/CHAT-CONNECT-AI-DESIGN-2026-06-08.md` — chat reliability (Phase 1 = done #127) + Connect-AI page (Phase 2 = TODO).
- `docs/ONBOARDING-V2-DESIGN-2026-06-08.md` — **locked onboarding plan** (this handoff's main pickup).

## Pickup protocol — NEXT
**Build onboarding v2** (`docs/ONBOARDING-V2-DESIGN-2026-06-08.md`), branch `feat/onboarding-v2` (worktree `~/Documents/GitHub/mycelium-worktrees/onboarding`, off `1c514be`):
1. **OnboardingFlow controller** — collapse the 3 overlapping surfaces (`WelcomeModal` + `OnboardingGuide` + empty-mindscape `ConnectionsChecklist`) into one linear flow; honor `onboarding_dismissed_at` (`portal-compat.js:701`).
2. **Step 1** state-aware Create/Unlock/Restore (`/account/status` → needsSetup/locked/open) + recovery-key **confirm-gate**; remove "Add to Keychain". ⚠️ recovery key only decrypts LOCAL data — be honest (verified `account/router.js:75-99`); vault backup is **deferred** (task `task_fda61874`).
3. **Step 2** single Welcome + the **mycelium.id 3D Goethe model** background (asset needed).
4. **Step 3** upload-first + **"See your mind"** preview card (needs a `/import/preview` summary: counts/date-range/people/sources). Operator was firm: NOT "we see you".
5. **Step 4 = Connect-AI Phase 2**: new `ai` settings tab (move `IntelligenceSection` + how-to/recipe panels), Ollama auto-detect (`/hardware/recommend` → `ollamaUp`) → 1-tap confirm (model visible), **auto-activate first provider** (`portal-providers.js` POST), de-dup the onboarding/checklist AI steps. Never say "harness".
6. **Step 5** wire the auto crescendo + **gate the reveal on cluster quality**.

**Then: clustering skew** (operator: after onboarding works to that point). Investigated — root cause `cluster.py:822-853` (`centroids_to_groups`: Ward HAC + `fcluster maxclust`, variance-not-size-aware, no rebalance, realms clamped 5-10). Fix: size-aware oversized-realm split + skew metric (Gini/max-share); validate on a synthetic dominant-mode dataset (max-share 0.5+ → <0.30); re-run via `run-clustering.sh` step 2 (idempotent, Jaccard-stable).

**Still pending operator decisions:** Stripe price/timing (unblocks #12 Stripe full flow — code-ready: `/billing/return` + entitlement polling).

## ⚠️ Environment gotchas (READ before rebuilding/merging)
- **Local `main` diverged from `origin/main`.** The launch-feedback doc was committed to local main while PRs merged on origin; subsequent PR branches were rebased onto `origin/main` to carry it forward. **Before any local rebuild: `git fetch && git reset --hard origin/main` (or pull)** in the main checkout, or you'll rebuild a stale tree missing the 4 fixes.
- **Concurrent sessions churned the shared main checkout** (`~/Documents/GitHub/mycelium.id`): a foreign `node src/server-rest.js` dev server held `:8787`, the installed `/Applications/Mycelium.app` got deleted mid-session by another rebuild, and a stale `:8091` embed service (old code) shadowed `verify:embed` locally (false cos=1.0). Verify on free ports / clean state.
- **Worktrees:** `mycelium-worktrees/{channels-reliable,telegram-reply,pipeline-autocontinue,embed-chunking,chat-connect-ai,onboarding}` — each symlinks the main repo's `node_modules`. Clean up merged ones (`git worktree remove`).
- **Build:** `cargo tauri build` from repo root needs `bash scripts/fetch-sidecars.sh` first; the DMG step fails headless (the `.app` is fine); `build-app-bundle.sh` now strips xattrs + bundles `packages/` + checks deps completeness.
- **`@better-auth/passkey`** was declared but uninstalled (latent remote-mode boot crash) — `npm install` fixed it locally; the bundle deps-check now guards it.
- **Discipline that held all session:** sweep-first-design (parallel Explore agents → design doc w/ verification table) → implement → `verify:*` gate green → PR → watch-and-merge on green. Keep it.
