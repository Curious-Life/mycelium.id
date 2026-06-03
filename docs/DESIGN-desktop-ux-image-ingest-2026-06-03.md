# DESIGN — Desktop chrome + image ingestion + profile fix (2026-06-03)

Sweep-first-design for a 5-part request: (1) window-drag strip in the Tauri app,
(2) misplaced hamburger overlapping the "Mycelium" wordmark, (3) a drag-over file
**drop zone** (web + desktop), (4) accept **image uploads** and enrich them with the
local LLM, (5) the **profile page not loading**.

6 parallel Explore sweeps + live pressure-testing (read cited code, curled the running
server, drove the running app in a headless browser via the preview MCP, inspected the
served JS chunks, queried the live vault schema read-only). Several findings **contradict
the user's framing** — documented below so we fix the real causes, not the symptoms.

---

## TL;DR — the real root causes (all verified)

| # | Reported | Real root cause (verified) |
|---|---|---|
| 1 | "no drag strip" | The drag code **already ships** (`Header.svelte:60-67`, `data-tauri-drag-region` + `startWindowDrag` fallback). It silently fails because **there is no `src-tauri/capabilities/` dir** → Tauri v2 denies the `window:start-dragging` IPC by default, and the app loads a **remote origin** (`http://127.0.0.1:8787`) which needs a capability with `remote.urls` scoping to be granted anything. |
| 2 | "hamburger overlaps Mycelium" | `isTauri` (hence the 68px macOS traffic-light spacer) is set in `onMount` **after first paint** (`Header.svelte:15-16`), so the hamburger renders at x≈0 under the traffic lights before shifting. Combined with the mindscape rail's "Mycelium" breadcrumb (`MindscapeDetail.svelte:224`) directly below, the top-left is cramped/ambiguous. Fix = make traffic-light clearance deterministic + a clean header wordmark. |
| 3 | "no drop zone" | A global drop overlay **exists but is chat-scoped** (`ChatFloat.svelte:968-1008` → "Drop files to attach") and uploads via `chunked-upload.ts` → `/api/v1/portal/upload`, the **ZIP-only import router**. There is **no vault-import drop zone**, and the chat one rejects non-ZIPs. |
| 4 | "it rejected my PNG; enrich with local LLM" | `portalUploadsRouter` only understands **Claude/ChatGPT export ZIPs** (`portal-uploads.js:72-92`): a PNG hits `JSZip.loadAsync` → `"unrecognized file — upload a … .zip"`. The server-side blob path (`uploadAttachment` → `blob-store.putBlob`, `server-http.js:239`) has **no MIME rejection** and is image-safe, but isn't wired into the portal. Enrichment is **text-only** (Nomic 768-d, `embed-service.py`); the only local LLM is **Ollama `llama3.1` (text)** (`inference/local.js:14`) — **no vision/OCR exists** (`upload.js:12` calls it "Tier-2-gated"). Image→text needs a vision step. |
| 5 | "profile won't load" | **Purely frontend.** `/api/v1/portal/profile` returns **200** with valid data (curled live: 132 msgs/11 territories/7 realms). On a clean `/profile` load the `$effect` **does** run and fetches `/profile`+`/stats` once each (per-document Performance API), both 200 — yet `loading` never flips false and **no** error toast appears (so loadProfile's `finally` never runs). The page hangs on "Loading…". Plus a latent `ReferenceError`: `+page.svelte:218` calls `apiPost` which is **not imported** (only `api,apiGet,apiPut`). |

**Pivots forced by the sweep:** #1 and #3 were "add a drag region / add a drop zone" in
the user's framing — but both already exist in code; the work is *making them function*
(a Tauri capability) and *adding a vault-import surface distinct from chat*. #5 looked
like a backend/500 — it's a client hang. This is the sweep-first-design payoff.

---

## Verification table

| Assumption | Verified at |
|---|---|
| Drag code exists; relies on `data-tauri-drag-region` + JS `startDragging` fallback | `portal-app/src/lib/components/shell/Header.svelte:60-67, 18-27` |
| No `src-tauri/capabilities/` dir exists → JS IPC deny-by-default | `ls src-tauri/capabilities` → absent (Bash) |
| App loads a **remote** origin (needs `remote.urls` capability scoping) | `src-tauri/src/main.rs:132-149` (`WebviewUrl::External(http://127.0.0.1:8787)`) |
| `withGlobalTauri:true` (so `window.__TAURI__` exists for the fallback) | `src-tauri/tauri.conf.json:11` |
| `isTauri`/68px spacer set in onMount (post-paint) | `Header.svelte:15-16, 66-68` |
| "Mycelium" rail breadcrumb under the header | `MindscapeDetail.svelte:224`; mindscape page `+page.svelte:573-576` |
| Global drop overlay is chat-scoped, posts to ZIP-only `/upload` | `ChatFloat.svelte:968-1008, 450`; `chunked-upload.ts:76` |
| PNG rejected because `/upload` is ZIP-only | `src/portal-uploads.js:72-92` (JSZip → "unrecognized file") |
| Blob path is image-safe, no MIME reject, encrypts at rest, queues enrich | `src/ingest/upload.js:30-62`, `src/ingest/blob-store.js:37-63` |
| `uploadAttachment(..., enqueueEnrichment)` wired w/ drainer nudge | `src/server-http.js:239-245`, `src/server-rest.js:90, 180` |
| Embedder is text-only; drainer embeds `messages.content` | `pipeline/embed-service.py:247-250`, `src/enrich/drainer.js:55-62` |
| Only local LLM = Ollama llama3.1 (text); no vision/OCR | `src/inference/local.js:13-14`, `src/inference/router.js:23-25` |
| `/portal/profile` returns 200 with full data | curl `http://127.0.0.1:8787/api/v1/portal/profile` → 200 JSON |
| readProfile cannot throw (try/catch + countOf) → never 500 | `src/portal-compat.js:131-156, 161-163` |
| App is CSR-only (ssr=false) → effects run client-side | `portal-app/src/routes/+layout.ts:1` |
| Profile effect runs + fetches once, loading stays true, no error toast | preview MCP: Performance API `fetched_profile:1, fetched_stats:1`; DOM `.profile-page .loading` present, `.card` absent |
| `apiPost` used but not imported on the profile page | `profile/+page.svelte:3, 218`; `$lib/api.ts:84` (it IS exported) |
| Live `user_profiles` has avatar_url/exlibris_url/scores columns | sqlite3 `.schema user_profiles` (read-only) |

---

## Designs

### 1 — Window drag strip (Tauri capability)
Add `src-tauri/capabilities/default.json` granting the drag permission to the **main**
window AND the **remote** origin:
```json
{ "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default", "description": "Mycelium webview permissions",
  "windows": ["main"],
  "remote": { "urls": ["http://127.0.0.1:8787", "http://localhost:8787"] },
  "permissions": ["core:default", "core:window:allow-start-dragging"] }
```
This makes the existing `startWindowDrag` fallback work (it already calls
`getCurrentWindow().startDragging()`), so the whole header becomes a drag strip. No
frontend change needed for the mechanism. Verify in the real .app (preview can't fake
Tauri). Low risk: `core:default` is the Tauri-recommended baseline.

### 2 — Header chrome (deterministic clearance + wordmark)
- Make traffic-light clearance **CSS-driven** off `html.is-tauri` (already added in
  `+layout.svelte:23-25`) instead of the post-paint `isTauri` flag, so there's no
  first-paint shift and the hamburger is always cleanly placed.
- Add a small **"Mycelium" wordmark** in the header next to the hamburger (left), so the
  brand has one intentional home and the hamburger has a clear left position. Keep it out
  of the drag-exclusion (text isn't interactive).
- Keep the mindscape rail breadcrumb (it's contextual nav, not the app brand).
- Verify in the .app + the browser at 1105×802.

### 3 + 4 — Vault drop zone + image upload + enrichment

**Server (accept + store, never reject a real file):** new attachment endpoint on the
portal sub-app (has `db`, `userId`, `enqueueEnrichment`):
`POST /api/v1/portal/upload/file` (multipart `file`, reuse the Busboy reader from
`portal-uploads.js`). It calls `uploadAttachment(db, {userId, bytes, fileName, fileType,
asMessage:true}, enqueueEnrichment)` → encrypted blob + `attachments` row + a linked
`messages` row at `nlp_processed=0` (so it enters the enrich/embed pipeline) → returns
`{ attachmentId, type, filename }`. Accept images + common docs; size-cap (e.g. 25MB).
Keep `/upload` (ZIP import) unchanged. ChatFloat's `chunkedUpload` and the new drop zone
both target `/upload/file` for non-export files; `.zip/.json` still route to `/upload`.

**Frontend drop zone:** a small `<ImportDropZone>` mounted in the **(app) layout** (so it
works on every screen, web + desktop). Window-level `dragenter/over/leave/drop` with a
counter (the ChatFloat pattern, `:968-1008`), showing a full-window overlay "Drop to add
to your vault". On drop: `.zip/.json` → existing import; images/docs → `/upload/file`;
toast success/error (`$lib/stores/toast`). Tauri already does `.disable_drag_drop_handler()`
(`main.rs:148`) so HTML5 drop receives files. Don't double-handle when the chat composer
is the drop target.

**Image enrichment (image → text → embed), fail-soft:** images have no embeddable text.
Add a vision caption step that runs in the enrich drainer *before* embedding, for messages
whose attachment is an image and whose caption is empty:
- `src/inference/local.js`: extend `localInfer` to accept `images:[base64]` → Ollama
  `/api/generate` `{model, prompt, images}` (Ollama's native vision input).
- New `src/enrich/describe-image.js`: load the blob, call the vision model, store the
  caption as the message `content` (and `attachments.description`) so the **existing**
  text drainer embeds it — the image becomes a first-class mindscape point.
- **Degrade gracefully, never hang** (the generate-robustness principle): probe Ollama
  `/api/tags` for a vision model (`MYCELIUM_VISION_MODEL`, else any `llava|llama3.2-vision|
  moondream|bakllava`). If Ollama is down or no vision model is pulled → embed the
  filename/alt-text placeholder and mark the row enriched-pending (re-enrichable later);
  surface a one-line "image captioning needs a local vision model (ollama pull llava)"
  hint in the UI. A timeout (like `describe-chronicles` `CHRONICLE_INFER_TIMEOUT_MS`)
  guards every call.

> **Open product decision (asking the user):** vision enrichment depends on the user
> running Ollama + pulling a vision model. Alternatives: bundle a small ONNX captioner
> (works out-of-box, +hundreds of MB) or OCR-only. The accept+store+display path ships
> regardless; the enrichment backend is the fork.

### 5 — Profile page (robust load, never hang)
The `$effect`-driven loader provably runs and fetches 200 but `loading` never clears.
Rather than chase the minified effect-scheduling quirk, make it bulletproof:
- Load in **`onMount`** (lifecycle, not a reactive effect — immune to effect-scheduling
  edge cases), not `$effect`.
- A **safety timeout** clears `loading` after ≤6s no matter what ("no silent hangs").
- Add the missing **`apiPost`** import (fixes the latent Recompute `ReferenceError`).
- Defensive: render the page shell even if a fetch fails (show partial + a retry).
- **Empirically verified** by rebuilding the portal and reloading the page in the preview
  until `.profile-page .card` renders.

---

## Implementation order (each independently shippable + verifiable)
1. **Profile fix** (onMount + timeout + apiPost) — smallest, highest user pain; verify in preview.
2. **Tauri capability** (drag) + **header chrome** (clearance + wordmark) — verify in .app.
3. **Server `/upload/file`** + **`<ImportDropZone>`** — accept+store+display images; verify PNG round-trips.
4. **Vision enrichment** (`describe-image.js` + `localInfer` images) — fail-soft; gated on the product decision.
5. Rebuild portal + repackage .app; full `npm run verify`; new `scripts/verify-*` for the upload route.

## Threat model / security
- Image bytes go through the **same AES-256-GCM blob envelope** as the vault
  (`blob-store.js`), fail-closed without the master key. No new at-rest plaintext.
- Vision inference is **on-box Ollama** (127.0.0.1) — image bytes never leave the machine,
  same boundary as `inference/local.js` (no prompt/response logging).
- New endpoint is localhost-only (the whole REST surface is), size-capped, MIME-labelled
  (`file_type` stays plaintext — accepted metadata leak, matches existing attachments).

## Test strategy
- `scripts/verify-upload-file.mjs`: POST a tiny PNG → 200 `{attachmentId}`; blob is
  ciphertext at rest (magic `MYCB`, not the raw PNG); a `messages` row exists at
  `nlp_processed=0`. Add to the `verify` chain.
- `describe-image.js`: unit — no Ollama → returns null/placeholder, never throws; with a
  stub fetch → returns caption; timeout honored.
- Live: PNG drop in the preview → toast + attachment appears; profile renders the card;
  drag works in the repackaged .app.

## Verification (built + run, 2026-06-03)
Implemented on branch `feat/desktop-ux-image-ingest`. Verified against a throwaway
vault on a spare port (new frontend + new backend), driven in a headless browser:
- **Profile** — `onMount` + safety timeout: page renders the card (`stillLoading:false`,
  `hasCard:true`). The `$effect` hang is gone. `apiPost` import added.
- **Drop zone** — a Files `dragenter` shows the "Drop to add to your vault" overlay;
  `dragleave` clears it.
- **Image upload** — `POST /upload/file` with a PNG → **200** `{attachmentId, messageId,
  type:'image', captioned:false}` (fail-soft: no Ollama). Blob on disk begins with magic
  `MYCB` and contains **no raw PNG signature** (encrypted at rest); attachment + message
  rows created, message drained from `nlp_processed=0` (pipeline end-to-end).
- **Header** — `.app-header` + "Mycelium" wordmark render; pre-paint `is-tauri` in app.html.
- **`verify:describe-image`** — 9/9 (localInfer images, vision probe degrade-to-null,
  describeImage never throws).
- **`npm run verify`** — full chain **exit 0** (GO) with the new + changed code included.

**Still to verify in the repackaged `.app`** (needs the real Tauri window): header is a
working window-drag strip (capability), traffic-light clearance, profile/drop on the real
132-msg vault. Repackage = `cargo tauri build` (picks up `capabilities/default.json` +
the fresh `portal-app/build`).

## Out of scope / deferred
- Bundling a vision/OCR model (pending the product decision).
- The populated-overlay simplification (separate, already-tracked follow-up).
- PDF/audio extraction (the same `describe-*` seam; later).
