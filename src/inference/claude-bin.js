// src/inference/claude-bin.js — locate the installed `claude` (Claude Code) CLI.
//
// Mirrors findOllamaBinary (src/hardware/ollama-daemon.js): env override → absolute
// candidates → PATH scan → null. "Latest version" is automatic — Claude Code
// self-updates, so we never pin a version. Fail-soft: returns an absolute path or
// null, and the harness resolver (src/agent/resolve-harness.js) falls back to the
// native engine when this is null. See the harness-CLI design.
import { existsSync as nodeExistsSync } from 'node:fs';
import { findExecutable, homeDir } from '../system/platform-env.js';

const ABSOLUTE_CANDIDATES = ['/opt/homebrew/bin/claude', '/usr/local/bin/claude'];

/**
 * @param {{ existsSync?: (p: string) => boolean, env?: NodeJS.ProcessEnv, platform?: string }} [deps]
 * @returns {string | null} absolute path to `claude`, or null if not found.
 */
export function resolveClaudeBin({ existsSync = nodeExistsSync, env = process.env, platform = process.platform } = {}) {
  if (env.CLAUDE_BIN && existsSync(env.CLAUDE_BIN)) return env.CLAUDE_BIN;
  const home = homeDir({ env, platform });
  // win32: Claude Code is npm-installed, so it lands on PATH as a `claude.cmd`
  // shim (there is no claude.exe) — findExecutable expands PATHEXT for the bare
  // name. `%APPDATA%\npm` is npm's global bin dir, probed for a Finder/Explorer
  // launch whose PATH may not carry it.
  const candidates = platform === 'win32'
    ? [env.APPDATA ? `${env.APPDATA}\\npm\\claude.cmd` : null, 'claude']
    : [...ABSOLUTE_CANDIDATES, home ? `${home}/.local/bin/claude` : null, home ? `${home}/.claude/local/claude` : null, 'claude'];
  // findExecutable: absolute candidates first, then the bare name via each PATH
  // dir (exe-suffixed on win32). Existence-only probe preserved (tests inject existsSync).
  return findExecutable(candidates.filter(Boolean), { env, platform, isExecutable: existsSync });
}
