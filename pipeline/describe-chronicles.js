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
import { resolveDbKeyHex } from '../src/db/open.js';
import { createNarrator } from './lib/narrate-infer.js';
import {
  loadMembers, sampleMembers, getSeenIds, recordSeen, exploredPercent, lastPassNumber,
} from './lib/narrate-sample.js';
import { buildContextCapsule, renderCapsule, describedPeriodFor } from './lib/narrate-context.js';

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
async function getTerritoriesToNarrate(db, userId, version, preserveImported = false) {
  const r = await db.rawQuery(
    `SELECT territory_id, name, essence, archetype_type,
            story_birth, story_arc, story_current_chapter,
            description_version, message_count,
            point_count_at_description, explored_percent
       FROM territory_profiles
      WHERE user_id = ? AND dissolved_at IS NULL
      ORDER BY message_count DESC`,
    [userId],
  ).catch(() => ({ results: [] }));
  const rows = r.results || r || [];
  // PRESERVE-IMPORTED (gap-fill): narrate ONLY territories that have NO chronicle
  // yet (no story) — never touch an existing one (e.g. canonical import).
  if (preserveImported) return rows.filter((t) => !t.story_arc && !t.story_current_chapter && !t.story_birth);
  // Normal: narrate when version is stale, OR content drifted, OR not yet fully
  // described (coverage gate — fold in unseen content until explored_percent=100).
  return rows.filter((t) => t.description_version !== version
    || hasDrifted(t.message_count, t.point_count_at_description)
    || t.explored_percent == null || Number(t.explored_percent) < 100);
}

/**
 * Timeline-stratified, all-source, incremental sample for a territory (shared
 * sampler). Returns the full sample object: { samples:[{id,content}], sampledIds,
 * topTags, entities, totalPoints, unseenRemaining }. Biased toward UNSEEN content
 * (territory_seen_points ledger) so repeated chronicling accumulates coverage.
 */
async function sampleTerritoryContent(db, userId, territoryId) {
  const query = (sql, p = []) => db.rawQuery(sql, p).then((r) => r.results || r || []);
  const members = await loadMembers(query, userId, 'territory_id', territoryId);
  const seenIds = await getSeenIds(query, userId, territoryId);
  return sampleMembers(members, { seenIds });
}

/** Normalize a sample (legacy injected `sample` may return a string[] of content;
 * the default returns the rich object) into the rich shape. */
function normalizeSample(raw) {
  if (Array.isArray(raw)) {
    return { samples: raw.map((c) => ({ content: c })), sampledIds: [], topTags: [], entities: [], totalPoints: raw.length, unseenRemaining: raw.length };
  }
  return raw || { samples: [], sampledIds: [], topTags: [], entities: [], totalPoints: 0, unseenRemaining: 0 };
}

function buildPrompt(t, samples, topTags = [], entities = [], contextBlock = '') {
  const lines = [
    `You are writing the "chronicle" of a region in someone's personal knowledge map.`,
    `This region is currently titled "${t.name || 'a territory'}".`,
  ];
  // Context Capsule: prior-covered span vs. new content, activity timeline, and what
  // this region connects to BY NAME — so the chronicle extends with awareness.
  if (contextBlock) lines.push('', contextBlock, '');
  // PROGRESSIVE: show the existing chronicle so the model refines/extends rather
  // than restarts as coverage deepens.
  if (t.story_arc || t.story_current_chapter || t.story_birth) {
    lines.push(
      `Its current chronicle — refine and extend it as your understanding deepens (keep what still holds; if nothing has meaningfully changed, return it unchanged):`,
      [t.story_birth && `birth: ${t.story_birth}`, t.story_arc && `arc: ${t.story_arc}`,
        t.story_current_chapter && `now: ${t.story_current_chapter}`].filter(Boolean).join(' · '),
    );
  }
  if (topTags.length) lines.push(`Recurring tags: ${topTags.join(', ')}.`);
  if (entities.length) lines.push(`Key entities: ${entities.join(', ')}.`);
  lines.push(
    `Below are representative snippets sampled across this region's WHOLE timeline (not just recent).`,
    ``,
    `Reply with EXACTLY one line of minified JSON with these keys:`,
    `{"essence":"<one vivid sentence>","archetype_type":"<1-2 words>",`,
    `"story_birth":"<how this began, 1 sentence>","story_arc":"<how it evolved, 1-2 sentences>",`,
    `"story_current_chapter":"<where it is now, 1 sentence>",`,
    `"signature_patterns":["<short phrase>","..."],"open_questions":["<question>","..."],`,
    `"agent_expertise":"<what an agent stewarding this would be expert in>"}`,
    ``,
    ...samples.map((s, i) => `(${i + 1}) ${String(s.content ?? s).slice(0, 5000)}`),
  );
  return lines.join('\n');
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
    // Territories/realms keep their describe-clusters title; themes have none yet
    // (materialized here) → take the narrated name.
    name: t.name || (typeof parsed.name === 'string' ? parsed.name.trim().slice(0, 80) : undefined),
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
export async function describeChronicles({ db, userId, infer, version = CHRONICLE_VERSION, sample, sampleRealm, log = () => {}, onProgress, modelLabel = 'unknown', preserveImported = false, skipTerritories = false }) {
  // skipTerritories: run ONLY the theme + realm passes (the territory-chronicle
  // gap-fill is the long pole — defer it). Themes still narrate from the existing
  // territory names/essences, so this is coherent.
  const targets = skipTerritories ? [] : await getTerritoriesToNarrate(db, userId, version, preserveImported);
  const realmTargets = await getRealmsToNarrate(db, userId, version, preserveImported);
  const total = targets.length + realmTargets.length;
  let described = 0, skipped = 0, failed = 0;
  try { await onProgress?.(0, total); } catch { /* */ }
  for (const t of targets) {
    const S = normalizeSample(await (sample ? sample(t) : sampleTerritoryContent(db, userId, t.territory_id)));
    if (!S.samples.length) { skipped += 1; continue; }
    const query = (sql, p = []) => db.rawQuery(sql, p).then((r) => r.results || r || []);
    // Context Capsule: temporal coverage + activity timeline + connected-by-name,
    // prepended to the chronicle prompt. Fail-soft → narration proceeds without it.
    const capMembers = await loadMembers(query, userId, 'territory_id', t.territory_id).catch(() => []);
    const capSeen = await getSeenIds(query, userId, t.territory_id).catch(() => new Set());
    const capsule = await buildContextCapsule({ query, db, userId, kind: 'territory', id: t.territory_id, members: capMembers, seenIds: capSeen, stored: t }).catch(() => null);
    let raw;
    try {
      raw = await withTimeout(
        infer({ task: 'narrate', prompt: buildPrompt(t, S.samples, S.topTags, S.entities, capsule ? renderCapsule(capsule) : ''), maxTokens: 700 }),
        CHRONICLE_INFER_TIMEOUT_MS, 'chronicle narration',
      );
    } catch {
      failed += 1; // fail-soft: no model reachable → leave existing name/essence
      continue;
    }
    // point_count_at_description anchors the drift gate — it must be the
    // territory's LIVE size, not the sample size, or drift math is dead.
    const desc = parseChronicle(raw, t, Number(t.message_count) || S.totalPoints || S.samples.length);
    try {
      await db.territoryDocs.upsertDescription(userId, t.territory_id, desc, version, typeof raw === 'string' ? raw : null, modelLabel);
      // Coverage: fold the sampled members into the shared territory_seen_points
      // ledger, then refresh explored_count/explored_percent ("% described").
      // upsertDescription doesn't own those columns, so write them here.
      if (S.sampledIds.length) {
        const pass = (await lastPassNumber(query, userId, t.territory_id)) + 1;
        await recordSeen(query, userId, t.territory_id, S.sampledIds, pass);
        const seenSet = await getSeenIds(query, userId, t.territory_id);
        const seen = seenSet.size;
        // Persist covered span (now incl. this pass) + activity histogram alongside
        // the coverage %, so the next chronicle knows what was already folded in.
        const dp = describedPeriodFor('territory', capMembers, seenSet);
        await query(
          `UPDATE territory_profiles SET explored_count = ?, explored_percent = ?, described_period_start = ?, described_period_end = ?, activity_timeline = ? WHERE user_id = ? AND territory_id = ?`,
          [seen, exploredPercent(seen, S.totalPoints || seen), dp?.start ?? null, dp?.end ?? null, JSON.stringify(capsule?.activity?.histogram ?? []), userId, t.territory_id],
        ).catch(() => {});
      }
      described += 1;
      await recordNarrative(db, userId, 'territory', t.territory_id, desc, version, modelLabel);
    } catch (e) {
      failed += 1; log(`chronicle write failed for territory ${t.territory_id}: ${e.message}`);
    }
    try { await onProgress?.(described + skipped + failed, total); } catch { /* */ }
  }

  // ── Theme pass (mid-level: territory → theme). Materialize semantic_themes from
  // clustering_points.theme_id (cluster.py's structural output), narrate each
  // theme FROM its member territory descriptions (bottom-up, not raw messages),
  // PRESERVE imported chronicles (narrate only nameless gaps + drift), PRUNE dead
  // themes, then CASCADE explored % territory→theme→realm. Fail-soft as a whole.
  let themesDescribed = 0;
  try {
    const rosters = await db.mindscape.assignTerritoryThemes(userId);
    for (const r of rosters) await db.mindscape.upsertSemanticThemeStructural(userId, r);
    await db.mindscape.pruneSemanticThemes(userId, rosters.map((r) => ({ realm_id: r.realm_id, theme_id: r.theme_id })));
    const rosterByKey = new Map(rosters.map((r) => [`${r.realm_id}:${r.theme_id}`, r]));
    const themeRows = await db.mindscape.getSemanticThemesForNarration(userId);
    // Gate: live theme with NO name yet (fill the gap — preserves imported themes,
    // whose generated_at is NULL → never the regen branch) OR a member territory
    // was described AFTER we last narrated this theme (regenerate-on-child-change).
    const themeTargets = themeRows.filter((th) => rosterByKey.has(`${th.realm_id}:${th.theme_id}`)
      && (!th.name || (!preserveImported && th.generated_at && th.child_max_described && th.child_max_described > th.generated_at)));
    for (const th of themeTargets) {
      const digests = await db.mindscape.getThemeTerritoryDigests(userId, th.realm_id, th.theme_id);
      if (!digests.length) { skipped += 1; continue; }
      let raw;
      try {
        raw = await withTimeout(
          infer({ task: 'narrate', prompt: buildThemePrompt(th, digests), maxTokens: 700 }),
          CHRONICLE_INFER_TIMEOUT_MS, 'theme chronicle narration',
        );
      } catch { failed += 1; continue; }
      const roster = rosterByKey.get(`${th.realm_id}:${th.theme_id}`);
      const desc = parseChronicle(raw, th, Number(roster?.message_count) || digests.length);
      try {
        await db.mindscape.upsertSemanticThemeChronicle(userId, th.realm_id, th.theme_id, desc, version, modelLabel);
        themesDescribed += 1; described += 1;
        await recordNarrative(db, userId, 'theme', `${th.realm_id}:${th.theme_id}`, desc, version, modelLabel);
      } catch (e) { failed += 1; log(`chronicle write failed for theme ${th.realm_id}:${th.theme_id}: ${e.message}`); }
      try { await onProgress?.(described + skipped + failed, total); } catch { /* */ }
    }
    await db.mindscape.cascadeExploredPercent(userId);
  } catch (e) { log(`theme pass failed (non-fatal): ${e.message}`); }

  // ── Realm pass — same narrator, same gating shape (generation_version +
  // drift). UPDATE-only: realm rows exist only via describe-clusters from live
  // points (or import); narration must never create one (fail-closed).
  for (const rm of realmTargets) {
    const ctx = await (sampleRealm ? sampleRealm(rm) : sampleRealmContext(db, userId, rm.realm_id));
    if (!ctx.samples.length) { skipped += 1; continue; }
    let raw;
    try {
      raw = await withTimeout(
        infer({ task: 'narrate', prompt: buildRealmPrompt(rm, ctx.samples, ctx.territoryDigests), maxTokens: 700 }),
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
      await recordNarrative(db, userId, 'realm', rm.realm_id, desc, version, modelLabel);
    } catch (e) {
      failed += 1; log(`chronicle write failed for realm ${rm.realm_id}: ${e.message}`);
    }
    try { await onProgress?.(described + skipped + failed, total); } catch { /* */ }
  }
  return { total, described, skipped, failed };
}

// Narrative fields worth versioning (the prose). Bookkeeping (description_version,
// point_count_at_description, last_described_at) is deliberately excluded so a
// drift-only re-narration with identical prose does not append a near-duplicate.
const PROSE_FIELDS = [
  'name', 'essence', 'archetype_type', 'archetype_character',
  'story_birth', 'story_arc', 'story_current_chapter', 'story_peak_moments',
  'signature_patterns', 'uncertainty_open_questions', 'uncertainty_edges',
  'agent_expertise', 'agent_curious_about', 'agent_can_help_with', 'agent_would_consult',
  'top_entities',
];
function prose(desc) {
  const o = {};
  for (const f of PROSE_FIELDS) if (desc[f] != null) o[f] = desc[f];
  return o;
}
/** Append a narrative version to the entity change-log (best-effort: a history
 * miss must never fail narration). Dedup-vs-latest lives in db.history. */
async function recordNarrative(db, userId, entityKind, entityId, desc, version, modelLabel) {
  if (!db.history?.recordSnapshot) return;
  try {
    await db.history.recordSnapshot(userId, {
      entityKind, entityId, snapshotKind: 'narrative',
      content: prose(desc),
      meta: { stage: 'chronicle', entityVersion: version, model: modelLabel },
    });
  } catch { /* history is best-effort */ }
}

/**
 * Realms still needing a chronicle at `version`. realms.generation_version is
 * PLAINTEXT (unlike territory_profiles.description_version) but the gate stays
 * in JS for symmetry with the territory pass. Only EXISTING rows are returned —
 * the realm pass never creates realm rows.
 */
async function getRealmsToNarrate(db, userId, version, preserveImported = false) {
  const r = await db.rawQuery(
    `SELECT realm_id, name, essence, story_arc, story_current_chapter,
            generation_version, message_count,
            point_count_at_description, generated_at,
            (SELECT MAX(tp.last_described_at) FROM territory_profiles tp
              WHERE tp.user_id = realms.user_id AND tp.realm_id = realms.realm_id
                AND tp.dissolved_at IS NULL) AS child_max_described
       FROM realms WHERE user_id = ? ORDER BY message_count DESC`,
    [userId],
  ).catch(() => ({ results: [] }));
  const rows = r.results || r || [];
  // PRESERVE-IMPORTED (gap-fill): narrate ONLY realms with NO chronicle yet.
  if (preserveImported) return rows.filter((rm) => !rm.story_arc && !rm.story_current_chapter && !rm.essence);
  // Normal: narrate when version stale, OR content drifted, OR a member territory
  // was described AFTER this realm was last narrated (regenerate-on-child-change —
  // the hierarchy fold: a realm restory follows its territories evolving).
  return rows.filter((rm) => rm.generation_version !== version
    || hasDrifted(rm.message_count, rm.point_count_at_description)
    || (rm.generated_at && rm.child_max_described && rm.child_max_described > rm.generated_at));
}

/** Realm narration input: a timeline-stratified all-source message sample (for
 * texture) PLUS the realm's member-territory DIGESTS (name + essence + current
 * chapter) — the lower-level descriptions the realm story is synthesized from. */
async function sampleRealmContext(db, userId, realmId) {
  const query = (sql, p = []) => db.rawQuery(sql, p).then((r) => r.results || r || []);
  const members = await loadMembers(query, userId, 'realm_id', realmId);
  const s = sampleMembers(members, {});
  const samples = s.samples.map((x) => x.content);
  const digestRows = await query(
    `SELECT name, essence, story_current_chapter FROM territory_profiles
      WHERE user_id = ? AND realm_id = ? AND dissolved_at IS NULL AND name IS NOT NULL
      ORDER BY message_count DESC LIMIT 12`,
    [userId, realmId],
  );
  const territoryNames = digestRows.map((x) => x.name).filter(Boolean);
  const territoryDigests = digestRows.map((d) =>
    `${d.name}${d.essence ? ` — ${d.essence}` : ''}${d.story_current_chapter ? ` [now: ${d.story_current_chapter}]` : ''}`);
  return { samples, territoryNames, territoryDigests };
}

/** A theme is narrated FROM its member territories' descriptions (bottom-up),
 * not raw messages. It must also produce a NAME (themes are materialized here). */
function buildThemePrompt(th, digests) {
  return [
    `You are naming and writing the "chronicle" of a THEME — a mid-level grouping of related territories in someone's personal knowledge map.`,
    th.name ? `It is currently titled "${th.name}". Refine it as understanding deepens.` : '',
    `Synthesize the theme FROM its member territories and their stories below:`,
    ...digests.map((d, i) => `(${i + 1}) ${d.name}${d.essence ? ` — ${d.essence}` : ''}${d.story_current_chapter ? ` [now: ${d.story_current_chapter}]` : ''}`),
    ``,
    `Reply with EXACTLY one line of minified JSON:`,
    `{"name":"<2-4 word title>","essence":"<one vivid sentence>","archetype_type":"<1-2 words>",`,
    `"story_birth":"<how this theme began, 1 sentence>","story_arc":"<how it evolved, 1-2 sentences>",`,
    `"story_current_chapter":"<where it is now, 1 sentence>",`,
    `"signature_patterns":["<short phrase>"],"open_questions":["<question>"]}`,
  ].filter(Boolean).join('\n');
}

function buildRealmPrompt(rm, samples, territoryDigests = []) {
  const lines = [
    `You are writing the "chronicle" of a REALM — a broad region of someone's personal knowledge map that contains several territories.`,
    `This realm is currently titled "${rm.name || 'a realm'}".`,
  ];
  if (rm.story_arc || rm.story_current_chapter) {
    lines.push(`Its current chronicle — refine and extend as understanding deepens: ${[rm.story_arc && `arc: ${rm.story_arc}`, rm.story_current_chapter && `now: ${rm.story_current_chapter}`].filter(Boolean).join(' · ')}`);
  }
  // The lower-level descriptions the realm is synthesized FROM (hierarchy fold).
  if (territoryDigests.length) {
    lines.push(`Its territories and their stories:`, ...territoryDigests.map((d, i) => `  ${i + 1}. ${d}`));
  }
  lines.push(
    `Below are representative snippets sampled across the realm's whole timeline.`,
    ``,
    `Reply with EXACTLY one line of minified JSON with these keys:`,
    `{"essence":"<one vivid sentence>","archetype_type":"<1-2 words>",`,
    `"story_birth":"<how this began, 1 sentence>","story_arc":"<how it evolved, 1-2 sentences>",`,
    `"story_current_chapter":"<where it is now, 1 sentence>",`,
    `"signature_patterns":["<short phrase>","..."],"open_questions":["<question>","..."],`,
    `"agent_expertise":"<what an agent stewarding this would be expert in>"}`,
    ``,
    ...samples.map((s, i) => `(${i + 1}) ${String(s).slice(0, 5000)}`),
  );
  return lines.filter(Boolean).join('\n');
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

  // getDb + loadKey (CryptoKeys) + resolveDbKeyHex (the at-rest DB-file key). NOT boot():
  // boot runs initVaultStorage (schema + cross-process migration lock) + builds domains,
  // which deadlocks/alters state when a parent (a test, or the app) already holds the vault.
  // This opens the vault keyed — the one thing the old getDb-with-hex lacked — no side effects.
  const [userKey, systemKey] = await Promise.all([loadKey(USER_MASTER), loadKey(SYSTEM_KEY)]);
  const dbKeyHex = resolveDbKeyHex(USER_MASTER, DB_PATH);
  const { db, close } = getDb({ dbPath: DB_PATH, userKey, systemKey, scope: 'personal', dbKeyHex });
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
        res = await describeChronicles({ db, userId: USER_ID, infer: ({ prompt, maxTokens }) => narrator.infer(prompt, { maxTokens }), log: console.error, onProgress, modelLabel: narrator.label,
          preserveImported: process.argv.includes('--preserve-imported') || process.env.MYCELIUM_DESCRIBE_PRESERVE === '1',
          skipTerritories: process.argv.includes('--skip-territories') || process.env.MYCELIUM_DESCRIBE_SKIP_TERRITORIES === '1' });
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
