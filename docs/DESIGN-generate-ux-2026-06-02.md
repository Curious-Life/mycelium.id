# Design — Robust "Generate" UX: reliable start, live progress, ETA (2026-06-02)

Built with **sweep-first-design** (3 parallel sweeps + live reproduction + reads of
every cited line). Fixes the persistent **"Failed to start generation"** and adds the
two things the user asked for: **live progress** and **estimated time**.

## Problem — verified by live reproduction, not guessed

In the running packaged app: vault initialized, embedding complete (132/132), and
`POST /api/v1/portal/mycelium/generate` → **200 `{jobId,status:running}`**, job runs to
**`done` in ~16 s** (bundled Python). **The backend is fine.** The failure is entirely
in the **frontend**, duplicated across the two trigger sites.

## Sweep findings (consolidated, cited)

- **Two near-duplicate trigger sites**, both buggy the same way:
  `portal-app/src/lib/components/OnboardingGuide.svelte` (`startGenerate` :371-406, the
  "activate analysis" onboarding step) and `portal-app/src/routes/(app)/mindscape/+page.svelte`
  (`startGenerate` :75-104).
- **They handle only `503 ai_not_ready` + `429` — neither of which the server returns.**
  Backend (`src/portal-mindscape.js:278-313`) returns: **200**, **409**
  `{error, reason:'no_messages'|'not_embedded', embedded, total}` (preflight,
  `MIN_EMBEDDED=5`), or generic **503** `'…key source or pipeline not ready'`. There is
  **no** `ai_not_ready` and **no** `429` in this route (Sweep 2). So those branches are
  **dead**, and every real error (incl. the 409) falls through `!res.ok → throw 'Failed
  to start'` → the user sees **"Failed to start generation"** (`OnboardingGuide.svelte:389,404`;
  `mindscape/+page.svelte:94,102`).
- **The 409 is the common case**: right after import the drainer is still embedding
  (`src/enrich/drainer.js`, 15 s timer + nudge; `EMBED_CHUNK=12`); clicking Generate
  before `embedded≥5` → 409 → misleading "Failed to start". The actionable
  `{embedded,total}` is thrown away.
- **`totalSteps: 8` hardcoded** on both clients (`OnboardingGuide:396`, `mindscape:98`)
  vs the server's **5** (`jobs.js:72`, STAGE_LABELS :19-25) → wrong progress bar.
- **No button-gating on embedding** — the button is enabled regardless (only `cooldownSec`
  disables it), so the user *can* click too early.
- **No ETA for generation.** (Both show an ETA for *embedding* only.) Job status exposes
  `startedAt`, `step`, `totalSteps`, `finishedAt` (`jobs.js:141-145`); **no historical
  run-duration is persisted anywhere** (Sweep 2 searched — none).
- `api.ts:35-72` — same-origin relative fetch (`/portal/*`→`/api/v1/portal/*`), returns
  the Response. **Webview fetch works**; not the problem.

## Design

### 1. One shared lifecycle module — `portal-app/src/lib/generate.ts` (NEW)
Kill the duplication (the root of the divergent bugs). A small Svelte store + actions
that BOTH sites consume (each keeps its own rendering):

State: `{ phase: 'idle'|'embedding'|'starting'|'running'|'done'|'error',
jobId, step, totalSteps, stageLabel, embedded, total, startedAt, elapsedMs,
etaSeconds, message, error }`.

- **`start()`** → `POST /portal/mycelium/generate`, then branch on the REAL contract:
  - **200** `{jobId, status}` → `phase='running'` (or adopt `already_running`'s jobId); begin status polling.
  - **409** → `phase='embedding'`, store `{embedded,total,message:body.error}`; begin
    **processing-status polling**; **auto-start** once `embedded≥MIN_EMBEDDED`. No error —
    the click means "go when ready", so we wait + start automatically.
  - **503 / other** → `phase='error'`, `error = body.error` (the real server message),
    with a Retry affordance.
- **`pollStatus()`** (3 s) → GET `…/generate/status/:id`; take **server `totalSteps`**;
  update step/stageLabel; compute `elapsedMs` + `etaSeconds`; `done`→phase done,
  `error`→phase error with the job's `error` (e.g. the Tier-A actionable deps line).
- **`pollEmbedding()`** (3 s) → GET `…/processing-status`; update embedded/total; auto-start when ready.
- **ETA**: `etaSeconds` from `priorDurationMs` (see #2) minus elapsed if known; else
  project from step fraction: `elapsed × (totalSteps−step)/max(step,1)`. Always show
  **elapsed**; show ETA as "~estimate". Honest + simple.
- Keep the `sessionStorage('mycelium_gen_job')` resume bridge in the store.

### 2. Persist last run duration for a real ETA seed — backend (small)
- `src/generate-stats.js` (NEW, ~30 LOC): read/write `dataDir()/generate-stats.json`
  `{ lastDurationMs, lastMessages, at }`.
- `src/jobs.js`: on `done`, write `lastDurationMs = finishedAt-startedAt`; read the prior
  value at spawn and stash `priorDurationMs` on the job; include it in `getJob()`.
  Also record per-step timestamps (`stepTimings`) for a smoother bar (optional, cheap).
- So even at step 0 the UI can say "~16 s" (last run), refined as steps complete.

### 3. Both components → consume the store
Replace each `startGenerate` + poll + the dead 503/429 branches + hardcoded
`totalSteps:8` with the shared store. Render: progress bar = `step/totalSteps`,
`stageLabel`, **elapsed + ETA**, and the **embedding** state ("Processing N/M — will
start automatically"). Button calls `generate.start()`; disable while `phase` is
embedding/starting/running.

## Edge cases — explicit decisions
- **Click during embedding** → wait + auto-start (not an error). The single biggest fix.
- **`already_running`** → adopt that jobId and poll (don't double-spawn). jobs.js single-flight already returns it.
- **Pipeline `error`** (e.g. missing deps) → show the job's real `error` string, not "Failed to start".
- **Generic 503** (keys/pipeline) → show server message + Retry.
- **Reload mid-run** → resume from `sessionStorage`.
- **Two sites diverging** → eliminated; both use one store.

## Verification table (assumptions → read myself)
| Assumption | Verified at |
|---|---|
| Server start works (200) + completes (done) | live: `POST …/generate`→200; status→`done` step 5/5 (~16s) |
| Both clients only handle 503/429, throw on else (incl 409) | `OnboardingGuide.svelte:374-405`; `mindscape/+page.svelte:78-103` |
| Server returns 409 `{reason,embedded,total}` / generic 503; no ai_not_ready/429 | `src/portal-mindscape.js:278-313` |
| `totalSteps:8` hardcoded; server reports 5 | `OnboardingGuide.svelte:396`, `mindscape:98`; `jobs.js:72` |
| Job status shape (startedAt/step/totalSteps/finishedAt); no persisted history | `src/jobs.js:141-145`; Sweep 2 (none found) |
| `api()` same-origin relative fetch (webview OK) | `portal-app/src/lib/api.ts:40,65` |
| Embedding via in-process drainer (15s/nudge) → processing-status | `src/enrich/drainer.js`; `src/portal-mindscape.js:264-272` |

## Test strategy
- Rebuild portal (`npm --prefix portal-app run build`); run server from repo (dev) so it
  serves the fresh build; reload the webview.
- **Happy path (live):** click Generate with embedding done → running → progress bar
  advances 1→5 with real labels → **elapsed + ETA** shown → done.
- **Early-click path:** seed an un-embedded state (or unit-test the store) → click → shows
  "Processing N/M — starting automatically" → auto-starts when ready (NOT "Failed to start").
- **Error path:** force a 503/job-error (stub) → shows the real message + Retry.
- `npm run verify:portal*` + `verify:generate` stay green.

## Implementation order
1. `src/generate-stats.js` + `jobs.js` (priorDurationMs + stepTimings) + `getJob` shape.
2. `portal-app/src/lib/generate.ts` (the shared store).
3. Refactor `mindscape/+page.svelte` to the store; verify live (happy path + ETA).
4. Refactor `OnboardingGuide.svelte` to the store.
5. `npm run verify`; rebuild portal; land as a branch + squash PR.

## Risks
| Risk | Mit |
|---|---|
| Refactoring two working components | Shared store is rendering-agnostic; verify both flows live |
| ETA inaccurate on first run / odd vault sizes | Always show elapsed; ETA labelled "~"; seeds from last run |
| Auto-start loops on persistent 409 | Cap auto-retries; stop if `total===0` (nothing to embed) → show "import first" |

## Revision history
- **v1:** sweep-first; root cause = unhandled 409 + dead 503/429 branches + duplicated
  trigger sites + hardcoded totalSteps + no ETA. Fix = one shared store handling the real
  contract (409→wait+auto-start, real errors surfaced), server totalSteps, elapsed+ETA
  (seeded by persisted last-run duration).
