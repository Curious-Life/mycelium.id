# Ollama Auto-Download on Launch + Catalog Currency — Design

**Date:** 2026-06-05
**Author:** Claude (sweep-first-design)
**Status:** Design — awaiting go-ahead to implement.
**Builds on:** [LOCAL-MODEL-SETUP-DESIGN-2026-06-05.md](LOCAL-MODEL-SETUP-DESIGN-2026-06-05.md) (the v2 picker, already built).

Two coupled changes, requested after the v2 picker shipped:
- **Part A — Auto-download the Ollama runtime at launch** (reverses the earlier "guided install only" call). If Ollama isn't already present, fetch the official standalone binary into the app's data dir, verify it, and run `ollama serve` from there — no installer, no sudo, no system changes.
- **Part B — Catalog currency refresh.** The v2 catalog uses **gemma2 / qwen2.5**, which by 2026-06 are **two generations behind** (gemma3/gemma4, qwen3/qwen3.5/qwen3.6 now exist). Refresh to the current warm-companion leaders.

---

## 0. Headline

The v2 picker already has the right seam: `src/hardware/ollama-daemon.js` does lazy **adopt-or-spawn** with **absolute-path discovery**. Auto-download is one more rung *below* spawn: **adopt → spawn → (new) download-then-spawn**. We add a downloader and one candidate path; the daemon's existing single-flight + `stop()`-only-what-we-spawned logic carries over unchanged.

The safe distribution path is the **standalone tarball**, not the installer:
- `ollama-darwin.tgz` (~136 MB, **codesigned + notarized**, universal) — extract → `ollama` binary → `ollama serve`. No `.app`, no menu-bar agent, no Gatekeeper prompt.
- Linux `ollama-linux-{amd64,arm64}.tar.zst` (~1.3 GB — bundles GPU libs); Windows `.zip`.
- Every release publishes `sha256sum.txt`; Ollama is **MIT** (redistribution permitted). `install.sh` is rejected — it requires **root**, creates a system user, and installs a **systemd service** we wouldn't control.

Stored under `<MYCELIUM_DATA_DIR>/ollama/` (survives `.app` replacement), models under `<…>/ollama/models` via `OLLAMA_MODELS` (keeps the user's `~/.ollama` untouched). Verified against a **bundled pinned checksum manifest**, fail-closed.

---

## 1. Decisions (with rationale)

| Decision | Choice | Why |
|---|---|---|
| Distribution | **Standalone tarball**, not `install.sh`/`.dmg` | No sudo / no system service / app-private; macOS notarized; MIT redistribution OK |
| Where | `<MYCELIUM_DATA_DIR>/ollama/` + `OLLAMA_MODELS=<…>/ollama/models` | Survives app update; never pollutes `~/.ollama`; large model store on the durable disk |
| Build-time bundle vs runtime download | **Runtime download at launch** | User said "when it's launched"; keeps `.app` small (~136 MB–1.3 GB not shipped); cooperates with an existing user install |
| Trigger | **Lazy — on first Pull & use** (download happens inside `ensureUp()`) | User chose lazy over background-at-launch: nothing is fetched until they actually pick a model. (No launch hook needed; §2.3 dropped.) |
| Integrity | **Pinned SHA-256** in a bundled manifest; abort + delete on mismatch | Reuse `fetch-sidecars.sh` discipline; never exec an unverified binary (CLAUDE.md §2/§3) |
| Version | **Pin a known-good release** (e.g. v0.30.5) | Pinning is what makes the checksum meaningful; "latest" defeats it. Pin must be recent enough to run the catalog (gemma4 needs a current Ollama) |
| Adopt first | `findBinary` checks **system installs before** the data-dir copy | Never re-download if the user already has Ollama (Homebrew/.app) |
| Opt-out | Setting `MYCELIUM_AUTO_OLLAMA` (default **on**) | User wants auto; respect a user who'd rather not have us fetch a binary |

---

## 2. Part A — module shapes

### 2.1 `src/hardware/ollama-install.js` (NEW, ~120 LOC)

Pure-ish, fully injectable (fetch / fs / extract / checksum), so it's unit-testable without touching the network.

```
resolveAsset({ platform, arch }) → { url, asset, sha256 } | null
  // platform/arch → pinned GitHub release asset + its pinned sha256 (from a
  // bundled manifest). null for an unsupported platform.

installOllama({ dataDir, fetch, writeFile, mkdir, extract, sha256, onProgress }) → { ok, binPath?, reason? }
  1. asset = resolveAsset(...); if null → { ok:false, reason:'unsupported_platform' }
  2. download asset.url → <dataDir>/ollama/.dl/<asset>  (stream; onProgress(pct))
  3. got = sha256(file); if got !== asset.sha256 → delete; { ok:false, reason:'checksum_mismatch' }
  4. extract into <dataDir>/ollama/  (tar -xzf for .tgz; tar -xf for .tar.zst)
  5. chmod +x the ollama binary; return { ok:true, binPath }
```

- **Pinned manifest:** `scripts/ollama-checksums.txt` (same format as `sidecar-checksums.txt`), bundled into the app. Keyed by asset name. Fail-closed if a platform's checksum is absent (don't download what we can't verify).
- **Extraction:** `execFile('tar', ['-xzf', archive, '-C', dest])` for darwin `.tgz` (works everywhere); `execFile('tar', ['-xf', …])` for Linux `.tar.zst` (needs system `zstd` — caveat §6). No shell; fixed args.
- **No secrets, no PII**; logs only progress + outcome.

### 2.2 `src/hardware/ollama-daemon.js` (EXTEND, ~+25 LOC)

- `findOllamaBinary` candidate list gains `<dataDir>/ollama/ollama` (+ `/bin/ollama`) — **after** the system paths (adopt an existing install first).
- New `provision()` = single-flight wrapper over `installOllama(...)` (reuse the existing in-flight guard so launch-trigger + a Pull&use click can't double-download).
- `ensureUp()` gains a rung:
  ```
  if (await isUp()) return adopted
  let bin = findBinary()
  if (!bin && autoInstall) { const r = await provision(); if (!r.ok) return {ok:false, reason:r.reason}; bin = r.binPath }
  if (!bin) return { ok:false, reason:'not_installed' }
  spawn(bin, ['serve'], { env: { …allowlist, OLLAMA_MODELS: <dataDir>/ollama/models } })  // poll up
  ```
- `stop()` unchanged (only kills `spawnedByUs`).

### 2.3 Launch trigger — `src/server-rest.js` (~+4 LOC)

Mirror the embed-supervisor boot: after constructing `hwOllamaDaemon`, fire a background `provisionAtLaunch()` (fail-soft, gated by `MYCELIUM_AUTO_OLLAMA` and skipped when a system Ollama is already found) so the runtime is ready before the user opens the picker. The Node server is the right home (the canonical "lazy fetch + supervise a big dependency" precedent is `src/embed/supervisor.js`, Node-side; the Tauri `.setup()` already delegates daemon lifecycle to Node).

### 2.4 Routes + UI

- `GET /hardware/recommend` already returns `ollamaInstalled`; add `ollamaDownloading` / progress surfaced via the existing health channel (or a small `GET /hardware/ollama-status`).
- Pull SSE already auto-starts; with auto-install, a missing binary now streams `status: 'downloading Ollama…'` + pct instead of erroring `not_installed`. The UI's existing `pulling[...]` progress row renders it; the "Install Ollama" link becomes the fallback only when `autoInstall` is off or the platform is unsupported.

---

## 3. Part B — catalog currency refresh

**The fix:** gemma2→gemma3/gemma4, qwen2.5→qwen3, drop/replace stale entries. Gemma remains the **warm/high-EQ leader** (community consensus; EQ-Bench numbers were not machine-verifiable this sweep). Proposed lineup (Q4 sizes from research; `quality` = companion-suitability per v2 §4.1):

| name | ~GB | quality | bestFor | notes |
|---|---|---|---|---|
| gemma3:1b | 0.8 | 30 | Fast & light | |
| gemma3:4b | 3.3 | 58 | Warm, small | warm even small |
| qwen3:4b | 2.5 | 46 | Everyday, analytical | thinking-off for chat |
| qwen3:8b | 5.2 | 64 | Balanced | |
| **gemma3:12b** | 8.1 | **86** | **Warm companion** | **16GB-Mac sweet spot** (replaces gemma2:9b) |
| mistral-nemo:12b | 7 | 80 | Warm & creative | still a community favourite |
| qwen3:14b | 9.3 | 70 | Analytical thinking | |
| mistral-small3.2:24b | 15 | 76 | Balanced | |
| **gemma3:27b** | 17 | **92** | **Warm, deep companion** | 32GB pick |
| qwen3:32b | 20 | 80 | Analytical (large) | |
| llama3.3:70b | 43 | 90 | Reflective coaching | 64GB+ |
| phi4:14b | 9 | 50 | Technical / STEM | kept as the honest "cold but capable" option |

**Newest-generation, pending verification (the user asked about these):** `gemma4:12b` / `gemma4:26b|31b` and `qwen3.5` / `qwen3.6` came back **single-source** in the sweep. **Load-bearing:** the catalog is the *pull allowlist* — every tag must be confirmed to exist on `ollama.com/library/<model>/tags` before it ships. Plan: at implementation, verify each tag via the Ollama library/registry; include gemma4/qwen3.6 **only if** confirmed, else ship gemma3/qwen3 (multiply-confirmed, out since 2025) and add the newer ones in a follow-up. deepseek-r1 / reasoning models stay **excluded** (visible `<think>` traces hurt conversational companionship).

**Version-pin coupling:** the pinned Ollama (Part A) must be new enough to run the catalog's newest models (gemma4 needs a recent Ollama). Pick the pin and the catalog together.

---

## 4. Threat model (auto-download adds real surface)

The user reversed "no auto-download," so the mitigations are the safeguard:

| Surface | Mitigation |
|---|---|
| Fetching a binary we then execute | **Pinned URL** (specific release) over **HTTPS** + **pinned SHA-256** from a **bundled** manifest; mismatch → delete + abort, never exec (CLAUDE.md §3 fail-closed) |
| Supply-chain (compromised release) | Pin a *known* checksum, not "latest"; macOS asset additionally notarized; manifest lives in the signed `.app`, not fetched |
| Path / command injection | Fixed args (`['serve']`, `tar -xzf`), no shell, no request input in any arg; binary path from app-private dir |
| Privilege | **No sudo, no system service, no PATH change** — app-private dir only; the rejected `install.sh` is exactly what we avoid |
| Secrets | Spawn env allowlist (PATH/HOME/OLLAMA_*); **never** the master key; no plaintext/PII in logs |
| Disk/bandwidth (1.3 GB on Linux) | Surface a progress UI; opt-out setting; skip entirely if a system Ollama is adopted |
| Stale pinned runtime can't run new models | Document the pin↔catalog coupling; bump both together |

Accepted/deferred: Linux auto-extract needs system `zstd` (else fall back to guided install — fail-soft); Windows path is designed but macOS is the V1 priority.

---

## 5. Test strategy (extend the existing gates)

- **`verify:hardware` — new H8 (ollama-install):** injected fetch/fs/extract/sha256 →
  - resolveAsset maps darwin/linux/win to the right pinned asset+sha; unsupported → null.
  - happy path: download → checksum match → extract → chmod → `{ok:true, binPath}`.
  - **checksum mismatch → `{ok:false, checksum_mismatch}` and the partial file is deleted, extract NOT called** (the security-critical assertion).
  - progress callback fires.
- **`verify:hardware` — extend H7:** `ensureUp` with `autoInstall:true` + `findBinary→null` once → calls `provision()` (injected) → then spawns; single-flight covers launch+click.
- **`verify:hardware-routes` — extend HR8/new HR9:** pull with auto-install on streams `downloading Ollama…` then proceeds; platform-unsupported → guided-install fallback payload.
- **No network in tests** (all injected). Manual smoke on a real machine without Ollama: launch → background download → picker shows ready; checksum-tamper a local manifest → abort.

## 6. Implementation order

1. `scripts/ollama-checksums.txt` (pinned manifest) + pick the Ollama version; record asset SHAs from the release `sha256sum.txt`.
2. `src/hardware/ollama-install.js` + H8. Smoke `verify:hardware`.
3. Extend `ollama-daemon.js` (candidate path, `provision()`, `ensureUp` rung) + H7 extension.
4. Launch trigger in `server-rest.js`; routes/status + UI progress; HR extension.
5. **Part B catalog refresh** — verify every tag against `ollama.com/library`, update `catalog.js` + re-pin H4/HR2 expectations.
6. Full `verify:hardware` + `verify:hardware-routes` GO; portal build; living-docs + handoff.

---

## 7. Verification table

| # | Load-bearing assumption | Status | Evidence |
|---|---|---|---|
| 1 | Ollama ships a no-installer standalone tarball, runnable via `ollama serve` | ✅ | research: `ollama-darwin.tgz`, GH releases; macOS notarized |
| 2 | Releases publish per-asset SHA-256 (`sha256sum.txt`) | ✅ | v0.30.5 `sha256sum.txt` (4 hashes quoted in handoff research) |
| 3 | Ollama is MIT → redistribution/bundling permitted | ✅ | repo LICENSE (research) |
| 4 | Repo already has pinned-SHA download-or-abort to mirror | ✅ | [fetch-sidecars.sh:22-40](../scripts/fetch-sidecars.sh#L22); [sidecar-checksums.txt](../scripts/sidecar-checksums.txt) (read myself) |
| 5 | Durable data dir resolves cross-OS; survives `.app` replace | ✅ | [src/paths.js:27-42](../src/paths.js#L27); main.rs sets `MYCELIUM_DATA_DIR` ([main.rs:249](../src-tauri/src/main.rs#L249)) |
| 6 | Daemon already does adopt-or-spawn + single-flight + absolute discovery to extend | ✅ | [src/hardware/ollama-daemon.js](../src/hardware/ollama-daemon.js) (just built) |
| 7 | Node-side lazy-provision precedent exists (embed supervisor) | ✅ | [src/embed/supervisor.js](../src/embed/supervisor.js); wired [server-rest.js:214](../src/server-rest.js#L214) |
| 8 | `tar`/`gzip` present for `.tgz`; Linux `.tar.zst` needs `zstd` | ✅ | `which tar gzip zstd` (read myself; zstd only via Homebrew here) |
| 9 | Catalog gemma2/qwen2.5 are stale; gemma3/qwen3 are current | ✅ | ollama.com/library (research) |
| 10 | every catalog tag is a real pullable Ollama tag | ✅ | `npm run verify:catalog-tags` — all 16 resolve on the registry manifest API (gemma4:12b/26b/31b, qwen3.6:27b included; gemma4:e4b & qwen3.5 deliberately NOT shipped) |
| 11 | Pinned Ollama version must run the catalog's newest models | ⚠️ | design constraint — choose pin + catalog together (§3) |

## 8. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Pinned checksum drifts when we bump Ollama | Med | Med | Bump version + manifest together; CI/TOFU print like fetch-sidecars |
| Linux box lacks `zstd` → extract fails | Med | Low | Fail-soft to guided install; macOS is V1 priority |
| Adding unverified tags to the pull allowlist | Med | Med | Tag-verification gate (#10) before catalog lands |
| 1.3 GB Linux download surprises user | Low | Med | Progress UI + opt-out + adopt-existing-first |
| Auto-download seen as overreach | Low | Low | Default-on but opt-out setting; only when no system Ollama |
