# Mycelium Design System

**Status:** Living reference for the portal UI. The implementation lives in the
`reference/portal/` snapshot today and ports to `packages/portal/` during the V1
build (see `docs/V1-BUILD-SPEC.md` and `reference/PORT-PRIORITY.md`).

**See it live:** the styleguide route at **`/design`** renders every token and
component straight from the CSS variables — change a token, the page reflects
it. It's a public page (no user data); the rest of the portal stays behind the
session gate.

---

## 1. Two identities, on purpose

Mycelium carries **two** visual identities, and the split is intentional —
document it so it reads as a decision, not drift.

| | Brand mark | Product UI |
|---|---|---|
| Artifact | `assets/mycelium-sumi-e.svg` | `reference/portal/` |
| Mood | *sumi-e* ink-wash, Zen, analog | dark, digital, instrument-like |
| Form | ensō cap · stem · ~200-particle spore cloud | dense data surfaces, lenses, maps |
| Palette | ink `#222` on warm paper `#f4efe6` | near-black `#0A0A0C`, azure + aurum |
| Type | Georgia serif | Geist + JetBrains Mono |

The **login page** (`routes/login/+page.svelte`) is the bridge: a generative
*mycelium* renderer (golden-ratio branching, anastomosis) drawn live on a
`<canvas>`, with an aurum rhombus keyline. It carries the brand's organic
spirit into the product's dark, precise shell. New surfaces should feel like the
product UI; the brand mark is for the marque, the README, and first-run moments.

---

## 2. Token contract

Three tiers, defined in **`reference/portal/src/lib/styles/tokens.css`**:

1. **Primitive** — raw values (hex, rgb channels, px).
2. **Semantic** — purpose-named CSS custom properties (`--color-surface`,
   `--space-4`). **This is the layer components consume.**
3. **Component** — local overrides in a component's `<style>`, only when a
   semantic token genuinely doesn't fit.

**Rules**
- Components reference **semantic tokens or the Tailwind aliases** — never a raw
  hex. (`bg-[var(--color-surface)]`, `text-aurum`, `var(--color-accent)`.)
- Theming is the **`[data-theme]` attribute + CSS variables**, not Tailwind's
  `dark:` variant. The store (`src/lib/stores/theme.ts`) sets
  `data-theme="light"` on `<html>`; an inline bootstrap in `app.html` applies it
  pre-paint to avoid FOUC. Dark is the `:root` default.
- **Accents are RGB channel triplets** (`--color-accent-rgb: 91 159 232`). The
  hex-producing vars derive from them (`--color-accent: rgb(var(--color-accent-rgb))`),
  and per-theme overrides touch **only the channels**. This is what lets the
  Tailwind aliases support `/opacity` (see §6).

---

## 3. Color

### Surfaces & text

| Token | Dark | Light |
|---|---|---|
| `--color-bg` | `#0A0A0C` | `#FAF8F5` |
| `--color-surface` | `#141417` | `#F5F3EE` |
| `--color-elevated` | `#1E1E23` | `#EBE8E2` |
| `--color-border` | `#2A2A32` | `#DCD8D0` |
| `--color-text-primary` | `#E8E8EC` | `#44403C` |
| `--color-text-secondary` | `#9898A3` | `#625D58` |
| `--color-text-tertiary` | `#6B6B75` | `#A8A29E` |
| `--color-text-emphasis` | `#FFFFFF` | `#1C1917` |

### Accents

| Name | Tailwind | CSS var | Dark | Light | Role |
|---|---|---|---|---|---|
| azure | `azure` | `--color-accent` | `#5B9FE8` | `#4A8BD4` | primary action |
| aurum | `aurum` | `--color-accent-aurum` | `#E5B84C` | `#C9A23A` | signature gold |
| amethyst | `amethyst` | `--color-accent-amethyst` | `#A78BFA` | `#8B6FE0` | cognitive |
| coral | `coral` | `--color-accent-coral` | `#F87171` | `#E85C5C` | alert / error |
| jade | `jade` | `--color-accent-jade` | `#4ADE80` | `#38C96A` | success / online |

Aurum is the brand's load-bearing accent (the sumi-e gold). Azure is the
interactive primary.

---

## 4. Type, space, shape, motion

- **Fonts:** `--font-sans` Geist (also `font-sans`), `--font-mono` JetBrains
  Mono (also `font-mono`). Note: `--font-serif` is currently aliased to Geist —
  there is no true serif in the product UI (the only serif is Georgia inside the
  brand SVG).
- **Spacing:** 8px grid, `--space-1`…`--space-8` (`0.25rem`…`4rem`).
- **Radius:** `--radius-sm` 4 · `md` 8 · `lg` 16 · `xl` 24 · `full`.
- **Shadows:** `--shadow-sm/md/lg`.
- **Motion:** `--duration-fast` 150ms · `normal` 250ms · `slow` 400ms; eases
  `--ease-out`, `--ease-in-out`, `--ease-bounce`. All durations collapse to
  `0.01ms` under `prefers-reduced-motion`.

---

## 5. Component classes

Defined in `app.css` `@layer components`, consumed across the portal:

`.btn` + `.btn-primary` / `.btn-secondary` / `.btn-ghost` · `.card` /
`.card-elevated` · `.input` (with focus ring) · `.tag` + `.tag-warm` /
`.tag-azure` / `.tag-amethyst` / `.tag-coral` / `.tag-jade` · `.overline` ·
`.heading-display` · `.section-marker` · `.prose-dark` · `.backdrop-dark` /
`.backdrop-surface`, plus mobile chrome (safe-area insets, overscroll lock).

---

## 6. Tailwind integration

The portal's Tailwind pipeline is **two files that travel as a unit with
`tokens.css`** — lose either and every utility silently stops compiling:

- **`tailwind.config.js`** — maps the five accent aliases to the channel vars:
  ```js
  aurum: 'rgb(var(--color-accent-aurum-rgb) / <alpha-value>)'
  ```
  `<alpha-value>` is what makes `bg-aurum/10`, `from-azure/5`, `border-coral/30`
  work — Tailwind substitutes the opacity, the channels stay theme-aware. Also
  registers the typography plugin (`prose`, `prose-invert`) and the Geist/mono
  font families. Surface/text tokens are intentionally **not** mirrored here —
  use them as arbitrary values (`bg-[var(--color-surface)]`).
- **`postcss.config.js`** — runs `tailwindcss` + `autoprefixer`.

**Adding a new accent:** (1) add `--color-<name>-rgb` channels to **both** the
`:root` and `[data-theme="light"]` blocks in `tokens.css`; (2) add a derived
`--color-<name>: rgb(var(--color-<name>-rgb))`; (3) add the alias to
`tailwind.config.js`. The styleguide at `/design` will pick it up once you add a
row to its `accents` array.

**Agent colors** are centralized in `src/lib/agent-colors.ts`
(`agentColorVar()`) — the one place that maps an agent's semantic colour key to
a token var. Consumed (in CSS contexts) by `ChatFloat`, `AgentsNav`, the `(app)/agents` page, and `timeline/utils.ts` (which re-exports `agentColorVar`).

---

## 7. Known gaps / follow-ups

- **Hardcoded accent hex elsewhere (~100 occurrences across ~18 files).** `ChatFloat`,
  `AgentsNav`, and the `(app)/agents` page were de-duped to `agent-colors.ts`;
  the rest live mostly in
  canvas / 3D / chart code (`mindscape/Mindscape3D.svelte`,
  `mindscape/phase-color.ts`, `cognitive-metrics/*`) where a resolved colour is
  genuinely required, plus several `(app)/*` pages. Migrate per-caller (audit
  the consumption context first — canvas needs a resolved string, not `var()`).
- **`.btn-primary` box-shadow** still hardcodes azure `rgba(91,159,232,…)` in
  `app.css`; could derive from `--color-accent-rgb`.
- **`--font-serif` aliases Geist** — decide whether a real display serif is
  wanted or drop the alias.

---

## 8. Porting to V1

When `reference/portal/` ports to `packages/portal/`, carry these **together**
or the UI ships unstyled:

```
src/lib/styles/tokens.css     # the source of truth
src/app.css                   # @tailwind layers + component classes + font @import
tailwind.config.js            # accent aliases → channel vars (+ typography, fonts)
postcss.config.js             # tailwindcss + autoprefixer
src/lib/stores/theme.ts       # [data-theme] store
src/lib/agent-colors.ts       # agent colour single-source
src/routes/design/+page.svelte# the living styleguide (keep it building)
```

Keep `/design` green through the port — it's the cheapest regression check that
the token pipeline survived.
