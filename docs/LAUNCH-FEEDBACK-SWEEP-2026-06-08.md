# Launch-feedback sweep — root-cause understanding (2026-06-08)

Master tracker for the 30 test-feedback points, grouped into 9 areas, each swept against live code (file:line). Status tags: 🔴 blocker · 🟡 important · ⚪ defer. Owner: [me]=this session (channels/pipeline/relay), [chat]=in-app-chat session, [nav]=nav-IA session, [decision]=needs a product call from operator.

> **Read the "reframes" first** — several symptoms have a different real cause than the report assumed.

## Reframes (symptom ≠ root cause)
- **"Embedding miscalculated" (#11)** — the count is *correct* (`portal-compat.js:679` queries `embedding_768 IS NOT NULL`). The real issue is **slow embed rate** (~40 msgs/min CPU) *and* **no embed→cluster auto-continue** (you must click Generate). 
- **"Token limits scrambling data" (#10)** — ✅ **REAL ISSUE (corrected).** The embed service hard-caps at **`MAX_LENGTH = 512` tokens** (`embed-service.py:75`, `enable_truncation` `:130`) and silently truncates — yet **Nomic v1.5 supports 8192 tokens**. So any message/document past ~512 tokens (~400 words) only embeds its first ~512 tokens; the rest is dropped from the vector → degraded search/clustering for long content. `src/enrich/service.js:82` chunks by *rows*, not by tokens within a row, so it does not mitigate this. **Fix:** raise `MAX_LENGTH` toward the model's real cap (perf/memory cost) and/or **chunk long content into ≤N-token windows and embed each** (store multiple vectors or a pooled vector). [me] — decide fidelity vs perf; verify ONNX latency at higher seq-len.
- **"Spaces missing" (#17)** — Spaces **exists** and is wired, intentionally placed under the People cluster, not top-level (`PeopleNav.svelte:16`, `views/SpacesView.svelte`). It's a placement expectation, not a regression.
- **"Doc-types/folders should drop from library page" (#18)** — ✏️ **operator clarification:** folders should appear **inline beneath the Library nav item** in the main sidebar, NOT in a separate page-dependent lower menu region. **Remove the contextual lower sidebar menu entirely** (the per-page `LibraryNav`/`PeopleNav` region) — no specialized lower menu that changes by page. Folders nest under Library; the People sub-items likewise fold into the top nav. Files: `Sidebar.svelte` (the contextual region ~`:301-305`), `LibraryNav.svelte`, `PeopleNav.svelte`.
- **"Chat doesn't work with the model" (#28)** — chat *does* stream end-to-end, but it **silently falls back to local Ollama** when no provider is set, then hangs ~90s with no feedback. ✏️ **operator directive: NO random fallbacks.** Do not auto-fall-back to Ollama. Require an explicit, selected model; if none is set, show a clear "connect a model" state instead of silently using one. **Always show the active provider + model in the chat UI.** Make the whole path clean, visible, and reliably testable (see Groups 1 & 2).
- **Telegram "no reply" (#26)** — plumbing is fixed (PR #123). The remaining cause is **the local model not calling the `reply` tool** (see Group 3). The "fetch failed" I saw earlier was the app being down, not a code bug.

---

## Group 1 — In-app chat 🔴 [chat] — **DESIGN FIRST**
`#1 #3 #27 #28 #29 #30`
> **Operator directives:** (1) remove the silent Ollama fallback — no random fallbacks; require an explicitly selected provider+model. (2) Always display the active **provider + model** in the chat UI. (3) Clean, visible, reliably testable. Design this group first.
- **Flow:** `ChatFloat.svelte` → `POST /portal/chat/stream` (`portal-chat.js:94`) → `resolveInferenceConfig` (`:134`) → `harness.streamTurn` (`harness.js:220`). Real SSE streaming exists.
- **Root cause:** no provider → `resolveInferenceConfig` returns `{}` → `normalizeProvider` (`harness.js:185-195`) silently uses local Ollama `127.0.0.1:11434` model `llama3.1`. If Ollama isn't answering, the **IDLE_MS=90s** watchdog fires, then a vague error (`portal-chat.js:181`). No TTFB timeout, no "connecting…" signal, no pre-flight provider check.
- **First-run:** `loadHistory()` silently returns `[]` and swallows errors (`chat.ts:44`); empty chat shows no welcome/CTA; "load history" appears with nothing to load.
- **Fix scope:** pre-flight provider/Ollama check + clear "no model configured" state; TTFB timeout + streaming "thinking" indicator; welcome state; surface `loadHistory` errors. Files: `harness.js:194/233`, `portal-chat.js:134/165/181`, `ChatFloat.svelte`, `chat.ts`.

## Group 2 — Connect-AI + harness auto-select 🔴 [chat/decision]
`#22 #23 #9`
> **Operator directives:** Connect-AI gets a **beautiful, dedicated settings page** (its own page, nicely formatted), redundancy removed. Includes the **first model connection** flow (the one a new user does in onboarding). No random fallbacks — explicit model selection, surfaced everywhere it's used.
- **Root cause:** no auto-selection; 3–5 clicks (tab → provider → paste → save). OAuth buttons are **stubs by design** (`portal-providers.js:164` returns "not supported — add an API key"). The app **does** auto-install/run local Ollama (`server-rest.js:146`, `MYCELIUM_AUTO_OLLAMA`) and local is the **guaranteed fallback** (`resolve.js:91`) — but the UI never says so and marks "Connect AI" as *Required/blocking* even though it works without a cloud key.
- **Fix scope:** auto-activate the first provider added (`portal-providers.js:100`); present **local Ollama as the pre-selected default** so a new user is productive in 0 clicks; signal "using local model" in the UI; collapse the key form to ≤2 clicks. [decision]: which providers (if any) get true one-click OAuth.

## Group 3 — Telegram agent reply 🔴 [me]
`#4 #25 #26`
> **Operator directive:** the reply model must be **reliably settable, no random fallbacks** — the channel uses exactly the configured provider+model (cloud or local), surfaced + testable; never a silent default swap.
- **Root cause:** the egress chokepoint delivers **only** when the model calls the `reply` tool (CLAUDE.md #11 — free-form text is never delivered). llama3.1 often returns plain text → `ollama.js:51` breaks the loop → `no-reply` (`lane.js:41`). Commands work because they bypass the agent turn (`commands.js`).
- **Levers:** (1) **force tool use** — add `tool_choice` to the Ollama `/api/chat` body (`ollama.js:96`) — ⚠️ **VERIFY Ollama supports this** (version-dependent; not certain). (2) sharpen `buildReplySystemPrompt` (`prompt.js:22`). (3) better tool-calling local model (e.g. `qwen3:4b`, already installed). **No explicit-send-safe text fallback is possible** without violating #11.
- **Fix scope:** `ollama.js` + `prompt.js`; verify forcing works against the bundled Ollama; pick a default channel model that tool-calls reliably. Also #25: a clearer "connected ✓" toast after linking.

## Group 4 — Payments / Stripe / handle 🔴 [me/decision]
`#2 #5 #6 #1 #12`
> **Operator directive:** wire Stripe in so the **full flow works** end-to-end (app checkout → pay → entitlement → tunnel up → handle live), including the missing `/billing/return` + entitlement polling. Pricing/timing decisions still needed (below).
- **Server side is production-ready** (`mycelium-managed/`): checkout session (`billing.js:68`), webhook (`server.js:67`), reserve-then-pay 402 (`server.js:199`), billing portal (`:282`). Stripe is **env-gated OFF** today.
- **App side:** `POST /api/v1/remote/connect-managed` (`remote/router.js:166`) returns the 402 `checkoutUrl`; `ManagedConnectSection.svelte:252` renders a "Pay €1/mo" link. **MISSING:** the Stripe success redirect target — **no `/billing/return` route in `portal-app/src/routes`** → user lands on a dead URL post-payment; no entitlement polling/auto-finalize. *(Reconcile: an earlier task "A3 Stripe return handler" was marked done — verify whether it actually landed in `main`; the sweep finds it absent.)*
- **Decisions:** when to ask for money; handle **before/after** vault (claim needs the master key to sign → realistically after unlock); free-name vs paid-relay split.

## Group 5 — Onboarding / first-run 🔴 [decision]
`#4 #6 #7 #8`
- **Root cause:** onboarding is **3 overlapping surfaces** — `WelcomeModal` (4 steps) + `OnboardingGuide` (4-step card) + `MindscapeView` empty-state that renders `ConnectionsChecklist` over a demo starfield (`MindscapeView.svelte:917-931`). Heavy duplication; the empty stellar display on first run is this welcome branch. `onboarding_dismissed_at` is written but **never checked** (`portal-compat.js:701`).
- **Fix scope:** collapse to one screen, remove the checklist duplication, inline an upload **preview/teaser** (none today), respect the dismiss flag. Files: `WelcomeModal.svelte`, `OnboardingGuide.svelte`, `MindscapeView.svelte:846`, `portal-compat.js:689`.

## Group 6 — Mycelium viz + pipeline 🟡 [me]
`#7 #10 #11 #12`
- **Undescribed territories:** `essence`/`chronicle` are NULL pre-narration and silently omitted (`MindscapeDetail.svelte:489-498`) → stark name+stats only. Fix: "Chronicle pending" placeholder.
- **No auto-continue:** drainer embeds (`drainer.js:81`) but never triggers clustering; user must click Generate (preflight `MIN_EMBEDDED=5`, `portal-mindscape.js:290`). Fix: when `pending==0 && embedded≥MIN`, auto-fire `startClusteringJob` (`drainer.js:68` + `jobs.js`).
- **Count is correct** (reframe above); add a rate indicator so "10/1000" doesn't feel stuck. Single-cluster just looks sparse — needs viz polish.

## Group 7 — Navigation / IA 🟡 [nav]
`#16 #17 #20 #24`
- Nav locked at `aa99dc4` (NAV-IA-LOCK). **People→Connections:** rename `Sidebar.svelte:40` + `PeopleNav.svelte:40` + `navigation.ts:6` + `BottomTabBar.svelte:17` (5-min). **Spaces:** exists, under People cluster by design (reframe). **Profile:** in sidebar footer, not under a "User" group (`Sidebar.svelte:309`). **Channels:** lives in Settings → Intelligence/Integrations (`SettingsView.svelte:10`, `ChannelsSection.svelte`); moving out = [decision] + new nav item. Cruft: a `PeopleNav 2.svelte` backup file to delete.

## Group 8 — Library / Stream / Search 🟡/⚪ [chat/nav]
`#13(lib) #14 #15 #18 #19`
- **Library empty state** bare, no upload button (`LibraryView.svelte:1366`). Folders already sidebar-only (reframe #18).
- **Stream/Timeline empty state** bare, no "connect an integration" CTA (`TimelineView.svelte:282`); backend wired (`/portal/messages`).
- **Search** is client-side instant filter on **loaded docs only**, no debounce, no server full-text (`LibraryView.svelte:320`). "Blocky/delay" = grid reflow + all-docs-upfront load, not network. Fix: `/portal/documents/search` endpoint + debounce + paginated load.

## Group 9 — Settings complexity + theming 🟡 [decision/me]
`#21 #13(theme)`
- Settings is a **7-tab** layout (Connection/Intelligence/Integrations/Billing/General/Security/Account, `SettingsView.svelte:169`). Not one scroll, but **Intelligence is overloaded** (subscriptions + checklist + channel authority + voice + channels). Fix: `showAdvanced` toggle hiding Security/Channel-Authority/Account-deletion.
- **Theme:** dark default; `[data-theme="light"]` is warm beige low-contrast (`tokens.css:101`) that **washes out on the transparent Tauri window** (backdrop-filter disabled for Tauri, `app.css:305`). **Dark-only for launch:** force dark in `theme.ts:8`, remove toggles in `Header.svelte:123` + `SettingsView.svelte:1810`.

---

## Decisions needed from operator (block design work)
1. **Payment**: when/where to ask; price; free-name vs paid-relay split. (#4/#5)
2. **Handle**: reserve before or after vault unlock. (#12/#1)
3. **Onboarding copy**: what the single screen says. (#5)
4. **Connect-AI**: is local-Ollama-by-default acceptable as the launch default (vs requiring a cloud key)? (#2/#3)
5. **Channels placement**: own nav section vs stay in Settings. (#24)

## Verify-before-build
- Ollama `tool_choice`/forced-tool support against the bundled Ollama version (Group 3) — the whole Telegram-reply fix hinges on it; if unsupported, fall back to prompt-hardening + model swap.
- Reconcile the "A3 Stripe return handler" task vs the sweep finding it absent in `main` (Group 4).

## Suggested ownership / sequencing
- **[me] now:** Group 3 (Telegram reply — verify forcing → fix), Group 6 (auto-continue + chronicle-pending), Group 4 app-side (`/billing/return` + polling, pending payment decision).
- **[chat] session:** Groups 1, 2, and the Library/Stream empty-state + search (Group 8).
- **[nav] session:** Group 7 renames + Profile/Channels placement, Group 9 dark-only + advanced toggle.
- **[decision] gating:** Groups 4, 5, and parts of 2/9 wait on the operator decisions above.

---

# Onboarding flow — OPERATOR TO DEFINE

> **The operator (you) will define the onboarding step sequence + copy.** This is the full inventory of every PAGE and FUNCTION from install → full basic functionality, so you can pick which steps onboarding includes, in what order, and what each says. Status: ✅ built · 🟡 partial · 🔴 missing.
>
> "Full basic functionality" = a user can: create/unlock a vault → connect a model → import data → generate their Mycelium → chat with it. (Channels + paid relay/handle are extensions on top.)

### Phase 0 — Install & first launch
- **Pages:** native app launch (Tauri); first-run detection (no `kcv.json`).
- **Functions:** ✅ vault/key detection, ✅ Keychain key storage, ✅ server boot `:8787`, ✅ embed-service `:8091` (supervised), ✅ auto-install/run local Ollama (`MYCELIUM_AUTO_OLLAMA`), ✅ channel daemon supervised (PR #123).

### Phase 1 — Account ceremony (create / restore / unlock)
- **Pages:** Setup screen (create new vault **or** restore from recovery key); Unlock/Login screen (recovery key / passphrase). 🟡 *login UX flagged earlier (operator-email dead-end on local vaults) — vault-native login still unbuilt.*
- **Functions:** ✅ master key gen + recovery-key display, ✅ optional passphrase seal, ✅ restore-from-key, ✅ KCV verify, ✅ vault unlock. 🔴 vault-native local login.

### Phase 2 — Welcome / intro
- **Pages:** 🟡 WelcomeModal (4 steps) + OnboardingGuide card + MindscapeView empty-state — **3 overlapping surfaces to collapse into one** (Group 5).
- **Functions:** ✅ `welcome-seen` flag, ✅ `/onboarding/status`, 🟡 `/onboarding/dismiss` (written, not honored).

### Phase 3 — Connect AI / first model  ← **dedicated beautiful page (Group 2)**
- **Pages:** 🔴 dedicated Connect-AI / Providers page (today it's split across OnboardingGuide + ConnectionsChecklist + Settings→Intelligence — redundant). Model picker.
- **Functions:** ✅ provider store (`ai_providers`), 🟡 set-active (needs auto-activate first), 🟡 model selection (needs explicit, no fallback), ✅ local Ollama model **pull** (Hardware), ✅ inference resolve, 🔴 show active provider+model in UI, 🔴 connection test/"it works" signal.

### Phase 4 — Import data / bring your past
- **Pages:** ✅ Import/Sources page (upload + connectors: Claude, ChatGPT, Obsidian, LinkedIn), ✅ import progress.
- **Functions:** ✅ upload+parse+ingest, ✅ dedup, ✅ enqueue enrichment, ✅ embed drain `:8091`, 🟡 embed count/rate (correct but slow + no rate shown), 🔴 **chunk long content to respect the 512→8192 token limit** (Reframe #10), ✅ connectors framework. 🔴 upload **preview/teaser** (none).

### Phase 5 — Generate Mycelium / topology
- **Pages:** ✅ Mycelium/Mindscape view (empty → generating → territories), ✅ Generate CTA.
- **Functions:** ✅ generate preflight (`MIN_EMBEDDED=5`), ✅ clustering job, ✅ metrics, ✅ chronicle narration (async), 🔴 **embed→cluster auto-continue**, 🔴 "chronicle pending" placeholder, 🟡 single-cluster / sparse viz polish.

### Phase 6 — Chat / core interaction  ← **DESIGN FIRST (Group 1)**
- **Pages:** 🟡 Chat (ChatFloat / chat view).
- **Functions:** ✅ SSE streaming turn, ✅ tool-use over vault tools, ✅ history, ✅ AI-access policy, 🔴 show active model+provider, 🔴 no-fallback + "no model configured" state, 🔴 TTFB timeout + "thinking" indicator + error surface, 🔴 welcome/empty state (kill false "load history").

### Phase 7 — Channels / reach your agent (extension)
- **Pages:** ✅ Channels settings (Telegram/Discord). 🔴 better "connected ✓" confirmation; [decision] own nav section vs Settings.
- **Functions:** ✅ token store, ✅ daemon supervise (PR #123), ✅ inbound + commands, 🔴 **reliable agent reply (force tool-use / settable model — Group 3)**, ✅ authority/access policy.

### Phase 8 — Handle + payment / relay (extension, paid)
- **Pages:** 🔴 handle claim/reserve UI in-app, ✅ checkout link (402→Stripe), 🔴 `/billing/return` route, ✅ billing-portal link.
- **Functions:** ✅ control-plane Stripe (checkout/webhook/entitlement/402), ✅ connect-managed, 🔴 post-pay return + entitlement polling, ✅ frpc/Caddy tunnel. [decision] when to ask / price / handle-timing.

### Phase 9 — Shell / navigation (the surfaces they live in)
- **Pages:** ✅ Sidebar (Mycelium, Library, Streams, Connections), Profile, Settings (7 tabs).
- **Functions:** 🟡 nav (People→Connections rename, remove lower contextual menu, folders under Library, Profile under User), 🟡 theme (dark-only for launch), 🔴 real Library search endpoint + debounce, 🔴 empty-state CTAs (Library/Stream).

---
**Operator: annotate the phases above** (which become onboarding steps, order, copy). Once you define the sequence, I'll fold it into a concrete onboarding design under Group 5.
