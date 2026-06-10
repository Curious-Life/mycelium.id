# Session handoff — chat fix · describe fix · activity stream · UX polish (2026-06-09/10)

**Date:** 2026-06-10
**Companions:** predecessor [SESSION-HANDOFF-2026-06-09-onboarding-ai-ux.md](SESSION-HANDOFF-2026-06-09-onboarding-ai-ux.md) · designs written this session: [AI-SETTINGS-PAGE-DESIGN-2026-06-09.md](AI-SETTINGS-PAGE-DESIGN-2026-06-09.md), [REALM-SIDEBAR-REDESIGN-2026-06-09.md](REALM-SIDEBAR-REDESIGN-2026-06-09.md), [ONBOARDING-LIGHTMODE-GLASS-2026-06-09.md](ONBOARDING-LIGHTMODE-GLASS-2026-06-09.md), [DESCRIBE-PIPELINE-FIX-DESIGN-2026-06-10.md](DESCRIBE-PIPELINE-FIX-DESIGN-2026-06-10.md), [ACTIVITY-STREAM-DESIGN-2026-06-10.md](ACTIVITY-STREAM-DESIGN-2026-06-10.md)
**Audience:** the next Claude Code instance picking up launch-readiness work.

## TL;DR — current state

**10 PRs merged to `main` this session, zero open PRs.** `origin/main` HEAD = `258a415`. Real app running on `:8787` from the merged tree. Everything below is SHIPPED + verified (each PR merged only on a green `verify` CI run; live smokes noted per row).

| PR | main commit | What | Live-verified |
|---|---|---|---|
| #133 | `571e9a6` | Redesigned **AI & Intelligence page** (active-model hero + Local/Cloud lanes) + harness/external-client folded in + legacy "AI Subscriptions" Claude-OAuth block retired (507-line script teardown) + orphaned `IntelligenceSection.svelte` deleted + "harness"→"your AI app" | operator eyeballed |
| #134 | `5ea0809` | **Realm sidebar**: described-aware (placeholder `Realm N`+empty essence detected by CONTENT, not name-presence) → greyed "Area N", softened dots, "Mycelium" breadcrumb dropped, bottom **Illuminate**/Spawn-intelligence CTA | browser |
| #135 | `3230228` | **Onboarding light-mode + glass**: theme-aware `--glass-*` tokens; canvases follow app `[data-theme]` not OS; Intelligence step = hardware recommender (≤6mo, top-3 collapse) + ALL cloud presets incl. EU; progress stepper; ✓ spacing | throwaway + light mode |
| #136 | `eb571c3` | **Connections page** glass redesign + "how it works" + federated `name@server` connect surfaced (existing WebFinger→did:web path, zero backend). Matrix raw-IDs = designed follow-up | browser |
| #137 | `92ae0fc` | **Mindscape 3D load-jitter fix** (debounced geometry rebuild, 180ms coalesce) + model-selector curation: `recommended` flag (top-3 by rankScore, ≤12mo), search box in both selectors, Settings defaults to recommended+recent | live `/hardware/recommend` |
| #138 | `1d38b1b` | **Chat fixed**: reasoning models (`delta.reasoning`) surfaced as `thinking_delta` (was: 90s hang→error); real provider label (was "openai" for Regolo); actionable errors (401/404/429/5xx); TTFB(45s)/idle(60s) split + `responding` event + exp backoff; local models tool-free (28s→10s first token); **switch-provider-from-chat** (model chip menu); header de-dup ("Mycelium" wordmark + broken PipelineStatusChip removed) | curl SSE end-to-end: 10.1s first token, full answer |
| #139 | `7c2a764` | **Describe pipeline fixed**: realms/territories named by the SELECTED provider via `pipeline/lib/narrate-infer.js` (was: `claude -p` CLI → always failed → "Realm N"); local Ollama native `/api/chat` `think:false`+`format:json` (~4s/item vs ~36s on `/v1`); + chat input 0.875rem | named 5/5 realms + 11/11 territories on the real vault ("Contextual Architecture" etc.) |
| #140 | `35a4d60` | **Unified activity feed**: `db.activityFeed` over `background_jobs` (content-free, DB-as-IPC, fail-closed reaper) + `/portal/activity` (+`/pipeline/status`) with live ETA + describe/chronicle per-item progress + MindscapeActivityChip shows "Naming your areas · 5/16 · ~28s left" | live poll climbed N/16 with ETA |
| #141 | `33295d3` | **Header stream dot** (pulsing + count + popover on every page) + clustering folded into the feed (`mycelium_generate` rows) | browser |
| #142 | `258a415` | Embedding/enrichment folded in (read-time projection "Reading your world · N/M") + **`verify:activity`** gate (GO 6/6, in CI chain) | gate |

## What was learned (the lines that die without this doc)

1. **`cargo tauri dev` runs a STALE BUNDLE** unless launched as `MYCELIUM_HOME="$(pwd)" cargo tauri dev`. There is no `beforeDevCommand`; node spawns with `current_dir(home)` falling back to `src-tauri/target/debug/app/` (refreshed only on `tauri build`). This silently ate half a day — "changes not showing" on `:8787` was old code. (`main.rs:46-54`, `tauri.conf.json:8`.) ALWAYS launch dev with `MYCELIUM_HOME`.
2. **Reasoning models stream thinking in `delta.reasoning`/`reasoning_content` with empty `content`** (Ollama gemma3/4, qwen3, DeepSeek-R1). Any consumer that only reads `delta.content` sees a dead stream. Chat fixed in `harness.js`; describe sidesteps it via native `/api/chat think:false`. Watch for OTHER consumers (gateway? channel-daemon backends — note untracked `packages/channel-daemon/agent/backends/*` edits in someone's tree).
3. **Tools attached to a small local model ≈ 3× first-token latency** (gemma4:12b: ~28s with tools vs ~11s without, measured). Ollama constrains decoding to the tool grammar. portal-chat now sends `tools: []` for local providers.
4. **Ollama's OpenAI-compat `/v1` ignores `think:false` AND `response_format`** for reasoning models; the NATIVE `/api/chat` honors both (~4s vs ~36s per describe item). Use native for local batch inference (`pipeline/lib/narrate-infer.js`).
5. **The pipeline writes literal placeholder names** (`Realm N`, essence `''`) when describe fails — name-presence is NOT a "described" signal; content-match is (`/^realm\s+\d+$/i` OR empty essence → undescribed). `MindscapeDetail.svelte` `isRealmDescribed()`.
6. **`d1QueryAdmin` returns `{results:[...]}`, not a bare array** (same as audit.js). My first activityFeed reads silently returned `[]` for an hour. Unwrap with `Array.isArray(r) ? r : r?.results`.
7. **Heartbeat starvation**: a per-item-only heartbeat dies under the 45s reaper when the first model call is cold. Describe children run a 10s liveness `setInterval` alongside item ticks.
8. **`db.activity` was already taken** (desktop screen-time namespace) — the jobs feed is `db.activityFeed` (`src/db/activity-feed.js`).
9. **`verify:chat` CI failed on my improved error copy + new TTFB budget** — test asserted the old string and lacked `MYCELIUM_CHAT_TTFB_MS` override. When changing chat reliability semantics, update `scripts/verify-portal-chat.mjs` C5–C7 in the same PR.
10. **Repo has auto-merge DISABLED** — `gh pr merge --auto` fails. Pattern used all session: background watch-loop polling `verify` conclusion → `gh pr merge --squash --delete-branch` on SUCCESS only (fail-closed).
11. **`clustering_points` persists** in the app DB (`~/Library/Application Support/id.mycelium.app/mycelium.db`) — describe-clusters can be re-run standalone anytime: read keys via `src/account/keystore.js` `readUserMaster()`+`deriveSystemKey()`, set `MYCELIUM_DB` to the app DB. `data/mycelium.db` in the repo is an empty dev DB — wrong target.

## Operator's directional calls (this session)
- Fold harness/Subscriptions cleanup INTO #133 (not follow-up); merge-on-green without further review for #133/#134.
- Connections: "both — federated now, Matrix next" (raw `@user:homeserver` is a designed follow-up, backend-heavy).
- Activity: UNIFIED aggregator over focused-chronicle-only (chose the bigger build).
- Describe must use "the default model that is selected" (the active provider) — locked.
- Model curation: only models <6mo in onboarding, contained/expandable list, "recommended from us" badges, search.

## Production state (single box — operator's Mac)
- App: `:8787` via `MYCELIUM_HOME="$(pwd)" cargo tauri dev` from repo root @ `main` `258a415`. Verify: `curl -s localhost:8787/api/v1/portal/activity` → `{"active":[...],"recent":[...]}`.
- Operator's realms ARE named (gemma4:12b ran live): "Contextual Architecture", "AI Capability Testing", "System Security & Ops", "Travel Cost Estimation", "Routine Optimization".
- Active provider: local `gemma4:12b` (id 2). Regolo row (id 1) is `status:error` — `qwen3.6-27b` likely an invalid Regolo model name; chat now surfaces the actionable reason. Throwaway vault recipe (isolated keychain + `MYCELIUM_EMBED_PORT=8092`) in the 2026-06-09 handoff.
- Untracked NOT-mine files in the tree: `packages/channel-daemon/agent/backends/openai-compat.js` (+ modified `ollama.js`), `* 2.svelte` Finder junk, `.claude/launch.json` — leave alone.

## Open decisions for the operator
1. **Regolo model name** — give a valid one to close the cloud-chat loop end-to-end (errors are now actionable either way).
2. **Matrix raw-ID connect** — green-light the design phase? (needs `.well-known` resolution + storage + homeserver config; new security surface).
3. **Clustering-skew rebalance** (`pipeline/cluster.py:822-853` `centroids_to_groups`, variance-blind → one realm balloons: 81 pts vs 3) — next big quality item, carried from 2026-06-09.
4. Parked: Stripe flip (#12 code-ready), relay go-live (plan `~/.claude/plans/swift-nibbling-catmull.md`), app notarization.

## Pickup protocol — next session
1. Read this handoff cold; skim the 2026-06-09 predecessor for the throwaway-vault recipe + onboarding context.
2. `git log --oneline -3 origin/main` → expect `258a415` at HEAD (or newer).
3. If launching the app: **`MYCELIUM_HOME="$(pwd)" cargo tauri dev`** — never bare (gotcha #1).
4. Smoke the new surfaces: chat streams with thinking (gemma); model chip switches provider; Illuminate → header dot + chip count N/16 with ETA; realms show real names.
5. Likely next: clustering-skew rebalance (sweep-first — `cluster.py` is load-bearing), or Matrix raw-ID design, or launch-checklist items.
6. Gates for touched surfaces: `verify:chat` / `verify:chronicles` / `verify:generate` / `verify:activity`; `portal:check` 0 errors for any portal change; rebuild via `npm --prefix portal-app run build` (tauri dev serves `portal-app/build` from disk).

## Failed approaches (don't retry)
- `stream_options: include_usage` as the chat-hang cause — disproven by live repro; Ollama accepts it fine. The real cause was reasoning-deltas (gotcha #2).
- Stdout `[progress]`-line parsing for describe progress — dropped for direct DB writes (children already `getDb()`; the DB is the IPC channel; survives restarts).
- Testing describe against `data/mycelium.db` — empty dev DB, `no such table: clustering_points`; the app DB is under Application Support (gotcha #11).
