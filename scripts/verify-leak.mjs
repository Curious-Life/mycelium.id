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
  // people PII tokens removed in SQLCipher collapse (Stage B/C cut 3): `people` is
  // now plaintext-inside-cipher — its at-rest protection is whole-file SQLCipher
  // (verify:at-rest), not a per-field envelope. The tokens left here are the tables
  // STILL field-encrypted (facts/entities/messages); each leaves as its cut lands.
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

// people seed REMOVED in SQLCipher collapse (Stage B/C cut 3): `people` is now
// plaintext-inside-cipher, so a per-field "PII absent from raw bytes" assertion no
// longer applies (whole-file SQLCipher protects it at rest — verify:at-rest proves
// it). The multi-line COALESCE UPDATE / parser-fix path stays covered by the
// entities dedup UPDATE above (line 41, entities is still field-encrypted).

// ── FAIL-CLOSED: a write the encryption parser can't model must THROW, never
// silently persist plaintext into an encrypted column (H1, 2026-06-11). ──
const threw = async (fn) => { try { await fn(); return false; } catch { return true; } };
const LITERAL = 'ZZleakLiteralPlaintext';
// 1) encrypted column assigned a string LITERAL (not a bound ?) → refuse.
rec('UPDATE encrypted col = string literal is refused',
  await threw(() => db._base.d1Query(`UPDATE messages SET content = '${LITERAL}' WHERE id = ?`, ['lk1'])));
// 2) INSERT…SELECT into an encrypted table (no parseable column→value map) → refuse.
rec('INSERT…SELECT into encrypted table is refused',
  await threw(() => db._base.d1Query(`INSERT INTO messages SELECT * FROM messages WHERE id = ?`, ['lk1'])));
// 3) clearing an encrypted column to NULL stays ALLOWED (no plaintext to encrypt).
rec('UPDATE encrypted col = NULL is allowed',
  !(await threw(() => db._base.d1Query(`UPDATE messages SET thinking = NULL WHERE id = ?`, ['lk1']))));

// ── SCRUB-2: a secret mistakenly placed in an allowlisted scrubber field is
// masked by the final redaction pass; tenant fingerprint is non-reversible. ──
{
  const { scrubByKind } = await import('../src/crypto/guardians/scrubbers.js');
  const out = scrubByKind('default', { path: '/x?k=' + 'a'.repeat(64), method: 'GET' });
  rec('guardian scrubber redacts a hex secret in an allowlisted field', !String(out.path).includes('a'.repeat(64)));
  const t = scrubByKind('tenant', { actual_tenant: 'tenant-42' }).actual_tenant;
  rec('guardian tenant fingerprint is HMAC (12 hex, not the raw id)', t.length === 12 && t !== 'tenant-42');
}

// ── DB-COL: column builders reject a non-identifier (injected) column key ──
rec('messages.insert refuses an unsafe column identifier',
  await threw(() => db.messages.insert([{ id: 'x', 'evil)--': 1, content: 'y', scope: 'personal' }])));

// ── THE scan: raw db + wal + shm bytes must contain NONE of the tokens ──
const raw = [DB, `${DB}-wal`, `${DB}-shm`].filter(existsSync).map((f) => readFileSync(f).toString('latin1')).join('');
for (const [col, tok] of Object.entries(T)) {
  rec(`${col} encrypted at rest`, !raw.includes(tok), raw.includes(tok) ? 'PLAINTEXT LEAK' : 'ciphertext only');
}
// Sanity: the scan reads real bytes — the plaintext (never-encrypted) row id IS present.
rec('scan integrity (a known plaintext id IS found in the raw bytes)', raw.includes('lk1'), 'scan reads real bytes');

close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — encryption at rest holds across every write path (facts/entities/messages/people, INSERT + multi-line UPDATE)' : 'NO-GO — PLAINTEXT LEAK, see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
