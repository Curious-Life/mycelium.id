#!/usr/bin/env node
/**
 * Compute territory co-firing from clustering_points.
 *
 * Two territories "co-fire" when messages in both appear in the same time window.
 * Computes 4 timescales:
 *   - immediate: same hour
 *   - session:   same 4-hour block
 *   - daily:     same calendar day
 *   - weekly:    same ISO week
 *
 * Strength = count of co-occurrences with exponential time decay (half-life varies by scale).
 *
 * V1 single-user port: reads/writes the local encrypted SQLite vault directly
 * through the in-process db adapter (no Worker proxy, no MINDSCAPE_OWNER_ID /
 * AGENT_ID scope plumbing). The single user scope is always 'personal'.
 *
 * Usage:
 *   USER_MASTER=<hex> SYSTEM_KEY=<hex> MYCELIUM_DB=./data/vault.db node pipeline/compute-cofire.js
 */

import { boot } from '../src/index.js';
import { createStageResult } from './lib/stage-result.js';

const USER_ID = process.env.MYCELIUM_USER_ID || 'local-user';
const DB_PATH = process.env.MYCELIUM_DB || './data/vault.db';
const USER_MASTER = process.env.USER_MASTER;
const SYSTEM_KEY = process.env.SYSTEM_KEY;

if (!USER_MASTER || !SYSTEM_KEY) {
  console.error('Missing: USER_MASTER and SYSTEM_KEY (64-char hex each)');
  process.exit(1);
}

// Time window functions
function hourKey(dt) { return dt.toISOString().slice(0, 13); } // YYYY-MM-DDTHH
function sessionKey(dt) { // 4-hour blocks
  const h = dt.getUTCHours();
  const block = Math.floor(h / 4) * 4;
  return dt.toISOString().slice(0, 10) + 'T' + String(block).padStart(2, '0');
}
function dayKey(dt) { return dt.toISOString().slice(0, 10); } // YYYY-MM-DD
function weekKey(dt) { // ISO week
  const d = new Date(dt);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d - new Date(Date.UTC(year, 0, 1))) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

// Half-lives for time decay (in days)
const HALF_LIVES = { immediate: 7, session: 14, daily: 30, weekly: 90 };

function decay(daysAgo, halfLife) {
  return Math.pow(0.5, daysAgo / halfLife);
}

async function run() {
  // boot() (NOT getDb-with-hex): unlock() turns the hex keys into CryptoKeys so the
  // adapter can auto-ENCRYPT the cofire_* columns (SEC-2). getDb-with-hex throws
  // "argument is not of type CryptoKey" on every encrypted write and the per-row
  // catch swallows it → territory_cofire silently empty in the spawned-CLI path.
  const { db, close } = await boot({ dbPath: DB_PATH, userHex: USER_MASTER, systemHex: SYSTEM_KEY, userId: USER_ID, embedder: null });
  const query = (sql, params = []) => db.rawQuery(sql, params).then(r => (Array.isArray(r) ? r : r.results || []));

  try {
    const USER_ID_LOCAL = USER_ID;
    const res = createStageResult('cofire', { record: db.pipelineState.recorderFor(USER_ID_LOCAL, 'cofire') });
    console.log(`[cofire] Computing co-firing for user=${USER_ID_LOCAL}`);

    // Fetch all points with territory assignments
    const points = await query(
      `SELECT territory_id, created_at FROM clustering_points
       WHERE user_id = ? AND territory_id IS NOT NULL
       ORDER BY created_at`,
      [USER_ID_LOCAL],
    );

    console.log(`[cofire] ${points.length} points with territory assignments`);

    if (points.length === 0) {
      console.log('[cofire] No data. Exiting.');
      return;
    }

    // Exclude catch-all territories from co-firing computation
    const catchAllRows = await query(
      `SELECT territory_id FROM territory_profiles WHERE user_id = ? AND is_catchall = 1`,
      [USER_ID_LOCAL],
    );
    const catchAllSet = new Set(catchAllRows.map(r => r.territory_id));
    if (catchAllSet.size > 0) {
      console.log(`[cofire] Excluding ${catchAllSet.size} catch-all territories: ${[...catchAllSet].join(', ')}`);
    }

    const now = Date.now();

    // Group points by time windows
    const windows = {
      immediate: new Map(), // hourKey → Set<territory_id>
      session: new Map(),   // sessionKey → Set<territory_id>
      daily: new Map(),     // dayKey → Set<territory_id>
      weekly: new Map(),    // weekKey → Set<territory_id>
    };

    // Also track window dates for decay
    const windowDates = {
      immediate: new Map(),
      session: new Map(),
      daily: new Map(),
      weekly: new Map(),
    };

    for (const p of points) {
      const dt = new Date(p.created_at);
      const tid = p.territory_id;
      if (catchAllSet.has(tid)) continue;

      for (const [scale, keyFn] of [['immediate', hourKey], ['session', sessionKey], ['daily', dayKey], ['weekly', weekKey]]) {
        const key = keyFn(dt);
        if (!windows[scale].has(key)) {
          windows[scale].set(key, new Set());
          windowDates[scale].set(key, dt);
        }
        windows[scale].get(key).add(tid);
      }
    }

    console.log(`[cofire] Windows: immediate=${windows.immediate.size}, session=${windows.session.size}, daily=${windows.daily.size}, weekly=${windows.weekly.size}`);

    // Compute co-firing: for each window, every pair of territories in it co-fires
    const cofire = new Map(); // "a:b" → { immediate, session, daily, weekly, lastAt }

    function pairKey(a, b) {
      return a < b ? `${a}:${b}` : `${b}:${a}`;
    }

    for (const scale of ['immediate', 'session', 'daily', 'weekly']) {
      const halfLife = HALF_LIVES[scale];
      let windowCount = 0;

      for (const [key, territories] of windows[scale]) {
        if (territories.size < 2) continue; // need at least 2 territories to co-fire
        windowCount++;

        const tids = [...territories];
        const windowDate = windowDates[scale].get(key);
        const daysAgo = (now - windowDate.getTime()) / (1000 * 60 * 60 * 24);
        const weight = decay(daysAgo, halfLife);

        // All pairs in this window
        for (let i = 0; i < tids.length; i++) {
          for (let j = i + 1; j < tids.length; j++) {
            const pk = pairKey(tids[i], tids[j]);
            if (!cofire.has(pk)) {
              cofire.set(pk, { a: Math.min(tids[i], tids[j]), b: Math.max(tids[i], tids[j]), immediate: 0, session: 0, daily: 0, weekly: 0, lastAt: null });
            }
            const entry = cofire.get(pk);
            entry[scale] += weight;
            if (!entry.lastAt || windowDate > new Date(entry.lastAt)) {
              entry.lastAt = windowDate.toISOString();
            }
          }
        }
      }
      console.log(`[cofire] ${scale}: ${windowCount} multi-territory windows processed`);
    }

    // Filter: only keep pairs with meaningful co-firing (daily >= 1 OR session >= 0.5)
    const significant = [...cofire.values()].filter(e => e.daily >= 1 || e.session >= 0.5);
    console.log(`[cofire] ${cofire.size} total pairs → ${significant.length} significant (daily>=1 or session>=0.5)`);

    // Clear old cofire data
    await query(`DELETE FROM territory_cofire WHERE user_id = ?`, [USER_ID_LOCAL]);
    console.log('[cofire] Old data cleared');

    // Insert significant pairs only
    const entries = significant;
    let inserted = 0;

    for (const e of entries) {
      const sql = `INSERT INTO territory_cofire (id, user_id, territory_a, territory_b, cofire_immediate, cofire_session, cofire_daily, cofire_weekly, last_cofire_at, last_computed)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`;
      const params = [
        `${USER_ID_LOCAL}:${e.a}:${e.b}`,
        USER_ID_LOCAL, e.a, e.b,
        Math.round(e.immediate * 1000) / 1000,
        Math.round(e.session * 1000) / 1000,
        Math.round(e.daily * 1000) / 1000,
        Math.round(e.weekly * 1000) / 1000,
        e.lastAt,
      ];
      try {
        await query(sql, params);
        inserted++;
        res.ok();
      } catch (err) {
        res.fail(err);
        console.error(`[cofire] Insert failed for ${e.a}:${e.b}:`, err.message);
      }

      if (inserted % 500 === 0 || inserted === entries.length) {
        console.log(`[cofire] Progress: ${inserted}/${entries.length} pairs inserted`);
      }
    }

    console.log(`[cofire] Done: ${inserted} co-firing pairs computed and stored`);
    // Fail loud if the write was materially incomplete (e.g. a systematic encrypted-
    // write regression) + record per-stage health to pipeline_state. Throws →
    // run().catch → exit 1 → run-clustering.sh (set -e) aborts → jobs.js names it.
    await res.finalize();
  } finally {
    close();
  }
}

run().catch(err => { console.error('[cofire] Fatal:', err); process.exit(1); });
