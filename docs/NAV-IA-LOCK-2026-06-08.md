# Navigation IA — Locked Scope for Launch (2026-06-08)

**Status:** scope-lock in progress. Drives the navigation refactor *and* the
"delete what's beyond scope" prune that follows once this is signed off.
**Author:** full-UI-review pass (familiarization sweep + route census + view-purpose analysis).
**Pairs with:** [LAUNCH-PREP-CHECKLIST-2026-06-08.md](LAUNCH-PREP-CHECKLIST-2026-06-08.md) (C2 — no-backend screens), [UX-COMPLETE-DESIGN-2026-06-01.md](UX-COMPLETE-DESIGN-2026-06-01.md).

> The workspace shell (VS Code–style split panes + draggable tabs, `lib/workspace/`)
> is **kept** — confirmed. This doc is only about the *navigation surface* (sidebar /
> header / bottom tab bar / registry) that feeds it, not the pane system.

---

## Decisions locked

| # | Decision | Choice |
|---|----------|--------|
| 1 | Split-pane workspace | **Keep** as-is |
| 2 | Import + Timeline | **Merge → "Streams"** (sources/connectors + live incoming feed) |
| 3 | Library vs Spaces | **Relate, don't merge** — Library = private knowledge; Spaces = shared/collaborative |
| 4 | Connections + Spaces + Sharing | **Group → "People"** (Connections is the entry; Spaces + Sharing are contextual sub-nav) |
| 5 | Built-but-unshipped future pages | **Leave for now.** Lock scope first, then prune what's beyond it |

---

## Target top-level navigation

8 core items + roadmap → **5 destinations** + Curious Life + pinned Profile/Settings.

| Top-level | Absorbs (viewIds) | What it answers | V1 backend |
|---|---|---|---|
| **Mycelium** | `mindscape` | the map of your mind | ✅ |
| **Library** | `library` | your knowledge / documents | ✅ |
| **Streams** | `import` + `timeline` | where your data comes from + what's flowing in | ✅ both |
| **People** | `connections` + `spaces` + `contexts` | your federated world | ⚠️ see open question |
| **Curious Life** | `curious-life` | who you're becoming (aspirational, set apart) | ✅ view exists |
| _(pinned bottom)_ **Profile**, **Settings** | `profile`, `settings` | identity & config | ✅ |

### Streams (merge of Import + Timeline)
One workspace view with an in-view segmented control, two facets:
- **Stream** (default) — the live incoming feed = current `TimelineView` (telegram / discord / whatsapp / portal, source + channel filters). Keeps its contextual sidebar (`TimelineNav`).
- **Sources** — manage inputs/connectors + run imports = current `ImportView` (Obsidian / ChatGPT / Claude / LinkedIn exports + live connectors: Gmail, Linear).

Implementation: a `streams` registry view hosting the segmented control; `/import` and `/timeline` route intents both open `streams` with a facet param so existing deep-links keep working.

### People (group of Connections + Spaces + Sharing)
- Top-level **People** opens **Connections** (federation: handles, mindscape overlap, accept/reject).
- Contextual sub-nav (sidebar's existing contextual region) lists: **Connections · Spaces · Sharing**.
- `Spaces` = multi-member shared knowledge containers (members, roles, shared knowledge).
- `Sharing` (`contexts`) = privacy scopes — bundles of territories you grant to connections.

### Library vs Spaces
**Relate, don't merge.** Library stays in the knowledge cluster (yours/private); Spaces lives under People (shared/collaborative). The private↔shared boundary is load-bearing for a privacy-first vault — merging would blur it.

---

## Naming reconciliation (collisions found in the sweep)

The social cluster names are tangled today and must be made consistent:

- **BUG:** [Header.svelte:38](../portal-app/src/lib/components/shell/Header.svelte) maps `contexts → "Spaces"`, colliding with the real `spaces` view; the sidebar/registry call `contexts` **"Sharing"**. → Header must say **"Sharing"** for `contexts`.
- **BUG:** `ContextsView.createContext()` toasts **"Space created"** for a *context*. → fix to "Sharing scope created" (or equivalent).
- Final terms: `mindscape` → **"Mycelium"**, `import`+`timeline` → **"Streams"**, `connections` group → **"People"**, `contexts` → **"Sharing"**, `spaces` → **"Spaces"**.

---

## In-scope vs Roadmap (drives the prune)

**In scope for launch (ship):** `mindscape`, `library`, `import`, `timeline`, `connections`, `spaces`, `contexts`, `curious-life`, `profile`, `settings`, `space` (detail), `claims`.

**Roadmap — real pages already built, NOT in the workspace registry, only reachable by direct URL** (the "Coming later" chips). To be pruned once scope is signed off:
`agents`, `cycles`, `wealth`, `intel`, `body`, `vitality`, `activity`, `media`, `fleet`, `modules`, `chat` (redirects to mindscape).

> These are substantial (intel ~2000 LOC, vitality ~900, plus wealth/body/activity/media/agents/cycles/fleet/modules). They have **no V1 backend** (launch-checklist C2). Prune = remove the route folders, keep the "Coming later" roadmap chips as the signal. Requires a `/pre-deletion-caller-audit` pass.

### ✅ Resolved scope question — the People / federation cluster
**People is IN the launch nav** (decided 2026-06-08). Launch nav = **Mycelium · Library · Streams · People · Curious Life** (+ pinned Profile/Settings). Note this supersedes the `CLAUDE.md` "Federation: Deferred" line for V1 launch — the federation backend (`connections` / `spaces` / `contexts` endpoints) is treated as launch-ready; CLAUDE.md should be reconciled.

---

## Build status (landed 2026-06-08 — `svelte-check` 0 errors)
1. ✅ **Sidebar scroll bug** ([Sidebar.svelte](../portal-app/src/lib/components/shell/Sidebar.svelte)) — primary + contextual nav share one `flex-1 overflow-y-auto` region; Profile + Settings + user footer pinned `flex-shrink-0`. (Previously a tall list overflowed the `overflow-hidden` aside and pushed the bottom controls off-screen.)
2. ✅ **Streams** — new [StreamsView.svelte](../portal-app/src/lib/views/StreamsView.svelte) (segmented Stream/Sources, lazy-mount + keep-alive, hosting `TimelineView` + `ImportView`); registry `import`+`timeline` → single `streams` ([registry.ts](../portal-app/src/lib/workspace/registry.ts)); `/streams` route added; `/import` + `/timeline` intents now open the matching facet; `canonicalUrl` mirrors `/streams?facet=…` ([store.ts](../portal-app/src/lib/workspace/store.ts)).
3. ✅ **People** — sidebar `coreNav` → 5 destinations; People item active across the `connections`/`spaces`/`contexts` cluster; new [PeopleNav.svelte](../portal-app/src/lib/components/people/PeopleNav.svelte) contextual sub-nav (Connections · Spaces · Sharing); Profile moved to the pinned bottom.
4. ✅ **Alignment + naming** — `Header.viewLabels` (fixed `contexts → "Sharing"` collision, added Streams/People), `BottomTabBar` tabs (Mycelium · Library · Streams · People), `navigation.ts` `PrimaryView` union (+`streams`/`people`), `ContextsView` toast "Space created" → "Sharing scope created".
5. ⏳ **Prune** the roadmap route folders (`agents`, `cycles`, `wealth`, `intel`, `body`, `vitality`, `activity`, `media`, `fleet`, `modules`, `chat`) — deferred until scope is signed off; needs a `/pre-deletion-caller-audit`. People stays (federation in launch scope).

> **Verification:** `npm run check` → 0 errors (4 pre-existing warnings in OnboardingGuide/tsconfig, not from this change). Live visual verify is pending a portal rebuild — the running `:8787` server serves a prebuilt bundle, and the preview tool can't spawn its own server here (sandbox `getcwd`).
