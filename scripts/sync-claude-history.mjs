#!/usr/bin/env node
// Incremental, idempotent sync of Claude Code transcripts into the vault.
//
// This is the DURABLE periodic sync (run by a launchd agent every N minutes) that
// complements the live `Stop` hook: it (a) finishes any historical backlog, (b)
// re-syncs anything missed while :4711 was down, and (c) covers sessions whose
// hooks never fired. It walks ~/.claude/projects/**/*.jsonl and bulk-imports new
// turns via the memory bridge — idempotent on each turn's transcript uuid, so
// re-walking is always safe.
//
// Cheap in steady state: a per-file (mtime,size) check skips unchanged transcripts
// without reading them, and a per-file LINE high-water mark means only the newly
// appended turns of a changed transcript are parsed. State lives in
// ~/.mycelium-bridge/sync-state.json (the same dir the Stop hook uses for its HWMs).
//
// Fail-soft by contract: if :4711 is down (the app not running / mid-restart), the
// bridge's importBatch returns null; we DON'T advance that file's HWM and exit 0
// quietly, so the next run retries. Capture is also consent-gated server-side — if
// "Memory capture" is OFF, imports are a reported no-op.
//
// No env required on a local box: the bridge resolves its bearer from auth.db
// (PR #189). Tunables: MYCELIUM_SYNC_BATCH (default 50), MYCELIUM_SYNC_DELAY_MS
// (default 300), CLAUDE_PROJECTS_DIR, MYCELIUM_BASE_URL.
//
// Flags:  --full   ignore saved state and re-walk every file from line 0 (a manual
//                   catch-up; still idempotent, just slower).
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { parseTranscript } from '../tools/memory-bridge/claude-code/transcript.mjs';
import { importBatch, BASE_URL } from '../tools/memory-bridge/bridge.mjs';

const FULL = process.argv.includes('--full');
const root = process.env.CLAUDE_PROJECTS_DIR || join(homedir(), '.claude', 'projects');
const STATE_DIR = join(homedir(), '.mycelium-bridge');
const STATE_FILE = join(STATE_DIR, 'sync-state.json');

const BATCH = Math.max(1, Number(process.env.MYCELIUM_SYNC_BATCH) || 50);
const DELAY_MS = Number.isFinite(Number(process.env.MYCELIUM_SYNC_DELAY_MS)) ? Number(process.env.MYCELIUM_SYNC_DELAY_MS) : 300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

function loadState() {
  if (FULL) return {};
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) || {}; } catch { return {}; }
}
function saveState(state) {
  try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(state, null, 0)); } catch { /* best-effort */ }
}

function findJsonl(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'memory') findJsonl(p, out); }
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

const state = loadState();
const files = findJsonl(root);
let scanned = 0, parsed = 0, considered = 0, totalNew = 0, totalDup = 0, totalFailed = 0;
let appDown = false;

for (const f of files) {
  scanned += 1;
  let st;
  try { st = statSync(f); } catch { continue; }
  const prev = state[f] || { hwm: 0, mtimeMs: 0, size: 0 };
  // Stat-only skip: unchanged transcript (same mtime + size) → nothing to do.
  if (!FULL && st.mtimeMs === prev.mtimeMs && st.size === prev.size) continue;

  parsed += 1;
  const sinceLine = FULL ? 0 : (prev.hwm || 0);
  const { items, lastLine } = parseTranscript(f, { sinceLine });
  // Overlap by one line on persist so a partial trailing line in a LIVE transcript
  // (written mid-turn, no trailing newline yet) is re-read next run rather than
  // skipped. The re-read turn dedups by uuid, so the overlap is free of duplicates.
  const nextHwm = Math.max(0, lastLine - 1);

  if (!items.length) {
    // File changed (e.g. only tool entries appended) but no new conversation turns.
    state[f] = { hwm: nextHwm, mtimeMs: st.mtimeMs, size: st.size };
    continue;
  }
  considered += items.length;

  let fileNew = 0, fileDup = 0, failed = false;
  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH);
    let result = String((await importBatch(chunk)) || '');
    if (!/(\d+) new, (\d+) duplicates/.test(result)) { await sleep(1500); result = String((await importBatch(chunk)) || ''); }
    const m = /(\d+) new, (\d+) duplicates/.exec(result);
    if (m) { fileNew += Number(m[1]); fileDup += Number(m[2]); }
    else { failed = true; break; } // app down/busy — stop; retry this file next run
    if (DELAY_MS > 0) await sleep(DELAY_MS);
  }

  if (failed) {
    appDown = true;
    totalFailed += items.length;
    // Do NOT advance HWM/state — the file is retried in full next run (idempotent).
    break; // app is down; no point hammering the rest
  }
  totalNew += fileNew; totalDup += fileDup;
  state[f] = { hwm: nextHwm, mtimeMs: st.mtimeMs, size: st.size };
}

saveState(state);

const summary = `[${now()}] sync: ${scanned} transcript(s) scanned, ${parsed} changed, ${considered} turn(s) considered → ${totalNew} new, ${totalDup} dup` +
  (appDown ? `, ${totalFailed} deferred (app :4711 down/busy — will retry)` : '') + ` · ${BASE_URL}`;
console.log(summary);
// Exit 0 even when the app was down: a launchd agent treating that as failure would
// spam its error path. The deferred work is simply retried on the next interval.
process.exit(0);
