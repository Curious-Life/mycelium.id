// src/tts/qwen3-tts-model.js — manages the local Qwen3-TTS voice model: the
// `mlx-audio` Python package (the NEW MLX runtime) + an MLX-converted model
// snapshot from Hugging Face (mlx-community/Qwen3-TTS-12Hz-*). Replaces Kokoro,
// which the operator judged "quite bad"; Qwen3-TTS WON a live listening test on
// the operator's own hardware (2026-07-15) — see
// the agent character-and-voice design §0 (V1) + §2 (evidence).
//
// The portal "Download model" button triggers startDownload(); the UI polls
// getModelState(). Files land under <dataDir>/models/qwen3-tts/<variant>/ and
// are passed to qwen3-tts-service.py via QWEN_TTS_MODEL_DIR.
//
// Structural precedent (verbatim): src/tts/kokoro-model.js —
//   • Single in-flight provision (module-level state), idempotent: re-running
//     when already ready is a no-op.
//   • Fail-soft: errors surface in state.error, NEVER throw the caller.
//   • "ready" requires BOTH the model files AND an importable runtime, so the UI
//     never falsely shows ready when the pip package didn't land.
//
// ⚠️ RUNTIME NOTE — MLX is Apple-Silicon-only (design §4.2 / §6). On Intel Macs
//    `import mlx_audio` fails ⇒ state stays 'needs-runtime'/'error', honestly.
//    That is the accepted cost of removing Kokoro (design V2).
//
// ⚠️ SYNTHESIS SEAM — this module manages the MODEL (download + health). The
//    actual voice RENDER (pipeline/qwen3-tts-service.py) needs a FROZEN reference
//    sample to hold identity: a described voice is NOT reproducible (design §2.2,
//    the keystone finding — same description renders "different people"). That
//    sample is authored on the per-agent character page (design §5), a SEPARATE
//    unit not built here. Until it exists the service reports its render path as
//    pending — honestly, never a fake 'ok'. This module is complete and verified;
//    the render is the marked seam. Said plainly in the PR.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync, readdirSync, statfsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../paths.js';
import { venvPythonPath, bundledPythonPath, systemPython } from '../system/platform-env.js';
import { voiceRecommendedModel } from '../inference/role-models.js';
import { createVoiceSampleStore } from './voice-sample-store.js';

// ── The variant catalog (design §2.1 — timed on the operator's base-M1 box) ──
// Both are MLX-converted (mlx-community). The 0.6B is NOT faster than the 1.7B —
// the shared speech codec is the bottleneck, not the LM (design §2.1 / Q6), so
// there is no "just use the small one" escape hatch. Sizes are on-disk GB→MB.
export const QWEN_VARIANTS = Object.freeze([
  Object.freeze({
    id: 'Qwen3-TTS-12Hz-1.7B-Base-8bit',
    repo: 'mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit',
    label: 'Qwen3-TTS 1.7B (8-bit)',
    description: 'Recommended — won the live listening test (2026-07-15). ~1.25× realtime on a base M1.',
    sizeMB: 2900,
    rtf: 1.25,
    recommended: true,
  }),
  Object.freeze({
    id: 'Qwen3-TTS-12Hz-0.6B-Base-bf16',
    repo: 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16',
    label: 'Qwen3-TTS 0.6B (bf16)',
    description: 'Smaller download, but NOT faster (the codec is the bottleneck) — ~1.4× realtime.',
    sizeMB: 2400,
    rtf: 1.4,
    recommended: false,
  }),
]);

// SINGLE SOURCE OF TRUTH: the recommended/default variant is pinned in
// role-models.js (ROLE_RECOMMENDATIONS.voice) and imported here so the
// "Recommended for voice" badge and the actual default can never drift
// (verify:tts-voice asserts DEFAULT_VOICE_MODEL === voiceRecommendedModel()).
export const DEFAULT_VOICE_MODEL = voiceRecommendedModel();

/** The variant offered/downloaded when the user doesn't pick otherwise. */
export function defaultVariant() {
  return QWEN_VARIANTS.find((v) => v.id === DEFAULT_VOICE_MODEL) || QWEN_VARIANTS[0];
}
/** Look up a variant by id, falling back to the default. */
export function variantById(id) {
  return QWEN_VARIANTS.find((v) => v.id === id) || defaultVariant();
}
/** The catalog the Voice UI renders (pure — NO I/O, NO network). */
export function qwenVoiceCatalog() {
  return QWEN_VARIANTS.map((v) => ({ id: v.id, label: v.label, description: v.description, sizeMB: v.sizeMB, recommended: v.recommended }));
}

// ── The voice-sample truth (design §2.2 — the keystone) ──────────────────────
// Identity is held ONLY by a FROZEN reference sample authored on the per-agent
// character page (design §5). NO render can hold identity without one: the
// service 501s every /tts, so every surface reports the voice PENDING, never
// "active", until a sample exists. This is the single source the portal reads so
// the top line cannot over-promise while every render fails (adversarial review
// of #209, MED-1). Now that the character page ships, this reads the stored
// sample's existence per agent (was hardcoded false until V1u). Defaults to
// 'personal-agent'.
//
// ⚠️ It uses the SAME predicate the render uses — a successful DECRYPT, not mere
// file existence (voice-panel honesty audit, 2026-07-18). A corrupt / re-keyed /
// sub-envelope .mvs would pass a size check but 501 at render; gating the top-line
// on decryptability keeps "voice active" from ever out-promising the render.
export async function hasVoiceSample(agentId = 'personal-agent', opts = {}) {
  try { return (await createVoiceSampleStore(opts).getSample(agentId)) !== null; }
  catch { return false; }
}

export function qwenPaths(opts = {}, variantId = DEFAULT_VOICE_MODEL) {
  const v = variantById(variantId);
  const root = process.env.QWEN_TTS_MODEL_ROOT || join(dataDir(opts), 'models', 'qwen3-tts');
  const dir = join(root, v.id);
  return { root, dir, variant: v };
}

// Same python resolution as the other local services (kokoro-model.js verbatim):
// main.rs sets MYCELIUM_PYTHON to the bundled interpreter; we ALSO resolve it
// explicitly so pip-install + the service + the import-check always agree on ONE
// python. Exported so qwen3-tts-supervisor.js uses the identical resolution.
export function resolveQwenPython({ home = process.cwd() } = {}) {
  if (process.env.MYCELIUM_PYTHON) return process.env.MYCELIUM_PYTHON;
  const bundled = bundledPythonPath(home);
  if (existsSync(bundled)) return bundled;
  const venv = venvPythonPath(home);
  if (existsSync(venv)) return venv;
  return systemPython();
}
const resolvePython = resolveQwenPython;

// True iff `import mlx_audio` succeeds in the given python — the REAL readiness
// signal (files on disk ≠ an importable MLX runtime; MLX is Apple-Silicon-only).
function pkgImportable(python) {
  return new Promise((resolve) => {
    let p; try { p = spawn(python, ['-c', 'import mlx_audio'], { stdio: 'ignore' }); }
    catch { return resolve(false); }
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}
let _pkgInstalled = null;   // null=unknown · true · false
let _pkgChecking = false;
// TEST SEAM (verify:tts-voice only) — inject/reset the import probe so gates can
// pin the 'ready' and 'needs-runtime' states deterministically (the real probe
// depends on whether THIS box has mlx_audio). Resets the cache so the injected
// answer takes effect.
let _pkgProbe = pkgImportable;
export function __setPkgProbe(fn) { _pkgProbe = fn || pkgImportable; _pkgInstalled = null; _pkgChecking = false; }
async function checkPkg(opts = {}) {
  if (_pkgChecking) return _pkgInstalled;
  _pkgChecking = true;
  try { _pkgInstalled = await _pkgProbe(resolvePython(opts)); } catch { _pkgInstalled = false; } finally { _pkgChecking = false; }
  return _pkgInstalled;
}

// A snapshot is "present" when its dir holds a config.json + at least one weight
// shard (*.safetensors) — the same "files ≠ runtime" guard Kokoro uses.
function snapshotPresent(dir) {
  try {
    if (!existsSync(join(dir, 'config.json'))) return false;
    return readdirSync(dir).some((f) => f.endsWith('.safetensors') || f.endsWith('.npz') || f.endsWith('.gguf'));
  } catch { return false; }
}
// Recursive: huggingface_hub streams the in-flight shard into a hidden
// <dir>/.cache/huggingface/download/ staging area and only moves it to the top
// level once COMPLETE — a top-level-only scan reads ~0 for the whole multi-GB
// download, pinning the progress bar at its 5% floor until the final snap.
// Symlinks are skipped (their targets live in the global HF cache, outside dir).
function dirBytes(dir, depth = 0) {
  let total = 0;
  try {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      try {
        const st = lstatSync(p);
        if (st.isDirectory()) { if (depth < 6) total += dirBytes(p, depth + 1); }
        else if (st.isFile()) total += st.size;
      } catch { /* */ }
    }
  } catch { /* */ }
  return total;
}
export function __dirBytes(dir) { return dirBytes(dir); }  // gate seam (verify:tts-voice)

// ── The provisioner seam (design §4.2 / eval §3.4: `mlx-audio`) ──────────────
// pip install mlx-audio, then snapshot_download the chosen MLX variant from HF.
// Exposed via __setProvisioner ONLY so verify:tts-voice can prove consent (zero
// invocations until the user picks) and fail-soft (a rejection surfaces in
// state.error, never throws) WITHOUT a multi-GB real download. The default is the
// real runtime; production callers never touch the seam.
function pipInstall(python) {
  return new Promise((resolve) => {
    const child = spawn(python, ['-m', 'pip', 'install', '--disable-pip-version-check', 'mlx-audio'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr?.on('data', (d) => { err += d.toString().slice(0, 500); });
    child.on('error', () => resolve({ ok: false, err: 'python/pip not found' }));
    child.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, err: err.slice(-300) || `pip exit ${code}` }));
  });
}
function snapshotDownload(python, repo, dir) {
  return new Promise((resolve) => {
    // HF_HUB_OFFLINE=0: the bundled embedder pins 1 for its offline model; a
    // user-initiated download must override it (mirrors the whisper supervisor).
    const env = { ...process.env, HF_HUB_OFFLINE: '0', HF_HUB_ENABLE_HF_TRANSFER: '0' };
    const code = `import sys\nfrom huggingface_hub import snapshot_download\nsnapshot_download(repo_id=sys.argv[1], local_dir=sys.argv[2])\nprint('SNAPSHOT_OK', flush=True)`;
    let out = '', err = '';
    const child = spawn(python, ['-c', code, repo, dir], { stdio: ['ignore', 'pipe', 'pipe'], env });
    child.stdout?.on('data', (d) => { out += d.toString().slice(-200); });
    child.stderr?.on('data', (d) => { err += d.toString().slice(-500); });
    child.on('error', () => resolve({ ok: false, err: 'python/huggingface_hub not found' }));
    child.on('close', (c) => resolve(c === 0 && out.includes('SNAPSHOT_OK') ? { ok: true } : { ok: false, err: err.slice(-300) || `snapshot exit ${c}` }));
  });
}

// The default provisioner: pip install mlx-audio, verify the import, then fetch
// the snapshot. Fail-soft is the CALLER's job (startDownload) — this throws on
// failure so the single-flight wrapper records it in state.error.
async function defaultProvisioner({ python, variant, dir, onProgress }) {
  let pip = await pipInstall(python);
  if (!pip.ok) throw new Error(`mlx-audio install failed: ${pip.err}`);
  // A clean pip exit is NOT proof of an importable runtime (relocatable pythons,
  // and MLX is Apple-Silicon-only). Verify; retry once. Kokoro precedent.
  _pkgInstalled = await _pkgProbe(python);
  if (!_pkgInstalled) { pip = await pipInstall(python); _pkgInstalled = await _pkgProbe(python); }
  if (!_pkgInstalled) throw new Error(`mlx-audio installed but not importable (Apple Silicon required; python: ${python})`);
  onProgress?.(5);
  const snap = await snapshotDownload(python, variant.repo, dir);
  if (!snap.ok) throw new Error(`model download failed: ${snap.err}`);
  onProgress?.(100);
}
let _provisioner = defaultProvisioner;
/** TEST SEAM (verify:tts-voice only) — inject/reset the provisioner. */
export function __setProvisioner(fn) { _provisioner = fn || defaultProvisioner; }

// ── Disk preflight (adversarial review of #209, MED-2) ───────────────────────
// A 2.9GB snapshot on a box the design itself describes at ~1.5GB free (§4.1) —
// and Qwen staging "filled the disk to 0 twice" (stage-hf-models.sh). So the
// download REFUSES to start unless the variant fits with a margin; a too-tight
// disk surfaces state.error with an actionable reason, and the provisioner is
// NEVER invoked. Seam-injectable so the gate can pin both sides without filling
// a real disk.
const DISK_MARGIN_BYTES = 1e9;   // headroom the vault itself needs to keep breathing
function defaultFreeBytes(dir) {
  try { const s = statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
}
let _freeBytes = defaultFreeBytes;
/** TEST SEAM (verify:tts-voice only) — inject/reset the free-space probe. */
export function __setFreeBytes(fn) { _freeBytes = fn || defaultFreeBytes; }

// module-level provision state (one machine, one model at a time)
let _state = { phase: 'idle', progress: 0, error: null, variant: DEFAULT_VOICE_MODEL };
let _progressTimer = null;

export function getModelState(opts = {}) {
  const variantId = _state.variant || DEFAULT_VOICE_MODEL;
  const { dir, variant } = qwenPaths(opts, variantId);
  const files = snapshotPresent(dir);
  // Files present but runtime not yet verified → kick a background import check
  // (cached). "ready" requires BOTH files AND an importable mlx_audio.
  if (files && _pkgInstalled === null && !_pkgChecking) checkPkg(opts);
  let phase;
  if (_state.phase === 'installing' || _state.phase === 'downloading') phase = _state.phase;
  else if (files && _pkgInstalled === true) phase = 'ready';
  else if (files && _pkgInstalled === false) phase = 'needs-runtime'; // files ok, MLX runtime missing/unsupported
  else if (_state.error) phase = 'error';
  else if (files) phase = 'checking';                                  // verifying import (brief)
  else phase = 'absent';
  return {
    phase, progress: _state.progress, error: _state.error,
    files, pkg: _pkgInstalled,
    variant: variant.id, model: variant.id, sizeMB: variant.sizeMB, rtf: variant.rtf,
  };
}

/**
 * Start (or resume) provisioning the chosen variant: pip install mlx-audio, then
 * snapshot_download the MLX model. Idempotent + single-flight. Returns
 * immediately; poll getModelState() for progress. FAIL-SOFT: any error is caught
 * and surfaced in state.error — this NEVER throws the caller.
 */
export async function startDownload(opts = {}) {
  if (_state.phase === 'installing' || _state.phase === 'downloading') return getModelState(opts);
  const variant = variantById(opts.variant || _state.variant || DEFAULT_VOICE_MODEL);
  _state.variant = variant.id;
  if (getModelState(opts).phase === 'ready') return getModelState(opts);
  const { dir } = qwenPaths(opts, variant.id);
  _state = { phase: 'installing', progress: 1, error: null, variant: variant.id };
  (async () => {
    try {
      mkdirSync(dir, { recursive: true });
      // DISK PREFLIGHT — refuse before fetching a byte. If the snapshot is already
      // on disk (needs-runtime re-install) only the margin is required; a fresh
      // download needs the variant's full size plus the margin.
      const requiredBytes = (snapshotPresent(dir) ? 0 : variant.sizeMB * 1e6) + DISK_MARGIN_BYTES;
      const freeBytes = _freeBytes(dir);
      if (freeBytes != null && freeBytes < requiredBytes) {
        throw new Error(`not enough disk space: needs ~${(requiredBytes / 1e9).toFixed(1)} GB free, you have ${(freeBytes / 1e9).toFixed(1)} GB`);
      }
      const python = resolvePython(opts);
      // Poll on-disk size → honest download progress (snapshot_download has no
      // per-byte callback we can thread through a bare spawn). Weighted to the
      // variant's expected size, capped at 99 until the provisioner confirms.
      const totalBytes = variant.sizeMB * 1e6;
      _progressTimer = setInterval(() => {
        if (_state.phase !== 'downloading') return;
        const pct = Math.min(99, 5 + Math.round((dirBytes(dir) / totalBytes) * 94));
        if (pct > _state.progress) _state.progress = pct;
      }, 1500);
      _progressTimer.unref?.();
      await _provisioner({
        python, variant, dir,
        onProgress: (p) => {
          if (p >= 5 && _state.phase === 'installing') { _state.phase = 'downloading'; _state.progress = 5; }
          if (typeof p === 'number' && p > _state.progress) _state.progress = Math.min(100, p);
        },
      });
      _pkgInstalled = true;
      _state.phase = 'ready'; _state.progress = 100; _state.error = null;
    } catch (e) {
      _state.phase = 'error'; _state.error = String(e?.message || e).slice(0, 200);
    } finally {
      if (_progressTimer) { clearInterval(_progressTimer); _progressTimer = null; }
    }
  })();
  return getModelState(opts);
}

export default { QWEN_VARIANTS, DEFAULT_VOICE_MODEL, qwenVoiceCatalog, qwenPaths, getModelState, startDownload, hasVoiceSample };
