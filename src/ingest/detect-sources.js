// src/ingest/detect-sources.js — "what's on this Mac you could bring in".
//
// The local backend (loopback :8787) runs on the user's machine, so it can scan
// for known data-source runtimes/folders and offer one-click import. PRIVACY:
// this is an ALLOWLIST of well-known paths; it reads PRESENCE, COUNTS and DATES
// only — NEVER file contents — and is only invoked on an explicit user action
// (the "Scan this Mac for data" CTA). A detector that throws never breaks the
// scan. Mirrors the local hardware-recommender pattern (sync detect → JSON).
//
// Each detector returns null (not found) or a record the catalog renders as
// "Found on this Mac — N <unit> · Import". `importable:true` means an importer
// already exists for it (Obsidian folder, Claude Code transcripts).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const statSafe = (p) => { try { return fs.statSync(p); } catch { return null; } };

// Bounded recursive count of files matching `ext` (no content read).
function countFiles(root, ext, { maxDepth = 6, cap = 50000, skipDot = true } = {}) {
  let count = 0, minMs = Infinity, maxMs = 0;
  const walk = (dir, depth) => {
    if (depth > maxDepth || count >= cap) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (count >= cap) return;
      if (e.isSymbolicLink()) continue; // never follow symlinks out of the scanned root
      if (skipDot && e.name.startsWith('.') && e.isDirectory()) continue;
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) walk(fp, depth + 1);
      else if (e.name.endsWith(ext)) {
        count++;
        const st = statSafe(fp);
        if (st) { minMs = Math.min(minMs, st.mtimeMs); maxMs = Math.max(maxMs, st.mtimeMs); }
      }
    }
  };
  walk(root, 0);
  const day = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : null);
  return { count, dateRange: count ? [day(minMs), day(maxMs)] : null };
}

// Claude Code: ~/.claude/projects/**/*.jsonl (session transcripts).
function detectClaudeCode(home) {
  const dir = path.join(home, '.claude', 'projects');
  if (!statSafe(dir)?.isDirectory()) return null;
  const { count, dateRange } = countFiles(dir, '.jsonl');
  if (!count) return null;
  return { source: 'claude-code', found: true, path: dir, count, dateRange,
    unit: 'sessions', importable: true, action: 'import-claude-code' };
}

// Obsidian: vault list at the macOS config; count .md per vault (no content).
function detectObsidian(home) {
  const cfg = path.join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json');
  let paths = [];
  try {
    const j = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    paths = Object.values(j?.vaults || {}).map((v) => v && v.path).filter((p) => typeof p === 'string');
  } catch { /* no Obsidian config — not installed */ }
  const vaults = [];
  for (const vp of paths) {
    if (!statSafe(vp)?.isDirectory()) continue;
    const { count } = countFiles(vp, '.md');
    if (count) vaults.push({ path: vp, name: path.basename(vp), count });
  }
  if (!vaults.length) return null;
  const total = vaults.reduce((a, v) => a + v.count, 0);
  return { source: 'obsidian', found: true, path: vaults[0].path, vaults, count: total,
    unit: 'notes', importable: true, action: 'import-folder' };
}

/** Scan the allowlist. Returns an array of detection records (found sources). */
export function detectSources({ home = os.homedir() } = {}) {
  const detectors = [detectObsidian, detectClaudeCode];
  const out = [];
  for (const det of detectors) {
    try { const r = det(home); if (r) out.push(r); } catch { /* one detector failing never breaks the scan */ }
  }
  return out;
}

// ── Import-path confinement ──────────────────────────────────────────────────
// The import routes (POST /import/obsidian|full-export|claude-code) accept a
// server-local path and walk it off disk. Without confinement a stolen owner
// Bearer or a malicious portal page could point them at ~/Library/Messages,
// ~/.ssh, mounted volumes, etc. and read those files back out of the vault.
// Defense: resolve the requested path through realpath (collapsing any symlink
// escape) and require it to sit inside one of a small ALLOWLIST of roots:
//   • the Obsidian config's registered vault dirs (obsidian.json)
//   • ~/.claude/projects (Claude Code transcripts)
//   • any path in MYCELIUM_IMPORT_ALLOWED_ROOTS (colon-separated) — the explicit
//     out-of-band grant for an arbitrary user-picked directory (e.g. a Tauri
//     native folder picker, or an operator importing a full-export bundle). This
//     is set by the trusted local shell, NOT mintable over HTTP, so a forged
//     request can't widen it.
// Anything else is rejected fail-closed. realpathSync also means a path that
// doesn't exist (or a dangling symlink) is rejected rather than silently passed.

/** Realpath a candidate root; return null if it doesn't resolve (skipped). */
function realRoot(p) { try { return fs.realpathSync(p); } catch { return null; } }

/** The set of realpath'd filesystem roots the import routes may read from. */
export function importAllowedRoots({ home = os.homedir(), env = process.env } = {}) {
  const roots = new Set();
  const add = (p) => { const r = p && realRoot(p); if (r) roots.add(r); };

  // Claude Code transcripts.
  add(path.join(home, '.claude', 'projects'));

  // Obsidian vault dirs registered in the config (same source detectObsidian uses).
  try {
    const cfg = path.join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json');
    const j = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    for (const v of Object.values(j?.vaults || {})) { if (v && typeof v.path === 'string') add(v.path); }
  } catch { /* no Obsidian config — not installed */ }

  // Explicit out-of-band grants (Tauri picker / operator full-export bundles).
  const extra = env?.MYCELIUM_IMPORT_ALLOWED_ROOTS;
  if (typeof extra === 'string' && extra.trim()) {
    for (const p of extra.split(path.delimiter)) { if (p.trim()) add(p.trim()); }
  }

  return [...roots];
}

/** Is `child` the same as, or nested under, `root`? (both already realpath'd) */
function isWithin(root, child) {
  return child === root || child.startsWith(root + path.sep);
}

/**
 * Confine an HTTP-supplied import path to the allowlist. Returns the resolved
 * (realpath'd) absolute path on success; throws Error('import_path_denied') on
 * any escape, fail-closed. Caller maps the throw to HTTP 400.
 * @param {string} requested  the client-supplied folderPath/dirPath
 */
export function assertImportPathAllowed(requested, { home = os.homedir(), env = process.env } = {}) {
  if (typeof requested !== 'string' || !requested.trim()) throw new Error('import_path_denied: path required');
  const resolved = realRoot(requested);
  if (!resolved) throw new Error('import_path_denied: path does not resolve');
  const allowed = importAllowedRoots({ home, env });
  if (!allowed.some((root) => isWithin(root, resolved))) throw new Error('import_path_denied: outside the allowed import roots');
  return resolved;
}

/** Read Claude Code session files into {relPath, content} entries for the parser. */
export function readClaudeCodeEntries(dir, { maxFiles = 5000 } = {}) {
  const entries = [];
  const walk = (d, depth) => {
    if (depth > 6 || entries.length >= maxFiles) return;
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (entries.length >= maxFiles) return;
      if (e.isSymbolicLink()) continue; // never follow symlinks out of the projects dir
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp, depth + 1);
      else if (e.name.endsWith('.jsonl')) {
        try { entries.push({ relPath: path.relative(dir, fp), content: fs.readFileSync(fp, 'utf8') }); } catch { /* skip unreadable */ }
      }
    }
  };
  if (statSafe(dir)?.isDirectory()) walk(dir, 0);
  return entries;
}
