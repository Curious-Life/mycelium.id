# DESIGN — Workspace shell Phase C · 2026-06-04

Phase C of the IDE-style workspace (A=#60, B=#62 shipped + installed). This phase
makes the workspace **URL-coherent** and adds two ergonomics features. Built
sweep-first (4 Explore sweeps + first-hand pressure-test reads; verification table
at the end).

- **Predecessor design:** `docs/DESIGN-workspace-shell-2026-06-03.md`.
- **Handoff:** `docs/HANDOFF-workspace-shell-2026-06-03.md` (§2.2 quirk, §6 Phase C plan, §7 quick-start).

## Goal (this PR)

1. **tab↔URL sync** — the focused tab's view drives the browser URL via
   `replaceState`, so reload is coherent. **Fixes the §2.2 quirk:** close a tab
   then reload → it no longer reappears (today the stale URL's intent re-adds it).
2. **B4 (Library doc-state → tab params)** — required to make #1 conflict-free:
   `LibraryView` is a *second* URL author today (native `history.pushState`). Move
   its doc-selection into the tab's `params` so the workspace is the **single** URL
   author. Bonus: fixes a latent Phase-A gap (deep-link `?doc=` doesn't auto-select).
3. **Command palette (⌘K)** — fuzzy/substring over registry sections + recents →
   open/focus as a tab.
4. **Drag-to-reorder tabs** — pointer-based reorder within a strip.

## Scope — deferred to a Phase C-part-2 (with rationale, NOT skipped)

| Deferred | Why now is wrong |
|---|---|
| Drag-a-tab-to-edge → split | Needs cross-pane `moveTab` + drop-zone overlay; higher risk; reorder delivers most of the drag value first. |
| LRU eviction of mounted heavy tabs | **Premature.** Mindscape is a singleton (1 WebGL context, already enforced); other views are light DOM. Eviction would *regress* keep-alive (lose scroll/edit state) for no current benefit. Revisit only if heavy-view proliferation becomes real. |
| Mobile single-pane (`WorkspaceRoot` narrow mode) | This is a **Tauri desktop** app; `<768px` is not a V1 target. `BottomTabBar` already drives sections on narrow via goto→intents. |
| De-route `spaces/[id]` → `SpaceView` | `spaces` is **unreachable** in V1 (disabled "Coming later" chip, no href — sweep 4). No user path reaches it; de-routing now is untested churn. |
| Unknown-viewId fallback tab | **No live path produces one.** Un-migrated routes are unreachable (sweep 4); removed-view tabs are already dropped by `sanitizeNode` (`store.ts:96`). Adding a handler now is untestable dead code. |

## Load-bearing assumptions (Step 1 inventory)

1. SvelteKit's shallow-routing `replaceState` (`$app/navigation`) exists in this version and updates the URL **without** re-running the route (no intent re-fire).
2. Route intents call the workspace **only in `onMount`** (not reactively on `$page`), so a URL change can't re-trigger `openOrFocus`.
3. The **only** reactive `$page.url` readers are the root-layout `/login|/setup|/unlock` guards — none react to `(app)` URLs, so `replaceState` among app views causes no loop / no guard flip.
4. `LibraryView` owns `/library?doc` via **native** `history.pushState` + `popstate` — the one URL-author conflict to resolve.
5. There is **one** global keydown handler (`(app)/+layout.svelte`) — the palette shortcut's home.
6. No HTML5 drag/sortable and no shared drag util exist — reorder must be custom pointer code (ChatFloat/SplitPane pattern).
7. `captureMode` (`?capture`) renders children-only (headless 3D snapshot) — URL-sync must **not** run there (it would strip `?capture`).
8. Route folder names == viewIds (so `canonicalUrl = '/'+viewId`), Library adds `?doc`.

## Sweep findings (consolidated; file:line)

**Routing / shallow routing**
- `@sveltejs/kit ^2.49.3` → `pushState`/`replaceState` from `$app/navigation` available (needs ≥2.12). `svelte.config.js` `fallback:'200.html'`; root `+layout.ts` `ssr=false`, `prerender=false`.
- All 7 intents call `workspace.openFromRoute(...)` inside `onMount`: `mindscape/+page.svelte:12`, `library/+page.svelte:7-10`, `import/+page.svelte:5`, `timeline:5`, `profile:5`, `curious-life:5`, `settings:5`.
- `(app)/+layout.svelte:95` renders the hidden `{@render children()}`; `:16` `captureMode`; `:55-68` the lone global keydown (Cmd+`\`).
- Existing URL authors: `LibraryView.svelte:341` native `history.pushState({docPath},'','/library?doc=…')`, popstate `:130-140,147,165`; `chat/+page.svelte:7` `goto('/mindscape',{replaceState:true})` (chat unreachable). **No `$app/navigation` `replaceState`/`pushState` used yet.**
- Reactive `$page` readers (whole portal): `+layout.svelte:11-13` (login/setup/unlock), `spaces/[id]/+page.svelte:61` (unreachable). Nothing else.

**Navigation store / sidebar**
- `stores/navigation.ts` — `PrimaryView` union (20 ids), `setPrimaryView`. Callers: `store.ts:148` (active-tab mirror), `Sidebar.svelte:48,266`, `BottomTabBar.svelte:21`, `LibraryNav.svelte:146,461`.
- `Sidebar.handleNavClick` (`:42-51`): `setPrimaryView(item.id); goto(item.href)`. Enabled: mindscape/library/import/timeline/profile + curious-life. Disabled "comingLater" (chips, **no href**): Spaces, Connections, Chat, Agents, Cycles, Wealth, Intel, Body, Vitality, Activity, Media.
- `BottomTabBar` shows `<768px`; tabs mindscape/library/import/timeline.

**Drag / overlay precedent**
- Imperative pointer pattern: `ChatFloat.svelte:242-382,1025-1076` (capture rect → accumulators → direct `.style` → commit on up); `SplitPane.svelte:16-43` (flex-basis mutate → `resizeSplit` on up).
- `ImportDropZone.svelte:64-104` window-level drag overlay, depth counter, `z-index:200`, `pointer-events:none`.
- **No** `draggable`/`dragstart`/sortable anywhere; **no** shared drag action/util.

**Modal / shortcut / search precedent**
- Reusable modal: `WelcomeModal.svelte` (`{#if open}` backdrop `role=dialog`, Escape via `svelte:window`, backdrop-click close).
- No central shortcut registry — only `(app)/+layout.svelte` Cmd+`\`. No fuzzy lib; everywhere `.toLowerCase().includes()`.
- `LibraryView` declares **no `$props()`** — the `doc` from `tab.params` is currently **ignored** (deep-link doesn't auto-select; B4 fixes this).

## Design

### C1 — tab↔URL sync + B4 Library doc-state (the coupled unit)

**Single URL author = the workspace store.** In `store.ts`'s existing `subscribe`
(already debounce-saves + mirrors `primaryView`), add: compute the focused pane's
active tab → `canonicalUrl`; if it differs from `location.pathname+search`,
`replaceState(url, {})`.

```ts
// store.ts
import { replaceState } from '$app/navigation';

function canonicalUrl(tab: Tab): string {
  if (tab.viewId === 'library' && typeof tab.params.doc === 'string' && tab.params.doc)
    return `/library?doc=${encodeURIComponent(tab.params.doc)}`;
  return `/${tab.viewId}`;
}

let urlSyncEnabled = false;            // flipped by the (app) layout once the router is up
api.enableUrlSync = () => { urlSyncEnabled = true; };

// inside subscribe(s):
if (urlSyncEnabled && browser && !captureMode()) {
  const active = activeTabOf(s);
  if (active) {
    const url = canonicalUrl(active);
    const cur = location.pathname + location.search;
    if (url !== cur) { try { replaceState(url, {}); } catch { /* router not ready */ } }
  }
}
```

- **Why `replaceState` (not `goto`/`pushState`):** `goto` re-runs the route →
  remounts the intent (works, but churns + spams history); native `pushState`
  re-introduces a 2nd author. `replaceState` updates URL + `$page` + the router's
  notion of "current" with **no** navigation, no remount, no history entry per
  tab-switch. Verified no reactive `$page` reader reacts to `(app)` URLs (assumption 3).
- **Router-ready gate:** `enableUrlSync()` is called from `(app)/+layout.svelte`
  `onMount` (router is up by then). Before that, sync is a no-op. `try/catch` is
  belt-and-suspenders.
- **Capture-safe:** `captureMode()` = `browser && new URLSearchParams(location.search).has('capture')` → skip (assumption 7).

**Quirk fix (§2.2) mechanism:** closing the Library tab moves focus to the
sibling/default tab → sync rewrites the URL to *that* view → on reload the intent
opens that view (already the restored active tab) → Library stays closed. URL and
localStorage now agree.

**B4 — Library becomes a keyed singleton tab carrying its doc:**
- `registry.ts`: `library` → `singleton: true` (drop the per-doc `key`). One Library
  tab; `params.doc` is its live selection. (Per-doc multi-tabs were never realized
  and would spawn duplicates when params change — see Edge cases.)
- `store.ts`: new `setTabParams(tabId, patch)` (merge; explicit `null` clears) so a
  view can update its own tab's params. And in `openIn`, focusing an existing tab
  **merges** params (`{...ex.params, ...params}`) instead of replacing — so a plain
  `openOrFocus('library',{})` (sidebar) keeps the current doc, while a deep-link
  `{doc:X}` applies it.
- `Pane.svelte`: pass `setParams={(p)=>workspace.setTabParams(tab.id,p)}` into the
  rendered view (alongside `active` + `...tab.params`).
- `LibraryView.svelte`: (a) declare `let { doc, setParams } = $props()`; (b) delete
  the native `history.pushState` (`:341`) + the `popstate` handler/listener
  (`:130-140,147,165`); (c) `selectDoc()` calls `setParams?.({doc: path})` instead;
  closing a doc → `setParams?.({doc: null})`; (d) an `$effect` selects the doc when
  the `doc` prop is set and differs from `selectedDoc?.path` (drives deep-link +
  reload restore). The list-channel `subscribeToLibrary` + `doc-moved` listener stay.

### C2 — command palette (⌘K)

- New `lib/components/workspace/CommandPalette.svelte` (modeled on `WelcomeModal`):
  `{#if open}` fixed backdrop (`role=dialog`, `aria-modal`), an `<input>` autofocus,
  a filtered list. Closes on Escape / backdrop / after running a command.
- **Commands** = registry sections (`Object.entries(REGISTRY)` → "Open <title>") +
  `$workspace.recents` (→ "Recent: <title>"). Filter = `query.toLowerCase()` substring
  over the label. Arrow ↑/↓ moves `selectedIndex` (clamped), Enter runs, mouse hover
  sets index, click runs. Running = `workspace.openOrFocus(viewId, params)` + close.
- **Trigger:** in `(app)/+layout.svelte` keydown, add
  `if ((meta||ctrl) && key==='k'){ e.preventDefault(); paletteOpen = !paletteOpen }`.
  Render `<CommandPalette bind:open={paletteOpen} />` in the non-capture branch.
  (Cmd+`\` stays.)

### C3 — drag-to-reorder tabs (within a strip)

- Pointer-based in `TabStrip.svelte` (no HTML5 DnD). On `pointerdown` on a tab body
  (not the close button), record start X + tabId; on `pointermove` past a small
  threshold (~5px) enter dragging (set pointer capture, `userSelect:none`); compute
  the target index by comparing pointer X against sibling tab-rect midpoints; if it
  crosses, call `workspace.moveTabWithinPane(paneId, tabId, toIndex)` (reorders the
  array live — Svelte keyed-each reflows). On `pointerup`: if never crossed the
  threshold, it was a click → `focusTab`; else end the drag. The `Tab.svelte`
  `onclick=focus` stays for keyboard/non-drag; the drag layer guards the click.
- `store.ts`: `moveTabWithinPane(paneId, tabId, toIndex)` — splice within
  `leaf.tabs`, clamp, keep `activeTabId`.
- Needs `paneId` in `TabStrip` props (currently it has tabs/activeTabId/callbacks) —
  add `paneId` + `onreorder`. Wire from `Pane.svelte`.

## Threat model

Client-only, **no new attack surface.** The URL lives inside the Tauri WKWebView
(no address bar); no value leaves the process. localStorage was already the
persistence channel (Phase A). No crypto, no network egress, no cross-process state,
no auth surface touched. The palette only opens **registered local views** (closed
set in `REGISTRY`) — it cannot navigate to arbitrary URLs or un-gated routes. B4
moves doc-selection from `window.history` to in-memory store params (strictly less
global state). `replaceState` cannot reach `/login|/setup|/unlock` (canonicalUrl only
emits `/<registered-view>`), so the auth/setup/lock guards are untouched.

## Module shape + LOC budget (±20%)

| File | Change | ~LOC |
|---|---|---|
| `lib/workspace/store.ts` | `canonicalUrl`, URL-sync in subscribe, `enableUrlSync`, `setTabParams`, merge-on-focus, `moveTabWithinPane` | +45 |
| `lib/workspace/registry.ts` | `library` → singleton | ~-3 |
| `lib/components/workspace/Pane.svelte` | pass `setParams`; pass `paneId`+`onreorder` to TabStrip | +6 |
| `lib/components/workspace/TabStrip.svelte` | pointer reorder + `paneId`/`onreorder` props | +90 |
| `lib/components/workspace/CommandPalette.svelte` | NEW modal | +160 |
| `routes/(app)/+layout.svelte` | `enableUrlSync()` onMount; ⌘K; render palette | +12 |
| `lib/views/LibraryView.svelte` | doc prop + setParams; drop native history | net ~+8 |

≈ 320 LOC. Three independently-shippable commits (C1, C2, C3).

## Edge cases — explicit decisions

- **Sidebar "Library" while a doc is open** → `openOrFocus('library',{})` merges
  empty params → **keeps** the doc (no surprise deselect). Clearing a doc is an
  explicit in-view action (`setParams({doc:null})`).
- **Library as singleton vs per-doc tabs** → singleton. Per-doc keys + param mutation
  would mismatch keys (`'library'` vs `'library:X'`) and spawn a duplicate tab on the
  next sidebar click. A personal vault wants one file-browser tab (VS-Code-explorer
  model), not N doc tabs.
- **`replaceState` before router ready** → gated by `enableUrlSync()` (set in the
  `(app)` layout `onMount`) + `try/catch`. First synchronous store emission (module
  load) is a no-op.
- **Capture mode** → URL-sync skipped (`?capture` preserved for the snapshot tool).
- **Closing the last tab** → unchanged from B (`closeTab` reseeds DEFAULT_VIEW;
  never empties the workspace) → sync writes `/mindscape`.
- **Split panes, two views** → URL reflects the **focused** pane's active tab only
  (one address bar; matches "focused pane = where new tabs land"). Switching focus
  between panes updates the URL. Acceptable + intuitive.
- **Drag vs click** → a <5px pointer travel = click (focus); past it = reorder. Close
  button stops propagation (B already), so dragging from it is impossible.
- **Palette over a modal/onboarding** → ⌘K toggles `paletteOpen`; it renders in the
  non-capture branch alongside Welcome/Onboarding; Escape closes the palette only.

## Test strategy

- **`npm run verify` WITHOUT `| tail`** (capture real exit — the §-LESSON). Portal-only
  change; backend gate should stay GO. Watch `verify:nav` (it asserts ImportView etc.).
- **Build:** `npm --prefix portal-app run build` clean (a11y warnings are non-fatal).
- **Isolated `:8796` preview** (throwaway vault, temp `MYCELIUM_KC_*`, never touches
  the real Keychain). Per feature:
  - C1: open Library, select a doc → URL shows `/library?doc=…` (eval `location.href`);
    switch to Mindscape → URL `/mindscape`; **close a non-active tab, reload → it stays
    closed** (the quirk); reload on `/library?doc=X` → Library opens with X selected.
  - C2: ⌘K opens; type "tim" → Timeline filters in; Enter opens a Timeline tab; Escape
    closes.
  - C3: open 3 tabs; drag the first past the second → order changes + persists a reload;
    a plain click still focuses.
- **Real-vault read-only** (optional): rebuild portal, inspect on the app's `:8787`.

## Implementation order

1. **C1** (store + registry + Pane + LibraryView + layout) → verify quirk + deep-link.
2. **C2** (CommandPalette + layout) → verify ⌘K.
3. **C3** (TabStrip + store) → verify reorder.
4. `npm run verify` (no pipe) GO → update handoff + memory → PR (squash) → rebuild
   `.app` (wait for `:8787`) for the user.

## Decision criteria for Phase C-part-2

Pull the deferred items only when a real trigger appears: edge-split when users ask
to "drag a tab out"; LRU when >1 heavy (WebGL/video) view can be open at once; mobile
when a non-desktop target is committed; `spaces` de-route when Spaces leaves "Coming
later".

## Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `replaceState` loops via a reactive `$page` reader | Low | Med | Verified only login/setup/unlock react, none to `(app)` URLs (assumption 3, grep). `try/catch` + diff-guard. |
| URL-sync fires before router ready → throw | Med | Low | `enableUrlSync()` gate (layout onMount) + `try/catch`. |
| Two URL authors (Library + workspace) race | — | — | **Eliminated** by B4 (Library no longer writes history). |
| Deep-link `?doc` regresses | Low | Low | B4 *adds* the missing prop-driven select; covered by preview test. |
| Drag breaks tab click | Med | Med | <5px threshold; close-button stops propagation; preview test asserts click still focuses. |
| Library surgery in a 2081-line file breaks live-sync/editor | Med | Med | Touch only the history/prop lines; keep `subscribeToLibrary`/`doc-moved`/editor untouched; build + preview a doc open/edit. |

## Open questions resolved during sweep

- *Does the deep-link `?doc` auto-select today?* **No** — `LibraryView` has no `doc`
  prop; B4 fixes a latent gap, not just refactors.
- *Will `replaceState` remount intents / loop?* **No** — intents are `onMount`-only;
  no `(app)`-URL reactive reader exists.
- *Native `history` vs `$app/navigation`?* Use `$app/navigation` `replaceState` so
  `$page`/router stay consistent and there's exactly one author.

## Open questions deferred

- Cross-pane tab **move** (prereq for edge-split) — Phase C-part-2.
- Palette command set beyond views/recents (documents, actions like "split") — later.

## Verification table

| Assumption | Verified at (read first-hand) |
|---|---|
| SvelteKit ≥2.12 → `replaceState` available | `portal-app/package.json` `@sveltejs/kit ^2.49.3` (sweep 1) |
| SPA, ssr=false, fallback 200 | `svelte.config.js` `fallback:'200.html'`; `routes/+layout.ts` `ssr=false` (sweep 1) |
| All intents call workspace in `onMount` only | `routes/(app)/{mindscape:12,library:7-10,import:5,timeline:5,profile:5,curious-life:5,settings:5}/+page.svelte` (read) |
| Only login/setup/unlock react to `$page.url` | `routes/+layout.svelte:11-13`; broad grep → only `spaces/[id]:61` else (read) |
| Library is a 2nd URL author (native history) | `lib/views/LibraryView.svelte:341` (pushState), `:130-140,147,165` (popstate) (read) |
| `selectDoc(doc, pushHistory=true)` is the hook | `lib/views/LibraryView.svelte:336-351` (read) |
| LibraryView has no `doc` prop today | grep `$props` in `LibraryView.svelte` → none (read) |
| One global keydown handler | `routes/(app)/+layout.svelte:55-68` (read) |
| `captureMode` renders children-only | `routes/(app)/+layout.svelte:16,71-74` (read) |
| `Pane` renders `<Comp active {...tab.params}/>` (can add setParams) | `lib/components/workspace/Pane.svelte:62-67` (read) |
| `openIn` already updates `ex.params` on focus | `lib/workspace/store.ts:163-166` (read) |
| `closeTab` reseeds DEFAULT_VIEW, never empties | `lib/workspace/store.ts:210-217` (read) |
| `sanitizeNode` drops removed-view tabs | `lib/workspace/store.ts:95-100` (read) |
| Imperative pointer-drag pattern to copy | `lib/components/workspace/SplitPane.svelte:16-43`; `ChatFloat.svelte:242-382` (read/sweep) |
| Reusable modal shape | `lib/components/WelcomeModal.svelte` (`{#if open}`+Escape+backdrop) (sweep 4) |
| Un-migrated routes unreachable; removed handled | `Sidebar.svelte` comingLater = no href (sweep 4); `store.ts:96` (read) |

## Revision history

- **v1 (this doc).** Sweep-first. Pivot from the handoff sketch: the handoff listed
  URL-sync and B4 as separable, but sweep 1 proved `LibraryView` is a competing URL
  author, so **they must ship together** (single-author invariant). Also dropped the
  "unknown-viewId fallback tab" and `spaces` de-route from this PR as untestable /
  unreachable (documented above) rather than add dead code.
