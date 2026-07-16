// src/db/durability-log.js — the vault's incident black box.
//
// Five corruption events in two weeks left ZERO forensic record: the app wrote no log
// (stderr is discarded on a Finder launch), kept no event history, and the only evidence
// was operator-made archive filenames — which were then deleted to reclaim disk, taking
// the whole trail with them. Root-causing took days of live experiments that one JSONL
// line per event would have replaced.
//
// This is an append-only JSONL at <dataDir>/durability-events.jsonl. One line per event:
// corruption detected, foreign WAL quarantined, uncaught crash, integrity verdicts, swap
// installs. CONTENT-FREE by construction (§1): error CODES, file metadata, counts —
// never message text, never keys, never paths outside dataDir.
//
// Fail-soft everywhere: the black box must never take the plane down.

import { appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs';
import path from 'node:path';
import { dataDir } from '../paths.js';

const FILE = 'durability-events.jsonl';
const MAX_BYTES = 5 * 1024 * 1024; // rotate at 5MB — years of events; one .1 generation kept

function eventPath() { return path.join(dataDir(), FILE); }

function rotateIfHuge(p) {
  try { if (statSync(p).size > MAX_BYTES) renameSync(p, `${p}.1`); } catch { /* absent/best-effort */ }
}

/**
 * Append one durability event. Never throws.
 * @param {string} kind e.g. 'sqlite-corrupt' | 'foreign-wal-quarantined' | 'uncaught-exception'
 *                      | 'integrity-check' | 'vault-installed' | 'process-exit'
 * @param {object} [fields] content-free details (codes, counts, file metadata)
 */
export function recordDurabilityEvent(kind, fields = {}) {
  try {
    const p = eventPath();
    mkdirSync(path.dirname(p), { recursive: true });
    rotateIfHuge(p);
    appendFileSync(p, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, kind, ...fields }) + '\n');
    return true;
  } catch { return false; }
}

/** Is this error SQLite corruption? (code or message — better-sqlite3 sets .code) */
export function isCorruptionError(err) {
  const c = String(err?.code || '');
  if (c === 'SQLITE_CORRUPT' || c.startsWith('SQLITE_CORRUPT_')) return true;
  return /database disk image is malformed/i.test(String(err?.message || ''));
}

export default recordDurabilityEvent;
