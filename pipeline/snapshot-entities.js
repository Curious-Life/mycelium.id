#!/usr/bin/env node
/**
 * Pipeline stage — append a per-entity DYNAMICS snapshot to the entity change-log
 * (ENTITY-HISTORY-DESIGN-2026-06-11). Runs after describe, every Generate. The
 * narrative history is hooked at the describe write sites; this stage captures the
 * other half: each live territory's + realm's dynamics (energy/coherence/velocity/
 * vitality/counts) at this moment, so the per-entity trajectory is preserved instead
 * of overwritten on territory_profiles each run.
 *
 * The SEC-3 scalars (energy/coherence/velocity/current_vitality/point_delta) are
 * ENCRYPTED on territory_profiles; reading via the adapter auto-decrypts them, and
 * db.history re-encrypts the assembled payload blob on write. Dedup-vs-latest means
 * identical back-to-back runs add no row. Best-effort + fail-soft: a snapshot miss
 * never blocks the pipeline.
 *
 * Usage (pipeline stage, after describe):
 *   USER_MASTER=<hex> SYSTEM_KEY=<hex> MYCELIUM_DB=./data/vault.db \
 *     node pipeline/snapshot-entities.js [--dry-run]
 */

import { getDb } from '../src/db/index.js';
import { loadKey } from '../src/crypto/keys.js';
import { resolveDbKeyHex } from '../src/db/open.js';
import { createStageResult } from './lib/stage-result.js';

const USER_ID = process.env.MYCELIUM_USER_ID || 'local-user';
const DB_PATH = process.env.MYCELIUM_DB || './data/vault.db';
const USER_MASTER = process.env.USER_MASTER;
const SYSTEM_KEY = process.env.SYSTEM_KEY;
const DRY_RUN = process.argv.includes('--dry-run');

if (!USER_MASTER || !SYSTEM_KEY) {
  console.error('[snapshot] Missing USER_MASTER and SYSTEM_KEY (64-char hex each)');
  process.exit(1);
}

/** Round a decrypted scalar to a number, or null. Keeps payloads stable + small so
 * float jitter in the last digits doesn't defeat the dedup. */
function num(v, dp = 4) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 10 ** dp) / 10 ** dp;
}

async function run() {
  // getDb + loadKey (CryptoKeys) + resolveDbKeyHex (the at-rest DB-file key). NOT boot():
  // boot runs initVaultStorage (schema + cross-process migration lock) + builds domains,
  // which deadlocks/alters state when a parent (a test, or the app) already holds the vault.
  // This opens the vault keyed — the one thing the old getDb-with-hex lacked — no side effects.
  const [userKey, systemKey] = await Promise.all([loadKey(USER_MASTER), loadKey(SYSTEM_KEY)]);
  const dbKeyHex = resolveDbKeyHex(USER_MASTER, DB_PATH);
  const { db, close } = getDb({ dbPath: DB_PATH, userKey, systemKey, scope: 'personal', dbKeyHex });
  const q = (sql, params = []) => db.rawQuery(sql, params).then((r) => (Array.isArray(r) ? r : r.results || []));
  let terr = 0, realms = 0, skipped = 0;
  try {
    if (!db.history?.recordSnapshot) { console.error('[snapshot] db.history unavailable — skipping'); return; }

    // STAGE ACCOUNTING (Gap #3). ⚠️ NOTE THE EXIT CONTRACT: this stage is deliberately fail-soft
    // (run-clustering.sh:165 "never blocks the cycle"; the bottom of this file exits 0 on any
    // throw), and that is NOT changed here. finalize() records to pipeline_state BEFORE it
    // throws, so a materially-incomplete snapshot becomes VISIBLE on the health surface while
    // the cycle still continues. Visibility without a new failure mode.
    const res = createStageResult('snapshot-entities', {
      record: db.pipelineState?.recorderFor?.(USER_ID, 'snapshot-entities'),
    });

    // Territories — live (non-dissolved) only; the SEC-3 scalars auto-decrypt on read.
    const territories = await q(
      `SELECT territory_id, energy, coherence, velocity, current_vitality, point_delta,
              message_count, growth_state, is_anchored, current_phase
       FROM territory_profiles WHERE user_id = ? AND dissolved_at IS NULL`,
      [USER_ID],
    ).catch(() => []);
    for (const t of territories) {
      const payload = {
        energy: num(t.energy), coherence: num(t.coherence), velocity: num(t.velocity),
        currentVitality: num(t.current_vitality), pointDelta: num(t.point_delta, 0),
        messageCount: num(t.message_count, 0), growthState: t.growth_state || null,
        currentPhase: t.current_phase || null, isAnchored: t.is_anchored ? 1 : 0,
      };
      if (DRY_RUN) { console.log(`[snapshot] (dry) territory ${t.territory_id}`); res.skip(); continue; }
      // ⚠️ THE CATCH USED TO SAY `({ skipped: true })` — a thrown WRITE ERROR was counted as
      // "unchanged", identical to the dedup-vs-latest no-op this stage does on purpose. That is
      // Gap #3 in one line: a failure wearing a benign outcome's clothes, so a systematically
      // broken recordSnapshot reported "(N unchanged)" and exited 0. Separated now: a throw is a
      // FAILURE, `{skipped:true}` from a successful call is a genuine skip.
      let r;
      try {
        r = await db.history.recordSnapshot(USER_ID, {
          entityKind: 'territory', entityId: t.territory_id, snapshotKind: 'dynamics', content: payload,
        });
      } catch (err) { res.fail(err); skipped += 1; continue; }
      if (r?.skipped) { res.skip(); skipped += 1; } else { res.ok(); terr += 1; }
    }

    // Realms — no SEC-3 scalars; the meaningful dynamics are the counts.
    const realmRows = await q(
      `SELECT realm_id, message_count, territory_count FROM realms WHERE user_id = ?`,
      [USER_ID],
    ).catch(() => []);
    for (const rm of realmRows) {
      const payload = { messageCount: num(rm.message_count, 0), territoryCount: num(rm.territory_count, 0) };
      if (DRY_RUN) { console.log(`[snapshot] (dry) realm ${rm.realm_id}`); res.skip(); continue; }
      let r;   // see the territory loop: a throw is a FAILURE, not "unchanged"
      try {
        r = await db.history.recordSnapshot(USER_ID, {
          entityKind: 'realm', entityId: rm.realm_id, snapshotKind: 'dynamics', content: payload,
        });
      } catch (err) { res.fail(err); skipped += 1; continue; }
      if (r?.skipped) { res.skip(); skipped += 1; } else { res.ok(); realms += 1; }
    }

    console.log(`[snapshot] dynamics: +${terr} territory · +${realms} realm versions (${skipped} unchanged)`);
    await res.finalize();   // records to pipeline_state; must run while the db is open
  } finally {
    close();
  }
}

run().catch((err) => { console.error('[snapshot] non-fatal:', err.message); process.exit(0); });
