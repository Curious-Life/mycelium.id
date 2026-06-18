#!/usr/bin/env node
/**
 * Compute territory SEMANTIC NEIGHBORS → populate `territory_neighbors`.
 *
 * This is the writer the "gaps" feature was missing. `db.topology.getGaps`
 * (src/db/topology.js) reads `territory_neighbors` to surface *semantically
 * close territories that don't co-fire* — the unexplored connections in your
 * mindscape. Nothing wrote that table (it was dead in the canonical system
 * too), so gaps were always empty. This stage fills it.
 *
 * Algorithm (mirrors the live `getOrphanGaps` cosine + the `realm_neighbors`
 * writer in cluster.py): for every active, non-catch-all territory with a
 * `centroid_256`, find its top-K nearest other territories by cosine similarity
 * and store directed rows (territory_id → neighbor_id) with
 * `distance = 1 - cosine_similarity` and `connection_type = 'semantic'`.
 * getGaps then reads `1 - distance` as the semantic similarity and excludes any
 * pair that already co-fires.
 *
 * MODULARITY: one file = one pipeline stage (sibling to compute-cofire.js). The
 * compute is exported as `computeTerritoryNeighbors({ db, userId, ... })` so it
 * is unit-testable against a booted vault (scripts/verify-territory-neighbors.mjs);
 * the CLI wrapper at the bottom only runs when the file is invoked directly.
 * Cosine math comes from the shared primitive (src/metrics/primitives.js, F1) —
 * one source of truth, no per-stage duplication.
 *
 * V1 single-user: reads/writes the local encrypted SQLite vault in-process via
 * src/db (no Worker proxy, scope always 'personal'). `centroid_256` is stored
 * plaintext (not in ENCRYPTED_FIELDS); db.rawQuery still round-trips it.
 *
 * Usage:
 *   USER_MASTER=<hex> SYSTEM_KEY=<hex> MYCELIUM_DB=./data/vault.db \
 *     node pipeline/compute-territory-neighbors.js [--dry-run]
 *
 * Tunables (env): MYCELIUM_NEIGHBOR_TOP_K (default 12),
 *                 MYCELIUM_NEIGHBOR_MIN_SIM (default 0.5).
 */

import { pathToFileURL } from 'node:url';
import { boot } from '../src/index.js';
import { cosineSim } from '../src/metrics/primitives.js';
import { createStageResult } from './lib/stage-result.js';

const DEFAULT_TOP_K = 12;
const DEFAULT_MIN_SIM = 0.5;

/**
 * Core stage: compute + persist semantic neighbors for every active territory.
 *
 * @param {object}   deps
 * @param {object}   deps.db        assembled db (needs db.rawQuery)
 * @param {string}   deps.userId    single-user scope id
 * @param {number}   [deps.topK]    neighbors stored per territory (default 12)
 * @param {number}   [deps.minSim]  minimum cosine similarity to store (default 0.5)
 * @param {boolean}  [deps.dryRun]  compute + report but don't write
 * @param {(s:string)=>void} [deps.log]  progress sink (default console.log)
 * @returns {Promise<{territories:number, pairs:number, written:number}>}
 */
export async function computeTerritoryNeighbors({ db, userId, topK = DEFAULT_TOP_K, minSim = DEFAULT_MIN_SIM, dryRun = false, log = console.log }) {
  if (!db?.rawQuery) throw new TypeError('computeTerritoryNeighbors: db.rawQuery required');
  if (typeof userId !== 'string') throw new TypeError('computeTerritoryNeighbors: userId required');

  const asArray = (r) => (Array.isArray(r) ? r : (r && Array.isArray(r.results) ? r.results : []));

  // Active, non-catch-all territories that carry a centroid.
  const rows = asArray(await db.rawQuery(
    `SELECT territory_id, centroid_256 FROM territory_profiles
     WHERE user_id = ? AND centroid_256 IS NOT NULL
       AND COALESCE(is_catchall, 0) = 0 AND dissolved_at IS NULL
       AND message_count > 0`,
    [userId],
  ));

  // Parse + normalize; drop anything malformed.
  const terts = [];
  let dim = null;
  for (const r of rows) {
    let vec;
    try {
      vec = typeof r.centroid_256 === 'string' ? JSON.parse(r.centroid_256) : r.centroid_256;
    } catch { continue; }
    if (!Array.isArray(vec) || vec.length === 0) continue;
    if (dim === null) dim = vec.length;
    if (vec.length !== dim) continue; // mismatched dimensionality — skip defensively
    terts.push({ id: r.territory_id, vec }); // raw; cosineSim normalizes internally
  }

  log(`[neighbors] ${terts.length} territories with usable centroids (dim=${dim ?? 'n/a'})`);
  if (terts.length < 2) {
    log('[neighbors] Fewer than 2 territories with centroids — nothing to compute.');
    return { territories: terts.length, pairs: 0, written: 0 };
  }

  // Top-K nearest neighbors per territory (directed rows), above the similarity floor.
  const pairs = []; // { tid, nid, distance }
  for (let i = 0; i < terts.length; i++) {
    const sims = [];
    for (let j = 0; j < terts.length; j++) {
      if (i === j) continue;
      const sim = cosineSim(terts[i].vec, terts[j].vec);
      if (sim >= minSim) sims.push({ nid: terts[j].id, sim });
    }
    sims.sort((a, b) => b.sim - a.sim);
    for (const { nid, sim } of sims.slice(0, topK)) {
      pairs.push({ tid: terts[i].id, nid, distance: Math.round((1 - sim) * 10000) / 10000 });
    }
  }

  log(`[neighbors] ${pairs.length} neighbor edges (topK=${topK}, minSim=${minSim})`);

  if (dryRun) {
    for (const p of pairs.slice(0, 10)) log(`    T${p.tid} → T${p.nid}: similarity=${(1 - p.distance).toFixed(4)}`);
    log(`[neighbors] (dry run) would replace territory_neighbors for user=${userId}`);
    return { territories: terts.length, pairs: pairs.length, written: 0 };
  }

  // Replace-all (idempotent rebuild), same pattern as compute-cofire / realm_neighbors.
  await db.rawQuery(`DELETE FROM territory_neighbors WHERE user_id = ?`, [userId]);

  const res = createStageResult('territory-neighbors', { record: db.pipelineState.recorderFor(userId, 'territory-neighbors') });
  let written = 0;
  for (const p of pairs) {
    try {
      await db.rawQuery(
        `INSERT INTO territory_neighbors (id, user_id, territory_id, neighbor_id, connection_type, distance)
         VALUES (?, ?, ?, ?, 'semantic', ?)`,
        [`${userId}:${p.tid}:${p.nid}`, userId, p.tid, p.nid, p.distance],
      );
      written++;
      res.ok();
    } catch (err) {
      res.fail(err);
      log(`[neighbors] insert failed for ${p.tid}→${p.nid}: ${err.message}`);
    }
  }

  // Fail loud on materially-incomplete output + record per-stage health.
  await res.finalize();
  log(`[neighbors] Done: ${written} semantic neighbor edges written`);
  return { territories: terts.length, pairs: pairs.length, written };
}

// ── CLI wrapper (only when invoked directly, never on import) ────────────────
async function runCli() {
  const USER_ID = process.env.MYCELIUM_USER_ID || 'local-user';
  const DB_PATH = process.env.MYCELIUM_DB || './data/vault.db';
  const USER_MASTER = process.env.USER_MASTER;
  const SYSTEM_KEY = process.env.SYSTEM_KEY;
  if (!USER_MASTER || !SYSTEM_KEY) {
    console.error('Missing: USER_MASTER and SYSTEM_KEY (64-char hex each)');
    process.exit(1);
  }
  const topK = Number(process.env.MYCELIUM_NEIGHBOR_TOP_K) || DEFAULT_TOP_K;
  const minSim = process.env.MYCELIUM_NEIGHBOR_MIN_SIM ? Number(process.env.MYCELIUM_NEIGHBOR_MIN_SIM) : DEFAULT_MIN_SIM;
  const dryRun = process.argv.includes('--dry-run');

  // boot() (NOT getDb-with-hex): unlock() turns the hex keys into CryptoKeys so the
  // adapter can auto-ENCRYPT territory_neighbors.distance (SEC-2). getDb-with-hex
  // throws "not of type CryptoKey" on the encrypted write → neighbors silently
  // empty in the spawned-CLI path (the in-process verify gate boots, so it passed).
  const { db, close } = await boot({ dbPath: DB_PATH, userHex: USER_MASTER, systemHex: SYSTEM_KEY, userId: USER_ID, embedder: null });
  try {
    await computeTerritoryNeighbors({ db, userId: USER_ID, topK, minSim, dryRun });
  } finally {
    close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((err) => { console.error('[neighbors] Fatal:', err); process.exit(1); });
}
