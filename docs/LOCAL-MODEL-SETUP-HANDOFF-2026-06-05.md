# Local-Model Picker v2 — Handoff (2026-06-05)

## TL;DR

Rebuilt the Settings → Intelligence local-model picker (S6 "Cookbook") around three asks:
1. **Ollama auto-starts** on "Pull & use" (lazy adopt-or-spawn); guided install link when the binary is absent (no bundling, no auto-installer).
2. **Catalog 9 → 19** models, with a **companion-suitability `quality`** axis (warmth/EQ for personal growth — *not* coding/benchmarks) + a `bestFor` tag.
3. **Full scrollable list**, ranked **descending by compatibility × companion-quality** (was top-4, won't-fit filtered out).

Design + rationale (incl. PewDiePie/odysseus + EQ-Bench research): [docs/LOCAL-MODEL-SETUP-DESIGN-2026-06-05.md](LOCAL-MODEL-SETUP-DESIGN-2026-06-05.md). Built via `/sweep-first-design` (4 sweeps, 3 documented pivots, 11-row verification table).

## The reframe (why quality changed)

The picker feeds Mycelium's *thinking* (enrichment/narration) for a cognitive vault about personal growth, so models are ranked as a **warm companion / self-development guide**, grounded in **EQ-Bench** (emotional intelligence + creative writing) + **Spiral-Bench** (anti-sycophancy — we want *appropriate challenge*, not flattery), with community consensus where benchmarks are thin:
- **gemma2 = the warm family** (a gemma2:9b derivative, Ataraxy-9B, topped EQ-Bench creative writing). gemma2 9b/27b + `vanilj/gemma-2-ataraxy-9b` are the backbone.
- **mistral-nemo:12b** — warm/creative favourite.
- **llama 3.1/3.3** — balanced, slightly assistant-coded.
- **qwen2.5** — smart but cooler (analytical coach), **phi** — clinical/STEM (worst for warmth). Both intentionally demoted.

Proof: on a 16GB Mac (~10.7GB usable) the top four are `vanilj/gemma-2-ataraxy-9b → gemma2:9b → mistral-nemo:12b → llama3.1:8b`.

## Files changed

| File | Change |
|---|---|
| `src/hardware/catalog.js` | 19 models; `quality` (companion-suitability) + `bestFor` + per-model rationale comments |
| `src/hardware/recommend.js` | full list; composite `rankScore = quality × fitWeight(fitScore)`; Band A (fits, desc) then Band B (won't-fit, paramsB asc); `note` only when nothing fits |
| `src/hardware/ollama-daemon.js` **(new)** | lazy adopt-or-spawn `ollama serve`; absolute-path binary discovery; single-flight; `stop()` only kills what it spawned; `findOllamaBinary` exported |
| `src/portal-hardware.js` | `ollamaInstalled` in recommend; new `POST /hardware/start`; `ensureUp()` before pull (surfaces `not_installed`/`start_timeout`); injectable `daemon` |
| `src/server-rest.js` | construct one shared `createOllamaDaemon()`, pass to router, `stop()` in `closeHandle` |
| `portal-app/.../IntelligenceSection.svelte` | scroll container (`max-h-72`); install-vs-start state + Install Ollama link; `bestFor` pill; provider **dedup** in `pullAndUse`; auto-start (removed the `ollama serve` nag + the `!ollamaUp` gate) |
| `scripts/verify-hardware.mjs` | H4 rewritten to new contract; **+H7** (daemon: adopt/not-installed/spawn/timeout/single-flight/discovery-order/stop) |
| `scripts/verify-hardware-routes.mjs` | HR2 rewritten; **+HR6** (start), **+HR7** (pull auto-starts), **+HR8** (not-installed → no pull) |

## Verification ledger

- [✓] `npm run verify:hardware` → GO (H1–H7)
- [✓] `npm run verify:hardware-routes` → GO (HR1–HR8)
- [✓] `npm run verify:rest` · `verify:providers` · `verify:resolve` → GO (regressions)
- [✓] `portal-app` build → clean
- [✓] **Live smoke (this machine, Ollama genuinely absent):** `/hardware/recommend` → 19 models, `ollamaInstalled:false`, top `gemma-2-ataraxy-9b (Warmest prose)`; `/hardware/start` → `{ok:false, reason:'not_installed'}`. The guided-install path works end-to-end.
- [—] **Not smoked here (no Ollama installed):** the installed→adopt and installed→spawn *live* paths. Unit-verified by H7c (spawn `['serve']` + poll-up) and H7a (adopt). To smoke with a real install: `brew install ollama`, stop it, click Pull & use — expect it to auto-start then download.

## Security notes (CLAUDE.md §2/§4/§6)

Spawning is the only new surface. Fixed args `['serve']`, no shell, binary from a fixed absolute allowlist (+PATH dirs, never request input), env allowlist (PATH/HOME/OLLAMA_* — no master key/secrets), spawn only when down, kill only `spawnedByUs` (never an adopted daemon), fail-closed on missing binary. Pull surface still catalog-constrained (HR4/HR5).

## Deferred (named, not lost)

- Installed→adopt/spawn live smoke (needs Ollama on the box).
- Per-use-case ranking weights (odysseus `USE_CASE_WEIGHTS` shape) — we ship the single companion use-case.
- Server-side provider dedup / UNIQUE constraint (frontend dedups for now).
- Non-default `OLLAMA_HOST` port detection.
- deepseek-r1 / reasoning-trace models (the `<think>` output hurts conversational use).
- `quality` ratings are curated judgments — tune freely; ordering also respects fit.

## Pickup protocol

Branch `docs/build-mac-fetch-sidecars` (uncommitted working tree). Nothing committed yet for this work — `git status` shows the 8 changed/new files above. Next: commit, then optionally PR. Re-run the two hardware gates after any catalog/quality tweak (H4/HR2 pin exact picks).
