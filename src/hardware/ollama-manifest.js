// Pulled-model manifest — records every Ollama model tag Mycelium pulls, so a
// destroy-vault (factory reset) can remove the ones that landed in the user's
// SHARED ~/.ollama (the adopt-an-already-running-daemon case). Models Mycelium
// spawned into its app-private <dataDir>/ollama are removed by the recursive dir
// wipe; only the shared-daemon case needs a tracked tag list (we must never
// blanket-`rm ~/.ollama` — it holds the user's own models). Locked decision #2,
// the destroy-vault design.
//
// Persisted OUTSIDE the vault DB (a small <dataDir>/ollama-pulled.json) so it
// survives to destroy time even with the DB unavailable. Best-effort: a failure
// to record never breaks a pull; a missing/garbled file reads as empty.

import { promises as nodeFs } from 'node:fs';
import { join } from 'node:path';
import { dataDir as defaultDataDir } from '../paths.js';

const FILE = 'ollama-pulled.json';
const manifestPath = (dir) => join(dir || defaultDataDir(), FILE);

/** Record a pulled model tag (idempotent, best-effort). */
export async function recordPulledModel(name, { dataDir, fs = nodeFs } = {}) {
  if (typeof name !== 'string' || !name.trim()) return;
  const p = manifestPath(dataDir);
  const list = await readPulledModels({ dataDir, fs });
  if (list.includes(name)) return;
  list.push(name);
  try { await fs.writeFile(p, JSON.stringify(list), { mode: 0o600 }); } catch { /* best-effort */ }
}

/** Read the tracked tag list (empty on missing/garbled). */
export async function readPulledModels({ dataDir, fs = nodeFs } = {}) {
  try {
    const parsed = JSON.parse(await fs.readFile(manifestPath(dataDir), 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string' && x) : [];
  } catch { return []; }
}

/**
 * Build the destroy-time `deleteOllamaModels(tags)` hook from an ollama client
 * (src/hardware/ollama.js — has deleteModel). Best-effort: never throws; returns
 * which tags were removed vs failed. A daemon that's already down → all failed,
 * which the destroy job records but does not block on.
 * @param {{deleteModel:(name:string)=>Promise<{ok:boolean,notFound?:boolean}>}} client
 */
export function makeDeleteOllamaModels(client) {
  return async function deleteOllamaModels(tags) {
    const removed = [];
    const failed = [];
    for (const tag of tags || []) {
      try {
        const r = await client.deleteModel(tag);
        if (r?.ok || r?.notFound) removed.push(tag); else failed.push(tag);
      } catch { failed.push(tag); }
    }
    return { removed, failed };
  };
}
