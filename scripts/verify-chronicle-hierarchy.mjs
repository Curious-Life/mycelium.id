// verify:chronicle-hierarchy — the realm hierarchy fold (2d). Calls describeChronicles
// with a prompt-capturing stub and asserts:
//   H1 the realm chronicle is synthesized FROM its member-territory descriptions
//      (the realm prompt contains territory names + their stories, not just raw msgs)
//   H2 regenerate-on-child-change: after a realm is narrated, a member territory
//      described LATER re-opens the realm for narration (hierarchy fold)
//   H3 a realm whose children did NOT change is NOT re-narrated (stable)
// PASS/FAIL ledger; VERDICT GO/NO-GO.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { applyMigrations } from '../src/db/migrate.js';
import { getDb } from '../src/db/index.js';
import { unlock } from '../src/crypto/keys.js';
import { describeChronicles } from '../pipeline/describe-chronicles.js';

const DB = 'data/verify-chronicle-hierarchy.db', KCV = 'data/verify-chronicle-hierarchy-kcv.json';
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

let prompts = [];
const stub = async ({ prompt }) => { prompts.push(prompt); return JSON.stringify({
  name: 'X', essence: 'realm essence', archetype_type: 'the keeper',
  story_birth: 'b', story_arc: 'an evolving arc', story_current_chapter: 'present chapter',
  signature_patterns: ['p'], open_questions: ['q'], agent_expertise: 'stewardship',
}); };

try {
  // Realm 0 with two named territories (Alpha, Beta), each with message-points.
  for (const [tid, name] of [[1, 'Alpha'], [2, 'Beta']]) {
    await q(`INSERT INTO territory_profiles (territory_id, user_id, realm_id, name, essence, message_count) VALUES (?,?,?,?,?,?)`,
      [tid, U, 0, name, `essence of ${name}`, 3]);
    for (let i = 0; i < 3; i++) {
      const mid = `m${tid}_${i}`;
      await q(`INSERT INTO messages (id, user_id, role, content, scope) VALUES (?,?,?,?,?)`, [mid, U, 'user', `note on ${name} ${i}`, 'personal']);
      await q(`INSERT INTO clustering_points (user_id, source_type, source_id, territory_id, realm_id) VALUES (?,?,?,?,?)`, [U, 'message', mid, tid, 0]);
    }
  }
  await q(`INSERT INTO realms (user_id, realm_id, name) VALUES (?,?,?)`, [U, 0, 'The Realm']);

  // ── Run 1: territories + realm narrated. Capture the realm prompt. ──
  prompts = [];
  await describeChronicles({ db, userId: U, infer: stub, version: 'chronicle-v1', modelLabel: 'stub' });
  const realmPrompt = prompts.find((p) => /REALM/i.test(p) && /territories and their stories/i.test(p));
  rec('H1. realm chronicle synthesized FROM member-territory descriptions (Alpha/Beta + stories)',
    !!realmPrompt && realmPrompt.includes('Alpha') && realmPrompt.includes('Beta') && /present chapter|essence of/.test(realmPrompt),
    `realmPromptFound=${!!realmPrompt}`);

  // ── H3 first: re-run with NO child change → realm stable (not re-narrated). ──
  prompts = [];
  const r2 = await describeChronicles({ db, userId: U, infer: stub, version: 'chronicle-v1', modelLabel: 'stub' });
  const realmRenarratedStable = prompts.some((p) => /REALM/i.test(p));
  rec('H3. no child change → realm NOT re-narrated (stable)',
    r2.described === 0 && !realmRenarratedStable, `described=${r2.described} realmPrompted=${realmRenarratedStable}`);

  // ── H2: a child described LATER → realm re-opens for narration. ──
  await q(`UPDATE territory_profiles SET last_described_at = '2099-01-01T00:00:00Z' WHERE user_id=? AND territory_id=1`, [U]);
  prompts = [];
  const r3 = await describeChronicles({ db, userId: U, infer: stub, version: 'chronicle-v1', modelLabel: 'stub' });
  const realmReNarrated = prompts.some((p) => /REALM/i.test(p));
  rec('H2. regenerate-on-child-change: child described after the realm → realm re-narrated',
    realmReNarrated && r3.described >= 1, `described=${r3.described} realmPrompted=${realmReNarrated}`);
} catch (e) {
  rec('FATAL', false, e.stack || e.message);
}
try { close(); } catch {}
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — realm hierarchy: synthesized-from-territories + regenerate-on-child-change' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
