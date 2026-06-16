# Pre-Launch UX Fixes — Handoff Doc

**Date:** 2026-06-16
**Spec:** `~/Downloads/mycelium-coding-agent-spec-2026-06-16.md` (20 tasks, P0/P1/P2)
**Companions:** memory note `portal-ui-live-verify.md` (live-verify recipe + git-recovery + relaunch gotchas)
**Audience:** the next Claude Code instance picking up the 4 remaining feedback points.

---

## TL;DR — current state

**13 of 17 assigned (P0 + all P1) spec items DONE, verified, merged to local `main`, and LIVE in the running app.** 4 remain (all net-new, decisions locked). The fresh session starts with a **3-fold sweep on #19**.

| Commit (on `main` = `b22fde0`) | Spec items | Verified |
|---|---|---|
| `5648e3f` | **#15/#16/#17** nav→semantic `<a href>` anchors (modified-click new-tab + 400ms double-fire guard); **#2** escapable onboarding modal (ESC + click-outside + ×); **#20** "Reading your world"→"Weaving your world" + activity-chip minimize | browser (nav as `link:`) + svelte-check |
| `26a4184` | **#6/#8/#9** AI config — `src/inference/models.js` (`listModels`) + `POST /portal/providers/models` + `GET /providers/:id/models`; AISettings "Load models" datalist + "Custom endpoint / agent handler" option | verify:providers GO + unit + svelte-check + **LIVE** (returned real Ollama models) |
| `b22fde0` | **#4** agent name & personality — `users.settings.agent`; `GET/PUT /portal/agent-identity`; `/agents` returns chosen name; chat system preamble; onboarding welcome field + Settings "Your assistant" lane | verify:chat GO + svelte-check + **LIVE** (`/agent-identity`→200 JSON) |

**Verified already-satisfied in `main`** (the spec was written against an OLDER running bundle): **#18** (no ex-libris theme / thin-minimal option; the only `exlibris_url` is a profile bookplate IMAGE — preserved, NOT deleted), **#5** (onboarding rail shows "Using <provider>"+✓), **#1** (welcome modal already glassmorphic), **#12 P0** ("No memes" placeholder gone; Sources facet has `/portal/connectors` list + Channels toggle), **#3** (onboarding import step → Streams Sources, same backend).

**REMAINING (4, net-new, NOT built):** #19 public space + context areas · #10 MCP/webhook streams · #13 connections galaxy · #11 streams redesign.

---

## 2026-06-16 session summary — start here when picking up

### What shipped
- 3 commits above on branch **`claude/prelaunch-ux-v2`** in worktree **`/Users/altus/Documents/GitHub/mycelium-worktrees/prelaunch-ux`** (off clean `origin/main`). Local `main` fast-forwarded to `b22fde0`.
- The updated payload is **LIVE in `/Applications/Mycelium.app`** (relaunched + verified — see Production state).

### What was learned (MOST IMPORTANT — these die if not read)
1. **The spec was written against an OLDER bundle.** ~5 of the 20 items (#1/#3/#5/#12/#18) were already satisfied in current `main`. ALWAYS read the current code before building a spec item — several "build this" items are "already done." The #18 "remove ex-libris" item would have **wrongly deleted a real profile-bookplate feature** (`exlibris_url`) if taken literally.
2. **The 4 remaining items overlap existing systems** — building them blind risks confusing parallel features. Operator locked the directions (see Open decisions): **extend, don't duplicate.**
3. **`main` had been silently ROLLED BACK to a stale commit** (`221ab0d`) by repo corruption / a concurrent session, while the true `origin/main` is `337c942` (10 commits ahead). A naive merge onto the stale ref would have **regressed** the at-rest/bearer/harness/enrich work. CHECK `git rev-parse origin/main` vs local `main` before any merge here.
4. **A concurrent Claude session was operating on the same repo** — it moved/clobbered the original `claude/prelaunch-ux-fixes` branch and reverted my uncommitted work once. Hence the isolated worktree. That branch's ref is still locally corrupt (its own recovery).

### Operator's directional calls
- **Scope:** P0 + all P1 (17 tasks), live-verify each.
- **Recovery:** recreate clobbered work in an isolated worktree (done).
- **#19 Context Areas:** EXTEND the existing Sharing-contexts (`db.contexts`) with AI summary + optional doc attachments — NOT a parallel system.
- **#13 galaxy + #11 redesign:** DEFER until the env was stable enough to live-verify (it now is).
- **This session:** clear up (git) → merge → relaunch the updated app → write this handoff. **Next session:** the 4 remaining, starting with a 3-fold sweep.

### Pickup protocol for the next session
1. Read this handoff cold + the `portal-ui-live-verify` memory note.
2. `cd /Users/altus/Documents/GitHub/mycelium-worktrees/prelaunch-ux` (= `main` + UX work; node_modules symlinked from the main repo).
3. Verify state: `git -C . log --oneline -4` → top is `b22fde0`. `git -C /Users/altus/Documents/GitHub/mycelium.id rev-parse main` → `b22fde0`.
4. **Run `/sweep-first-design` (3 cycles) on #19** before any code — it touches shared abstractions (`db.contexts`, `user_profiles`/`handle`, publish pipeline, `users.settings`). Inventory: how do "context areas" relate to Sharing-contexts, Spaces, territories, Library docs, and the publish surface? How does "public space" relate to the existing Profile pane (`handle` = public slug) + publish?
5. Build → `/deploy-and-verify` (svelte-check + a new `verify:*` gate + live-verify via the browser preview, now viable).
6. Live-verify recipe is in the memory note (vite dev :5174 proxied to live :8787; OR — since the app is live — relaunch via the payload-swap recipe).

### Open decisions for the operator
- **Push `main` upstream?** Local `main` = `b22fde0` is 3 commits ahead of `origin/main` (`337c942`); NOT pushed. Recommend a PR (UX changes are low-risk but include backend endpoints). Say the word.
- **#10 MCP/webhook streams:** add as connector *types* in `/portal/connectors` (additive UI) — but the ingestion worker is real backend. Scope the worker first.

---

## Engineering principles that earned their keep
- **Read current code before building a spec item.** 5 of 20 items were already done; one (#18) would have deleted a real feature. The spec is a wish, not the source of truth — the code is.
- **Verify the merge BASE, not just the merge.** `git rev-parse origin/main` caught a stale-`main` rollback that a fast-forward would have silently regressed across 10 merged commits.
- **Adversarial diff before an in-place swap.** Diffing the installed app's `portal-chat.js`/`portal-providers.js` against the worktree proved the only differences were my additions → safe to overlay without a Rust rebuild.
- **The completeness check is cheap insurance.** `build-app-bundle.sh`'s node_modules preflight caught a missing `undici` that would have crashed the app on boot.

---

## Commit detail

### `5648e3f` — nav anchors + modal + copy (#15/#16/#17/#2/#20)
- `portal-app/src/lib/components/shell/Sidebar.svelte`, `BottomTabBar.svelte` — `<button onclick=goto>` → `<a href>` + modified-click passthrough + 400ms same-target guard.
- `portal-app/src/lib/components/onboarding/OnboardingFlow.svelte` — welcome modal: ESC + click-outside-backdrop + × button (+ `tabindex="-1"` a11y).
- `portal-app/src/lib/components/mindscape/MindscapeActivityChip.svelte` — copy + minimize-to-dot.
- `portal-app/vite.config.ts` — dev-only proxy (`/api /auth /oauth /mcp /.well-known` → :8787). Build/prod unaffected.

### `26a4184` — AI config models (#6/#8/#9)
- `src/inference/models.js` (NEW) — `listModels()` (Anthropic `/v1/models` + OpenAI-compat `/models`, SSRF guard, dedup, category errors).
- `src/portal-providers.js` — `POST /providers/models` + `GET /providers/:id/models`.
- `portal-app/src/lib/components/settings/AISettings.svelte` — "Load models" datalist auto-fill + "Custom endpoint / agent handler" option. OpenRouter already in `PROVIDER_PRESETS`.

### `b22fde0` — agent name & personality (#4)
- `src/portal-chat.js` — `users.settings.agent`; `GET/PUT /agent-identity`; `/agents` returns chosen name; system preamble leads with name + personality.
- `portal-app/.../onboarding/OnboardingFlow.svelte` — welcome name + personality field.
- `portal-app/.../settings/AISettings.svelte` — "Your assistant" lane.

---

## Production state

**`/Applications/Mycelium.app` (the running app — NOT the dev build at `src-tauri/target`) is updated + relaunched + verified 2026-06-16.**

Payload-swap recipe used (no Rust rebuild — my commits don't touch `src-tauri`, and entitlements have `disable-library-validation`): copied 3 changed `src/` files + `ditto`'d `portal-app/build` into `/Applications/Mycelium.app/Contents/Resources/app/` → `xattr -cr` → `osascript -e 'tell application "Mycelium" to quit'` → `open`.

Verification commands (re-confirm a fresh session):
```
curl -s http://127.0.0.1:8787/api/v1/portal/agent-identity
# expected: {"name":"Mycelium","personality":"friendly","personalities":[...]}
curl -s -X POST -H 'content-type: application/json' \
  -d '{"provider":"custom","base_url":"http://127.0.0.1:11434/v1"}' \
  http://127.0.0.1:8787/api/v1/portal/providers/models
# expected: {"ok":true,"models":[...real Ollama models...],"error":null}
curl -s http://127.0.0.1:8787/api/v1/portal/agents   # name reflects identity
```
Vault data lives at `~/Library/Application Support/id.mycelium.app` (Tauri app_data_dir) — untouched by the code swap.

---

## Gotchas + lessons (dated)
- **The running app is `/Applications/Mycelium.app`, not the dev build** (`src-tauri/target/.../Mycelium.app`). Swapping the dev build does nothing to the live app. (2026-06-16)
- **Git pack truncation from interrupted gc** → recover via quarantine + `unpack-objects -r` + remove `.git/objects/info/commit-graph*` + `git fetch --refetch`; a broken worktree HEAD (dead `2783be5`) blocks fetch — point `.git/worktrees/<wt>/HEAD` at a live SHA first. (2026-06-16)
- **`rsync` HANGS at exit under high load** (process sleeps holding the last file) — use `ditto`, or kill rsync once `du` source/dest sizes match. The full `build-app-bundle.sh` staging stalls under load; delta-copy only changed files instead. (2026-06-16)
- **Bash/preview sandbox hangs `vite`** (esbuild dep-opt sleeps at 0% CPU) — run with `dangerouslyDisableSandbox` to warm `.vite`, then preview_start launches from cache. A wedged vite is fixed by `rm -rf portal-app/node_modules/.vite .svelte-kit`. (2026-06-16)
- **`portal-app/node_modules/tailwindcss` was filesystem-corrupt** (`evaluateTailwindFunctions.js` bytes-present-but-unreadable) → `rm -rf node_modules/tailwindcss && npm install tailwindcss@3.4.17`. `npm install` alone doesn't fix (version unchanged). (2026-06-16)
- **macOS iCloud sync storm** (`cloudd`/`bird`) drove system load to 33 and stalled everything — this repo is NOT in iCloud (verified `~/Documents` is local), the load was the broader account. (2026-06-16)

---

## Plan for the 4 remaining items (for the 3-fold sweep)

### #19 — Public space + context areas (start here)
- **Context Areas** (decision: EXTEND Sharing-contexts): `db.contexts` already does named groups of mindscape **territories** shared with **connections** (the "Sharing" view + 10 `/contexts/*` endpoints in `src/portal-compat.js`). Add an AI `summary` + optional attached document paths in `users.settings.contextAreas[id]` (avoids a migration); surface as "Areas" with a summary view; feed the AI as life-domain context.
- **Public Space**: the Profile pane (`user_profiles.handle` = public slug, `GET/PUT /profile`, handle-availability check + publish pipeline) already IS the public surface. Add `users.settings.publicSpace = {enabled, showProfile, showPublished}` + `GET/PUT /portal/public-space` + an enable/visibility card.
- SettingsView panes = `GROUPS` registry (`portal-app/src/lib/views/SettingsView.svelte:127`) + `{#if activePane==='x'}` render blocks + an import + an icon-switch case (`:1075`). Adding a pane = PaneDef + block + import + icon.

### #10 — MCP/webhook streams
- Stream-source registry is `/portal/connectors` (Gmail/Linear) rendered by `ImportView.svelte` (Sources facet). Add `mcp` + `webhook` connector types + config forms (MCP server URL/bearer; webhook endpoint). The ingestion worker (poll MCP / receive webhooks) is the real backend lift — scope it in the sweep.

### #13 — Connections galaxy · #11 — Streams redesign
- Canvas/visual; build against the **live browser preview** (memory note recipe) to verify 60fps + the "quiet engine room" look. Connections route: `src/routes/(app)/connections/`. Streams: `StreamsView.svelte` (already clean Stream/Sources facets).

---

## Pickup checklist (execute step-by-step)
1. Read this handoff cold. Don't skim.
2. `cd /Users/altus/Documents/GitHub/mycelium-worktrees/prelaunch-ux`; confirm `git log -1` = `b22fde0`.
3. `/sweep-first-design` × 3 on **#19** (the operator's chosen starting point).
4. Build #19 → svelte-check + a new `verify:*` gate + live-verify.
5. Then #10, then #13/#11 (visual, browser-verified).
6. After each ships: `/deploy-and-verify`, and relaunch the app via the payload-swap recipe to put it live.
7. End of that session: update this handoff (append a dated section).
