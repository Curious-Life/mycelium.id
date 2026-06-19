# Wiring the Fisher cross-check into the Curious Life page — Design

**Date:** 2026-06-19
**Branch:** `feat/curious-life-fisher-crosscheck` (off `origin/main` @ `d71c844`)
**Companions:** `docs/CURIOUS-LIFE-HANDOFF-2026-06-19.md`, `docs/DESIGN-fisher-embedding-trajectory-2026-06-19.md` (P3a/P3b), `docs/DESIGN-fisher-faithfulness-2026-06-19.md` (P0)
**Audience:** the next Claude Code instance building this.
**Skill:** authored under `/sweep-first-design` (3 sweeps + own-eyes verification; pivot recorded below).

---

## 0. What we're building

The Fisher movement arc is fully on main: **P0** (#313) honest baseline-relative σ headline · **P2** (#315) freshness hedge · **P3a** (#319) basis-free embedding centroid-drift series · **P3b** (#321) the 2×2 cross-check endpoint + a minimal one-line chip. The operator chose two page elements:

- **(A) Trust qualifier on the headline σ** — the cross-check verdict re-frames how much to trust *this week's* movement number, surfaced next to the σ rather than as a footnote.
- **(B) 2×2 quadrant plot** — a small SVG showing this week's position on the Fisher-distribution × semantic-center axes, so "two independent witnesses agree/disagree" is legible at a glance.

This is a **presentation + one small endpoint-contract** change. No migration, no pipeline, no new sensitive data.

---

## 1. Revision history — the pivot

**v1 (the operator's sketch + my first proposal):** "Fold the cross-check verdict up next to the σ headline as a trust chip (corroborated/basis-suspect/hidden-drift)."

**v2 (after Sweep 1 + reading the two endpoints myself) — PIVOT:** *The chip can only honestly qualify the displayed headline σ when the cross-check's aligned week equals the headline's current week.*

Why: the headline σ (`/trajectory/summary` → `velocity_baseline_z`) is `baselineZ(confVel)` over **all** confident Fisher rows of the run — its "current" is the **latest confident Fisher week** = `max(fConfW)`. The cross-check F (`/trajectory/cross-check`) is `baselineZ(fSeries ≤ W)` where **`W` = the latest week confident in *both* Fisher *and* embedding** — so `W ≤ max(fConfW)`. When the embedding-trajectory stage lags (its own freshness family — by design, migration `0031`), `W < max(fConfW)`, and a "corroborated" chip stuck on the headline would be vouching for a *different, older* week than the number on screen. That is precisely the false-confidence this whole arc exists to kill.

**Resolution:** make the cross-check endpoint self-describe whether `W` is the current frontier. Because the cross-check fetches the **identical** Fisher series the headline does (`db.fisher.getTrajectory(u.id,{level,windowType:'weekly_step',limit:1000})`), it already knows `max(fConfW)`. Return it. The frontend then qualifies the headline **only** when `is_current === true` (and in that case `F.z === velocity_baseline_z` *exactly* — set-equality of inputs, gate-assertable); otherwise it degrades to an honest "as of {W} · semantic cross-check is N weeks behind" form that does **not** claim to qualify the on-screen σ.

This keeps the single source of truth server-side; the frontend never re-derives the confident-row selection.

---

## 2. Sweep findings (consolidated, file:line — all re-read by me)

### Signal identity (the load-bearing question)
- Headline σ: `src/portal-measurement.js:323-328` — `confVel = all.filter(!low_confidence && fisher_velocity!=null).map(fisher_velocity)`; `velBz = baselineZ(confVel)`. Period (`PERIOD_DAYS`) slices the *displayed* series/peak only, **not** the baseline (`:286-293` vs `:323`). Level default `realm` (`:275`); frontend requests `?period=quarter&level=realm` (`CuriousLifeView.svelte:94`).
- `baselineZ` (`src/metrics/baseline-z.js:34-56`): trailing-**exclusive**, K=12, current = last element; fail-closed on degenerate baseline (`cv<0.02` / `std<1e-9` → `lowConfidence`, `z:null`, never a fabricated σ).
- Cross-check F: `src/portal-measurement.js:378` fetches the **same** `getTrajectory(...realm,weekly_step)` series; `:393-398` computes `W = max{ window_start : fisher-confident ∧ embedding-confident }`; `:402-408` `fSeries = confident fisher rows ≤ W`, `F = baselineZ(fSeries)`. Returns `window_start: W` (`:427`) but **not** `max(fConfW)`.
- Summary response (`:336-357`): exposes `velocity_baseline_z`, `*_low_confidence`, `avg_velocity_z` (gate), `entropy_baseline_z`, `exploration_ratio`, `R_recent`, `top_movers`, `window_count` — but **not** the window date the baseline-z's "current" sits on. (So the frontend cannot self-derive `is_current`; the cross-check endpoint must report it.)
- **Conclusion:** identical signal, identical formula, identical level. They are bit-equal **iff** `W == max(fConfW)`.

### Render surface (`portal-app/src/lib/views/CuriousLifeView.svelte`)
- State + derived: `movement` (`:33`), `movementCrossCheck` (`:36`), `moveBaseline` (`:217-225`), `moveAboveNoise` (`:227-229`), `moveStale`/`moveStaleText` (`:236-243`), `xcAccent` (`:245-252`).
- Fetch: blocking `summary`/`current` (`:94-95`, assigned `:111-113`); **non-blocking** cross-check (`:114-115`) → `movementCrossCheck = xc?.cross_check`.
- Movement detail markup (`:721-752`): lead panel + phase badge + `stale·advisory` lc + `moveStaleText` + seg-toggle + `<TimeSeries>` big-spark + `.stat-row` of 4 `.stat` (σ "vs your normal" `:741`, entropy, R, ratio) + `moveAboveNoise` note + the existing one-line cross-check `<p class="muted sm" style="border-left…">` (`:748-752`) + "Phase by level" panel (`:753+`).
- Overview glance card for movement (`~:480-489`): `rel-chip {moveBaseline.tone}` = the glance headline.
- Palette: `accentVar`/`accentRgb` (`:393-410`) — `jade/azure/amethyst/aurum/coral/teal/rose` → `--color-accent-*` tokens (`portal-app/src/lib/styles/tokens.css`). `xcAccent` already maps `corroborated→jade`, `hidden_drift→amethyst`, `basis_suspect→azure`, else hairline.
- CSS house style: `.lc` pill (`:1083-1089`), `.stat`/`.s-v`/`.s-l` (`:1184-1189`), `.panel`/`h3` (`:1159-1161`), `.row-between`. No collapsible mechanism in the movement detail (everything always-rendered; `<details>` used only in the glossary).
- Inline-SVG precedent: `TimeSeries.svelte` (imported `:22`, used `:738`) — pure SVG, WKWebView-safe, `vector-effect="non-scaling-stroke"`, null-safe `geom`. **Mirror this** for the 2×2; do not reuse TerritoryRiver (too domain-specific).

### Contract + gates
- `/trajectory/cross-check` response (`src/portal-measurement.js:423-433`): `{ freshness:{verdict,age_ms,budget_ms}|null, freshness_hedge:string|null, cross_check:{ level, window_start, state, label, detail, fisher_velocity_z, centroid_drift_z, top_movers } }`.
- Quadrant (`src/metrics/cross-check-quadrant.js:28-67`): thresholds `movedZ=2`, `flatZ=1`; states = `corroborated|settled|basis_suspect|hidden_drift|consistent|insufficient`; fail-closed → `insufficient` when either axis null/low-conf/non-finite; deadzone `[1,2)` → `consistent`. `top_movers` populated **only** on `basis_suspect` (`:417-419`, `lastFisher.top_contributors.slice(0,3)`).
- For any **non-insufficient** state, both `fisher_velocity_z` and `centroid_drift_z` are finite (the helper requires it) → the 2×2 is always plottable when shown.
- Gates: `verify:cross-check-quadrant` (pure-helper unit test, 11 checks, no DB — `scripts/verify-cross-check-quadrant.mjs`); `verify:fisher-display` (static source analysis — `readFileSync` + substring; D7 checks the endpoint fields, D8 checks the `.svelte` toggle — `scripts/verify-fisher-display.mjs`). Frontend net = `portal:check` (`svelte-check --fail-on-warnings`). No runtime/browser gate. Aggregate `verify` chains all of them.
- Freshness: when `embedding_trajectory` is stale, `freshness_hedge` is a non-null disclaimer string (`src/metrics/freshness.js`); the UI should surface it on the cross-check surface.

---

## 3. Threat model / security

- **No new sensitive surface.** New fields (`latest_window`, `is_current`) derive from **plaintext structural** columns (`window_start`, `low_confidence`). `fisher_velocity_z` / `centroid_drift_z` are baseline-z scalars already in the response; `top_movers` are territory labels already in `summary.top_movers`. The 768D centroid is **never** persisted (migration `0031` invariant) and is not touched here.
- **Owner-gated, fail-closed:** the endpoint stays behind `owner(req,res)` (`:370`); `Cache-Control: no-store` retained.
- **No plaintext leakage:** the 2×2 renders only z-scores + already-public labels. No raw vectors, no message text.
- **Honesty (the product-level threat):** the v2 pivot *is* the mitigation — the UI never asserts corroboration of a number the cross-check isn't actually about.

---

## 4. Module shape (signatures, shapes, LOC)

### 4.1 Backend — `src/portal-measurement.js` (+~5 LOC)
In the cross-check handler, after `W` is computed, add the frontier and currency flag:
```js
// The latest Fisher-confident window — the SAME series the headline σ uses, so this is
// the headline's "current" week. is_current ⇒ F.z === summary.velocity_baseline_z exactly.
const latestFisherW = fisher.reduce((mx, r) =>
  (!r.low_confidence && r.fisher_velocity != null && (mx === null || r.window_start > mx)) ? r.window_start : mx, null);
```
and in `cross_check: { … }` add:
```js
latest_window: latestFisherW,
is_current: W != null && latestFisherW != null && W === latestFisherW,
```
No change to `/trajectory/summary`.

### 4.2 New component — `portal-app/src/lib/curious/CrossCheckQuadrant.svelte` (~95 LOC)
Pure SVG, WKWebView-safe, mirrors `TimeSeries.svelte`.
```svelte
let { f = null, e = null, state = null, accent = 'var(--hairline,#8883)',
      movedZ = 2, flatZ = 1, size = 200 } = $props<{
  f: number|null; e: number|null; state: string|null; accent?: string;
  movedZ?: number; flatZ?: number; size?: number }>();
```
- Returns nothing if `state == null || state === 'insufficient' || f == null || e == null`.
- Axes: x = **F** (topic-map movement), y = **E** (semantic-center movement), origin centered, domain clamped to `[-3,3]` (z-space) with labeled `±flatZ` / `±movedZ` gridlines.
- Plots the current point at `(clamp(f), clamp(e))`, filled with `accent`; the live quadrant's background tinted `accent` @ ~8%.
- Corner micro-labels: `corroborated` (↗), `settled` (↙ origin), `basis-suspect` (↘, "map only"), `hidden-drift` (↖, "meaning only"). Axis captions: x "topic-map σ", y "semantic-center σ".
- Tabular-nums, `0.62rem` tertiary labels; `vector-effect="non-scaling-stroke"`.

### 4.3 Frontend wiring — `CuriousLifeView.svelte` (~45 LOC)
- New derived (near `xcAccent`, `:252`):
```ts
const xcCurrent = $derived(Boolean(movementCrossCheck?.is_current));
const xcActionable = $derived(['corroborated','basis_suspect','hidden_drift'].includes(movementCrossCheck?.state));
// Trust chip ONLY qualifies the headline when the cross-check is on the current week.
const headlineTrust = $derived.by(() => {
  if (!xcCurrent || !xcActionable) return null;
  switch (movementCrossCheck.state) {
    case 'corroborated': return { text: 'corroborated', tone: 'jade', mark: '✓' };
    case 'basis_suspect': return { text: 'map effect?',   tone: 'azure', mark: '⚠' };
    case 'hidden_drift':  return { text: 'drift your map missed', tone: 'amethyst', mark: '•' };
  }
});
const xcLag = $derived.by(() => { // honest "N weeks behind" when not current
  if (!movementCrossCheck || xcCurrent || movementCrossCheck.state === 'insufficient') return null;
  return movementCrossCheck.window_start; // render "as of {date}"
});
```
- **(A) Trust chip** next to the σ stat (`:741`): when `headlineTrust`, append a small `.lc`-style pill tinted `accentVar[headlineTrust.tone]` reading `{mark} {text}`. (Glance echo on the overview `rel-chip` `~:487` is an optional Step 5 follow-up, kept minimal.)
- **(B) 2×2** import + render in the detail, **replacing** the existing one-line block (`:748-752`) with: the `<CrossCheckQuadrant …>` panel + an upgraded caption that (i) shows `label`/`detail`, (ii) prepends `freshness_hedge` if present, (iii) shows "as of {xcLag}" when not current, (iv) lists `top_movers` on `basis_suspect`.
- Honesty contract preserved: `insufficient` and `consistent` → no chip, no alarm; the 2×2 renders for `consistent` (informational, no accent) but **not** `insufficient`.

**Total: ~145 LOC** (5 backend + 95 component + 45 view).

---

## 5. Edge cases — explicit decisions

| Case | Decision | Why |
|---|---|---|
| Embedding stage lags (`W < max(fConfW)`) | No headline chip; 2×2 shown "as of {W}" + lag note | The v2 pivot — never qualify the displayed σ with a stale comparison |
| `state==='insufficient'` | Render nothing (no chip, no 2×2) | Existing fail-closed contract; a directionless week must not alarm |
| `state==='consistent'` (deadzone) | No headline chip; 2×2 shown, neutral accent | In-normal-range on both → informational, not a trust verdict |
| `freshness_hedge` non-null | Prepend disclaimer to the cross-check caption | Stale family must not read authoritative (mirrors P2) |
| Cross-check fetch fails (non-blocking `.catch`→null) | All cross-check UI absent; headline unaffected | Cross-check is additive; never blocks the page |
| `basis_suspect` with empty `top_movers` | Show label/detail without the movers line | `top_movers` only populated when `top_contributors` exists |
| User on a non-realm level | Out of scope — both headline & cross-check hardcode `realm`; documented constraint | If the headline ever becomes level-switchable, the cross-check fetch must follow the same `level` |
| `is_current===true` | Chip qualifies headline; `F.z===velocity_baseline_z` | Set-equality of `fSeries`/`confVel`; asserted in the gate |

---

## 6. Test strategy

1. **Extend `scripts/verify-cross-check-quadrant.mjs`** (pure-helper, no DB) — unchanged 11 checks stay; the helper contract is untouched.
2. **New `scripts/verify-cross-check-display.mjs`** (static source analysis, mirrors `verify-fisher-display.mjs`):
   - X1 — endpoint returns `latest_window` + `is_current` (substring on `src/portal-measurement.js`).
   - X2 — `is_current` derivation uses the same `getTrajectory(...weekly_step...)` series as summary (assert both call sites present; assert no second/foreign Fisher query introduced).
   - X3 — `.svelte` gates the trust chip on `is_current` (assert `is_current` referenced in `CuriousLifeView.svelte` and that `headlineTrust`/`xcCurrent` exist).
   - X4 — `.svelte` imports + renders `CrossCheckQuadrant`; the old always-on one-line block is gone.
   - X5 — honesty: `insufficient` still renders nothing (assert the `!== 'insufficient'` guard remains).
   - X6 — invariant doc check: assert the comment asserting `is_current ⇒ F.z === velocity_baseline_z` is present (keeps the rationale from rotting).
3. **`npm run portal:check`** (`svelte-check --fail-on-warnings`) — type-safety net for the new component + props.
4. **Full `npm run verify`** to `VERDICT: GO` before any merge (per the no-hotfixes discipline). Add `verify:cross-check-display` into the aggregate chain.
5. **Live smoke (WKWebView / dev-preview):** open Curious Life → Movement detail; confirm (a) chip appears only when current+actionable, (b) 2×2 plots the point in the right quadrant, (c) lag note appears if embedding is behind. (Dev-preview congestion caveat from the handoff applies — wait it out.)

---

## 7. Implementation order (each step independently shippable)

1. **Backend field** — add `latest_window`/`is_current` to `/trajectory/cross-check`. Smoke: `curl …/trajectory/cross-check?level=realm | jq .cross_check.is_current`.
2. **Component** — `CrossCheckQuadrant.svelte`. Smoke: `npm run portal:check`.
3. **View wiring** — derived values + trust chip + replace the one-liner with the 2×2 panel + lag/freshness/top_movers caption. Smoke: `portal:check` + dev-preview.
4. **Gate** — `verify-cross-check-display.mjs` + wire into `package.json` aggregate. Smoke: `npm run verify:cross-check-display`.
5. **(optional)** glance echo on the overview movement card. Smoke: `portal:check`.
6. **Full verify** → `VERDICT: GO`; commit; PR; leave for human glance (vault-data-adjacent UI). Coordinate merge order on `portal-measurement.js` with any in-flight Fisher PRs (none expected — arc is merged).

---

## 8. Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Chip qualifies a stale week (dishonesty) | Med (embedding lags) | High (trust) | v2 pivot: `is_current` gate; lag note when false |
| `is_current` drift if the two endpoints diverge in how they fetch Fisher | Low | High | Both use the identical `getTrajectory` call; gate X2 asserts it; comment locks the invariant |
| 2×2 renders blank on WKWebView | Low | Med | Mirror `TimeSeries.svelte` (proven WKWebView-safe); `portal:check` + live smoke |
| Visual clutter in the movement detail | Med | Low | Replace (not add to) the existing one-liner; chip is a single pill |
| Threshold flapping week-to-week | Low | Low | Deadzone `[1,2)→consistent` already in the helper; chip hidden on `consistent` |

---

## 9. Open questions — resolved during sweep

- *Is the headline σ the same signal as the cross-check F?* — Yes, **iff** `W == max(fConfW)`; otherwise an older week. (→ the pivot.)
- *Can the frontend self-derive `is_current`?* — No; summary doesn't expose the baseline-z's current window. The cross-check endpoint must report it (it has both windows from the same series).
- *Does period affect the headline σ?* — No; baseline-z uses the full run, period slices only the displayed series.
- *Is `top_movers` always present?* — Only on `basis_suspect`.

## 9b. Open questions — deferred

- Level-switchable headline (theme/territory) + matching cross-check fetch — out of scope; documented constraint.
- The cross-run velocity-change disambiguator that sharpens `basis_suspect` ("map redrew" vs "minor reshuffle") — a Fisher-track fast-follow (design doc Part 13.8), not this PR.
- Glance-tier overview chip — optional Step 5.

---

## 10. Verification table

| Load-bearing assumption | Verified at (read myself) |
|---|---|
| Headline σ = `baselineZ(confVel)` over all confident Fisher rows (current = latest confident week) | `src/portal-measurement.js:323-328` |
| Baseline-z is trailing-exclusive K=12, fail-closed on degenerate baseline | `src/metrics/baseline-z.js:34-56` |
| Period slices displayed series only, not the baseline | `src/portal-measurement.js:286-293` vs `:323` |
| Cross-check F uses the **same** `getTrajectory(realm,weekly_step)` series | `src/portal-measurement.js:378` |
| `W` = latest week confident in both; `fSeries ≤ W`; returns `window_start:W` | `src/portal-measurement.js:393-411`, `:427` |
| Summary does NOT expose the baseline-z current window | `src/portal-measurement.js:336-357` |
| `F.z === velocity_baseline_z` when `W == max(fConfW)` (set-equality of inputs) | `:323` (confVel) vs `:402-405` (fSeries) — same filter, same source |
| Quadrant states + fail-closed/deadzone rules | `src/metrics/cross-check-quadrant.js:33-67` |
| `top_movers` only on `basis_suspect` | `src/portal-measurement.js:417-419` |
| Movement detail markup + insertion points (σ stat `:741`, one-liner `:748-752`) | `portal-app/src/lib/views/CuriousLifeView.svelte:721-752` |
| `accentVar` palette + `xcAccent` mapping | `CuriousLifeView.svelte:393-410`, `:245-252` |
| Non-blocking cross-check fetch | `CuriousLifeView.svelte:114-115` |
| Inline-SVG precedent (WKWebView-safe) | `portal-app/src/lib/curious/TimeSeries.svelte` (used `CuriousLifeView.svelte:738`) |
| Gate conventions (static analysis; svelte-check only frontend net) | `scripts/verify-fisher-display.mjs:62-73`, `package.json` verify chain |
| No new sensitive data (z-scores + structural cols only; centroid never persisted) | migration `migrations/0031_embedding_trajectory.sql` header |
