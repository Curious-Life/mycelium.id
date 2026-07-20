// src/hardware/ollama-daemon.js — lazily start a local `ollama serve` daemon so
// "Pull & use" works even when Ollama is installed but not running.
//
// WHY a separate module from ollama.js: ollama.js is the HTTP *client* (it never
// shells out, by design). STARTING the daemon is a distinct concern with its own
// security surface, kept here. This mirrors src/embed/supervisor.js (adopt-or-
// spawn a local engine) but is LAZY — there is no boot tick-loop; `ensureUp()`
// is called on demand (on a Pull & use click).
//
// SECURITY (CLAUDE.md §2/§4/§6):
//   • Fixed args `['serve']` — no shell, no interpolation, no request input.
//   • The binary path comes from a FIXED absolute allowlist (+ PATH dirs), never
//     from a request body or the model catalog.
//   • Env is an allowlist (PATH, HOME, OLLAMA_*) — NO master key, NO secrets.
//   • We spawn ONLY when the daemon is down, and kill ONLY a daemon we started
//     (`spawnedByUs`) — we can never take down a user's own Ollama (adopt path).
//   • Fail-closed: binary absent → do nothing, report `not_installed`.
//
// THE PATH PROBLEM: a Finder-launched macOS .app inherits launchd's minimal PATH
// (no Homebrew dirs), and the Tauri→Node command only prepends home/python
// (src-tauri/src/main.rs). So we must probe ABSOLUTE candidate paths, not rely
// on PATH resolving `ollama`.

import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync as nodeExistsSync } from 'node:fs';
import { join } from 'node:path';
import { findExecutable, homeDir } from '../system/platform-env.js';
import { createOllamaClient } from './ollama.js';
import { installOllama, extractedBinPath } from './ollama-install.js';

// Absolute install locations we trust, in priority order. (Homebrew on Apple
// Silicon + Intel, the official Ollama.app, and a common user-local dir.)
const ABSOLUTE_CANDIDATES = [
  '/opt/homebrew/bin/ollama',
  '/usr/local/bin/ollama',
  '/Applications/Ollama.app/Contents/Resources/ollama',
];

/**
 * Locate the `ollama` binary by checking absolute candidates, then each PATH dir.
 * The binary path is still confined to a FIXED candidate allowlist + PATH — never
 * request input (CLAUDE.md §4). @see findExecutable.
 * @param {object} [deps]
 * @param {(p:string)=>boolean} [deps.existsSync]
 * @param {object} [deps.env]
 * @param {string} [deps.platform]
 * @returns {string|null} absolute path, or null if not found
 */
export function findOllamaBinary({ existsSync = nodeExistsSync, env = process.env, platform = process.platform } = {}) {
  if (env.MYCELIUM_OLLAMA && existsSync(env.MYCELIUM_OLLAMA)) return env.MYCELIUM_OLLAMA;
  const home = homeDir({ env, platform });
  const candidates = platform === 'win32'
    ? [env.LOCALAPPDATA ? `${env.LOCALAPPDATA}\\Programs\\Ollama\\ollama.exe` : null, 'C:\\Program Files\\Ollama\\ollama.exe', 'ollama']
    : [...ABSOLUTE_CANDIDATES, home ? `${home}/.local/bin/ollama` : null, 'ollama'];
  return findExecutable(candidates.filter(Boolean), { env, platform, isExecutable: existsSync });
}

// Only what the daemon needs — never the master key or any vault secret.
//
// Proxy vars ARE forwarded (R2-QWENPULL): `ollama serve` reaches the model registry over the
// network, and on a corporate/VPN box the ONLY route out is the configured proxy. Without these,
// the spawned daemon dials the registry directly, the connection is dropped, and every pull fails
// with no hint why. Go reads both upper- and lower-case forms, so we forward both. These are
// endpoint/allow-list hints, never secrets (a proxy URL may carry credentials, but it is the
// user's own already-exported env — we neither read nor log its value).
function allowlistEnv(env) {
  const out = {};
  const KEYS = [
    'PATH', 'HOME', 'OLLAMA_HOST', 'OLLAMA_MODELS',
    'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY',
    'https_proxy', 'http_proxy', 'no_proxy',
  ];
  for (const k of KEYS) {
    if (env[k]) out[k] = env[k];
  }
  return out;
}

// Scrub credential-bearing substrings from the daemon's stderr tail BEFORE it is
// returned to the localhost portal (as `detail`) or logged. Low severity — the
// only surface is loopback-only, single-user V1 — but §1 ("if in doubt, don't
// log it") and §4 (master-key/secret discipline) say don't ship secrets we don't
// need. The live vector: we now forward proxy env to `ollama serve` (R2-QWENPULL),
// so a corporate proxy URL with embedded credentials (http://user:pass@proxy) can
// appear in a connection error on stderr. We redact:
//   • URL userinfo — `scheme://user:pass@host` → `scheme://<redacted>@host`
//     (the proxy-credential case; the host stays, it's useful diagnostics).
//   • generic secret-looking tokens (JWT / Bearer / sk- / ghp_ / xox*- / long hex),
//     mirroring crypto/guardians/scrubbers.js SECRET_PATTERNS as defence in depth.
// The userinfo class is `[^\s/?#]*` — greedy to the LAST `@` before a path/query/
// fragment boundary — so a password containing `@` still redacts fully (an earlier
// `[^/@\s]+` stopped at the FIRST `@` and leaked the tail; independent review). It
// still won't cross whitespace (multiple URLs on a line each redact independently)
// and won't touch a legit `@` in a PATH (`https://h/p@2x.png` — the `/` bounds it).
// Residual (documented, not covered): a raw UNENCODED `/` inside userinfo — but
// that is RFC-3986-invalid and Go percent-encodes/rejects it, so a working proxy
// URL can't emit it; and non-URL credential forms (`--proxy-user u:p`, a base64
// `Proxy-Authorization`) are out of scope — the token patterns below are the only
// backstop for those.
const SECRET_PATTERNS = [
  /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi,                      // URL userinfo (user:pass@)
  /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, // JWT
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,                        // bearer tokens
  /\bsk-[A-Za-z0-9_-]{12,}/g,                                    // OpenAI-style keys
  /\bghp_[A-Za-z0-9]{20,}/g,                                     // GitHub tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,                             // Slack tokens
  /\b[0-9a-fA-F]{32,}\b/g,                                       // hex keys (master key = 64 hex)
];

/** Redact credential-bearing substrings from a daemon stderr string. */
export function redactDaemonDetail(s) {
  let out = String(s);
  for (const re of SECRET_PATTERNS) {
    out = re.source.includes('@') ? out.replace(re, '$1<redacted>@') : out.replace(re, '[redacted]');
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Create a lazy adopt-or-spawn controller for the local Ollama daemon.
 * @param {object} [deps]
 * @param {string}   [deps.baseUrl]          ollama base (default loopback :11434)
 * @param {typeof fetch} [deps.fetch]        injectable (tests)
 * @param {()=>Promise<boolean>} [deps.isUp] override the up-probe (tests)
 * @param {()=>(string|null)} [deps.findBinary]
 * @param {Function} [deps.spawn]            child_process.spawn (injectable)
 * @param {object}   [deps.env]
 * @param {(m:string)=>void} [deps.log]
 * @param {number}   [deps.startTimeoutMs=15000]
 * @param {number}   [deps.pollMs=400]
 * @returns {{ ensureUp:Function, isInstalled:Function, stop:Function }}
 */
export function createOllamaDaemon({
  baseUrl,
  fetch = globalThis.fetch,
  isUp,
  dataDir,
  autoInstall = true,
  install = installOllama,
  findBinary,
  spawn = nodeSpawn,
  env = process.env,
  log = () => {},
  startTimeoutMs = 15000,
  pollMs = 400,
} = {}) {
  const probeUp = isUp || (() => createOllamaClient({ baseUrl, fetch }).isUp());
  // Adopt a SYSTEM install first; fall back to a copy we downloaded into dataDir.
  const resolveBinary = findBinary || (() => findOllamaBinary({ env }) || (dataDir ? extractedBinPath(dataDir) : null));

  let child = null;
  let spawnedByUs = false;
  let errBuf = '';
  let inflight = null;        // single-flight: start()
  let installInflight = null; // single-flight: download

  function isInstalled() {
    return resolveBinary() !== null;
  }

  /** Download+verify+extract the Ollama runtime (single-flight). */
  function provision(onProgress) {
    if (installInflight) return installInflight;
    if (!dataDir) return Promise.resolve({ ok: false, reason: 'unsupported_platform' });
    installInflight = install({ dataDir, onProgress, log }).finally(() => { installInflight = null; });
    return installInflight;
  }

  async function start(onProgress) {
    // 1. Already up (perhaps the user's own daemon) → adopt, never spawn.
    if (await probeUp()) return { ok: true, running: true, installed: true, adopted: true };

    // 2. Locate the binary; if absent and auto-install is on, DOWNLOAD it first.
    let bin = resolveBinary();
    if (!bin && autoInstall) {
      const r = await provision(onProgress);
      if (!r.ok) return { ok: false, running: false, installed: false, reason: r.reason };
      bin = r.binPath;
    }
    if (!bin) return { ok: false, running: false, installed: false, reason: 'not_installed' };

    // 3. Spawn `ollama serve` (non-detached → reaped with our process group on
    //    app exit; fixed args; allowlisted env; stderr captured for diagnostics).
    //    Models live app-private under dataDir, not the user's ~/.ollama.
    try {
      errBuf = '';
      const spawnEnv = allowlistEnv(env);
      if (dataDir) spawnEnv.OLLAMA_MODELS = join(dataDir, 'ollama', 'models');
      child = spawn(bin, ['serve'], { detached: false, stdio: ['ignore', 'ignore', 'pipe'], env: spawnEnv });
      spawnedByUs = true;
      child.stderr?.on?.('data', (d) => { errBuf = (errBuf + String(d)).slice(-4096); });
      child.on?.('exit', () => { child = null; });
    } catch {
      return { ok: false, running: false, installed: true, reason: 'spawn_failed' };
    }

    // 4. Poll until it binds or we time out.
    const deadline = Date.now() + startTimeoutMs;
    for (;;) {
      await sleep(pollMs);
      if (await probeUp()) {
        log('[ollama-daemon] started ollama serve');
        return { ok: true, running: true, installed: true, adopted: false };
      }
      if (Date.now() >= deadline) {
        const tail = redactDaemonDetail(errBuf.trim().split('\n').pop() || '');
        return { ok: false, running: false, installed: true, reason: 'start_timeout', detail: tail || undefined };
      }
    }
  }

  /**
   * Ensure the daemon is up (single-flight: concurrent callers share one start).
   * @param {(pct:number, done?:number, total?:number)=>void} [onProgress] download progress
   */
  function ensureUp(onProgress) {
    if (inflight) return inflight;
    inflight = start(onProgress).finally(() => { inflight = null; });
    return inflight;
  }

  /** Kill the daemon ONLY if we started it (never an adopted one). */
  function stop() {
    if (child && spawnedByUs) { try { child.kill('SIGTERM'); } catch { /* noop */ } }
    child = null;
  }

  return { ensureUp, isInstalled, stop };
}

export default createOllamaDaemon;
