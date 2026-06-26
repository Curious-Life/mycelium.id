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
import Database from 'better-sqlite3';
import { categoryOf, isManagedPackageDir, FILE_CATEGORIES } from './file-categories.js';

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

// ── Hermes: ~/.hermes/state.db (SQLite) sessions + messages, + SOUL.md persona ─
// Detection opens the DB READONLY to COUNT turns + date span only — never reads
// message text (same presence/count/date posture as the file detectors; it's the
// user's own agent DB on their own machine). A locked/corrupt DB → skipped.
export function hermesPaths(home) {
  return { statePath: path.join(home, '.hermes', 'state.db'), soulPath: path.join(home, '.hermes', 'SOUL.md') };
}
function detectHermes(home) {
  const { statePath, soulPath } = hermesPaths(home);
  if (!statSafe(statePath)?.isFile()) return null;
  let count = 0, dateRange = null;
  try {
    const sdb = new Database(statePath, { readonly: true, fileMustExist: true });
    try {
      const r = sdb.prepare("SELECT COUNT(*) c, MIN(timestamp) lo, MAX(timestamp) hi FROM messages WHERE active = 1 AND role IN ('user','assistant') AND content IS NOT NULL AND content <> ''").get();
      count = r?.c || 0;
      const day = (s) => (Number.isFinite(s) && s > 0 ? new Date(s * 1000).toISOString().slice(0, 10) : null);
      if (count && r?.lo) dateRange = [day(r.lo), day(r.hi)];
    } finally { sdb.close(); }
  } catch { return null; } // unreadable/locked DB or no driver → not offered
  const hasSoul = !!statSafe(soulPath)?.isFile();
  if (!count && !hasSoul) return null;
  return { source: 'hermes', found: true, path: statePath, count, dateRange,
    unit: 'messages', persona: hasSoul, importable: true, action: 'import-hermes' };
}

// ── OpenClaw: JSONL session transcripts + workspace/*.md memory documents ──────
export function openClawPaths(home) {
  const base = path.join(home, '.openclaw');
  return { sessionsDir: path.join(base, 'agents', 'main', 'sessions'), workspaceDir: path.join(base, 'workspace') };
}
function detectOpenClaw(home) {
  const { sessionsDir, workspaceDir } = openClawPaths(home);
  let sessions = 0, dateRange = null;
  // Count canonical transcripts (exclude the .trajectory.jsonl telemetry mirror).
  if (statSafe(sessionsDir)?.isDirectory()) {
    try {
      let lo = Infinity, hi = 0;
      for (const name of fs.readdirSync(sessionsDir)) {
        if (!/\.jsonl$/i.test(name) || /\.trajectory\.jsonl$/i.test(name)) continue;
        sessions++;
        const st = statSafe(path.join(sessionsDir, name));
        if (st) { lo = Math.min(lo, st.mtimeMs); hi = Math.max(hi, st.mtimeMs); }
      }
      const day = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : null);
      if (sessions && Number.isFinite(lo)) dateRange = [day(lo), day(hi)];
    } catch { /* unreadable → sessions stays 0 */ }
  }
  let notes = 0;
  if (statSafe(workspaceDir)?.isDirectory()) {
    try { for (const n of fs.readdirSync(workspaceDir)) if (/\.md$/i.test(n)) notes++; } catch { /* */ }
  }
  if (!sessions && !notes) return null;
  return { source: 'openclaw', found: true, path: sessionsDir, count: sessions, dateRange,
    unit: 'sessions', notes, importable: true, action: 'import-openclaw' };
}

// ── Broad local sweep: count loose files per category across the user's folders ─
// The default roots the sweep offers. Each is the parent of the user's loose,
// intentional files; managed library packages inside are pruned (Photos etc.).
export function localSweepRoots(home) {
  return ['Documents', 'Desktop', 'Downloads', 'Music', 'Pictures', 'Movies'].map((d) => path.join(home, d));
}
// Single-pass categorizing count (no content read): tallies files per category
// and the date span, bounded by depth + a file cap so a huge home stays fast.
function countByCategory(root, { maxDepth = 5, cap = 40000 } = {}) {
  const tally = {}; // cat → { count, minMs, maxMs }
  let seen = 0;
  const bump = (cat, ms) => { const t = tally[cat] || (tally[cat] = { count: 0, minMs: Infinity, maxMs: 0 }); t.count++; if (Number.isFinite(ms)) { t.minMs = Math.min(t.minMs, ms); t.maxMs = Math.max(t.maxMs, ms); } };
  const walk = (dir, depth) => {
    if (depth > maxDepth || seen >= cap) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (seen >= cap) return;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (e.name.startsWith('.') || isManagedPackageDir(e.name)) continue; walk(path.join(dir, e.name), depth + 1); continue; }
      const cat = categoryOf(e.name);
      if (!cat) continue;
      seen++;
      const st = statSafe(path.join(dir, e.name));
      bump(cat, st?.mtimeMs);
    }
  };
  walk(root, 0);
  return tally;
}
function detectLocalFiles(home) {
  const roots = localSweepRoots(home).filter((r) => statSafe(r)?.isDirectory());
  if (!roots.length) return null;
  const merged = {}; // cat → { count, minMs, maxMs, roots:Set }
  for (const root of roots) {
    const tally = countByCategory(root);
    for (const [cat, t] of Object.entries(tally)) {
      const m = merged[cat] || (merged[cat] = { count: 0, minMs: Infinity, maxMs: 0, roots: new Set() });
      m.count += t.count; m.minMs = Math.min(m.minMs, t.minMs); m.maxMs = Math.max(m.maxMs, t.maxMs); m.roots.add(root);
    }
  }
  const day = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : null);
  const categories = Object.entries(merged).map(([key, m]) => ({
    key, label: FILE_CATEGORIES[key]?.label || key, count: m.count,
    dateRange: m.count ? [day(m.minMs), day(m.maxMs)] : null, roots: [...m.roots],
  })).filter((c) => c.count > 0).sort((a, b) => b.count - a.count);
  if (!categories.length) return null;
  const total = categories.reduce((a, c) => a + c.count, 0);
  return { source: 'local-files', found: true, path: roots[0], count: total,
    unit: 'files', categories, importable: true, action: 'import-local-files' };
}

/** Scan the allowlist. Returns an array of detection records (found sources). */
export function detectSources({ home = os.homedir() } = {}) {
  const detectors = [detectObsidian, detectClaudeCode, detectHermes, detectOpenClaw, detectLocalFiles];
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

  // Hermes + OpenClaw agent stores (their own dirs, on this machine).
  add(path.join(home, '.hermes'));
  add(path.join(home, '.openclaw'));

  // Broad-sweep roots (the user's loose files). Confined to these standard
  // folders so a picked subfolder is permitted but ~/Library/Messages, ~/.ssh,
  // mounted volumes, etc. stay denied. realRoot() drops any that don't exist.
  for (const r of localSweepRoots(home)) add(r);

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
