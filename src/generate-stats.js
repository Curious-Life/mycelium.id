// src/generate-stats.js — persist the last Generate run's wall-clock duration so
// the UI can show a real ETA from the moment a run starts (not only once steps
// complete). Single-user / local: a tiny JSON file in the data dir. Best-effort —
// a stats read/write must NEVER block or fail a clustering run.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './paths.js';

const statsPath = () => join(dataDir(), 'generate-stats.json');

/** @returns {{ lastDurationMs:number, lastMessages:number|null, at:number }|null} */
export function readGenerateStats() {
  try { return JSON.parse(readFileSync(statsPath(), 'utf8')); }
  catch { return null; }
}

export function writeGenerateStats({ durationMs, messages = null }) {
  try {
    writeFileSync(statsPath(), JSON.stringify({ lastDurationMs: durationMs, lastMessages: messages, at: Date.now() }));
  } catch { /* best-effort — never block a run on stats */ }
}
