// Verify Phase C — chronicle narration. Seeds territories + member messages
// through the encrypting adapter, stubs the inference model, runs
// describeChronicles, and asserts the story columns populate. Also covers
// idempotency (version-gated re-run skips), fail-soft (no model → skipped, data
// intact), and that getNeedingDescription works (regression on the open_questions
// → uncertainty_open_questions column fix). The REAL narration needs a model
// (Ollama / BYOK) on the host — Tier-2.
//
//   C0 getNeedingDescription runs (column fix) → returns the 2 seeded territories
//   C1 narrate              → {described:2}; story/archetype columns written
//   C2 read back            getByTerritoryId shows story_arc + archetype + version
//   C3 idempotent           re-run at same version → described:0 (version-gated)
//   C4 fail-soft            model throws → failed:2, no crash, prior chronicle intact
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>.

import crypto from 'node:crypto';
import { rmSync, mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrate.js';
import { getDb } from '../src/db/index.js';
import { unlock } from '../src/crypto/keys.js';
import { describeChronicles } from '../pipeline/describe-chronicles.js';

const DB = 'data/verify-chronicles.db';
const KCV = 'data/verify-chronicles-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

const OK_JSON = JSON.stringify({
  essence: 'a vivid distilled essence',
  archetype_type: 'the explorer',
  story_birth: 'it began with a question',
  story_arc: 'it grew through experiments and setbacks',
  story_current_chapter: 'now consolidating what was learned',
  signature_patterns: ['late-night bursts', 'recurring metaphor of water'],
  open_questions: ['what comes after mastery?'],
  agent_expertise: 'systems thinking and synthesis',
});
const okInfer = async () => OK_JSON;                       // model returns canned chronicle
const throwInfer = async () => { throw new Error('no model reachable'); };

async function main() {
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  mkdirSync('data', { recursive: true });
  const raw = new Database(DB); applyMigrations(raw); raw.close();

  const userId = 'local-user';
  // Unlock to derive the scope key material getDb/the adapter expect (not raw hex).
  const { userKey, systemKey } = await unlock({ userHex: hex(), systemHex: hex(), kcvPath: KCV });
  const { db, close } = getDb({ dbPath: DB, userKey, systemKey, scope: 'personal' });

  try {
    // ── Seed 2 territories + member messages (content encrypts on write) ──
    for (const [tid, name] of [[10, 'Roots'], [11, 'Canopy']]) {
      await db.rawQuery(
        `INSERT INTO territory_profiles (territory_id, user_id, realm_id, name, essence, message_count) VALUES (?,?,?,?,?,?)`,
        [tid, userId, 0, name, 'placeholder essence', 3],
      );
      for (let i = 0; i < 3; i++) {
        const mid = `m${tid}_${i}`;
        await db.rawQuery(
          `INSERT INTO messages (id, user_id, role, content, message_type, source, scope) VALUES (?,?,?,?,?,?,?)`,
          [mid, userId, 'user', `a thought about ${name} number ${i}`, 'chat', 'note', 'personal'],
        );
        await db.rawQuery(
          `INSERT INTO clustering_points (user_id, source_type, source_id, territory_id, realm_id) VALUES (?,?,?,?,?)`,
          [userId, 'message', mid, tid, 0],
        );
      }
    }

    // ── C0 getNeedingDescription runs (open_questions column-fix regression) ──
    let needing = [];
    let c0ok = true;
    try { needing = await db.territoryDocs.getNeedingDescription(userId, 'chronicle-v1'); }
    catch (e) { c0ok = false; }
    rec('C0. getNeedingDescription runs + returns 2 (column fix)', c0ok && needing.length === 2, `count=${needing.length}`);

    // ── C1 narrate ──
    const r1 = await describeChronicles({ db, userId, infer: okInfer, version: 'chronicle-v1' });
    rec('C1. narrate → described:2, no failures', r1.described === 2 && r1.failed === 0 && r1.skipped === 0, JSON.stringify(r1));

    // ── C2 read back ──
    const t = await db.territoryDocs.getByTerritoryId(userId, 10);
    rec('C2. chronicle written (story_arc + archetype + version + open questions)',
      !!t && /experiments/.test(t.story_arc || '') && t.archetype_type === 'the explorer'
        && t.description_version === 'chronicle-v1' && Array.isArray(t.uncertainty_open_questions) && t.uncertainty_open_questions.length === 1,
      `arc=${(t?.story_arc || '').slice(0, 24)}… archetype=${t?.archetype_type} ver=${t?.description_version}`);

    // ── C3 idempotent (same version) ──
    const r3 = await describeChronicles({ db, userId, infer: okInfer, version: 'chronicle-v1' });
    rec('C3. re-run at same version is idempotent (described:0)', r3.described === 0 && r3.total === 0, JSON.stringify(r3));

    // ── C4 fail-soft (new version forces targets; model throws) ──
    const r4 = await describeChronicles({ db, userId, infer: throwInfer, version: 'chronicle-v2' });
    const tAfter = await db.territoryDocs.getByTerritoryId(userId, 10);
    rec('C4. model failure → failed:2, no crash, prior chronicle intact',
      r4.failed === 2 && r4.described === 0 && /experiments/.test(tAfter?.story_arc || '') && tAfter.description_version === 'chronicle-v1',
      `r4=${JSON.stringify(r4)} stillArc=${/experiments/.test(tAfter?.story_arc || '')}`);

    // ── C5 drift refresh: same version, but the territory grew ≥1.5× since
    //    narration → re-narrated WITHOUT a version bump (the 2026-06-11 gap fix). ──
    await db.rawQuery(`UPDATE territory_profiles SET message_count = 30 WHERE territory_id = 10 AND user_id = ?`, [userId]);
    const r5 = await describeChronicles({ db, userId, infer: okInfer, version: 'chronicle-v1', modelLabel: 'stub-model' });
    const t10 = await db.territoryDocs.getByTerritoryId(userId, 10);
    rec('C5. drift (3→30 msgs) re-narrates exactly the drifted territory at the SAME version',
      r5.described === 1 && r5.total === 1, JSON.stringify(r5));

    // ── C6 pcad semantics: stores the territory's LIVE message_count (30), not
    //    samples.length (3) — the drift anchor the old code broke. Then no-drift skip. ──
    const r6 = await describeChronicles({ db, userId, infer: okInfer, version: 'chronicle-v1' });
    rec('C6. point_count_at_description = message_count (30); re-run drift-stable → 0 targets',
      Number(t10?.point_count_at_description) === 30 && r6.total === 0,
      `pcad=${t10?.point_count_at_description} rerun=${JSON.stringify(r6)}`);

    // ── C7 honest model label (was hardcoded 'claude-opus') ──
    rec('C7. generation_model records the real narrator label',
      t10?.generation_model === 'stub-model', `label=${t10?.generation_model}`);

    // ── C8 realm pass: existing realm row gets a chronicle (UPDATE-only) ──
    await db.rawQuery(
      `INSERT INTO realms (user_id, realm_id, name, essence, message_count) VALUES (?, 0, ?, ?, 3)`,
      [userId, 'Grove', 'seed essence']);
    const r8 = await describeChronicles({ db, userId, infer: okInfer, version: 'chronicle-v1', modelLabel: 'stub-model' });
    const realms = await db.mindscape.getRealms(userId);
    const grove = realms.find((r) => Number(r.realm_id) === 0);
    const realmCount = ((await db.rawQuery(`SELECT COUNT(*) AS n FROM realms WHERE user_id = ?`, [userId])).results || [])[0];
    rec('C8. realm chronicle written via UPDATE-only (story fields + version + pcad; no row created)',
      r8.described === 1 && /experiments/.test(grove?.story_arc || '') && grove?.archetype_type === 'the explorer'
      && Number(realmCount?.n) === 1,
      `r8=${JSON.stringify(r8)} arc=${(grove?.story_arc || '').slice(0, 24)}…`);

    // ── C9 security: realm raw_response stays NULL (the chronicle generator never
    //    persists the raw model response). SQLCipher collapse (Stage B/C cut 1):
    //    realms.story_birth is now PLAINTEXT-inside-cipher — at-rest confidentiality
    //    is whole-file SQLCipher (verify:at-rest), not a per-field envelope. Assert
    //    the stop-write worked (story stored readable) + generation_version gate key. ──
    const rawDb = new Database(DB, { readonly: true });
    const rawRealm = rawDb.prepare(`SELECT raw_response, story_birth, generation_version FROM realms WHERE realm_id = 0`).get();
    rawDb.close();
    rec('C9. realms.raw_response NULL; story_birth PLAINTEXT-in-cipher (collapse cut 1); generation_version plaintext gate key',
      rawRealm?.raw_response == null && typeof rawRealm?.story_birth === 'string'
      && rawRealm.story_birth.includes('question') && rawRealm?.generation_version === 'chronicle-v1',
      `raw=${rawRealm?.raw_response} ver=${rawRealm?.generation_version}`);
  } finally {
    close();
  }

  const allPass = ledger.every(Boolean);
  console.log(`VERDICT: ${allPass ? 'GO — Phase C: chronicle narration → territory story columns (idempotent, fail-soft; real model is Tier-2)' : 'NO-GO — see FAIL rows'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('verify-chronicles threw:', e); process.exit(1); });
