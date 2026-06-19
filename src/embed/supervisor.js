// src/embed/supervisor.js — ONE owner for the local embed-service (:8091) lifecycle.
//
// Why this exists: the embedder turns imported messages into vectors; without it
// the enrichment drainer has nothing to embed → the "embedded" count never rises →
// the Generate preflight returns 409 forever → the UI sits at "Processing 0/N"
// with no error and no escape (the #1 "generation hangs" report).
//
// Previously main.rs spawned embed-service.py FIRE-AND-FORGET (it caught only the
// spawn error, never a post-spawn crash) and pure `npm` dev spawned nothing at all.
// When the resolved Python lacked numpy, embed-service.py died at `import numpy`
// (module load), /health never answered, and the failure was 100% invisible.
//
// This supervisor (run by the Node server, so it works identically in npm-dev,
// Tauri-dev and the bundled app):
//   • resolves Python: MYCELIUM_PYTHON → pipeline/.venv/bin/python3 → python3
//   • DEP SELF-CHECK before spawning, so a deps-less Python yields an ACTIONABLE
//     health status ("run: bash pipeline/setup.sh") instead of a doomed process
//   • ADOPTS an already-healthy :8091 (e.g. a manually started one) — never double-spawns
//   • RESTARTS the child on crash with capped exponential backoff
//   • exposes getEmbedderHealth() so /processing-status (→ the UI) can tell
//     "still working" from "broken, here's how to fix it"
//
// SECURITY: the embed child handles NO key material — it only loads the ONNX model
// and embeds text passed over loopback. Its env is a minimal allowlist (PATH/HOME +
// the offline-model HF_* hints) — no vault keys ever flow to it.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createEmbedClient } from './client.js';

const DEFAULT_PORT = Number(process.env.MYCELIUM_EMBED_PORT) || 8091;
const PROBE_TIMEOUT_MS = 2000;     // a health probe must not stack up
const TICK_MS = 3000;              // re-evaluate health/lifecycle this often
const DEPS_RETRY_MS = 15000;       // recheck deps this often (so a later setup.sh recovers)
const MAX_BACKOFF_MS = 30000;
const DOWN_AFTER = 5;              // consecutive crashes → report 'down'

// Module-level singleton: at most one embed service per machine (:8091), so at
// most one supervisor. getEmbedderHealth() reads this without plumbing.
let _health = { status: 'unknown', message: 'Embedding engine not started yet.', detail: null };
let _instance = null;

/**
 * Current embedder health for the UI. Status:
 *   'ok'           — ready to embed
 *   'loading'      — model loading (first run); keep waiting, NOT an error
 *   'starting'     — process (re)starting; transient
 *   'error'        — process up but the model failed to load (detail = reason)
 *   'deps_missing' — the Python is missing deps; actionable (run setup.sh)
 *   'down'         — keeps crashing; actionable (detail = last stderr line)
 *   'unknown'      — supervisor not started (e.g. verify scripts)
 * @returns {{status:string,message:string,detail:string|null}}
 */
export function getEmbedderHealth() { return { ..._health }; }

function resolvePython({ home, pythonBin }) {
  if (pythonBin) return pythonBin;
  if (process.env.MYCELIUM_PYTHON) return process.env.MYCELIUM_PYTHON;
  const venv = join(home, 'pipeline/.venv/bin/python3');
  if (existsSync(venv)) return venv;
  return 'python3';
}

/**
 * Start (or adopt) and supervise the embed service. Idempotent: a second call
 * returns the existing instance. Safe to call only on real app launches (NOT
 * verify scripts) — keep it gated the same way the enrich drainer is.
 *
 * @param {object} [opts]
 * @param {string} [opts.home=process.cwd()] repo root (cwd for the child + venv lookup)
 * @param {string} [opts.pythonBin] explicit interpreter (else resolved)
 * @param {number} [opts.port=8091]
 * @param {(m:string)=>void} [opts.log]
 * @param {ReturnType<typeof createEmbedClient>} [opts.embed] injectable client (tests)
 */
export function startEmbedSupervisor({
  home = process.cwd(),
  pythonBin,
  port = DEFAULT_PORT,
  log = (m) => process.stderr.write(`${m}\n`),
  embed,
} = {}) {
  if (_instance) return _instance;

  const python = resolvePython({ home, pythonBin });
  const client = embed || createEmbedClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: PROBE_TIMEOUT_MS });

  let child = null;          // the spawned process (null when none / between restarts)
  let spawnedByUs = false;   // never kill a service we merely adopted
  let failures = 0;          // consecutive crashes (drives backoff + 'down')
  let nextStartAt = 0;       // backoff gate (epoch ms)
  let stopped = false;
  let errBuf = '';
  let tickTimer = null;

  const setHealth = (status, message, detail = null) => { _health = { status, message, detail }; };
  const lastErrLine = () => errBuf.split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';

  const childEnv = () => ({
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...(process.env.HF_HOME ? { HF_HOME: process.env.HF_HOME } : {}),
    ...(process.env.HF_HUB_OFFLINE ? { HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE } : {}),
  });

  // True if :8091 answers /health (reachable). Updates health from the reply.
  async function probe() {
    try {
      const h = await client.health();
      failures = 0;
      // Order matters: /health sets loaded:false for BOTH 'error' and 'loading',
      // so the error case must be checked FIRST or it reads as a benign "loading".
      if (h?.status === 'error') {
        setHealth('error', 'The embedding model failed to load.', h?.load_error || null);
      } else if (h?.loaded === false || h?.status === 'loading') {
        setHealth('loading', 'Loading the embedding model… the first run can take a minute.');
      } else {
        setHealth('ok', 'Embedding engine ready.');
      }
      return true;
    } catch {
      return false;
    }
  }

  // Resolve whether the chosen Python can import the embed deps. Async (no
  // event-loop block). Returns true iff `import numpy,onnxruntime,tokenizers,huggingface_hub` succeeds.
  function checkDeps() {
    return new Promise((resolve) => {
      let p;
      try {
        p = spawn(python, ['-c', 'import numpy, onnxruntime, tokenizers, huggingface_hub'], { stdio: 'ignore' });
      } catch { return resolve(false); }
      p.on('error', () => resolve(false));
      p.on('close', (code) => resolve(code === 0));
    });
  }

  function backoff() { nextStartAt = Date.now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(failures, 5)); }

  // Adopt-or-spawn. Only runs when :8091 is unreachable and no child is alive.
  async function tryStart() {
    if (stopped || child || Date.now() < nextStartAt) return;

    if (!(await checkDeps())) {
      setHealth('deps_missing', 'The embedding engine needs setup — run: bash pipeline/setup.sh', `python: ${python}`);
      nextStartAt = Date.now() + DEPS_RETRY_MS; // recover promptly once deps appear (no crash-backoff)
      return;
    }

    setHealth('starting', failures ? 'Restarting the embedding engine…' : 'Starting the embedding engine…');
    try {
      child = spawn(python, ['pipeline/embed-service.py', '--serve', '--port', String(port)], {
        cwd: home, env: childEnv(), stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (e) {
      setHealth('down', 'Could not start the embedding engine.', String(e?.message || e));
      failures++; backoff(); return;
    }
    spawnedByUs = true; errBuf = '';
    child.stderr?.on('data', (d) => { errBuf = (errBuf + d.toString()).slice(-4096); });
    child.on('error', () => { /* surfaced via exit/last stderr */ });
    child.on('exit', (code) => {
      const wasOurs = child;
      child = null;
      if (stopped || !wasOurs) return;
      failures++;
      const tail = lastErrLine();
      if (failures >= DOWN_AFTER) {
        setHealth('down', 'The embedding engine keeps stopping. Check that its dependencies are installed (bash pipeline/setup.sh).', tail || `exited code ${code}`);
      } else {
        setHealth('starting', 'Restarting the embedding engine…', tail || `exited code ${code}`);
      }
      backoff();
      log(`[embed-supervisor] embed-service exited (code ${code}) — restart #${failures} scheduled${tail ? `: ${tail}` : ''}`);
    });
  }

  async function tick() {
    if (stopped) return;
    if (await probe()) return;     // reachable → health set by probe; nothing to do
    if (child) return;             // a child we spawned is still binding; its exit handler covers crashes
    await tryStart();              // unreachable + no child → adopt / deps-check / spawn
  }

  tickTimer = setInterval(() => { void tick(); }, TICK_MS);
  if (tickTimer.unref) tickTimer.unref();
  void tick(); // start immediately, don't wait a full tick

  _instance = {
    getHealth: getEmbedderHealth,
    /** Force an immediate re-evaluation (e.g. after the user clicks Retry / ran setup.sh). */
    nudge: () => { nextStartAt = 0; void tick(); },
    stop: () => {
      stopped = true;
      if (tickTimer) clearInterval(tickTimer);
      if (child && spawnedByUs) { try { child.kill('SIGTERM'); } catch { /* noop */ } }
      child = null;
      _instance = null;
    },
  };
  return _instance;
}

// Test seam: reset the module singleton + health between unit runs in one process.
export function _resetEmbedSupervisor() {
  if (_instance) { try { _instance.stop(); } catch { /* */ } }
  _instance = null;
  _health = { status: 'unknown', message: 'Embedding engine not started yet.', detail: null };
}

export default startEmbedSupervisor;
