# Launch-Prep Checklist — Mycelium V1 (self-hosted)

**Date:** 2026-06-08 · **Author:** launch-prep sweep (4 parallel audits + live fresh-install test)
**Status:** PRE-LAUNCH — core product verified; the gaps are **distribution, onboarding glue, operational config (Stripe), and legal/brand placeholders.**

> This is the **master** checklist. It consolidates and supersedes the scattered prior art:
> - `docs/PRE-LAUNCH-READINESS-2026-06-01.md` (P0–P2 readiness map — still valid; folded in here)
> - `docs/PRE-LAUNCH-CHECKLIST.md` (funding placeholders — folded in)
> - `docs/MAC-APP-RELEASE-RUNBOOK-2026-06-05.md` (signing/notarization runbook)
> - `docs/ONBOARDING-RELAY-BILLING-HANDOFF-2026-06-06.md` (Stripe/relay O1–O11 as-built)
> - `docs/TEST-local-session-HANDOFF-2026-06-06.md` (screen wiring map)

---

## TL;DR verdict

The **vault, crypto, MCP/REST transports, tools, search, portal core surfaces, and the Stripe billing *code*** are built and verified (120+ `verify:*` gates green in CI). What stands between today and "share with the public" is:

1. **Distribution UX** — the app is **ad-hoc signed, not notarized** → Gatekeeper warns on first open. (P0)
2. **Onboarding glue** — the OnboardingGuide calls **3 enrichment endpoints that don't exist** + **OAuth provider buttons that are stubs**. (P0)
3. **Stripe is code-complete but not *operationally connected*** — no live keys, no registered webhook, no post-purchase landing UX. (P0 for the paid managed tier; N/A for free self-host.)
4. **Remote relay is not end-to-end live** — V1 is local-only; `<handle>.mycelium.id` is "coming soon." (P0 if remote is in launch scope)
5. **Legal/brand placeholders** — `FUNDING.yml` + README Sponsors/Stripe links are literal `YOUR_…` placeholders; no PRIVACY/ToS. (P0 for a public repo)
6. **A TEMP debug log** in `server-http.js` (logs bearer-presence + session id + IP) must be removed pre-launch. (P0, security)

Decide launch scope first (**A: free self-host only** vs **B: + paid managed relay**) — it changes which P0s are blocking. The Stripe + relay P0s only bind for scope B.

---

## Fresh-test environment state (set up 2026-06-08)

For this test pass I reset the machine to a clean first-run:

- ✅ Live vault backed up → `~/Library/Application Support/id.mycelium.app.PREWIPE-bak-20260608-082458` (encrypted; recoverable only with the 64-char recovery key).
- ✅ Data dir, both keychain master keys (`mycelium-user-master`, `mycelium-system-key`), and app caches/WebKit storage **wiped**.
- ✅ App **rebuilt from `main` (`f28ad9a`)** via `cargo tauri build --bundles app`.
- → Next launch enters the **new-user onboarding ceremony** (`needsSetup: true`).

### Live test results (2026-06-08, clean run)

Walked the real fresh-install flow on the rebuilt app. Verified:

- ✅ **Key-gen onboarding works** — `needsSetup: true` → create vault → recovery key → vault opens.
- ⚠️ **No handle step, no checkout step in onboarding** — *by design* (setup is key-gen only; handle lives in Profile, checkout only in the paid managed-relay path). **But this is a UX gap:** a new user is never guided to claim a handle, and the managed/relay/checkout path needs B7/B8 to exist at all.
- ✅ **Claude-export import WORKS and persists** — uploaded a real Claude export → **132 messages / 6 conversations**, `source=claude-import`, correct ISO timestamps, content encrypted at rest, **132/132 embedded**. `/portal/upload/complete` returns `{importResult:{type:'claude',imported,stats}}` and ImportView reads it correctly.
- 🟥 **"Data doesn't show up" — confirmed UX bug, NOT data loss.** Imported conversations land as **messages**, surfaced only by **Timeline** (`/portal/messages` → returns all 132). But the **default/primary screens look empty**: **Library** reads `/portal/documents` (0 rows — chat imports aren't documents) and **Mindscape** is blank until "Generate" is clicked. With no post-import guidance ("imported 132 — view in Timeline / Generate now"), a new user reasonably concludes the import failed.
- ⚠️ **Embed pipeline healthy** — embedder `status:ok`, drained 132/132 unattended. **Generate Mindscape is ready** (≥5 embedded).
- 🟥 **Root-cause of the earlier "vault didn't load / generate errored" bug = multi-session contention.** Two concurrent headless Claude sessions (autonomous routine) were writing the same keychain + `./data` vault under the live app, clobbering state mid-run. Not a product bug, but a real hazard while running automation against a live vault.

---

## Part A — The new-user flow, step by step

Status legend: ✅ works · ⚠️ works-with-caveat · 🟥 broken/stub for a first-timer

| # | Step | Status | Evidence / note |
|---|------|--------|-----------------|
| 1 | App launch → Tauri spawns node → opens `127.0.0.1:8787` | ✅ | `src-tauri/src/main.rs:224-349` (waits for port, 25s) |
| 2 | Setup-mode detection (`/account/status` → `needsSetup`) | ✅ | `src/account/router.js:42-55` (gated on `kcv.json`) |
| 3 | Key-gen ceremony, recovery-key display + save (Keychain/1Password/download) | ✅ | `src/account/router.js:57-72`, `portal-app/src/routes/setup/+page.svelte` |
| 3a | Recovery key shown **once** — if user closes tab before saving, vault is unrecoverable on a new machine | ⚠️ | by design; the re-entry challenge proves possession only for the current session |
| 4 | Connect AI — **OAuth buttons (Claude/OpenAI)** | 🟥 | `portal-providers.js:159-165` — Claude OAuth refused (400), OpenAI status hardcoded false |
| 4a | Connect AI — **paste API key** fallback | ✅ | `POST /portal/providers` `portal-providers.js:92-110` |
| 5 | Import data (Obsidian folder) | ✅ | `src/portal-import.js:22-36` |
| 5a | Import ChatGPT / Claude / LinkedIn exports | ⚠️ | upload path works; format-specific parsing **untested on real exports** |
| 6 | OnboardingGuide enrichment progress (`/portal/enrichment/{status,trigger,progress}`) | 🟥 | **endpoints not mounted** — confirmed absent in `src/`; guide will 404 / spin forever |
| 6a | Actual embedding (background drainer + `/portal/mycelium/processing-status`) | ✅ | `src/embed/supervisor.js`, `src/portal-mindscape.js:265-278` — the *real* pipeline works; only the guide's polling is broken |
| 7 | Generate mindscape (needs ≥5 embedded msgs) | ✅ | `src/portal-mindscape.js:284-319` (Tier-2: needs python/onnx/ollama on host) |
| 8 | Messaging setup (Telegram/Discord token save) | ✅ | credential save works; live agents are Phase 4+ |

**Net:** the happy path works **if** the user (a) pastes an API key instead of using OAuth, and (b) ignores the OnboardingGuide's broken enrichment polling. Two fixes (below) make it clean.

---

## Part B — P0 blockers (must fix before public)

- [ ] **B1 · Onboarding: mount enrichment endpoints OR hide the steps that call them.** `OnboardingGuide.svelte:119,307,333` call `/portal/enrichment/{status,trigger,progress}` — none are registered in `src/`. Either implement them (the real work already happens via the embed drainer + `/portal/mycelium/processing-status`) or gate those UI steps off. *Owner: dev.*
- [ ] **B1b · Post-import visibility (NEW, verified live).** Import succeeds but the user can't see it: Library shows `documents` (chat imports are `messages`), Mindscape is blank pre-generate, and nothing routes the user to Timeline or prompts "Generate." Fix: after import, show "Imported N messages from M conversations → View in Timeline / Generate Mindscape," and/or surface a conversations list in the default view. *Owner: dev.*
- [ ] **B1d · Mindscape doesn't detect data without a reload (NEW, verified live).** `checkGenerationState()` runs only in `onMount` (MindscapeView.svelte:275); in the tabbed workspace the view stays mounted, so after import it never re-checks and keeps showing "Welcome" instead of "Your data is ready → Generate." User had to close+reopen the app. Fix: poll / re-check on view activation (and after an import-complete event), and read the live `/portal/mycelium/processing-status` instead of the stubbed `/portal/onboarding/status` (enrichedCount hardcoded 0) + missing `/portal/enrichment/status` (404). *Owner: dev.*
- [ ] **B1e · Chronicle narration times out → empty chronicles (NEW, verified live).** Step 3 narrates each territory via local Ollama `llama3.1` (700 tok) with a 60s timeout (`describe-chronicles.js:114`), fail-soft. The first call also pays cold model-load (~30s) → exceeds 60s → all 9 territories left empty; Step 3 looks frozen for minutes. Fix options: pre-warm the model + `keep_alive` before the loop, raise the local timeout (60s→120-180s), trim local maxTokens, and/or move chronicle narration to an async background step so Generate completes fast and chronicles fill in after. *Owner: dev.*
- [ ] **B1c · Onboarding doesn't guide handle creation (NEW, verified live).** Decide whether first-run should include claiming a `<handle>` (it currently lives only in Profile, and the relay/checkout path needs B7/B8). *Owner: product.*
- [ ] **B2 · Onboarding: fix or hide the OAuth "Connect AI" buttons.** `portal-providers.js:159-165` — Claude OAuth returns 400 ("not supported"), OpenAI status hardcoded `false`. First-timers clicking them see "Connection failed." Make the API-key path the primary CTA and demote/hide OAuth until real. *Owner: dev.*
- [ ] **B3 · Remove TEMP debug logging.** `src/server-http.js:102` (`[myc-prm]` logs IP+UA) and `:307` (`[myc-mcp]` logs bearer-present + session-id + IP). Both tagged `// TEMP — remove pre-merge`. CLAUDE.md §1 (zero plaintext/sensitive leakage). *Owner: dev — note this file is auth/CORS-sensitive; per CLAUDE.md re-verify with the WebKit MCP Inspector after any change here.*
- [ ] **B4 · Distribution: notarize + hardened-runtime the Mac app.** Currently ad-hoc signed (`tauri.conf.json:23 signingIdentity: "-"`) → Gatekeeper "unidentified developer" on first open. Requires Apple Developer ID ($99/yr). Also wire `entitlements.plist` into `tauri.conf.json` (`"entitlements": "entitlements.plist"`). Runbook: `docs/MAC-APP-RELEASE-RUNBOOK-2026-06-05.md:46-79`. *Owner: operator (Apple ID) + dev.* — *Interim:* document "right-click → Open" prominently.
- [ ] **B5 · Legal/brand placeholders.** `.github/FUNDING.yml` is fully commented (`YOUR_GITHUB_SPONSORS_HANDLE`, `YOUR_STRIPE_PAYMENT_LINK`); `README.md:192-202` has the same placeholders. Fill the Sponsors handle + Stripe link; add a minimal `PRIVACY.md` (data stays on-device by default; relay = TLS-SNI passthrough; hash-only egress audit). *Owner: operator.*
- [ ] **B6 · Real-export import smoke.** Import a **real** Claude export and a **real** ChatGPT export end-to-end (parsers only tested on synthetic fixtures). *Owner: this test pass — see Part E.*

### P0 — only if **paid managed relay** is in launch scope (scope B)
- [ ] **B7 · Stand up the hosted relay** so `<handle>.mycelium.id/mcp` + `/v1` work end-to-end. Today: client side built, hosted relay **not live** (`docs/CONNECT-YOUR-AI.md:129`). *Owner: operator/infra.*
- [ ] **B8 · Connect Stripe (operational).** Code is complete + tested (`mycelium-managed/src/billing.js`, `server.js:62-102`, `registry.js`). Remaining ops:
  - [ ] Create live Stripe account; set `MYC_STRIPE_SECRET`, `MYC_STRIPE_WEBHOOK_SECRET`, `MYC_STRIPE_PRICE_MONTHLY`, `MYC_STRIPE_PRICE_ANNUAL`, `MYC_APP_RETURN_URL`.
  - [ ] Register the webhook URL (`/v1/stripe/webhook`) in the Stripe dashboard with the 5 subscribed events.
  - [ ] Run the **test-mode €1 card → webhook → entitled re-provision** smoke (gate from the onboarding-billing handoff).
  - [ ] Add a post-checkout return/landing page (`?status=success|cancel`) with retry UX.
  - [ ] Add a legible "relay down — subscription lapsed" message on reconnect (`relay-hook.js:37-38` denies silently today).

---

## Part C — P1 should-fix

- [ ] **C1 · Gate portal type-check in the main verify chain.** `npm run verify` (backend) does NOT include `svelte-check`; it's a separate CI step (`.github/workflows/verify.yml:61-69`). A local `npm run verify` misses portal type errors. Fold `portal:check` in or document the two-command requirement.
- [ ] **C2 · No-backend screens must render graceful-empty, not throw.** `cycles`, `fleet`, `wealth`, `media` have no V1 backend (`docs/TEST-local-session-HANDOFF-2026-06-06.md:77-79`). Verify they show "coming soon," not an HTTP error. Either hide their nav entries for launch or confirm graceful fallback.
- [ ] **C3 · Partial screens — audit 404 sub-features.** Settings (`/passkeys`, `/billing`, `/delete-account`, `/export`, `/master-key/restore`, `/channels/global`), Profile (`/avatar`, `/exlibris`), Vitality (`/vitality/arc`, `/chronicle/by-window`), Mindscape (the enrichment trio) call endpoints that 404. Ensure each fails gracefully (`TEST-local-session-HANDOFF-2026-06-06.md:69-75`).
- [ ] **C4 · Confirm `MYCELIUM_MCP_BEARER` is never baked into the distributed binary.** It's correctly fail-closed/opt-in (`src/gateway/static-bearer.js:8-34`); just verify no `.env`/`src-tauri` sets it in the bundle.
- [ ] **C5 · Confirm `includeMock` connector is off in production** (`src/connectors/index.js:4,16,25`).
- [ ] **C6 · PRIVACY.md + brief ToS** for the public repo (see B5).
- [ ] **C7 · Real-client smoke:** Claude Desktop (stdio) + a phone over the relay actually connect and list tools — including the **WebKit MCP Inspector** browser check required by CLAUDE.md §55 for any `/mcp`/auth/CORS surface.

---

## Part D — P2 nice-to-have

- [ ] **D1 · Auto-updater** (today: manual DMG download/replace) — `MAC-APP-RELEASE-RUNBOOK:92-95`.
- [ ] **D2 · Intel/Universal build** (arm64-only today — bundled Node/Python/wheels are arch-specific).
- [ ] **D3 · Cognitive-metric baselines** show "not yet calibrated" until enough data (expected; `HonestyBanner.svelte`).
- [ ] **D4 · DMG creation** needs an interactive GUI (AppleScript/Finder) or the `hdiutil` workaround for CI (`BUILD-MAC.md:75-86`).
- [ ] **D5 · Fisher-tools verify + chronicles narratives** (deferred polish, `PRE-LAUNCH-READINESS`).

---

## Part E — This test pass: what to walk through live

Once the rebuilt app launches into the clean onboarding:

1. [ ] Create vault → confirm recovery-key display + **save to Keychain** round-trips; relaunch confirms auto-unlock.
2. [ ] Connect AI via **API key** (skip OAuth) → provider saved + encrypted.
3. [ ] Import a **real** Claude or ChatGPT export → messages land (validates B6).
4. [ ] Watch embedding via `/portal/mycelium/processing-status` (not the broken guide poll) → ≥5 embedded.
5. [ ] **Generate mindscape** → completes (Tier-2: needs ollama + embed-service, both present on this host).
6. [ ] Note every dead button / 404 / spinner-forever for Parts B–C.

---

## Part F — Operator (non-code) action list

- [ ] Decide **launch scope A vs B** (free self-host only / + paid managed relay).
- [ ] Apple Developer ID + notarization (B4).
- [ ] GitHub Sponsors handle + Stripe payment link → `FUNDING.yml` + README (B5).
- [ ] PRIVACY.md (+ optional ToS) (B5/C6).
- [ ] **If scope B:** live Stripe account + webhook registration + relay host stood up (B7/B8).

---

*Generated from a 4-way parallel code sweep with file:line evidence + a live fresh-install test on 2026-06-08. Re-run the relevant `verify:*` gates and re-test the onboarding after B1–B3 land.*
