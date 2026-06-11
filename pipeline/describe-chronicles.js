#!/usr/bin/env node
/**
 * Phase C — chronicle narration. Enriches each territory with a narrative:
 * archetype, story (birth / arc / current chapter), signature patterns, open
 * questions, agent expertise. Where describe-clusters.js gives a name + essence,
 * this gives the *story* the portal's territory cards read.
 *
 * For each territory still needing a chronicle (description_version != current),
 * it samples decrypted member messages and asks the inference router to narrate
 * (`task:'narrate'` → cloud if a BYOK key is set, else local Ollama), then writes
 * the fields via db.territoryDocs.upsertDescription (idempotent on version).
 *
 * FAIL-SOFT: if no model is reachable (or it errors), that territory is skipped —
 * its existing name/essence from describe-clusters stays. The clustering output
 * is never blocked by narration. PRIVACY: only the sampled snippets needed to
 * narrate a cluster are sent to the model; `narrate` egresses to cloud only when
 * the user has configured a key (else on-box Ollama). Never logs message content.
 *
 * Usage (pipeline stage, after describe-clusters):
 *   USER_MASTER=<hex> SYSTEM_KEY=<hex> MYCELIUM_DB=./data/vault.db \
 *     node pipeline/describe-chronicles.js [--dry-run]
 */

import { getDb } from '../src/db/index.js';
import { loadKey } from '../src/crypto/keys.js';
import { createNarrator } from './lib/narrate-infer.js';

export const CHRONICLE_VERSION = process.env.MYCELIUM_CHRONICLE_VERSION || 'chronicle-v1';

// Drift gate: an already-chronicled territory re-narrates when its live point
// count has moved meaningfully since narration — symmetric ratio ≥ FACTOR and
// absolute delta ≥ MIN (the MIN floor stops tiny territories from churning).
// Without this, a chronicle written at 50 messages stays identical at 500.
const DRIFT_FACTOR = Number(process.env.MYCELIUM_CHRONICLE_DRIFT_FACTOR) || 1.5;
const DRIFT_MIN = Number(process.env.MYCELIUM_CHRONICLE_DRIFT_MIN) || 10;

/** True when current count has drifted far enough from the count at narration. */
export function hasDrifted(currentCount, countAtDescription, { factor = DRIFT_FACTOR, min = DRIFT_MIN } = {}) {
  const cur = Number(currentCount), then = Number(countAtDescription);
  if (!Number.isFinite(then) || then <= 0) return false; // never narrated with a real count → version gate owns it
  if (!Number.isFinite(cur) || cur <= 0) return false;
  if (Math.abs(cur - then) < min) return false;
  return Math.max(cur, then) / Math.min(cur, then) >= factor;
}

/**
 * Territories still needing a chronicle at `version`. NOTE: `description_version`
 * is an ENCRYPTED column (crypto-local.js), so it can't be filtered in SQL
 * (ciphertext is non-deterministic — a `!= ?` always matches). We select all and
 * compare the DECRYPTED value in JS. This is why we don't use
 * db.territoryDocs.getNeedingDescription (whose SQL version filter is ineffective).
 */
async function getTerritoriesToNarrate(db, userId, version) {
  const r = await db.rawQuery(
    `SELECT territory_id, name, essence, description_version, message_count,
            point_count_at_description
       FROM territory_profiles
      WHERE user_id = ? AND dissolved_at IS NULL
      ORDER BY message_count DESC`,
    [userId],
  ).catch(() => ({ results: [] }));
  const rows = r.results || r || [];
  // Narrate when the version is stale OR the content drifted since narration.
  return rows.filter((t) => t.description_version !== version
    || hasDrifted(t.message_count, t.point_count_at_description));
}

/** Pull up to `n` decrypted member snippets for a territory (adapter decrypts). */
async function sampleTerritoryContent(db, userId, territoryId, n = 6) {
  const r = await db.rawQuery(
    `SELECT m.content FROM clustering_points cp
       JOIN messages m ON m.id = cp.source_id AND cp.source_type = 'message'
      WHERE cp.user_id = ? AND cp.territory_id = ?
      ORDER BY m.created_at DESC LIMIT ?`,
    [userId, territoryId, n],
  ).catch(() => ({ results: [] }));
  return (r.results || r || []).map((x) => x.content).filter(Boolean);
}

function buildPrompt(t, samples) {
  return [
    `You are writing the "chronicle" of a region in someone's personal knowledge map.`,
    `This region is currently titled "${t.name || 'a territory'}".`,
    `Below are representative snippets that belong to it.`,
    ``,
    `Reply with EXACTLY one line of minified JSON with these keys:`,
    `{"essence":"<one vivid sentence>","archetype_type":"<1-2 words>",`,
    `"story_birth":"<how this began, 1 sentence>","story_arc":"<how it evolved, 1-2 sentences>",`,
    `"story_current_chapter":"<where it is now, 1 sentence>",`,
    `"signature_patterns":["<short phrase>","..."],"open_questions":["<question>","..."],`,
    `"agent_expertise":"<what an agent stewarding this would be expert in>"}`,
    ``,
    ...samples.map((s, i) => `(${i + 1}) ${String(s).slice(0, 400)}`),
  ].join('\n');
}

/** Extract the last JSON object from a model response (tolerant). */
function parseChronicle(raw, t, pointCount) {
  let parsed = {};
  if (typeof raw === 'string') {
    const match = raw.trim().match(/\{[\s\S]*\}/);
    if (match) { try { parsed = JSON.parse(match[0]); } catch { parsed = {}; } }
  }
  const arr = (v) => (Array.isArray(v) ? v.map(String).slice(0, 8) : []);
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);
  return {
    name: t.name,                                   // keep the describe-clusters title
    essence: str(parsed.essence, 500) || t.essence,
    archetype_type: str(parsed.archetype_type, 60),
    archetype_character: str(parsed.archetype_character, 200),
    story_birth: str(parsed.story_birth, 600),
    story_arc: str(parsed.story_arc, 1000),
    story_current_chapter: str(parsed.story_current_chapter, 600),
    story_peak_moments: arr(parsed.story_peak_moments),
    signature_patterns: arr(parsed.signature_patterns),
    uncertainty_open_questions: arr(parsed.open_questions || parsed.uncertainty_open_questions),
    uncertainty_edges: str(parsed.uncertainty_edges, 400),
    agent_expertise: str(parsed.agent_expertise, 300),
    agent_curious_about: str(parsed.agent_curious_about, 300),
    agent_can_help_with: arr(parsed.agent_can_help_with),
    agent_would_consult: arr(parsed.agent_would_consult),
    top_entities: arr(parsed.top_entities),
    point_count: pointCount,
  };
}

// Per-territory model timeout. Without it a hung Ollama/cloud `infer()` blocks
// Step 3 of Generate INDEFINITELY (the loop awaits every territory) — a wedged run
// the UI can't distinguish from progress. On timeout we fail-soft (keep the
// existing name/essence) exactly like an unreachable model.
const CHRONICLE_INFER_TIMEOUT_MS = Number(process.env.MYCELIUM_CHRONICLE_TIMEOUT_MS) || 60000;

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

/**
 * Narrate every territory needing a chronicle. Injectable `infer` + `sample` so
 * the verify can stub the model + content. Returns counts.
 * @param {{ db: object, userId: string, infer: Function, version?: string, sample?: Function, log?: Function }} opts
 */
export async function describeChronicles({ db, userId, infer, version = CHRONICLE_VERSION, sample, sampleRealm, log = () => {}, onProgress, modelLabel = 'unknown' }) {
  const targets = await getTerritoriesToNarrate(db, userId, version);
  const realmTargets = await getRealmsToNarrate(db, userId, version);
  const total = targets.length + realmTargets.length;
  let described = 0, skipped = 0, failed = 0;
  try { await onProgress?.(0, total); } catch { /* */ }
  for (const t of targets) {
    const samples = await (sample ? sample(t) : sampleTerritoryContent(db, userId, t.territory_id));
    if (!samples.length) { skipped += 1; continue; }
    let raw;
    try {
      raw = await withTimeout(
        infer({ task: 'narrate', prompt: buildPrompt(t, samples), maxTokens: 700 }),
        CHRONICLE_INFER_TIMEOUT_MS, 'chronicle narration',
      );
    } catch {
      failed += 1; // fail-soft: no model reachable → leave existing name/essence
      continue;
    }
    // point_count_at_description anchors the drift gate — it must be the
    // territory's LIVE size, not samples.length (≤6), or drift math is dead.
    const desc = parseChronicle(raw, t, Number(t.message_count) || samples.length);
    try {
      await db.territoryDocs.upsertDescription(userId, t.territory_id, desc, version, typeof raw === 'string' ? raw : null, modelLabel);
      described += 1;
    } catch (e) {
      failed += 1; log(`chronicle write failed for territory ${t.territory_id}: ${e.message}`);
    }
    try { await onProgress?.(described + skipped + failed, total); } catch { /* */ }
  }

  // ── Realm pass — same narrator, same gating shape (generation_version +
  // drift). UPDATE-only: realm rows exist only via describe-clusters from live
  // points (or import); narration must never create one (fail-closed).
  for (const rm of realmTargets) {
    const ctx = await (sampleRealm ? sampleRealm(rm) : sampleRealmContext(db, userId, rm.realm_id));
    if (!ctx.samples.length) { skipped += 1; continue; }
    let raw;
    try {
      raw = await withTimeout(
        infer({ task: 'narrate', prompt: buildRealmPrompt(rm, ctx.samples, ctx.territoryNames), maxTokens: 700 }),
        CHRONICLE_INFER_TIMEOUT_MS, 'realm chronicle narration',
      );
    } catch {
      failed += 1;
      continue;
    }
    const desc = parseChronicle(raw, rm, Number(rm.message_count) || ctx.samples.length);
    try {
      await db.mindscape.upsertRealmDescription(userId, rm.realm_id, desc, version, modelLabel);
      described += 1;
    } catch (e) {
      failed += 1; log(`chronicle write failed for realm ${rm.realm_id}: ${e.message}`);
    }
    try { await onProgress?.(described + skipped + failed, total); } catch { /* */ }
  }
  return { total, described, skipped, failed };
}

/**
 * Realms still needing a chronicle at `version`. realms.generation_version is
 * PLAINTEXT (unlike territory_profiles.description_version) but the gate stays
 * in JS for symmetry with the territory pass. Only EXISTING rows are returned —
 * the realm pass never creates realm rows.
 */
async function getRealmsToNarrate(db, userId, version) {
  const r = await db.rawQuery(
    `SELECT realm_id, name, essence, generation_version, message_count,
            point_count_at_description
       FROM realms WHERE user_id = ? ORDER BY message_count DESC`,
    [userId],
  ).catch(() => ({ results: [] }));
  const rows = r.results || r || [];
  return rows.filter((rm) => rm.generation_version !== version
    || hasDrifted(rm.message_count, rm.point_count_at_description));
}

/** Snippets + member territory names for a realm (adapter decrypts both). */
async function sampleRealmContext(db, userId, realmId, n = 6) {
  const r = await db.rawQuery(
    `SELECT m.content FROM clustering_points cp
       JOIN messages m ON m.id = cp.source_id AND cp.source_type = 'message'
      WHERE cp.user_id = ? AND cp.realm_id = ?
      ORDER BY m.created_at DESC LIMIT ?`,
    [userId, realmId, n],
  ).catch(() => ({ results: [] }));
  const samples = (r.results || r || []).map((x) => x.content).filter(Boolean);
  const t = await db.rawQuery(
    `SELECT name FROM territory_profiles
      WHERE user_id = ? AND realm_id = ? AND dissolved_at IS NULL AND name IS NOT NULL
      ORDER BY message_count DESC LIMIT 6`,
    [userId, realmId],
  ).catch(() => ({ results: [] }));
  const territoryNames = (t.results || t || []).map((x) => x.name).filter(Boolean);
  return { samples, territoryNames };
}

function buildRealmPrompt(rm, samples, territoryNames) {
  return [
    `You are writing the "chronicle" of a REALM — a broad region of someone's personal knowledge map that contains several territories.`,
    `This realm is currently titled "${rm.name || 'a realm'}".`,
    territoryNames.length ? `Territories inside it: ${territoryNames.join(', ')}.` : '',
    `Below are representative snippets from across the realm.`,
    ``,
    `Reply with EXACTLY one line of minified JSON with these keys:`,
    `{"essence":"<one vivid sentence>","archetype_type":"<1-2 words>",`,
    `"story_birth":"<how this began, 1 sentence>","story_arc":"<how it evolved, 1-2 sentences>",`,
    `"story_current_chapter":"<where it is now, 1 sentence>",`,
    `"signature_patterns":["<short phrase>","..."],"open_questions":["<question>","..."],`,
    `"agent_expertise":"<what an agent stewarding this would be expert in>"}`,
    ``,
    ...samples.map((s, i) => `(${i + 1}) ${String(s).slice(0, 400)}`),
  ].filter(Boolean).join('\n');
}

// ── CLI entry (pipeline stage) ──────────────────────────────────────────────
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const DRY_RUN = process.argv.includes('--dry-run');
  const USER_ID = process.env.MYCELIUM_USER_ID || 'local-user';
  const DB_PATH = process.env.MYCELIUM_DB || './data/vault.db';
  const USER_MASTER = process.env.USER_MASTER;
  const SYSTEM_KEY = process.env.SYSTEM_KEY;
  if (!USER_MASTER || !SYSTEM_KEY) { console.error('[chronicles] Missing USER_MASTER and SYSTEM_KEY'); process.exit(1); }

  // getDb needs IMPORTED HKDF CryptoKeys, not raw hex — raw hex throws
  // "deriveBits 2nd argument is not of type CryptoKey" on every content decrypt.
  const [userKey, systemKey] = await Promise.all([loadKey(USER_MASTER), loadKey(SYSTEM_KEY)]);
  const { db, close } = getDb({ dbPath: DB_PATH, userKey, systemKey, scope: 'personal' });
  // The user's ACTIVE provider names + chronicles (same seam describe-clusters uses).
  // Local Ollama is reached over native /api/chat with think:false (fast); cloud goes
  // through the audited router. The narrator's infer(prompt, {maxTokens}) is adapted
  // to describeChronicles' infer({prompt,maxTokens}) call shape.
  const narrator = await createNarrator({ db, userId: USER_ID });
  console.log(`[chronicles] narrating territories via ${narrator.label}${narrator.local ? ' (local)' : ''}${DRY_RUN ? ' (dry-run)' : ''}`);
  try {
    if (DRY_RUN) {
      const targets = await getTerritoriesToNarrate(db, USER_ID, CHRONICLE_VERSION);
      const realmTargets = await getRealmsToNarrate(db, USER_ID, CHRONICLE_VERSION);
      console.log(`[chronicles] (dry) ${targets.length} territories + ${realmTargets.length} realms would be narrated`);
    } else {
      // Surface live progress to the unified activity feed (content-free).
      let feedId = null, hbTimer = null;
      try { feedId = await db.activityFeed.begin({ userId: USER_ID, kind: 'describe:chronicle', stageLabel: 'Describing your areas' }); } catch { /* */ }
      if (feedId) { hbTimer = setInterval(() => { db.activityFeed.heartbeat(feedId, {}).catch(() => {}); }, 10_000); hbTimer.unref?.(); }
      const onProgress = feedId ? (done, total) => db.activityFeed.heartbeat(feedId, { step: done, totalSteps: total }).catch(() => {}) : undefined;
      let res;
      try {
        res = await describeChronicles({ db, userId: USER_ID, infer: ({ prompt, maxTokens }) => narrator.infer(prompt, { maxTokens }), log: console.error, onProgress, modelLabel: narrator.label });
      } finally {
        if (hbTimer) clearInterval(hbTimer);
        if (feedId) { try { await db.activityFeed.finish(feedId, { status: 'done' }); } catch { /* */ } }
      }
      console.log(`[chronicles] ${res.described} narrated, ${res.skipped} skipped (no content), ${res.failed} failed (no model / write)`);
    }
  } catch (e) {
    console.error('[chronicles] non-fatal:', e.message); // never block the pipeline
  } finally {
    close();
  }
}
