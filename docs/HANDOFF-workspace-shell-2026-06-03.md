# HANDOFF — Workspace shell (tabbed, resizable, multi-pane) · 2026-06-03

The fixed sidebar + one-view-at-a-time shell is becoming an **IDE-style workspace**
(default tab = Mindscape), per a Claude-Code-style screenshot the user shared.

- **Design:** `docs/DESIGN-workspace-shell-2026-06-03.md` (sweep-first: 5 Explore
  sweeps + 6 first-hand reads + 13-row verification table).
- **Phase A: SHIPPED → main as PR #60 (8ac4b69)**, rebuilt + installed to
  `/Applications/Mycelium.app`, verified on the **real vault** (132 msgs / 7
  realms / 11 territories) — tabs render with the live 3D map, zero errors.
- **Phase B + C: NOT started.** Detailed build plans below.

User-locked decisions: **split panes in ONE window** (no separate OS windows);
**hybrid sidebar** (sections open tabs + recents + keep "Coming soon").

---

## 1. What Phase A shipped (the architecture)

**Routes-as-intents + one persistent Workspace.** SvelteKit is page-routed + SPA
(`fallback:200.html`, ssr=false), and navigation was dual-driven (`goto()` + a
store). So instead of removing routing:

- `(app)/+layout.svelte` renders a persistent **`WorkspaceRoot`** as the content;
  `{@render children()}` lives in a `display:none` slot.
- Each `(app)/<view>/+page.svelte` shrank to a 2-line **intent**:
  `onMount(() => workspace.openFromRoute(viewId, params))`, renders nothing.
- The heavy view UI **moved** to `lib/views/*` via `git mv` (history preserved).
- Result: **every existing `goto('/x')` still works** (→ intent → idempotent
  `openOrFocus`); deep-links (`/library?doc=`) + `?capture` mode handled; the
  `/login` `/setup` `/unlock` guards (root `+layout`) untouched.

**Files (Phase A):**
| File | Role |
|---|---|
| `lib/workspace/types.ts` | `Tab`, `LeafPane`, `SplitNode` (reserved), `WorkspaceState` |
| `lib/workspace/registry.ts` | `viewId → {title,icon,singleton,key?,load()}`; the 7 sidebar views |
| `lib/workspace/store.ts` | `openOrFocus`/`openFromRoute`/`focusTab`/`closeTab`/recents; persist `mycelium-workspace`; restore + validate vs registry; mirrors `navigation.primaryView` |
| `lib/components/workspace/{WorkspaceRoot,Pane,TabStrip,Tab}.svelte` | single pane; keep-alive tab bodies; tab row + "+" launcher |
| `lib/views/{Mindscape,Library,Import,Timeline,Profile,CuriousLife,Settings}View.svelte` | the de-routed pages (git mv'd) |
| `routes/(app)/<those>/+page.svelte` | the 2-line intents |
| `routes/(app)/+layout.svelte` | renders WorkspaceRoot + hidden children |
| `lib/components/mindscape/Mindscape3D.svelte` | `+ active` prop → `renderLoop` pause |

**Key behaviors (verified in preview + the installed app):**
- Default Mindscape tab; renders the real 3D map (canvas) when active.
- Sidebar sections open/focus tabs; switch keeps **both tabs mounted** (keep-alive);
  close; **persistence round-trips** a reload; Coming soon intact.
- **Mindscape is singleton** + **pauses its rAF when backgrounded** (only one
  WebGL context ever; close-only `forceContextLoss`).

---

## 2. Known Phase-A limitations (fixed in B/C)

1. **No splits / resize / recents yet** → Phase B.
2. **tab→URL not synced**: closing a tab then *reloading on its URL* reopens it
   (the URL still says `/library`, so the intent re-adds the tab). Harmless;
   Phase C adds a guarded `replaceState` on focus change.
3. **Un-migrated `(app)` routes render HIDDEN.** Only the 7 sidebar sections are
   registered as views. The other ~16 routes (activity, agents, body, chat,
   connections, contexts, cycles, fleet, intel, media, modules, spaces,
   spaces/[id], vitality, wealth) still render in the hidden `children` slot if
   navigated to — i.e. they won't show. **Currently harmless** because they're
   all behind the *disabled* "Coming soon" list (not reachable in V1), but Phase
   B should migrate the reachable ones (spaces/[id] especially) and decide a
   fallback for the rest. (A generic "unknown viewId → friendly empty tab" guard
   is cheap insurance.)
4. Pre-existing a11y lint warnings carried over with the moved files (non-blocking).

---

## 3. Build · install · run the desktop app (procedure + gotcha)

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$HOME/.cargo/bin:$PATH"
cd ~/mycelium.id
cargo tauri build              # beforeBuildCommand = scripts/build-app-bundle.sh
                               # (caches node/python/model; builds portal; stages ~1GB)
# → src-tauri/target/release/bundle/macos/Mycelium.app  (+ a .dmg)
```
Install + launch (the user runs it from `/Applications`):
```bash
pkill -9 -f "Mycelium.app/Contents"                       # quit old
PIDS=$(lsof -ti tcp:8787); [ -n "$PIDS" ] && kill -9 $PIDS  # free the server port
until ! lsof -ti tcp:8787 >/dev/null 2>&1; do sleep 0.5; done   # WAIT for release
sleep 2
rm -rf /Applications/Mycelium.app
ditto src-tauri/target/release/bundle/macos/Mycelium.app /Applications/Mycelium.app
open /Applications/Mycelium.app
```
**GOTCHA (cost a restart this session):** if you launch the new app before
`:8787` is released by the killed old server, the new app's node can't bind and
dies (window shows connection-refused / serves a stale process briefly). ALWAYS
wait for `:8787` to free before `open`. Confirm boot:
`curl -s http://127.0.0.1:8787/api/v1/account/status` → expect the **new shape**
`{"open":true,...}` (old shape `{"initialized":...}` alone = a stale server).

Local builds aren't quarantined, so Gatekeeper doesn't block them.

---

## 4. How to verify a portal change (no real-vault risk)

Two patterns, both used this session:

- **Isolated throwaway vault** (for shell/flow logic): a tiny launcher that calls
  `startRestServer({dbPath,kcvPath})` with explicit ephemeral paths + temp
  Keychain names (`MYCELIUM_KC_*`) + `MYCELIUM_DISABLE_EMBED=1`, on port 8796.
  `curl POST /api/v1/account/setup` to open it. Point the preview MCP at it via a
  `setup-preview` (sleep, port 8796) entry in **`/Users/altus/Documents/.claude/launch.json`**
  (the preview reads the SESSION-root launch.json, NOT the repo's). Clean up: kill
  the node, delete the temp KC items, rm the temp dir.
- **Real-data, read-only** (for "does it choke on real data"): rebuild the portal,
  let the installed app serve it on `:8787`, then `preview_start("mycelium")`
  (already an 8787 entry) and inspect/screenshot. Separate browser from the app's
  WKWebView, but same served portal + real data.

Theme in the preview defaults light; the app is dark — set `data-theme=dark` via
eval to match. Build: `npm --prefix portal-app run build` (the a11y warnings are
not errors). Backend `npm run verify` is unaffected by portal-only changes.

---

## 5. Phase B — split panes + resize + recents (the plan)

Goal: the side-by-side layout from the screenshot (e.g. Mindscape | a document),
a draggable divider, and the Recents list. ~450 LOC.

**B1 · Generalize the tree (store + types).**
- `types.ts`: widen `WorkspaceState.root: LeafPane` → `WsNode` (`LeafPane |
  SplitNode`). `SplitNode` already defined.
- `store.ts`: add tree helpers — `findPane(id)`, `findParent(id)`, `replaceNode`.
  Operations: `splitPane(paneId, dir, viewId?)` (wrap a leaf in a SplitNode with a
  new sibling leaf), `resizeSplit(splitId, [a,b])`, `moveTab(tabId, toPaneId,
  index?)`, `closePane(id)` (collapse the split, sibling absorbs the space).
  `openOrFocus` targets `focusedPaneId`'s leaf. Update `sanitize()` to validate
  the recursive tree (drop unknown viewIds; collapse empty leaves).
- Keep the `mycelium-workspace` persistence key; bump an internal `v` and
  fall back to default on shape mismatch.

**B2 · Recursive render + SplitPane.**
- `WorkspaceRoot.svelte`: `{#if node.kind==='leaf'}<Pane>{:else}<SplitPane>` with
  the two children rendered recursively.
- `SplitPane.svelte` (new): flex row/col + a draggable divider. **Reuse
  ChatFloat's imperative pattern** (`ChatFloat.svelte`): mutate the two panes'
  `flex-basis` directly during `pointermove` (don't thrash Svelte state), commit
  the final `sizes` to the store on `pointerup`. Min pane size ~240px; clamp.
- `Pane.svelte`: set `workspace.focusedPaneId` on pointerdown; show a subtle focus
  ring on the focused pane. Add a "split" affordance (a button in `TabStrip`, e.g.
  a ⊟/⊞ icon → `splitPane(thisPaneId,'h')`).

**B3 · Recents (sidebar).**
- `workspace.recents` is already populated on `closeTab`. Add a **Recents** region
  in `Sidebar.svelte` between the sections and "Coming soon": list the last N
  (sorted by `at`), click → `workspace.openOrFocus(viewId, params)`. (Sidebar
  currently needs NO changes for sections — they `goto()` → intents. Recents is
  the one addition.)

**B4 · De-route the next reachable views.**
- **Spaces:** `git mv routes/(app)/spaces/[id]/+page.svelte → lib/views/SpaceView.svelte`;
  intent reads `$page.params.id` → `openFromRoute('space',{id})`; `SpaceView` uses
  `let { spaceId } = $props()` (param→prop, see sweep B); register `space`
  (`key: p => 'space:'+p.id`). Same for `spaces/+page.svelte` → a `SpacesView`.
- **Library doc state:** replace `LibraryView`'s `history.pushState('/library?doc=')`
  + popstate with updating the tab's `params.doc` via a small callback the Pane
  passes down (or `workspace.setTabParams(tabId,{doc})`). This makes Library a
  proper keyed tab (registry `key` already = `library:`+doc).

**B5 · Verify** in the isolated preview: split a pane, drag the divider (sizes
persist), drag/open a second view, focus ring follows clicks, recents populate +
reopen, Spaces deep-link opens a SpaceView tab. Then rebuild + install + try.
Own PR.

---

## 6. Phase C — drag/reorder, URL sync, LRU, palette (the plan)

~450 LOC. Each independently shippable; pick the highest-value first.

- **Drag-to-reorder tabs** within a strip (pointer-based; reuse imperative drag;
  reorder `pane.tabs`).
- **Drag a tab to a pane edge → split** (drop-zone overlay on hover near an edge →
  `splitPane` + `moveTab`).
- **tab↔URL sync:** on focused-tab change, `replaceState` to the tab's canonical
  URL (guard against the intent re-firing `openOrFocus` — compare current state /
  a flag). Fixes the "close + reload reopens" quirk (§2.2).
- **LRU eviction:** cap simultaneously-mounted heavy tabs; evict least-recently-
  active (full teardown incl. `forceContextLoss`). `log`/toast what was dropped.
- **Command palette** (⌘P): fuzzy over registry sections + recents (+ documents
  later) → open as a tab. Replaces/augments the "+" menu.
- **Narrow viewport:** `WorkspaceRoot` renders only the focused pane's active tab
  full-screen (no splits/resizers); `BottomTabBar` still drives sections.

---

## 7. Quick-start for the next session

1. Read this handoff + `docs/DESIGN-workspace-shell-2026-06-03.md` (§ the
   tree/SplitPane decisions + the verification table).
2. `git checkout main && git pull` (Phase A = #60 is in).
3. Branch `feat/workspace-shell-phase-b`. Start at **B1** (widen the tree).
4. Build/verify with the isolated `:8796` preview (the real vault is
   `~/Library/Application Support/id.mycelium.app`; testing must NOT touch its
   Keychain — use temp `MYCELIUM_KC_*`).
5. PR per phase (squash-merge after `npm run verify` GO + a preview check), then
   rebuild + install the `.app` (§3) for the user to feel it.

**Adjacent context:** first-run hardening (key-backup / welcome-persist / optional
passphrase-lock) shipped this session as #57/#58/#59 — see
`docs/DESIGN-first-run-hardening-2026-06-03.md`. The new `/account/status` shape
(`open/needsSetup/locked/passphraseEnabled`) is what the workspace gate reads.
