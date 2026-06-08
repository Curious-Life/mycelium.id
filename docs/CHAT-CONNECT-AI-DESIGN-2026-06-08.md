# Chat + Connect-AI — design (2026-06-08)

Owner: this session (operator: "I own it end-to-end"). Operator directives:
- **No random fallbacks.** Chat must NOT silently use local Ollama. If no model is connected, show a clear "connect a model" state.
- **Always show the active provider + model** in the chat UI.
- **Connect-AI:** one beautiful, dedicated page; remove the redundancy (3 scattered entry points today).
- Clean, visible, reliably testable.

Built in two shippable phases. **Phase 1 (chat reliability) is the #1 launch blocker and ships first.**

---

## Sweep findings (consolidated, file:line)

**Silent fallback (the bug).** `src/agent/harness.js:185-195` `normalizeProvider({})` → silent Ollama `127.0.0.1:11434` / `llama3.1`. Reached via `portal-chat.js:134` (`resolveInferenceConfig` → `{}` when no provider) → `streamTurn` (`:168`) → `normalizeProvider`. **Caller safety:** the ONLY consumer that should fail-explicit is chat. Channels (`packages/channel-daemon/agent/runtime.js` `selectRuntime` → capture-only if unset), enrichment (`src/inference/router.js` — intentional local for simple tasks), and `describe-image.js` (intentional local, fail-soft) each have their OWN explicit config and **do not call `streamTurn`**. So I make chat explicit in `portal-chat.js` and **do not touch `normalizeProvider`** — zero collateral, and `verify:inference/harness/gateway` stay green.

**Chat backend** (`src/portal-chat.js`, read in full): SSE handler `/chat/stream` (`:95-195`). Events: `stream_start`, `keepalive`, `tool_start/complete` (portal) + `text_delta/thinking_delta/tool_*/usage` (harness) + `done`/`error`/`[DONE]`. `:134` resolves provider; `:138` already computes an `isLocal`/no-provider expression; `:168` calls `streamTurn`; `:181` the vague "didn't respond" error after the 90s `IDLE_MS` watchdog (`:116,129`). History `GET /chat/history` (`:80-92`) returns `{messages:[]}` when empty.

**Chat UI** (`portal-app/src/lib/components/chat/ChatFloat.svelte`, 2461 lines + `stores/chat.ts`): `handleEvent` switch `:571-626`; fetch/SSE loop `:669-716`; history auto-load on expand `:1144-1149`; **"Load chat history" button shows even with no history** `:1442-1464` (the false load-history, #27); error handling `:720-735`; "thinking" spinner `:1649-1661` (no TTFB timeout); header `:1282-1391` (no model shown). Store `stores/chat.ts:44-61` `loadHistory` swallows empties.

**Provider store** (`src/db/providers.js`, `src/portal-providers.js`): `ai_providers` table (provider/label/auth_type/credentials/model_preference/base_url/is_active/status). `create` does **NOT auto-activate** (`is_active=0`); `setActive` enforces one-active-per-type; `PUT /:id {is_active:true}` activates; `POST /:id/test` probes (`src/inference/probe.js`). **Missing: auto-activate first provider; model-list endpoint.** `resolveInferenceConfig` (`src/inference/resolve.js:54-60`) reads `getActive` → `{}` when none.

**Connect-AI redundancy** (`portal-app/src`): the real control surface is `settings/IntelligenceSection.svelte` (provider CRUD + hardware-aware Ollama pull → registers a `custom` provider at `127.0.0.1:11434/v1` + cascade-routing). Duplicated by `OnboardingGuide.svelte` "Connect AI" step + `ConnectionsChecklist.svelte` AI step (both POST `/portal/providers`). Reference-only: `ConnectYourAISection` (MCP/gateway how-to), `HarnessPickerSection` (recipes). Orthogonal: `AIAccessSection` (tool-domain gates). Settings `TABS` (`SettingsView.svelte:169-177`): connection/intelligence/integrations/billing/general/security/account — **Intelligence is overloaded** (subscriptions + channel authority + voice + channels + AI-access).

**Tests:** `verify:portal-chat` (chat streaming + error SSE), `verify:providers` (CRUD/setActive/test), `verify:inference` (routing/fallback/leak), `verify:gateway[-stream]`. `portal:check` = `svelte-check --fail-on-warnings` (0 errors).

---

## Phase 1 — Chat reliability (BLOCKER, ships first)

**Goal:** no silent fallback; visible active model; clear no-model state; no false "load history"; honest stall feedback.

1. **`harness.js`** — add `export function describeProvider(cfg)` → `{kind,label,model,jurisdiction,local}` or `null` when no provider. Single source of truth for "what model is this config", using the same `DEFAULT_*` constants. **`normalizeProvider`/`streamTurn` unchanged** (keeps all other gates green).
2. **`portal-chat.js`** — after `resolveInferenceConfig` (`:134`): `const info = describeProvider(provider)`. If `!info` → `send({type:'no_model', message})` + `done` + `return` (NO `streamTurn`, NO silent Ollama). Else `send({type:'model', label, model, jurisdiction, local})` before the turn. Reuse `info.local` for the preamble sizing (replaces the inline `:138` expression).
3. **`stores/chat.ts`** — add `activeModel` store (`{label,model,jurisdiction,local}|null`) + `noModel` flag; `loadHistory` returns `{loaded,empty}` so the UI can distinguish "no history" from "not loaded".
4. **`ChatFloat.svelte`** — `handleEvent`: `case 'model'` → set `activeModel`; `case 'no_model'` → set `noModel` + surface a "Connect a model → Settings" CTA in the composer/empty area. Header (`:1282-1391`): a **model chip** (`activeModel.label · model`, local/cloud dot). Empty state (`:1442-1464`): replace the always-on "Load chat history" — show a **welcome** line when history loaded-and-empty, the **no-model CTA** when no model; keep an explicit "load older" only when history exists. Light **TTFB hint**: if no `text_delta` within ~12s of `stream_start`, append "…taking longer than usual" to the thinking row.
5. **Gate:** extend `verify:portal-chat` — no-provider → `no_model` SSE (not a silent stream); configured provider → a `model` SSE precedes `text_delta`. Keep all existing assertions green.

## Phase 2 — Dedicated Connect-AI page (UX consolidation; ships second)

1. New Settings tab `{id:'ai', label:'Connect AI'}` (after `connection`) rendering `IntelligenceSection` (provider add/test/active + Ollama pull + model pick) + `ConnectYourAISection` + `HarnessPickerSection`. Slim the `intelligence` tab to channels/voice/authority (rename later).
2. **Auto-activate first provider:** `portal-providers.js` POST → if no active provider of that type exists, `setActive(newId)`. (Gate: `verify:providers`.)
3. **Model pick** already supported (`PUT /:id {model_preference}`) — surface it in the page.
4. Remove the redundant "Connect AI" steps from `OnboardingGuide` + `ConnectionsChecklist`; point them at the new page. (The onboarding "first model" step copy/sequence is the operator's to define — non-blocking.)

---

## Threat model / invariants
- **Egress unchanged:** the harness egress audit (hash+len only) + the §4g sensitive/jurisdiction policy are untouched; Phase 1 only adds a pre-flight refuse + display events. No new plaintext in logs/SSE (the `model`/`no_model` events carry only label/model name/jurisdiction — never keys or content).
- **No behavior change for non-chat consumers** (channels/enrichment/describe-image) — `normalizeProvider` untouched; verified by the caller map above.
- **Fail-closed:** no provider → refuse with an actionable message, never a silent attempt.

## Module shape (±20% LOC)
| File | Change | ~LOC |
|---|---|---|
| `src/agent/harness.js` | `describeProvider()` export | +18 |
| `src/portal-chat.js` | no_model refuse + model event + reuse info.local | +12 |
| `portal-app/.../stores/chat.ts` | activeModel/noModel + loadHistory result | +20 |
| `portal-app/.../chat/ChatFloat.svelte` | model chip + no-model CTA + welcome + TTFB hint | +60 |
| `scripts/verify-portal-chat.mjs` | no_model + model SSE assertions | +30 |
| **Phase 2:** new `ai` tab + IntelligenceSection move | `SettingsView.svelte` | +40 |
| `src/portal-providers.js` | auto-activate first | +6 |
| `OnboardingGuide`/`ConnectionsChecklist` | remove AI step → link | -60 |

## Test strategy
- `verify:portal-chat` (extended): no_model SSE on no provider; model SSE before text on configured provider; existing streaming/error assertions stay green.
- `verify:providers` (Phase 2): first-provider auto-activates.
- `verify:inference`, `verify:harness`, `verify:gateway[-stream]` stay green (normalizeProvider untouched).
- `portal:check` 0 errors.
- Manual smoke (packaged app): no provider → chat shows "Connect a model"; add a provider → chip shows it + replies; no false "load history".

## Implementation order
1. Phase 1 backend (`harness.describeProvider` + `portal-chat`), extend `verify:portal-chat` → GO.
2. Phase 1 UI (`chat.ts` + `ChatFloat`), `portal:check` 0.
3. PR #1 (chat reliability) → merge.
4. Phase 2 (Connect-AI page + auto-activate + de-dup), `verify:providers` + `portal:check` → PR #2.

## Verification table
| Assumption | Verified at |
|---|---|
| Silent fallback = `normalizeProvider({})` → Ollama | `harness.js:185-195` (read) |
| chat reaches it via resolve→streamTurn | `portal-chat.js:134,168` (read) |
| no-provider = empty `{}`; `isLocal` already computed | `portal-chat.js:134,138`; `resolve.js:54-60` (read + sweep) |
| channels/enrichment don't call streamTurn (no collateral) | sweep1 caller map (`channel-daemon/runtime.js`, `inference/router.js`) |
| SSE event protocol + where to inject `model` | `portal-chat.js:104-132` (read) |
| harness constants for describeProvider | `harness.js:25,33,34` (read) |
| provider create does NOT auto-activate; setActive one-per-type | sweep2 (`db/providers.js`, `portal-providers.js`) |
| ChatFloat handleEvent/header/load-history/empty | sweep4 (`ChatFloat.svelte:571-626,1282-1391,1442-1464`) |
| Settings TABS + Intelligence overloaded | sweep6 (`SettingsView.svelte:169-177`) |
| test gates for chat/providers/inference | sweep6 (`verify-portal-chat/providers/inference`) |
