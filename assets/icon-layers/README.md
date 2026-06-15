# Mycelium app icon — sources & the Apple Liquid Glass build

The mark: a **gold mushroom** on a **black starfield** (Milky-Way scatter).
Master composite lives in [`../mushroom.svg`](../mushroom.svg) and is mirrored to
`portal/favicon.svg` + `portal-app/static/favicon.svg`. All three are generated, not hand-edited —
regenerate by re-running the generator (see "Regenerating" below).

There are **two icon products**, because they have different requirements:

| Product | Source | Covers |
|---|---|---|
| Flat icon (`.icns`, `.ico`, PNGs, favicons) | `../mushroom.svg` (single composite, squircle baked in) | Web favicon, Windows/Linux, and the macOS *fallback* before Tahoe |
| **Liquid Glass `.icon`** (iOS 26 / macOS 26 Tahoe) | the **three layers in this folder** | System glass material + **Dark / Clear / Tinted** appearances |

A flat raster (`.icns`/PNG) **cannot** participate in system tinting or the glass material — that is
strictly an Icon Composer `.icon` feature. So the gold-on-black look ships everywhere via the flat
icon, and the *adaptive* glass/tint behaviour ships via the `.icon` built from the layers here.

## The three layers

Full-bleed 1024×1024, **no squircle mask** (the system masks and supplies the glass):

1. `1-background.svg` — black radial sky. In **Tinted/Clear** modes the system replaces/recolors this; keep it dark and plain.
2. `2-stars.svg` — the Milky-Way starfield + the few bright glow stars (white / faint blue / faint gold).
3. `3-mushroom.svg` — the gold mushroom (the subject).

### Why it tints well
Apple's Tinted and Clear appearances throw away your colors and recolor each layer by its
**luminance** (bright pixels → strong tint, dark → recessive). Our layering is built for that:
- mushroom = a single solid silhouette → reads as one clean mid/high-luminance shape under any tint;
- stars = small high-luminance points → become tasteful sparkle in the tint color;
- background = dark → stays recessive so the subject pops.
Keep the mushroom as one flat fill (the gradient is luminance-monotonic, so it survives tinting). Do
not add dark detailing *inside* the mushroom or it will punch holes in the tinted silhouette.

## Building the `.icon` (Icon Composer — Mac, one-time, GUI)

Icon Composer ships with Xcode 26+. It cannot be driven headlessly, so this is a manual step:

1. Open **Icon Composer** → New.
2. Add three layers, bottom → top: `1-background.svg`, `2-stars.svg`, `3-mushroom.svg`.
   (Import SVG directly; if it insists on raster, export each layer to 1024 PNG first.)
3. Group **stars + mushroom** as the foreground; leave background as the bottom layer so the system
   can swap it in Tinted/Clear.
4. Check all four appearances in the preview: **Default, Dark, Clear, Tinted**. The mushroom should
   stay a clean silhouette and the stars should sparkle in every mode. Nudge layer opacity/“specular”
   only if a mode looks muddy — don't re-color (the system owns color in Tinted/Clear).
5. Export `Mycelium.icon` into `src-tauri/icons/`.

Then wire it into the bundle: add `"icons/Mycelium.icon"` to the `bundle.icon` array in
`src-tauri/tauri.conf.json` (alongside the PNG/`.icns` fallbacks — older macOS ignores it and uses
`.icns`). Tauri passes `.icon` through to the app bundle.

## Regenerating the flat icon + favicons

The composite and these layers are emitted by the generator script (kept out of the repo, run ad-hoc):
`node scripts/gen-icon.mjs` — seeded starfield, so output is reproducible. After regenerating,
rebuild the rasters on the Mac:

```sh
cargo tauri icon ../assets/mushroom.svg   # writes src-tauri/icons/{icon.icns,*.png,icon.ico}
```
