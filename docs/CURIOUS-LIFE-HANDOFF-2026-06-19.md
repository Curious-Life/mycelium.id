# Curious Life redesign — Handoff Doc

**Date:** 2026-06-19
**Audience:** the next Claude Code instance picking up the Curious Life page work.
**Companions (read these next):**
- `docs/SPEC-curious-life-interaction-2026-06-19.md` — **interaction/component spec (this thread owns it). NOT on main yet — it's on PR #307.**
- `docs/SPEC-curious-life-page-2026-06-19.md` — metric/validity spec (the "Ada" half). **Uncommitted/untracked in the main working tree — never committed. Commit it or it's lost.**
- `docs/CURIOUS-LIFE-METRICS-CATALOG.md` — per-metric plain-language + rigor (on main).
- `docs/FINDING-clustering-run-inconsistency-blocks-topic-river-2026-06-19.md` + `docs/FINDING-territory-naming-incomplete-2026-06-19.md` (on main).

This is a two-agent design collaboration: **this coding thread** owns the interaction/component spec + the frontend/endpoint build; a separate **metrics/research thread ("Ada")** owns the metric spec, reliability calls, clustering/naming pipeline, and the literature grounding. The two specs cross-reference and must be reconciled.

---

## TL;DR — current state

| Slice | PR / commit | Status |
|---|---|---|
| Precision-ladder IA rework + Routine/Early-signals + first endpoints + metricsCatalog + reference doc | #293 (main `d1ba451`) | ✅ merged + deployed |
| Anchor-count-over-time graph + cache schema v2 | #304 (main `8fa4bb2`) | ✅ merged + deployed |
| Title fix + Week×top-3 drill-floor + shared-hover sync + cache v3 | #312 (main `4a6eccd`) | ✅ merged + deployed |
| Interaction/component spec (+ 2 rounds of Ada review folded in) | **#307 (OPEN)** | ⏳ open, not merged |
| River cold-compute perf fix (cap + chunked decrypt + robust `v4` key) | **PR #317 (OPEN)** | ⏳ open, not merged |
| `weekly_top` regression restore (commit `e3ddb9c`, on #317) | **PR #317 (OPEN)** | ✅ FIXED on branch; merges with #317 |
| Territory naming (describe-only) + clustering reconciliation | metrics/pipeline thread | ⛔ owned elsewhere, gating B1 |

> ## ✅ REGRESSION — FIXED 2026-06-19 (was: fix this FIRST)
> **`weekly_top` was clobbered off `main`** and is now **restored on PR #317** (commit `e3ddb9c`, `RIVER_SCHEMA` bumped `v4`→`v5-weeklytop`, `verify:territory-river-cache` 8/8 GO). It is NOT yet on `main` — it lands when #317 merges, and the app must be re-deployed after.
> **What happened:** #312 added `weekly_top` to the `/portal/territory-river` payload (the week×top-3 drill-floor). A later movement PR — **#315 `4771e5e`** — branched *before* #312, touched `src/portal-measurement.js`, and its merge **dropped the `weekly_top` block** (`anchor_count` survived; `weekly_top` did not — `grep -c weekly_top` on main's `portal-measurement.js` = **0**). The frontend (`WeeklyTopTerritories.svelte` + `CuriousLifeView`) renders it gated on `river?.weekly_top?.length`, so the graph went silently empty.
> **The fix** (commit `e3ddb9c` on `fix/territory-river-eventloop-cache`): re-added the `weekly_top` computeFn block (section 7) from #312 (`4a6eccd`), reconciled on top of #317's capped + chunked-decrypt cold fold; bumped the cache schema so stale payloads (which lack `weekly_top`) are invalidated. Full payload now verified to carry `weekly_top`, `anchor_count`, `anchors[]`, `novelty.{text,path}`.

**The app (`/Applications/Mycelium.app`) was hot-patched to main *at the time of the #312 deploy*** (when `weekly_top` was present), so the *running app* currently still serves `weekly_top` — but a fresh deploy from current main would lose it until #317 (which now carries the restore) merges. The page is otherwise live: title fixed, territory river + anchor-count, shared-hover sync. **Known rough edge:** river first load ~10–23s + cache not catching — **fix is in open PR #317** (cap + chunked decrypt + robust `v4` key dropping the `MAX(updated_at)` churn) + the `weekly_top` restore; deploy it once merged.

**Build order:** steps 1–3 shipped (#312). Next = **B1 connectivity** (gated), **B2 event-anchor** (infra unblocked), **B3 movement** (gated). See Implementation plan.

---

## What shipped (commit detail)

All merged to `main` via squash; branches in `mycelium-worktrees/curious-life`.

**#293 `d1ba451` — precision-ladder rework**
- `portal-app/src/lib/views/CuriousLifeView.svelte` — rebuilt: hero, narrative summary band, at-a-glance stats, grouped pillar cards (How you think / Your world / Turning points), "What we measure" glossary, rigor badges, band/granularity relabeling.
- `portal-app/src/lib/curious/metricsCatalog.ts` (new) — single source for the glossary + rigor labels.
- `src/portal-measurement.js` — new owner-gated endpoints `/portal/behavioral`, `/portal/criticality`, `/portal/events` (read path auto-decrypts envelopes; no crypto-registry change).
- `docs/CURIOUS-LIFE-METRICS-CATALOG.md` (new).

**#304 `8fa4bb2` — anchor-count graph**
- `/portal/territory-river` payload gains `anchor_count` (persistent-core size/week, trailing-26wk ≥60% rule).
- `territory-river-cache.js` schema → `v2-anchorcount`.
- `CuriousLifeView` renders it via `TimeSeries`.

**#312 `4a6eccd` — title + week×top-3 + shared-hover**
- Title: retired the centered gradient hero ("Your mind, quantified.") → quiet left-aligned "Curious Life" overline.
- `/portal/territory-river` payload gains `weekly_top` (each week's top-3 territories + counts = `round(share × weekly message_count)`, names from `territory_profiles`). Cache → `v3-weeklytop`.
- `portal-app/src/lib/curious/WeeklyTopTerritories.svelte` (new) — rank-colored weekly bars, hover → names+counts.
- `TerritoryRiver.svelte` refactored to a **bindable `hoverDate`** (hoverIdx derived); `CuriousLifeView` holds a page-level `hoverDate` bound to both → one cursor syncs every graph.

**Adjacent work merged by the metrics/Ada thread** (depended-on, not ours): #287 vitality dedup (`240b773`, fixes the over-count I'd flagged), #288 clustering validity diagnostics (`95d80c4`), #289 decrypt-once cache + isEncrypted prefix-guard (`ea46ebc`), #290 topology prune (`ca0b06d`), #292 embedding-novelty (`e1bc31c`), #294 CVP presentation gate (`ea34e5e`), #296 LZ saturation fix (`5f98859`), **#301 territory-river persisted cache (`ab196c7`)**, plus `src/metrics/baseline-z.js` (trailing-exclusive "unusual for me" z) + a `verify:fisher-display` gate.

---

## The design — decisions locked (with Ada's deltas folded in)

The full design is in the two specs. The load-bearing decisions:

1. **The page = one bidirectional timeline ("one instrument").** Shared time axis; the *system* annotates shifts downward, the *person* annotates events upward, the *AI* reads both (third writer). Correlation lives in the overlap. Everything drills to the week×top-3 floor.
2. **Honesty staircase: detect → correlate → predict.** Detection ships now (change-points are sound). Correlation is *earned* via anchored events (the ground-truth engine), gated by CVP (#294). **Prediction stays present-tense, never a forecast** — EWS sensitivity is ~33%, direction-blind (Smit 2025). "You've been slower to return to baseline" ✅; "a shift is coming" ❌.
3. **Reliability tiers drive display.** Tier-A (counts/text/behavioral, basis-independent) = headline; Tier-B (Fisher/coherence/harmonics/LZ, basis-dependent) = hedged detail; Tier-C (embedding-anchors/affect, CVP-pending) = badged/gated.
4. **Self-relative always** ("vs *your* normal", baseline-z), drill-to-evidence everywhere, name-the-experience-not-the-machinery (no "quantified"/"analytics").

**Ada's B-layer corrections (folded into #307 — the ones that change implementation):**
- **B1 Connectivity is an idiographic temporal network (graphicalVAR).** Co-firing = contemporaneous net; transitions = temporal net. **DO NOT ship raw co-occurrence — volume-confounded.** Use **PPMI → regularized partial-correlation + sparsify**; transitions at **realm/theme, share-weighted** (territory-level undersamples to noise); **snapshot `territory_cofire`** rather than re-derive; drift = edges vs surrogate noise.
- **B2 Event-anchor primary path = system-PROPOSED at detected shifts (in-situ).** Retrospective scrolling captures the biased ~70% (hindsight). Fuzzy/range dates; timestamped valence (good/hard/neutral/mixed/unsure); free-text fallback. Couples B2↔B3/P3.
- **B3 Movement uses `velocity_baseline_z`** (not pooled-null) for the "Nσ" copy; cycling/exploring via **depth-invariant `R_recent` / windowed `D_K` / mean step** — NOT the cumulative `fisher_*` columns (those are the depth-degenerate source of the weird numbers). Each shift-mark carries its **P3 agreement quadrant** ("cross-check pending" until P3 lands).

---

## Implementation plan (the build order)

✅ **1–3 shipped** (#312): title, shared-hover, week×top-3.

🔜 **B1 — Connectivity over time** (§3.5 of interaction spec). **Build as a temporal psychometric network, not naive co-occurrence.** First cut: PPMI + top-edge sparsify on realm/theme co-activation; share-weighted realm/theme transition matrix; co-firing-drift = PPMI edges across windows vs surrogate. Target: partial-correlation (GGM). **GATED on:** realm/theme layer being consistent + named (clustering reconciliation) + ideally the cofire-snapshot pipeline job. Reuses the river's heavy activation fetch (so it benefits from the perf fix).

🔜 **B2 — Event-anchor** (§3.7). **Infra is unblocked, build it next:** `user_events` table (encrypted: label, valence, valence_ts, fuzzy date, note), `GET/POST /portal/events/anchor`, capture UI, marker overlay on every time graph (reuse `hoverDate`/shared axis), "since [event]" before/after lens. The **system-proposed-at-shifts primary path couples to B3/P3** (needs shift detection to know where to prompt) → lands with B3; free-text anchor is the interim.

⛔ **B3 — Movement shift-marks** (§3.4). **GATED on** the depth-invariant `D_K`/mean-step columns landing (metrics thread) + the P3 cross-check layer. Then: velocity-z spikes as marks on the shared timeline, baseline-z copy, P3 quadrant per mark.

Then: Novelty surface (gzip + coarse LZ now; embedding-novelty fine via CVP) · Texture (coherence-as-flow, harmonics exploratory) · Recovery/early-signal battery (present-tense).

---

## Production state

- **App:** `/Applications/Mycelium.app` — hot-patched to current `main` (full `src/` + `migrations/` + `portal-app/build` sync + adhoc re-sign + relaunch). Serves `:8787`.
- **Verify it's current:**
  ```
  grep -c weekly_top /Applications/Mycelium.app/Contents/Resources/app/src/portal-measurement.js   # expect 1
  curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8787/api/v1/portal/frequency            # expect 200
  curl -s "http://127.0.0.1:8787/api/v1/portal/territory-river" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log("weekly_top:",(JSON.parse(s).weekly_top||[]).length))'  # expect ~417 (may be slow/cold)
  ```
- **Migrations:** the bundle's `migrations/` was synced from main; the app applies pending ones on boot (incl. `territory_river_cache`, clustering diagnostics).

---

## Gotchas + lessons (2026-06-19)

- **River cold-compute freezes the whole app (the big one).** `/territory-river` decrypts ~417 weekly `activation_vector` blobs synchronously (~10–23s, up to 2min under boot) → monopolizes the single Node event loop → *every* endpoint returns HTTP 000 until it finishes. NOT a crash (server-rest.js at ~73% CPU grinding). #301's persisted cache fixes *repeat* loads but **not the cold path**, and any cache-schema bump (v2/v3) or true cold boot re-triggers it. Observed: a 2nd sequential river call still ~10s → the data-derived cache key was **rotating** (the key included `MAX(updated_at)` over `territory_profiles`, which churns under the enrich pipeline) so it never cached. → **FIX is open PR #317** (`fix/territory-river-eventloop-cache`): 180-week cap + 60-row chunked decrypt + `setImmediate` yield + a robust cache key (`v4`, drops `MAX(updated_at)`). Deploy once merged. NOTE: #317 lacks `weekly_top` (see the REGRESSION callout) — reconcile.
- **Deploy = hot-patch the bundle** (no full Tauri rebuild needed — the diffs are JS-only): `rsync -a --delete` main's `src/` + `migrations/` + `portal-app/build` into `/Applications/Mycelium.app/Contents/Resources/app/`, `codesign --force --deep --sign - /Applications/Mycelium.app`, `open` it. **Back up first** (`cp -R src build migrations /tmp/...`). The bundle is adhoc-signed (re-signing adhoc is fine). A minimal one-file patch breaks on missing imports (the bundle lags several PRs) → sync the whole `src/`.
- **Dev-preview verification recipe:** `.claude/launch.json` config `curious` runs vite on `:5179` (worktree `portal-app`), proxying `/api` → `:8787`. The SPA's auth gate needs the app up (else redirects to `/login`). The preview's 16-request burst **re-congests** the app → page gets stuck on skeletons; wait it out or load when the app's idle. For components whose endpoint isn't in the running app yet, use the **sample-swap**: write `portal-app/static/river-sample.json`, temp-edit the river fetch to `fetch('/river-sample.json')`, screenshot, then revert the one line (do NOT `git checkout` the whole file — it wipes uncommitted edits).
- **Synthetic-event hover in preview:** dispatch `PointerEvent` with `clientX`; `offsetX` is unreliable. Read tooltip state *after* a `setTimeout(…,250)` (Svelte reactivity flush) — synchronous reads show stale values.
- **Squash-merge-then-continue:** after a PR squash-merges, `git checkout -B <new> origin/main` for the next slice — don't keep committing on the old branch (it diverges; re-merging re-introduces). Hit this between #304 and #312.
- **Naming blocker:** 218/312 territories have null `name`/`essence`/`top_entities` → bands read "Territory 2660". Fix = a **describe-only** pipeline pass (a full re-cluster collapses realms — known issue). Owned by metrics/pipeline thread.
- **Clustering inconsistency:** three irreconcilable realm id-spaces (trajectory 1–48 vs territory-assignments 43–56 vs realms table = 2) → named *realm*-level views blocked; ship at territory altitude. (FINDING doc on main.)
- **`autoDecryptResults` is envelope-sniffing, not registry-gated** (`crypto-local.js`): a raw `db.rawQuery` SELECT auto-decrypts any envelope column even for tables not in `ENCRYPTED_FIELDS` — which is why `/behavioral` `/criticality` worked with no crypto change. #289's prefix-guard (`isEncrypted` requires `"ey"` prefix) is compatible (Python `json.dumps` envelopes start with `"ey"`).
- **Vitality bug was real and is FIXED upstream** by #287 (`240b773`) — my BUG note was removed as resolved. Don't re-file it.

---

## Open decisions for the operator

1. **Start B2 infra now, or hold?** B2's storage/capture/overlay infra is unblocked (keystone). Its *system-proposed* primary path needs B3. **Recommendation:** build the B2 infra now (free-text anchor + overlay + "since" lens); add the proposed-path when B3 lands.
2. **River perf — decided in #317:** it did *both* (180-week cap + chunked/yielding decrypt + robust key) **and now carries the `weekly_top` restore** (commit `e3ddb9c`). The cap means the river shows ~last 180 weeks, not the full 2018→2026 span — confirm that's acceptable, or widen the cap. Action: merge #317, redeploy (the `weekly_top` restore rides along).
3. **B1 cofire source:** snapshot `territory_cofire` over time (richer, needs a pipeline job) vs activation-derived weekly PPMI (build-now, coarser). **Recommendation:** activation-derived PPMI first cut; snapshot job later.
4. **Spec PRs:** merge #307 (interaction spec) after you + Ada reconcile; **commit the metric spec** (`SPEC-curious-life-page-2026-06-19.md`) — currently untracked in the main working tree, at risk of loss.
5. **The metric-side deliverables that gate us:** depth-invariant `D_K`/mean-step columns (gates B3), dimension-aware Fisher smoothing (ε=α/n), realm/theme consistency + naming (gate B1), the P3 cross-check layer (gates B3 marks). Confirm ownership with the metrics thread.

---

## Pickup protocol (execute in order)

0. ✅ **DONE — `weekly_top` regression fixed** (commit `e3ddb9c` on #317, `verify:territory-river-cache` 8/8). Nothing to do here except merge #317 + redeploy (steps 3–4). Left in place as the audit trail.
1. **Read this handoff cold.** Then read `docs/SPEC-curious-life-interaction-2026-06-19.md` (on PR #307 — `gh pr diff 307` or check out the branch) and the metric spec (untracked in the main working tree — `git -C <main> status` will show it).
2. **Confirm where main is:** `git -C mycelium-worktrees/curious-life fetch origin main && git log --oneline -8 origin/main` — note any new metrics-thread PRs (this repo moves fast; main advanced ~10 PRs during this session).
3. **Verify the app is current + healthy:** run the Production-state probes above. If the river is slow/000, check `task_566d39e4` (perf subagent) status — it may have shipped a fix.
4. **Check PR #317** (river-perf: cap + chunked decrypt + robust `v4` key + the `weekly_top` restore, commit `e3ddb9c`). When it merges, re-deploy the app (hot-patch runbook) so the river is fast *and* the week×top-3 works — both fixes ride together now.
5. **Check the gates** (with the metrics thread): naming describe-only pass done? clustering reconciled (realms named/consistent)? depth-invariant `D_K` columns + P3 landed? These unblock B1/B3.
6. **Decide the next slice** (Open decision #1): default = **B2 event-anchor infra** (unblocked keystone). Run `/sweep-first-design` before B1/B2 structural code, `/deploy-and-verify` after any deploy.
7. **For B1 when you build it:** it MUST be the PPMI/partial-correlation temporal network at realm/theme — re-read §3.5. Do not ship raw co-occurrence.

---

## Worktree / branch state

- Worktree: `mycelium-worktrees/curious-life` (this thread's isolated tree; main is contested by other sessions — always work in a worktree).
- `portal-app/node_modules` is a real `npm ci` install; root `node_modules` is symlinked to the main checkout (enough for `verify:*` + svelte-check).
- Open branch: `docs/curious-life-interaction-spec` (= PR #307). This handoff is on `docs/curious-life-handoff`.
- Skills that fired this session: `/sweep-first-design` (the data sweeps + B1 methodology check), `/deploy-and-verify` (each deploy), `/handoff-discipline` (this doc). The metric/validity work was grounded against live literature by the Ada thread.
