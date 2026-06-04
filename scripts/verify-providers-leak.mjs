// verify:providers-leak — the BYOK-credential encryption-at-rest gate. Stores a
// provider API key via db.providers, then scans the raw SQLite bytes: the key
// must NEVER appear in plaintext, and providers.list() must NEVER return the
// `credentials` column. A hit = a leaked paid-account key at rest = FAIL.
// Own DB file. PASS/FAIL ledger.
import Database from 'better-sqlite3';
import { readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';

const DB = 'data/verify-providers-leak.db', KCV = 'data/verify-providers-leak-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex: crypto.randomBytes(32).toString('hex'), systemHex: crypto.randomBytes(32).toString('hex'), embedder: null });
const U = 'local-user';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

function looksEncrypted(value) {
  if (typeof value !== 'string' || value.length < 20) return false;
  try { const o = JSON.parse(Buffer.from(value, 'base64').toString('utf8')); return !!(o.iv && o.ct && o.dk); }
  catch { return false; }
}

const SECRET = 'ZZsk-secretProviderKey-DEADBEEF';
const id = await db.providers.create(U, { provider: 'openai', label: 'Test GPT', authType: 'api_key', credentials: JSON.stringify({ apiKey: SECRET }), model: 'gpt-4o-mini' });
rec('PV1. create returns a row id', Number.isInteger(id) && id > 0, `id=${id}`);

// raw bytes (db + wal + shm): the key must be ciphertext only.
const raw = [DB, `${DB}-wal`, `${DB}-shm`].filter(existsSync).map((f) => readFileSync(f).toString('latin1')).join('');
rec('PV2. API key ENCRYPTED at rest (absent from raw db bytes)', !raw.includes(SECRET), raw.includes(SECRET) ? 'PLAINTEXT LEAK' : 'ciphertext only');

// raw column read bypassing the adapter → must be an envelope, not the key.
const rawDb = new Database(DB, { readonly: true });
const rawCred = rawDb.prepare('SELECT credentials FROM ai_providers WHERE id = ?').get(id)?.credentials ?? null;
rec('PV3. credentials column is an envelope, not the key', looksEncrypted(rawCred) && !String(rawCred).includes(SECRET), `raw=${String(rawCred).slice(0, 40)}…`);

// list() must omit credentials entirely.
const listed = await db.providers.list(U);
const hasCred = listed.some((r) => 'credentials' in r);
rec('PV4. providers.list() never returns credentials', listed.length === 1 && !hasCred, `keys=${Object.keys(listed[0] || {}).join(',')}`);

// get() decrypts transparently for internal use (the probe + the router).
const full = await db.providers.get(id, U);
let back = null; try { back = JSON.parse(full.credentials).apiKey; } catch {}
rec('PV5. get() decrypts the key transparently for internal use', back === SECRET, back === SECRET ? 'round-trips' : `got ${back}`);

// sanity: the scan reads real bytes — the plaintext label IS present.
rec('PV6. scan integrity (a known plaintext label IS found in raw bytes)', raw.includes('Test GPT'), 'scan reads real bytes');

rawDb.close(); close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — provider API keys encrypted at rest + omitted from list reads' : 'NO-GO — PLAINTEXT KEY LEAK, see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
