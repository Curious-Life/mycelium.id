# Local-Model Setup Improvements — Design (S6 "Cookbook" v2)

**Date:** 2026-06-05
**Author:** Claude (sweep-first-design)
**Status:** Design locked; ready to implement.
**Scope:** Three improvements to the hardware-aware local-model picker (Settings → Intelligence):
1. **Auto-start Ollama** on "Pull & use" (lazy), with guided install when the binary is absent.
2. **Expand the model catalog** (~9 → ~19) with an explicit **quality** axis.
3. **Show all models, scrollable, ranked descending by compatibility × quality** (today: top-4, won't-fit filtered out).

User decisions captured upstream: *auto-start + guided install* (no bundling, no auto-running an installer); *start lazily on Pull & use click*.

---

## 0. Headline

Ollama is **optional and decoupled from embeddings** — embeddings run on the Nomic v1.5 ONNX `embed-service.py` (:8091), zero Ollama dependency (D2; verified [embed-service.py:71-114](../pipeline/embed-service.py#L71), no `11434`/`ollama` refs in `src/embed/`). Ollama is *only* the local **inference** ("thinking") backend, and only when the user picks a local provider. So the whole picker — and its new auto-start — stays **lazy, on-demand, and fail-soft**: nothing about the vault, embeddings, or a cloud-provider user breaks if Ollama is absent.

The build splits cleanly along the existing seams:
- **New module** `src/hardware/ollama-daemon.js` — adopt-or-spawn `ollama serve`, mirroring the `src/embed/supervisor.js` pattern, but **lazy** (no boot tick-loop) and with **absolute-path binary discovery** (the GUI-PATH problem, §3.1).
- **Data + ranking** changes in `catalog.js` + `recommend.js` (pure, the well-tested core).
- **Route** wiring in `portal-hardware.js` (`ensureUp` before pull; `ollamaInstalled` in recommend; new `/hardware/start`).
- **UI** in `IntelligenceSection.svelte` (scroll, install-vs-start state, auto-start, provider dedup).
- **Tests** extend the *existing* `verify:hardware` + `verify:hardware-routes` gates (they pin the old contract and MUST be updated in lockstep).

---

## 1. Revision history

- **v1 (sketch, pre-sweep):** "Add a `startOllama()` that runs `ollama serve`; bump the catalog; remove the limit; add `overflow-y-auto`." Three structural defects, caught by sweeps:
  - **v1→v2 (PATH pivot):** v1 assumed `spawn('ollama', …)` resolves via PATH. **False for the packaged app.** A Finder-launched macOS app inherits launchd's minimal PATH; the Tauri→Node command only prepends `home`/`home/python/bin` ([main.rs:235-240](../src-tauri/src/main.rs#L235)), never `/opt/homebrew/bin` or `/usr/local/bin`. → **must probe absolute candidate paths.** (§3.1)
  - **v1→v2 (test-contract pivot):** v1 "remove the limit / drop won't-fit" silently breaks `verify-hardware.mjs` H4a–H4d and `verify-hardware-routes.mjs` HR2, which assert `every(fitScore>0)` and exact top-picks/counts ([verify-hardware.mjs:52-74](../scripts/verify-hardware.mjs#L52)). → **new `recommend.js` contract is a deliberate change; both gates are rewritten to the new contract.** (§4, §8)
  - **v1→v2 (dedup pivot):** v1 left `pullAndUse` POSTing a new provider every click. `POST /providers` has no dedup and no UNIQUE constraint ([0001_init.sql:119-134](../migrations/0001_init.sql#L119)); repeated clicks accumulate identical `custom` rows. → **dedup in `pullAndUse`** (reuse the existing row + `setActive`). (§5)

---

## 2. Sweep findings (consolidated, load-bearing only)

**Spawn surface (main.rs).** Node REST is spawned with `set_group` (own process group; `pgid==pid`) ([main.rs:252](../src-tauri/src/main.rs#L252)). On app exit `reap()` does `kill_group` (SIGTERM→SIGKILL to `-pgid`) ([main.rs:126-148](../src-tauri/src/main.rs#L126)). **Consequence:** any child the Node server spawns **non-detached** lives in that group and is reaped automatically on app quit — *we get cleanup for free* by NOT detaching. The Rust pidfile/`reap_stale_pids` only tracks `caddy`/`frpc` by name ([main.rs:153](../src-tauri/src/main.rs#L153)) — we deliberately do **not** add `ollama` there (a stale-PID `ollama` kill could hit the user's own daemon; PID-reuse + adopt semantics make name-matching unsafe — same reason node/python are excluded).

**Embed supervisor = the canonical daemon template** ([supervisor.js](../src/embed/supervisor.js)): probe-before-spawn (adopt if healthy), `spawn()` not detached, `stdio: ['ignore','ignore','pipe']`, `childEnv()` **allowlist** (`PATH`, `HOME`, +HF_*), `spawnedByUs` flag so `stop()` only kills what it started, stderr ring-buffer (4096) for actionable errors, never logs secrets. Wired in [server-rest.js:214](../src/server-rest.js#L214) + `embedSup.stop()` in `shutdown()` ([server-rest.js:220](../src/server-rest.js#L220), SIGINT/SIGTERM at :341). **We mirror this but lazy** — no boot tick-loop; an on-demand `ensureUp()`.

**Provider semantics.** `setActive` deactivates all siblings of the *same* `provider` value then activates the target ([db/providers.js setActive]); `getActive(userId)` returns the most-recently-used active row. `provider='custom'` is shared by every Ollama model **and** LM Studio. No dedup on insert. `pullAndUse` POSTs `{provider:'custom', base_url:'http://127.0.0.1:11434/v1', model_preference:m.name}` then `setActive` ([IntelligenceSection.svelte:189-192](../portal-app/src/lib/components/settings/IntelligenceSection.svelte#L189)).

**Test harness.** `node:test` + `node:assert`, but the hardware code is covered by **bespoke ledger scripts** (`scripts/verify-hardware*.mjs`), not `tests/*.test.js`. They inject `fetch`/`detect`/`runCmd`/`osMod`. New daemon code uses the same injection style (`spawn`, `existsSync`, `isUp` injectable).

---

## 3. Module: `src/hardware/ollama-daemon.js` (NEW, ~95 LOC)

### 3.1 Binary discovery (the PATH pivot)

`ollama serve` cannot rely on PATH in the packaged app. Resolution order (first existing wins):

1. `process.env.MYCELIUM_OLLAMA` (explicit override / tests).
2. Fixed absolute candidates:
   - `/opt/homebrew/bin/ollama` (Homebrew, Apple Silicon)
   - `/usr/local/bin/ollama` (Homebrew Intel / official-installer symlink)
   - `/Applications/Ollama.app/Contents/Resources/ollama` (official .app)
   - `${HOME}/.local/bin/ollama`
3. Each dir in `process.env.PATH` + `/ollama` (covers dev shells & Linux).

Checked with injected `existsSync`. Returns absolute path or `null`. **No request input ever reaches this** — candidates are a fixed allowlist.

### 3.2 Lifecycle (lazy adopt-or-spawn)

```
createOllamaDaemon({ isUp, findBinary, spawn, env, log,
                     startTimeoutMs = 15000, pollMs = 400 }) → { ensureUp, isInstalled, stop }
```

`ensureUp()` (single-flight via a module-level in-progress promise):
1. `await isUp()` → `{ ok:true, running:true, adopted:true }`. (Never touch a daemon we didn't start.)
2. `bin = findBinary()`; if `null` → `{ ok:false, running:false, installed:false, reason:'not_installed' }`. **Fail-closed: spawn nothing.**
3. `spawn(bin, ['serve'], { detached:false, stdio:['ignore','ignore','pipe'], env: allowlist })`. `spawnedByUs=true`; capture stderr tail (4096).
4. Poll `isUp()` every `pollMs` until true (→ `{ ok:true, running:true, adopted:false }`) or `startTimeoutMs` (→ `{ ok:false, reason:'start_timeout', detail: stderrTail }`).

`isInstalled()` = `findBinary() !== null` (sync, cheap).
`stop()` = SIGTERM the child **only if `spawnedByUs`**. Wired into `server-rest.js` `shutdown()`.

Env allowlist: `{ PATH, HOME }` (+ pass-through `OLLAMA_HOST`/`OLLAMA_MODELS` if already set). **No secrets** — Ollama needs none; the master key is never passed (CLAUDE.md §4).

Args are the fixed literal `['serve']` — no shell, no interpolation (matches `detect.js`/`key-source.js` discipline).

---

## 4. `catalog.js` + `recommend.js` changes

### 4.0 Research basis — odysseus + companion/EQ benchmarks

**Odysseus (PewDiePie), confirmed public** at `github.com/pewdiepie-archdaemon/odysseus` (adapts `AlexsJones/llmfit`). Our `fit.js` is a faithful port of its `hwfit` memory/fit math. Its ranking generalises ours: a **multi-dimension weighted composite** `quality·wq + speed·ws + fit·wf + context·wc` with **per-use-case weights** (`USE_CASE_WEIGHTS` — e.g. reasoning `(0.55,0.15,0.15,0.15)`, chat ~`0.35` speed). Crucially, odysseus's "quality" is a **generic heuristic** (params + quant + reputation), *not* benchmark-grounded and *not* tuned for companionship — so we cannot borrow its numbers. (Its catalog is 270+ HF-scraped models with no human rating; its personalities are prompt-assigned "councils", not fine-tunes.) We adopt the *shape* (a weighted composite, single use-case for now) and **define quality for OUR use case**. Multi-use-case weighting is a documented deferral (§11).

**Our use case = warm personal companion + self-development guide.** The relevant benchmarks are NOT coding/math:
- **EQ-Bench 3** (eqbench.com) — LLM-judged emotional intelligence across empathy, insight, social dexterity, appropriate validation/**challenge**. The most on-target eval.
- **EQ-Bench Creative Writing** — human-like prose + a "slop" (LLM-cliché) score → warmth, not assistant-ese.
- **Spiral-Bench** — sycophancy/safety in emotionally charged chats. Directly relevant: a self-development companion must *appropriately challenge*, not just validate — so we **do not** chase uncensored/RP-sycophantic tunes.

**Family verdicts (measured where noted, else community consensus — flagged in catalog comments):**
- **gemma2 = the warm family.** A gemma2:9b derivative (*Ataraxy-9B*) reached **#1 on EQ-Bench creative-writing** over much larger models — strongest measured support. gemma2:9b/27b are the companion backbone.
- **mistral-nemo:12b** = community-favourite warm/creative mid-size.
- **llama3.1:8b / llama3.3:70b** = balanced, genuinely good, slightly "assistant-coded."
- **qwen2.5 = smart but cold/technical** → strong *analytical* coach, weaker *warm* companion.
- **phi4 / phi3.5 = clinical/STEM** → the *worst* fit for companionship despite high generic benchmarks.

### 4.1 Catalog: redefine `quality` as **companion-suitability** + add `bestFor` + ~10 models

`quality` ∈ 0–100 is **NOT generic capability** — it is a curated, reviewed-in-repo rating of *suitability as a warm companion & self-development guide* (warmth · EQ · reflective depth · appropriate challenge), grounded in §4.0. `bestFor` is a short UI tag answering "what's it for." Param counts are public facts; MoE sets `kvParamsB`=active. Each catalog entry carries a one-line rationale comment citing the basis (measured vs consensus).

| name | paramsB | kvParamsB | quality | bestFor | basis |
|---|---|---|---|---|---|
| qwen2.5:0.5b | 0.5 | — | 16 | Fast & light | too shallow for reflection |
| llama3.2:1b | 1.3 | — | 28 | Fast & light | edge/speed, thin depth |
| gemma2:2b | 2.6 | — | 46 | Warm, tiny | gemma warmth, small |
| qwen2.5:3b | 3.1 | — | 42 | Everyday, analytical | precise, cooler tone |
| llama3.2:3b | 3.2 | — | 50 | Everyday chat | balanced light |
| phi3.5:3.8b | 3.8 | — | 38 | Technical / STEM | clinical, low warmth |
| mistral:7b | 7.2 | — | 58 | Everyday chat | dry base, decent |
| qwen2.5:7b | 7.6 | — | 58 | Analytical thinking | smart, technical tone |
| llama3.1:8b | 8.0 | — | 72 | Balanced companion | good conversationalist |
| **gemma2:9b** | 9.2 | — | **85** | **Warm companion** | warm family; 16GB sweet-spot |
| **gemma-2-ataraxy-9b** | 9.2 | — | **88** | **Warmest prose** | EQ-Bench CW #1 (community merge) |
| **mistral-nemo:12b** | 12.2 | — | 80 | Warm & creative | community warm favourite |
| phi4:14b | 14.7 | — | 50 | Technical / STEM | smart but cold |
| qwen2.5:14b | 14.8 | — | 66 | Analytical thinking | capable, cooler |
| mixtral:8x7b | 46.7 | 12.9 | 70 | Creative (heavy) | capable, dated, MoE |
| **gemma2:27b** | 27.2 | — | **92** | **Warm, deep companion** | best warm quality @ 32GB |
| qwen2.5:32b | 32.8 | — | 76 | Analytical thinking | strong analytical coach |
| **llama3.3:70b** | 70.6 | — | **93** | **Reflective coaching** | near-frontier nuance |
| qwen2.5:72b | 72.7 | — | 82 | Analytical (frontier) | frontier, but cooler |

`gemma-2-ataraxy-9b` is the one **community merge** (Ollama tag `vanilj/gemma-2-ataraxy-9b`; lightly-uncensored *general/creative*, **not** NSFW-RP) — included because it is the strongest *measured* warm pick at the 16GB tier; flagged as community in its comment. Reasoning-trace models (deepseek-r1) remain **deferred** (§11) — `<think>` traces hurt this conversational use-case.

### 4.2 `recommendModels` — new contract

Returns the **full** catalog, scored and sorted; UI scrolls. Each item gains `quality` + `bestFor`. `quality` here = companion-suitability (§4.1).

**Sort:** two bands.
- **Band A — fits** (`fitScore > 0`): sorted by composite `rankScore = quality × fitWeight(fitScore)` **desc**, tie-break `quality` desc.
  - `fitWeight`: 100→1.0, 70→0.85, 50→0.6 (maps the right-size/tight/very-tight buckets so a right-sized warmer model beats a tight cooler one — *the "compatibility vs companion-quality" blend*).
- **Band B — won't fit** (`fitScore === 0`): appended after Band A, sorted by `paramsB` **asc** (smallest overflow first = nearest reach).

Worked example — **16GB Apple Silicon** (avail ≈10.7GB, matches the user's screenshot): Band A top = `gemma-2-ataraxy-9b` (88), `gemma2:9b` (85), `mistral-nemo:12b` (80), `llama3.1:8b` (72); `gemma2:27b`/`llama3.3:70b` fall to Band B. This is the community-correct companion ranking — the reframe's proof.

`note` retained: set only when Band A is empty ("nothing fits comfortably… smallest will be CPU-slow"). No `limit` (UI scrolls; an optional `limit` arg stays for callers/tests).

Signature stays `recommendModels(hw, { ctx = 8192, limit } = {})`; default `limit = undefined` (all). Output adds `quality` per item; `recommendations` now includes won't-fit rows.

---

## 5. `portal-hardware.js` changes (~+30 LOC)

- Construct one `createOllamaDaemon(...)` alongside the existing `createOllamaClient(...)` (share `fetch`/`ollamaUrl`; inject for tests).
- **`GET /hardware/recommend`:** add `ollamaInstalled: daemon.isInstalled()` to the response (UI shows *Install* vs *Start*). `recommendations` now carries the full ranked list + `quality` (+ existing `installed` flag).
- **`POST /hardware/start`** (new): `await daemon.ensureUp()` → `{ ok, running, installed, adopted?, reason? }`. JSON, not SSE.
- **`POST /hardware/pull`:** before pulling, `const up = await daemon.ensureUp()`. If `!up.ok`, emit `send({done:true, ok:false, error: up.reason})` (`'not_installed'`/`'start_timeout'`) and end — **don't** attempt the pull against a dead daemon. Otherwise proceed exactly as today. Catalog-name constraint unchanged.

---

## 6. `IntelligenceSection.svelte` changes (~+35/-12 LOC)

- **Scroll:** wrap the `{#each hwRec.recommendations}` rows in `<div class="max-h-72 overflow-y-auto space-y-2 pr-1">`. All models render, best-first.
- **Quality cue:** keep the fit badge; append a muted quality hint (e.g. `Q{m.quality}` or a tiny 5-dot bar) so the user sees the compat/quality tradeoff that drove the order. Minimal.
- **Install vs start state** (driven by new `hwRec.ollamaInstalled` + existing `ollamaUp`):
  - `!ollamaInstalled` → replace the "run `ollama serve`" line with: *"Ollama isn't installed — [Install Ollama](https://ollama.com/download)."* Pull buttons disabled.
  - `ollamaInstalled && !ollamaUp` → line: *"Ollama will start automatically when you pick a model."* Pull buttons **enabled** (remove the `disabled={!hwRec.ollamaUp}` gate).
  - `ollamaUp` → as today.
- **Auto-start + dedup in `pullAndUse`:**
  - The pull SSE now self-starts the daemon server-side; handle new error payloads `not_installed`/`start_timeout` → surface the install link / retry hint.
  - Before `POST /providers`, dedup: `const existing = providers.find(p => p.base_url === 'http://127.0.0.1:11434/v1' && p.model_preference === m.name)`. If found → `await setActive(existing.id)`; else POST then `setActive(cd.id)`. (Kills duplicate-row accumulation.)

---

## 7. Threat model

New surface = **spawning a process**. Mitigations:
- **Fixed args** `['serve']`; **no shell**; binary path from a **fixed absolute allowlist + PATH dirs**, never from request body or catalog. (CLAUDE.md §2, §6.)
- **Only spawn when `isUp()===false`** → no double-bind; **never kill an adopted daemon** (`spawnedByUs` gate) → we can't take down the user's own Ollama.
- **Env allowlist** (`PATH`,`HOME`,+OLLAMA_*); **no master key / no secrets** in env or args (§4 discipline); stderr tail capped at 4096 and only surfaced as a UI hint — **no PII/secret logging** (§1, §8).
- **Pull surface unchanged** — still catalog-constrained (HR4/HR5 keep passing).
- **Fail-closed:** binary absent → do nothing, report `not_installed`; start timeout → no partial state.
- **No new network listener we own** — Ollama binds its own loopback :11434, same as today's assumption.

Accepted: a user who runs Ollama on a **non-default port** (`OLLAMA_HOST`) is seen as "down"; `ensureUp` would start a *default-port* instance. Harmless (different port, our client targets :11434) — documented as deferred (§11).

---

## 8. Test strategy (extend existing gates)

**`scripts/verify-hardware.mjs`:**
- **Update H4a–H4e** to the new contract: recompute expected top-picks under the expanded catalog + composite rank; assert Band-A-then-Band-B ordering; assert won't-fit rows are *present* (not filtered) and carry `fitLevel==='too_tight'`; assert each item has a numeric `quality`. (Re-derive expected names by running, then pin.)
- **New H7 — `ollama-daemon`** (injected `isUp`/`findBinary`/`spawn`):
  - H7a `ensureUp` adopts when `isUp()` true → `{adopted:true}`, **spawn not called**.
  - H7b not installed (`findBinary→null`) → `{ok:false, reason:'not_installed'}`, **spawn not called**.
  - H7c installed + initially down → spawns with args `['serve']`, polls, resolves `{ok:true, adopted:false}` once fake `isUp` flips true.
  - H7d start timeout (fake `isUp` stays false) → `{ok:false, reason:'start_timeout'}`.
  - H7e single-flight: two concurrent `ensureUp()` → **one** spawn.
  - H7f `findBinary` order: `MYCELIUM_OLLAMA` wins; else first existing absolute candidate; injected `existsSync`.
  - H7g `stop()` kills only when `spawnedByUs` (no kill after adopt).

**`scripts/verify-hardware-routes.mjs`:**
- **Update HR2** to new contract (full list incl. won't-fit; `ollamaInstalled` present; `quality` on items). Drop the `every(fitScore>0)` assertion; assert won't-fit rows exist for a small box.
- **New HR6 — `POST /hardware/start`**: injected daemon → `{ok, running}`.
- **New HR7 — pull auto-starts**: with injected daemon `isUp` initially false + a findable binary, `POST /hardware/pull` first brings the daemon up, then streams progress (assert spawn happened before pull fetch).
- **New HR8 — pull when not installed**: `findBinary→null` → SSE `{done:true,ok:false,error:'not_installed'}`, **no `/api/pull` fetch**.
- HR3/HR4/HR5 unchanged (catalog constraint + injection-name rejection still hold).

Both gates must print `VERDICT: GO` / exit 0. `node:assert` / ledger style preserved.

**Manual smoke** (deploy-and-verify, REST+portal :8787):
- Ollama installed + stopped → Pull & use spins it up and pulls (watch `:11434` come alive).
- Ollama absent → UI shows "Install Ollama" link; pulls disabled.
- List scrolls; ~19 models, best-runnable on top, won't-fit greyed at the bottom.
- Click Pull & use twice on the same model → exactly **one** provider row.

---

## 9. Implementation order (each step independently shippable)

1. **`catalog.js`** — add `quality` + new models (pure data). Smoke: `node -e "import('./src/hardware/catalog.js').then(m=>console.log(m.CATALOG.length))"`.
2. **`recommend.js`** — composite rank + full list + `quality` passthrough. Update **H4** in `verify-hardware.mjs`. Smoke: `npm run verify:hardware`.
3. **`ollama-daemon.js`** (new) + **H7** tests. Smoke: `npm run verify:hardware`.
4. **`portal-hardware.js`** — `ollamaInstalled`, `/hardware/start`, `ensureUp` in pull. Update **HR2** + add **HR6/HR7/HR8**. Smoke: `npm run verify:hardware-routes`.
5. **`server-rest.js`** — construct daemon (shared) + `daemon.stop()` in `shutdown()`. Smoke: server boots.
6. **`IntelligenceSection.svelte`** — scroll, install/start state, auto-start, dedup. Smoke: portal build + manual click-through.
7. Full `npm run verify:hardware && npm run verify:hardware-routes`; living-docs update (ARCHITECTURE + V1 spec status); handoff.

---

## 10. Verification table

| # | Load-bearing assumption | Status | Verified at (read myself) |
|---|---|---|---|
| 1 | Ollama is NOT a dependency of embeddings (decoupling is safe) | ✅ | [pipeline/embed-service.py:71-114](../pipeline/embed-service.py#L71); no `ollama`/`11434` in `src/embed/` (grep) |
| 2 | Packaged Node's PATH excludes Homebrew dirs → must use absolute paths | ✅ | [main.rs:230-241](../src-tauri/src/main.rs#L230) (PATH only prepends `home`,`home/python/bin`) |
| 3 | Node child spawned non-detached is reaped on app exit via group-kill | ✅ | [main.rs:108-148](../src-tauri/src/main.rs#L108) (`set_group`/`kill_group`/`reap`) |
| 4 | Stale-PID reaper tracks only caddy/frpc by name (don't add ollama) | ✅ | [main.rs:151-186](../src-tauri/src/main.rs#L151) |
| 5 | Embed supervisor = adopt-or-spawn template (probe, spawnedByUs, allowlist env, stop in shutdown) | ✅ | [supervisor.js](../src/embed/supervisor.js); [server-rest.js:214,220,341](../src/server-rest.js#L214) |
| 6 | `POST /providers` always inserts; no dedup; `provider='custom'` shared; `setActive` per-provider-type | ✅ | [portal-providers.js:92-128](../src/portal-providers.js#L92); [migrations/0001_init.sql:119-134](../migrations/0001_init.sql#L119) |
| 7 | `pullAndUse` has `providers` list in scope for dedup; posts custom+base_url+model | ✅ | [IntelligenceSection.svelte:157-199](../portal-app/src/lib/components/settings/IntelligenceSection.svelte#L157) |
| 8 | `recommend.js` consumed only by route + verify script (contract change is contained) | ✅ | grep: only `src/portal-hardware.js:15` + `scripts/verify-hardware*.mjs` + the frontend route call — no other importer |
| 9 | Existing gates pin old contract (`every fitScore>0`, exact picks, counts) → must update | ✅ | [verify-hardware.mjs:52-74](../scripts/verify-hardware.mjs#L52); [verify-hardware-routes.mjs:46-53](../scripts/verify-hardware-routes.mjs#L46) |
| 10 | `recommend.js`/`detect.js`/`ollama.js` use injectable deps → daemon testable the same way | ✅ | [detect.js:42-47](../src/hardware/detect.js#L42); [ollama.js:26](../src/hardware/ollama.js#L26) |
| 11 | Ollama needs no secret/master-key in env → allowlist env is safe | ✅ | [ollama.js](../src/hardware/ollama.js) is HTTP-only loopback, no auth; CLAUDE.md §4 |

(#8 is the one row I verify at the first edit, per protocol — a one-line grep; everything else read directly.)

---

## 11. Open questions

**Resolved during sweep:**
- *Spawn from Node or Rust?* → Node (lazy, owns the HTTP probe, matches embed supervisor; Rust group-kill still reaps it).
- *Detach the child?* → No — non-detach gives free cleanup via the Node process group; detaching would orphan it.
- *Add ollama to the Rust pidfile?* → No — name-matching `ollama` in `reap_stale_pids` could kill the user's own daemon (PID reuse + adopt).
- *Dedup server- or client-side?* → Client (`pullAndUse` already has the list; smallest change). Server-side UNIQUE is a larger migration — deferred.

**Deferred (out of scope, named so they don't ambush later):**
- Non-default `OLLAMA_HOST` port detection.
- deepseek-r1 / reasoning-trace models in the catalog (use-case mismatch with enrichment/narration).
- Server-side provider dedup / a UNIQUE constraint migration.
- Bundling Ollama as a sidecar (rejected on security/robustness/size grounds — see headline).
- Auto-installing Ollama (rejected — running fetched installers crosses the trust boundary).

---

## 12. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `ollama serve` spawns but never binds (corrupt install) | Low | Med | `start_timeout` → clear UI error + install link; no partial state |
| Quality ratings are subjective / contested | Med | Low | Curated + reviewed-in-repo (like blurbs); easy to tune; ordering also respects fit |
| Updated H4/HR2 expectations drift from actual math | Med | Low | Re-derive by running, then pin; gates fail loudly if math changes |
| Binary-discovery misses an install layout | Low | Med | Allowlist + full PATH scan + `MYCELIUM_OLLAMA` override; falls back to install link |
| Concurrent Pull&use double-spawn | Low | Low | Single-flight promise in `ensureUp` (H7e) |
