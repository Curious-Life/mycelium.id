# Design — Generate robustness + transparent recovery-key save

**Date:** 2026-06-02 · **Protocol:** sweep-first-design · **Branch:** main

## Context

A user ran the full first-run flow: created a vault, imported 132 conversations
through the UI, clicked **Generate Mycelium** → it failed with `clustering exited
with code 1`. Separately, the new **Save to Keychain** button writes silently and
the user (rightly) wants to *see* what happened / have the native store confirm.

The surface read ("clustering is broken", "add a save confirmation") is wrong.
The sweep shows two **systemic** gaps. This doc records the sweep, the verified
root causes, and a phased robust fix — not symptom patches.

## Revision history

- **v1 (surface):** "fix clustering + add a download/save confirmation."
- **v2 (post-sweep — this doc):** PIVOT. Clustering isn't broken; **UI imports
  never get embedded** (two background services aren't running, and the app never
  runs the enrich loop), so Generate had nothing to cluster *and* failed
  cryptically. The save button can't use native OS dialogs (no API) and can't use
  Tauri IPC (External-URL webview) — native transparency must route through the
  node server (`open -a`).

## Sweep findings (consolidated, verified)

**A. UI imports are never embedded → Generate has nothing to cluster.**
- Import → `captureMessage(…, enqueueEnrichment)` → `enqueueEnrichment(id)` POSTs
  fire-and-forget to `http://127.0.0.1:8095/enrich-all`; on failure the error
  **never surfaces** (`src/ingest/enqueue.js:17,31,50-54`).
- **Nothing auto-starts `:8095` (enrich loop) or `:8091` (embed model).** The
  Tauri shell spawns only `node src/server-rest.js` (`src-tauri/src/main.rs:64-70`);
  `:8095` only exists under `node src/index.js --enrich` (`src/index.js:120-131`).
- Live state right now: **`:8091` UP, `:8095` DOWN**, and `pipeline/.venv` is
  **missing `sentence_transformers`** (the running `:8091` is from another env).
- Net: the 132 imported rows sit at `nlp_processed=0`, `embedding_768=NULL`.

**B. Generate fails cryptically; no preflight.**
- `cluster.py` resolves the user from `MINDSCAPE_OWNER_ID`/`MYA_USER_ID`, else the
  "most common user in `clustering_points`" — which is **empty** → no user →
  `sys.exit(1)` (`pipeline/cluster.py:1740-1747`). This fires *before* the graceful
  `<min_points` skip (`:1724,1765-1766`). **jobs.js sets `MYCELIUM_USER_ID`, which
  cluster.py never reads** (`src/jobs.js:61`, `pipeline/run-clustering.sh:37`).
- The child's stderr is `'inherit'` (lost); the job reports only the generic
  `clustering exited with code ${code}` (`src/jobs.js:77,109`). The UI shows that
  verbatim. No preflight exists anywhere; `portalMindscapeRouter` *does* have `db`
  (incl. `db.messages`) (`src/portal-mindscape.js:27`).

**C. Save-to-Keychain is silent; native transparency is constrained.**
- `saveRecoveryKeyToKeychain`/`…To1Password` are silent `security`/`op` shells
  (`src/account/keystore.js:112-126`); UI shows only a tiny "Saved ✓".
- The window is `WebviewUrl::External` (`src-tauri/src/main.rs:90`); **no
  `#[tauri::command]` handlers, no capabilities** → the web UI **cannot invoke
  Rust**. It's an HTTP-only browser. Native actions must go through the node
  server, which **can** `open -a "Keychain Access"` / `open onepassword://`.
- There is **no macOS API** to trigger a native "save password to Keychain"
  confirmation for an arbitrary secret (those are Safari/autofill-only). Realistic
  transparency = save + open the store app + a clear in-app confirmation.

## Design

### Phase 1 — Make it honest & transparent (low-risk, no process/env changes)

1. **Preflight in the generate endpoint** (`src/portal-mindscape.js` POST
   `/mycelium/generate`): before `startClusteringJob`, count
   `messages WHERE embedding_768 IS NOT NULL` (via `db.messages`). Branch:
   - `0 embedded, >0 messages` → `409 { reason:'not_embedded', embedded, total }`
     ("Your N conversations are still being processed — none are ready to map
     yet."). Pair with a Phase-2 "process now" affordance.
   - `0 messages` → `409 { reason:'no_messages' }` ("Import conversations first.").
   - `< MIN (e.g. 5)` → `409 { reason:'too_few', embedded, total }`.
   - else spawn as today.
2. **Surface the real error** (`src/jobs.js`): stderr `'inherit'` → `'pipe'`; keep a
   bounded ring buffer (last ~4 KB) of child stderr; on nonzero exit set
   `state.error` to the last non-empty stderr line (the pipeline prints no
   secrets — verified). Keep the generic code as a suffix.
3. **Fix the owner-env mismatch** (`pipeline/run-clustering.sh`): `export
   MINDSCAPE_OWNER_ID="${MYCELIUM_USER_ID}"` so cluster.py resolves the user even
   on partial data (defense beyond the preflight).
4. **Transparent save** (`src/account/router.js` + `keystore.js` + setup UI):
   - After a successful save, the node server runs `open -a "Keychain Access"`
     (or `open onepassword://` for 1Password) — best-effort, non-blocking.
   - Response `{ ok:true, opened:'keychain'|'1password'|false, item:'Mycelium
     Recovery Key' }`. The setup screen shows a clear confirmation panel: *what*
     was saved, *where* (login Keychain → Passwords → "Mycelium Recovery Key"),
     and that the app is opening so you can verify — instead of a 1-line toast.
   - Same treatment, reusable, in **Settings → Recovery Key**.

### Phase 2 — Make Generate actually succeed for a UI user (structural)

5. **In-process enrichment drain** (`src/server-rest.js`): run the enrich loop in
   the REST process — a small background drainer (interval + a nudge after import)
   that calls `enrich/service.drainOnce()`+`enrichNlpOnce()` against the embed
   client (`:8091`). Removes the unstarted-`:8095` dependency entirely (matches the
   codebase's in-process pattern). Expose `GET /api/v1/account/…/processing-status`
   (pending vs embedded counts) so the UI can show progress + drive the Phase-1
   preflight message ("42 of 132 ready…").
6. **Embed-service lifecycle** (`src-tauri/src/main.rs` + `pipeline/setup.sh`):
   the app ensures `:8091` is up — spawn the Python embed service alongside the
   node child (kill on exit), and **fix `pipeline/.venv`** so it actually has the
   model deps (`sentence_transformers` is missing today). If the service can't
   start, the Phase-1 preflight degrades gracefully ("processing unavailable").

Phase 1 makes every failure honest and the save transparent **today**. Phase 2
delivers the happy path (import → auto-embed → generate succeeds) and is the
larger, environment-touching change.

## Module shape (Phase 1, ±20%)

- `src/portal-mindscape.js`: +~25 LOC preflight branch (reuses `db.messages`).
- `src/jobs.js`: ~15 LOC stderr ring-buffer + last-line error.
- `pipeline/run-clustering.sh`: +1 line.
- `src/account/keystore.js`: +~8 LOC `openInStore(target)` (`open -a`/deep-link).
- `src/account/router.js`: save handler returns `opened`; +~6 LOC.
- `portal-app/src/routes/setup/+page.svelte` + `(app)/settings/+page.svelte`:
  confirmation panel + status copy; ~30 LOC each.

## Edge cases — decisions

- **Embeddings in progress when Generate is clicked** → preflight returns
  `not_embedded` with counts; UI says "still processing, N of M ready" (not an
  error). Re-enabled automatically once enough are ready (Phase 2 status).
- **`open -a` fails / app absent** → save still succeeded; `opened:false`; the
  confirmation panel still tells the user where to find the item. Never fail the
  save because the open failed.
- **1Password without `op`** → button stays hidden (status flag); Keychain +
  copy/download cover it. (A `op`-less deep-link create isn't possible.)
- **stderr capture** → bounded buffer (no unbounded memory); last line only;
  pipeline emits no secrets (verified) — but still trim to one line.
- **Preflight threshold** → `MIN_EMBEDDED_TO_GENERATE = 5` (tunable); below it the
  clusters are meaningless anyway.

## Test strategy

- `scripts/verify-portal-mindscape.mjs` (extend): seed a vault with messages but
  0 embeddings → assert `/mycelium/generate` returns `409 not_embedded` and does
  **not** spawn. Seed ≥5 embedded → assert it spawns.
- `scripts/verify-generate.mjs` (extend): assert a failing fake pipeline surfaces
  its **last stderr line** in `state.error`, not just the code.
- `scripts/verify-account.mjs` (extend): `POST /recovery-key/save` returns
  `{ ok, opened }`; mock `open` (PATH shim) to assert it's invoked with
  `-a "Keychain Access"`; assert a save still succeeds when `open` fails.
- Phase 2: a drain test (insert pending row → run drainer with a stub embedder →
  row becomes `nlp_processed=2`, `embedding_768` set).

## Implementation order (each independently shippable + smoke-tested)

1. Preflight (`portal-mindscape.js`) + verify-portal-mindscape → `npm run verify:portal-mindscape`.
2. stderr surfacing (`jobs.js`) + owner env (`run-clustering.sh`) → `npm run verify:generate`.
3. Save transparency (keystore/router/setup/settings) → `npm run verify:account` + manual.
4. (Phase 2) in-process drain → new drain verify.
5. (Phase 2) embed-service lifecycle + venv fix → manual import→generate E2E.

## Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| stderr capture leaks a secret | low | high | pipeline prints none (verified); trim to 1 line; never echo env |
| `open -a` annoys (focus steal) | med | low | best-effort, non-blocking, behind the save the user chose |
| Spawning `:8091` from app destabilizes launch | med | med | Phase 2 only; fail-soft to preflight "unavailable"; kill on exit |
| In-process drain blocks the REST event loop | low | med | chunked drain already exists (`EMBED_CHUNK`); run on interval, single-flight |
| `pipeline/.venv` model deps heavy/slow | med | med | Phase 2; document in `pipeline/setup.sh`; lazy-load |

## Verification table

| Assumption | Verified at |
|---|---|
| Import nudges `:8095` fire-and-forget; error never surfaces | `src/ingest/enqueue.js:17,31,50-54` |
| App spawns only `server-rest.js`; `:8095` needs `--enrich` | `src-tauri/src/main.rs:64-70`, `src/index.js:120-131` |
| `:8091` UP, `:8095` DOWN, venv missing `sentence_transformers` | live `lsof`/`curl` + `pipeline/.venv` import check |
| cluster.py exits 1 on empty (user_id unresolved) before min-points skip | `pipeline/cluster.py:1740-1747,1724,1765-1766` |
| Owner-env mismatch (jobs sets `MYCELIUM_USER_ID`; cluster reads `MINDSCAPE_OWNER_ID`) | `src/jobs.js:61`, `pipeline/run-clustering.sh:37`, `pipeline/cluster.py:1740` |
| jobs.js stderr `'inherit'` (lost); only generic code surfaced | `src/jobs.js:77,109` |
| Generate endpoint has `db` (incl. `messages`) for a preflight | `src/portal-mindscape.js:27` |
| Save path is a silent `security`/`op` shell | `src/account/keystore.js:112-126` |
| External-URL webview → no Tauri IPC; node can `open -a` | `src-tauri/src/main.rs:90` (External), no `#[tauri::command]`/capabilities |

## Open questions

- **Deferred:** should embedding run on the GPU/Metal if available (perf)? Out of
  scope; CPU model is ~2/sec, fine for first-run sizes.
- **Resolved in sweep:** can the web UI open native apps directly? No (External
  webview, no IPC) — must go through the node server.
