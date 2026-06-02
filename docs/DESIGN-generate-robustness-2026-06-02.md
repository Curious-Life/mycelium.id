# DESIGN — Effortless Generate: no silent infinite states (2026-06-02, session 3)

Sweep-first design (`.claude/skills/sweep-first-design`). The user reports the **generation
step "keeps hanging"** and asked to *"understand the system end-to-end every step and make it
work effortlessly."* Four parallel Explore sweeps + live-environment verification produced the
root-cause map below. Every load-bearing claim is verified in the table at the end.

## TL;DR — what actually hangs

There is no single bug. Generation depends on a **Python embed service** and a **Python
clustering pipeline**, and the failure of either is **invisible and unbounded** in the UI:

1. **The hang the user is hitting (fresh vault):** the embed service (`:8091`) is spawned
   **fire-and-forget by main.rs** with whatever Python it resolves. When that Python lacks
   `numpy` (e.g. the build copy `/private/tmp/myc-phase2` has **no `pipeline/.venv`** → falls to
   bare `python3`), `embed-service.py` **dies at `import numpy` (module load)** → `/health` never
   answers → the in-process drainer sees "unhealthy" and **silently no-ops every 15 s forever** →
   the embedded count stays **0** → the Generate preflight returns **409 forever** → the UI sits
   at **"Processing 0 / N ready"** with no error, no timeout, no escape. *That is the hang.*
2. **The other hang (wedged run):** once a run starts, a stage can block for minutes with no
   sub-progress (cluster.py UMAP/HAC; describe-chronicles `infer()` has **no timeout**). The job
   has **no cancel**, **no stall detection**, and a **45-minute single-flight lockout** — a wedged
   run locks the user out with the bar frozen on "step N of 5."
3. **Not the hang (ruled out):** the `claude` CLI is absent, but Step 3 `describe-clusters.js`
   **fails soft** (60 s timeout, `catch → null`, placeholder names). Verified — not a hang.

## Design principles (the definition of "effortless")

1. **No silent infinite state.** Every wait has a deadline that converts into an actionable
   message ("the embedding engine isn't running — Retry") — never an endless spinner.
2. **Make failure visible and fixable.** Surface embedder health + the real error to the UI;
   always offer Retry / Cancel.
3. **Self-heal where possible.** One supervisor (in Node) owns the embedder: dep self-check →
   spawn → capture stderr → restart on death with backoff → expose health.
4. **Bounded, cancelable runs.** A cancel endpoint + a stall watchdog; the 45-min cap stays only
   as a backstop.

## Root causes (verified — see table)

| RC | Root cause | Where |
|----|-----------|-------|
| RC1 | Embedder spawned fire-and-forget, unsupervised; post-spawn death unnoticed; no dep guard | main.rs:128-144; embed-service.py:52 |
| RC2 | In pure `npm` dev **nothing** spawns the embedder (only the drainer starts) | server-rest.js:163-171 |
| RC3 | Embedder health invisible — `processing-status` returns only counts | portal-mindscape.js:264-272 |
| RC4 | Drainer silently no-ops forever when embedder unhealthy | drainer.js:29-40 |
| RC5 | Preflight 409 says "check back in a moment" — false when embedder is permanently dead | portal-mindscape.js:300-305 |
| RC6 | Frontend `embedding`/`running` phases: no deadline, no stall detection, no cancel | generate.ts:110-120, 83-108 |
| RC7 | No cancel endpoint; 45-min single-flight lockout on a wedged run | jobs.js:19,37-39 |
| RC8 | describe-chronicles `infer()` has no timeout; cluster.py heavy stages have no sub-progress | describe-chronicles.js:121; cluster.py:883 |

## The architecture decision: **Node owns the embedder lifecycle**

Today main.rs (Rust) spawns the embedder and nobody supervises it; `npm` dev has no embedder at
all. Move ownership into **`src/server-rest.js`** via a new **`src/embed/supervisor.js`**, so the
SAME supervision works in npm-dev, Tauri-dev, and the bundled app. Node is the right home: the
drainer and the routes already live there, restart/backoff/stderr-capture are trivial in JS, and
it's browser-verifiable without a Rust rebuild. main.rs stops spawning the embedder (removes the
race; one owner).

## Implementation (phased, each independently shippable + verifiable)

### Phase 1 — Backend keystone: supervised embedder + health surface
- **New `src/embed/supervisor.js`** `startEmbedSupervisor({ home, pythonBin?, port=8091 })`:
  - Resolve Python: explicit `MYCELIUM_PYTHON` → `pipeline/.venv/bin/python3` → `python3`
    (mirror main.rs:76-81, but in JS).
  - **Dep self-check** before spawn: `python -c "import numpy,onnxruntime,tokenizers,huggingface_hub"`.
    On failure → health = `{status:'deps_missing', message:'Embedding engine needs setup — run: bash pipeline/setup.sh', detail}`; do NOT spawn a doomed process.
  - If `:8091` already healthy (someone else owns it) → **adopt**, don't spawn.
  - Else spawn `embed-service.py --serve --port 8091`, capture stderr (bounded ring buffer),
    **restart on exit** with exponential backoff (cap ~5 tries, then health=`down` with the last
    stderr line).
  - Expose `getHealth()` → `{status:'ok'|'loading'|'error'|'deps_missing'|'down', message, detail}`
    combining a fast (`~2s`) live `/health` probe with the supervisor's own spawn state.
  - `stop()` kills the child + the timer (wire into server-rest close).
- **`src/server-rest.js`**: start the supervisor at boot (alongside the drainer); `closeHandle`
  also stops it. Keep the drainer's health-gate (now backed by a real, self-healing service).
- **`src/portal-mindscape.js` `/mycelium/processing-status`**: add
  `embedder: getEmbedderHealth()` to the response (counts unchanged).
- **`src-tauri/src/main.rs`**: remove the embedder spawn block (Node owns it). *(Rust rebuild
  needed for the packaged app; the npm/browser path works immediately.)*
- **`pipeline/embed-service.py`**: add a top-of-file actionable guard so a manual run also fails
  clearly (mirror run-clustering.sh): wrap the heavy imports, print the `setup.sh` hint to stderr,
  `sys.exit(3)`.

### Phase 2 — Frontend keystone: kill every infinite state
- **`generate.ts`**:
  - `pollEmbedding()`: read `embedder` from `processing-status`. If `status` ∈
    {`deps_missing`,`down`,`error`} → `stop()` + `phase:'error'` with the embedder message (Retry
    shows). Add a **stall deadline**: if `embedded` hasn't increased for ~45 s AND embedder isn't
    `ok`/`loading` → error. If healthy but slow → keep waiting with "large imports can take a few
    minutes."
  - `pollStatus()`: track `lastStepAt`; if `step` hasn't advanced in ~3 min → set `stalled:true`
    (NOT error) so the UI can show "still working on <stage> — taking longer than usual."
  - Add `export function cancel()` → `POST /portal/mycelium/generate/cancel/:id` → `reset()`.
  - Add `embedder`, `stalled` to `GenState`.
- **`mindscape/+page.svelte`** + **`OnboardingGuide.svelte`**: render a **Cancel** button in
  `embedding`/`starting`/`running`; show the `stalled` hint; surface the embedder error verbatim.
  Cap OnboardingGuide's 409 auto-retry (currently unbounded every 4 s) at ~N tries then show help.

### Phase 3 — Backend: cancel + stall watchdog + chronicles timeout
- **`src/jobs.js`**: `export function cancelJob(jobId)` → SIGTERM→SIGKILL the child, mark
  `status:'canceled'`, clear `runningJobId`. Add a **stdout-inactivity watchdog**: if no output
  for `MYCELIUM_GEN_STALL_MS` (default 5 min) → set `state.stalled=true` (surfaced via getJob);
  optional hard inactivity-kill at a higher bound. Keep `MAX_MS` as the 45-min backstop.
  `getJob` returns `stalled`.
- **Route** `POST /mycelium/generate/cancel/:id` in portal-mindscape.js → `cancelJob`.
- **`pipeline/describe-chronicles.js`**: pass a timeout into `infer()` (or wrap in
  `Promise.race` with a timeout) so a hung model can't wedge step 3.

### Phase 4 — Polish (if budget): pipeline sub-progress
- `cluster.py`: a few more `print("Step 2/5: …", flush=True)`-style sub-lines (k-NN, Leiden,
  UMAP) so the bar moves within the heavy step. Low risk; cosmetic.

## Edge cases — explicit decisions
- **Embedder adopted (already up & healthy):** supervisor does not spawn or kill it; `stop()`
  only kills children it spawned. (Avoids killing a user's manual service.)
- **deps_missing vs down:** deps_missing is actionable ("run setup.sh"); down means it spawned but
  keeps crashing (show last stderr line). Distinct messages.
- **Slow model load (`loading`)** is NOT an error — the UI keeps waiting with a reassuring note;
  only `error`/`down`/`deps_missing` convert to an error.
- **Cancel during a stage:** SIGTERM then SIGKILL after 5 s (reuse the existing pattern). Partial
  pipeline writes are idempotent (each stage re-runnable); a re-run overwrites.
- **Two tabs / double click:** server single-flights; `cancel` then `start` is the supported
  restart. Frontend disables the button while `starting`.
- **Backwards compat:** `processing-status` adds a field (non-breaking); old clients ignore it.

## Test strategy
- **supervisor.spec** (new): (a) deps-present + service up → `getHealth()` `ok`; (b) python with
  missing deps → `deps_missing`, no spawn; (c) service killed → supervisor restarts (health
  recovers); (d) adopt path: 8091 pre-bound healthy → no second spawn.
- **jobs.spec**: `cancelJob` transitions running→canceled + frees single-flight; stall watchdog
  sets `stalled` after the (test-shrunk) inactivity window; `MAX_MS` still backstops.
- **portal-mindscape**: `processing-status` includes `embedder`; `generate` preflight unchanged.
- **generate.ts** (logic): embedding→error on `deps_missing`; running→`stalled` after no advance;
  `cancel()` resets.
- **End-to-end (browser, the real proof):** fresh vault → import → with the embedder broken
  (point MYCELIUM_PYTHON at a deps-less python) the UI shows the actionable embedder error + Retry
  (NOT infinite 0/N); with the embedder healthy → embeds → Generate runs with live progress + ETA
  → Cancel mid-run works → completes. `npm run verify` stays green.

## Implementation order (each with a smoke test)
1. `src/embed/supervisor.js` + unit spec → `node --test`.
2. Wire supervisor into server-rest.js; add `embedder` to processing-status → `curl …/processing-status`.
3. embed-service.py import guard → run under a deps-less python, expect exit 3 + hint.
4. jobs.js cancel + stall + route → `curl -XPOST …/generate/cancel/:id`.
5. generate.ts: embedder error + stall + cancel; Svelte Cancel buttons → browser.
6. main.rs: remove embedder spawn → `cargo tauri build` (last; one rebuild).
7. `npm run verify`; browser end-to-end on a fresh vault; land as a PR.

## Decision criteria to proceed to "done"
A fresh vault, embedder deliberately broken, shows an **actionable error within ~45 s** (not an
infinite spinner); embedder healthy → embeds and **Generate completes with live progress**; a
mid-run **Cancel** returns control immediately; `npm run verify` green.

## Out of scope / deferred
- **WKWebView freeze (OPEN #1)** — orthogonal to pipeline robustness; tracked separately. The
  browser path is the verification surface here.
- **env-key precedence (OPEN #2)**, **account-setup overwrite guard (OPEN #4)**, **locked real
  vault (OPEN #3)** — unchanged by this work.
- BIP39, multi-user, notarization.

## Verification table (every load-bearing assumption, read myself)

| # | Assumption | Verified at |
|---|-----------|-------------|
| 1 | `import numpy` is module-level in embed-service.py → missing deps kill the process at load; `/health` never answers | pipeline/embed-service.py:52; live log /tmp/myc-app-run.log:1-4 (ModuleNotFoundError traceback) |
| 2 | Embedder spawned fire-and-forget; only the *spawn* error is caught, not post-spawn exit; no restart | src-tauri/src/main.rs:128-144 |
| 3 | Only main.rs spawns the embedder; `npm` dev starts only the drainer | grep (src/, scripts/, package.json); src/server-rest.js:163-171 |
| 4 | Drainer returns early (no-op) forever when `embedHealthy()` is false | src/enrich/drainer.js:29-40 |
| 5 | `processing-status` returns only `{embedded,total,pending}` — no embedder health | src/portal-mindscape.js:264-272 |
| 6 | Preflight: 409 if embedded<5 with "check back in a moment" message | src/portal-mindscape.js:284-305 |
| 7 | embed client health(): `GET /health → {status,model,loaded,dim}`, configurable timeout (30s default) | src/embed/client.js:5,46,56-66 |
| 8 | Frontend `embedding` polls forever; only `total===0` exits; no deadline/health | portal-app/src/lib/generate.ts:110-120 |
| 9 | Frontend `running`: ETA-only, no stall detection, no cancel; templates have no Cancel | generate.ts:83-108; mindscape/+page.svelte:794-808 |
| 10 | No cancel/abort route; single-flight returns `already_running` until MAX_MS (45 min) | src/jobs.js:19,37-39; grep (no cancel route) |
| 11 | `claude` CLI absent → describe-clusters fails soft (60s timeout, catch→null) — NOT a hang | pipeline/describe-clusters.js:36,49-72; live `which claude` → not found |
| 12 | describe-chronicles `infer()` has no explicit timeout; cluster.py UMAP/HAC no sub-progress | pipeline/describe-chronicles.js:121; pipeline/cluster.py:883-891 |
| 13 | Canonical repo venv has ALL deps; the build copy the user tested has NO `.venv` | live: ~/mycelium.id/pipeline/.venv all-deps OK; /private/tmp/myc-phase2 → no .venv |
| 14 | OnboardingGuide auto-retries 409 every 4s with no cap | portal-app/src/lib/components/OnboardingGuide.svelte:384-389 |
| 15 | run-clustering.sh prints exactly `Step N/5:` lines that jobs.js parses | pipeline/run-clustering.sh:77-96; src/jobs.js:100 |

## Sweep findings (consolidated, load-bearing)
- The embedder is the **single most fragile link** and its failure is **100% invisible** to the
  user. Fixing visibility + supervision removes the dominant "hang."
- The clustering pipeline's blocking risk is **real but secondary** (heavy compute, no
  sub-progress, no cancel) — addressed by cancel + stall detection + a chronicles timeout.
- The `claude`-CLI worry from the handoff is a **non-issue** (verified fail-soft).
- A **single supervisor in Node** unifies three runtimes (npm/Tauri/bundled) and is
  browser-verifiable — the key structural pivot from "main.rs spawns it" to "Node owns it."
