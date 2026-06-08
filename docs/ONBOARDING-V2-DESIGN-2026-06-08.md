# Mycelium Onboarding v2 — locked design (2026-06-08)

Operator-authored copy draft + a design review/iteration (this session). **Locked** — ready to build. Goal: zero → "see your mind" in six steps, one path, flawless. Collapses the **three overlapping surfaces** that exist today (`WelcomeModal` 4-step + `OnboardingGuide` card + the empty-mindscape `ConnectionsChecklist`) into one clean linear flow.

## Current structure (build on this)
- Account ceremony routes: `portal-app/src/routes/{setup,unlock,login}/+page.svelte`. First-run gate = `/api/v1/account/status` → `needsSetup` (no `kcv.json`) · `locked` (vault present + passphrase) · `open`.
- Post-vault onboarding: `(app)/+layout.svelte:11-12,42-47,121-123` mounts `WelcomeModal` + `OnboardingGuide`, gated by `/portal/onboarding/status` (`showWelcome`, `show`). `onboarding_dismissed_at` is written but **never honored** (`portal-compat.js:701`) — fix.
- Already shipped this session (on main): auto-continue generate (#125), embedding chunking (#126), chat no-fallback + show-model (#127). So Steps 3/4/5's "broken" notes are largely resolved.

---

## The six steps

### Step 0 — Install/launch (invisible)
App handles keys/Keychain/servers/Ollama auto-pull/channel daemon. No UI.

### Step 1 — Create (custody moment) · **state-aware**
Emotional job: *transfer of custody*, not "make an account." Drive off `/account/status`:
- `needsSetup` → **Create vault** (primary) + a secondary **"Restore from a backup"** path.
- `locked` → **Unlock** (passphrase or recovery key, `/account/restore`).
- `open` → skip in.

**⚠️ The recovery-key truth (verified `src/account/router.js:75-99`):** the key DECRYPTS local data; it does NOT store it. On a device with **no vault file**, `/account/restore` silently creates a **fresh empty vault**. So device-loss = data-loss even with the key, and there is **no vault data export today**. Copy must be honest ("the only key to your data — lose it and the data is unrecoverable"), and the **vault-backup feature is deferred to a future session** (spawned task `task_fda61874`, incl. external/remote-served vault access). Until it lands, "Restore from backup" = restore the data folder + paste the key.

- Recovery-key reveal gets **gravity**: copy/download **+ an "I've saved my key" confirm gate** (the one irreversible thing).
- ✅ Remove the "Add to Keychain" button — store silently; only surface the key.
- One screen, no second modal.

### Step 2 — Welcome (one breath)
Single screen replacing the 3 surfaces. The **mycelium.id site's 3D Goethe mindscape model** alive behind the text (operator: lift that asset). One line + 3-step preview + one CTA.
> Mycelium turns your conversations into a living map of your mind. Private, encrypted, on your device.
> **1.** Bring your world in · **2.** Connect an AI · **3.** Watch your mind take shape
- CTA: `Let's grow your mycelium`. No empty mindscape behind it — the Goethe model IS the preview (creates desire).

### Step 3 — Import ("Bring your world in") · **upload-first**
Not just conversations — journals, transcripts, media, chat logs. Upload **before** Connect-AI (commitment → lower drop-off). Supported-format chips (Telegram/WhatsApp/ChatGPT/Claude/Obsidian/md/txt…).
- **Preview card after file #1** = the desire engine: **"See your mind"** (operator: NOT "we see you" — self-insight, not surveillance). Concrete + personal: `847 messages · 2019–2024 · 4 people · earliest: "…"`. Evidence the system perceives them. NOT a mini-mindscape (too early; would expose the skew).
- Chunking is correct now (#126) — full content embedded, no 512-token truncation.
- Upload kicks embedding immediately; auto-continue (#125) starts the pipeline in the background.

### Step 4 — Connect AI ("Choose your intelligence") · = chat Connect-AI **Phase 2**
Dedicated page (consolidate `IntelligenceSection` + `ConnectYourAISection` + `HarnessPickerSection` into a new `ai` settings tab; remove the redundant AI steps in `OnboardingGuide`/`ConnectionsChecklist`). Auto-detect via `/portal/hardware/recommend` (returns `ollamaUp` + installed models).
- **Ollama up + capable model → pre-select + one-tap "Using local AI · on your device" confirm** (collapse, don't silently skip — the model must stay visible per the no-fallback we shipped). Else show the picker. Cloud key is the alternative.
- **Auto-activate the first provider** (`portal-providers.js` POST → `setActive` if first of type). **Never say "harness."**
- Overlaps Step 5's background work (data already uploaded).

### Step 5 — Generate (the magic moment)
Auto-runs (built #125): embed → cluster → metrics → narrate, no clicks. Progressive copy tied to real stages ("Embedding… · Finding patterns… · Mapping your territories… · Your mycelium is ready"). CTA `Explore your mind`.
- **Gate the reveal on cluster QUALITY, not just completion** — do not drop them into a lopsided blob. Depends on the **clustering-skew rebalance** (separate workstream — see below). This is where the product lands or loses them.

### Post-onboarding (surface after first generation; non-gating)
Chat ("Talk to your mycelium") · Channels (Settings, "link Telegram") · Handle (after first use, free reserve) · Payment (after value, at remote activation). **Handle/payment order:** value → claim handle (free) → pay only at remote activation. Never gate onboarding on either.

---

## Open questions — resolved
1. Merge Welcome+Import? **No** — distinct beats (desire vs commitment); keep Welcome to one breath that one-taps into Import.
2. Ollama auto-skip? **Collapse to one-tap confirm, model stays visible** (not a silent skip).
3. Min preview? **The "See your mind" evidence card** after file #1.
4. Handle before/after payment? **After** — value → free handle → pay at remote activation.

---

## Build map
**Done (main):** auto-continue (#125), chunking (#126), chat no-fallback + show-model (#127).
**To build (this feature):**
- A single **OnboardingFlow controller** (state machine over `/account/status` + `/portal/onboarding/status`) replacing `WelcomeModal` + `OnboardingGuide` + the empty-mindscape checklist; honor `onboarding_dismissed_at`.
- **Step 1** state-aware Create/Unlock/Restore + key confirm-gate; remove "Add to Keychain".
- **Step 2** single Welcome screen + the Goethe 3D model background (need the asset from mycelium.id).
- **Step 3** upload-first + the "See your mind" card (needs a `/portal/import/preview`-style summary: counts/date-range/people/sources).
- **Step 4** = Connect-AI **Phase 2**: new `ai` settings tab (move `IntelligenceSection` + how-to/recipe panels), Ollama auto-detect → 1-tap, auto-activate first provider, de-dup onboarding/checklist AI steps.
- **Step 5** wire the auto crescendo + gated reveal.

**Co-requisite (separate workstream): clustering skew.** Investigated (`docs/` + below). Root cause: `centroids_to_groups` (`cluster.py:822-853`) — Ward HAC + `fcluster(criterion='maxclust')` is variance-not-size-aware → one realm balloons; no rebalancing; realms clamped 5–10. Fix: **size-aware oversized-realm split + skew metric (Gini/max-share)**, validated on a synthetic dominant-mode dataset (max-share 0.5+ → <0.30). Operator: **build onboarding first, then clustering** — so Step 5's quality-gate lands once the rebalance exists.

## Deferred (future session)
- **Vault backup + external/remote vault access** — task `task_fda61874`. The honest restore story depends on it.

## Files (anticipated)
`portal-app/src/lib/components/onboarding/*` (new flow), `routes/{setup,unlock}/+page.svelte`, `(app)/+layout.svelte`, `src/portal-compat.js` (onboarding status + dismiss + a `/import/preview` summary), `views/SettingsView.svelte` (+`ai` tab), `src/portal-providers.js` (auto-activate), `OnboardingGuide.svelte`/`ConnectionsChecklist.svelte` (de-dup/remove). Tests: extend `verify:providers` (auto-activate), `verify:portal`/onboarding-status; `portal:check` 0.
