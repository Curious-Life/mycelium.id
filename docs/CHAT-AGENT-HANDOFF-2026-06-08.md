# Chat Agent — Build Handoff (2026-06-08)

**Branch:** `feat/chat-agent-harness` (off `bf5ad4b`)
**Design:** [docs/CHAT-BACKEND-DESIGN-2026-06-08.md](CHAT-BACKEND-DESIGN-2026-06-08.md) (v3 + AS-BUILT section)
**Status:** Built + verified. Not yet smoke-tested in the full Tauri desktop build (gate below).

## TL;DR

The in-app floating chat is now a **real, provider-agnostic, tool-using agent** over the vault — web + Tauri share the same build. One user turn → think · call vault tools in-process · answer → idle (bounded; not the autonomous loop D5 defers). It drives whatever provider the user selected (Anthropic native / OpenAI-compatible / EU-ZDR / local Ollama). What the agent may touch is governed by an **"AI Access"** settings panel (tool-domain grants).

## What landed

| File | Change |
|---|---|
| `src/agent/harness.js` (new) | Provider-agnostic tool-use loop: Anthropic (`tool_use`) + OpenAI-compat (`tool_calls`) adapters; no-tool fallback; `maxIterations` cap; abort; per-call egress audit (hash+len only). |
| `src/agent/tool-domains.js` (new) | The grantable "areas" (13 domains → tool names); `toolsForDomains` (fail-closed intersect with live registry); policy defaults/normalize. |
| `src/portal-chat.js` (new) | `GET /agents`, `GET /chat/history`, `POST /chat/stream` (SSE), `GET/PUT /ai-access`. Loads policy → getContext preamble + retrieval → harness → persist both turns (`source:'portal-chat'`). |
| `src/inference/cloud.js` | Exported `openStream`/`ssePayloads`/`postJson` for the harness. |
| `src/server-rest.js` | Mounted `portalChatRouter` in `buildVaultSubApp` (loopback-trusted auth). |
| `src/portal-compat.js` | Removed the placeholder `GET /agents → {agents:[]}` stub (shadowed the real endpoint). |
| `portal-app/.../chat/ChatFloat.svelte` | Stream fetch `/portal/chat/stream` → `/api/v1/portal/chat/stream` (the 404 fix). |
| `portal-app/.../+layout.svelte` | Cmd/Ctrl+J → `toggleChat`. |
| `portal-app/.../shell/Header.svelte` | Chat launcher button (active state on `chatOpen`). |
| `portal-app/.../settings/AIAccessSection.svelte` (new) + `SettingsView.svelte` | The AI Access panel (domain toggles) + mount. |
| `scripts/verify-harness.mjs`, `verify-portal-chat.mjs` (new); `package.json` | `verify:harness` (23 checks) + `verify:chat` added to the `verify` chain. |
| `scripts/verify-nav.mjs` | N6 flipped from "chat hidden" → "chat live". |

## Verification (all GO)

- `npm run verify:harness` — Anthropic + OpenAI tool loops, no-tool fallback, cap, tool-error recovery, audit (hash+len, no plaintext), abort. 23/23.
- `npm run verify:chat` — real booted vault: auth fail-closed (401), SSE stream, persistence, history (no `entities/tags/metadata` leak), policy round-trip + fail-closed tool filter, provider-error → graceful `error` event with no leak. 5/5 stable.
- Full-server smoke: `/api/v1/portal/agents` + `/ai-access` reachable through `startRestServer` (caught + fixed the `/agents` shadowing stub).
- `portal-app`: `svelte-check` 0 errors (1 pre-existing unrelated `tsconfig` node-types warning); `npm run build` clean.
- Inference neighbors unaffected: `verify:{resolve,egress,cascade,inference,gateway-stream,gateway-tools}` GO.

## Known limitations / follow-ups (see design §14)

1. **Data-scope restriction is deferred.** `AGENT_SCOPES` is process-env-global (not per-request), so v1 enforces "areas" at the **tool-domain** level (fully enforced). Restricting the AI from a *data scope* (e.g. `wealth`) specifically needs `allowedScopes` plumbing through handler→db→decrypt. Policy already stores `scopes` forward-compatibly; `getContext` already withholds `sensitive`-marked rows.
2. **Adaptive thinking not sent** (cross-model safety) — opt Opus 4.x into `thinking:{type:'adaptive',display:'summarized'}` later.
3. **Tool-confirmation UI** — destructive/egress tools (`forget`, `publishDocument`, mind-file overwrites) ARE grantable (full access within an area, per operator decision), but a per-call confirmation round-trip would be a good defense-in-depth addition.
4. **Relay/secure-channel chat parity** — local web/Tauri use the plain fetch path; the encrypted `channel.requestStream('chat')` path is untouched.

## Pickup gate before launch

- **Tauri desktop smoke** (Step 7): `npm run tauri build` (or dev), open the app, Cmd+J, send a message with a real provider configured in Settings → confirm streaming + a tool pill + persistence. Same `127.0.0.1:8787` build, `csp:null`, WKWebView SSE — expected to work with no code change; this is the verification gate.
- **Live-provider smoke**: configure an Anthropic/OpenAI/EU key in Settings → Intelligence, then chat. (The verify scripts stub the provider stream.)

## NOT part of this branch (left in the working tree, do not attribute here)

`portal-app/.../shell/Sidebar.svelte` + `BottomTabBar.svelte` carry an unrelated in-flight nav redesign (TimelineNav→PeopleNav, `/streams` `/connections`). That work owns `verify:nav` N1/N4/N5 (still failing against the old expected nav set). I only updated N6 (chat).
