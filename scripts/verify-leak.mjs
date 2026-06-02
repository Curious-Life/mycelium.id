// verify:leak — encryption-at-rest regression gate. The ground-truth check a
// cognitive vault needs: plant distinctive plaintext tokens in EVERY encrypted
// column, exercise every write path (INSERT *and* the multi-line / COALESCE
// UPDATE paths), then scan the raw SQLite file bytes (db + WAL + shm) for any
// token. A hit = plaintext at rest = FAIL. This gate catches the crypto-boundary
// class of bug a static review misses — e.g. parseWriteSQL skipping a multi-line
// SET clause → silent plaintext (the entity/people summary leak, 2026-06-02).
// Own DB file. PASS/FAIL ledger.
import Database from 'better-sqlite3';
import { readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createPeopleNamespace } from '../src/db/people.js';

const DB = 'data/verify-leak.db', KCV = 'data/verify-leak-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const { db, close, handlers } = await boot({ dbPath: DB, kcvPath: KCV, userHex: crypto.randomBytes(32).toString('hex'), systemHex: crypto.randomBytes(32).toString('hex'), embedder: null });
const U = 'local-user';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

// Distinctive tokens, one per encrypted column we touch. NONE may appear raw.
const T = {
  fact_value: 'ZZleakFactValue',
  msg_content: 'ZZleakMsgContent',
  entity_name: 'ZZleakEntityName', entity_summary: 'ZZleakEntitySummary',
  people_name: 'ZZleakPeopleName', people_email: 'ZZleakPeopleAtEmail', people_phone: 'ZZleakPeoplePhone',
  people_company: 'ZZleakPeopleCo', people_linkedin: 'ZZleakPeopleLinkedin',
};

// ── exercise every encrypted WRITE path ──
// facts: INSERT + ON CONFLICT UPDATE (re-remember)
await handlers.remember({ category: 'prefs', key: 'k', value: T.fact_value });
await handlers.remember({ category: 'prefs', key: 'k', value: T.fact_value }); // conflict → DO UPDATE
// entities: INSERT (remember) + the MULTI-LINE dedup UPDATE (link re-upserts by name)
await handlers.remember({ kind: 'entity', entityType: 'person', name: T.entity_name, summary: T.entity_summary });
await handlers.link({ entity: T.entity_name, entityType: 'person', type: 'fact', id: 'x' }); // → entities UPDATE
// messages: INSERT (encrypted content)
await db.messages.insert([{ id: 'lk1', user_id: U, role: 'user', content: T.msg_content, scope: 'personal', created_at: '2026-06-02T10:00:00.000Z' }]);

// people (dormant namespace, but its multi-line COALESCE UPDATE shares the same
// crypto path — a pre-existing PII-at-rest leak the parser fix also closes). Seed
// the row with a plain INSERT (the upsert's own randomblob INSERT is a separate
// dormant-path quirk, out of scope), then exercise the multi-line COALESCE UPDATE
// — the exact path the parser fix repairs. The contact tokens enter ONLY via the
// UPDATE, so their absence proves the UPDATE-path encryption.
const PID = 'ZZleakPersonId1';
const people = createPeopleNamespace({ d1Query: db._base.d1Query, d1QueryAdmin: db._base.d1QueryAdmin });
await db._base.d1Query(
  `INSERT INTO people (id, user_id, name, source, email, phone, company, linkedin_url, status) VALUES (?,?,?,?,?,?,?,?,?)`,
  [PID, U, T.people_name, 'leaktest', 'seed@x', 'seedphone', 'seedco', 'seedlink', 'connected'],
);
await people.upsert(
  { user_id: U, name: T.people_name, source: 'leaktest', email: T.people_email, phone: T.people_phone, company: T.people_company, linkedin_url: T.people_linkedin },
  new Map([[T.people_name, PID]]),
); // → multi-line COALESCE UPDATE (the parser-fix path)

// ── THE scan: raw db + wal + shm bytes must contain NONE of the tokens ──
const raw = [DB, `${DB}-wal`, `${DB}-shm`].filter(existsSync).map((f) => readFileSync(f).toString('latin1')).join('');
for (const [col, tok] of Object.entries(T)) {
  rec(`${col} encrypted at rest`, !raw.includes(tok), raw.includes(tok) ? 'PLAINTEXT LEAK' : 'ciphertext only');
}
// Sanity: the scan reads real bytes — the plaintext (never-encrypted) row id IS present.
rec('scan integrity (a known plaintext id IS found in the raw bytes)', raw.includes(PID), 'scan reads real bytes');

close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — encryption at rest holds across every write path (facts/entities/messages/people, INSERT + multi-line UPDATE)' : 'NO-GO — PLAINTEXT LEAK, see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
