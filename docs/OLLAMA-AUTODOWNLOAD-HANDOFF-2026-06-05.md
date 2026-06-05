# Ollama Auto-Download + Catalog Currency — Handoff (2026-06-05)

## TL;DR

Two coupled changes on top of the v2 picker:
1. **Ollama auto-downloads on first Pull & use** (lazy). The daemon ladder is now **adopt → spawn → download-then-spawn**: if no Ollama is found, it fetches the official **standalone tarball** (pinned **v0.30.5**, SHA-256-verified) into `<data_dir>/ollama/`, extracts it, and runs `ollama serve` with models under `<data_dir>/ollama/models`. No installer, no sudo, no system changes. Opt out with `MYCELIUM_AUTO_OLLAMA=0`.
2. **Catalog refreshed to current-gen models** — gemma2/qwen2.5 (two gens stale) → **gemma3 / gemma4 / qwen3 / qwen3.6 / mistral-small3.2 / mistral-nemo / llama3.3 / phi4**. Every tag verified live on `ollama.com/library` (it's the pull allowlist). Companion-quality ranking unchanged in spirit (gemma leads).

Design + research (PewDiePie odysseus, EQ-Bench, Ollama distribution mechanics): [OLLAMA-AUTODOWNLOAD-DESIGN-2026-06-05.md](OLLAMA-AUTODOWNLOAD-DESIGN-2026-06-05.md).

## Verified facts (this session, by me)

- Latest Ollama = **v0.30.5** (Jun 4 2026); assets + **sha256sum.txt** fetched. Pinned hashes: darwin `1defa6bf…3de41b`, linux-amd64 `36d104f9…568b6`, linux-arm64 `12da8c15…f9ca89`, win-amd64 `1aaed668…b52623`. The pinned darwin URL resolves to exactly **142,922,751 bytes** (HEAD check) and the release notes cite a gemma4:12b fix → the pin runs the catalog.
- Tags confirmed real on ollama.com/library: gemma3 (1b/4b/12b/27b), **gemma4** (12b/26b-a4b/31b — real, not a misconception), qwen3 (4b/8b/14b/32b), **qwen3.6** (27b/35b-a3b). Ollama is **MIT** (redistribution OK); macOS build notarized.

## Files

| File | Change |
|---|---|
| `src/hardware/ollama-install.js` **(new)** | `resolveAsset` (platform→pinned asset+URL+sha), `installOllama` (download→**verify sha**→extract→chmod, fail-closed), embedded pinned `CHECKSUMS` + `OLLAMA_VERSION='v0.30.5'`, `extractedBinPath` |
| `src/hardware/ollama-daemon.js` | data-dir binary candidate (after system installs); `provision()` single-flight; `ensureUp(onProgress)` download rung; `OLLAMA_MODELS` env; `autoInstall` flag |
| `src/portal-hardware.js` | pull SSE streams `downloading Ollama…` + pct via `ensureUp(onProgress)`; surfaces new reasons |
| `src/server-rest.js` | daemon gets `dataDir: dataDir()` + `autoInstall: MYCELIUM_AUTO_OLLAMA !== '0'` |
| `src/hardware/catalog.js` | **16 current-gen models**, companion `quality` + `bestFor`; gemma4:26b carries `kvParamsB` (MoE a4b) |
| `portal-app/.../IntelligenceSection.svelte` | new error strings (checksum_mismatch/download_failed/unsupported_platform); "downloaded automatically" messaging; Pull&use enabled even when not installed |
| `scripts/verify-hardware.mjs` | re-pinned H4 (N=16, new top picks); **+H8** (installer: resolveAsset, happy path, **checksum-mismatch-aborts-before-extract**, unsupported); **+H9** (daemon auto-install rung: download→spawn, fail, opt-out) |
| `scripts/verify-hardware-routes.mjs` | HR2 (N=16, current tags); **+HR9** (pull auto-downloads + streams progress); pulled tags → catalog members |

## Verification ledger

- [✓] `verify:hardware` GO (H1–H9; incl. H8c checksum-mismatch-aborts-before-extract — the security assertion)
- [✓] `verify:hardware-routes` GO (HR1–HR9)
- [✓] `verify:rest` GO; portal-app build clean
- [✓] Live URL check: pinned darwin asset resolves to 142,922,751 B (matches sha256sum.txt size)
- [—] **Not done (would pull 136 MB+):** a real end-to-end download+extract+serve. Logic is unit-verified (H8/H9) with injected fetch/fs/extract. To smoke for real: on a box without Ollama, click Pull & use → watch `<data_dir>/ollama/` populate and `:11434` come up. Linux needs system `zstd` for `.tar.zst` (fail-soft otherwise).

## Companion ranking (new catalog)

- **16GB Mac (~10.7GB):** gemma4:12b → gemma3:12b → mistral-nemo:12b → qwen3:8b
- **8GB:** qwen3:8b → gemma3:4b (warm 12B models don't fit 8GB)
- **32GB:** gemma3:27b / gemma4:26b lead; **64GB+:** llama3.3:70b / gemma4:31b
- phi4 kept as the honest "cold but capable / STEM" option; deepseek-r1 excluded (think-traces).

## Security posture (the new download+exec surface)

Pinned version + **pinned per-asset SHA-256** embedded in the signed app (never fetched); HTTPS pinned URL; mismatch → delete + abort, **never extract/exec** (H8c proves extract isn't called on mismatch); fixed `tar`/`['serve']` args, no shell; app-private dir, no sudo/PATH/systemd; env allowlist (no master key); adopt existing install first (never re-download or kill the user's daemon); opt-out env.

## Deferred

- Real end-to-end download smoke (needs a clean box / bandwidth).
- Windows `.zip` extraction (resolveAsset returns it but `installOllama` rejects `kind:'zip'` → `unsupported_platform`); Linux zstd dependency.
- Bumping the pin: update `OLLAMA_VERSION` + `CHECKSUMS` in `ollama-install.js` from the new release's `sha256sum.txt`.
- gemma4 e-series / MoE param accounting left out of the catalog (murky paramsB → unreliable fit math); dense variants used.

## Pickup

Branch `docs/build-mac-fetch-sidecars`, uncommitted. New files: `src/hardware/ollama-install.js`, the three design/handoff docs. Re-run both hardware gates after any catalog/checksum change (H4/HR2 pin exact picks; H8a pins asset names).
