# DESIGN — Workspace shell: tabbed, resizable, multi-pane layout (2026-06-03)

Status: **design for review.** Sweep-first-design (5 parallel Explore sweeps + 6 first-hand reads). No code yet — this is the "design it properly first" artifact.

Goal: replace the current **fixed sidebar + one-view-at-a-time** shell with an **IDE-style workspace** — resizable split panes, each with closable/switchable **tabs**, defaulting to the **Mindscape**, all inside the single desktop window. Inspired by the Claude Code layout the user shared.

## Decisions locked by the user
- **Split panes in ONE window** (not separate OS windows). → the whole thing is an in-app pane/tab manager; **no cross-window state sync**, no second Tauri window. (Multi-OS-window is explicitly out of scope; revisitable later.)
- **Sidebar = hybrid**: app **sections** (launchers that open/focus tabs) + a **recents** list + the existing **"Coming soon"** teaser section (kept, disabled).
- Default tab = **Mindscape**.

---

## 1. The core problem & the chosen reconciliation

SvelteKit here is **page-routed** (one `+page.svelte` = one main view) and **SPA** (`svelte.config.js:11` `fallback: '200.html'`, `+layout.ts` `ssr=false`). A multi-pane workspace needs many views alive at once, hosted as **components**, not swapped pages.

Navigation today is **dual-driven**: every nav click fires BOTH `navigationState.setPrimaryView(id)` AND `goto(href)` (`Sidebar.svelte:47-48`, `BottomTabBar.svelte:21-22`). Dozens of `goto('/x')` calls exist across the app.

**Chosen approach — "routes as intents + one persistent Workspace":**
- The `(app)/+layout.svelte` hosts a **persistent `WorkspaceRoot`** (the pane tree) as the actual content — it does NOT remount on route changes.
- Each `(app)/<view>/+page.svelte` becomes a **thin intent**: on mount it calls `workspace.openFromRoute(viewId, params)` and **renders nothing**. The layout renders `{@render children()}` inside a `display:none` slot so the intent fires without showing page UI.
- The heavy view UI **moves** out of the route page into a reusable **view component** under `lib/views/` (e.g. `MindscapeView.svelte`), which the workspace mounts inside a tab.

Why this wins:
- **Every existing `goto('/x')` keeps working** — it routes → the thin intent → `openOrFocus` a tab. Near-zero churn to the ~dozens of call sites.
- **Deep-links work** (`/library?doc=x`, `/spaces/abc`) → open the right tab with params. The SPA `200.html` fallback already resolves any URL client-side.
- **The route guards stay** (`+layout.svelte` → `/login` `/setup` `/unlock`) — untouched, they live above `(app)`.
- `openOrFocus` is **idempotent** (focusing an open tab is a no-op), so the sidebar/tab/route paths can all converge on it without loops.

`openFromRoute`/`openOrFocus` is the **single entry point**; tab-focus → URL sync (`replaceState`) is a Phase-C nicety (deep-link *in* is what matters for v1).

---

## 2. Component inventory ("all the parts")

### New — `lib/workspace/` (state)
| File | Responsibility | ~LOC |
|---|---|---|
| `types.ts` | `Tab`, `LeafPane`, `SplitNode`, `WorkspaceState` types | 60 |
| `store.ts` | the workspace store: tree, `openOrFocus`/`openFromRoute`/`closeTab`/`focusTab`/`focusPane`/`splitPane`/`resizeSplit`/`moveTab`, recents, persist/restore | 280 |
| `registry.ts` | view registry: `viewId → { load() lazy component, title, icon, singleton, key(params), props(params) }` | 90 |

### New — `lib/components/workspace/` (UI)
| File | Responsibility | ~LOC |
|---|---|---|
| `WorkspaceRoot.svelte` | recursively render the tree: split node → `SplitPane`; leaf → `Pane`. Single-pane on narrow viewports. | 120 |
| `SplitPane.svelte` | h/v split, draggable divider, persisted size, min/max clamp. **Reuses ChatFloat's imperative-drag pattern** (mutate `.style` during drag, commit on pointerup — avoids Svelte thrash). | 130 |
| `Pane.svelte` | a leaf: `TabStrip` + the **keep-alive** tab bodies (all mounted; only active is shown; `active` prop passed down). Focus ring. | 130 |
| `TabStrip.svelte` | the tab row: tabs, close buttons, "+" launcher, overflow scroll, (drag-reorder in C). | 150 |
| `Tab.svelte` | one tab chip (icon, title, dirty dot, close ✕). | 60 |

### New — `lib/views/` (de-routed view components)
`MindscapeView`, `LibraryView`, `TimelineView`, `ProfileView`, `SettingsView`, `CuriousLifeView`, `SpaceView`, `ImportView`, … — **the existing page UIs, moved here** and made prop-driven. Mechanical for the self-contained ones.

### Changed
| File | Change |
|---|---|
| `routes/(app)/+layout.svelte` | render `Header` + `Sidebar` + `WorkspaceRoot` + overlays; `{@render children()}` in a hidden slot (intent-only). |
| `routes/(app)/<view>/+page.svelte` (×~23) | shrink to a ~4-line intent (`onMount(() => workspace.openFromRoute(...))`). |
| `components/shell/Sidebar.svelte` | hybrid: sections open/focus tabs; new **Recents**; keep **Coming soon**. |
| `components/shell/Header.svelte` | unchanged structurally (drag region + wordmark + theme); the per-view mobile title now reads the focused tab. |
| `stores/navigation.ts` | kept for chat/space/doc scope + sidebar/header highlight; the workspace sets `primaryView` on focus change (coexist, minimal churn). |

### Untouched singletons (must survive the rebuild)
`ChatFloat`, `Toast`, `ImportDropZone`, `WelcomeModal`, `OnboardingGuide` — already render at the layout root **outside** `{@render children()}` (`+layout.svelte:91-102`); they stay there, unaffected. `ChatFloat` already floats/resizes over everything.

---

## 3. State model

```ts
type Tab = { id: string; viewId: string; params: Record<string,any>;
             title: string; icon: string; closable: boolean };
type LeafPane  = { kind:'leaf'; id:string; tabs: Tab[]; activeTabId: string };
type SplitNode = { kind:'split'; id:string; dir:'h'|'v';
                   children:[Node,Node]; sizes:[number,number] /* % */ };
type Node = LeafPane | SplitNode;
type WorkspaceState = { root: Node; focusedPaneId: string;
                        recents: { viewId:string; params:any; title:string; at:number }[] };
```
- Binary tree → arbitrary splits; v1 ships single-leaf + one split, the model already generalizes.
- Persisted to `localStorage['mycelium-workspace']` (debounced, mirroring `navigation.ts:96-106`). On load: restore → **validate against `registry`** (drop tabs whose `viewId` no longer exists) → if empty/invalid, default to `{ single pane, one Mindscape tab }`.
- `openOrFocus(viewId, params)`: if the view is **singleton** (or a tab with the same `key(params)` exists) → focus it; else add a tab to the focused pane.

---

## 4. View registry + de-routing plan (sweep B, ranked easy→hard)

| View | Coupling | Action |
|---|---|---|
| Mindscape, Profile, Timeline, Settings | none (onMount-only) | **move as-is** to `lib/views/`, render in a tab |
| Spaces/[id] | `$page.params.id` | param → **prop** (`let { spaceId } = $props()`); the intent reads `$page.params.id` and passes it |
| Library | `history.pushState`+popstate for `?doc=` | doc selection → **tab param** (drop the manual history push); registry `key = doc path` so the same doc focuses |
| Curious Life, Modules, Chat | `goto('/x')` | **no change needed** — `goto` still routes → intent → `openOrFocus`. (The sweep flagged these "hard" assuming routing was removed; we keep it.) |

Registry entry shape:
```ts
mindscape: { load: () => import('$lib/views/MindscapeView.svelte'),
             title: 'Mycelium', icon: 'ratio', singleton: true }
library:   { load: () => import('$lib/views/LibraryView.svelte'),
             title: 'Library', icon: 'folder',
             key: p => p.doc ?? 'library', props: p => ({ doc: p.doc }) }
space:     { load: () => import('$lib/views/SpaceView.svelte'),
             key: p => `space:${p.id}`, props: p => ({ spaceId: p.id }) }
```

---

## 5. Mindscape: singleton + keep-alive + render-pause (the hard view)

Sweep C: 3D runs even under Tauri (`mindscape/+page.svelte:246`), one `THREE.WebGLRenderer` per instance, `onDestroy` does `forceContextLoss()` (`Mindscape3D.svelte:2331-2352` — the WKWebView wedge fix). The **shared singleton stores** `generate` (`generate.ts:64`) and `mindscapeState` (realm/theme/territory drilldown) make two live Mindscapes interfere (HIGH risk), and Sidebar already guards against remount (`Sidebar.svelte:42-43`).

**Decisions:**
1. **Singleton Mindscape** — `registry.mindscape.singleton = true`. Opening it again **focuses** the existing tab. At most **one** WebGL context, ever.
2. **Keep-alive, not remount** — inactive tabs stay mounted (state preserved: Library scroll, Timeline page), hidden via `display:none`. Switching tabs is instant; no WebGL re-init churn. `forceContextLoss` happens **only on tab close** (real `onDestroy`), never on hide.
3. **Render-pause** — `Pane` passes `active:boolean` to each view. `MindscapeView` **pauses its rAF loop** when `!active` (the canvas survives, just stops painting) and resumes on activate. This is the key perf rule for tabs + WebGL.
4. **LRU memory guard** (Phase C) — if open heavy tabs exceed N, evict the least-recently-used (full teardown). v1: no cap (a personal vault won't open dozens).

---

## 6. Sidebar (hybrid + Coming soon)

Three stacked regions (resizable width stays, `mycelium-sidebar-width`):
- **Sections** — Mindscape, Library, Import, Timeline, Profile, Curious Life, Settings (today's `coreNav`+`curiousLife`+Settings). Click → `openFromRoute` (open/focus a tab in the focused pane). The active tab's `viewId` highlights.
- **Recents** — last N from `workspace.recents` (recently-opened tabs/items). Click → reopen. New region.
- **Coming soon** — the existing `comingLater` expandable teaser (Spaces, Connections, Chat, Agents, Cycles, Wealth, Intel, Body, Vitality, Activity, Media), disabled, collapsed by default. **Kept verbatim** (user requirement).

Contextual sub-nav (`TimelineNav`, `LibraryNav`) currently keys off `primaryView`; it will key off the **focused tab's** `viewId` instead.

---

## 7. Mobile / narrow (<768px)

Split panes don't fit a phone. On narrow viewports `WorkspaceRoot` renders **only the focused pane**, showing **only its active tab** full-screen — **no split rendering, no resize handles**. The pane tree still exists in state (restored on widening). The **`BottomTabBar` stays** and drives section switching via `openFromRoute`; the sidebar remains a drawer. Net: today's mobile UX is preserved; the workspace is a desktop/wide enhancement.

---

## 8. Tauri / desktop chrome (sweep E)

Single window `main`, `TitleBarStyle::Visible` + `hidden_title` + opaque + `disable_drag_drop_handler` (`main.rs:133-158`); capability scoped to `["main"]`. **No multi-window code** — and we don't add any (user chose one window).
- The native title-bar strip (traffic lights, left ~84px) sits above the `Header` (the `data-tauri-drag-region`). **Split dividers live in the content area below the header**, so they never collide with the traffic-light zone.
- `data-tauri-drag-region` can't be partial/nested in Tauri v2 — fine, only the `Header` strip is the drag region; panes/tabs are normal content with the JS `startDragging` fallback already present.
- WKWebView constraints respected: opaque window (no backdrop-filter — `app.css` `html.is-tauri` already drops it), single WebGL context (singleton Mindscape).

---

## 9. Edge cases — explicit decisions

| Case | Decision |
|---|---|
| Open Mindscape when already open | focus the existing tab (singleton) |
| Open the same document twice | focus existing (singleton-by-`key`=path) |
| Close the last tab in a pane | if it's a split child → collapse the split, sibling takes the space; if it's the root leaf → show an empty-pane launcher (don't allow zero panes) |
| Background tab with a running generate | the singleton `generate` store keeps polling (correct); the Mindscape tab shows progress whether focused or not; rAF paused if hidden |
| Restored workspace references a removed view | dropped on validate; if all dropped → default Mindscape |
| Narrow viewport with a saved split | render focused pane only; keep the split in state for when it widens |
| Two panes both want "the URL" | the **focused** pane's active tab owns the URL (Phase C sync) |
| Deep-link `/spaces/abc` cold load | intent reads `$page.params.id` → opens a `space` tab with `spaceId=abc` |

---

## 10. Implementation phases (each shippable)

**Phase A — Tabs + single pane + default Mindscape** (the core ask).
Workspace store (single-leaf), registry, `WorkspaceRoot`/`Pane`/`TabStrip`/`Tab`, de-route the 4 easy views + Mindscape into `lib/views/`, thin intents for those routes, sidebar **sections open tabs** + keep **Coming soon**, keep-alive + Mindscape render-pause, persistence. → delivers "closable/switchable document tabs, default Mindscape." ~900 LOC + mechanical view moves.

**Phase B — Split panes + resize + recents.**
`SplitPane` (drag-resize, persisted), `splitPane`/`moveTab`, a "Split" command + the tab "+", sidebar **Recents**, de-route Library + Spaces. ~450 LOC.

**Phase C — Polish.**
Drag-tab-reorder, drag-tab-to-edge-to-split, tab↔URL sync, LRU eviction, command palette ("+"/⌘P), narrow-viewport refinements. ~450 LOC.

Each phase: builds clean + `npm run verify` GO + an isolated preview check (the `:8796` harness) + its own PR. No direct main push.

---

## 11. Test strategy
- **Per phase, in the isolated `:8796` preview** (real data via a `.backup` copy): default opens Mindscape; open/close/switch tabs; section→tab; Coming soon intact; **switching off Mindscape pauses its rAF and back resumes with no WebGL wedge** (the prior leak test, extended); persistence across reload; (B) split + resize; deep-link `/library?doc=` and `/spaces/abc` open the right tab.
- **Regression**: every existing `goto('/x')` still lands the user on the right view (now a tab). `npm run verify` stays GO (this is portal-only; backend unaffected).
- **WebGL stress**: open Mindscape + several other tabs, switch repeatedly, leave — confirm one context, freed on close, no wedge (WKWebView).

## 12. Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Hidden `{@render children()}` intent double-fires `openOrFocus` | med | low | `openOrFocus` idempotent; guard by current focused tab |
| Mindscape rAF keeps running in a hidden tab → GPU burn | med | med | `active` prop + explicit rAF pause; verified in preview |
| Keep-alive memory with many heavy tabs | low | med | singleton Mindscape; LRU eviction (C); personal-scale usage |
| Big mechanical refactor (move ~20 pages → views) breaks a view | med | med | phase it (4 easy first); each view verified in preview before its route is thinned |
| Tab↔URL loops | med | low | defer to C; single guarded `replaceState` on focus change |
| Library `history.pushState` fights workspace URL | low | low | drop it; doc state → tab param |

## 13. Open questions (resolved during sweep)
- *Routing vs panes?* → keep routes as **thin intents**; one persistent Workspace. `goto()` calls survive.
- *Multiple Mindscapes?* → no — singleton (shared `mindscapeState`/`generate`), keep-alive + render-pause.
- *Any libs to reuse?* → none for panes/tabs; reuse ChatFloat's imperative-resize + the existing resizable-side-panel pattern.
- *Multi OS window?* → out of scope (user chose one window); design leaves room (server is canonical state) but adds nothing.

## 14. Deferred / out of scope
- Separate OS windows (tear-out tabs).
- Command palette / fuzzy open (Phase C).
- Per-pane independent Mindscape drilldown (would need `mindscapeState` keyed by pane — not worth it; singleton).
- Collaborative/multi-user (the app is single-user).

---

## 15. Verification table (load-bearing assumptions, read first-hand)

| # | Assumption | Verified at |
|---|---|---|
| 1 | `(app)` layout renders `{@render children()}` in `main` → can host WorkspaceRoot + hide children | `routes/(app)/+layout.svelte:80-88` |
| 2 | Global overlays render at layout root, outside children (survive rebuild) | `routes/(app)/+layout.svelte:91-102` |
| 3 | Nav is dual-driven (`setPrimaryView` + `goto`) → routes-as-intents keep `goto()` working | `Sidebar.svelte:47-48` |
| 4 | Sidebar already guards Mindscape remount ("prevents 3D map remount") | `Sidebar.svelte:42-43` |
| 5 | SPA adapter, `fallback: 200.html` → any route resolves client-side (deep-links) | `svelte.config.js:8-13` |
| 6 | `navigation.ts` = single persisted writable (primaryView + scopes); workspace can coexist + set primaryView | `stores/navigation.ts:40-106, 113-115` |
| 7 | Mindscape lazy-loads 3D, runs under Tauri (no 2D fallback) | `mindscape/+page.svelte:243-251` |
| 8 | One `WebGLRenderer`/instance; `onDestroy` does `forceContextLoss` (close-only teardown) | `Mindscape3D.svelte:2331-2352` |
| 9 | `generate` + `mindscapeState` are global singletons → singleton Mindscape | `generate.ts:64`; `stores/mindscape.ts` |
| 10 | No pane/tab/split/dnd libs → build on primitives | `portal-app/package.json` (deps) |
| 11 | Reusable imperative resize/drag exists | `ChatFloat.svelte` (drag/resize + localStorage) |
| 12 | Single Tauri window, capability `["main"]`, no multi-window | `src-tauri/src/main.rs:133-158`; `capabilities/default.json` |
| 13 | Coming-soon teaser list to preserve | `Sidebar.svelte:35-39` |
