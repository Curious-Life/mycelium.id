// verify:leak — encryption-at-rest regression gate, PIVOTED for the SQLCipher
// collapse (Stage B/C cut 4). Pre-collapse this planted tokens in EVERY field-
// encrypted column and scanned the raw file bytes for any leak. After cut 4 the
// ONLY field-encrypted table left is `secrets` (separate SYSTEM_KEY) — all content
// tables are plaintext-inside-cipher, whose at-rest confidentiality is whole-file
// SQLCipher (verify:at-rest), NOT a per-field envelope. So this gate now targets
// `secrets`: it still catches the crypto-boundary class of bug a static review
// misses (parseWriteSQL skipping a multi-line SET → silent plaintext), now for the
// SYSTEM_KEY write path. The fail-closed parser checks + guardian scrubbers + the
// column-identifier guard are unchanged in spirit, retargeted to the encrypted table.
// Boots a PLAINTEXT low-level DB (boot()), so a field-encrypted value MUST be absent
// from the raw bytes; a plaintext column (a message id) MUST be present. PASS/FAIL ledger.
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

// Distinctive tokens. `secrets` is the ONLY field-encrypted table after cut 4 — its
// value+key are SYSTEM_KEY envelopes → MUST be absent from the plaintext db bytes.
const T = {
  secret_value: 'ZZleakSecretValue',
  secret_key: 'ZZleakSecretKeyName',
};

// ── exercise the SYSTEM_KEY write path (db.secrets.set: INSERT + the UPDATE/rotate
// path on a re-set with a changed value — both must encrypt key+value). ──
await db.secrets.set(U, { key: T.secret_key, value: T.secret_value, scope: 'personal', description: 'leak-probe' });
await db.secrets.set(U, { key: T.secret_key, value: T.secret_value, scope: 'personal' }); // re-set → UPDATE path

// A plaintext message (content is plaintext-in-cipher after cut 4) — used only for the
// scan-integrity check (a known plaintext id IS in the bytes) + the DB-COL guard below.
await db.messages.insert([{ id: 'lk1', user_id: U, role: 'user', content: 'plaintext-after-cut4', scope: 'personal', created_at: '2026-06-02T10:00:00.000Z' }]);

// ── FAIL-CLOSED: a write the encryption parser can't model must THROW, never
// silently persist plaintext into an encrypted column (H1, 2026-06-11). Retargeted
// to `secrets.value` — the remaining encrypted column after the cut-4 collapse. ──
const threw = async (fn) => { try { await fn(); return false; } catch { return true; } };
const LITERAL = 'ZZleakLiteralPlaintext';
// 1) encrypted column assigned a string LITERAL (not a bound ?) → refuse.
rec('UPDATE encrypted col (secrets.value) = string literal is refused',
  await threw(() => db._base.d1Query(`UPDATE secrets SET value = '${LITERAL}' WHERE user_id = ? AND key = ?`, [U, T.secret_key])));
// 2) INSERT…SELECT into an encrypted table (no parseable column→value map) → refuse.
rec('INSERT…SELECT into encrypted table (secrets) is refused',
  await threw(() => db._base.d1Query(`INSERT INTO secrets SELECT * FROM secrets WHERE key = ?`, [T.secret_key])));
// 3) clearing an encrypted column to NULL stays ALLOWED (no plaintext to encrypt).
rec('UPDATE encrypted col (secrets.description) = NULL is allowed',
  !(await threw(() => db._base.d1Query(`UPDATE secrets SET description = NULL WHERE user_id = ? AND key = ?`, [U, T.secret_key]))));

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

// ── THE scan: raw db + wal + shm bytes must contain NONE of the secrets tokens ──
const raw = [DB, `${DB}-wal`, `${DB}-shm`].filter(existsSync).map((f) => readFileSync(f).toString('latin1')).join('');
for (const [col, tok] of Object.entries(T)) {
  rec(`secrets.${col} encrypted at rest (SYSTEM_KEY)`, !raw.includes(tok), raw.includes(tok) ? 'PLAINTEXT LEAK' : 'ciphertext only');
}
// Sanity: the scan reads real bytes — the plaintext (never-encrypted) message id IS present.
rec('scan integrity (a known plaintext id IS found in the raw bytes)', raw.includes('lk1'), 'scan reads real bytes');

close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — encryption at rest holds for the SYSTEM_KEY secrets table (INSERT + rotate UPDATE); fail-closed parser + guardians intact' : 'NO-GO — PLAINTEXT LEAK, see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
