// src/generate-stats.js — persist the last Generate run's wall-clock duration so
// the UI can show a real ETA from the moment a run starts (not only once steps
// complete). Single-user / local: a tiny JSON file in the data dir. Best-effort —
// a stats read/write must NEVER block or fail a clustering run.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './paths.js';

const statsPath = () => join(dataDir(), 'generate-stats.json');

/**
 * `lastEmbedded` is the FRESHNESS BASELINE (D-004): the embedded-message count at the moment
 * the last real clustering run completed. src/mindscape-freshness.js compares the CURRENT
 * embedded count against it to decide whether the map has fallen behind. It is null on a vault
 * whose map predates this field — the freshness module has an explicit, bounded fallback for
 * that (see its header), and the first rebuild fills it in.
 * @returns {{ lastDurationMs:number, lastMessages:number|null, lastEmbedded:number|null, at:number }|null}
 */
export function readGenerateStats() {
  try { return JSON.parse(readFileSync(statsPath(), 'utf8')); }
  catch { return null; }
}

/**
 * ⚠️ ONE write, BOTH facts. This file is overwritten wholesale, so a caller that wrote only
 * `durationMs` would silently erase the freshness baseline and send the map back to the
 * fallback comparison. Every caller passes what it knows; `embedded` omitted preserves the
 * previously recorded baseline rather than nulling it.
 */
export function writeGenerateStats({ durationMs, messages = null, embedded = undefined }) {
  try {
    const prev = readGenerateStats();
    const lastEmbedded = embedded === undefined
      ? (Number.isFinite(Number(prev?.lastEmbedded)) ? Number(prev.lastEmbedded) : null)
      : (Number.isFinite(Number(embedded)) ? Number(embedded) : null);
    writeFileSync(statsPath(), JSON.stringify({ lastDurationMs: durationMs, lastMessages: messages, lastEmbedded, at: Date.now() }));
  } catch { /* best-effort — never block a run on stats */ }
}
