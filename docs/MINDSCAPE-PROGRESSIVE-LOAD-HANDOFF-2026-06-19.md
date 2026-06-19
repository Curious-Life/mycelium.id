# Mindscape progressive load — durable points cache + visuals-first

**Date:** 2026-06-19 · **Branch:** `perf/settings-agents-curious` (off `origin/main` f449e10)
**Status:** built + gated GREEN, not yet merged. Touches a central read path + the
onboarding-gating endpoint → human review + live WKWebView smoke after rebuild.

## TL;DR

Opening the Mindscape (mycelium) page was slow because the **3D points were thrown
away and re-read on almost every open**. The single mindscape cache was busted by
**chronicle/narrative** writes (constant during background enrichment) — but
narration never moves a point. So the expensive geometry recomputed for nothing.

Fix: **split the cache.** The points (geometry) now live in a DURABLE cache that
narrative busts do NOT touch; only real point changes (re-cluster, doc/msg delete)
drop them. A new `GET /portal/mindscape/points` serves the geometry, and the
frontend renders it FIRST (instant) then loads the full `/mindscape` for the text
panels.

## Evidence (measured, encrypted 70k-point vault)

| Mindscape sub-read | Time | Note |
|---|---|---|
| `getPoints` (VISUALS, plaintext) | **234 ms** | the dominant cost + biggest payload |
| `getTerritoryProfiles` (TEXT, encrypted) | 18 ms | a few hundred rows |
| `getThemeCards` (TEXT) | 3 ms | |
| full bundle | 283 ms | |

The natural assumption (encrypted *text* is slow) was **wrong** — the plaintext
*points* are the cost. So caching the points (not the text) is the lever, exactly
as the user proposed. "Visuals first" then falls out: points are cheap to keep warm
*because* they change rarely, so they get their own durable cache.

Root cause of the constant re-read: `jobs.js:495` busted the whole cache on every
chronicle write. Now it busts only the full (text) cache; points survive.

## What changed

- **`src/mindscape-cache.js`** — refactored to a small `makeSwrCache()` factory with
  TWO instances: a durable **points** cache + the **full** cache. New API:
  `getMindscapePointsCached` / `bustMindscapePoints` (drops BOTH) alongside the
  existing `getMindscapeCached` / `bustMindscape` (now full-only).
- **`src/portal-mindscape.js`** — extracted `buildPointsBundle(points, diag)` (nodes
  + activity maps + centroids + counts + meta — the whole 70k-row half), cached
  durably via `loadPointsBundle()`. New `GET /mindscape/points → { nodes, meta }`.
  The full `GET /mindscape` now REUSES the cached bundle (no second getPoints, no
  second 70k loop) and adds the cheap text profiles — so even after a narrative
  bust the geometry is reused, not rescanned. Output shape unchanged.
- **bust call sites** — `jobs.js:219` (clustering job), `documents.js:305`,
  `messages.js:330/473` (point deletes/edits) → `bustMindscapePoints`.
  `jobs.js:495` (chronicle narration) stays `bustMindscape` (full only). **This is
  the fix.**
- **`portal-app/.../stores/mindscape.ts`** — `load()` is now two-phase: await
  `/mindscape/points` → set points + clear `loading` (3D paints), then await
  `/mindscape` → fill themes/territories/realms. Phase-1 nodes are kept (same ref →
  no 3D re-render); phase-1 failure falls back to the full payload's nodes.
- **`portal-app/.../secure-fetch.ts`** — routing entry for the new path (remote
  channel parity; the local app uses plain fetch).

## Why it's safe (the fragile parts)

- **Output parity:** `GET /mindscape` returns the identical `{ nodes, themes,
  territories, realms, semanticThemes, meta }` shape. The gate golden-checks that
  `/mindscape` nodes are byte-identical to `/points` nodes and that text + centroids
  + activity still surface (B2).
- **One projection:** both endpoints build `nodes` via the same `buildPointsBundle`,
  so they can never diverge.
- **Single pass:** the two old point loops (activity, then counts) merged into one
  (counts always; activity gated on `month`) — same result, one scan.
- **`meta` is point-derived** (counts/noise/partitionConfidence), so it travels with
  the durable geometry and refreshes on a point bust — which is exactly when
  clustering writes new diagnostics (validated by the updated portal-mindscape M1c).

## Verification

```
verify:mindscape-points-cache   GO  (NEW: A1-A4 cache durability + B1-B3 endpoint/parity/§7)
verify:mindscape-cache          GO  (updated C6 wiring assertions for the two-cache split)
verify:portal-mindscape         GO  (M1c now busts points — diagnostics are point-derived)
verify:mindscape                GO  (no regression)
verify:forget · portal · portal-data   GO  (central bust-site files exercised)
svelte-check                    0 errors / 0 warnings (703 files)
```

## NOT done / follow-ups

- **Live WKWebView smoke after rebuild** — required (this is bundled JS + a central
  read path; per CLAUDE.md remote-MCP/portal caveats, headless green ≠ live green).
- Settings `/stats` and the streams covering-index win (0033) ALSO need the rebuild
  to go live — none of this is live until the packaged app is rebuilt.
- Deeper geometry win (F2b typed-array nodes) still open — shrinks transfer + render,
  orthogonal to this caching fix.

## ASCII — before / after

```
  BEFORE                                AFTER
  ────────────────────────────         ──────────────────────────────────────
  narration writes text                narration writes text
        │                                    │
        ▼                                    ▼  bustMindscape (full only)
  bustMindscape → drops EVERYTHING      full(text) cache dropped
        │                                    points cache UNTOUCHED ──┐
        ▼                                                             │
  next open: getPoints 234ms again     next open:                    │
  (geometry rescanned for nothing)       GET /mindscape/points ◄──────┘ warm → instant 3D
                                          GET /mindscape  → text fills in after
```
