# DESIGN — Login page: space animation + decisive theme adaptation (2026-06-19)

Branch `fix/login-space-animation` (worktree off `origin/main`). Replaces the login page's
procedural "mycelium tree" with the marketing site's hyphae + hover-grown starfield, shows the
gold mushroom mark, and **fixes, once and for all, the recurring "canvas doesn't re-theme on
dark↔light switch" bug.**

## Sweep findings (file:line evidence)

1. **App theme mechanism is the store, NOT `prefers-color-scheme`.**
   `portal-app/src/lib/stores/theme.ts` — a `writable<'dark'|'light'>`; `toggle()`/`setTheme()`
   write `document.documentElement.setAttribute('data-theme', theme)` and `set()` the store.
   CSS vars flip on `[data-theme="light"]` (`src/lib/styles/tokens.css:111`). Default (`:root`)
   is dark (`tokens.css:13-20`).

2. **The site's animation reads `prefers-color-scheme` vars (`--canvas-bg`) ONCE at init.**
   `/tmp/myc-site/index.html` hyphae `initCanvas()` reads `--canvas-bg` via getComputedStyle on
   first paint only; it listens for a custom `themechange` event the *site* dispatches from its
   own toggle. Our app dispatches no such event → **root cause of the bug**: ported verbatim, the
   canvas never learns the theme changed, so it keeps its initial palette.

3. **Two stacked canvases drive the effect.** `#mycelium-canvas` (hyphae; JS ~1819-2446) +
   `#starfield` (Milky-Way bloom from the mark on hover; JS ~2449-2600). Hyphae accumulate into an
   offscreen `persist` buffer and re-blit each frame. Star colors are intrinsic deep-space (theme
   independent); hyphae *line* color is hard-coded pale-warm (`hsl(34,18%,62%)`) — readable on the
   site's dark bg but **near-invisible on a light bg**, so line color must become theme-derived too.

4. **Site's starfield force-flips the whole page to dark on hover** (`galaxyPrevTheme`,
   `dispatchEvent('themechange', {source:'galaxy'})`, hides `#faq`/`#download`). That gimmick fights
   our theme store and has no meaning on a login page → **drop it.** The bloom stays a localized
   "window into space" over the current theme (reads well on both: it carries its own dark gradient
   inside the blob mask).

5. **Auth logic is independent of the canvas.** `+page.svelte` operator-password / passkey /
   telegram handlers (lines 53-323) never touch `tree-canvas`. Safe to swap the visual wholesale.

6. **Mark source of truth** = `static/favicon.svg` / `assets/mushroom.svg`: two gold paths,
   viewBox 0 0 1024 1024; mark bbox ≈ x[192,832] y[88,848]. Crop tight to `viewBox="176 64 672 800"`.
   Fill `var(--color-accent-aurum)` (auto-themes: `#E5B84C` dark / `#C9A23A` light, `tokens.css`).

## The decisive theme fix (the load-bearing decision)

Three independent layers, all driving ONE `applyTheme()` — belt, suspenders, and a parachute:

- **Read at the source, every theme change, never cache stale.** `readPalette()` calls
  `getComputedStyle(documentElement)` and reads the *live* `--color-bg` + derives line color from a
  per-theme table keyed on `data-theme`. Colors are never frozen at init.
- **Subscribe to the theme store** (`theme.subscribe`) — the canonical signal; fires on every
  `toggle()`/`setTheme()`.
- **MutationObserver on `data-theme`** — defensive: catches any path that flips the attribute
  without going through the store (e.g. server-rendered initial value, future code).

`applyTheme()` does a **full reset, not a patch**: clears the persist buffer, refills bg with the
new `--color-bg`, clears tips/nodes/grid, reseeds, rebuilds the galaxy buffer, and restarts the rAF
loop if it had ended. A full reset is what makes this bulletproof — there is no "half old-palette,
half new-palette" buffer to get wrong (the artifact every previous patch-the-bg attempt produced).
A login-page network regrowing on a rare manual toggle is invisible-to-pleasant, never jarring.

## Dark-mode aesthetic (per brief: etherial, faded, NOT brighter)

Same star brightness; soften only. Theme-keyed `feather`:
- dark: blob-edge blur `24·dpr` (vs 16), twinkle-halo radius ×1.5, core-star alpha ×0.82 → feathered
  glow, "stars in a galaxy shining," easy on the eyes.
- light: unchanged (blur 16·dpr, halo ×1.0, core ×1.0) — only needs to adapt fully + automatically.

## Layout

Two `position:fixed; inset:0` canvases (`#hyphae-canvas` z-0, `#starfield` z-1) behind a
`position:relative; z-10` content column. `.login-page` background goes transparent (body already
paints `--color-bg`; the hyphae canvas paints the same colour → seamless). The gold mushroom mark
(96px, hover origin for the bloom) sits above the wordmark; card/inputs untouched.

## Layout diagram

```
        ┌─────────────────────────────────────────────┐
        │  #starfield  (z1, fixed, transparent)         │  ← blooms from mark on hover
        │  ┌─────────────────────────────────────────┐  │
        │  │ #hyphae-canvas (z0, fixed, --color-bg)   │  │  ← fine-line network, radial-mask
        │  │                                          │  │     fades lines toward centre
        │  │              ╔══════════════╗            │  │
        │  │              ║   🍄  mark    ║ z10        │  │  ← gold mushroom (hover = bloom)
        │  │              ║  mycelium     ║            │  │
        │  │              ║   VAULT       ║            │  │
        │  │              ║ ┌──────────┐  ║            │  │
        │  │              ║ │ password │  ║            │  │  ← card (untouched auth)
        │  │              ║ │ passkey  │  ║            │  │
        │  │              ║ └──────────┘  ║            │  │
        │  │              ╚══════════════╝            │  │
        │  └─────────────────────────────────────────┘  │
        └─────────────────────────────────────────────┘

  theme toggle ──┐
  data-theme  ───┼──▶ applyTheme()  ─▶ readPalette() (live getComputedStyle)
  MutationObs ───┘                   ─▶ hyphae: clear persist + refill bg + reseed
                                     ─▶ starfield: rebuild galaxy + re-pick feather
                 (3 inputs, 1 reset — no stale palette survives)
```

## Verify
`npm run check` 0/0 + `vite build` succeeds; reason through both themes + (if app rebuilt) toggle
live and confirm the animation re-renders in BOTH directions.
