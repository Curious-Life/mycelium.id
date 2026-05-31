// Foundation structural proof (Wave 1). Compact PASS/FAIL ledger.
//
// Proves the load-bearing vertical end-to-end:
//   schema load -> two-key unlock + KCV -> encrypting adapter -> a real
//   document write/read round-trip -> ciphertext-at-rest -> fail-closed on
//   a wrong key (both KCV and data-read paths).
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrate.js';
import { readFileSync, rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { unlock } from '../src/crypto/keys.js';
import { createDb } from '../src/adapter/d1.js';
import { isEncrypted } from '../src/crypto/crypto-local.js';

const DB = 'data/verify.db';
const KCV = 'data/verify-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');
const userHex = hex(), systemHex = hex(), wrongHex = hex();
const PLAINTEXT = 'SECRET reflection: the vault must never leak this.';

const ledger = [];
const rec = (name, pass, detail) => { ledger.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`); };
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// fresh state
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });

// B1: schema loads
{
  const db = new Database(DB);
  applyMigrations(db);
  const n = db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table'").get().c;
  db.close();
  rec('B1. 111-table schema loads in better-sqlite3', n >= 111, `${n} tables`);
}

// B2: two-key unlock + KCV creation
const { userKey, systemKey } = await unlock({ userHex, systemHex, kcvPath: KCV });
rec('B2. two-key unlock creates KCV (D4/D6)', !!userKey && !!systemKey, 'USER_MASTER + SYSTEM_KEY loaded, KCV written');

// B3: encrypting adapter — document round-trip
const dbh = createDb({ dbPath: DB, userKey, systemKey });
const id = crypto.randomUUID();
await dbh.d1Query(
  'INSERT INTO documents (id, user_id, path, title, content) VALUES (?, ?, ?, ?, ?)',
  [id, 'local-user', 'notes/verify', 'My Title', PLAINTEXT],
);
const read = dbh.firstRow(await dbh.d1Query('SELECT title, content FROM documents WHERE path = ?', ['notes/verify']));
rec('B3. document round-trip through the encrypting adapter (transparent decrypt)',
  read?.content === PLAINTEXT && read?.title === 'My Title',
  `title='${read?.title}' content==plaintext:${read?.content === PLAINTEXT}`);

// B4: ciphertext-at-rest (raw read, no adapter)
{
  const raw = new Database(DB, { readonly: true });
  const rawContent = raw.prepare('SELECT content FROM documents WHERE path = ?').get('notes/verify')?.content;
  raw.close();
  rec('B4. ciphertext-at-rest (raw column is an envelope, not plaintext)',
    isEncrypted(rawContent) && rawContent !== PLAINTEXT,
    `isEncrypted=${isEncrypted(rawContent)} leaks-plaintext=${rawContent === PLAINTEXT}`);
}
dbh.close();

// B5: wrong key — KCV fails closed BEFORE any vault row is touched
{
  const err = await threw(() => unlock({ userHex: wrongHex, systemHex, kcvPath: KCV }));
  rec('B5. wrong USER_MASTER rejected at KCV (fail-closed unlock)',
    err !== null && /KCV/i.test(err.message),
    err ? `threw: ${err.message}` : 'DID NOT THROW (BAD)');
}

// B6: wrong key — even past unlock, data cannot be read as plaintext
{
  const wrongKey = (await import('../src/crypto/keys.js')).loadKey
    ? await (await import('../src/crypto/keys.js')).loadKey(wrongHex) : null;
  const bad = createDb({ dbPath: DB, userKey: wrongKey, systemKey });
  const res = await threw(async () => {
    const r = bad.firstRow(await bad.d1Query('SELECT content FROM documents WHERE path = ?', ['notes/verify']));
    if (r?.content === PLAINTEXT) throw new Error('LEAKED PLAINTEXT');
    return r;
  });
  bad.close();
  // PASS if it threw a decrypt error OR returned non-plaintext (never the secret)
  const leaked = res instanceof Error && res.message === 'LEAKED PLAINTEXT';
  rec('B6. wrong key cannot decrypt vault data', !leaked,
    leaked ? 'LEAKED PLAINTEXT (BAD)' : `safe (${res instanceof Error ? 'decrypt threw' : 'returned ciphertext'})`);
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — foundation vertical boots + encrypts + fails closed' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
