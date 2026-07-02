// src/inference/claude-bin.js — locate the installed `claude` (Claude Code) CLI.
//
// Mirrors findOllamaBinary (src/hardware/ollama-daemon.js): env override → absolute
// candidates → PATH scan → null. "Latest version" is automatic — Claude Code
// self-updates, so we never pin a version. Fail-soft: returns an absolute path or
// null, and the harness resolver (src/agent/resolve-harness.js) falls back to the
// native engine when this is null. See docs/HARNESS-CLI-DESIGN-2026-07-02.md.
import { existsSync as nodeExistsSync } from 'node:fs';

const ABSOLUTE_CANDIDATES = ['/opt/homebrew/bin/claude', '/usr/local/bin/claude'];

/**
 * @param {{ existsSync?: (p: string) => boolean, env?: NodeJS.ProcessEnv }} [deps]
 * @returns {string | null} absolute path to `claude`, or null if not found.
 */
export function resolveClaudeBin({ existsSync = nodeExistsSync, env = process.env } = {}) {
  if (env.CLAUDE_BIN && existsSync(env.CLAUDE_BIN)) return env.CLAUDE_BIN;
  const candidates = [...ABSOLUTE_CANDIDATES];
  if (env.HOME) {
    candidates.push(`${env.HOME}/.local/bin/claude`);
    candidates.push(`${env.HOME}/.claude/local/claude`);
  }
  for (const dir of String(env.PATH || '').split(':')) {
    if (dir) candidates.push(`${dir.replace(/\/+$/, '')}/claude`);
  }
  for (const c of candidates) {
    try { if (existsSync(c)) return c; } catch { /* unreadable — skip */ }
  }
  return null;
}
