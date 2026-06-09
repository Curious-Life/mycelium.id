# Onboarding light-mode + glass + Intelligence recommender (2026-06-09)

Operator feedback (live test): the Welcome modal, the MindscapeInvite home + steps, the
Intelligence step, the Telegram fields, and the activity notification **don't adapt to
white mode**; add **glass passthrough**; and the Intelligence step should use the
**hardware recommender dropdown** (most-capable/most-suitable models per machine, like the
cookbook) **plus all cloud options including the European ones**, with **mode-aware fields**.

## Root causes (verified)

1. **Theme model:** the app toggles light/dark via `document.documentElement[data-theme]`
   (`stores/theme.ts:25,35`), and `tokens.css` redefines all semantic tokens under
   `[data-theme="light"]` (`tokens.css:101`). So `var(--color-*)` already adapts.
2. **The animated backdrops read the OS scheme, not the app theme** —
   `mycelium-engine.ts:179` and `MindscapeBackground.svelte:29` use
   `matchMedia('(prefers-color-scheme: dark)')`. Toggling the *app* to light leaves the
   canvas dark → mismatch. **Fix:** read `[data-theme]` first, fall back to matchMedia.
3. **Glass is hardcoded dark:** `rgba(255,255,255,0.03)` cards, `rgba(12,12,16,0.55)`
   panels, `rgba(0,0,0,0.25)` inputs. With light-mode *text* tokens (dark text), these give
   **dark-on-dark / invisible** in light mode (Welcome card `OnboardingFlow.svelte:394`;
   invite cards/inputs `MindscapeInvite.svelte:195,213,227`; chip `MindscapeActivityChip.svelte:57`).
   `MindscapeView` already proved the pattern with `:global([data-theme="light"]) .welcome-inner`
   (`MindscapeView.svelte:1047`). **Fix:** theme-aware glass tokens in `tokens.css`.
4. **Intelligence step is thin:** one "Use local AI · <model>" button + Anthropic/OpenAI
   key only (`MindscapeInvite.svelte:141-160`). The full recommender + EU/US presets already
   exist in `AISettings.svelte` (recommend list + `pullAndUse` SSE; `cloudGroups` EU/US;
   `choose`→`connect`) over `/portal/hardware/recommend`, `/portal/providers/presets`,
   `/portal/providers`. **Fix:** port that compactly into the step.

## Plan

### A. `tokens.css` — theme-aware glass tokens (dark in `:root`, light in `[data-theme="light"]`)
`--glass-card-bg`, `--glass-card-hover`, `--glass-border`, `--glass-panel-bg`,
`--glass-input-bg`, `--glass-input-border`. Light values use dark-on-light tints + frosted
white panels (≈0.8 alpha) so text tokens stay readable over any backdrop.

### B. Canvas theme fix — `mycelium-engine.ts` + `MindscapeBackground.svelte`
`const a = document.documentElement.getAttribute('data-theme'); dark = a ? a==='dark' : matchMedia(...)`.

### C. Welcome modal (`OnboardingFlow.svelte`)
Backdrop `var(--color-bg)`; card → `--glass-panel-bg` + `--glass-border`; step bubbles keep
aurum tint (works both modes). Text already token-based.

### D. `MindscapeActivityChip.svelte`
Panel/border/progress-track → glass tokens; keep aurum/coral/jade accents.

### E. `MindscapeInvite.svelte`
- All cards/inputs/seg/file/dropzone → glass tokens (light-mode correct).
- **Intelligence step rebuilt** mirroring AISettings: **Local lane** = recommend list
  (fitLevel badges + Pull&use SSE → activate provider), **Cloud lane** = preset chips
  grouped **EU-sovereign (Regolo, Scaleway) · US (Anthropic, OpenAI, OpenRouter, Together,
  Groq)** → key + optional model → `POST /portal/providers`. Compact, glassy, mode-aware.

## Verification table
| Assumption | Verified at |
|---|---|
| App theme = `[data-theme]` on `<html>`; tokens flip under it | `stores/theme.ts:25,35`; `tokens.css:101` |
| Canvases use OS scheme not app theme (bug) | `mycelium-engine.ts:179`, `MindscapeBackground.svelte:29` |
| MindscapeView already light-adapts the invite wrapper | `MindscapeView.svelte:1047` |
| Welcome card is dark glass + token text (invisible in light) | `OnboardingFlow.svelte:394,420` |
| Recommender shape + SSE pull + provider activate | `portal-hardware.js:43-103`, `AISettings.svelte:136-189` |
| Presets incl EU (regolo/scaleway) + connect write | `inference/presets.js:15-29`, `portal-providers.js:68,92-120` |
| Invite inputs/cards hardcoded dark | `MindscapeInvite.svelte:195,213,220,227` |
| Chip hardcoded dark glass | `MindscapeActivityChip.svelte:57,60,91` |

## Follow-up additions (same PR #135)
- **Onboarding panel glass:** `MindscapeView.welcome-inner` now uses `--glass-panel-bg` +
  `--glass-border` + blur (was a near-opaque hardcoded panel) → frosted in both modes.
- **Recency filter + contained list:** `catalog.js` keeps each model's `updated`;
  `recommend.js` emits `ageMonths = monthsSince(updated)`. The onboarding Local lane shows
  only models **≤ 6 months old** (`MAX_AGE_MONTHS`), **collapsed to the top 3** with a
  "Show N more" expander so the Cloud lane stays in view.

## ⚠️ Dev-workflow gotcha (discovered this session)
`cargo tauri dev` has **no `beforeDevCommand`** — it spawns node with `current_dir(home)`
where `home` falls back to the **stale bundled copy** at `src-tauri/target/debug/app/`
(refreshed only by `scripts/build-app-bundle.sh` on `tauri build`). So plain `cargo tauri
dev` runs OLD `src/` **and** old `portal-app/build`. **Always launch the dev app as
`MYCELIUM_HOME="$(pwd)" cargo tauri dev`** so node runs the working tree. (The throwaway
`node src/server-rest.js` launched from the repo root is always fresh.) Verified:
`main.rs:46-54` (`mycelium_home`), `tauri.conf.json:8` (only `beforeBuildCommand`).

## Out of scope
Extracting a shared `<ModelPicker>` to de-dupe AISettings ↔ onboarding (noted follow-up —
inline port now to avoid destabilizing the just-merged AISettings); reacting to live theme
toggles mid-animation (canvas reads theme at init).
