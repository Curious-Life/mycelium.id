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
import { fileURLToPath } from 'node:url';
import { getDb } from '../src/db/index.js';
import { loadKey } from '../src/crypto/keys.js';
import { resolveDbKeyHex } from '../src/db/open.js';
import { createNarrator } from './lib/narrate-infer.js';
import {
  loadMembers, sampleMembers, getSeenIds, recordSeen, exploredPercent, lastPassNumber,
} from './lib/narrate-sample.js';
import { buildContextCapsule, renderCapsule, describedPeriodFor } from './lib/narrate-context.js';
import { isPlaceholderName, NAME_MAX_OUT_TOKENS } from './lib/naming-facts.js';

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

// isPlaceholderName (D10: "a Realm 7 is not a name") now lives in lib/naming-facts.js — ONE
// predicate shared with GET /portal/mycelium/naming-status, so the route counts with the
// pipeline's OWN notion of "unnamed" and the two can never drift (II.2a). The full rationale
// travels with the function.

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
      `Refine or rewrite the title and essence as your understanding deepens; keep them only if they still fit. If your understanding has not changed, return the existing title and essence unchanged.`,
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
    // NAME_MAX_OUT_TOKENS is SHARED with the served forecast (naming-facts.js) — the cap and
    // the promise "up to ~Nk tokens" are one constant, so the bound stays true by construction.
    const raw = await narrator.infer(lines.join('\n'), { maxTokens: NAME_MAX_OUT_TOKENS });
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
  // getDb + loadKey (CryptoKeys) + resolveDbKeyHex (the at-rest DB-file key). NOT
  // boot(): boot runs initVaultStorage (schema + cross-process migration lock) +
  // builds domains, which deadlocks/alters state when a parent (e.g. a test, or the
  // app) already holds the vault. This opens the vault keyed — the ONLY thing the
  // old getDb-with-hex lacked — with no side effects. dbKeyHex is null for a
  // plaintext vault (unchanged) and the derived key for an at-rest one.
  const [userKey, systemKey] = await Promise.all([loadKey(USER_MASTER), loadKey(SYSTEM_KEY)]);
  const dbKeyHex = resolveDbKeyHex(USER_MASTER, DB_PATH);
  const { db, close } = getDb({ dbPath: DB_PATH, userKey, systemKey, scope: 'personal', dbKeyHex });
  const query = (sql, params = []) => db.rawQuery(sql, params).then(r => (Array.isArray(r) ? r : r.results || []));
  const narrator = await createNarrator({ db, userId: USER_ID });
  let namedRealms = 0, namedTerr = 0;
  // Surface live progress to the unified activity feed (header + mindscape chip).
  // Content-free: only a constant stage label + done/total — never a realm name.
  let feedId = null, done = 0, hbTimer = null;
  const tick = async (total) => { try { await db.activityFeed.heartbeat(feedId, { step: ++done, totalSteps: total }); } catch { /* */ } };

  try {
    console.log(`[describe] Naming realms + territories for user=${USER_ID} via ${narrator.label}${narrator.local ? ' (local)' : ''}${DRY_RUN ? ' (dry-run)' : ''}`);
    // ── Nothing safe to run (§M): stop before doing the work, and SAY SO ─────────
    // Not a loop of N identical refusals: this is a steady state, so it costs one honest
    // line and one terminal feed row. Reported via the SAME activity feed the run would
    // have used — an owner watching "Naming areas" must learn why it did not happen from
    // the place they were already looking, not from a log they will never open.
    //
    // begin+finish('error'), NOT a `notice()`: activityFeed exposes begin/heartbeat/finish/
    // active/recent/reap/prune and NOTHING ELSE (src/db/activity-feed.js). `recent()` selects
    // `error`, so this row carries the reason into the feed's history. (narrate-infer.js's
    // onCloudFallback called `activityFeed.notice?.()` — optional-chained, so it has always
    // been a silent no-op; fixed in the same commit. Verify the method, not the intention.)
    //
    // DRY_RUN refuses TOO — only the feed WRITE is skipped. Gating the whole check on
    // !DRY_RUN made a dry run walk every realm calling a narrator that throws per item: N
    // "narration failed" lines and no cause, in the one mode whose entire purpose is to tell
    // the operator what WOULD happen. A diagnostic that misreports the diagnosis is worse
    // than none.
    // ⚠️ Blocked ⇒ NO NAMING, but the walk still runs for COUNT MAINTENANCE.
    // The first version `return`ed here — which regressed the exact defect
    // verify:realm-prune exists for: describe is the ONLY writer of
    // realms.territory_count/message_count ("they were 0 forever: no writer"),
    // so an early return froze every count on any vault without an approved
    // model. Counts are pure SQL bookkeeping over clustering_points — no model
    // runs — so consent does not gate them. The flag suppresses only the
    // describe() calls below; their null flows through the existing paths
    // (clobber guard keeps real names; unnamed rows get placeholders and retry
    // when a model is approved). Caught by verify:realm-prune, 2026-07-16.
    // ⚠️ TRUTHY, not `=== true`. createNarrator sets `blocked: BLOCKED_NO_MODEL` — a STRING
    // ('no-approved-on-box-model'), never the boolean true (narrate-infer.js; verify:narrate-
    // consent asserts blocked === BLOCKED_NO_MODEL). `=== true` was therefore ALWAYS false, so
    // this whole "stop before the work and SAY SO" block was dead: a vault with no approved model
    // fell through to describe() N times (N identical stderr "narration failed" lines — the very
    // loop the comment above says it avoids), and the feed got a message-LESS `error` row instead
    // of the actionable refusal. describe-chronicles.js:483 already uses the truthy form; this
    // aligns them. Found by driving the consent state (verify:illuminate-naming N5b), 2026-07-17.
    const namingBlocked = Boolean(narrator.blocked);
    if (namingBlocked) {
      const msg = 'No on-box model is approved and no cloud provider is configured — approve a model in Settings → Intelligence to name your areas.';
      console.error(`[describe] ${DRY_RUN ? '(dry) ' : ''}${msg} (counts still maintained)`);
      if (!DRY_RUN) {
        try {
          const id = await db.activityFeed.begin({ userId: USER_ID, kind: 'describe:name', stageLabel: 'Naming your areas' });
          await db.activityFeed.finish(id, { status: 'error', error: msg });
        } catch { /* feed is best-effort — the refusal itself already stands */ }
      }
    }
    if (!DRY_RUN && !namingBlocked) {
      // (blocked runs already wrote their terminal feed row above — a second
      //  "Naming areas" begin would show a running job that names nothing)
      try { feedId = await db.activityFeed.begin({ userId: USER_ID, kind: 'describe:name', stageLabel: 'Naming your areas' }); } catch { /* */ }
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
      // Counts stay fresh (describe owns realm counters). A PLACEHOLDER name is not a
      // name (D10) — never let it satisfy this skip, or a naming pass no-ops on the
      // rows it was spawned to name.
      if (!FORCE && existing?.name && !isPlaceholderName(existing.name) && (PRESERVE || existing.describe_input_hash === sig)) {
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
      const described = (!namingBlocked && sample.samples.length)
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
      // in). Refresh the coverage % on the way past so the UI stays honest. A
      // PLACEHOLDER name is not a name (D10) — never let it satisfy this skip.
      if (!FORCE && existing?.name && !isPlaceholderName(existing.name) && (PRESERVE || (existing.describe_input_hash === sig && unseen === 0))) {
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
      const described = (!namingBlocked && sample.samples.length)
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
      // Report the REAL cause. "the model returned nothing usable" is a lie when the truth is
      // "we refused to run a model you never approved" — and it sends the owner to Settings to
      // debug a model that was never the problem. A refusal is a legitimate steady state
      // (drainer §3.5 no_model), not a malfunction; blaming the model for it is what makes a
      // consent gate feel like a bug and get "fixed" by restoring the fail-open default.
      console.error(narrator.blocked
        ? `[describe] named 0 realms — no on-box model is approved and no cloud provider is configured, so nothing was run. Approve a model in Settings → Intelligence to name your areas.`
        : `[describe] WARNING: named 0 realms — the model (${narrator.label}) returned nothing usable. Check Settings → Intelligence.`);
    }
    if (feedId) { try { await db.activityFeed.finish(feedId, { status: failedAll ? 'error' : 'done' }); } catch { /* */ } }
  } finally {
    if (hbTimer) clearInterval(hbTimer);
    close();
  }
}

// isMain guard so this file can be IMPORTED (by verify:narrate-consent's N8) without
// executing run() — which opens the vault. Matches describe-chronicles.js's guard. Spawned
// as `node pipeline/describe-clusters.js` (jobs.js, run-clustering.sh) isMain is true → runs
// exactly as before. fileURLToPath, not the raw file:// compare — the app ships as "Mycelium
// Dev.app", a path with a space, which breaks the unescaped form.
const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  // The env-key guard lives HERE, not at module top level — a top-level process.exit(1) fires
  // on IMPORT (N8 loads this file to prove its import graph resolves), which would kill the
  // whole verify run. Only the spawned entry point needs the keys.
  if (!USER_MASTER || !SYSTEM_KEY) {
    console.error('Missing: USER_MASTER and SYSTEM_KEY (64-char hex each)');
    process.exit(1);
  }
  run().catch(err => { console.error('[describe] Fatal:', err); process.exit(1); });
}
