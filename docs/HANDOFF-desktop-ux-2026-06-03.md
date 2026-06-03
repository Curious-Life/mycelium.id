# HANDOFF — Desktop UX, image ingestion, Curious Life (2026-06-03)

Everything below is **shipped to `main`** across three squash-merged PRs:
- **#53** `Desktop UX + image ingestion + Curious Life` (3fedee8)
- **#54** `Fix desktop WKWebView: dup window title, profile crash, WebGL leak` (ebeb652)
- **#55** `Desktop: standard title bar so the header aligns with the sidebar` (4b0f7d7)

The running packaged `.app` (`src-tauri/target/release/bundle/macos/Mycelium.app`,
built 2026-06-03 11:41) is that merged code, on the real vault (132 msgs / 11
territories / 7 realms). Design doc: `docs/DESIGN-desktop-ux-image-ingest-2026-06-03.md`.

---

## What shipped

### 1. Window chrome (drag + hamburger + title)
- **Drag worked-but-denied → fixed.** The drag code already shipped; it was denied
  because there was no `src-tauri/capabilities/` and the app loads a **remote** origin.
  Added `src-tauri/capabilities/default.json` (`core:default` + `core:window:allow-start-dragging`,
  scoped to `http://127.0.0.1:8787`).
- **Duplicate "Mycelium" / crowded hamburger** = the macOS **window title** painting over
  the traffic-lights (overlay title bar). Final fix (#55): **`TitleBarStyle::Visible`** +
  `.hidden_title(true)` in `main.rs` — the window buttons get their own strip, the in-app
  header sits below it at normal padding and lines up with the sidebar. (Intermediate #54
  hid the title; #55 also fixed the alignment.) Window stays **opaque** (the #52 flicker fix).
- `app.html` tags `html.is-tauri` pre-paint (used by app.css to drop `backdrop-filter`,
  which WKWebView mis-repaints). The old `.app-header` left-clearance was removed in #55.

### 2. Global drop zone (web + desktop)
- New `portal-app/src/lib/components/shell/ImportDropZone.svelte`, mounted in `(app)/+layout.svelte`.
  Window-level dragenter/over/leave/drop with a counter → full-window "Drop to add to your
  vault" overlay. Archives (`.zip/.json`) → the import pipeline; everything else → `/upload/file`.
- `ChatFloat.svelte`'s pre-existing window-drop `$effect` is now gated on `visible` (chat is
  deferred in V1) so the two don't both fire.

### 3. Image (and any-file) upload + enrichment
- New **`POST /api/v1/portal/upload/file`** in `src/portal-uploads.js`: stores an encrypted
  blob + attachments row + a linked message (→ embed → mindscape). A PNG is no longer rejected
  (the old `/upload` only understood Claude/ChatGPT export ZIPs).
- **Image enrichment = Ollama vision, fail-soft** (user choice). `src/enrich/describe-image.js`
  probes Ollama `/api/tags` for a vision model (`MYCELIUM_VISION_MODEL` override; else
  llava / llama3.2-vision / moondream / …), captions the image, and the caption is embedded.
  No model / Ollama down → caption falls back to the filename; **never blocks the upload.**
  `src/inference/local.js` `localInfer` gained an `images:[base64]` param.
- `scripts/verify-describe-image.mjs` (9 checks) wired into `npm run verify`.

### 4. Curious Life
- New aspirational nav section in `Sidebar.svelte`, **between the working tabs and "Coming
  later"** (aurum→amethyst accent, compass icon). `PrimaryView` gained `'curious-life'`
  (navigation.ts) + Header `viewLabels`.
- New route `(app)/curious-life/+page.svelte` — poetic, Goethe-anchored ("Wouldst thou into
  the infinite stride? / Then walk the finite to every side."): hero → a 3-station "traverse"
  (path behind → ground beneath → self ahead) → CTA to the mindscape. **Pure-CSS atmosphere,
  NO WebGL / no backdrop-filter** (Tauri-safe).

### 5. The real profile-page fix (the hard one)
- Profile "doesn't load in Tauri" was **NOT** a loading/reactivity bug. The Data Overview
  rendered `stats.messages.dateRange.first`, but `/portal/stats` returns **`dateRange: null`**,
  so on any populated vault the render threw `Cannot read properties of null (reading 'first')`,
  which **aborted the component's render and froze it on "Loading…".** Fix = **`dateRange?.first`**
  (one char, in `profile/+page.svelte`).
- **WebGL leak (also fixed)** — `Mindscape3D.svelte` onDestroy called `dispose()` but not
  `renderer.forceContextLoss()`; WebKit leaks the GPU context on leaving the 3D map, which
  can wedge the webview. Now forces context loss + detaches the canvas.

---

## Verification
- `npm run verify` full chain **GO** (incl. new `verify:describe-image`).
- In-browser against a `sqlite3 .backup` **copy of the real (populated) vault**: profile card
  renders with real data; PNG → 200, encrypted at rest (magic `MYCB`, no raw PNG); drop overlay;
  Curious Life (both themes); WebGL stress (14 map↔profile cycles, contexts freed, no wedge).
- Native-shell items (title bar / drag / hamburger alignment) confirmed by the user in the
  running `.app`.

## Deferred / follow-ups (none blocking)
- **Image captions need a local vision model.** Ollama isn't bundled and isn't running on this
  Mac; until the user runs `ollama pull llava` (or sets `MYCELIUM_VISION_MODEL`), images import
  but embed on their filename. Options if we want out-of-box captions: bundle a small ONNX
  captioner (+hundreds of MB) or OCR-only. (Design notes in the design doc.)
- **Populated-map overlay simplification** (from the prior session) — the "N points · N realms"
  line, LAYERS panel, All-Realms list live in `Mindscape3D.svelte` / `MindscapeDetail.svelte`;
  still verbose, deferred until looking at the populated map.
- **Now-redundant but harmless:** with the native title bar, the header's `data-tauri-drag-region`
  + `startWindowDrag` fallback + the drag capability are belt-and-suspenders (the OS title bar
  drags natively). Left in place for robustness.

## Key learnings (read before the next desktop bug)
- **When the console is opaque (preview headless Chromium OR the WKWebView), capture errors
  FIRST** by injecting `window.addEventListener('error'/'unhandledrejection', …)` into
  `portal-app/src/app.html` (temp), rebuild, read `window.__errs`. This is what finally
  surfaced the profile crash after a long, wrong detour through loading patterns. Do NOT
  theorize about Svelte reactivity before ruling out a thrown exception.
- **WKWebView quirks seen this session:** needs `forceContextLoss()` to free WebGL on unmount;
  `hidden_title` to drop the overlay-title-bar text; `TitleBarStyle::Visible` to get content
  below the traffic-lights; opaque window (no transparency) to avoid flicker.
- **Testing on real data safely:** `sqlite3 "$REAL_DB" ".backup /tmp/copy.db"` + run a 2nd
  server with `MYCELIUM_DATA_DIR=/tmp/... MYCELIUM_REST_PORT=8790 MYCELIUM_EMBED_PORT=8092
  MYCELIUM_KEY_SOURCE=keychain` (reuses the real keychain keys). The local REST server is
  **not auth-gated**, so a plain browser/preview pointed at it renders the full app.
- The app is **CSR-only** (`+layout.ts` `ssr=false`); a `+page.ts` `load` broke the shell —
  don't reach for it here.

## Repo / build notes (unchanged)
- Node `/opt/homebrew/opt/node@22/bin`; cargo `~/.cargo/bin`; tauri-cli 2.11.2.
- `cargo tauri build` → the `.app` (the DMG step fails harmlessly). Rebuild needs the running
  app quit first (`pkill -9 -f "Mycelium.app/Contents"`). `portal-app/build` is gitignored
  (regenerated by `build-app-bundle.sh`).
- Default branch `main`, remote `Curious-Life/mycelium.id`, squash-PR workflow via `gh`.
