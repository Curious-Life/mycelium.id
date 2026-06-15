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

## The `.icon` is already built — `src-tauri/icons/Mycelium.icon`

Built from these layers and **verified in Icon Composer across Default, Dark, and Mono/Tinted**
(2026-06-15). Structure (`icon.json`):

- `fill` = the dark sky (a near-black-blue gradient). This is the layer the system **replaces** under
  Tinted/Clear — which is why the sky is the fill, not a layer.
- group `stars` (glass) — the Milky-Way starfield; sparkles as bright points under tint.
- group `mushroom` (glass, neutral shadow) — the gold silhouette; reads as one clean tinted shape.

To edit: `open -a "Icon Composer" src-tauri/icons/Mycelium.icon`, change, Save. To rebuild the layer
PNGs from the SVGs first: `cargo tauri icon assets/icon-layers/2-stars.svg -o /tmp/s -p 1024` (and
the mushroom), then drop the `1024x1024.png`s into `Mycelium.icon/Assets/`.

### What ships in the app — baked glass `.icns`

The app uses the glass **look** in every build: `scripts/gen-glass-icns.sh` renders the `.icon`'s
macOS *Default* appearance (which already carries the glass material — specular, depth, edge light)
to a PNG via Icon Composer's `ictool`, pads it to the standard macOS margin, and runs
`cargo tauri icon` to regenerate `src-tauri/icons/*` (`.icns` + `.ico` + PNGs + Windows `Square*`).
Those are what `cargo tauri build` already bundles into the `.app` and `.dmg` — so **every build and
every new user gets the glass icon with no extra step**. Re-run the script whenever the `.icon` (or
`assets/mushroom.svg`) changes.

```sh
scripts/gen-glass-icns.sh      # needs Xcode (for ictool) + cargo tauri
```

### Why not the *dynamic* system-tint (the honest limitation)

macOS 26's **live** glass/tint (the icon re-coloring with system appearance settings) needs a
compiled **`Assets.car`** with the AppIcon + `CFBundleIconName`. Producing that car from a macOS
`.icon` requires Xcode's asset-catalog build step — and on Xcode 26.5 here, `actool` does **not**
compile a macOS `.icon` into a car (verified every way: standalone `actool`, a Swift package, and a
full `xcodebuild` app target — even Apple's own sample `.icon` yields an empty plist + no car). Until
that tooling works for macOS `.icon` files, the baked-glass `.icns` above is the shipping path: it
looks like the Icon Composer design but won't re-tint live. `Mycelium.icon` stays the source of truth,
so flipping to the dynamic car later is just a re-render away.

## Regenerating the flat icon + favicons

The composite and these layers are emitted by the generator script (kept out of the repo, run ad-hoc):
`node scripts/gen-icon.mjs` — seeded starfield, so output is reproducible. After regenerating,
rebuild the rasters on the Mac:

```sh
cargo tauri icon ../assets/mushroom.svg   # writes src-tauri/icons/{icon.icns,*.png,icon.ico}
```

## Regenerating the flat icon + favicons

The composite and these layers are emitted by the generator script (kept out of the repo, run ad-hoc):
`node scripts/gen-icon.mjs` — seeded starfield, so output is reproducible. After regenerating,
rebuild the rasters on the Mac:

```sh
cargo tauri icon ../assets/mushroom.svg   # writes src-tauri/icons/{icon.icns,*.png,icon.ico}
```
