#!/usr/bin/env node
/**
 * Generate realm + territory names/essences from clustered points.
 *
 * Populates `realms` and `territory_profiles` with human-readable names and
 * essences so the portal/3D view has labels. For each realm/territory it draws a
 * TIMELINE-STRATIFIED sample (≈20 members spread across the cluster's whole date
 * range, ALL source types, 5k chars each, plus aggregated top tags + entities —
 * pipeline/lib/narrate-sample.js) and asks the user's ACTIVE provider to name +
 * summarize them. Plaintext never leaves the box on a local model.
 *
 * PROGRESSIVE: the model is shown the EXISTING name/essence and asked to refine or
 * rewrite as understanding deepens. COVERAGE (territories): the sampled member ids
 * are recorded in `territory_seen_points`; each pass biases toward UNSEEN content
 * so coverage accumulates, and `explored_count`/`explored_percent` track "% described"
 * (realms roll up their children's coverage). Realms have no per-entity seen table —
 * they draw a plain stratified spread.
 *
 * V1 single-user port:
 *   - Reads/writes the local encrypted SQLite vault via the in-process db adapter
 *     (no Worker proxy, no scope plumbing; scope is always 'personal').
 *   - If the model is unavailable, falls back to deterministic placeholder names so
 *     the pipeline still completes (fail-soft; structural clustering is what matters).
 *
 * Usage:
 *   USER_MASTER=<hex> SYSTEM_KEY=<hex> MYCELIUM_DB=./data/vault.db \
 *     node pipeline/describe-clusters.js [--dry-run]
 */

import crypto from 'node:crypto';
import { getDb } from '../src/db/index.js';
import { loadKey } from '../src/crypto/keys.js';
import { createNarrator } from './lib/narrate-infer.js';
import {
  loadMembers, sampleMembers, getSeenIds, recordSeen, exploredPercent, lastPassNumber,
} from './lib/narrate-sample.js';
import { buildContextCapsule, renderCapsule, describedPeriodFor } from './lib/narrate-context.js';

const USER_ID = process.env.MYCELIUM_USER_ID || 'local-user';
const DB_PATH = process.env.MYCELIUM_DB || './data/vault.db';
const USER_MASTER = process.env.USER_MASTER;
const SYSTEM_KEY = process.env.SYSTEM_KEY;
const DRY_RUN = process.argv.includes('--dry-run');
// Bypass the input-signature skip and re-narrate everything (recovery hatch).
const FORCE = process.argv.includes('--force') || process.env.MYCELIUM_DESCRIBE_FORCE === '1';
// Preserve-imported (gap-fill-only): NEVER re-narrate an entity that already has a
// name — only fill the unnamed. Used for the one-shot over a freshly-imported vault
// so canonical narration is never overwritten by the local model. Coverage columns
// still refresh (non-destructive). FORCE wins (explicit re-narrate).
const PRESERVE = !FORCE && (process.argv.includes('--preserve-imported') || process.env.MYCELIUM_DESCRIBE_PRESERVE === '1');

/**
 * Change-detection signature for a cluster's describe input: SHA-256 over the
 * sampled source IDs (random UUIDs — never content-derived, so the hash leaks
 * nothing about plaintext) + the cluster's live point count. Same sample + same
 * count → narration input is identical → skip. Stored in describe_input_hash.
 * Because the sampler biases to UNSEEN content, the signature rotates while a
 * territory is still under-covered (→ re-narrate) and stabilizes once fully
 * covered (→ skip), giving progressive enrichment without endless churn.
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
 * Name + summarize a cluster with the user's ACTIVE provider. Shows the model a
 * timeline-stratified sample + top tags + entities, and (when present) the EXISTING
 * name/essence so it can refine rather than restart. Returns null on any failure so
 * the caller can fall back to a placeholder (fail-soft: a miss never blocks Generate).
 */
async function describe(narrator, kind, { samples, topTags = [], entities = [], existing = null, contextBlock = '' }) {
  const lines = [
    `You are naming a ${kind} in a personal knowledge graph.`,
  ];
  // Context Capsule: temporal coverage (prior span vs. new span), activity timeline,
  // and what this area connects to BY NAME — so the model refines with awareness.
  if (contextBlock) lines.push('', contextBlock, '');
  lines.push(`Below are representative snippets sampled across this ${kind}'s WHOLE timeline (not just recent).`);
  if (existing?.name) {
    lines.push(
      `It is currently titled "${existing.name}"${existing.essence ? ` — "${existing.essence}"` : ''}.`,
      `Refine or rewrite the title and essence as your understanding deepens; keep them only if they still fit.`,
    );
  }
  if (topTags.length) lines.push(`Recurring tags: ${topTags.join(', ')}.`);
  if (entities.length) lines.push(`Key entities: ${entities.join(', ')}.`);
  lines.push(
    `Reply with EXACTLY one line of minified JSON: {"name": "<2-4 word title>", "essence": "<one sentence>"}.`,
    '',
    ...samples.map((s, i) => `(${i + 1}) ${String(s.content ?? s).slice(0, 5000)}`),
  );
  try {
    const raw = await narrator.infer(lines.join('\n'), { maxTokens: 300 });
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
      const members = await loadMembers(query, USER_ID, 'realm_id', realm_id);
      const sample = sampleMembers(members, {}); // realms: plain stratified spread (no per-realm seen table)
      // Real counts from live points — no other stage maintains these, and the
      // search corpus ranks realms by message_count (zeros = arbitrary order).
      const [counts = {}] = await query(
        `SELECT COUNT(*) AS mc,
                COUNT(DISTINCT CASE WHEN territory_id >= 0 THEN territory_id END) AS tc
         FROM clustering_points WHERE user_id = ? AND realm_id = ?`,
        [USER_ID, realm_id],
      ).catch(() => []);
      const sig = inputSignature(sample.sampledIds, counts.mc);
      const [existing] = await query(
        `SELECT name, essence, describe_input_hash, described_period_start, described_period_end FROM realms WHERE user_id = ? AND realm_id = ?`,
        [USER_ID, realm_id],
      ).catch(() => []);

      // Skip-if-unchanged: named + identical narration input → no inference.
      // Counts stay fresh (describe owns realm counters).
      if (!FORCE && existing?.name && (PRESERVE || existing.describe_input_hash === sig)) {
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

      // Context Capsule: timeline + connected-by-name (child territories) so the
      // realm essence is named with awareness of what it actually contains.
      const capsule = await buildContextCapsule({ query, db, userId: USER_ID, kind: 'realm', id: realm_id, members, seenIds: null, stored: existing }).catch(() => null);
      const described = sample.samples.length
        ? await describe(narrator, 'realm', { samples: sample.samples, topTags: sample.topTags, entities: sample.entities, existing, contextBlock: capsule ? renderCapsule(capsule) : '' })
        : null;
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
      if (described) {
        // Persist the covered span (what this essence is based on) + activity histogram.
        const dp = describedPeriodFor('realm', members);
        await query(
          `UPDATE realms SET described_period_start = ?, described_period_end = ?, activity_timeline = ?
           WHERE user_id = ? AND realm_id = ?`,
          [dp?.start ?? null, dp?.end ?? null, JSON.stringify(capsule?.activity?.histogram ?? []), USER_ID, realm_id],
        ).catch(() => {});
        await recordName(db, 'realm', realm_id, name, essence);
      }
      await tick(total);
    }

    // ── Territories ─────────────────────────────────────────────────
    // cluster.py's dynamics upsert owns message_count + realm_id (refreshed every
    // run, before this stage). describe owns name/essence + the coverage columns
    // (explored_count/explored_percent) and the seen-points ledger.
    let skippedTerr = 0;
    for (const { territory_id, realm_id } of terrIds) {
      const members = await loadMembers(query, USER_ID, 'territory_id', territory_id);
      const seenIds = await getSeenIds(query, USER_ID, territory_id);
      const sample = sampleMembers(members, { seenIds });
      const total_pts = members.length;
      const [tc = {}] = await query(
        `SELECT COUNT(*) AS mc FROM clustering_points WHERE user_id = ? AND territory_id = ?`,
        [USER_ID, territory_id],
      ).catch(() => []);
      const sig = inputSignature(sample.sampledIds, total_pts);
      const [existing] = await query(
        `SELECT name, essence, describe_input_hash, described_period_start, described_period_end FROM territory_profiles WHERE user_id = ? AND territory_id = ?`,
        [USER_ID, territory_id],
      ).catch(() => []);
      const seenBefore = seenIds.size;
      const unseen = sample.unseenRemaining;

      // Skip: named AND input unchanged AND fully covered (no new content to fold
      // in). Refresh the coverage % on the way past so the UI stays honest.
      if (!FORCE && existing?.name && (PRESERVE || (existing.describe_input_hash === sig && unseen === 0))) {
        skippedTerr += 1;
        if (DRY_RUN) { console.log(`[describe] (dry) territory ${territory_id} unchanged + fully covered — skip`); await tick(total); continue; }
        await query(
          `UPDATE territory_profiles SET explored_count = ?, explored_percent = ?, updated_at = datetime('now')
           WHERE user_id = ? AND territory_id = ?`,
          [seenBefore, exploredPercent(seenBefore, total_pts), USER_ID, territory_id],
        ).catch(() => {});
        await tick(total);
        continue;
      }

      // Context Capsule: prior-covered span vs. new-content span, % described,
      // activity timeline, and connected-by-name (realm / nearest / lineage).
      const capsule = await buildContextCapsule({ query, db, userId: USER_ID, kind: 'territory', id: territory_id, members, seenIds, stored: existing }).catch(() => null);
      const described = sample.samples.length
        ? await describe(narrator, 'territory', { samples: sample.samples, topTags: sample.topTags, entities: sample.entities, existing, contextBlock: capsule ? renderCapsule(capsule) : '' })
        : null;
      if (described) namedTerr += 1;
      if (DRY_RUN) {
        console.log(`[describe] (dry) territory ${territory_id} → "${described?.name || `Territory ${territory_id}`}" (covered ${seenBefore}/${total_pts})`);
        continue;
      }
      if (!described && existing?.name) {
        // Clobber guard: keep the real name; old hash ≠ sig → retried next run. No
        // seen-points advance (coverage only grows on a real narration).
        await tick(total);
        continue;
      }
      // Real narration → fold the sampled members into coverage, then write.
      let seenCount = seenBefore;
      if (described) {
        const pass = (await lastPassNumber(query, USER_ID, territory_id)) + 1;
        await recordSeen(query, USER_ID, territory_id, sample.sampledIds, pass);
        seenCount = (await getSeenIds(query, USER_ID, territory_id)).size;
      }
      const ep = exploredPercent(seenCount, total_pts);
      const name = described?.name || `Territory ${territory_id}`;
      const essence = described?.essence || '';
      await query(
        `INSERT INTO territory_profiles
           (user_id, territory_id, realm_id, name, essence, message_count, explored_count, explored_percent, describe_input_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(user_id, territory_id) DO UPDATE SET name = excluded.name, essence = excluded.essence,
           realm_id = excluded.realm_id, explored_count = excluded.explored_count, explored_percent = excluded.explored_percent,
           describe_input_hash = excluded.describe_input_hash, updated_at = datetime('now')`,
        [USER_ID, territory_id, realm_id, name, essence, tc.mc ?? total_pts, seenCount, ep, described ? sig : null],
      ).catch(err => console.error(`[describe] territory ${territory_id} write failed:`, err.message));
      if (described) {
        // Persist the covered span (now includes this pass's freshly-seen members) +
        // the activity histogram, so the NEXT narration knows what was already folded.
        const seenNow = await getSeenIds(query, USER_ID, territory_id);
        const dp = describedPeriodFor('territory', members, seenNow);
        await query(
          `UPDATE territory_profiles SET described_period_start = ?, described_period_end = ?, activity_timeline = ?
           WHERE user_id = ? AND territory_id = ?`,
          [dp?.start ?? null, dp?.end ?? null, JSON.stringify(capsule?.activity?.histogram ?? []), USER_ID, territory_id],
        ).catch(() => {});
        await recordName(db, 'territory', territory_id, name, essence);
      }
      await tick(total);
    }

    // ── Realm coverage roll-up (CASCADE): a realm's explored_percent is the
    // message-weighted average of its live territories' coverage. Pure SQL, no
    // inference; runs once after territories so the children are fresh.
    if (!DRY_RUN) {
      await query(
        `UPDATE realms SET explored_percent = COALESCE((
            SELECT ROUND(SUM(tp.explored_percent * tp.message_count) * 1.0 / NULLIF(SUM(tp.message_count), 0))
            FROM territory_profiles tp
            WHERE tp.user_id = realms.user_id AND tp.realm_id = realms.realm_id AND tp.dissolved_at IS NULL
          ), explored_percent)
         WHERE user_id = ?`,
        [USER_ID],
      ).catch(err => console.error('[describe] realm coverage roll-up failed:', err.message));
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

run().catch(err => { console.error('[describe] Fatal:', err); process.exit(1); });
