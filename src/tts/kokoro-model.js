// src/tts/kokoro-model.js — manages the local Kokoro TTS model: the kokoro-onnx
// Python package + the two model files (kokoro-v1.0.onnx + voices-v1.0.bin).
// The portal "Download model" button triggers startDownload(); the UI polls
// getModelState(). Files land under <dataDir>/models/kokoro/ and are passed to
// kokoro-service.py via KOKORO_MODEL_PATH / KOKORO_VOICES_PATH.
//
// Single in-flight download (module-level state), idempotent: re-running when
// already ready is a no-op. Fail-soft: errors surface in state.error, never throw.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, createWriteStream, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { dataDir } from '../paths.js';

const ONNX_URL = process.env.KOKORO_ONNX_URL || 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx';
const VOICES_URL = process.env.KOKORO_VOICES_URL || 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin';

export function kokoroPaths(opts = {}) {
  const dir = process.env.KOKORO_MODEL_DIR || join(dataDir(opts), 'models', 'kokoro');
  return { dir, onnx: join(dir, 'kokoro-v1.0.onnx'), voices: join(dir, 'voices-v1.0.bin') };
}

function resolvePython({ home = process.cwd() } = {}) {
  if (process.env.MYCELIUM_PYTHON) return process.env.MYCELIUM_PYTHON;
  const venv = join(home, 'pipeline/.venv/bin/python3');
  if (existsSync(venv)) return venv;
  return 'python3';
}

// module-level download state (one machine, one model)
let _state = { phase: 'idle', progress: 0, error: null, bytes: 0, total: 0 };
export function getModelState(opts = {}) {
  const p = kokoroPaths(opts);
  const files = existsSync(p.onnx) && existsSync(p.voices) && statSync(p.onnx).size > 1_000_000;
  const phase = _state.phase === 'downloading' || _state.phase === 'installing' ? _state.phase : (files ? 'ready' : (_state.error ? 'error' : 'absent'));
  return { phase, progress: _state.progress, error: _state.error, files, sizeMB: 340 };
}

async function downloadTo(url, dest, onProgress) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download ${res.status} for ${url.split('/').pop()}`);
  const total = Number(res.headers.get('content-length') || 0);
  const tmp = `${dest}.part`;
  const out = createWriteStream(tmp);
  let bytes = 0;
  const reader = Readable.fromWeb(res.body);
  reader.on('data', (c) => { bytes += c.length; onProgress?.(bytes, total); });
  await new Promise((resolve, reject) => { reader.pipe(out); out.on('finish', resolve); out.on('error', reject); reader.on('error', reject); });
  renameSync(tmp, dest);
  return bytes;
}

function pipInstall(python) {
  return new Promise((resolve) => {
    const child = spawn(python, ['-m', 'pip', 'install', '--disable-pip-version-check', 'kokoro-onnx'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr?.on('data', (d) => { err += d.toString().slice(0, 500); });
    child.on('error', () => resolve({ ok: false, err: 'python/pip not found' }));
    child.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, err: err.slice(-300) || `pip exit ${code}` }));
  });
}

/**
 * Start (or resume) the model provisioning: pip install kokoro-onnx, then fetch
 * the two model files. Idempotent + single-flight. Returns immediately; poll
 * getModelState() for progress.
 */
export async function startDownload(opts = {}) {
  if (_state.phase === 'installing' || _state.phase === 'downloading') return getModelState(opts);
  const p = kokoroPaths(opts);
  if (getModelState(opts).phase === 'ready') return getModelState(opts);
  _state = { phase: 'installing', progress: 1, error: null, bytes: 0, total: 0 };
  (async () => {
    try {
      mkdirSync(p.dir, { recursive: true });
      const python = resolvePython(opts);
      const pip = await pipInstall(python);
      if (!pip.ok) throw new Error(`kokoro-onnx install failed: ${pip.err}`);
      _state.phase = 'downloading'; _state.progress = 5;
      // voices first (small), then the big onnx; weight progress by size (~26MB + ~310MB)
      if (!existsSync(p.voices)) await downloadTo(VOICES_URL, p.voices, (b, t) => { _state.progress = 5 + Math.round((b / (t || 26e6)) * 5); });
      _state.progress = 10;
      if (!existsSync(p.onnx)) await downloadTo(ONNX_URL, p.onnx, (b, t) => { _state.bytes = b; _state.total = t; _state.progress = 10 + Math.round((b / (t || 310e6)) * 89); });
      _state.phase = 'ready'; _state.progress = 100; _state.error = null;
    } catch (e) {
      _state.phase = 'error'; _state.error = String(e?.message || e).slice(0, 200);
    }
  })();
  return getModelState(opts);
}

export default { kokoroPaths, getModelState, startDownload };
