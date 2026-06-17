# Streams — Phase 3 (Manage-sources drawer) + Phase 2.1 (river search) — Design

**Date:** 2026-06-17
**Branch:** `feat/streams-river-phase2` (worktree `mycelium-worktrees/prelaunch-remaining`) — this branch also **re-lands Phase 2**, which merged onto a side branch but never reached `main` (#214 merged at the Phase-1 commit `fc7073e`; Phase 2 commits `968bc20`/`026849d` were stranded on `feat/streams-river-phase2`). So this PR delivers **Phase 2 + Phase 3 + Phase 2.1** together.
**Builds on:** `docs/STREAMS-PAGE-REDESIGN-DESIGN-2026-06-17.md` (D-B: river-first, Sources in a drawer) + `docs/STREAMS-RIVER-PHASE2-DESIGN-2026-06-17.md`.
**Protocol:** `/sweep-first-design` — 2 sweeps (drawer/UI patterns + search infra), file:line, security red-team.

---

## A. Phase 3 — "Manage sources" drawer (decision D-B)

### Sweep facts
- `StreamsView.svelte` facets = `stream | sources | body`; the `sources` facet renders `<ImportView/>` (imports + connector health). Facet param is mirrored to `/streams?facet=…` (`workspace/store.ts:146`).
- **Every entry into Sources routes via `facet=sources`**: the `/import` route page (`routes/(app)/import/+page.svelte:6`), `/streams?facet=sources` (`routes/(app)/streams/+page.svelte:8`), the store URL map (`store.ts:146`), and ≥4 onboarding/checklist links → `/import` (`OnboardingFlow.svelte:184`, `OnboardingGuide.svelte`, `ConnectionsChecklist.svelte`). **All must keep working.**
- No reusable Drawer/Sheet exists; the **share-viewer modal** (`ConnectionsView.svelte:576`, styles `:762`) is the reuse template (fixed backdrop, `stopPropagation` panel, ✕ close, `max-height` + scroll). `WelcomeModal.svelte:200` adds the slide/fade keyframes + Escape + focus-on-open.
- `ImportView` owns its scroll via `h-full overflow-y-auto` (`:449`) and centers `max-w-2xl` — fits a drawer once the outer scroll wrapper defers to the drawer body.

### Design
- **Keep the `sources` facet PARAM** (so all deep-links work untouched) but **render it as a right-side slide-over drawer**, not a co-equal tab. When `current === 'sources'` → drawer open over the stream facet (river stays mounted behind); closing → `setParams({ facet: 'stream' })`.
- **Segmented control** becomes `Stream | Body`; add a right-aligned **"Manage sources"** icon+label button in the seg bar that opens the drawer (`setParams({ facet: 'sources' })`).
- **New `Drawer.svelte`** (small, reusable): right slide-over, `open` + `onClose` props, backdrop click + Escape close, focus-trap on open, `transform: translateX` slide. Mirrors the share-modal CSS + WelcomeModal keyframes. (First real Drawer in the app — kept generic for later reuse.)
- **`ManageSourcesDrawer`** = `Drawer` wrapping `<ImportView/>` (drop ImportView's outer `h-full overflow-y-auto`; the drawer body scrolls). Title "Manage sources", ✕ close.
- Lazy-mount: the drawer (and ImportView's connector fetch) only mounts once opened.

### Why keep the param (not a pure local boolean)
Deep-links (`/import`, onboarding "Bring your world in") are the primary path to connect data; routing them through the existing `facet=sources` param means **zero churn** to 6 call sites and the URL stays shareable/bookmarkable. The drawer is a *rendering* of that state, not a new state.

---

## B. Phase 2.1 — river search

### Sweep facts (corrected: the search-sweep cited `reference/` which is NOT live code — CLAUDE.md)
- Semantic search (`searchMindscape` → mind-search ANN) covers **messages + documents** only (they have `embedding_768`); **health_daily + tasks have no embeddings** and are not semantically searchable.
- **No FTS5, no blind-index, no keyword fallback, no portal search endpoint, no search UI** exist (`migrations/*` have no `CREATE VIRTUAL TABLE`; the at-rest FTS plan is designed-not-built per memory `pipeline-integrity-search-scaling`).
- Semantic search needs the embed service running (503 + Retry-After otherwise).

### Decision — keyword substring over a bounded recent window, NOT semantic
A river search box reads as **keyword filter** ("find the message about flights"), not semantic similarity — and must work uniformly across all four types, including the un-embedded health/tasks, **without** an embed-service dependency. So:
- **Fold a `q` substring filter into `db.streams.feed`** (reuses its explicit-column, vector-free, auto-decrypting per-table reads + the `hasVectorKey` egress guard — no new data surface).
- When `q` is set, each arm scans up to **`SEARCH_SCAN` (=800)** most-recent rows in the window, the row decrypts at the adapter, and we keep rows whose searchable text contains `q` (case-insensitive): message → `content`; document → `title + summary`; health → the day summary + `date`; task → `title`.
- Merge matches by `created_at DESC`, return up to **`SEARCH_RESULT_CAP` (=100)**, `nextCursor: null` (search is a **single bounded pass, not paginated**). Return `truncated: true` when matches exceed the cap so the UI can say "showing the first 100 — refine your search".
- **Scope is honest:** search covers "what's recently flowing" (the SEARCH_SCAN window), surfaced in the UI as "searching recent streams". Deep/full-vault + semantic search stays the **Mindscape** surface (separate; the future FTS/at-rest index supersedes this when it lands).
- `q` **composes** with the spectrum `sources` filter and `types` (q AND source AND type).

### Why not semantic / not deep-paginated
- Semantic over messages-only would miss health/tasks, behave surprisingly for exact-term lookups, and hard-depend on the embed service. Keyword is the right primitive for "filter the river".
- Deep cross-table cursor pagination *with per-source scan caps* is a correctness trap (skipping matches below the shallowest-scanned arm). A single bounded pass with a clear cap avoids it entirely and matches the feature's intent. The future FTS index is the right home for ranked, paginated, full-history search.

### Endpoint + UI
- `GET /portal/streams?...&q=<text>` (extend the existing route; no new endpoint).
- `StreamRiver` gets a **debounced search box** (top of the river, below the spectrum). Typing sets `q` → refetch; clearing restores the live feed. Result count + the "recent streams" scope hint + the `truncated` notice. Search + spectrum-chip + (later) time-scope compose.

---

## C. Security red-team
- **§7 unchanged + still enforced**: search reuses `feed`'s explicit vector-free projections + `assembleTimelineMessages` (metadata strip) + the final `hasVectorKey(items)` throw. The substring filter runs on *already-decrypted, already-vector-free* item text — it adds no new column, no new surface.
- **No query logging**: `q` is user plaintext about their own vault; it is NEVER written to logs/audit/DB (search is read-only, stateless). 
- **Owner-only**: same `/portal/*` vault-auth gate; the drawer + search add no public surface.
- **Bounded cost / DoS**: `SEARCH_SCAN` (800/table) + `SEARCH_RESULT_CAP` (100) cap decrypt + payload size; `q` length clamped; `limit` already clamped.
- **Drawer**: pure presentation of existing `facet=sources` state + existing ImportView (already owner-gated). No new data path.

## D. Verify
- Extend **`verify:streams-feed`**: with `q` set → returns only matching items across all four types; case-insensitive; respects `types`/`sources`; `truncated` flag past the cap; **§7 still holds** (no vector/metadata leak in search results); empty `q` ≡ normal feed.
- **`verify:nav`** must stay GO (the drawer keeps `facet=sources` reachable — assert the param/route still resolves).
- `portal:check` + `vite build`; **browser live-verify**: open Manage-sources drawer (connectors render, Escape/backdrop close), type a search term (river narrows to matches across types, count + scope hint show), clear (live feed restored).

## E. Build order
1. `feed()` gains `q` (+ `SEARCH_SCAN`/`SEARCH_RESULT_CAP`/`truncated`); route passes `q`; extend the gate. (backend, gated)
2. `Drawer.svelte` + `ManageSourcesDrawer`; StreamsView swaps the Sources tab → "Manage sources" button + drawer (param preserved). (frontend)
3. `StreamRiver` search box wired to `q`. (frontend)
4. Browser live-verify; living-docs.

## F. Out of scope
- Ranked relevance / semantic search / full-history pagination → the at-rest FTS index (separate, designed-not-built).
- Time-scope (Today/7d/All) control — trivial follow-up on the existing `since` param.
