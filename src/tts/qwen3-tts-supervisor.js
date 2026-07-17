// src/tts/qwen3-tts-supervisor.js — lifecycle owner for the local Qwen3-TTS
// voice service (:8094), modeled verbatim on src/tts/kokoro-supervisor.js (which
// this replaces). Starts qwen3-tts-service.py ONLY once the model is downloaded
// AND the user has opted in (QWEN_TTS_ENABLED in the secrets table). Ticks so it
// picks up the model the moment a download finishes; adopts an already-running
// service; restarts on crash with backoff.
//
// SECURITY: the child handles NO key material — it loads the MLX model and
// synthesizes text passed over loopback. Minimal env allowlist (PATH/HOME +
// model dir). Loopback-only, zero egress (design §5.5).
//
// ⚠️ MLX is Apple-Silicon-only. On Intel the model never reaches 'ready'
//    (import mlx_audio fails), so this supervisor stays idle by design — the
//    accepted cost of removing Kokoro (design §6).
import { spawn } from 'node:child_process';
import { qwenPaths, getModelState, resolveQwenPython, startDownload } from './qwen3-tts-model.js';

const PORT = Number(process.env.MYCELIUM_QWEN_TTS_PORT) || 8094;
const TICK_MS = 4000;
const MAX_BACKOFF_MS = 30000;

let _instance = null;
let _health = { status: 'idle', message: 'Local voice not started.' };
export function getQwenTtsHealth() { return _health; }

// Shared resolver — the supervisor MUST use the same python as the pip-install
// and the import-check (qwen3-tts-model.js), or the service runs under a python
// that lacks mlx-audio.
const resolvePython = resolveQwenPython;

async function probe() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

/**
 * @param {object} opts
 * @param {string} opts.home
 * @param {() => (boolean|Promise<boolean>)} opts.shouldRun  true iff the user opted in (QWEN_TTS_ENABLED)
 * @param {number} [opts.tickMs]  test-only override of the tick interval
 */
export function startQwenTtsSupervisor({ home = process.cwd(), shouldRun = () => false, tickMs = TICK_MS } = {}) {
  if (_instance) return _instance;
  const python = resolvePython({ home });
  let child = null, spawnedByUs = false, failures = 0, nextStartAt = 0, stopped = false, installing = false;
  // Backoff for the needs-runtime AUTO-install (adversarial review of #209, LOW-1):
  // without it a persistently-failing `pip install mlx-audio` re-ran EVERY tick —
  // the storm family #206 just fixed on the pull path. Attempt-based, doubling,
  // capped; reset the moment the model reaches 'ready'.
  let installAttempts = 0, nextInstallAt = 0;

  const modelDir = () => qwenPaths({ home }, getModelState().variant).dir;
  const env = () => ({
    PATH: process.env.PATH, HOME: process.env.HOME,
    MYCELIUM_QWEN_TTS_PORT: String(PORT),
    QWEN_TTS_MODEL_DIR: modelDir(),
    ...(process.env.MYCELIUM_PYTHON ? { MYCELIUM_PYTHON: process.env.MYCELIUM_PYTHON } : {}),
  });

  async function tick() {
    if (stopped) return;
    let want = false; try { want = await shouldRun(); } catch { want = false; }
    const phase = getModelState().phase;

    if (!want) { // not opted in → stop any child we spawned
      if (child && spawnedByUs) { try { child.kill(); } catch { /* */ } }
      _health = { status: 'idle', message: 'Local voice off.' };
      return;
    }

    // Model FILES present but the MLX runtime isn't importable (e.g. after an app
    // update reset the bundled python) → AUTO-INSTALL mlx-audio, no UI click.
    // startDownload skips the snapshot since the files already exist. Only for
    // 'needs-runtime'; 'absent' means no model yet — that multi-GB fetch stays a
    // deliberate Download click (design §3.10 consent). Mirrors the whisper +
    // Kokoro supervisors' auto-install.
    if (phase === 'ready') installAttempts = 0;   // a landed install resets the backoff
    if (phase === 'needs-runtime' && !installing) {
      if (Date.now() < nextInstallAt) {           // backoff gate — no per-tick pip storm
        _health = { status: 'installing', message: 'Local voice runtime install failed — retrying shortly…' };
        return;
      }
      installing = true;
      installAttempts++;
      nextInstallAt = Date.now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(installAttempts, 5));
      _health = { status: 'installing', message: 'Installing local voice runtime…' };
      try { await startDownload({ home }); } catch { /* surfaced via model state */ }
      installing = false;
      return; // next tick re-evaluates (should be 'ready')
    }

    if (phase !== 'ready') { // absent / installing / checking / error → wait
      if (child && spawnedByUs) { try { child.kill(); } catch { /* */ } }
      _health = { status: phase === 'absent' ? 'idle' : 'installing', message: phase === 'absent' ? 'Local voice model not installed.' : 'Preparing local voice…' };
      return;
    }
    if (child) return;                                   // already running ours
    if (await probe()) { _health = { status: 'ok', message: 'Local voice ready (adopted).' }; return; } // adopt
    if (Date.now() < nextStartAt) return;                // backoff gate

    _health = { status: 'starting', message: failures ? 'Restarting local voice…' : 'Starting local voice…' };
    try {
      child = spawn(python, ['pipeline/qwen3-tts-service.py', '--serve', '--port', String(PORT)], { cwd: home, env: env(), stdio: ['ignore', 'ignore', 'pipe'] });
      spawnedByUs = true;
    } catch (e) {
      _health = { status: 'down', message: 'Could not start local voice.', detail: String(e?.message || e) };
      failures++; nextStartAt = Date.now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(failures, 5)); return;
    }
    child.on('exit', () => { child = null; spawnedByUs = false; failures++; nextStartAt = Date.now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(failures, 5)); });
    // give it a moment, then confirm health
    setTimeout(async () => { if (await probe()) { failures = 0; _health = { status: 'ok', message: 'Local voice ready.' }; } }, 4000).unref?.();
  }

  const timer = setInterval(tick, tickMs);
  timer.unref?.();
  tick();
  _instance = {
    stop() { stopped = true; clearInterval(timer); if (child && spawnedByUs) { try { child.kill(); } catch { /* */ } } _instance = null; },
    health: getQwenTtsHealth,
  };
  return _instance;
}

export default { startQwenTtsSupervisor, getQwenTtsHealth };
