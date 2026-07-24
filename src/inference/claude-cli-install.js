// src/inference/claude-cli-install.js — install / update the Claude Code CLI FROM
// the Mycelium app (QA7 D-002, operator reframe 2026-07-24).
//
// WHY THIS EXISTS. The Engine panel could only ever hand the user a copy-paste
// command to run themselves in a terminal. The operator's bar is that the app can
// INSTALL the `claude` CLI and UPDATE it — the panel must lead to a real action, not
// homework. This module is that action: owner-initiated, FIXED-command installers,
// reported honestly.
//
// WHICH INSTALLER. The OFFICIAL Anthropic native installer
// (`curl -fsSL https://claude.ai/install.sh | bash`, docs: code.claude.com/docs/en/setup)
// is used rather than `npm i -g` because it is npm/node-INDEPENDENT (a Finder-launched
// GUI app has neither npm nor a user PATH) and it lands the binary at
// ~/.local/bin/claude — exactly where resolveClaudeBin already probes. `claude update`
// updates any install type. The commands are LITERAL constants: no user- or
// network-supplied value is ever interpolated into the shell string, so there is no
// injection surface. This is the same trust posture as the app's existing
// runtime auto-installs (qwen3-tts-model.js `pip install`), over https to Anthropic's
// own domain, and it only ever runs on an explicit owner click behind the portal
// session.
//
// HONESTY (never a silent success). A clean installer exit is NOT proof the binary is
// runnable, so the CALLER (the endpoint) MUST re-probe with probeClaudeCli and report
// `ok` only when a usable `claude` actually appears. This module returns a structured
// verdict and NEVER throws. SECURITY: minimal env (PATH/HOME only) — no vault secrets
// reach the child; the child's stderr is DRAINED-AND-DISCARDED and NEVER returned
// (it can embed the user's home dir → §1), so only bounded machine codes
// (`exit-<n>` / `spawn-failed:<errno>` / `timed-out` / `not-installed`) ever leave here.
import { spawn as nodeSpawn } from 'node:child_process';
import { resolveClaudeBin } from './claude-bin.js';

// The exact, LITERAL commands. One source of truth with the panel copy.
export const CLAUDE_NATIVE_INSTALL_SH = 'curl -fsSL https://claude.ai/install.sh | bash';
export const CLAUDE_NATIVE_INSTALL_PS = 'irm https://claude.ai/install.ps1 | iex';
export const CLAUDE_UPDATE_ARGS = ['update'];

const INSTALL_TIMEOUT_MS = 180_000; // a native download+install; generous, bounded
const UPDATE_TIMEOUT_MS = 120_000;

// Minimal env — the installer needs PATH (to find curl/bash) + HOME (install target
// ~/.local). NOTHING from the vault. Never inherit the full process env (it can carry
// provider keys / the master-key source).
function minimalEnv(env) {
  return { PATH: env.PATH, HOME: env.HOME, ...(env.CLAUDE_BIN ? { CLAUDE_BIN: env.CLAUDE_BIN } : {}) };
}

// Run a child to completion; resolve a structured verdict, never reject. Bounded
// stderr tail only (a code, never the resolved path or any secret).
function runToVerdict(cmd, args, { spawnImpl, env, timeoutMs, shell = false }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], env: minimalEnv(env), shell });
    } catch (e) {
      resolve({ ok: false, error: `spawn-failed: ${String(e?.code || e?.message || 'error').slice(0, 60)}` });
      return;
    }
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } done({ ok: false, error: 'timed-out' }); }, timeoutMs);
    if (timer.unref) timer.unref();
    // Drain stderr so the pipe can't fill and block the child — but DISCARD it (F7).
    // The installer's stderr can embed the user's home dir; §1 forbids returning it.
    // Only a bounded machine code (exit-N / spawn-failed:<errno>) ever leaves this
    // function, never the raw output.
    child.stderr?.on?.('data', () => {});
    child.on('error', (e) => { clearTimeout(timer); done({ ok: false, error: `spawn-failed: ${String(e?.code || 'error').slice(0, 40)}` }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      done(code === 0 ? { ok: true } : { ok: false, error: `exit-${code}` });
    });
  });
}

/**
 * Install the Claude Code CLI via the official native installer.
 * @returns {Promise<{ok:boolean, error?:string}>}  ok = the installer exited 0.
 *   The CALLER must re-probe to confirm a USABLE binary before telling the user
 *   it worked (a clean exit is not a runnable install).
 */
export async function installClaudeCli({ spawnImpl = nodeSpawn, env = process.env, platform = process.platform, timeoutMs = INSTALL_TIMEOUT_MS } = {}) {
  if (platform === 'win32') {
    // PowerShell one-liner; the app can't assume a POSIX shell here. Fixed command.
    return runToVerdict('powershell.exe', ['-NoProfile', '-Command', CLAUDE_NATIVE_INSTALL_PS], { spawnImpl, env, timeoutMs });
  }
  // macOS / Linux: the documented `curl … | bash`. A pipe needs a shell; the string
  // is a LITERAL constant, so `sh -c` is not an injection surface.
  return runToVerdict('/bin/sh', ['-c', CLAUDE_NATIVE_INSTALL_SH], { spawnImpl, env, timeoutMs });
}

/**
 * Update an installed Claude Code CLI (`claude update`, works for every install type).
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function updateClaudeCli({ spawnImpl = nodeSpawn, env = process.env, platform = process.platform, findBin = resolveClaudeBin, timeoutMs = UPDATE_TIMEOUT_MS } = {}) {
  let bin = null;
  try { bin = findBin({ env, platform }); } catch { bin = null; }
  if (!bin) return { ok: false, error: 'not-installed' };
  return runToVerdict(bin, CLAUDE_UPDATE_ARGS, { spawnImpl, env, timeoutMs });
}

export default { installClaudeCli, updateClaudeCli };
