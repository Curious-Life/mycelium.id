// verify:describe-preserve — the preserve-imported (gap-fill) mode used for the
// one-shot over a freshly-imported vault. Proves describeChronicles({preserveImported})
// NEVER overwrites an existing chronicle (canonical import) and ONLY fills gaps:
//   P1 a territory WITH a chronicle is left untouched (story preserved)
//   P2 a territory WITHOUT a chronicle gets narrated (gap filled)
//   P3 a realm WITH a chronicle is left untouched
// PASS/FAIL ledger; VERDICT GO/NO-GO.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { applyMigrations } from '../src/db/migrate.js';
import { getDb } from '../src/db/index.js';
import { unlock } from '../src/crypto/keys.js';
import { describeChronicles } from '../pipeline/describe-chronicles.js';

const DB = 'data/verify-describe-preserve.db', KCV = 'data/verify-describe-preserve-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
const hex = () => crypto.randomBytes(32).toString('hex');
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };
const U = 'local-user';

new Database(DB).close(); { const d = new Database(DB); applyMigrations(d); d.close(); }
const { userKey, systemKey } = await unlock({ userHex: hex(), systemHex: hex(), kcvPath: KCV });
const { db, close } = getDb({ dbPath: DB, userKey, systemKey, scope: 'personal' });
const q = (sql, p = []) => db.rawQuery(sql, p).then((r) => r.results || r || []);
const stub = async () => JSON.stringify({ essence: 'fresh essence', archetype_type: 'the maker',
  story_birth: 'b', story_arc: 'a freshly written arc', story_current_chapter: 'c', signature_patterns: ['p'], open_questions: ['q'] });

try {
  // Territory 1 (realm 0): IMPORTED chronicle present. Territory 2: gap (no story).
  await q(`INSERT INTO territory_profiles (territory_id, user_id, realm_id, name, essence, story_arc, description_version, message_count) VALUES (?,?,?,?,?,?,?,?)`,
    [1, U, 0, 'Imported T', 'imported essence', 'a canonical arc to keep', 'chronicle-v1', 3]);
  await q(`INSERT INTO territory_profiles (territory_id, user_id, realm_id, name, message_count) VALUES (?,?,?,?,?)`,
    [2, U, 0, 'Bare T', 3]);
  for (const tid of [1, 2]) for (let i = 0; i < 3; i++) {
    const mid = `m${tid}_${i}`;
    await q(`INSERT INTO messages (id, user_id, role, content, scope) VALUES (?,?,?,?,?)`, [mid, U, 'user', `a longer reflection about territory ${tid} item ${i}`, 'personal']);
    await q(`INSERT INTO clustering_points (user_id, source_type, source_id, territory_id, realm_id) VALUES (?,?,?,?,?)`, [U, 'message', mid, tid, 0]);
  }
  // Realm 0: IMPORTED chronicle present.
  await q(`INSERT INTO realms (user_id, realm_id, name, essence, story_arc, generation_version) VALUES (?,?,?,?,?,?)`,
    [U, 0, 'Imported Realm', 'imported realm essence', 'a canonical realm arc', 'chronicle-v1']);

  await describeChronicles({ db, userId: U, infer: stub, version: 'chronicle-v1', modelLabel: 'stub', preserveImported: true });

  const t1 = (await q(`SELECT story_arc FROM territory_profiles WHERE user_id=? AND territory_id=1`, [U]))[0];
  const t2 = (await q(`SELECT story_arc FROM territory_profiles WHERE user_id=? AND territory_id=2`, [U]))[0];
  const rm = (await q(`SELECT story_arc FROM realms WHERE user_id=? AND realm_id=0`, [U]))[0];
  rec('P1. territory WITH imported chronicle is PRESERVED (story unchanged)',
    /canonical arc to keep/.test(t1?.story_arc || ''), `t1.arc=${(t1?.story_arc || '').slice(0, 28)}…`);
  rec('P2. territory WITHOUT a chronicle gets narrated (gap filled)',
    /freshly written arc/.test(t2?.story_arc || ''), `t2.arc=${(t2?.story_arc || '').slice(0, 28)}…`);
  rec('P3. realm WITH imported chronicle is PRESERVED (story unchanged)',
    /canonical realm arc/.test(rm?.story_arc || ''), `realm.arc=${(rm?.story_arc || '').slice(0, 28)}…`);
} catch (e) { rec('FATAL', false, e.stack || e.message); }
try { close(); } catch {}
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — preserve-imported: gap-fill only, never overwrites an existing chronicle' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
