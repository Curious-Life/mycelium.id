// verify:themes — the THEME level (mid-level between realm and territory),
// materialized + narrated in the describe stage from clustering_points.theme_id.
// Calls describeChronicles directly with a prompt-capturing stub. Asserts:
//   T1 assignTerritoryThemes sets territory_profiles.semantic_theme_id = dominant theme
//   T2 a NEW theme is materialized (semantic_themes row: structural + narrated name/story)
//   T3 the theme is narrated FROM its member TERRITORY descriptions (not raw messages)
//   T4 a DEAD theme (no live member) is PRUNED
//   T5 CASCADE: explored_percent rolls territory → theme → realm
//   T6 an IMPORTED theme chronicle is PRESERVED (has a name → not re-narrated)
//   T7 theme name/story ciphertext at rest (no plaintext narrative leak)
// PASS/FAIL ledger; VERDICT GO/NO-GO.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { applyMigrations } from '../src/db/migrate.js';
import { getDb } from '../src/db/index.js';
import { unlock } from '../src/crypto/keys.js';
import { describeChronicles } from '../pipeline/describe-chronicles.js';

const DB = 'data/verify-themes.db', KCV = 'data/verify-themes-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
const hex = () => crypto.randomBytes(32).toString('hex');
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };
const U = 'local-user';

const raw0 = new Database(DB); applyMigrations(raw0); raw0.close();
const { userKey, systemKey } = await unlock({ userHex: hex(), systemHex: hex(), kcvPath: KCV });
const { db, close } = getDb({ dbPath: DB, userKey, systemKey, scope: 'personal' });
const q = (sql, p = []) => db.rawQuery(sql, p).then((r) => r.results || r || []);

// Prompt-capturing stub: returns a chronicle JSON WITH a name (themes need one).
const prompts = [];
const stubInfer = async ({ prompt }) => { prompts.push(prompt); return JSON.stringify({
  name: 'Synthesized Theme', essence: 'a vivid theme essence', archetype_type: 'the weaver',
  story_birth: 'it began as scattered notes', story_arc: 'it cohered through reflection',
  story_current_chapter: 'now a recognizable throughline',
  signature_patterns: ['cross-territory echoes'], open_questions: ['where next?'],
}); };

try {
  // Realm 0. Territories 1,2 → theme 5 ; territory 3 → theme 7. Each 3 message-points.
  for (const [tid, name, theme] of [[1, 'Roots', 5], [2, 'Trunk', 5], [3, 'Canopy', 7]]) {
    await q(`INSERT INTO territory_profiles (territory_id, user_id, realm_id, name, essence, message_count) VALUES (?,?,?,?,?,?)`,
      [tid, U, 0, name, `essence of ${name}`, 3]);
    for (let i = 0; i < 3; i++) {
      const mid = `m${tid}_${i}`;
      await q(`INSERT INTO messages (id, user_id, role, content, scope) VALUES (?,?,?,?,?)`,
        [mid, U, 'user', `a thought about ${name} number ${i}`, 'personal']);
      await q(`INSERT INTO clustering_points (user_id, source_type, source_id, territory_id, realm_id, theme_id) VALUES (?,?,?,?,?,?)`,
        [U, 'message', mid, tid, 0, theme]);
    }
  }
  await q(`INSERT INTO realms (user_id, realm_id, name, generation_version) VALUES (?,?,?,?)`, [U, 0, 'The Realm', 'chronicle-v1']);
  // Pre-existing IMPORTED theme 7 WITH a chronicle (must be preserved).
  await q(`INSERT INTO semantic_themes (user_id, realm_id, semantic_theme_id, name, essence, story_arc, generation_version, message_count) VALUES (?,?,?,?,?,?,?,?)`,
    [U, 0, 7, 'Imported Theme 7', 'imported essence', 'an imported arc worth keeping', 'chronicle-v1', 3]);
  // DEAD theme 99 (no live member points) → must be pruned.
  await q(`INSERT INTO semantic_themes (user_id, realm_id, semantic_theme_id, name, story_arc) VALUES (?,?,?,?,?)`,
    [U, 0, 99, 'Dead Theme', 'orphaned story']);

  await describeChronicles({ db, userId: U, infer: stubInfer, version: 'chronicle-v1', modelLabel: 'stub-model' });

  // ── T1: dominant-theme linkage ──
  const links = await q(`SELECT territory_id, semantic_theme_id FROM territory_profiles WHERE user_id=? ORDER BY territory_id`, [U]);
  const byT = Object.fromEntries(links.map((r) => [r.territory_id, r.semantic_theme_id]));
  rec('T1. assignTerritoryThemes set semantic_theme_id to the dominant theme (1,2→5; 3→7)',
    byT[1] === 5 && byT[2] === 5 && byT[3] === 7, JSON.stringify(byT));

  // ── T2: new theme materialized + narrated ──
  const th5 = (await q(`SELECT name, essence, story_arc, territory_count, territory_ids, message_count FROM semantic_themes WHERE user_id=? AND realm_id=0 AND semantic_theme_id=5`, [U]))[0];
  const ids5 = (() => { try { return JSON.parse(th5?.territory_ids || '[]'); } catch { return []; } })();
  rec('T2. NEW theme 5 materialized: structural (2 territories [1,2]) + narrated name/story',
    !!th5 && th5.name === 'Synthesized Theme' && /cohered/.test(th5.story_arc || '') && Number(th5.territory_count) === 2 && ids5.includes(1) && ids5.includes(2),
    `name=${th5?.name} tc=${th5?.territory_count} ids=${JSON.stringify(ids5)}`);

  // ── T3: theme narrated FROM member territory descriptions ──
  const themePrompt = prompts.find((p) => /THEME/i.test(p) && /member territories/i.test(p));
  rec('T3. theme prompt is built from member TERRITORY descriptions (Roots/Trunk), not raw messages',
    !!themePrompt && themePrompt.includes('Roots') && themePrompt.includes('Trunk') && !/thought about Roots number/.test(themePrompt),
    `themePromptFound=${!!themePrompt}`);

  // ── T4: dead theme pruned ──
  const dead = await q(`SELECT COUNT(*) c FROM semantic_themes WHERE user_id=? AND semantic_theme_id=99`, [U]);
  rec('T4. dead theme 99 (no live member) pruned', Number(dead[0]?.c) === 0, `remaining=${dead[0]?.c}`);

  // ── T5: cascade explored % territory→theme→realm ──
  const th5e = (await q(`SELECT explored_percent FROM semantic_themes WHERE user_id=? AND semantic_theme_id=5`, [U]))[0];
  const realmE = (await q(`SELECT explored_percent FROM realms WHERE user_id=? AND realm_id=0`, [U]))[0];
  rec('T5. CASCADE: explored_percent rolled territory→theme→realm (both > 0)',
    Number(th5e?.explored_percent) > 0 && Number(realmE?.explored_percent) > 0,
    `theme5=${th5e?.explored_percent}% realm0=${realmE?.explored_percent}%`);

  // ── T6: imported theme 7 preserved ──
  const th7 = (await q(`SELECT name, story_arc FROM semantic_themes WHERE user_id=? AND semantic_theme_id=7`, [U]))[0];
  rec('T6. imported theme 7 chronicle PRESERVED (name + story unchanged, not re-narrated)',
    th7?.name === 'Imported Theme 7' && /imported arc/.test(th7?.story_arc || ''),
    `name=${th7?.name} arc=${(th7?.story_arc || '').slice(0, 24)}…`);
  close();

  // ── T7: ciphertext at rest ──
  const rawDb = new Database(DB, { readonly: true });
  const rawTh = rawDb.prepare(`SELECT name, story_arc FROM semantic_themes WHERE semantic_theme_id=5`).get();
  rawDb.close();
  rec('T7. theme name + story ciphertext at rest (no plaintext narrative leak)',
    typeof rawTh?.name === 'string' && !rawTh.name.includes('Synthesized') && typeof rawTh?.story_arc === 'string' && !rawTh.story_arc.includes('cohered'),
    `nameLen=${rawTh?.name?.length}`);
} catch (e) {
  rec('FATAL', false, e.stack || e.message);
  try { close(); } catch {}
}

for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — theme level: assign · materialize · narrate-from-territories · preserve · prune · cascade · encrypted' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
