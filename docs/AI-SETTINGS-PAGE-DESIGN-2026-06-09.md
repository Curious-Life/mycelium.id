# AI & Intelligence settings page — design (2026-06-09)

Operator: "examine all the areas that touch ai — the model provider, the harness, everything — and create a good, simple, incredibly well-designed UX/UI." Plus: the "Spawn intelligence" prompt in realms + the realm UI improvements (shipped #132) must land here cohesively.

## Sweep findings (every AI-touching surface)

**Backend (zero changes needed — all endpoints exist):**
- Providers CRUD — `src/portal-providers.js`: list / create (auto-activate-first, returns `{id,activated}`) / `PUT :id` (activate via `is_active:true`) / delete / `:id/test` (probe) / `presets` / `routing` (cascade) / runtime-state. `setActive` = one-active-per-type.
- Catalog — `src/inference/presets.js`: regolo (eu-zdr), scaleway (eu-zdr), anthropic (us), openai (us), ollama (local), lmstudio (local). Fields: id,label,kind(anthropic|openai),baseUrl,jurisdiction,defaultModel.
- Harness — `src/agent/harness.js`: `resolveInferenceConfig` (active provider → cfg), `describeProvider` → `{kind,label,model,jurisdiction,local}` or null, `normalizeProvider` (local Ollama floor). Defaults: claude-opus-4-8 / gpt-4o / llama3.1.
- Local — `src/portal-hardware.js`: `/hardware/recommend` (ollamaUp, ollamaInstalled, recommendations[{name,installed,fitLevel,bestFor,estimatedGb,blurb}]), `/hardware/pull` (SSE, auto-starts daemon), `/hardware/start`.
- Routing — `/providers/routing` cascade; `resolveProviderChain` orders by jurisdiction (eu-zdr<us<local), drops US when sensitive, local floor.
- Probe — `src/inference/probe.js`: category only (no_key/auth_rejected/…).
- `ai_providers` table — `credentials` encrypted at rest; never echoed.

**Frontend (today, fragmented):**
- `intelligence` tab: `IntelligenceSection` (catalog by jurisdiction, connected list, smart routing, hardware recommender + Ollama pull) + `AIAccessSection` (chat tool-domain grants).
- `connection` tab: `RemoteAccessSection` + `HarnessPickerSection` (curated recipes; uses the word "harness") + `ConnectYourAISection` (MCP memory + model gateway endpoints, bearer token — Mycelium INTO other apps).
- Entry points: onboarding `MindscapeInvite` intelligence step + `OnboardingFlow` connect-ai step; `MindscapeDetail` "Spawn intelligence"; chat `ChatFloat` model chip + `no_model` state.
- Design tokens: `--color-text-{primary,secondary,tertiary}`, `--color-accent`, `--color-accent-aurum`, `--color-{bg,surface,elevated,border}`. Onboarding glass = `rgba(255,255,255,0.03)` cards, `rgba(229,184,76,*)` accent, 12px radius.

## Two distinct directions (the key insight)
1. **Mycelium's mind** — the model that powers enrichment/narration/chat. This is "Connect AI" / "Spawn intelligence." (providers + hardware + routing)
2. **Mycelium in your apps** — Mycelium as memory(MCP)+model(gateway) for an external agent. This is "the harness." (ConnectYourAI + HarnessPicker)
3. **In-app assistant access** — what the built-in chat agent may touch. (AIAccess)

A good design separates these clearly instead of one flat dump.

## The design — `AISettings.svelte` (the `intelligence` tab, redesigned)

Glassy/ethereal, matching onboarding. Vertical hierarchy:

1. **Active intelligence (hero)** — spark icon + the live active model: "Using Claude · claude-opus-4-8" + jurisdiction chip (local=green "on your device" · eu=green "zero-retention" · us=amber "US"), or — when none — "No intelligence connected yet · connect one below" (this is the chat `no_model` mirror + the "Spawn intelligence" target).
2. **Connect — two lanes:**
   - **Local · private** — Ollama: recommended-for-your-hardware models (one-tap Pull & use, SSE progress), "stays on this device."
   - **Cloud · your key** — preset cards (EU-sovereign · US) → key + optional model → connect.
3. **Connected** — list with active badge · Use · Test · Remove (glassy rows).
4. **Smart routing** — the cascade toggle.
5. **Footer links (progressive disclosure)** — "Use Mycelium in another app →" (connection tab) · "In-app assistant access" (`AIAccessSection`, kept). Reframe "harness" → "your AI app".

Reuses IntelligenceSection's proven script (endpoints, connect, pullAndUse, setActive, test, routing) verbatim; only the template + the hero are new.

## Deep-linking
`SettingsView` reads `?tab=<id>` on mount → sets `activeTab`. Route every "Connect AI"/"Spawn intelligence"/chat-no-model CTA → `/settings?tab=intelligence`:
- `MindscapeDetail.connectIntelligence` (the realm "Spawn intelligence" card)
- `OnboardingFlow.goConnectAI`
- chat no-model CTA

## Verification table
| Assumption | Verified at |
|---|---|
| Providers CRUD + activate + test + presets + routing exist | `src/portal-providers.js:47-175` |
| Auto-activate-first returns `{activated}` | `portal-providers.js:100-117` |
| `describeProvider` shape (active model display) | `src/agent/harness.js:207-222` |
| Hardware recommend + SSE pull (auto-start daemon) | `src/portal-hardware.js:44,76` |
| Preset catalog + jurisdictions | `src/inference/presets.js:15-29` |
| `credentials` encrypted, never echoed | `crypto-local.js:214`, `db/providers.js:25` |
| SettingsView tab system (`activeTab`, TABS, `{#if activeTab===}`) | `SettingsView.svelte:169-178,1292-1323` |
| `intelligence` tab mounts IntelligenceSection + AIAccessSection | `SettingsView.svelte:1641-1644` |

## Update (2026-06-09, commit `0dc1bff`) — follow-ups folded in
The "out of scope" items below were folded into this same PR (#133) at the operator's request:
- **External-client/"harness" folded in**: `HarnessPickerSection` + `ConnectYourAISection` moved out of the `connection` tab onto the AI page under **"Use Mycelium in another app"** (the Connection tab is now `ManagedConnect` + `RemoteAccess` only).
- **Legacy "AI Subscriptions" block retired**: the Claude-account OAuth path (ToS-refused) + its entire provider-management script tail in `SettingsView` removed (507 lines) — all superseded by `AISettings` (owns `/portal/providers`). Audited: zero remaining template consumers.
- **Orphaned `IntelligenceSection.svelte` deleted** (zero importers — pre-deletion-caller-audit clean).
- **"harness" → "your AI app"** user-facing rename (code identifiers `Harness`/`harnesses`/`HARNESS-RECIPES.md` preserved).

`portal:check` 0 errors; production build clean.

## Out of scope (remaining follow-ups)
Clustering-skew rebalance; deleting legacy onboarding components (`WelcomeModal`, `OnboardingGuide`, `ConnectionsChecklist`).
