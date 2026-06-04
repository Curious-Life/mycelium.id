#!/usr/bin/env node
/**
 * Lempel-Ziv Complexity — V1 single-user port of scripts/compute-complexity.js.
 *
 * Measures how compressible thinking patterns are, at three levels:
 *   - Per-territory: daily-activity-level sequence within each territory
 *   - Per-realm:     territory-transition sequence within each realm
 *   - Global:        territory-transition sequence across all messages
 *
 * Higher normalized complexity = novel/exploratory; lower = repetitive/stuck.
 * Stores time-series snapshots in complexity_snapshots.
 *
 * V1 single-user port: reads/writes the local encrypted SQLite vault in-process
 * via src/db (no Worker proxy, scope always 'personal'). The cloud script split
 * cluster-user vs portal-user ids; V1 is single-user so there's exactly one id.
 * Uses the shared LZ primitive (src/metrics/primitives.js lzComplexity) — one
 * source of truth (matches the cloud @mycelium/metrics primitive).
 *
 * ── T1 FIX: encrypt level_name ──
 * The canonical stored level_name (a territory / realm NAME) as PLAINTEXT.
 * Names are verbatim content (territory_profiles.name + realms.name are both
 * ENCRYPTED in V1), so a plaintext level_name leaked them. level_name is now in
 * ENCRYPTED_FIELDS.complexity_snapshots → the adapter auto-encrypts it on the
 * INSERT and auto-decrypts on read. The metric scalars (lz_complexity,
 * raw_complexity, sequence_length, alphabet_size, point_count) are also
 * encrypted (derived signal). level / level_id / window_* stay plaintext (keys +
 * the UPSERT conflict target). No SQL filters/sorts/aggregates over the encrypted
 * columns, so nothing to rework.
 *
 * Never logs level_name or metric values — counts + level only.
 *
 * Usage:
 *   USER_MASTER=<hex> SYSTEM_KEY=<hex> MYCELIUM_DB=./data/vault.db \
 *     node pipeline/compute-complexity.js [--dry-run] [--window <days>]
 */

import { pathToFileURL } from 'node:url';
import { lzComplexity } from '../src/metrics/primitives.js';

const DEFAULT_WINDOW_DAYS = 90;

function computeTerritoryComplexity(points, nameMap, log) {
  // Group points by territory.
  const byTerritory = new Map();
  for (const r of points) {
    if (r.territory_id == null) continue;
    if (!byTerritory.has(r.territory_id)) byTerritory.set(r.territory_id, []);
    byTerritory.get(r.territory_id).push(r);
  }

  const results = [];
  for (const [territoryId, pts] of byTerritory) {
    if (pts.length < 5) continue; // need enough data

    // Sequence = daily activity level quantized to 0–5.
    const dayCounts = new Map();
    for (const p of pts) {
      const day = (p.created_at || '').slice(0, 10);
      dayCounts.set(day, (dayCounts.get(day) || 0) + 1);
    }
    const days = [...dayCounts.keys()].sort();
    const maxCount = Math.max(...dayCounts.values());
    const quantize = (c) => Math.min(5, Math.floor((c / Math.max(maxCount, 1)) * 5));
    const sequence = days.map((d) => quantize(dayCounts.get(d)));

    const result = lzComplexity(sequence);
    results.push({
      level: 'territory',
      level_id: territoryId,
      level_name: nameMap.get(territoryId) || `Territory ${territoryId}`,
      ...result,
      pointCount: pts.length,
    });
  }
  log(`[complexity]   ${results.length} territories analyzed`);
  return results;
}

function computeRealmComplexity(points, realmNames, log) {
  const byRealm = new Map();
  for (const r of points) {
    if (r.realm_id == null || r.territory_id == null) continue;
    if (!byRealm.has(r.realm_id)) byRealm.set(r.realm_id, []);
    byRealm.get(r.realm_id).push(r);
  }

  const results = [];
  for (const [realmId, pts] of byRealm) {
    if (pts.length < 10) continue;
    const sequence = pts.map((p) => p.territory_id); // territory-transition sequence
    const result = lzComplexity(sequence);
    results.push({
      level: 'realm',
      level_id: realmId,
      level_name: realmNames.get(realmId) || `Realm ${realmId}`,
      ...result,
      pointCount: pts.length,
    });
  }
  log(`[complexity]   ${results.length} realms analyzed`);
  return results;
}

function computeGlobalComplexity(points, log) {
  const seq = points.filter((r) => r.territory_id != null).map((r) => r.territory_id);
  if (seq.length < 10) {
    log('[complexity]   not enough data for global complexity');
    return [];
  }
  const result = lzComplexity(seq);
  return [{
    level: 'global',
    level_id: null,
    level_name: 'Global',
    ...result,
    pointCount: seq.length,
  }];
}

/**
 * Core stage. Exported for the verify gate.
 * @returns {Promise<{snapshots:number, written:number, territory:number, realm:number, global:number}>}
 */
export async function computeComplexity({ db, userId, windowDays = DEFAULT_WINDOW_DAYS, dryRun = false, log = console.log }) {
  if (!db?.rawQuery) throw new TypeError('computeComplexity: db.rawQuery required');
  if (typeof userId !== 'string') throw new TypeError('computeComplexity: userId required');
  const asArray = (r) => (Array.isArray(r) ? r : (r && Array.isArray(r.results) ? r.results : []));

  const windowStart = new Date(Date.now() - windowDays * 86400000).toISOString();
  const windowEnd = new Date().toISOString().slice(0, 10);

  // clustering_points: territory_id/realm_id/created_at are all PLAINTEXT
  // structural columns → SQL filter is valid.
  const points = asArray(await db.rawQuery(
    `SELECT territory_id, realm_id, created_at FROM clustering_points
     WHERE user_id = ? AND territory_id IS NOT NULL AND created_at >= ?
     ORDER BY created_at`,
    [userId, windowStart],
  ));
  log(`[complexity] ${points.length} points in ${windowDays}-day window`);

  // Names: territory_profiles.name + realms.name are ENCRYPTED → the adapter
  // decrypts them on read; we feed them into level_name which is re-encrypted on
  // write (idempotent — encryptablePlaintext skips values already enveloped, but
  // decrypted plaintext gets a fresh envelope).
  const profiles = asArray(await db.rawQuery(
    `SELECT territory_id, name FROM territory_profiles WHERE user_id = ?`, [userId]));
  const nameMap = new Map(profiles.map((p) => [p.territory_id, p.name]));
  const realmRows = asArray(await db.rawQuery(
    `SELECT realm_id, name FROM realms WHERE user_id = ?`, [userId]));
  const realmNames = new Map(realmRows.map((r) => [r.realm_id, r.name]));

  const territoryResults = computeTerritoryComplexity(points, nameMap, log);
  const realmResults = computeRealmComplexity(points, realmNames, log);
  const globalResults = computeGlobalComplexity(points, log);
  const allResults = [...territoryResults, ...realmResults, ...globalResults];

  log(`[complexity] ${allResults.length} snapshots (territory=${territoryResults.length} realm=${realmResults.length} global=${globalResults.length})`);

  if (dryRun) {
    log('[complexity] Dry run — not writing');
    return { snapshots: allResults.length, written: 0, territory: territoryResults.length, realm: realmResults.length, global: globalResults.length };
  }

  let written = 0;
  for (const r of allResults) {
    try {
      // UPSERT: conflict target (user_id, level, level_id, window_end) is all
      // PLAINTEXT, so dedup works. The DO UPDATE re-binds the encrypted metric
      // columns (the adapter encrypts them); level_name is updated too.
      await db.rawQuery(
        `INSERT INTO complexity_snapshots
           (user_id, level, level_id, level_name, lz_complexity, raw_complexity,
            sequence_length, alphabet_size, window_start, window_end, point_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, level, level_id, window_end) DO UPDATE SET
           level_name = excluded.level_name,
           lz_complexity = excluded.lz_complexity,
           raw_complexity = excluded.raw_complexity,
           sequence_length = excluded.sequence_length,
           alphabet_size = excluded.alphabet_size,
           point_count = excluded.point_count,
           computed_at = datetime('now')`,
        [userId, r.level, r.level_id, r.level_name, r.normalized, r.complexity,
         r.sequenceLength, r.alphabetSize, windowStart.slice(0, 10), windowEnd, r.pointCount],
      );
      written++;
    } catch (err) {
      log(`[complexity] insert failed for ${r.level}/${r.level_id}: ${err.message}`);
    }
  }

  log(`[complexity] Done: ${written}/${allResults.length} snapshots written`);
  return { snapshots: allResults.length, written, territory: territoryResults.length, realm: realmResults.length, global: globalResults.length };
}

// ── CLI wrapper ──────────────────────────────────────────────────────────────
// boot() (NOT getDb-with-hex): unlock() turns the hex keys into CryptoKeys so the
// adapter's auto-encrypt of level_name + metric columns actually runs (see
// compute-vitality.js for the rationale).
async function runCli() {
  const USER_ID = process.env.MYCELIUM_USER_ID || 'local-user';
  const DB_PATH = process.env.MYCELIUM_DB || './data/vault.db';
  if (!process.env.USER_MASTER || !process.env.SYSTEM_KEY) {
    console.error('Missing: USER_MASTER and SYSTEM_KEY (64-char hex each)');
    process.exit(1);
  }
  const dryRun = process.argv.includes('--dry-run');
  const wIdx = process.argv.indexOf('--window');
  const windowDays = wIdx >= 0 ? (parseInt(process.argv[wIdx + 1], 10) || DEFAULT_WINDOW_DAYS) : DEFAULT_WINDOW_DAYS;

  const { boot } = await import('../src/index.js');
  const { db, close } = await boot({
    dbPath: DB_PATH,
    userHex: process.env.USER_MASTER,
    systemHex: process.env.SYSTEM_KEY,
    userId: USER_ID,
    embedder: null,
  });
  try {
    await computeComplexity({ db, userId: USER_ID, windowDays, dryRun });
  } finally {
    close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((err) => { console.error('[complexity] Fatal:', err); process.exit(1); });
}
