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

/** Read Claude Code session files into {relPath, content} entries for the parser. */
export function readClaudeCodeEntries(dir, { maxFiles = 5000 } = {}) {
  const entries = [];
  const walk = (d, depth) => {
    if (depth > 6 || entries.length >= maxFiles) return;
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (entries.length >= maxFiles) return;
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
