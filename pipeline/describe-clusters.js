#!/usr/bin/env node
/**
 * Generate realm + territory names/essences from clustered points.
 *
 * Populates `realms` and `territory_profiles` with human-readable names and
 * essences so the portal/3D view has labels. For each unnamed realm/territory,
 * samples representative member messages and asks the LOCAL Claude CLI to name
 * + summarize them — plaintext never leaves the VPS (the canonical design
 * rejected a cloud-model variant for exactly this reason).
 *
 * V1 single-user port:
 *   - Reads/writes the local encrypted SQLite vault via the in-process db
 *     adapter (no Worker proxy, no MINDSCAPE_OWNER_ID / AGENT_ID scope
 *     plumbing). The single user scope is always 'personal'.
 *   - If the Claude CLI is unavailable, falls back to deterministic
 *     placeholder names so the pipeline still completes (fail-soft on the
 *     describe step; the structural clustering is what matters).
 *
 * Usage:
 *   USER_MASTER=<hex> SYSTEM_KEY=<hex> MYCELIUM_DB=./data/vault.db \
 *     node pipeline/describe-clusters.js [--dry-run]
 */

import crypto from 'node:crypto';
import { getDb } from '../src/db/index.js';
import { loadKey } from '../src/crypto/keys.js';
import { createNarrator } from './lib/narrate-infer.js';

const USER_ID = process.env.MYCELIUM_USER_ID || 'local-user';
const DB_PATH = process.env.MYCELIUM_DB || './data/vault.db';
const USER_MASTER = process.env.USER_MASTER;
const SYSTEM_KEY = process.env.SYSTEM_KEY;
const DRY_RUN = process.argv.includes('--dry-run');
// Bypass the input-signature skip and re-narrate everything (recovery hatch).
const FORCE = process.argv.includes('--force') || process.env.MYCELIUM_DESCRIBE_FORCE === '1';

/**
 * Change-detection signature for a cluster's describe input: SHA-256 over the
 * sampled message IDs (random UUIDs — never content-derived, so the plaintext
 * hash leaks nothing about plaintext) + the cluster's live point count. Same
 * sample + same count → narration input is literally identical → skip. Stored
 * in the (previously vestigial) plaintext describe_input_hash column.
 */
function inputSignature(sampleIds, pointCount) {
  return crypto.createHash('sha256')
    .update(JSON.stringify([...sampleIds, Number(pointCount) || 0]))
    .digest('hex');
}

/** Append the first-pass name/essence to the entity change-log (best-effort —
 * a history miss must never fail describe). Only called on a real narration;
 * dedup-vs-latest in db.history drops no-op repeats. The fuller chronicle prose
 * lands as a later version via describe-chronicles. */
async function recordName(db, entityKind, entityId, name, essence) {
  if (!db.history?.recordSnapshot) return;
  try {
    await db.history.recordSnapshot(USER_ID, {
      entityKind, entityId, snapshotKind: 'narrative',
      content: { name, essence }, meta: { stage: 'name' },
    });
  } catch { /* history is best-effort */ }
}

if (!USER_MASTER || !SYSTEM_KEY) {
  console.error('Missing: USER_MASTER and SYSTEM_KEY (64-char hex each)');
  process.exit(1);
}

/**
 * Name + summarize a cluster with the user's ACTIVE provider (the model selected in
 * Settings → Intelligence). Returns null on any failure so the caller can fall back
 * to a deterministic placeholder (fail-soft: a describe miss never blocks Generate).
 */
async function describe(narrator, kind, samples) {
  const prompt = [
    `You are naming a ${kind} in a personal knowledge graph.`,
    `Below are representative snippets that belong to this ${kind}.`,
    `Reply with EXACTLY one line of minified JSON: {"name": "<2-4 word title>", "essence": "<one sentence>"}.`,
    '',
    ...samples.map((s, i) => `(${i + 1}) ${s.slice(0, 300)}`),
  ].join('\n');
  try {
    const raw = await narrator.infer(prompt, { maxTokens: 300 });
    const m = String(raw).match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : null;
    if (parsed && typeof parsed.name === 'string' && parsed.name.trim()) {
      return { name: parsed.name.trim().slice(0, 80), essence: (parsed.essence || '').slice(0, 500) };
    }
  } catch (err) {
    console.error(`[describe] ${kind} narration failed: ${err?.message || err}`);
  }
  return null;
}

async function run() {
  // The encrypting adapter needs imported HKDF CryptoKeys (not raw hex) — writing
  // an ENCRYPTED_FIELDS column (name/essence) otherwise throws deriveBits.
  const [userKey, systemKey] = await Promise.all([loadKey(USER_MASTER), loadKey(SYSTEM_KEY)]);
  const { db, close } = getDb({ dbPath: DB_PATH, userKey, systemKey, scope: 'personal' });
  const query = (sql, params = []) => db.rawQuery(sql, params).then(r => (Array.isArray(r) ? r : r.results || []));
  const narrator = await createNarrator({ db, userId: USER_ID });
  let namedRealms = 0, namedTerr = 0;
  // Surface live progress to the unified activity feed (header + mindscape chip).
  // Content-free: only a constant stage label + done/total — never a realm name.
  let feedId = null, done = 0, hbTimer = null;
  const tick = async (total) => { try { await db.activityFeed.heartbeat(feedId, { step: ++done, totalSteps: total }); } catch { /* */ } };

  try {
    console.log(`[describe] Naming realms + territories for user=${USER_ID} via ${narrator.label}${narrator.local ? ' (local)' : ''}${DRY_RUN ? ' (dry-run)' : ''}`);
    if (!DRY_RUN) {
      try { feedId = await db.activityFeed.begin({ userId: USER_ID, kind: 'describe:name', stageLabel: 'Naming areas' }); } catch { /* */ }
      // Refresh liveness every 10s regardless of per-item progress — a cold first
      // model call can exceed the reaper's stale window, which would falsely abandon
      // the row mid-run. The heartbeat (no step change) keeps it 'running'.
      if (feedId) { hbTimer = setInterval(() => { db.activityFeed.heartbeat(feedId, {}).catch(() => {}); }, 10_000); hbTimer.unref?.(); }
    }

    // ── Realms ──────────────────────────────────────────────────────
    const realmIds = await query(
      `SELECT DISTINCT realm_id FROM clustering_points
       WHERE user_id = ? AND realm_id IS NOT NULL`,
      [USER_ID],
    );
    // Fetch both sets up front so the activity feed has a stable total (queued).
    const terrIds = await query(
      `SELECT DISTINCT territory_id, realm_id FROM clustering_points
       WHERE user_id = ? AND territory_id IS NOT NULL`,
      [USER_ID],
    );
    const total = realmIds.length + terrIds.length;
    console.log(`[describe] ${realmIds.length} realms · ${terrIds.length} territories`);
    if (feedId) { try { await db.activityFeed.heartbeat(feedId, { totalSteps: total }); } catch { /* */ } }

    let skippedRealms = 0;
    for (const { realm_id } of realmIds) {
      const samples = await sampleContent(query, 'realm_id', realm_id);
      // Real counts from live points — no other stage maintains these, and the
      // search corpus ranks realms by message_count (zeros = arbitrary order).
      const [counts = {}] = await query(
        `SELECT COUNT(*) AS mc,
                COUNT(DISTINCT CASE WHEN territory_id >= 0 THEN territory_id END) AS tc
         FROM clustering_points WHERE user_id = ? AND realm_id = ?`,
        [USER_ID, realm_id],
      ).catch(() => []);
      const sig = inputSignature(samples.map((s) => s.id), counts.mc);
      const [existing] = await query(
        `SELECT name, describe_input_hash FROM realms WHERE user_id = ? AND realm_id = ?`,
        [USER_ID, realm_id],
      ).catch(() => []);

      // Skip-if-unchanged: named + identical narration input → no inference.
      // Counts stay fresh (describe owns realm counters).
      if (!FORCE && existing?.name && existing.describe_input_hash === sig) {
        skippedRealms += 1;
        if (DRY_RUN) { console.log(`[describe] (dry) realm ${realm_id} unchanged — skip`); continue; }
        await query(
          `UPDATE realms SET territory_count = ?, message_count = ?, updated_at = datetime('now')
           WHERE user_id = ? AND realm_id = ?`,
          [counts.tc ?? 0, counts.mc ?? 0, USER_ID, realm_id],
        ).catch(err => console.error(`[describe] realm ${realm_id} count update failed:`, err.message));
        await tick(total);
        continue;
      }

      const described = samples.length ? await describe(narrator, 'realm', samples.map((s) => s.content)) : null;
      if (described) namedRealms += 1;
      if (DRY_RUN) {
        console.log(`[describe] (dry) realm ${realm_id} → "${described?.name || `Realm ${realm_id}`}"`);
        continue;
      }
      if (!described && existing?.name) {
        // Clobber guard: narration failed but the realm already has a real name —
        // keep it (old hash stays ≠ sig, so the next run retries narration).
        await query(
          `UPDATE realms SET territory_count = ?, message_count = ?, updated_at = datetime('now')
           WHERE user_id = ? AND realm_id = ?`,
          [counts.tc ?? 0, counts.mc ?? 0, USER_ID, realm_id],
        ).catch(err => console.error(`[describe] realm ${realm_id} count update failed:`, err.message));
        await tick(total);
        continue;
      }
      // Success → write name + signature. Failure on an UNNAMED realm → placeholder
      // for UX, but hash stays NULL so every future run retries until a model lands.
      const name = described?.name || `Realm ${realm_id}`;
      const essence = described?.essence || '';
      await query(
        `INSERT INTO realms (user_id, realm_id, name, essence, territory_count, message_count, describe_input_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(user_id, realm_id) DO UPDATE SET name = excluded.name, essence = excluded.essence,
           territory_count = excluded.territory_count, message_count = excluded.message_count,
           describe_input_hash = excluded.describe_input_hash, updated_at = datetime('now')`,
        [USER_ID, realm_id, name, essence, counts.tc ?? 0, counts.mc ?? 0, described ? sig : null],
      ).catch(err => console.error(`[describe] realm ${realm_id} write failed:`, err.message));
      if (described) await recordName(db, 'realm', realm_id, name, essence);
      await tick(total);
    }

    // ── Territories ─────────────────────────────────────────────────
    // cluster.py's dynamics upsert owns message_count + realm_id (refreshed every
    // run, before this stage) — so the skip and clobber-guard paths here write
    // nothing at all.
    let skippedTerr = 0;
    for (const { territory_id, realm_id } of terrIds) {
      const samples = await sampleContent(query, 'territory_id', territory_id);
      const [tc = {}] = await query(
        `SELECT COUNT(*) AS mc FROM clustering_points WHERE user_id = ? AND territory_id = ?`,
        [USER_ID, territory_id],
      ).catch(() => []);
      const sig = inputSignature(samples.map((s) => s.id), tc.mc);
      const [existing] = await query(
        `SELECT name, describe_input_hash FROM territory_profiles WHERE user_id = ? AND territory_id = ?`,
        [USER_ID, territory_id],
      ).catch(() => []);

      if (!FORCE && existing?.name && existing.describe_input_hash === sig) {
        skippedTerr += 1;
        if (DRY_RUN) console.log(`[describe] (dry) territory ${territory_id} unchanged — skip`);
        await tick(total);
        continue;
      }

      const described = samples.length ? await describe(narrator, 'territory', samples.map((s) => s.content)) : null;
      if (described) namedTerr += 1;
      if (DRY_RUN) {
        console.log(`[describe] (dry) territory ${territory_id} → "${described?.name || `Territory ${territory_id}`}"`);
        continue;
      }
      if (!described && existing?.name) {
        // Clobber guard: keep the real name; old hash ≠ sig → retried next run.
        await tick(total);
        continue;
      }
      const name = described?.name || `Territory ${territory_id}`;
      const essence = described?.essence || '';
      await query(
        `INSERT INTO territory_profiles
           (user_id, territory_id, realm_id, name, essence, message_count, describe_input_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(user_id, territory_id) DO UPDATE SET name = excluded.name, essence = excluded.essence,
           realm_id = excluded.realm_id, describe_input_hash = excluded.describe_input_hash, updated_at = datetime('now')`,
        [USER_ID, territory_id, realm_id, name, essence, tc.mc ?? samples.length, described ? sig : null],
      ).catch(err => console.error(`[describe] territory ${territory_id} write failed:`, err.message));
      if (described) await recordName(db, 'territory', territory_id, name, essence);
      await tick(total);
    }

    console.log(`[describe] Done — named ${namedRealms}/${realmIds.length} realms (${skippedRealms} unchanged) · ${namedTerr}/${terrIds.length} territories (${skippedTerr} unchanged) via ${narrator.label}`);
    const failedAll = namedRealms === 0 && realmIds.length - skippedRealms > 0;
    if (failedAll) {
      console.error(`[describe] WARNING: named 0 realms — the model (${narrator.label}) returned nothing usable. Check Settings → Intelligence.`);
    }
    if (feedId) { try { await db.activityFeed.finish(feedId, { status: failedAll ? 'error' : 'done' }); } catch { /* */ } }
  } finally {
    if (hbTimer) clearInterval(hbTimer);
    close();
  }
}

/**
 * Pull up to 5 decrypted member snippets for a cluster column (realm_id /
 * territory_id). The adapter transparently decrypts messages.content. Returns
 * [{id, content}] — the ids feed the input signature, so the order must be
 * deterministic (m.id tiebreak on equal timestamps, else the hash would flap).
 */
async function sampleContent(query, column, value) {
  const rows = await query(
    `SELECT m.id, m.content FROM clustering_points cp
     JOIN messages m ON m.id = cp.source_id AND cp.source_type = 'message'
     WHERE cp.user_id = ? AND cp.${column} = ?
     ORDER BY m.created_at DESC, m.id DESC LIMIT 5`,
    [USER_ID, value],
  ).catch(() => []);
  return rows.filter(r => r.content).map(r => ({ id: r.id, content: r.content }));
}

run().catch(err => { console.error('[describe] Fatal:', err); process.exit(1); });
