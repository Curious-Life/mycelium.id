# HANDOFF — Workspace shell (tabbed, resizable, multi-pane) · 2026-06-03

The fixed sidebar + one-view-at-a-time shell is becoming an **IDE-style workspace**
(default tab = Mindscape), per a Claude-Code-style screenshot the user shared.

- **Design:** `docs/DESIGN-workspace-shell-2026-06-03.md` (sweep-first: 5 Explore
  sweeps + 6 first-hand reads + 13-row verification table).
- **Phase A: SHIPPED → main as PR #60 (8ac4b69).**
- **Phase B: SHIPPED → main as PR #62 (fa0dfa7)** — split panes + resizable
  divider + Recents + empty-pane launcher + focus ring. Rebuilt + installed to
  `/Applications/Mycelium.app`; verified on the **real vault**: 3D Mindscape |
  Library side-by-side, **ONE** WebGL context, zero errors.
- **Phase C (part 1): SHIPPED → main as PR #65 (10822a4)** — tab↔URL sync
  (fixes the §2.2 close+reload-reopens quirk), **Library doc-state → tab params**
  (B4; the workspace is now the single URL author; `library` is a singleton tab
  carrying `params.doc`; deep-links now auto-select), **⌘K command palette**, and
  **drag-to-reorder tabs**. Sweep-first design:
  `docs/DESIGN-workspace-shell-phase-c-2026-06-04.md`. Verified live on the
  isolated `:8796` preview (URL sync, the quirk fix, multi-pane URL, palette,
  reorder, split regression) + full `npm run verify` GO (real exit, no `| tail`).
  **Phase C-part-2 DEFERRED** with rationale in that design doc: drag-to-edge
  split, LRU eviction (premature), mobile single-pane (desktop app), `spaces/[id]`
  de-route + unknown-viewId fallback (un-migrated routes are unreachable).
- **LESSON (caused a hidden regression):** running the gate as `npm run verify |
  tail` MASKS the npm exit code (the pipe returns tail's 0). Phase A silently
  broke `verify:nav` N8 on main (it asserted the Import *route* had a drop zone,
  but de-routing moved that UI into `lib/views/ImportView.svelte`); only a
  non-piped run surfaced it. Fixed in #62. Always capture the real exit:
  `npm run verify > /tmp/v.log 2>&1; echo $?`.

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
  `setup-preview` (sleep, port 8796) entry in **`~/Documents/.claude/launch.json`**
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

## 5. Phase B — split panes + resize + recents (SHIPPED, #62)

**What shipped** (built per the plan below, kept for reference): the state widened
to a pane TREE (`WorkspaceState.root: WsNode`); `lib/components/workspace/` gained
`WorkspaceNode.svelte` (recursive: leaf→Pane, split→SplitPane, children passed as
snippets to dodge a circular import) and `SplitPane.svelte` (draggable divider,
**imperative** resize like ChatFloat — mutate `flex-basis` during drag, commit
`sizes` on pointerup, clamp 15–85%). `store.ts` gained tree helpers
(`findLeaf`/`allLeaves`/`updateLeaf`/`updateSplit`/`replaceLeaf`/`removeLeaf`) +
`splitPane`/`resizeSplit`/`closePane`/`openInPane`/`focusPane`; `closeTab` now
**collapses an emptied split** (sibling absorbs) and never empties the whole
workspace. `Pane.svelte` got a focus ring (multi-pane only) + an **empty-pane
launcher** (a fresh split shows a section grid). `TabStrip.svelte` got the **⊞
split** button. The **Recents** region was added to `Sidebar.svelte` (between
Curious Life and Coming soon; `workspace.recents` is filled on `closeTab`). Cap =
**4 panes**. **B4 (de-route `spaces/[id]` + Library doc-state) was DEFERRED** —
not done; those + the other un-migrated routes still render hidden (see §2.3).

Original plan (B1–B5), for reference:

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

## 6. Phase C — drag/reorder, URL sync, LRU, palette

**Part 1 SHIPPED (#65, 10822a4)** — design
`docs/DESIGN-workspace-shell-phase-c-2026-06-04.md`. ✅ = done; ⏳ = **Phase
C-part-2** (deferred, full rationale in that doc's scope table + "Decision criteria").

- ✅ **Drag-to-reorder tabs** within a strip — pointer-based (`TabStrip` +
  `moveTabWithinPane`; <5px = click → focus, past it = drag → trailing click
  swallowed). No HTML5 DnD (the app has none).
- ⏳ **Drag a tab to a pane edge → split** — needs cross-pane `moveTab` + a
  drop-zone overlay; reorder delivers most of the drag value first.
- ✅ **tab↔URL sync** — on focused-tab change, SvelteKit `replaceState` to the
  tab's canonical URL; gated by `enableUrlSync()` (set in the `(app)` layout
  `onMount`), skipped in `?capture`. Fixed the §2.2 quirk. **Coupled with B4**
  (Library doc-state → `params.doc`; `registry.library` is now `singleton`; the
  workspace is the SINGLE URL author; `openIn` merges params on focus; deep-link
  auto-selects). Verified only `/login|/setup|/unlock` react to `$page.url`, so
  syncing `(app)` URLs can't loop.
- ⏳ **LRU eviction** — premature: Mindscape is a 1-WebGL-context singleton, other
  views are light DOM, and eviction would regress keep-alive (lost scroll/edit).
- ✅ **Command palette (⌘K)** — substring over registry sections + param'd recents
  → `openOrFocus`; `CommandPalette.svelte` (WelcomeModal shape; Escape/backdrop).
  (⌘K, not ⌘P; no fuzzy dep.)
- ⏳ **Narrow viewport / mobile single-pane** — this is a desktop app; `<768px`
  isn't a V1 target (`BottomTabBar` already drives sections on narrow).
- ⏳ **`spaces/[id]` de-route + unknown-viewId fallback tab** — un-migrated routes
  are unreachable (disabled "Coming later", no href); removed-view tabs already
  dropped by `sanitizeNode` (`store.ts`). Untestable dead code today.

---

## 7. Quick-start for the next session

Workspace **A + B + C-part-1 are done + installed**. Two threads remain:

**(a) Workspace Phase C-part-2** (optional polish — the ⏳ items in §6): drag-to-
edge split, LRU eviction, mobile single-pane, `spaces/[id]` de-route +
unknown-viewId fallback. ALL deferred *with rationale* in
`docs/DESIGN-workspace-shell-phase-c-2026-06-04.md` (see its scope table +
"Decision criteria for Phase C-part-2") — pull each only when its real trigger
appears (edge-split when a user wants to "drag a tab out"; LRU when >1 heavy
WebGL/video view can be open at once; mobile when a non-desktop target is
committed; `spaces` when it leaves "Coming later"). Same workflow: branch off
main → build/verify on the isolated `:8796` preview (real vault is
`~/Library/Application Support/id.mycelium.app`; use temp `MYCELIUM_KC_*`, NEVER
its Keychain — the throwaway injects random keys via `startRestServer({userHex,
systemHex,…, portalMode:'auto'})` + `applyMigrations`, serving the fresh build) →
**`npm run verify` WITHOUT `| tail`** (top LESSON) → squash PR → rebuild + install
the `.app` (§3 — WAIT for `:8787` to free before relaunch).

**(b) Import/connectors revamp** (user-flagged; spawn-task chip created): make
importing quick — (1) open an **Obsidian vault folder** directly (Tauri fs /
folder picker → walk `*.md` → ingest), and (2) a **live-connectors framework**
(OAuth: Gmail, Linear, … that continuously sync, not one-time uploads). Current
import = `src/portal-uploads.js` (`/upload` ZIP, `/upload/file`) +
`lib/views/ImportView.svelte` + `ConnectionsChecklist.svelte`; tokens → encrypted
`secrets` table. Its own effort; sweep-first-design when picked up.

**Adjacent context:** first-run hardening (key-backup / welcome-persist / optional
passphrase-lock) shipped this session as #57/#58/#59 — see
`docs/DESIGN-first-run-hardening-2026-06-03.md`. The new `/account/status` shape
(`open/needsSetup/locked/passphraseEnabled`) is what the workspace gate reads.
