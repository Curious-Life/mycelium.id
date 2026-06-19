# App icons

The mark is a gold mushroom on a black Milky-Way starfield. Two products:

1. **Flat icon** — regenerate the rasters from the composite SVG on the Mac:
   ```sh
   cargo tauri icon ../assets/mushroom.svg   # writes icon.icns, icon.ico, *.png here
   ```
   Covers favicons, Windows/Linux, and the macOS pre-Tahoe fallback.

2. **Liquid Glass `.icon`** (macOS 26 Tahoe / iOS 26 — system glass + Dark/Clear/Tinted) —
   built once in Icon Composer from the three layer SVGs. See
   [`../../assets/icon-layers/README.md`](../../assets/icon-layers/README.md) for the layer build +
   how to wire `Mycelium.icon` into `tauri.conf.json`. A flat `.icns` can't tint; the `.icon` is the
   only thing that adapts to system tint.

To change the artwork, edit `scripts/gen-icon.mjs` and re-run `node scripts/gen-icon.mjs`, then redo
step 1 (and re-export the `.icon` if the layers changed).
